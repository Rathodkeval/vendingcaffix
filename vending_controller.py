import json
import os
import signal
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
import serial
import serial.tools.list_ports
import firebase_admin
from firebase_admin import credentials, firestore


# =====================================================
# FIREBASE & BACKEND HEARTBEAT CONFIGURATION
# =====================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SERVICE_ACCOUNT_FILE = os.path.join(BASE_DIR, "serviceAccountKey.json")
ORDERS_COLLECTION = "orders"

# Optional: set CAFFIX_MACHINE_ID for separate commercial machines.
# If blank, this controller accepts orders from the whole collection.
MACHINE_ID = os.environ.get("CAFFIX_MACHINE_ID", "").strip()

CAFFIX_API_BASE = (
    os.environ.get("CAFFIX_API_BASE", "https://vendingcaffix.vercel.app/api")
    .strip()
    .rstrip("/")
)
CAFFIX_KIOSK_TOKEN = os.environ.get("CAFFIX_KIOSK_TOKEN", "").strip()
HEARTBEAT_INTERVAL_SECONDS = 30.0
HEARTBEAT_HTTP_TIMEOUT_SECONDS = 8.0
JWT_REFRESH_INTERVAL_SECONDS = 23 * 3600

db = None


def init_firestore_client():
    """
    Initialize Firebase Admin Firestore client from serviceAccountKey.json when available.
    Preserves module-level initialization on the Raspberry Pi while allowing unit tests
    to import this module without live service account files on disk.
    """
    global db

    if db is not None:
        return db

    if not os.path.exists(SERVICE_ACCOUNT_FILE):
        return None

    if not firebase_admin._apps:
        cred = credentials.Certificate(SERVICE_ACCOUNT_FILE)
        firebase_admin.initialize_app(cred)

    db = firestore.client()
    return db


def ensure_firestore_client():
    client = init_firestore_client()
    if client is None:
        raise FileNotFoundError(
            f"Firebase service account file not found: {SERVICE_ACCOUNT_FILE}"
        )
    return client


init_firestore_client()


# =====================================================
# ARDUINO SETTINGS
# =====================================================

BAUDRATE = 115200
SERIAL_TIMEOUT = 0.2
WRITE_TIMEOUT = 2

PING_COMMAND = "PING"
ARDUINO_RESPONSE = "CAFFIX_ARDUINO"


# =====================================================
# GLOBAL CONTROLLER STATE
# =====================================================

arduino = None

arduino_lock = threading.Lock()
machine_lock = threading.Lock()

processed_orders = set()
orders_in_progress = set()
order_state_lock = threading.Lock()

heartbeat_stop_event = threading.Event()
heartbeat_thread = None
heartbeat_token_lock = threading.Lock()
_heartbeat_jwt_cache = {
    "token": None,
    "machine_id": None,
    "fetched_at": 0.0,
}


# =====================================================
# SERIAL HELPERS
# =====================================================

def close_serial():
    global arduino

    if arduino is not None:
        try:
            if arduino.is_open:
                arduino.close()
        except Exception:
            pass

    arduino = None


# =====================================================
# READ SERIAL LINES
# =====================================================

def read_serial_lines(ser, duration=1.5):
    lines = []

    end_time = time.monotonic() + duration

    while time.monotonic() < end_time:
        try:
            raw = ser.readline()

            if raw:
                line = raw.decode(
                    errors="ignore"
                ).strip()

                if line:
                    lines.append(line)
            else:
                time.sleep(0.05)

        except Exception:
            break

    return lines


# =====================================================
# ARDUINO AUTO DETECTION - UPDATED
# =====================================================

def connect_arduino():

    global arduino

    print(
        "\nSearching for CAFFIX Arduino GIGA R1...\n"
    )

    while True:

        ports = list(
            serial.tools.list_ports.comports()
        )

        if not ports:

            print(
                "No serial ports found. "
                "Retrying in 2 seconds..."
            )

            time.sleep(2)
            continue

        # ---------------------------------
        # PRIORITIZE ARDUINO ACM PORTS
        # ---------------------------------

        arduino_ports = [
            port for port in ports
            if port.device.startswith("/dev/ttyACM")
        ]

        other_ports = [
            port for port in ports
            if not port.device.startswith("/dev/ttyACM")
        ]

        # Arduino ports will be checked first
        ordered_ports = arduino_ports + other_ports

        # ---------------------------------
        # CHECK SERIAL PORTS
        # ---------------------------------

        for port in ordered_ports:

            ser = None

            try:

                print(
                    f"Checking {port.device} "
                    f"({port.description})"
                )

                # ---------------------------------
                # OPEN SERIAL PORT
                # ---------------------------------

                ser = serial.Serial(
                    port=port.device,
                    baudrate=BAUDRATE,
                    timeout=SERIAL_TIMEOUT,
                    write_timeout=WRITE_TIMEOUT
                )

                # ---------------------------------
                # RESET DELAY
                # ---------------------------------

                time.sleep(2)

                ser.reset_input_buffer()
                ser.reset_output_buffer()

                # ---------------------------------
                # SEND PING
                # ---------------------------------

                ser.write(
                    (
                        PING_COMMAND + "\n"
                    ).encode("ascii")
                )

                ser.flush()

                # ---------------------------------
                # READ RESPONSE
                # ---------------------------------

                responses = read_serial_lines(
                    ser,
                    duration=1.5
                )

                print(
                    f"Responses from "
                    f"{port.device}: {responses}"
                )

                # ---------------------------------
                # IDENTIFY ARDUINO
                # ---------------------------------

                if ARDUINO_RESPONSE in responses:

                    print(
                        "\n==================================="
                    )

                    print(
                        " CAFFIX ARDUINO GIGA R1 FOUND"
                    )

                    print(
                        f" Port: {port.device}"
                    )

                    print(
                        "===================================\n"
                    )

                    arduino = ser

                    return ser

                print(
                    f"Not CAFFIX Arduino: {port.device}"
                )

                ser.close()

            except Exception as error:

                print(
                    f"{port.device} failed: {error}"
                )

                if ser is not None:

                    try:
                        ser.close()

                    except Exception:
                        pass

        print(
            "\nArduino not found. "
            "Retrying in 2 seconds...\n"
        )

        time.sleep(2)


# =====================================================
# ENSURE ARDUINO CONNECTION
# =====================================================

def ensure_connection():
    global arduino

    if arduino is None or not arduino.is_open:
        arduino = connect_arduino()

    return arduino


# =====================================================
# SEND RAW COMMAND
# =====================================================

def send_raw_command(command):
    global arduino

    while True:

        try:

            ensure_connection()

            arduino.write(
                (
                    command.strip() + "\n"
                ).encode("ascii")
            )

            arduino.flush()

            return

        except Exception as error:

            print(
                f"Arduino write error: {error}"
            )

            close_serial()

            print(
                "Reconnecting to Arduino..."
            )

            time.sleep(1)


# =====================================================
# WAIT FOR ARDUINO MESSAGE
# =====================================================

def wait_for_message(
    target_messages,
    timeout=None
):

    global arduino

    if isinstance(target_messages, str):

        target_messages = {
            target_messages
        }

    else:

        target_messages = set(
            target_messages
        )

    start_time = time.monotonic()

    while True:

        # ---------------------------------
        # TIMEOUT
        # ---------------------------------

        if (
            timeout is not None
            and time.monotonic() - start_time
            >= timeout
        ):

            return None

        try:

            if (
                arduino is None
                or not arduino.is_open
            ):

                return None

            raw = arduino.readline()

            if not raw:
                continue

            message = raw.decode(
                errors="ignore"
            ).strip()

            if not message:
                continue

            print(
                "Arduino:",
                message
            )

            # ---------------------------------
            # CHECK EXPECTED MESSAGE
            # ---------------------------------

            if message in target_messages:
                return message

        except Exception as error:

            print(
                f"Serial read error: {error}"
            )

            return None


# =====================================================
# SEND COMMAND TO ARDUINO
# =====================================================

def send_to_arduino(
    command,
    expected="DONE",
    timeout=None
):

    if timeout is None:

        timeout = (
            180
            if command != "HOME"
            else 90
        )

    with machine_lock:

        print(
            "\n================================="
        )

        print(
            "Sending Command ->",
            command
        )

        print(
            "=================================\n"
        )

        with arduino_lock:

            # ---------------------------------
            # SEND COMMAND
            # ---------------------------------

            send_raw_command(command)

            if expected is None:
                return True

            # ---------------------------------
            # WAIT FOR RESPONSE
            # ---------------------------------

            result = wait_for_message(
                expected,
                timeout=timeout
            )

            if result == expected:

                print(
                    f"Command completed successfully: "
                    f"{command}"
                )

                return True

            print(
                f"Timeout waiting for Arduino response: "
                f"{expected}"
            )

            return False


# =====================================================
# BACKEND HEARTBEAT CLIENT (PHASE H.1)
# =====================================================

def clear_heartbeat_jwt_cache():
    with heartbeat_token_lock:
        _heartbeat_jwt_cache["token"] = None
        _heartbeat_jwt_cache["machine_id"] = None
        _heartbeat_jwt_cache["fetched_at"] = 0.0


def _resolve_heartbeat_config(machine_id=None, kiosk_token=None, api_base=None):
    resolved_machine_id = (MACHINE_ID if machine_id is None else str(machine_id)).strip()
    resolved_kiosk_token = (
        CAFFIX_KIOSK_TOKEN if kiosk_token is None else str(kiosk_token)
    ).strip()
    resolved_api_base = (
        CAFFIX_API_BASE if api_base is None else str(api_base)
    ).strip().rstrip("/")
    return resolved_machine_id, resolved_kiosk_token, resolved_api_base


def fetch_kiosk_jwt(
    machine_id=None,
    kiosk_token=None,
    api_base=None,
    timeout=None,
):
    resolved_timeout = HEARTBEAT_HTTP_TIMEOUT_SECONDS if timeout is None else timeout
    target_machine_id, secret_token, base_url = _resolve_heartbeat_config(
        machine_id, kiosk_token, api_base
    )
    if not target_machine_id:
        raise ValueError("CAFFIX_MACHINE_ID is required to authenticate kiosk heartbeat.")
    if not secret_token:
        raise ValueError("CAFFIX_KIOSK_TOKEN is required to authenticate kiosk heartbeat.")
    if not base_url:
        raise ValueError("CAFFIX_API_BASE is required to authenticate kiosk heartbeat.")

    query = urllib.parse.urlencode(
        {"kiosk": secret_token, "machine_id": target_machine_id}
    )
    verify_url = f"{base_url}/kiosk/verify?{query}"
    req = urllib.request.Request(
        verify_url,
        headers={"Accept": "application/json"},
        method="GET",
    )

    with urllib.request.urlopen(req, timeout=resolved_timeout) as resp:
        raw_body = resp.read().decode("utf-8", errors="replace")

    payload = json.loads(raw_body or "{}")
    if not payload.get("authorized"):
        raise RuntimeError(
            f"Kiosk verify rejected for machine {target_machine_id}"
        )

    verified_machine_id = str(payload.get("machine_id", "")).strip()
    if verified_machine_id != target_machine_id:
        raise RuntimeError(
            f"Kiosk JWT machine mismatch: expected {target_machine_id}, got {verified_machine_id}"
        )

    jwt_token = str(payload.get("token", "")).strip()
    if not jwt_token:
        raise RuntimeError("Kiosk verify response missing JWT token")

    with heartbeat_token_lock:
        _heartbeat_jwt_cache["token"] = jwt_token
        _heartbeat_jwt_cache["machine_id"] = target_machine_id
        _heartbeat_jwt_cache["fetched_at"] = time.monotonic()

    return jwt_token


def get_valid_kiosk_jwt(
    force_refresh=False,
    machine_id=None,
    kiosk_token=None,
    api_base=None,
    timeout=None,
):
    target_machine_id, _, _ = _resolve_heartbeat_config(
        machine_id, kiosk_token, api_base
    )

    if not force_refresh:
        with heartbeat_token_lock:
            cached_token = _heartbeat_jwt_cache.get("token")
            cached_machine = _heartbeat_jwt_cache.get("machine_id")
            fetched_at = _heartbeat_jwt_cache.get("fetched_at", 0.0)
            if (
                cached_token
                and cached_machine == target_machine_id
                and (time.monotonic() - fetched_at) < JWT_REFRESH_INTERVAL_SECONDS
            ):
                return cached_token

    return fetch_kiosk_jwt(
        machine_id=machine_id,
        kiosk_token=kiosk_token,
        api_base=api_base,
        timeout=timeout,
    )


def _post_heartbeat_request(base_url, target_machine_id, jwt_token, timeout):
    resolved_timeout = HEARTBEAT_HTTP_TIMEOUT_SECONDS if timeout is None else timeout
    url = f"{base_url}/machines/{urllib.parse.quote(target_machine_id, safe='')}/heartbeat"
    req = urllib.request.Request(
        url,
        data=b"{}",
        headers={
            "Authorization": f"Bearer {jwt_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=resolved_timeout) as resp:
        raw_body = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw_body or "{}")


def send_heartbeat_once(
    machine_id=None,
    kiosk_token=None,
    api_base=None,
    timeout=None,
):
    resolved_timeout = HEARTBEAT_HTTP_TIMEOUT_SECONDS if timeout is None else timeout
    target_machine_id, secret_token, base_url = _resolve_heartbeat_config(
        machine_id, kiosk_token, api_base
    )
    if not target_machine_id or not secret_token or not base_url:
        return None

    jwt_token = get_valid_kiosk_jwt(
        force_refresh=False,
        machine_id=target_machine_id,
        kiosk_token=secret_token,
        api_base=base_url,
        timeout=resolved_timeout,
    )

    try:
        return _post_heartbeat_request(
            base_url, target_machine_id, jwt_token, resolved_timeout
        )
    except urllib.error.HTTPError as err:
        if err.code == 401:
            clear_heartbeat_jwt_cache()
            refreshed_jwt = get_valid_kiosk_jwt(
                force_refresh=True,
                machine_id=target_machine_id,
                kiosk_token=secret_token,
                api_base=base_url,
                timeout=resolved_timeout,
            )
            return _post_heartbeat_request(
                base_url, target_machine_id, refreshed_jwt, resolved_timeout
            )
        raise


def heartbeat_loop(
    stop_event,
    machine_id=None,
    kiosk_token=None,
    api_base=None,
    interval_seconds=None,
    timeout=None,
):
    resolved_interval = (
        HEARTBEAT_INTERVAL_SECONDS if interval_seconds is None else interval_seconds
    )
    resolved_timeout = HEARTBEAT_HTTP_TIMEOUT_SECONDS if timeout is None else timeout
    target_machine_id, _, _ = _resolve_heartbeat_config(
        machine_id, kiosk_token, api_base
    )
    consecutive_failures = 0

    while not stop_event.is_set():
        try:
            response = send_heartbeat_once(
                machine_id=machine_id,
                kiosk_token=kiosk_token,
                api_base=api_base,
                timeout=resolved_timeout,
            )
            if response and response.get("status") == "success":
                data = response.get("data") or {}
                last_seen = data.get("last_seen")
                if consecutive_failures > 0 or last_seen:
                    if consecutive_failures > 0:
                        print(
                            f"[Heartbeat] Connectivity restored for {target_machine_id} "
                            f"(connection_status={data.get('connection_status')}, last_seen={last_seen})"
                        )
                consecutive_failures = 0
        except urllib.error.HTTPError as err:
            consecutive_failures += 1
            if consecutive_failures == 1 or consecutive_failures % 10 == 0:
                print(
                    f"[Heartbeat] HTTP error for {target_machine_id}: "
                    f"status={err.code} (failures={consecutive_failures})"
                )
        except Exception as err:
            consecutive_failures += 1
            if consecutive_failures == 1 or consecutive_failures % 10 == 0:
                print(
                    f"[Heartbeat] Unavailable for {target_machine_id}: "
                    f"{type(err).__name__} (failures={consecutive_failures})"
                )

        if stop_event.wait(resolved_interval):
            break


def start_heartbeat_thread(
    machine_id=None,
    kiosk_token=None,
    api_base=None,
    interval_seconds=None,
    timeout=None,
):
    global heartbeat_thread

    resolved_interval = (
        HEARTBEAT_INTERVAL_SECONDS if interval_seconds is None else interval_seconds
    )
    resolved_timeout = HEARTBEAT_HTTP_TIMEOUT_SECONDS if timeout is None else timeout
    target_machine_id, secret_token, base_url = _resolve_heartbeat_config(
        machine_id, kiosk_token, api_base
    )

    if not target_machine_id or not secret_token or not base_url:
        print(
            "[Heartbeat] CAFFIX_KIOSK_TOKEN not configured; "
            "skipping backend heartbeat thread."
        )
        return None

    stop_heartbeat_thread()
    heartbeat_stop_event.clear()

    heartbeat_thread = threading.Thread(
        target=heartbeat_loop,
        kwargs={
            "stop_event": heartbeat_stop_event,
            "machine_id": target_machine_id,
            "kiosk_token": secret_token,
            "api_base": base_url,
            "interval_seconds": resolved_interval,
            "timeout": resolved_timeout,
        },
        name=f"caffix-heartbeat-{target_machine_id}",
        daemon=True,
    )
    heartbeat_thread.start()
    print(
        f"[Heartbeat] Started {resolved_interval:g}s backend heartbeat thread for {target_machine_id}."
    )
    return heartbeat_thread


def stop_heartbeat_thread(timeout=3.0):
    global heartbeat_thread

    heartbeat_stop_event.set()
    if heartbeat_thread is not None:
        try:
            heartbeat_thread.join(timeout=timeout)
        except Exception:
            pass
        heartbeat_thread = None


# =====================================================
# COFFEE COMMAND CONVERSION
# =====================================================

COFFEE_COMMANDS = {

    "Classic Crest": "CLASSIC",

    "Vanilla Velvet": "VANILLA",

    "Hazel Gold": "HAZELNUT",

    "Irish Emerald": "IRISH",

    "Mocha Bliss": "MOCHA"

}


# =====================================================
# MILK POWDER FLAG NORMALIZATION
# =====================================================

def normalize_binary_flag(value):
    if isinstance(value, bool):
        return 1 if value else 0

    if isinstance(value, str):
        value = value.strip().lower()
        if value in {"true", "yes", "on", "1"}:
            return 1
        if value in {"false", "no", "off", "0", ""}:
            return 0

    try:
        return 1 if int(value) == 1 else 0
    except (TypeError, ValueError):
        return 0


# =====================================================
# BUILD COFFEE COMMAND
# =====================================================

def build_coffee_command(data):

    coffee_name = str(data.get("product_name", "")).strip()
    base = str(data.get("base", "water")).strip().upper()

    coffee_command = COFFEE_COMMANDS.get(coffee_name)

    if coffee_command is None:
        raise ValueError(f"Unknown coffee type: {coffee_name}")

    if base not in {"MILK", "WATER"}:
        raise ValueError(f"Unknown base: {base}")

    # Firebase extra_sugar controls the Arduino milk-powder input:
    # extra_sugar = 1 sends 1; extra_sugar = 0 sends 0.
    milk_powder = normalize_binary_flag(data.get("extra_sugar", 0))

    return f"{coffee_command},{base},{milk_powder}"


ELIGIBLE_ORDER_STATUSES = {
    "PAID",
    "PREPARING",
    "COMPLETED",
}

NON_PROCESSABLE_DISPENSE_STATES = {
    "CLAIMING",
    "DISPENSING",
    "DISPENSED",
    "FAILED",
    "CANCELLED",
    "EXPIRED",
}

ORDER_MAX_CLAIM_AGE_SECONDS = int(
    os.environ.get("CAFFIX_ORDER_MAX_CLAIM_AGE_SECONDS", "900")
)


def _parse_utc_timestamp(value):
    if not value or not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def _is_order_expired(data, max_claim_age_seconds=None):
    if not isinstance(data, dict):
        return True
    if data.get("expired_at"):
        return True

    now_utc = datetime.now(timezone.utc)
    expires_dt = _parse_utc_timestamp(data.get("expires_at"))
    if expires_dt is not None:
        return now_utc >= expires_dt

    resolved_max_age = (
        ORDER_MAX_CLAIM_AGE_SECONDS
        if max_claim_age_seconds is None
        else max_claim_age_seconds
    )
    if resolved_max_age and resolved_max_age > 0:
        created_dt = _parse_utc_timestamp(data.get("created_at"))
        if created_dt is not None:
            return (now_utc - created_dt).total_seconds() >= resolved_max_age

    return False


def order_belongs_to_this_machine(data):
    if not MACHINE_ID:
        return False

    return (
        str(data.get("machine_id", "")).strip()
        == MACHINE_ID
    )


def is_order_eligible_for_local_controller(data):
    if not isinstance(data, dict) or not order_belongs_to_this_machine(data):
        return False

    status = str(data.get("status") or "").strip().upper()
    if status not in ELIGIBLE_ORDER_STATUSES:
        return False

    if data.get("dispensed") is True or data.get("expired_at"):
        return False

    dispense_status = str(data.get("dispense_status") or "").strip().upper()
    if dispense_status in NON_PROCESSABLE_DISPENSE_STATES:
        return False

    # Paid/preparing orders must be explicitly QUEUED for dispensing.
    # Legacy COMPLETED orders are eligible only when explicitly QUEUED.
    if status in {"PAID", "PREPARING", "COMPLETED"} and dispense_status != "QUEUED":
        return False

    dispense_outcome = str(data.get("dispense_outcome") or "").strip().upper()
    if dispense_outcome in {"UNCERTAIN", "DISPENSED"}:
        return False

    refund_status = str(data.get("refund_status") or "").strip().upper()
    if refund_status in {"FULL", "PENDING", "PARTIAL"}:
        return False

    for refund_field in (
        "pending_refund_amount_paise",
        "total_refunded_amount_paise",
        "refunded_amount_paise",
    ):
        raw_val = data.get(refund_field)
        if raw_val is not None and raw_val != "":
            try:
                if float(raw_val) > 0:
                    return False
            except (TypeError, ValueError):
                return False

    if _is_order_expired(data):
        return False

    return True


def build_machine_orders_query(client=None):
    resolved_client = ensure_firestore_client() if client is None else client
    collection_ref = resolved_client.collection(ORDERS_COLLECTION)
    if not MACHINE_ID:
        return collection_ref

    try:
        from google.cloud.firestore_v1.base_query import FieldFilter

        return collection_ref.where(
            filter=FieldFilter("machine_id", "==", MACHINE_ID)
        )
    except Exception:
        return collection_ref.where("machine_id", "==", MACHINE_ID)


def claim_order_in_firestore(
    order_id,
    doc_ref=None,
    fallback_data=None,
    client=None,
):
    """
    Atomically verifies eligibility and transitions `orders/{order_id}` to
    `dispense_status = "DISPENSING"` BEFORE sending the Arduino serial command.

    SAFETY INVARIANTS (Phase H.3 Second-Level Review):
    - Always executes inside a genuine Firestore transaction.
    - Never falls back to a non-transactional get/set or local dict claim.
    - If the client lacks transaction support or the transaction fails/conflicts,
      returns None immediately so Arduino dispensing is never triggered.
    """
    if not order_id or not MACHINE_ID:
        return None

    resolved_doc_ref = doc_ref
    resolved_client = client
    if resolved_client is None and resolved_doc_ref is not None:
        resolved_client = getattr(resolved_doc_ref, "_client", None)

    if resolved_client is None:
        try:
            resolved_client = ensure_firestore_client()
        except Exception:
            resolved_client = db

    if resolved_doc_ref is None and resolved_client is not None:
        try:
            resolved_doc_ref = resolved_client.collection(
                ORDERS_COLLECTION
            ).document(order_id)
        except Exception:
            resolved_doc_ref = None

    if (
        resolved_doc_ref is None
        or resolved_client is None
        or not hasattr(resolved_client, "transaction")
    ):
        print(
            f"Refusing order claim for {order_id}: genuine Firestore transaction client is required."
        )
        return None

    def _apply_claim_on_snapshot(snap_data):
        if not is_order_eligible_for_local_controller(snap_data):
            return None
        # Validate command build before claiming in Firestore
        build_coffee_command(snap_data)
        now_iso = datetime.now(timezone.utc).isoformat()
        updates = {
            "dispense_status": "DISPENSING",
            "dispensed": False,
            "claimed_by": MACHINE_ID,
            "claimed_at": now_iso,
            "dispense_started_at": now_iso,
            "updated_at": now_iso,
        }
        return updates

    def _run_claim_body(transaction):
        snapshot = resolved_doc_ref.get(transaction=transaction)
        if not getattr(snapshot, "exists", False):
            return None
        live_data = snapshot.to_dict() or {}
        live_data["id"] = live_data.get("id") or order_id
        updates = _apply_claim_on_snapshot(live_data)
        if updates is None:
            return None
        transaction.set(resolved_doc_ref, updates, merge=True)
        merged = dict(live_data)
        merged.update(updates)
        return merged

    try:
        tx_obj = resolved_client.transaction()

        # Support test transaction harnesses that provide atomic `run(...)` or `_tx_lock`
        if hasattr(tx_obj, "run") and callable(tx_obj.run):
            return tx_obj.run(_run_claim_body)

        from google.cloud import firestore as gc_firestore

        @gc_firestore.transactional
        def _tx_claim(transaction):
            return _run_claim_body(transaction)

        return _tx_claim(tx_obj)
    except ValueError:
        raise
    except Exception as tx_err:
        print(
            f"Firestore transaction claim aborted for {order_id}: {tx_err}"
        )
        return None


OUTCOME_WRITE_MAX_RETRIES = 3
OUTCOME_WRITE_RETRY_DELAY_SECONDS = 0.05
pending_outcome_writes = {}
pending_outcome_lock = threading.Lock()


def flush_pending_outcome_writes():
    """
    Retries any post-dispense Firestore outcome updates that previously failed
    due to a temporary network interruption. Never re-sends Arduino commands.
    """
    with pending_outcome_lock:
        items = list(pending_outcome_writes.items())

    for order_id, entry in items:
        target_ref = entry.get("doc_ref")
        payload = entry.get("updates")
        if target_ref is None or not hasattr(target_ref, "set") or not payload:
            with pending_outcome_lock:
                pending_outcome_writes.pop(order_id, None)
            continue
        try:
            target_ref.set(payload, merge=True)
            with pending_outcome_lock:
                pending_outcome_writes.pop(order_id, None)
            print(
                f"Recovered pending Firestore outcome write for order {order_id}."
            )
        except Exception:
            pass


def record_dispense_outcome_in_firestore(
    order_id,
    success,
    doc_ref=None,
    failure_stage="DURING_DISPENSE",
    failure_reason=None,
    client=None,
):
    """
    Writes the post-claim dispense outcome to `orders/{order_id}`:
    - If `success` is True (Arduino returned DONE): marks `DISPENSED` (`dispensed=True`).
    - If `success` is False and `failure_stage == "PRE_DISPENSE"` (Arduino disconnected
      or serial write failed BEFORE command bytes were transmitted):
      marks `FAILED` with `dispense_outcome="NOT_DISPENSED"`, `failure_stage="PRE_DISPENSE"`,
      and clears `dispense_started_at`/`claimed_at` so the order qualifies for safe auto-refund.
    - If `success` is False and `failure_stage == "DURING_DISPENSE"` (timeout or disconnect
      AFTER command bytes were transmitted):
      marks `FAILED` with `dispense_outcome="UNCERTAIN"`, `failure_stage="DURING_DISPENSE"`
      so automatic refund is blocked pending manual inspection.
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    normalized_stage = str(failure_stage or "DURING_DISPENSE").strip().upper()
    if success:
        post_updates = {
            "dispense_status": "DISPENSED",
            "dispensed": True,
            "dispense_outcome": "DISPENSED",
            "dispensed_by": MACHINE_ID,
            "dispensed_at": now_iso,
            "updated_at": now_iso,
        }
    elif normalized_stage == "PRE_DISPENSE":
        post_updates = {
            "dispense_status": "FAILED",
            "dispensed": False,
            "dispense_outcome": "NOT_DISPENSED",
            "failure_stage": "PRE_DISPENSE",
            "failure_reason": (
                failure_reason
                or "ARDUINO_UNAVAILABLE_BEFORE_COMMAND_TRANSMISSION"
            ),
            "dispense_started_at": None,
            "claimed_at": None,
            "updated_at": now_iso,
        }
    else:
        post_updates = {
            "dispense_status": "FAILED",
            "dispensed": False,
            "dispense_outcome": "UNCERTAIN",
            "failure_stage": "DURING_DISPENSE",
            "failure_reason": (
                failure_reason
                or "ARDUINO_TIMEOUT_OR_SERIAL_DISCONNECT_DURING_DISPENSE"
            ),
            "dispensed_by": MACHINE_ID,
            "updated_at": now_iso,
        }

    resolved_doc_ref = doc_ref
    if resolved_doc_ref is None:
        try:
            resolved_client = (
                ensure_firestore_client() if client is None else client
            )
            if resolved_client is not None:
                resolved_doc_ref = resolved_client.collection(
                    ORDERS_COLLECTION
                ).document(order_id)
        except Exception:
            resolved_doc_ref = None

    if resolved_doc_ref is not None and hasattr(resolved_doc_ref, "set"):
        wrote = False
        last_exc = None
        for attempt in range(OUTCOME_WRITE_MAX_RETRIES):
            try:
                resolved_doc_ref.set(post_updates, merge=True)
                wrote = True
                with pending_outcome_lock:
                    pending_outcome_writes.pop(order_id, None)
                break
            except Exception as exc:
                last_exc = exc
                if attempt + 1 < OUTCOME_WRITE_MAX_RETRIES:
                    time.sleep(OUTCOME_WRITE_RETRY_DELAY_SECONDS)

        if not wrote:
            with pending_outcome_lock:
                pending_outcome_writes[order_id] = {
                    "doc_ref": resolved_doc_ref,
                    "updates": dict(post_updates),
                }
            print(
                f"Failed to update post-dispense status in Firestore for {order_id}: {last_exc}. "
                "Queued for background retry; order will NOT be re-dispensed."
            )

    return post_updates


def execute_arduino_dispense_for_order(command, timeout=180):
    """
    Executes the Arduino GIGA R1 dispense command while strictly classifying serial outcomes:
    1. Arduino disconnected before any write attempt ->
       PRE_DISPENSE / NOT_DISPENSED (dispense_started_at = None, claimed_at = None)
    2. Serial write returns 0 bytes without exception and zero transmission is reliably established ->
       PRE_DISPENSE / NOT_DISPENSED (dispense_started_at = None, claimed_at = None)
    3. Partial transmission (0 < written < expected_bytes), write timeout (SerialTimeoutException),
       any write/flush exception, or any uncertainty about bytes reaching Arduino ->
       DURING_DISPENSE / UNCERTAIN (preserves dispense_started_at, blocks auto-refund)
    4. Full command transmission followed by missing DONE (timeout or disconnect) ->
       DURING_DISPENSE / UNCERTAIN (preserves dispense_started_at, blocks auto-refund)
    5. Full command transmission and Arduino returns DONE ->
       DISPENSED (dispensed = True, dispense_outcome = DISPENSED)

    If `send_to_arduino` has been patched/replaced in unit tests, delegates to `send_to_arduino`
    and treats `False` as `DURING_DISPENSE` (`UNCERTAIN`) by default.
    """
    if send_to_arduino is not _DEFAULT_SEND_TO_ARDUINO:
        ok = bool(send_to_arduino(command, expected="DONE", timeout=timeout))
        if ok:
            return {
                "success": True,
                "command_transmitted": True,
                "bytes_written": len((command.strip() + "\n").encode("ascii")),
                "failure_stage": None,
                "failure_reason": None,
            }
        return {
            "success": False,
            "command_transmitted": True,
            "bytes_written": None,
            "failure_stage": "DURING_DISPENSE",
            "failure_reason": "ARDUINO_TIMEOUT_OR_SERIAL_DISCONNECT_DURING_DISPENSE",
        }

    with machine_lock:
        print("\n=================================")
        print("Sending Command ->", command)
        print("=================================\n")

        with arduino_lock:
            # Rule 1: Arduino disconnected before any write attempt
            if arduino is None or not getattr(arduino, "is_open", False):
                print("Arduino disconnected before command transmission.")
                return {
                    "success": False,
                    "command_transmitted": False,
                    "bytes_written": 0,
                    "failure_stage": "PRE_DISPENSE",
                    "failure_reason": "ARDUINO_DISCONNECTED_BEFORE_COMMAND",
                }

            payload = (command.strip() + "\n").encode("ascii")
            expected_bytes = len(payload)
            serial_timeout_cls = getattr(serial, "SerialTimeoutException", TimeoutError)

            try:
                written = arduino.write(payload)
            except serial_timeout_cls as timeout_err:
                # Rule 3: Write timeout -> uncertain whether bytes reached Arduino
                print(f"Arduino serial write timeout (uncertain transmission): {timeout_err}")
                close_serial()
                return {
                    "success": False,
                    "command_transmitted": True,
                    "bytes_written": None,
                    "failure_stage": "DURING_DISPENSE",
                    "failure_reason": "SERIAL_WRITE_TIMEOUT_UNCERTAIN",
                }
            except TimeoutError as timeout_err:
                print(f"Arduino serial write timeout (uncertain transmission): {timeout_err}")
                close_serial()
                return {
                    "success": False,
                    "command_transmitted": True,
                    "bytes_written": None,
                    "failure_stage": "DURING_DISPENSE",
                    "failure_reason": "SERIAL_WRITE_TIMEOUT_UNCERTAIN",
                }
            except Exception as write_err:
                # Rule 3: Any write exception may have transmitted some bytes before raising ->
                # NEVER classify as PRE_DISPENSE; always classify as DURING_DISPENSE / UNCERTAIN.
                print(f"Arduino write exception (uncertain transmission): {write_err}")
                close_serial()
                return {
                    "success": False,
                    "command_transmitted": True,
                    "bytes_written": None,
                    "failure_stage": "DURING_DISPENSE",
                    "failure_reason": "SERIAL_WRITE_EXCEPTION_UNCERTAIN",
                }

            is_exact_int = isinstance(written, int) and not isinstance(written, bool)
            out_waiting = getattr(arduino, "out_waiting", 0)
            has_buffered_tx = (
                isinstance(out_waiting, int)
                and not isinstance(out_waiting, bool)
                and out_waiting > 0
            )

            # Rule 2: Serial write returns 0 bytes cleanly and zero transmission is reliably established
            if is_exact_int and written == 0 and not has_buffered_tx:
                print("Arduino serial write returned 0 bytes (zero transmission established).")
                close_serial()
                return {
                    "success": False,
                    "command_transmitted": False,
                    "bytes_written": 0,
                    "failure_stage": "PRE_DISPENSE",
                    "failure_reason": "SERIAL_WRITE_ZERO_BYTES",
                }

            # Rule 3: Partial transmission or uncertain byte count
            if not is_exact_int or written != expected_bytes:
                if is_exact_int and 0 < written < expected_bytes:
                    reason = "SERIAL_PARTIAL_WRITE_UNCERTAIN"
                    print(
                        f"Arduino partial serial write ({written}/{expected_bytes} bytes); "
                        "marking DURING_DISPENSE / UNCERTAIN."
                    )
                else:
                    reason = "SERIAL_WRITE_UNCERTAIN_BYTE_COUNT"
                    print(
                        f"Arduino serial write returned uncertain byte count ({written!r} vs {expected_bytes}); "
                        "marking DURING_DISPENSE / UNCERTAIN."
                    )
                close_serial()
                return {
                    "success": False,
                    "command_transmitted": True,
                    "bytes_written": written if is_exact_int else None,
                    "failure_stage": "DURING_DISPENSE",
                    "failure_reason": reason,
                }

            # Full byte count written to serial: any subsequent flush/read/timeout failure
            # has uncertain physical outcome and MUST be classified DURING_DISPENSE.
            try:
                arduino.flush()
            except Exception as flush_err:
                print(f"Arduino flush error after command write: {flush_err}")
                close_serial()
                return {
                    "success": False,
                    "command_transmitted": True,
                    "bytes_written": written,
                    "failure_stage": "DURING_DISPENSE",
                    "failure_reason": "ARDUINO_DISCONNECTED_AFTER_COMMAND_TRANSMISSION",
                }

            # Rule 5: Arduino returns DONE
            result = wait_for_message("DONE", timeout=timeout)
            if result == "DONE":
                print(f"Command completed successfully: {command}")
                return {
                    "success": True,
                    "command_transmitted": True,
                    "bytes_written": written,
                    "failure_stage": None,
                    "failure_reason": None,
                }

            # Rule 4: Full command transmission followed by missing DONE
            if arduino is None or not getattr(arduino, "is_open", False):
                reason = "ARDUINO_DISCONNECTED_AFTER_COMMAND_TRANSMISSION"
            else:
                reason = "ARDUINO_RESPONSE_TIMEOUT_AFTER_COMMAND"

            print(f"Arduino did not confirm DONE ({reason}).")
            return {
                "success": False,
                "command_transmitted": True,
                "bytes_written": written,
                "failure_stage": "DURING_DISPENSE",
                "failure_reason": reason,
            }


_DEFAULT_SEND_TO_ARDUINO = send_to_arduino


# =====================================================
# LOAD EXISTING ORDERS AT STARTUP
# =====================================================

def load_existing_orders():

    global processed_orders

    client = ensure_firestore_client()

    print(
        "\nLoading existing orders for machine..."
    )

    try:

        existing_orders = build_machine_orders_query(
            client
        ).stream()

        count = 0

        for document in existing_orders:

            data = document.to_dict() or {}

            if not order_belongs_to_this_machine(data):
                continue

            # Fresh, unexpired PAID/QUEUED orders remain eligible for dispensing;
            # all historical completed, dispensed, failed, expired, or refunded orders
            # are recorded in processed_orders so they are never dispensed on startup.
            if is_order_eligible_for_local_controller(data):
                continue

            processed_orders.add(document.id)

            count += 1

        print(
            f"Ignored {count} existing completed/historical orders."
        )

        print(
            "Only eligible queued orders will be processed.\n"
        )

    except Exception as error:

        print(
            "Error loading existing orders:",
            error
        )

        raise


# =====================================================
# FIRESTORE LISTENER
# =====================================================

def on_snapshot(
    collection_snapshot,
    changes,
    read_time
):
    flush_pending_outcome_writes()

    for change in changes:
        try:
            process_firestore_change(change)
        except Exception as error:
            print(f"Firestore order callback error: {error}")


def process_firestore_change(change):

    # ---------------------------------
    # PROCESS ADDED AND MODIFIED
    # ---------------------------------

    if change.type.name not in {
        "ADDED",
        "MODIFIED"
    }:

        return

    data = (
        change.document.to_dict()
        or {}
    )

    if not is_order_eligible_for_local_controller(data):
        return

    # ---------------------------------
    # ORDER ID & DOCUMENT REFERENCE
    # ---------------------------------

    order_id = change.document.id
    doc_ref = getattr(change.document, "reference", None)

    # ---------------------------------
    # PREVENT DUPLICATE ORDERS
    # ---------------------------------

    with order_state_lock:
        if order_id in processed_orders or order_id in orders_in_progress:
            print(f"Order {order_id} already handled/in progress; skipping.")
            return
        orders_in_progress.add(order_id)

    # ---------------------------------
    # BUILD COMMAND & TRANSACTIONALLY CLAIM ORDER (DISPENSING)
    # ---------------------------------

    try:

        command = build_coffee_command(
            data
        )

        claimed_data = claim_order_in_firestore(
            order_id=order_id,
            doc_ref=doc_ref,
            fallback_data=data,
        )

    except ValueError as error:

        print(
            f"Order {order_id} rejected: "
            f"{error}"
        )

        # Mark invalid order as processed
        # so it does not repeatedly retry

        with order_state_lock:
            processed_orders.add(order_id)
            orders_in_progress.discard(order_id)

        return

    if not claimed_data:
        with order_state_lock:
            orders_in_progress.discard(order_id)
        return

    # ---------------------------------
    # ORDER INFORMATION
    # ---------------------------------

    coffee = claimed_data.get(
        "product_name",
        ""
    )

    base = str(
        claimed_data.get(
            "base",
            "water"
        )
    ).upper()

    milk_powder = normalize_binary_flag(claimed_data.get("extra_sugar", 0))

    amount = claimed_data.get(
        "amount"
    )

    # ---------------------------------
    # DISPLAY ORDER
    # ---------------------------------

    print(
        "\n--------------------------------"
    )

    print(
        "NEW ORDER RECEIVED"
    )

    print(
        "Order ID    :",
        order_id
    )

    print(
        "Coffee      :",
        coffee
    )

    print(
        "Base        :",
        base
    )

    print(
        "Milk Powder :",
        milk_powder
    )

    print(
        "Extra Sugar :",
        claimed_data.get("extra_sugar", 0),
        "(not sent as Arduino third parameter)"
    )

    print(
        "Amount      :",
        amount
    )

    print(
        "Command     :",
        command
    )

    print(
        "--------------------------------"
    )

    # ---------------------------------
    # SEND COFFEE COMMAND & RECORD OUTCOME
    # ---------------------------------

    try:
        dispense_exec = execute_arduino_dispense_for_order(
            command,
            timeout=180
        )
        success = bool(dispense_exec["success"])
        failure_stage = dispense_exec.get("failure_stage")
        failure_reason = dispense_exec.get("failure_reason")

        record_dispense_outcome_in_firestore(
            order_id=order_id,
            success=success,
            doc_ref=doc_ref,
            failure_stage=failure_stage,
            failure_reason=failure_reason,
        )
    finally:
        # Once claimed, ALWAYS mark order_id in processed_orders so a Firestore
        # outcome write error or uncertain Arduino failure NEVER triggers a duplicate dispense.
        with order_state_lock:
            orders_in_progress.discard(order_id)
            processed_orders.add(order_id)

    if success:
        print(
            f"Order {order_id} "
            "completed and marked DISPENSED in Firestore."
        )
    elif failure_stage == "PRE_DISPENSE":
        print(
            f"Order {order_id} failed before command transmission ({failure_reason}). "
            "Marked FAILED (NOT_DISPENSED / PRE_DISPENSE) in Firestore."
        )
    else:
        print(
            f"Order {order_id} was not confirmed by Arduino ({failure_reason}). "
            "Marked FAILED (UNCERTAIN / DURING_DISPENSE) in Firestore."
        )


# =====================================================
# MAIN FUNCTION
# =====================================================

def _handle_sigterm(signum, frame):
    raise SystemExit(0)


def main():

    global arduino

    print("CAFFIX Raspberry Pi controller starting...")

    # ---------------------------------
    # MACHINE ID VALIDATION
    # ---------------------------------

    if not MACHINE_ID:
        raise RuntimeError(
            "CAFFIX_MACHINE_ID is not configured. "
            "Stopping to prevent processing other machines' orders."
        )

    print(f"Machine ID filter enabled: {MACHINE_ID}")

    watch = None
    previous_sigterm_handler = None
    registered_sigterm = False
    if (
        hasattr(signal, "SIGTERM")
        and threading.current_thread() is threading.main_thread()
    ):
        previous_sigterm_handler = signal.getsignal(signal.SIGTERM)
        signal.signal(signal.SIGTERM, _handle_sigterm)
        registered_sigterm = True

    try:

        # ---------------------------------
        # START BACKEND HEARTBEAT THREAD IMMEDIATELY
        # (independent of Arduino serial availability)
        # ---------------------------------

        start_heartbeat_thread()

        client = ensure_firestore_client()

        # ---------------------------------
        # CONNECT TO ARDUINO
        # ---------------------------------

        print(
            "Connecting to Arduino..."
        )

        arduino = connect_arduino()

        # ---------------------------------
        # CONTROLLER STARTED
        # ---------------------------------

        print(
            "==================================="
        )

        print(
            " CAFFIX Vending Controller Started "
        )

        print(
            "==================================="
        )

        # ---------------------------------
        # IMPORTANT:
        # LOAD OLD ORDERS BEFORE LISTENER
        # ---------------------------------

        load_existing_orders()

        print(
            f"Waiting for new queued orders for {MACHINE_ID}...\n"
        )

        # ---------------------------------
        # MACHINE-FILTERED FIRESTORE QUERY
        # ---------------------------------

        query = build_machine_orders_query(
            client
        )

        # ---------------------------------
        # START FIRESTORE LISTENER
        # ---------------------------------

        watch = query.on_snapshot(
            on_snapshot
        )

        print(
            "Firestore listener is running."
        )

        print(
            "Old completed orders will not be dispensed."
        )

        print(
            "Press Ctrl+C to stop."
        )

        # ---------------------------------
        # KEEP PROGRAM RUNNING
        # ---------------------------------

        while True:

            time.sleep(1)

    except (KeyboardInterrupt, SystemExit):

        print(
            "\nController stopped by user or signal."
        )

    finally:

        stop_heartbeat_thread()

        if watch is not None:
            try:
                watch.unsubscribe()
            except Exception:
                pass

        close_serial()

        if registered_sigterm:
            try:
                signal.signal(signal.SIGTERM, previous_sigterm_handler)
            except Exception:
                pass


# =====================================================
# PROGRAM ENTRY POINT
# =====================================================

if __name__ == "__main__":

    main()

