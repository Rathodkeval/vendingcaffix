"""
CAFFIX Multi-Machine Raspberry Pi Firestore Order Processor & Heartbeat Controller
----------------------------------------------------------------------------------
1. Filters Firebase Firestore `orders` strictly by the configured `MACHINE_ID`
   and uses atomic Firestore transactions to claim orders so that:
   - Each Raspberry Pi only processes orders assigned to its own `MACHINE_ID`.
   - Duplicate payment notifications or Firebase listener reconnections can
     never trigger duplicate dispensing on the Arduino GIGA R1.
   - Existing Arduino GIGA R1 serial protocol and motor/sensor logic remain unchanged.
2. Sends a lightweight heartbeat every 30 seconds to `machines/{machine_id}`:
   - Updates ONLY `id` and `last_seen` using `merge=True`.
   - NEVER overwrites `desired_mode`, `status`, `owner_id`, `products`, or `estimated_inventory`.
   - Runs independently of the Arduino serial connection.
   - Handles temporary internet or Firestore errors gracefully without crashing.
   - Prevents duplicate heartbeat threads across internal reconnections.
"""

import argparse
import logging
import os
import re
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, Set

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s"
)

MACHINE_ID_PATTERN = re.compile(r"^CFX-MC-\d{2,4}$")
DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30.0
HEARTBEAT_INTERVAL_SECONDS = float(
    os.getenv("HEARTBEAT_INTERVAL_SECONDS", str(DEFAULT_HEARTBEAT_INTERVAL_SECONDS))
)
MACHINES_COLLECTION = os.getenv("FIRESTORE_MACHINES_COLLECTION", "machines").strip() or "machines"
ORDERS_COLLECTION = os.getenv("FIRESTORE_ORDERS_COLLECTION", "orders").strip() or "orders"

# Protected fields on `machines/{machine_id}` that a Raspberry Pi heartbeat must NEVER overwrite
PROTECTED_MACHINE_FIELDS = frozenset({
    "desired_mode",
    "status",
    "owner_id",
    "products",
    "estimated_inventory",
    "kiosk_token",
    "machine_name",
    "location",
})

# Active statuses eligible for dispensing once payment is confirmed
ELIGIBLE_ORDER_STATUSES = {"QUEUED", "PAID", "COMPLETED"}
# Dispense lifecycle states that indicate an order has already been claimed or completed
CLAIMED_DISPENSE_STATES = {"CLAIMING", "DISPENSING", "DISPENSED", "COMPLETED"}


def validate_machine_id(machine_id: str) -> str:
    """Validate that the configured MACHINE_ID is non-empty and properly formatted."""
    if not machine_id or not isinstance(machine_id, str):
        raise ValueError("MACHINE_ID must be a non-empty string (e.g. 'CFX-MC-01')")
    cleaned = machine_id.strip()
    if not MACHINE_ID_PATTERN.match(cleaned):
        raise ValueError(f"Invalid MACHINE_ID format: '{cleaned}'. Expected format like 'CFX-MC-01'")
    return cleaned


def _read_machine_id_from_env_file(env_file_path: str) -> Optional[str]:
    """Read MACHINE_ID or CAFFIX_MACHINE_ID from an environment file if present."""
    if not env_file_path or not os.path.isfile(env_file_path):
        return None
    try:
        with open(env_file_path, "r", encoding="utf-8") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key = key.strip()
                if key in ("MACHINE_ID", "CAFFIX_MACHINE_ID"):
                    cleaned = val.strip().strip('"').strip("'")
                    if cleaned:
                        return cleaned
    except Exception:
        return None
    return None


def resolve_configured_machine_id(
    explicit_machine_id: Optional[str] = None,
    env_file_path: Optional[str] = None,
    require_explicit: bool = False,
) -> str:
    """
    Resolve the machine ID for this Raspberry Pi installation in priority order:
    1. Explicit `explicit_machine_id` parameter (e.g. CLI `--machine-id` or constructor arg)
    2. `MACHINE_ID` or `CAFFIX_MACHINE_ID` environment variable
    3. Configured `env_file_path`, `/etc/caffix/machine.env`, or local `.env`
    4. Fallback default `'CFX-MC-01'` (unless `require_explicit=True`)
    """
    if explicit_machine_id is not None and str(explicit_machine_id).strip() != "":
        return validate_machine_id(str(explicit_machine_id))

    env_val = (os.getenv("MACHINE_ID") or os.getenv("CAFFIX_MACHINE_ID") or "").strip()
    if env_val:
        return validate_machine_id(env_val)

    candidate_files = [
        env_file_path,
        os.getenv("CAFFIX_ENV_FILE"),
        "/etc/caffix/machine.env",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
    ]
    for path in candidate_files:
        if path:
            from_file = _read_machine_id_from_env_file(path)
            if from_file:
                return validate_machine_id(from_file)

    if require_explicit:
        raise ValueError(
            "MACHINE_ID is not configured. Set MACHINE_ID in environment or /etc/caffix/machine.env."
        )

    return validate_machine_id("CFX-MC-01")


MACHINE_ID = resolve_configured_machine_id()


class MachineOrderProcessor:
    """
    Processes Firestore orders and sends periodic connectivity heartbeats
    exclusively for a single vending machine (`machine_id`).
    Provides atomic transactional order claiming, local deduplication,
    and fault-tolerant 30-second Firestore heartbeat reporting.
    """

    def __init__(
        self,
        machine_id: Optional[str] = None,
        firestore_db: Optional[Any] = None,
        arduino_dispense_callback: Optional[Callable[[Dict[str, Any]], bool]] = None,
        heartbeat_interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS,
        machines_collection: str = MACHINES_COLLECTION,
    ):
        resolved_machine_id = (
            validate_machine_id(machine_id)
            if machine_id is not None
            else resolve_configured_machine_id()
        )
        self.machine_id = resolved_machine_id
        self.db = firestore_db
        self.arduino_dispense_callback = arduino_dispense_callback

        if heartbeat_interval_seconds <= 0:
            raise ValueError("heartbeat_interval_seconds must be greater than 0")
        self.heartbeat_interval_seconds = float(heartbeat_interval_seconds)
        self.machines_collection = machines_collection or "machines"

        self.logger = logging.getLogger(f"CAFFIX-RPi-{self.machine_id}")
        self._lock = threading.Lock()
        self._processed_order_ids: Set[str] = set()

        # Heartbeat state & single-thread guard
        self._heartbeat_lock = threading.Lock()
        self._heartbeat_thread: Optional[threading.Thread] = None
        self._heartbeat_stop_event = threading.Event()
        self.last_heartbeat_iso: Optional[str] = None
        self.heartbeat_count: int = 0
        self.heartbeat_failure_count: int = 0

    @staticmethod
    def build_heartbeat_payload(machine_id: str, now_utc: Optional[datetime] = None) -> Dict[str, str]:
        """
        Build the strict partial heartbeat payload for `machines/{machine_id}`.
        Contains ONLY `id` and `last_seen` (ISO-8601 UTC).
        Never includes `desired_mode`, `status`, `owner_id`, `products`, or `estimated_inventory`.
        """
        validated_id = validate_machine_id(machine_id)
        ts = now_utc if now_utc is not None else datetime.now(timezone.utc)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        else:
            ts = ts.astimezone(timezone.utc)
        now_iso = ts.isoformat().replace("+00:00", "Z")
        payload = {
            "id": validated_id,
            "last_seen": now_iso,
        }
        # Defensive invariant: ensure no protected fields can ever be present
        for forbidden_key in PROTECTED_MACHINE_FIELDS:
            payload.pop(forbidden_key, None)
        return payload

    def send_heartbeat(self, now_utc: Optional[datetime] = None) -> bool:
        """
        Send a single heartbeat update to Firestore `machines/{self.machine_id}`.
        - Updates ONLY `id` and `last_seen` with `merge=True`.
        - Operates independently of the Arduino GIGA R1 serial connection.
        - Catches and logs temporary internet or Firestore errors without raising.
        Returns True if the Firestore write succeeded, False otherwise.
        """
        if self.db is None:
            self.heartbeat_failure_count += 1
            self.logger.warning(
                "Firestore client is not initialized; skipping heartbeat for machine %s",
                self.machine_id,
            )
            return False

        payload = self.build_heartbeat_payload(self.machine_id, now_utc=now_utc)
        try:
            doc_ref = self.db.collection(self.machines_collection).document(self.machine_id)
            doc_ref.set(payload, merge=True)
            self.last_heartbeat_iso = payload["last_seen"]
            self.heartbeat_count += 1
            self.logger.debug(
                "Heartbeat sent for machine %s (last_seen=%s)",
                self.machine_id,
                self.last_heartbeat_iso,
            )
            return True
        except Exception as exc:
            self.heartbeat_failure_count += 1
            self.logger.warning(
                "Temporary Firestore error while sending heartbeat for machine %s (will retry): %s",
                self.machine_id,
                exc,
            )
            return False

    def _heartbeat_loop(self, send_immediately: bool = True) -> None:
        """Background daemon loop that sends a heartbeat every `self.heartbeat_interval_seconds`."""
        if send_immediately and not self._heartbeat_stop_event.is_set():
            try:
                self.send_heartbeat()
            except Exception as exc:  # Defensive guard
                self.logger.warning("Unexpected error in initial heartbeat for %s: %s", self.machine_id, exc)

        while not self._heartbeat_stop_event.wait(timeout=self.heartbeat_interval_seconds):
            try:
                self.send_heartbeat()
            except Exception as exc:  # Defensive guard so the thread never dies on transient errors
                self.logger.warning("Unexpected error in heartbeat loop for %s: %s", self.machine_id, exc)

    def start_heartbeat(
        self,
        interval_seconds: Optional[float] = None,
        send_immediately: bool = True,
    ) -> threading.Thread:
        """
        Start the background heartbeat thread for `self.machine_id`.
        Idempotent: if a heartbeat thread is already alive for this processor instance,
        returns the existing thread without spawning a duplicate thread.
        """
        with self._heartbeat_lock:
            if interval_seconds is not None:
                if interval_seconds <= 0:
                    raise ValueError("interval_seconds must be greater than 0")
                self.heartbeat_interval_seconds = float(interval_seconds)

            if self._heartbeat_thread is not None and self._heartbeat_thread.is_alive():
                self.logger.info(
                    "Heartbeat thread already active for machine %s; reusing existing thread.",
                    self.machine_id,
                )
                return self._heartbeat_thread

            self._heartbeat_stop_event.clear()
            thread = threading.Thread(
                target=self._heartbeat_loop,
                args=(send_immediately,),
                name=f"caffix-heartbeat-{self.machine_id}",
                daemon=True,
            )
            self._heartbeat_thread = thread
            thread.start()
            self.logger.info(
                "Started heartbeat thread for machine %s (interval=%ss)",
                self.machine_id,
                self.heartbeat_interval_seconds,
            )
            return thread

    def stop_heartbeat(self, timeout: float = 2.0) -> None:
        """Stop the background heartbeat thread cleanly."""
        with self._heartbeat_lock:
            self._heartbeat_stop_event.set()
            thread = self._heartbeat_thread

        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=timeout)

        with self._heartbeat_lock:
            if self._heartbeat_thread is thread and (thread is None or not thread.is_alive()):
                self._heartbeat_thread = None

    def is_heartbeat_running(self) -> bool:
        """Return True if the background heartbeat thread is currently alive."""
        with self._heartbeat_lock:
            return bool(self._heartbeat_thread is not None and self._heartbeat_thread.is_alive())

    def can_process_order(self, order_data: Dict[str, Any]) -> bool:
        """
        Verify whether an order document belongs to this Raspberry Pi's machine_id
        and is eligible to be claimed for dispensing.
        """
        if not order_data or not isinstance(order_data, dict):
            return False

        order_id = order_data.get("id")
        order_machine_id = str(order_data.get("machine_id") or "").strip()

        # Strict machine isolation: never process orders for another machine
        if order_machine_id != self.machine_id:
            self.logger.debug(
                "Ignoring order %s assigned to machine '%s' (this machine is '%s')",
                order_id,
                order_machine_id,
                self.machine_id,
            )
            return False

        # Local memory guard against listener re-delivery
        if order_id and order_id in self._processed_order_ids:
            return False

        # Check if already dispensed or currently dispensing in Firestore document
        if order_data.get("dispensed") is True:
            return False

        dispense_status = str(order_data.get("dispense_status") or "").upper()
        if dispense_status in {"DISPENSING", "DISPENSED"}:
            return False

        status = str(order_data.get("status") or "").upper()
        if status not in ELIGIBLE_ORDER_STATUSES:
            return False

        return True

    def claim_and_process_order(
        self,
        order_id: str,
        doc_ref: Optional[Any] = None,
        order_snapshot_data: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """
        Atomically claim an order in Firestore and trigger the Arduino GIGA R1 dispense routine.
        Returns True if the order was claimed and dispensed by this machine, False otherwise.
        """
        if not order_id:
            return False

        with self._lock:
            if order_id in self._processed_order_ids:
                self.logger.info("Order %s already processed locally; skipping duplicate notification.", order_id)
                return False

        # If a Firestore client and document reference are provided, use a Firestore transaction
        if self.db is not None and doc_ref is not None:
            claimed_data = self._claim_via_firestore_transaction(order_id, doc_ref)
            if not claimed_data:
                return False
        else:
            # Fallback atomic claim on in-memory/dict representation (for unit testing or standalone mode)
            if not order_snapshot_data or not self.can_process_order(order_snapshot_data):
                return False
            with self._lock:
                if order_id in self._processed_order_ids or order_snapshot_data.get("dispensed") is True:
                    return False
                if str(order_snapshot_data.get("dispense_status") or "").upper() in {"DISPENSING", "DISPENSED"}:
                    return False
                order_snapshot_data["dispense_status"] = "DISPENSING"
                order_snapshot_data["claimed_by"] = self.machine_id
                order_snapshot_data["claimed_at"] = datetime.now(timezone.utc).isoformat()
                claimed_data = dict(order_snapshot_data)

        with self._lock:
            self._processed_order_ids.add(order_id)

        self.logger.info(
            "Successfully claimed order %s for machine %s (coffee: %s, base: %s)",
            order_id,
            self.machine_id,
            claimed_data.get("coffee") or claimed_data.get("product_name"),
            claimed_data.get("base", "water"),
        )

        # Invoke existing Arduino GIGA R1 serial dispense callback if configured
        success = True
        if self.arduino_dispense_callback is not None:
            try:
                success = bool(self.arduino_dispense_callback(claimed_data))
            except Exception as exc:
                self.logger.error("Arduino dispensing error for order %s: %s", order_id, exc)
                success = False

        # Mark order as DISPENSED in Firestore after hardware command finishes
        now_iso = datetime.now(timezone.utc).isoformat()
        if doc_ref is not None:
            try:
                doc_ref.set(
                    {
                        "dispense_status": "DISPENSED" if success else "FAILED",
                        "dispensed": bool(success),
                        "dispensed_by": self.machine_id,
                        "dispensed_at": now_iso,
                    },
                    merge=True,
                )
            except Exception as exc:
                self.logger.error("Failed to update post-dispense status for %s: %s", order_id, exc)
        elif order_snapshot_data is not None:
            order_snapshot_data["dispense_status"] = "DISPENSED" if success else "FAILED"
            order_snapshot_data["dispensed"] = bool(success)
            order_snapshot_data["dispensed_by"] = self.machine_id
            order_snapshot_data["dispensed_at"] = now_iso

        return success

    def _claim_via_firestore_transaction(self, order_id: str, doc_ref: Any) -> Optional[Dict[str, Any]]:
        """
        Execute an atomic Firestore transaction to claim `doc_ref` for `self.machine_id`.
        """
        from google.cloud import firestore as gc_firestore  # type: ignore

        transaction = self.db.transaction()

        @gc_firestore.transactional
        def _tx_claim(tx: Any) -> Optional[Dict[str, Any]]:
            snapshot = doc_ref.get(transaction=tx)
            if not snapshot.exists:
                return None

            data = snapshot.to_dict() or {}
            data["id"] = data.get("id") or snapshot.id

            if not self.can_process_order(data):
                return None

            now_iso = datetime.now(timezone.utc).isoformat()
            updates = {
                "dispense_status": "DISPENSING",
                "claimed_by": self.machine_id,
                "claimed_at": now_iso,
                "updated_at": now_iso,
            }
            tx.set(doc_ref, updates, merge=True)
            data.update(updates)
            return data

        try:
            return _tx_claim(transaction)
        except Exception as exc:
            self.logger.error("Firestore transaction failed while claiming order %s: %s", order_id, exc)
            return None

    def start_firestore_listener(
        self,
        collection_name: str = ORDERS_COLLECTION,
        start_heartbeat: bool = False,
    ) -> Any:
        """
        Attach a real-time Firestore snapshot listener filtered strictly by `machine_id == self.machine_id`.
        If `start_heartbeat=True`, also ensures the single background heartbeat thread is running.
        Returns the unsubscribe handle.
        """
        if self.db is None:
            raise RuntimeError("Firestore database client is required to start listener.")

        if start_heartbeat:
            self.start_heartbeat()

        from google.cloud.firestore_v1.base_query import FieldFilter  # type: ignore

        query = self.db.collection(collection_name).where(
            filter=FieldFilter("machine_id", "==", self.machine_id)
        )

        def on_snapshot(col_snapshot: Any, changes: Any, read_time: Any) -> None:
            for change in changes:
                if change.type.name in ("ADDED", "MODIFIED"):
                    doc = change.document
                    data = doc.to_dict() or {}
                    order_id = data.get("id") or doc.id
                    data["id"] = order_id
                    if self.can_process_order(data):
                        self.claim_and_process_order(
                            order_id=order_id,
                            doc_ref=doc.reference,
                            order_snapshot_data=data,
                        )

        self.logger.info(
            "Started Firestore order listener on collection '%s' for machine_id='%s'",
            collection_name,
            self.machine_id,
        )
        return query.on_snapshot(on_snapshot)


def _create_firestore_client_from_env() -> Any:
    """Initialize Firestore client using Firebase Admin or Google Cloud credentials."""
    try:
        import firebase_admin  # type: ignore
        from firebase_admin import credentials, firestore  # type: ignore

        if not firebase_admin._apps:
            cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS") or os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH")
            project_id = os.getenv("FIREBASE_PROJECT_ID")
            client_email = os.getenv("FIREBASE_CLIENT_EMAIL")
            private_key = os.getenv("FIREBASE_PRIVATE_KEY")

            if cred_path and os.path.isfile(cred_path):
                cred = credentials.Certificate(cred_path)
                firebase_admin.initialize_app(cred)
            elif project_id and client_email and private_key:
                cred = credentials.Certificate({
                    "type": "service_account",
                    "project_id": project_id,
                    "client_email": client_email,
                    "private_key": private_key.replace("\\n", "\n"),
                    "token_uri": "https://oauth2.googleapis.com/token",
                })
                firebase_admin.initialize_app(cred)
            else:
                firebase_admin.initialize_app()

        return firestore.client()
    except ImportError:
        from google.cloud import firestore as gc_firestore  # type: ignore
        return gc_firestore.Client()


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        description="CAFFIX Raspberry Pi 4 Order Processor & Firestore Heartbeat Daemon"
    )
    parser.add_argument(
        "--machine-id",
        dest="machine_id",
        default=None,
        help="Machine ID for this Raspberry Pi kiosk (e.g. CFX-MC-01, CFX-MC-02, CFX-MC-03)",
    )
    parser.add_argument(
        "--env-file",
        dest="env_file",
        default=None,
        help="Optional path to environment file containing MACHINE_ID",
    )
    parser.add_argument(
        "--heartbeat-interval",
        dest="heartbeat_interval",
        type=float,
        default=HEARTBEAT_INTERVAL_SECONDS,
        help="Heartbeat interval in seconds (default: 30)",
    )
    args = parser.parse_args(argv)

    resolved_machine_id = resolve_configured_machine_id(
        explicit_machine_id=args.machine_id,
        env_file_path=args.env_file,
    )
    db_client = _create_firestore_client_from_env()

    processor = MachineOrderProcessor(
        machine_id=resolved_machine_id,
        firestore_db=db_client,
        heartbeat_interval_seconds=args.heartbeat_interval,
    )

    stop_signal = threading.Event()

    def _handle_signal(signum: int, frame: Any) -> None:
        processor.logger.info("Received signal %s; shutting down CAFFIX RPi controller...", signum)
        stop_signal.set()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    # Start 30-second heartbeat thread first so connectivity is reported even if listener reconnects
    processor.start_heartbeat(interval_seconds=args.heartbeat_interval, send_immediately=True)

    unsubscribe = None
    try:
        unsubscribe = processor.start_firestore_listener(start_heartbeat=False)
    except Exception as exc:
        processor.logger.error("Initial Firestore order listener failed to attach (heartbeat remains active): %s", exc)

    try:
        while not stop_signal.wait(timeout=5.0):
            if unsubscribe is None and db_client is not None:
                try:
                    unsubscribe = processor.start_firestore_listener(start_heartbeat=False)
                except Exception as exc:
                    processor.logger.warning("Retrying Firestore order listener attachment: %s", exc)
    finally:
        if unsubscribe is not None and hasattr(unsubscribe, "unsubscribe"):
            try:
                unsubscribe.unsubscribe()
            except Exception:
                pass
        processor.stop_heartbeat()

    return 0


if __name__ == "__main__":
    sys.exit(main())
