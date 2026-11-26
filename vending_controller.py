import json
import os
import re
import signal
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
import serial
import serial.tools.list_ports
import firebase_admin
from firebase_admin import credentials, firestore

try:
    import fcntl
except ImportError:
    fcntl = None

try:
    import msvcrt
except ImportError:
    msvcrt = None


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


ARDUINO_PING_TIMEOUT_SECONDS = 1.5
ARDUINO_RECONNECT_RETRY_SECONDS = 2.0

ARDUINO_ERROR_RESPONSES = {
    "ERROR",
    "NO_CUP",
    "CUP_MISSING",
    "NO_WATER",
    "NO_MILK",
    "FAIL",
    "FAILED",
    "ABORT",
    "FAULT",
}

ARDUINO_ERROR_PREFIXES = (
    "ERROR:",
    "ERROR_",
    "FAIL:",
    "FAULT:",
    "NO_CUP",
)

# =====================================================
# GLOBAL CONTROLLER STATE
# =====================================================

arduino = None
_arduino_responsive = False
_last_arduino_probe_at = 0.0

arduino_lock = threading.Lock()
machine_lock = threading.Lock()
dispense_lockout_lock = threading.Lock()

processed_orders = set()
orders_in_progress = set()
order_state_lock = threading.Lock()

arduino_reconnect_event = threading.Event()
heartbeat_stop_event = threading.Event()
heartbeat_thread = None
heartbeat_token_lock = threading.Lock()
_heartbeat_jwt_cache = {
    "token": None,
    "machine_id": None,
    "fetched_at": 0.0,
}

DEFAULT_POSIX_STATE_DIR = "/var/lib/caffix"

_dispense_lockout_state = None
_dispense_lockout_disk_checked = False
_fatal_lockout_persistence_error = None
lockout_persistence_failed_event = threading.Event()
_controller_runtime_active = False
_controller_runtime_lock_fd = None


class LockoutPersistenceError(RuntimeError):
    def __init__(
        self,
        message,
        order_id=None,
        failure_reason=None,
        command_transmitted=True,
    ):
        super().__init__(message)
        self.order_id = order_id
        self.failure_reason = failure_reason
        self.command_transmitted = command_transmitted


def get_dispense_state_dir():
    """
    Returns the dedicated persistent directory for controller fault/lockout state.
    Never uses a temporary directory (`/tmp` or system temp). On systemd Linux
    hosts, uses `CAFFIX_STATE_DIR` or `STATE_DIRECTORY` (`/var/lib/caffix`).
    """
    override_dir = os.environ.get("CAFFIX_STATE_DIR", "").strip()
    if override_dir:
        return os.path.abspath(override_dir)

    systemd_state_dir = os.environ.get("STATE_DIRECTORY", "").strip()
    if systemd_state_dir:
        first_dir = systemd_state_dir.split(":")[0].strip()
        if first_dir:
            return os.path.abspath(first_dir)

    if os.name != "nt":
        if os.path.isdir(DEFAULT_POSIX_STATE_DIR) or os.access("/var/lib", os.W_OK):
            return DEFAULT_POSIX_STATE_DIR

    return os.path.join(BASE_DIR, "state")


def _get_machine_tag():
    return re.sub(r"[^A-Za-z0-9._-]", "_", MACHINE_ID or "UNCONFIGURED")


def get_dispense_lockout_file_path():
    override = os.environ.get("CAFFIX_DISPENSE_LOCKOUT_FILE", "").strip()
    if override:
        return os.path.abspath(override)
    return os.path.join(get_dispense_state_dir(), f"dispense_lockout_{_get_machine_tag()}.json")


def get_dispense_inflight_file_path():
    lockout_path = get_dispense_lockout_file_path()
    parent_dir = os.path.dirname(os.path.abspath(lockout_path))
    return os.path.join(parent_dir, f"dispense_inflight_{_get_machine_tag()}.json")


def get_attempted_orders_file_path():
    override = os.environ.get("CAFFIX_ATTEMPTED_ORDERS_FILE", "").strip()
    if override:
        return os.path.abspath(override)
    lockout_path = get_dispense_lockout_file_path()
    parent_dir = os.path.dirname(os.path.abspath(lockout_path))
    return os.path.join(parent_dir, f"attempted_orders_{_get_machine_tag()}.json")


ATTEMPTED_ORDERS_MAX_ENTRIES = 500
attempted_orders_lock = threading.Lock()


def _load_attempted_orders_entries_unlocked():
    path = get_attempted_orders_file_path()
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("orders"), list):
            return [e for e in data["orders"] if isinstance(e, dict) and e.get("order_id")]
        return []
    except Exception:
        return []


def load_attempted_orders():
    with attempted_orders_lock:
        return {str(e["order_id"]): dict(e) for e in _load_attempted_orders_entries_unlocked()}


def is_order_in_attempted_ledger(order_id):
    if not order_id:
        return False
    return str(order_id) in load_attempted_orders()


def record_attempted_order(
    order_id,
    command_transmitted=False,
    mechanical_command_attempted=False,
    stage="PRE_DISPENSE",
):
    if not order_id:
        return
    normalized_id = str(order_id).strip()
    now_iso = datetime.now(timezone.utc).isoformat()
    with attempted_orders_lock:
        entries = _load_attempted_orders_entries_unlocked()
        by_id = {str(e["order_id"]): dict(e) for e in entries}
        prev = by_id.get(normalized_id, {})
        by_id[normalized_id] = {
            "order_id": normalized_id,
            "machine_id": MACHINE_ID,
            "command_transmitted": bool(prev.get("command_transmitted") or command_transmitted),
            "mechanical_command_attempted": bool(
                prev.get("mechanical_command_attempted") or mechanical_command_attempted
            ),
            "stage": stage or prev.get("stage"),
            "first_recorded_at": prev.get("first_recorded_at") or now_iso,
            "updated_at": now_iso,
        }
        ordered = list(by_id.values())[-ATTEMPTED_ORDERS_MAX_ENTRIES:]
        payload = {"machine_id": MACHINE_ID, "orders": ordered}
        _write_file_durably(
            get_attempted_orders_file_path(),
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
        )


def get_controller_runtime_lock_path():
    lockout_path = get_dispense_lockout_file_path()
    parent_dir = os.path.dirname(os.path.abspath(lockout_path))
    return os.path.join(parent_dir, f"controller_runtime_{_get_machine_tag()}.lock")


def _try_lock_fd_exclusive_nonblocking(fd):
    if os.name != "nt" and fcntl is not None:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    elif os.name == "nt" and msvcrt is not None:
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)


def _unlock_fd(fd):
    if os.name != "nt" and fcntl is not None:
        fcntl.flock(fd, fcntl.LOCK_UN)
    elif os.name == "nt" and msvcrt is not None:
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)


def acquire_controller_runtime_lock():
    global _controller_runtime_active, _controller_runtime_lock_fd

    if _controller_runtime_lock_fd is not None:
        _controller_runtime_active = True
        return

    lock_path = get_controller_runtime_lock_path()
    _ensure_state_parent_dir(lock_path)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            _try_lock_fd_exclusive_nonblocking(fd)
        except OSError as err:
            raise RuntimeError(
                f"Another controller instance is already running (lock {lock_path}): {err}"
            ) from err
        os.ftruncate(fd, 0)
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, f"{os.getpid()}\n".encode("ascii"))
        os.fsync(fd)
        _controller_runtime_lock_fd = fd
        _controller_runtime_active = True
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise


def release_controller_runtime_lock():
    global _controller_runtime_active, _controller_runtime_lock_fd

    _controller_runtime_active = False
    fd = _controller_runtime_lock_fd
    _controller_runtime_lock_fd = None
    if fd is not None:
        try:
            _unlock_fd(fd)
        except Exception:
            pass
        try:
            os.close(fd)
        except Exception:
            pass


def _assert_controller_stopped_for_recovery():
    if _controller_runtime_active:
        raise RuntimeError(
            "Refusing to clear dispensing lockout while controller runtime is active. "
            "Stop caffix-vending.service first."
        )
    if machine_lock.locked() or orders_in_progress:
        raise RuntimeError(
            "Refusing to clear dispensing lockout while a dispensing operation is active."
        )
    if heartbeat_thread is not None and heartbeat_thread.is_alive():
        raise RuntimeError(
            "Refusing to clear dispensing lockout while controller heartbeat thread is running. "
            "Stop caffix-vending.service first."
        )

    lock_path = get_controller_runtime_lock_path()
    if os.path.exists(lock_path):
        fd = None
        try:
            fd = os.open(lock_path, os.O_RDWR, 0o600)
        except FileNotFoundError:
            return
        try:
            try:
                _try_lock_fd_exclusive_nonblocking(fd)
            except OSError as err:
                raise RuntimeError(
                    "Refusing to clear dispensing lockout while production controller process "
                    f"is still running (active lock {lock_path}). Stop caffix-vending.service first."
                ) from err
            _unlock_fd(fd)
        finally:
            try:
                os.close(fd)
            except Exception:
                pass


def _fsync_directory(dir_path):
    """
    Flushes directory entries to durable storage on POSIX filesystems.
    Raises immediately on POSIX if opening or fsyncing the directory fails.
    """
    if os.name == "nt":
        return
    dir_fd = os.open(dir_path, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def _ensure_state_parent_dir(file_path):
    parent_dir = os.path.dirname(os.path.abspath(file_path))
    os.makedirs(parent_dir, mode=0o750, exist_ok=True)
    if os.name != "nt":
        try:
            os.chmod(parent_dir, 0o750)
        except OSError:
            pass
    return parent_dir


def _write_file_durably(target_path, content_text):
    parent_dir = _ensure_state_parent_dir(target_path)
    tmp_path = f"{target_path}.tmp.{os.getpid()}"
    fd = None
    try:
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fd = None
            fh.write(content_text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, target_path)
        if os.name != "nt":
            os.chmod(target_path, 0o600)
        _fsync_directory(parent_dir)
    except Exception:
        if fd is not None:
            try:
                os.close(fd)
            except Exception:
                pass
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        raise


def _remove_file_durably(target_path):
    if not os.path.exists(target_path):
        return
    os.remove(target_path)
    _fsync_directory(os.path.dirname(os.path.abspath(target_path)))


def verify_dispense_state_dir_writable():
    """
    Preflight durability check executed at controller startup before claiming
    orders. Fails closed if the persistent state directory cannot be created,
    written, flushed/fsynced, or replaced cleanly.
    """
    lockout_path = get_dispense_lockout_file_path()
    probe_path = os.path.join(
        os.path.dirname(os.path.abspath(lockout_path)),
        f".lockout_probe_{os.getpid()}",
    )
    _write_file_durably(probe_path, "{}\n")
    _remove_file_durably(probe_path)


def _read_lockout_marker_file(file_path, default_reason):
    if not os.path.exists(file_path):
        return None
    try:
        with open(file_path, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict) and loaded.get("active", True):
            loaded["active"] = True
            return loaded
        # Non-dict or unexpected payload in marker file fails closed.
        return {
            "active": True,
            "machine_id": MACHINE_ID,
            "order_id": None,
            "command": None,
            "failure_stage": "DURING_DISPENSE",
            "failure_reason": default_reason,
            "latched_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as err:
        return {
            "active": True,
            "machine_id": MACHINE_ID,
            "order_id": None,
            "command": None,
            "failure_stage": "DURING_DISPENSE",
            "failure_reason": f"{default_reason}:{type(err).__name__}",
            "latched_at": datetime.now(timezone.utc).isoformat(),
        }


def _load_dispense_lockout_unlocked():
    global _dispense_lockout_state, _dispense_lockout_disk_checked

    if _dispense_lockout_state is not None:
        return _dispense_lockout_state if _dispense_lockout_state.get("active") else None

    if _dispense_lockout_disk_checked:
        return None

    _dispense_lockout_disk_checked = True
    lockout_path = get_dispense_lockout_file_path()
    loaded = _read_lockout_marker_file(lockout_path, "LOCKOUT_FILE_READ_ERROR")
    if loaded is not None:
        _dispense_lockout_state = loaded
        return _dispense_lockout_state

    # If a pre-dispense WAL marker remained on disk after a crash or failed lockout write
    # (when no local dispense is currently holding machine_lock), fail closed across restarts.
    if not machine_lock.locked():
        inflight_path = get_dispense_inflight_file_path()
        inflight_loaded = _read_lockout_marker_file(
            inflight_path, "UNFINISHED_DISPENSE_MARKER_ON_RESTART"
        )
        if inflight_loaded is not None:
            inflight_loaded["failure_stage"] = "DURING_DISPENSE"
            inflight_loaded["failure_reason"] = (
                inflight_loaded.get("failure_reason")
                or "UNFINISHED_DISPENSE_MARKER_ON_RESTART"
            )
            _dispense_lockout_state = inflight_loaded
            return _dispense_lockout_state

    return None


def get_dispense_lockout_state():
    with dispense_lockout_lock:
        state = _load_dispense_lockout_unlocked()
        return dict(state) if state else None


def is_dispense_locked_out():
    if lockout_persistence_failed_event.is_set():
        return True
    return get_dispense_lockout_state() is not None


def _write_inflight_dispense_marker(
    order_id=None,
    command=None,
    command_transmitted=False,
    command_transmitted_at=None,
    mechanical_command_attempted=False,
):
    inflight_path = get_dispense_inflight_file_path()
    payload = {
        "active": True,
        "persisted": True,
        "machine_id": MACHINE_ID,
        "order_id": order_id,
        "command": command,
        "command_transmitted": bool(command_transmitted),
        "command_transmitted_at": command_transmitted_at,
        "mechanical_command_attempted": bool(mechanical_command_attempted),
        "failure_stage": "DURING_DISPENSE" if command_transmitted else "PRE_DISPENSE",
        "failure_reason": "UNFINISHED_DISPENSE_MARKER_ON_RESTART",
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    _write_file_durably(
        inflight_path,
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
    )


def _clear_inflight_dispense_marker():
    _remove_file_durably(get_dispense_inflight_file_path())


def latch_dispense_lockout(
    order_id=None,
    command=None,
    failure_reason=None,
    failure_stage="DURING_DISPENSE",
):
    """
    Latches a persistent machine-level dispensing fault after any uncertain
    dispensing outcome (e.g. write timeout, partial write, post-command
    disconnect, response timeout, or mid-dispense Arduino error).

    Writes, flushes, fsyncs, and atomically replaces the persistent lockout
    file before returning (and fsyncs the parent directory on POSIX). If
    durable persistence fails, keeps the controller locked out in memory (and
    preserves any on-disk pre-command `dispense_inflight` WAL marker so restarts
    also remain locked out), halts heartbeats, sets `lockout_persistence_failed_event`,
    and raises `LockoutPersistenceError`.
    USB reconnection or PING success must NEVER clear this lockout automatically.
    """
    global _dispense_lockout_state, _dispense_lockout_disk_checked, _fatal_lockout_persistence_error

    now_iso = datetime.now(timezone.utc).isoformat()
    resolved_reason = (
        failure_reason or "UNCERTAIN_DISPENSE_REQUIRES_PHYSICAL_INSPECTION"
    )
    resolved_stage = str(failure_stage or "DURING_DISPENSE").strip().upper()
    with dispense_lockout_lock:
        existing = _load_dispense_lockout_unlocked()
        if existing is not None and existing.get("persisted", True):
            return dict(existing)

        state = {
            "active": True,
            "persisted": False,
            "machine_id": MACHINE_ID,
            "order_id": order_id,
            "command": command,
            "failure_stage": resolved_stage,
            "failure_reason": resolved_reason,
            "latched_at": now_iso,
        }
        _dispense_lockout_state = state
        _dispense_lockout_disk_checked = True

        lockout_path = get_dispense_lockout_file_path()
        try:
            persisted_payload = dict(state)
            persisted_payload["persisted"] = True
            _write_file_durably(
                lockout_path,
                json.dumps(persisted_payload, indent=2, sort_keys=True) + "\n",
            )
            state["persisted"] = True
            _dispense_lockout_state = state
            # Safe to remove pre-command WAL marker only after durable lockout file is on disk
            _clear_inflight_dispense_marker()
        except Exception as err:
            state["persisted"] = False
            state["persistence_failed"] = True
            state["persistence_error"] = f"{type(err).__name__}: {err}"
            _dispense_lockout_state = state
            _fatal_lockout_persistence_error = state["persistence_error"]
            lockout_persistence_failed_event.set()
            heartbeat_stop_event.set()
            print(
                f"[LOCKOUT] FATAL: Could not durably persist lockout file {lockout_path} ({err}). "
                "Failing closed: halting dispensing, claims, and ONLINE heartbeats."
            )
            raise LockoutPersistenceError(
                f"Failed to durably persist machine dispensing lockout to {lockout_path}: {err}",
                order_id=order_id,
                failure_reason=resolved_reason,
            ) from err

    print(
        f"[LOCKOUT] CRITICAL: Machine {MACHINE_ID or 'UNKNOWN'} latched dispensing fault "
        f"(order={order_id}, reason={state['failure_reason']}, file={lockout_path}). "
        "New claims/dispensing and ONLINE heartbeats are halted until controller stop, "
        "physical inspection, and explicit recovery (`--clear-lockout --confirm-machine-safe`)."
    )
    return dict(state)


def clear_dispense_lockout(confirm_machine_safe=False, operator=None, notes=None):
    """
    Explicitly clears the machine-level dispensing lockout ONLY when:
    1. `confirm_machine_safe=True` after physical inspection confirms all
       motors/pumps have stopped and the dispensing tray is safe.
    2. The controller runtime is stopped and no dispensing operation is active.
    3. All persistent fault files (`lockout_path`, `inflight_path`) are durably
       removed BEFORE unlocking in-memory lockout state. If deletion fails,
       the controller remains locked out in memory.
    """
    global _dispense_lockout_state, _dispense_lockout_disk_checked, _fatal_lockout_persistence_error

    if confirm_machine_safe is not True:
        raise ValueError(
            "Refusing to clear machine dispensing lockout without "
            "confirm_machine_safe=True after physical inspection."
        )

    _assert_controller_stopped_for_recovery()

    with dispense_lockout_lock:
        previous = _load_dispense_lockout_unlocked()
        previous_copy = dict(previous) if previous else None
        lockout_path = get_dispense_lockout_file_path()
        inflight_path = get_dispense_inflight_file_path()
        try:
            _remove_file_durably(lockout_path)
            _remove_file_durably(inflight_path)
        except Exception as err:
            raise RuntimeError(
                f"Failed to remove dispensing lockout state files ({lockout_path} / {inflight_path}): {err}"
            ) from err

        # Only unlock in-memory state AFTER disk deletion + directory fsync succeed
        _dispense_lockout_state = None
        _dispense_lockout_disk_checked = False
        _fatal_lockout_persistence_error = None
        lockout_persistence_failed_event.clear()

    if previous_copy is not None:
        print(
            f"[LOCKOUT] Cleared dispensing lockout for machine {MACHINE_ID or previous_copy.get('machine_id') or 'UNKNOWN'} "
            f"(operator={operator or 'unspecified'}, notes={notes or 'physical inspection confirmed safe'})."
        )
    return previous_copy


def is_arduino_error_message(message, error_messages=None):
    if not message or not isinstance(message, str):
        return False
    upper = message.strip().upper()
    if not upper:
        return False
    allowed = ARDUINO_ERROR_RESPONSES if error_messages is None else {
        str(item).strip().upper() for item in error_messages if item
    }
    if upper in allowed:
        return True
    return upper.startswith(ARDUINO_ERROR_PREFIXES)


def schedule_arduino_reconnect():
    arduino_reconnect_event.set()


# =====================================================
# SERIAL HELPERS
# =====================================================

def close_serial():
    """
    Closes and clears the active Arduino serial handle.
    Callers must hold `arduino_lock` (or execute during single-threaded shutdown).
    """
    global arduino, _arduino_responsive

    if arduino is not None:
        try:
            if arduino.is_open:
                arduino.close()
        except Exception:
            pass

    arduino = None
    _arduino_responsive = False


# =====================================================
# READ SERIAL LINES
# =====================================================

def read_serial_lines(ser, duration=1.5, stop_on=None):
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
                    if stop_on and line in stop_on:
                        break
            else:
                time.sleep(0.05)

        except Exception:
            break

    return lines


ARDUINO_USB_VID = 0x2341
ARDUINO_GIGA_PIDS = {0x0266, 0x0466, 0x0666}
ARDUINO_BOOTLOADER_PIDS = {0x0366}

# Explicit exclusion list for cellular/GNSS modems (including SIMCom SIM7600 1E0E:9001/9011)
# and legacy hardware UARTs so PING is never transmitted to modem or unrelated ports.
EXCLUDED_MODEM_USB_VIDS = {0x1E0E, 0x05C6}
EXCLUDED_SERIAL_PORT_KEYWORDS = (
    "sim7600",
    "simcom",
    "simtech",
    "qualcomm",
    "modem",
    "nmea",
    "wwan",
    "diag",
    "at port",
)


def _port_metadata_text(port):
    parts = [
        getattr(port, "device", "") or "",
        getattr(port, "description", "") or "",
        getattr(port, "manufacturer", "") or "",
        getattr(port, "product", "") or "",
        getattr(port, "interface", "") or "",
        getattr(port, "hwid", "") or "",
    ]
    return " ".join(str(p) for p in parts if p).lower()


def _is_excluded_serial_port(port):
    device = str(getattr(port, "device", "") or "").strip()
    device_lower = device.lower()
    if device_lower.startswith("/dev/ttys") or device_lower.startswith("/dev/ttyama"):
        return True

    vid = getattr(port, "vid", None)
    if isinstance(vid, int) and vid in EXCLUDED_MODEM_USB_VIDS:
        return True

    metadata = _port_metadata_text(port)
    for kw in EXCLUDED_SERIAL_PORT_KEYWORDS:
        if kw in metadata:
            return True
    return False


def _is_verified_arduino_giga_port(port):
    if _is_excluded_serial_port(port):
        return False

    device = str(getattr(port, "device", "") or "").strip()
    vid = getattr(port, "vid", None)
    pid = getattr(port, "pid", None)
    metadata = _port_metadata_text(port)

    # 1. Hardware USB VID/PID match for Arduino SA / GIGA R1
    if isinstance(vid, int):
        if vid != ARDUINO_USB_VID:
            return False
        if isinstance(pid, int) and pid in ARDUINO_BOOTLOADER_PIDS:
            return False
        return True

    # 2. Verified stable Linux device path (/dev/serial/by-id/*Arduino* or udev alias)
    device_lower = device.lower()
    if (
        device_lower.startswith("/dev/serial/by-id/")
        and any(tok in device_lower for tok in ("arduino", "giga"))
    ):
        return True

    # 3. Descriptor metadata when vid is unavailable (e.g. unit test mocks or custom symlinks)
    if any(tok in metadata for tok in ("arduino", "giga")):
        return True

    return False


def _port_priority_key(port):
    pid = getattr(port, "pid", None)
    device = str(getattr(port, "device", "") or "")
    return (
        0 if (isinstance(pid, int) and pid in ARDUINO_GIGA_PIDS) else 1,
        0 if "/dev/serial/by-id/" in device else (1 if device.startswith("/dev/ttyACM") else 2),
        device,
    )


def _list_ordered_serial_ports():
    configured_port = os.environ.get("CAFFIX_ARDUINO_PORT", "").strip()
    all_ports = list(serial.tools.list_ports.comports())

    if configured_port:
        real_configured = os.path.realpath(configured_port)
        matching = [
            p for p in all_ports
            if str(getattr(p, "device", "") or "") in {configured_port, real_configured}
        ]
        if matching:
            return [p for p in matching if not _is_excluded_serial_port(p)]
        pseudo = serial.tools.list_ports_common.ListPortInfo(configured_port) if hasattr(serial.tools, "list_ports_common") else None
        if pseudo is None:
            from types import SimpleNamespace
            pseudo = SimpleNamespace(device=configured_port, description="Configured CAFFIX Arduino Port")
        if _is_excluded_serial_port(pseudo):
            return []
        return [pseudo]

    verified_ports = [port for port in all_ports if _is_verified_arduino_giga_port(port)]
    verified_ports.sort(key=_port_priority_key)
    return verified_ports


def try_connect_arduino_once():
    """
    Performs a single scan pass over available serial ports, sending `PING` and
    waiting for `CAFFIX_ARDUINO`. Returns the open Serial instance on success
    or None if no responsive Arduino was found.
    """
    global arduino, _arduino_responsive, _last_arduino_probe_at

    ordered_ports = _list_ordered_serial_ports()
    if not ordered_ports:
        return None

    for port in ordered_ports:
        ser = None
        try:
            print(
                f"Checking {port.device} "
                f"({port.description})"
            )
            ser = serial.Serial(
                port=port.device,
                baudrate=BAUDRATE,
                timeout=SERIAL_TIMEOUT,
                write_timeout=WRITE_TIMEOUT,
            )

            # Allow Arduino GIGA R1 USB CDC reset before handshake
            time.sleep(2)

            ser.reset_input_buffer()
            ser.reset_output_buffer()

            ser.write((PING_COMMAND + "\n").encode("ascii"))
            ser.flush()

            responses = read_serial_lines(
                ser,
                duration=ARDUINO_PING_TIMEOUT_SECONDS,
                stop_on={ARDUINO_RESPONSE},
            )
            print(
                f"Responses from "
                f"{port.device}: {responses}"
            )

            if ARDUINO_RESPONSE in responses:
                print("\n===================================")
                print(" CAFFIX ARDUINO GIGA R1 FOUND")
                print(f" Port: {port.device}")
                print("===================================\n")

                with arduino_lock:
                    if arduino is not None and arduino is not ser:
                        try:
                            if arduino.is_open:
                                arduino.close()
                        except Exception:
                            pass
                    arduino = ser
                    _arduino_responsive = True
                    _last_arduino_probe_at = time.monotonic()
                arduino_reconnect_event.clear()
                return ser

            print(f"Not CAFFIX Arduino: {port.device}")
            ser.close()
        except Exception as error:
            print(f"{port.device} failed: {error}")
            if ser is not None:
                try:
                    ser.close()
                except Exception:
                    pass

    return None


def reconcile_arduino_connection_once():
    """
    Attempts one non-blocking reconnection cycle if Arduino is disconnected or
    unresponsive, without disturbing an in-progress dispensing operation.
    Closes any stale serial handle under `arduino_lock`, releases `arduino_lock`,
    and only then runs `try_connect_arduino_once()` so `arduino_lock` is never
    acquired recursively during port scan and PING handshake.
    """
    if not machine_lock.acquire(blocking=False):
        return arduino

    try:
        with arduino_lock:
            if (
                arduino is not None
                and getattr(arduino, "is_open", False)
                and _arduino_responsive
            ):
                return arduino
            close_serial()
        return try_connect_arduino_once()
    finally:
        machine_lock.release()


def probe_arduino_responsive(timeout=ARDUINO_PING_TIMEOUT_SECONDS):
    """
    Actively verifies that the connected Arduino responds to `PING` with
    `CAFFIX_ARDUINO`. If probing fails or times out, closes the dead serial
    handle and schedules automatic reconnection.
    """
    global _arduino_responsive, _last_arduino_probe_at

    with arduino_lock:
        if arduino is None or not getattr(arduino, "is_open", False):
            close_serial()
            schedule_arduino_reconnect()
            return False

        try:
            if hasattr(arduino, "reset_input_buffer"):
                arduino.reset_input_buffer()
            arduino.write((PING_COMMAND + "\n").encode("ascii"))
            arduino.flush()
            responses = read_serial_lines(
                arduino,
                duration=timeout,
                stop_on={ARDUINO_RESPONSE},
            )
            if ARDUINO_RESPONSE in responses:
                _arduino_responsive = True
                _last_arduino_probe_at = time.monotonic()
                return True
        except Exception as error:
            print(f"Arduino PING probe failed: {error}")

        close_serial()
        schedule_arduino_reconnect()
        return False


def is_arduino_ready(probe_when_idle=True, ping_timeout=ARDUINO_PING_TIMEOUT_SECONDS):
    """
    Returns True ONLY when the Arduino serial port is open and verified responsive.
    While a dispensing command holds `machine_lock`, reports current serial open/ready
    state without interfering with the active dispensing serial stream.
    """
    if arduino is None or not getattr(arduino, "is_open", False):
        schedule_arduino_reconnect()
        return False

    if not probe_when_idle:
        return bool(_arduino_responsive)

    if not machine_lock.acquire(blocking=False):
        return bool(
            arduino is not None
            and getattr(arduino, "is_open", False)
            and _arduino_responsive
        )

    try:
        with arduino_lock:
            if arduino is None or not getattr(arduino, "is_open", False):
                close_serial()
                schedule_arduino_reconnect()
                return False
            if not _arduino_responsive:
                return False
        return probe_arduino_responsive(timeout=ping_timeout)
    finally:
        machine_lock.release()


# =====================================================
# ARDUINO AUTO DETECTION - UPDATED
# =====================================================

def connect_arduino():

    global arduino

    print(
        "\nSearching for CAFFIX Arduino GIGA R1...\n"
    )

    while True:
        found = try_connect_arduino_once()
        if found is not None:
            return found

        print(
            "\nArduino not found. "
            "Retrying in 2 seconds...\n"
        )

        time.sleep(ARDUINO_RECONNECT_RETRY_SECONDS)


# =====================================================
# ENSURE ARDUINO CONNECTION
# =====================================================

def ensure_connection():
    global arduino

    if arduino is None or not getattr(arduino, "is_open", False) or not _arduino_responsive:
        arduino = connect_arduino()

    return arduino


# =====================================================
# SEND RAW COMMAND
# =====================================================

def send_raw_command(command):
    while True:

        try:

            ensure_connection()

            with arduino_lock:
                if arduino is None or not getattr(arduino, "is_open", False):
                    raise RuntimeError("Arduino serial handle is not open")

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

            with arduino_lock:
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
    timeout=None,
    error_messages=None,
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
                or not getattr(arduino, "is_open", False)
            ):
                close_serial()
                schedule_arduino_reconnect()
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

            # ---------------------------------
            # CHECK IMMEDIATE ARDUINO ERROR
            # ---------------------------------

            if error_messages is not None and is_arduino_error_message(
                message, error_messages=error_messages
            ):
                return message

        except Exception as error:

            print(
                f"Serial read error: {error}"
            )
            close_serial()
            schedule_arduino_reconnect()
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

        # ---------------------------------
        # SEND COMMAND (ensure_connection runs outside arduino_lock)
        # ---------------------------------

        send_raw_command(command)

        if expected is None:
            return True

        with arduino_lock:

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
    require_arduino=True,
):
    resolved_interval = (
        HEARTBEAT_INTERVAL_SECONDS if interval_seconds is None else interval_seconds
    )
    resolved_timeout = HEARTBEAT_HTTP_TIMEOUT_SECONDS if timeout is None else timeout
    target_machine_id, _, _ = _resolve_heartbeat_config(
        machine_id, kiosk_token, api_base
    )
    consecutive_failures = 0
    arduino_unavailable_logged = False
    lockout_logged = False

    while not stop_event.is_set():
        lockout_state = get_dispense_lockout_state()
        if lockout_state is not None:
            if not lockout_logged:
                print(
                    f"[Heartbeat] Machine {target_machine_id} is in DISPENSE LOCKOUT "
                    f"(reason={lockout_state.get('failure_reason')}); suppressing ONLINE heartbeat "
                    "until physical inspection and explicit recovery."
                )
                lockout_logged = True
            if stop_event.wait(resolved_interval):
                break
            continue

        if lockout_logged:
            print(
                f"[Heartbeat] Dispense lockout cleared for {target_machine_id}."
            )
            lockout_logged = False

        if require_arduino and not is_arduino_ready(probe_when_idle=True):
            if not arduino_unavailable_logged:
                print(
                    f"[Heartbeat] Arduino not connected/responsive for {target_machine_id}; "
                    "suppressing ONLINE heartbeat until Arduino is ready."
                )
                arduino_unavailable_logged = True
            if stop_event.wait(resolved_interval):
                break
            continue

        if arduino_unavailable_logged:
            print(
                f"[Heartbeat] Arduino ready for {target_machine_id}; resuming ONLINE heartbeat."
            )
            arduino_unavailable_logged = False

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
    require_arduino=True,
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
            "require_arduino": require_arduino,
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
    if refund_status in {"FULL", "PENDING", "PARTIAL", "FAILED"}:
        return False

    if data.get("command_transmitted") is True:
        return False

    order_id = str(data.get("id") or "").strip()
    if order_id and is_order_in_attempted_ledger(order_id):
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

    lockout_state = get_dispense_lockout_state()
    if lockout_state is not None:
        print(
            f"[LOCKOUT] Refusing to claim order {order_id} while dispensing lockout is active "
            f"(reason={lockout_state.get('failure_reason')})."
        )
        return None

    if is_order_in_attempted_ledger(order_id):
        print(
            f"[LEDGER] Refusing to claim order {order_id}: already recorded in attempted_orders ledger."
        )
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
        now_dt = datetime.now(timezone.utc)
        now_iso = now_dt.isoformat()
        dispense_expires_iso = (now_dt + timedelta(seconds=300)).isoformat()
        updates = {
            "dispense_status": "DISPENSING",
            "dispensed": False,
            "claimed_by": MACHINE_ID,
            "claimed_at": now_iso,
            "dispense_started_at": now_iso,
            "dispense_expires_at": dispense_expires_iso,
            "command_transmitted": False,
            "command_transmitted_at": None,
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


LOCAL_DISPENSE_DEADLINE_SECONDS = 240.0
PRE_WRITE_MAX_ELAPSED_SECONDS = 30.0
OUTCOME_WRITE_MAX_RETRIES = 3
OUTCOME_WRITE_RETRY_DELAY_SECONDS = 0.05
pending_outcome_writes = {}
pending_outcome_lock = threading.Lock()


def _resolve_doc_ref_and_client(order_id, doc_ref=None, client=None):
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
            resolved_doc_ref = resolved_client.collection(ORDERS_COLLECTION).document(order_id)
        except Exception:
            resolved_doc_ref = None
    return resolved_doc_ref, resolved_client


def _run_firestore_tx(resolved_client, fn):
    tx_obj = resolved_client.transaction()
    if hasattr(tx_obj, "run") and callable(tx_obj.run):
        return tx_obj.run(fn)
    from google.cloud import firestore as gc_firestore

    @gc_firestore.transactional
    def _wrapped(transaction):
        return fn(transaction)

    return _wrapped(tx_obj)


def commit_command_transmission_in_firestore(order_id, doc_ref=None, client=None):
    """
    Step 1 of crash-safe command transmission:
    Transactionally commits `command_transmitted=True` and `command_transmitted_at`
    in Firestore BEFORE updating local WAL or calling `arduino.write()`.
    Refuses if order is no longer in `DISPENSING` or has been expired/refunded.
    """
    resolved_doc_ref, resolved_client = _resolve_doc_ref_and_client(
        order_id, doc_ref=doc_ref, client=client
    )
    if (
        resolved_doc_ref is None
        or resolved_client is None
        or not hasattr(resolved_client, "transaction")
    ):
        return {
            "committed": False,
            "reason": "FIRESTORE_TRANSACTION_CLIENT_UNAVAILABLE",
            "command_transmitted_at": None,
        }

    now_iso = datetime.now(timezone.utc).isoformat()

    def _tx_body(transaction):
        snapshot = resolved_doc_ref.get(transaction=transaction)
        if not getattr(snapshot, "exists", False):
            return {"committed": False, "reason": "ORDER_NOT_FOUND", "command_transmitted_at": None}
        live = snapshot.to_dict() or {}
        disp_status = str(live.get("dispense_status") or "").strip().upper()
        refund_status = str(live.get("refund_status") or "").strip().upper()
        pending_paise = float(live.get("pending_refund_amount_paise") or 0)
        if disp_status != "DISPENSING" or refund_status in {"PENDING", "PARTIAL", "FULL", "FAILED"} or pending_paise > 0:
            return {
                "committed": False,
                "reason": f"ORDER_STATE_REJECTED_{disp_status or 'UNKNOWN'}",
                "command_transmitted_at": None,
            }
        tx_at = live.get("command_transmitted_at") or now_iso
        updates = {
            "command_transmitted": True,
            "command_transmitted_at": tx_at,
            "updated_at": now_iso,
        }
        transaction.set(resolved_doc_ref, updates, merge=True)
        return {"committed": True, "reason": None, "command_transmitted_at": tx_at}

    try:
        return _run_firestore_tx(resolved_client, _tx_body)
    except Exception as tx_err:
        return {
            "committed": False,
            "reason": f"FIRESTORE_TX_ERROR:{type(tx_err).__name__}",
            "command_transmitted_at": None,
        }


def flush_pending_outcome_writes():
    """
    Retries any post-dispense Firestore outcome updates that previously failed
    due to a temporary network interruption. Executes transactionally so a late
    DISPENSED write NEVER overwrites an already EXPIRED or refunded order.
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
            _, resolved_client = _resolve_doc_ref_and_client(
                order_id, doc_ref=target_ref, client=entry.get("client")
            )
            is_success_payload = str(payload.get("dispense_status") or "").upper() == "DISPENSED"
            if resolved_client is not None and hasattr(resolved_client, "transaction"):
                _apply_outcome_update_transactionally(
                    order_id=order_id,
                    target_ref=target_ref,
                    resolved_client=resolved_client,
                    post_updates=payload,
                    is_success=is_success_payload,
                )
            else:
                target_ref.set(payload, merge=True)
            with pending_outcome_lock:
                pending_outcome_writes.pop(order_id, None)
            print(
                f"Recovered pending Firestore outcome write for order {order_id}."
            )
        except Exception:
            pass


def _apply_outcome_update_transactionally(
    order_id, target_ref, resolved_client, post_updates, is_success
):
    def _tx_outcome(transaction):
        snapshot = target_ref.get(transaction=transaction)
        if not getattr(snapshot, "exists", False):
            return {"rejected_late_dispense": False, "updates": post_updates}
        live = snapshot.to_dict() or {}
        live_dispense = str(live.get("dispense_status") or "").strip().upper()
        live_refund = str(live.get("refund_status") or "").strip().upper()
        live_outcome = str(live.get("dispense_outcome") or "").strip().upper()
        pending_paise = float(live.get("pending_refund_amount_paise") or 0)
        refunded_paise = float(live.get("total_refunded_amount_paise") or 0)

        if is_success and (live_dispense == "DISPENSED" or live.get("dispensed") is True):
            return {
                "rejected_late_dispense": False,
                "already_dispensed": True,
                "updates": dict(live),
            }

        is_terminal_or_refunded = (
            live_dispense in {"EXPIRED", "FAILED", "CANCELLED"}
            or live_refund in {"PENDING", "PARTIAL", "FULL"}
            or pending_paise > 0
            or refunded_paise > 0
            or live_outcome == "UNCERTAIN"
        )

        if is_success and is_terminal_or_refunded:
            now_iso = datetime.now(timezone.utc).isoformat()
            audit_updates = {
                "late_dispense_reported_at": live.get("late_dispense_reported_at") or now_iso,
                "late_dispense_signal": live.get("late_dispense_signal") or "ARDUINO_DONE_AFTER_EXPIRY",
                "updated_at": now_iso,
            }
            transaction.set(target_ref, audit_updates, merge=True)
            return {"rejected_late_dispense": True, "updates": audit_updates}

        if not is_success and (
            live_dispense in {"DISPENSED", "EXPIRED", "CANCELLED"}
            or live.get("dispensed") is True
            or live_refund in {"PENDING", "PARTIAL", "FULL"}
            or pending_paise > 0
            or refunded_paise > 0
        ):
            # Never overwrite DISPENSED, EXPIRED, or refunded state with a failure update
            return {"rejected_late_dispense": False, "updates": dict(live)}

        # Never downgrade command_transmitted=True to False
        merged_updates = dict(post_updates)
        if live.get("command_transmitted") is True:
            merged_updates["command_transmitted"] = True
            if live.get("command_transmitted_at"):
                merged_updates["command_transmitted_at"] = live.get("command_transmitted_at")
        transaction.set(target_ref, merged_updates, merge=True)
        return {"rejected_late_dispense": False, "updates": merged_updates}

    return _run_firestore_tx(resolved_client, _tx_outcome)


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

    resolved_doc_ref, resolved_client = _resolve_doc_ref_and_client(
        order_id, doc_ref=doc_ref, client=client
    )

    if resolved_doc_ref is not None and (
        hasattr(resolved_doc_ref, "set")
        or (resolved_client is not None and hasattr(resolved_client, "transaction"))
    ):
        wrote = False
        last_exc = None
        for attempt in range(OUTCOME_WRITE_MAX_RETRIES):
            try:
                if resolved_client is not None and hasattr(resolved_client, "transaction"):
                    tx_res = _apply_outcome_update_transactionally(
                        order_id=order_id,
                        target_ref=resolved_doc_ref,
                        resolved_client=resolved_client,
                        post_updates=post_updates,
                        is_success=bool(success),
                    )
                    if tx_res.get("rejected_late_dispense"):
                        post_updates = tx_res["updates"]
                        print(
                            f"[RACE-GUARD] Rejected late DISPENSED update for {order_id}: "
                            "backend already expired/refunded order; recorded audit signal."
                        )
                else:
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
                    "client": resolved_client,
                    "updates": dict(post_updates),
                }
            print(
                f"Failed to update post-dispense status in Firestore for {order_id}: {last_exc}. "
                "Queued for background retry; order will NOT be re-dispensed."
            )

    return post_updates


from contextlib import nullcontext


def execute_arduino_dispense_for_order(
    command,
    timeout=180,
    order_id=None,
    doc_ref=None,
    client=None,
    dispense_started_at=None,
    _holding_machine_lock=False,
):
    """
    Executes the Arduino GIGA R1 dispense command with Firestore-first crash-safe commits:
    1. Pre-commit checks (Arduino disconnected, reset_input_buffer failure, elapsed >= 30s,
       or Firestore commit_command_transmission_in_firestore rejection) ->
       PRE_DISPENSE / NOT_DISPENSED (no lockout; command_transmitted remains False).
    2. Step 1: Transactionally commit `command_transmitted=True` in Firestore FIRST.
    3. Step 2: Durably fsync `dispense_inflight` (command_transmitted=True,
       mechanical_command_attempted=True) and `attempted_orders` SECOND.
       If Step 2 fails after Step 1 succeeded, refuse arduino.write(), never downgrade
       Firestore `command_transmitted=True`, and latch lockout (UNCERTAIN).
    4. Step 3: Call arduino.write(payload) ONLY after Steps 1 & 2 succeed.
       Any write exception, partial write, 0-byte return, flush failure, or timeout
       retains DURING_DISPENSE / UNCERTAIN and latches machine lockout.
    5. Wait up to min(timeout, 240s - elapsed_since_dispense_started) for DONE.
       Note: 240s deadline stops Python serial waiting (no Arduino STOP command exists);
       on 240s timeout, machine lockout is latched until physical inspection.
    """
    if is_dispense_locked_out():
        print(
            f"[LOCKOUT] Refusing serial command {command!r} for order {order_id}: "
            "machine-level dispensing lockout is active."
        )
        return {
            "success": False,
            "command_transmitted": False,
            "bytes_written": 0,
            "failure_stage": "LOCKED_OUT",
            "failure_reason": "MACHINE_DISPENSE_LOCKOUT_ACTIVE",
        }

    def _elapsed_since_start():
        dt = _parse_utc_timestamp(dispense_started_at) if dispense_started_at else None
        if dt is None:
            return 0.0
        return max(0.0, (datetime.now(timezone.utc) - dt).total_seconds())

    if send_to_arduino is not _DEFAULT_SEND_TO_ARDUINO:
        if _elapsed_since_start() >= PRE_WRITE_MAX_ELAPSED_SECONDS:
            return {
                "success": False,
                "command_transmitted": False,
                "bytes_written": 0,
                "failure_stage": "PRE_DISPENSE",
                "failure_reason": "PRE_WRITE_DEADLINE_EXCEEDED",
            }
        tx_at = None
        if order_id and (doc_ref is not None or client is not None or db is not None):
            fs_commit = commit_command_transmission_in_firestore(
                order_id, doc_ref=doc_ref, client=client
            )
            if not fs_commit.get("committed"):
                return {
                    "success": False,
                    "command_transmitted": False,
                    "bytes_written": 0,
                    "failure_stage": "PRE_DISPENSE",
                    "failure_reason": fs_commit.get("reason") or "FIRESTORE_PRE_WRITE_ABORTED",
                }
            tx_at = fs_commit.get("command_transmitted_at")
        if order_id:
            record_attempted_order(
                order_id,
                command_transmitted=True,
                mechanical_command_attempted=True,
                stage="DURING_DISPENSE",
            )
        remaining_wait = max(
            0.01 if timeout and timeout > 0 else 0.0,
            min(float(timeout), max(0.0, LOCAL_DISPENSE_DEADLINE_SECONDS - _elapsed_since_start())),
        )
        ok = bool(send_to_arduino(command, expected="DONE", timeout=remaining_wait))
        if ok:
            return {
                "success": True,
                "command_transmitted": True,
                "command_transmitted_at": tx_at,
                "bytes_written": len((command.strip() + "\n").encode("ascii")),
                "failure_stage": None,
                "failure_reason": None,
            }
        reason = "ARDUINO_TIMEOUT_OR_SERIAL_DISCONNECT_DURING_DISPENSE"
        latch_dispense_lockout(
            order_id=order_id,
            command=command,
            failure_reason=reason,
            failure_stage="DURING_DISPENSE",
        )
        return {
            "success": False,
            "command_transmitted": True,
            "command_transmitted_at": tx_at,
            "bytes_written": None,
            "failure_stage": "DURING_DISPENSE",
            "failure_reason": reason,
        }

    with (nullcontext() if _holding_machine_lock else machine_lock):
        if is_dispense_locked_out():
            return {
                "success": False,
                "command_transmitted": False,
                "bytes_written": 0,
                "failure_stage": "LOCKED_OUT",
                "failure_reason": "MACHINE_DISPENSE_LOCKOUT_ACTIVE",
            }

        if _elapsed_since_start() >= PRE_WRITE_MAX_ELAPSED_SECONDS:
            return {
                "success": False,
                "command_transmitted": False,
                "bytes_written": 0,
                "failure_stage": "PRE_DISPENSE",
                "failure_reason": "PRE_WRITE_DEADLINE_EXCEEDED",
            }

        print("\n=================================")
        print("Sending Command ->", command)
        print("=================================\n")

        with arduino_lock:
            # Rule 1: Arduino disconnected before any durable command commit
            if arduino is None or not getattr(arduino, "is_open", False):
                print("Arduino disconnected before command transmission.")
                close_serial()
                schedule_arduino_reconnect()
                return {
                    "success": False,
                    "command_transmitted": False,
                    "bytes_written": 0,
                    "failure_stage": "PRE_DISPENSE",
                    "failure_reason": "ARDUINO_DISCONNECTED_BEFORE_COMMAND",
                }

            # Clear any stale serial RX bytes before committing transmission
            if hasattr(arduino, "reset_input_buffer"):
                try:
                    arduino.reset_input_buffer()
                except Exception as buf_err:
                    print(
                        f"Arduino reset_input_buffer error before command transmission: {buf_err}"
                    )
                    close_serial()
                    schedule_arduino_reconnect()
                    return {
                        "success": False,
                        "command_transmitted": False,
                        "bytes_written": 0,
                        "failure_stage": "PRE_DISPENSE",
                        "failure_reason": "ARDUINO_DISCONNECTED_BEFORE_COMMAND",
                    }

            # Step 1: Transactionally commit command_transmitted=True in Firestore FIRST
            tx_at = datetime.now(timezone.utc).isoformat()
            firestore_committed = False
            if order_id and (doc_ref is not None or client is not None or db is not None):
                fs_commit = commit_command_transmission_in_firestore(
                    order_id, doc_ref=doc_ref, client=client
                )
                if not fs_commit.get("committed"):
                    return {
                        "success": False,
                        "command_transmitted": False,
                        "bytes_written": 0,
                        "failure_stage": "PRE_DISPENSE",
                        "failure_reason": fs_commit.get("reason") or "FIRESTORE_PRE_WRITE_ABORTED",
                    }
                tx_at = fs_commit.get("command_transmitted_at") or tx_at
                firestore_committed = True

            # Step 2: Durably fsync local WAL & attempted_orders SECOND (before arduino.write)
            wal_committed = False
            try:
                if order_id:
                    record_attempted_order(
                        order_id,
                        command_transmitted=True,
                        mechanical_command_attempted=True,
                        stage="DURING_DISPENSE",
                    )
                _write_inflight_dispense_marker(
                    order_id=order_id,
                    command=command,
                    command_transmitted=bool(order_id is not None),
                    command_transmitted_at=tx_at if order_id is not None else None,
                    mechanical_command_attempted=bool(order_id is not None),
                )
                wal_committed = True
            except Exception as wal_err:
                with dispense_lockout_lock:
                    _dispense_lockout_state = {
                        "active": True,
                        "persisted": False,
                        "persistence_failed": True,
                        "persistence_error": f"{type(wal_err).__name__}: {wal_err}",
                        "machine_id": MACHINE_ID,
                        "order_id": order_id,
                        "command": command,
                        "command_transmitted": firestore_committed,
                        "failure_stage": "DURING_DISPENSE" if firestore_committed else "PRE_DISPENSE",
                        "failure_reason": "LOCKOUT_PRE_WRITE_PERSISTENCE_FAILED",
                        "latched_at": datetime.now(timezone.utc).isoformat(),
                    }
                    _dispense_lockout_disk_checked = True
                    _fatal_lockout_persistence_error = f"{type(wal_err).__name__}: {wal_err}"
                    lockout_persistence_failed_event.set()
                    heartbeat_stop_event.set()
                raise LockoutPersistenceError(
                    f"Refusing dispense because durable state storage failed before write: {wal_err}",
                    order_id=order_id,
                    failure_reason="LOCKOUT_PRE_WRITE_PERSISTENCE_FAILED",
                    command_transmitted=firestore_committed,
                ) from wal_err

            command_durably_committed = bool(order_id is not None and (firestore_committed or wal_committed))
            payload = (command.strip() + "\n").encode("ascii")
            expected_bytes = len(payload)
            serial_timeout_cls = getattr(serial, "SerialTimeoutException", TimeoutError)

            try:
                written = arduino.write(payload)
            except serial_timeout_cls as timeout_err:
                # Rule 3: Write timeout -> uncertain whether bytes reached Arduino
                print(f"Arduino serial write timeout (uncertain transmission): {timeout_err}")
                close_serial()
                schedule_arduino_reconnect()
                reason = "SERIAL_WRITE_TIMEOUT_UNCERTAIN"
                latch_dispense_lockout(
                    order_id=order_id,
                    command=command,
                    failure_reason=reason,
                    failure_stage="DURING_DISPENSE",
                )
                return {
                    "success": False,
                    "command_transmitted": True,
                    "command_transmitted_at": tx_at,
                    "bytes_written": None,
                    "failure_stage": "DURING_DISPENSE",
                    "failure_reason": reason,
                }
            except TimeoutError as timeout_err:
                print(f"Arduino serial write timeout (uncertain transmission): {timeout_err}")
                close_serial()
                schedule_arduino_reconnect()
                reason = "SERIAL_WRITE_TIMEOUT_UNCERTAIN"
                latch_dispense_lockout(
                    order_id=order_id,
                    command=command,
                    failure_reason=reason,
                    failure_stage="DURING_DISPENSE",
                )
                return {
                    "success": False,
                    "command_transmitted": True,
                    "command_transmitted_at": tx_at,
                    "bytes_written": None,
                    "failure_stage": "DURING_DISPENSE",
                    "failure_reason": reason,
                }
            except Exception as write_err:
                print(f"Arduino write exception (uncertain transmission): {write_err}")
                close_serial()
                schedule_arduino_reconnect()
                reason = "SERIAL_WRITE_EXCEPTION_UNCERTAIN"
                latch_dispense_lockout(
                    order_id=order_id,
                    command=command,
                    failure_reason=reason,
                    failure_stage="DURING_DISPENSE",
                )
                return {
                    "success": False,
                    "command_transmitted": True,
                    "command_transmitted_at": tx_at,
                    "bytes_written": None,
                    "failure_stage": "DURING_DISPENSE",
                    "failure_reason": reason,
                }

            is_exact_int = isinstance(written, int) and not isinstance(written, bool)
            out_waiting = getattr(arduino, "out_waiting", 0)
            has_buffered_tx = (
                isinstance(out_waiting, int)
                and not isinstance(out_waiting, bool)
                and out_waiting > 0
            )

            # Rule 2: 0-byte return is PRE_DISPENSE ONLY if command_transmitted=True was NOT durably committed
            if is_exact_int and written == 0 and not has_buffered_tx and not command_durably_committed:
                print("Arduino serial write returned 0 bytes (zero transmission established).")
                close_serial()
                schedule_arduino_reconnect()
                try:
                    _clear_inflight_dispense_marker()
                except Exception:
                    pass
                return {
                    "success": False,
                    "command_transmitted": False,
                    "bytes_written": 0,
                    "failure_stage": "PRE_DISPENSE",
                    "failure_reason": "SERIAL_WRITE_ZERO_BYTES",
                }

            # Rule 3: Partial transmission, uncertain byte count, or 0-byte return AFTER durable commit
            if not is_exact_int or written != expected_bytes:
                if is_exact_int and written == 0:
                    reason = "SERIAL_WRITE_ZERO_BYTES_AFTER_DURABLE_COMMIT"
                elif is_exact_int and 0 < written < expected_bytes:
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
                schedule_arduino_reconnect()
                latch_dispense_lockout(
                    order_id=order_id,
                    command=command,
                    failure_reason=reason,
                    failure_stage="DURING_DISPENSE",
                )
                return {
                    "success": False,
                    "command_transmitted": True,
                    "command_transmitted_at": tx_at,
                    "bytes_written": written if is_exact_int else None,
                    "failure_stage": "DURING_DISPENSE",
                    "failure_reason": reason,
                }

            try:
                arduino.flush()
            except Exception as flush_err:
                print(f"Arduino flush error after command write: {flush_err}")
                close_serial()
                schedule_arduino_reconnect()
                reason = "ARDUINO_DISCONNECTED_AFTER_COMMAND_TRANSMISSION"
                latch_dispense_lockout(
                    order_id=order_id,
                    command=command,
                    failure_reason=reason,
                    failure_stage="DURING_DISPENSE",
                )
                return {
                    "success": False,
                    "command_transmitted": True,
                    "command_transmitted_at": tx_at,
                    "bytes_written": written,
                    "failure_stage": "DURING_DISPENSE",
                    "failure_reason": reason,
                }

            # Rule 5: Wait for DONE or immediate Arduino error, capped at 240s local deadline
            remaining_deadline = max(0.0, LOCAL_DISPENSE_DEADLINE_SECONDS - _elapsed_since_start())
            effective_timeout = min(float(timeout), remaining_deadline)
            result = wait_for_message(
                "DONE",
                timeout=effective_timeout,
                error_messages=ARDUINO_ERROR_RESPONSES,
            )
            if result == "DONE":
                try:
                    _clear_inflight_dispense_marker()
                except Exception as clear_err:
                    print(f"[LOCKOUT] Warning: failed to remove in-flight marker after DONE: {clear_err}")
                print(f"Command completed successfully: {command}")
                return {
                    "success": True,
                    "command_transmitted": True,
                    "command_transmitted_at": tx_at,
                    "bytes_written": written,
                    "failure_stage": None,
                    "failure_reason": None,
                }

            if result and is_arduino_error_message(result):
                sanitized = re.sub(r"[^A-Z0-9]+", "_", result.strip().upper()).strip("_") or "ERROR"
                reason = f"ARDUINO_ERROR_{sanitized}"
                print(f"Arduino reported immediate error ({result}); aborting wait cleanly.")
                latch_dispense_lockout(
                    order_id=order_id,
                    command=command,
                    failure_reason=reason,
                    failure_stage="DURING_DISPENSE",
                )
                return {
                    "success": False,
                    "command_transmitted": True,
                    "command_transmitted_at": tx_at,
                    "bytes_written": written,
                    "failure_stage": "DURING_DISPENSE",
                    "failure_reason": reason,
                }

            # Rule 4: Full command transmission followed by missing DONE or 240s deadline exceeded
            if arduino is None or not getattr(arduino, "is_open", False):
                close_serial()
                schedule_arduino_reconnect()
                reason = "ARDUINO_DISCONNECTED_AFTER_COMMAND_TRANSMISSION"
            elif _elapsed_since_start() >= LOCAL_DISPENSE_DEADLINE_SECONDS or remaining_deadline <= float(timeout):
                close_serial()
                schedule_arduino_reconnect()
                reason = "ARDUINO_DISPENSE_DEADLINE_EXCEEDED_HARDWARE_UNVERIFIED"
            else:
                reason = "ARDUINO_RESPONSE_TIMEOUT_AFTER_COMMAND"

            print(f"Arduino did not confirm DONE ({reason}).")
            latch_dispense_lockout(
                order_id=order_id,
                command=command,
                failure_reason=reason,
                failure_stage="DURING_DISPENSE",
            )
            return {
                "success": False,
                "command_transmitted": True,
                "command_transmitted_at": tx_at,
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

    lockout_state = get_dispense_lockout_state()
    if lockout_state is not None:
        print(
            f"[LOCKOUT] Refusing to claim or dispense order {order_id} while dispensing lockout is active "
            f"(reason={lockout_state.get('failure_reason')})."
        )
        return

    # ---------------------------------
    # PREVENT DUPLICATE ORDERS
    # ---------------------------------

    with order_state_lock:
        if order_id in processed_orders or order_id in orders_in_progress:
            print(f"Order {order_id} already handled/in progress; skipping.")
            return
        orders_in_progress.add(order_id)

    # ---------------------------------
    # BUILD COMMAND & TRANSACTIONALLY CLAIM ORDER (DISPENSING) UNDER machine_lock
    # ---------------------------------

    try:

        command = build_coffee_command(
            data
        )

    except ValueError as error:

        print(
            f"Order {order_id} rejected: "
            f"{error}"
        )

        with order_state_lock:
            processed_orders.add(order_id)
            orders_in_progress.discard(order_id)

        return

    with machine_lock:
        try:
            claimed_data = claim_order_in_firestore(
                order_id=order_id,
                doc_ref=doc_ref,
                fallback_data=data,
            )
        except ValueError as error:
            print(f"Order {order_id} rejected: {error}")
            with order_state_lock:
                processed_orders.add(order_id)
                orders_in_progress.discard(order_id)
            return

        if not claimed_data:
            with order_state_lock:
                orders_in_progress.discard(order_id)
            return

        coffee = claimed_data.get("product_name", "")
        base = str(claimed_data.get("base", "water")).upper()
        milk_powder = normalize_binary_flag(claimed_data.get("extra_sugar", 0))
        amount = claimed_data.get("amount")

        print("\n--------------------------------")
        print("NEW ORDER RECEIVED")
        print("Order ID    :", order_id)
        print("Coffee      :", coffee)
        print("Base        :", base)
        print("Milk Powder :", milk_powder)
        print(
            "Extra Sugar (Firestore) :",
            claimed_data.get("extra_sugar", 0),
            f"(mapped to Arduino 3rd parameter milk_powder={milk_powder})",
        )
        print("Amount      :", amount)
        print("Command     :", command)
        print("--------------------------------")

        try:
            dispense_exec = execute_arduino_dispense_for_order(
                command,
                timeout=180,
                order_id=order_id,
                doc_ref=doc_ref,
                dispense_started_at=claimed_data.get("dispense_started_at"),
                _holding_machine_lock=True,
            )
            success = bool(dispense_exec["success"])
            failure_stage = dispense_exec.get("failure_stage")
            failure_reason = dispense_exec.get("failure_reason")

            recorded_stage = (
                "PRE_DISPENSE" if failure_stage == "LOCKED_OUT" else failure_stage
            )
            record_dispense_outcome_in_firestore(
                order_id=order_id,
                success=success,
                doc_ref=doc_ref,
                failure_stage=recorded_stage,
                failure_reason=failure_reason,
            )
        except LockoutPersistenceError as persist_err:
            record_dispense_outcome_in_firestore(
                order_id=order_id,
                success=False,
                doc_ref=doc_ref,
                failure_stage=(
                    "DURING_DISPENSE" if persist_err.command_transmitted else "PRE_DISPENSE"
                ),
                failure_reason=persist_err.failure_reason,
            )
            raise
        finally:
            with order_state_lock:
                orders_in_progress.discard(order_id)
                processed_orders.add(order_id)

    if success:
        print(
            f"Order {order_id} "
            "completed and marked DISPENSED in Firestore."
        )
    elif failure_stage in {"PRE_DISPENSE", "LOCKED_OUT"}:
        print(
            f"Order {order_id} failed before command transmission ({failure_reason}). "
            "Marked FAILED (NOT_DISPENSED / PRE_DISPENSE) in Firestore."
        )
    else:
        print(
            f"Order {order_id} was not confirmed by Arduino ({failure_reason}). "
            "Marked FAILED (UNCERTAIN / DURING_DISPENSE) in Firestore; "
            "machine dispensing lockout latched."
        )


# =====================================================
# MAIN FUNCTION
# =====================================================

def _handle_sigterm(signum, frame):
    raise SystemExit(0)


def is_startup_home_verified_in_firmware():
    return os.environ.get("CAFFIX_STARTUP_HOME_VERIFIED", "").strip().lower() == "true"


def run_startup_safety_checks(client=None, arduino_probe_fn=None):
    """
    Ordered startup recovery & safety verification sequence:
    1. Load durable attempted_orders_<MACHINE_ID>.json into RAM processed_orders.
    2. Detect leftover dispense_inflight_<MACHINE_ID>.json.
    3. Permanently record interrupted order_id in attempted_orders.
    4. Reconcile interrupted order with Firestore using strict TWO-SOURCE agreement:
       NOT_DISPENSED only when BOTH local WAL and Firestore explicitly report
       command_transmitted=False (and no contradictory attempted_orders record exists);
       otherwise UNCERTAIN (never allowing Firestore False to override WAL True).
    5. Verify Arduino responds to PING -> CAFFIX_ARDUINO.
    6. Enforce CAFFIX_STARTUP_HOME_VERIFIED firmware gate: until actual Arduino sketch
       HOME behavior is verified, retain lockout on any leftover dispense_inflight.
       Even when verified, only run HOME if BOTH sources confirmed False.
    Returns dict with `safe_for_online`, `lockout_retained`, `outcome`, `reason`.
    """
    global _dispense_lockout_state, _dispense_lockout_disk_checked

    attempted_map = load_attempted_orders()
    with order_state_lock:
        for att_id in attempted_map:
            processed_orders.add(att_id)

    lockout_path = get_dispense_lockout_file_path()
    inflight_path = get_dispense_inflight_file_path()
    has_lockout_file = os.path.exists(lockout_path)
    has_inflight_file = os.path.exists(inflight_path)

    if has_lockout_file:
        state = get_dispense_lockout_state()
        return {
            "safe_for_online": False,
            "lockout_retained": True,
            "outcome": "LOCKOUT_FILE_ACTIVE",
            "reason": (state or {}).get("failure_reason") or "PERSISTED_LOCKOUT_ACTIVE",
        }

    if not has_inflight_file:
        probe_fn = probe_arduino_responsive if arduino_probe_fn is None else arduino_probe_fn
        if not probe_fn():
            return {
                "safe_for_online": False,
                "lockout_retained": False,
                "outcome": "ARDUINO_PING_FAILED",
                "reason": "ARDUINO_PING_FAILED",
            }
        return {
            "safe_for_online": True,
            "lockout_retained": False,
            "outcome": "CLEAN_STARTUP",
            "reason": None,
        }

    # Parse leftover WAL marker strictly (corrupt/unreadable -> None)
    wal_data = None
    wal_valid = False
    try:
        with open(inflight_path, "r", encoding="utf-8") as fh:
            parsed = json.load(fh)
        if isinstance(parsed, dict) and parsed.get("order_id"):
            wal_data = parsed
            wal_valid = True
    except Exception:
        wal_data = None
        wal_valid = False

    interrupted_order_id = str(wal_data.get("order_id")).strip() if wal_data else None
    wal_cmd_tx = wal_data.get("command_transmitted") if wal_data else None
    wal_mech_att = wal_data.get("mechanical_command_attempted") if wal_data else None
    prior_attempt = attempted_map.get(interrupted_order_id) if interrupted_order_id else None
    contradictory_attempt = bool(
        prior_attempt
        and (
            prior_attempt.get("command_transmitted") is True
            or prior_attempt.get("mechanical_command_attempted") is True
        )
    )

    if interrupted_order_id:
        record_attempted_order(
            interrupted_order_id,
            command_transmitted=bool(wal_cmd_tx is True or contradictory_attempt),
            mechanical_command_attempted=bool(wal_mech_att is True or contradictory_attempt),
            stage="DURING_DISPENSE"
            if (wal_cmd_tx is True or not wal_valid or contradictory_attempt)
            else "PRE_DISPENSE",
        )
        with order_state_lock:
            processed_orders.add(interrupted_order_id)

    # Reconcile with Firestore using transactional two-source truth
    firestore_reachable = False
    firestore_cmd_tx = None
    if interrupted_order_id:
        resolved_doc_ref, resolved_client = _resolve_doc_ref_and_client(
            interrupted_order_id, client=client
        )
        if (
            resolved_doc_ref is not None
            and resolved_client is not None
            and hasattr(resolved_client, "transaction")
        ):
            try:
                now_iso = datetime.now(timezone.utc).isoformat()

                def _reconcile_tx(transaction):
                    snap = resolved_doc_ref.get(transaction=transaction)
                    if not getattr(snap, "exists", False):
                        return {"reachable": True, "fs_cmd_tx": None}
                    live = snap.to_dict() or {}
                    fs_cmd = live.get("command_transmitted")
                    disp_status = str(live.get("dispense_status") or "").strip().upper()
                    live_refund = str(live.get("refund_status") or "").strip().upper()
                    pending_paise = float(live.get("pending_refund_amount_paise") or 0)
                    refunded_paise = float(live.get("total_refunded_amount_paise") or 0)

                    wal_explicit_false = (
                        wal_valid
                        and wal_cmd_tx is False
                        and wal_mech_att is False
                        and not contradictory_attempt
                    )
                    both_explicit_false = wal_explicit_false and (fs_cmd is False)

                    is_terminal_or_refunded = (
                        disp_status in {"DISPENSED", "EXPIRED", "FAILED", "CANCELLED"}
                        or live.get("dispensed") is True
                        or live_refund in {"PENDING", "PARTIAL", "FULL"}
                        or pending_paise > 0
                        or refunded_paise > 0
                    )

                    if not is_terminal_or_refunded and disp_status == "DISPENSING":
                        if both_explicit_false:
                            updates = {
                                "dispense_status": "FAILED",
                                "dispensed": False,
                                "dispense_outcome": "NOT_DISPENSED",
                                "failure_stage": "PRE_DISPENSE",
                                "failure_reason": "POWER_LOSS_BEFORE_COMMAND_TRANSMISSION",
                                "dispense_started_at": None,
                                "claimed_at": None,
                                "updated_at": now_iso,
                            }
                        else:
                            updates = {
                                "dispense_status": "FAILED",
                                "dispensed": False,
                                "dispense_outcome": "UNCERTAIN",
                                "failure_stage": "DURING_DISPENSE",
                                "failure_reason": "POWER_LOSS_DURING_DISPENSE_ON_RESTART",
                                "updated_at": now_iso,
                            }
                            if wal_cmd_tx is True or fs_cmd is True:
                                updates["command_transmitted"] = True
                                updates["command_transmitted_at"] = (
                                    live.get("command_transmitted_at")
                                    or (wal_data or {}).get("command_transmitted_at")
                                    or now_iso
                                )
                        transaction.set(resolved_doc_ref, updates, merge=True)
                    elif wal_cmd_tx is True and fs_cmd is not True:
                        # Never allow Firestore False to override WAL True
                        transaction.set(
                            resolved_doc_ref,
                            {
                                "command_transmitted": True,
                                "command_transmitted_at": (wal_data or {}).get("command_transmitted_at") or now_iso,
                                "updated_at": now_iso,
                            },
                            merge=True,
                        )
                    return {"reachable": True, "fs_cmd_tx": fs_cmd}

                tx_out = _run_firestore_tx(resolved_client, _reconcile_tx)
                firestore_reachable = bool(tx_out.get("reachable"))
                firestore_cmd_tx = tx_out.get("fs_cmd_tx")
            except Exception as fs_err:
                print(f"[STARTUP] Firestore reconciliation failed for {interrupted_order_id}: {fs_err}")
                firestore_reachable = False

    both_sources_explicit_false = (
        wal_valid
        and wal_cmd_tx is False
        and wal_mech_att is False
        and not contradictory_attempt
        and firestore_reachable
        and firestore_cmd_tx is False
    )

    probe_fn = probe_arduino_responsive if arduino_probe_fn is None else arduino_probe_fn
    if not probe_fn():
        latch_dispense_lockout(
            order_id=interrupted_order_id,
            command=(wal_data or {}).get("command"),
            failure_reason="STARTUP_ARDUINO_PING_FAILED",
            failure_stage="DURING_DISPENSE",
        )
        return {
            "safe_for_online": False,
            "lockout_retained": True,
            "outcome": "UNCERTAIN",
            "reason": "STARTUP_ARDUINO_PING_FAILED",
        }

    if not both_sources_explicit_false:
        latch_dispense_lockout(
            order_id=interrupted_order_id,
            command=(wal_data or {}).get("command"),
            failure_reason="TRAY_STATUS_UNVERIFIED_AFTER_POWER_LOSS",
            failure_stage="DURING_DISPENSE",
        )
        return {
            "safe_for_online": False,
            "lockout_retained": True,
            "outcome": "UNCERTAIN",
            "reason": "TRAY_STATUS_UNVERIFIED_AFTER_POWER_LOSS",
        }

    # Both sources explicitly false, but HOME firmware safety must still be verified
    if not is_startup_home_verified_in_firmware():
        latch_dispense_lockout(
            order_id=interrupted_order_id,
            command=(wal_data or {}).get("command"),
            failure_reason="STARTUP_HOME_UNVERIFIED_REQUIRES_PHYSICAL_INSPECTION",
            failure_stage="PRE_DISPENSE",
        )
        return {
            "safe_for_online": False,
            "lockout_retained": True,
            "outcome": "NOT_DISPENSED_LOCKOUT_RETAINED",
            "reason": "STARTUP_HOME_UNVERIFIED_REQUIRES_PHYSICAL_INSPECTION",
        }

    # Verified firmware HOME permitted only when both sources confirmed False
    home_ok = bool(send_to_arduino("HOME", expected="DONE", timeout=90))
    if not home_ok:
        latch_dispense_lockout(
            order_id=interrupted_order_id,
            command="HOME",
            failure_reason="STARTUP_HOME_FAILED",
            failure_stage="DURING_DISPENSE",
        )
        return {
            "safe_for_online": False,
            "lockout_retained": True,
            "outcome": "UNCERTAIN",
            "reason": "STARTUP_HOME_FAILED",
        }

    # Safe to clear stale pre-command marker only after PING + verified HOME succeed
    _clear_inflight_dispense_marker()
    with dispense_lockout_lock:
        _dispense_lockout_state = None
        _dispense_lockout_disk_checked = False
    return {
        "safe_for_online": True,
        "lockout_retained": False,
        "outcome": "NOT_DISPENSED_RECOVERED",
        "reason": None,
    }


def main():

    global arduino, _arduino_responsive

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

    startup_lockout = get_dispense_lockout_state()
    if startup_lockout is not None:
        print(
            f"[LOCKOUT] WARNING: Persisted dispensing lockout is ACTIVE for {MACHINE_ID} "
            f"(order={startup_lockout.get('order_id')}, reason={startup_lockout.get('failure_reason')}, "
            f"latched_at={startup_lockout.get('latched_at')}). "
            "Controller will NOT claim/dispense orders or report ONLINE until physically inspected and "
            "recovered via: python vending_controller.py --clear-lockout --confirm-machine-safe"
        )

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

        verify_dispense_state_dir_writable()
        acquire_controller_runtime_lock()

        client = ensure_firestore_client()

        # ---------------------------------
        # CONNECT TO ARDUINO FIRST BEFORE REPORTING ONLINE
        # ---------------------------------

        print(
            "Connecting to Arduino..."
        )

        arduino = connect_arduino()
        if arduino is not None and getattr(arduino, "is_open", False):
            _arduino_responsive = True

        startup_safety = run_startup_safety_checks(client=client)
        if not startup_safety.get("safe_for_online"):
            print(
                f"[STARTUP] Machine {MACHINE_ID} failed/held startup safety checks "
                f"(outcome={startup_safety.get('outcome')}, reason={startup_safety.get('reason')}). "
                "ONLINE heartbeats and dispensing remain halted until physical inspection."
            )

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

        # Start backend heartbeat only once Arduino is connected/responsive AND listener is active
        start_heartbeat_thread(require_arduino=True)

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
        # KEEP PROGRAM RUNNING & AUTO-RECONNECT ARDUINO
        # ---------------------------------

        while True:
            if lockout_persistence_failed_event.is_set():
                raise RuntimeError(
                    "CRITICAL: Dispensing lockout persistence failed; halting controller fail-closed: "
                    f"{_fatal_lockout_persistence_error}"
                )
            if (
                arduino_reconnect_event.is_set()
                or arduino is None
                or not getattr(arduino, "is_open", False)
                or not _arduino_responsive
            ):
                reconcile_arduino_connection_once()
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

        with arduino_lock:
            close_serial()

        release_controller_runtime_lock()

        if registered_sigterm:
            try:
                signal.signal(signal.SIGTERM, previous_sigterm_handler)
            except Exception:
                pass


# =====================================================
# DOCUMENTED LOCKOUT RECOVERY CLI
# =====================================================

def run_cli(argv=None):
    import argparse

    parser = argparse.ArgumentParser(
        description="CAFFIX Raspberry Pi Vending Controller & Fault Lockout Recovery"
    )
    parser.add_argument(
        "--lockout-status",
        action="store_true",
        help="Print current machine-level dispensing lockout state as JSON and exit.",
    )
    parser.add_argument(
        "--clear-lockout",
        action="store_true",
        help="Explicitly clear machine-level dispensing lockout after physical inspection.",
    )
    parser.add_argument(
        "--confirm-machine-safe",
        action="store_true",
        help="Required confirmation flag asserting physical inspection verified all motors/valves stopped and cup tray is safe.",
    )
    parser.add_argument(
        "--operator",
        default="",
        help="Optional operator identifier recorded in recovery logs.",
    )
    parser.add_argument(
        "--notes",
        default="",
        help="Optional physical inspection notes recorded in recovery logs.",
    )

    args = parser.parse_args(argv)

    if args.lockout_status:
        state = get_dispense_lockout_state()
        print(json.dumps({"locked_out": state is not None, "lockout": state}, indent=2))
        return 2 if state is not None else 0

    if args.clear_lockout:
        if not args.confirm_machine_safe:
            print(
                "ERROR: Refusing to clear dispensing lockout without --confirm-machine-safe.\n"
                "Recovery procedure:\n"
                "  1. Stop controller service (`sudo systemctl stop caffix-vending.service`).\n"
                "  2. Physically inspect the machine and confirm pouring/motors have stopped and cup tray is safe.\n"
                "  3. Run as controller user: sudo -u caffix ... python vending_controller.py --clear-lockout --confirm-machine-safe --operator <name>\n"
                "  4. Restart service (`sudo systemctl start caffix-vending.service`)."
            )
            return 1
        cleared = clear_dispense_lockout(
            confirm_machine_safe=True,
            operator=args.operator.strip() or None,
            notes=args.notes.strip() or None,
        )
        print(json.dumps({"cleared": True, "previous_lockout": cleared}, indent=2))
        return 0

    main()
    return 0


# =====================================================
# PROGRAM ENTRY POINT
# =====================================================

if __name__ == "__main__":

    raise SystemExit(run_cli())

