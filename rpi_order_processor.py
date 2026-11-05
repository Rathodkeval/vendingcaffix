"""
CAFFIX Multi-Machine Raspberry Pi Firestore Order Processor
-----------------------------------------------------------
Filters Firebase Firestore `orders` strictly by the configured `MACHINE_ID`
and uses atomic Firestore transactions to claim orders so that:
1. Each Raspberry Pi only processes orders assigned to its own `MACHINE_ID`.
2. Duplicate payment notifications or Firebase listener reconnections can
   never trigger duplicate dispensing on the Arduino GIGA R1.
3. Existing Arduino GIGA R1 serial protocol and motor/sensor logic remain unchanged.
"""

import os
import re
import time
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, Set

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s"
)

MACHINE_ID = os.getenv("MACHINE_ID", "CFX-MC-01").strip()
MACHINE_ID_PATTERN = re.compile(r"^CFX-MC-\d{2,4}$")

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


class MachineOrderProcessor:
    """
    Processes Firestore orders exclusively for a single vending machine (`machine_id`).
    Provides atomic transactional order claiming and local deduplication.
    """

    def __init__(
        self,
        machine_id: str = MACHINE_ID,
        firestore_db: Optional[Any] = None,
        arduino_dispense_callback: Optional[Callable[[Dict[str, Any]], bool]] = None,
    ):
        self.machine_id = validate_machine_id(machine_id)
        self.db = firestore_db
        self.arduino_dispense_callback = arduino_dispense_callback
        self.logger = logging.getLogger(f"CAFFIX-RPi-{self.machine_id}")
        self._lock = threading.Lock()
        self._processed_order_ids: Set[str] = set()

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

    def claim_and_process_order(self, order_id: str, doc_ref: Optional[Any] = None, order_snapshot_data: Optional[Dict[str, Any]] = None) -> bool:
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

    def start_firestore_listener(self, collection_name: str = "orders") -> Any:
        """
        Attach a real-time Firestore snapshot listener filtered strictly by `machine_id == self.machine_id`.
        Returns the unsubscribe handle.
        """
        if self.db is None:
            raise RuntimeError("Firestore database client is required to start listener.")

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

