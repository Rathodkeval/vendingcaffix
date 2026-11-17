import io
import json
import threading
import time
import unittest
import urllib.error
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest import mock

import vending_controller as vc


class _MockBackendState:
    def __init__(self):
        self.verify_calls = 0
        self.heartbeat_calls = 0
        self.rejected_once = False
        self.fail_network = False
        self.fail_http_503 = False
        self.expire_on_next_heartbeat = False
        self.expected_kiosk_token = "kiosk-secret-mc01-test"
        self.expected_machine_id = "CFX-MC-01"
        self.current_jwt = "jwt-initial-token"
        self.last_heartbeat_headers = None
        self.last_heartbeat_body = None
        self.last_seen_sent = None


def _make_handler(state: _MockBackendState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def _send_json(self, code, payload):
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path.startswith("/api/kiosk/verify"):
                state.verify_calls += 1
                from urllib.parse import parse_qs, urlparse

                qs = parse_qs(urlparse(self.path).query)
                kiosk = (qs.get("kiosk") or [""])[0]
                machine_id = (qs.get("machine_id") or [""])[0]
                if (
                    kiosk == state.expected_kiosk_token
                    and machine_id == state.expected_machine_id
                ):
                    self._send_json(
                        200,
                        {
                            "authorized": True,
                            "machine_id": machine_id,
                            "machine_name": "ONE",
                            "token": state.current_jwt,
                        },
                    )
                    return
                self._send_json(401, {"authorized": False, "message": "Unauthorized"})
                return
            self._send_json(404, {"status": "error", "message": "Not found"})

        def do_POST(self):
            if self.path == f"/api/machines/{state.expected_machine_id}/heartbeat":
                state.heartbeat_calls += 1
                if state.fail_http_503:
                    self._send_json(503, {"status": "error", "message": "Unavailable"})
                    return

                auth = self.headers.get("Authorization", "")
                length = int(self.headers.get("Content-Length") or "0")
                raw_body = self.rfile.read(length) if length > 0 else b""
                state.last_heartbeat_headers = dict(self.headers)
                state.last_heartbeat_body = raw_body.decode("utf-8", errors="replace")

                if state.expire_on_next_heartbeat:
                    state.expire_on_next_heartbeat = False
                    state.current_jwt = "jwt-refreshed-token"
                    self._send_json(401, {"status": "error", "message": "Token expired"})
                    return

                if auth != f"Bearer {state.current_jwt}":
                    self._send_json(401, {"status": "error", "message": "Invalid token"})
                    return

                state.last_seen_sent = "2026-11-16T05:00:00.000Z"
                self._send_json(
                    200,
                    {
                        "status": "success",
                        "data": {
                            "id": state.expected_machine_id,
                            "desired_mode": "RUNNING",
                            "connection_status": "ONLINE",
                            "status": "online",
                            "last_seen": state.last_seen_sent,
                        },
                    },
                )
                return
            self._send_json(403, {"status": "error", "message": "Forbidden"})

    return Handler


class TestVendingControllerHeartbeat(unittest.TestCase):
    def setUp(self):
        vc.stop_heartbeat_thread()
        vc.clear_heartbeat_jwt_cache()
        self.state = _MockBackendState()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _make_handler(self.state))
        self.port = self.server.server_address[1]
        self.api_base = f"http://127.0.0.1:{self.port}/api"
        self.server_thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        self.server_thread.start()

    def tearDown(self):
        vc.stop_heartbeat_thread()
        vc.clear_heartbeat_jwt_cache()
        self.server.shutdown()
        self.server.server_close()

    def test_jwt_exchange_and_heartbeat_contract(self):
        res = vc.send_heartbeat_once(
            machine_id="CFX-MC-01",
            kiosk_token="kiosk-secret-mc01-test",
            api_base=self.api_base,
        )
        self.assertEqual(res["status"], "success")
        self.assertEqual(res["data"]["id"], "CFX-MC-01")
        self.assertEqual(res["data"]["connection_status"], "ONLINE")
        self.assertEqual(self.state.verify_calls, 1)
        self.assertEqual(self.state.heartbeat_calls, 1)
        self.assertEqual(self.state.last_heartbeat_body, "{}")

        # Second call reuses cached JWT without hitting /kiosk/verify again
        res2 = vc.send_heartbeat_once(
            machine_id="CFX-MC-01",
            kiosk_token="kiosk-secret-mc01-test",
            api_base=self.api_base,
        )
        self.assertEqual(res2["data"]["connection_status"], "ONLINE")
        self.assertEqual(self.state.verify_calls, 1)
        self.assertEqual(self.state.heartbeat_calls, 2)

    def test_401_triggers_single_jwt_refresh_and_retry(self):
        vc.send_heartbeat_once(
            machine_id="CFX-MC-01",
            kiosk_token="kiosk-secret-mc01-test",
            api_base=self.api_base,
        )
        self.state.expire_on_next_heartbeat = True

        res = vc.send_heartbeat_once(
            machine_id="CFX-MC-01",
            kiosk_token="kiosk-secret-mc01-test",
            api_base=self.api_base,
        )
        self.assertEqual(res["data"]["connection_status"], "ONLINE")
        self.assertEqual(self.state.verify_calls, 2)
        self.assertEqual(self.state.heartbeat_calls, 3)

    def test_missing_kiosk_token_skips_cleanly(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            thread = vc.start_heartbeat_thread(
                machine_id="CFX-MC-01",
                kiosk_token="",
                api_base=self.api_base,
            )
        self.assertIsNone(thread)
        self.assertEqual(self.state.verify_calls, 0)
        self.assertEqual(self.state.heartbeat_calls, 0)
        self.assertIn("CAFFIX_KIOSK_TOKEN not configured", buf.getvalue())

    def test_offline_failure_recovery_clean_shutdown_and_no_secret_logs(self):
        self.state.fail_http_503 = True
        buf = io.StringIO()
        with redirect_stdout(buf):
            thread = vc.start_heartbeat_thread(
                machine_id="CFX-MC-01",
                kiosk_token="kiosk-secret-mc01-test",
                api_base=self.api_base,
                interval_seconds=0.08,
                timeout=2.0,
            )
            self.assertIsNotNone(thread)
            time.sleep(0.22)
            # Recover connectivity while thread is running
            self.state.fail_http_503 = False
            time.sleep(0.25)

            started_stop = time.monotonic()
            vc.stop_heartbeat_thread(timeout=2.0)
            stop_elapsed = time.monotonic() - started_stop

        logs = buf.getvalue()
        self.assertLess(stop_elapsed, 1.0, "Shutdown must wake stop_event immediately")
        self.assertGreaterEqual(self.state.heartbeat_calls, 2)
        self.assertIn("Connectivity restored for CFX-MC-01", logs)
        self.assertNotIn("kiosk-secret-mc01-test", logs)
        self.assertNotIn("jwt-initial-token", logs)
        self.assertFalse(vc.arduino_lock.locked())
        self.assertFalse(vc.machine_lock.locked())

    def test_network_error_does_not_crash_heartbeat_loop(self):
        stop_evt = threading.Event()
        with mock.patch.object(
            vc,
            "send_heartbeat_once",
            side_effect=urllib.error.URLError("DNS offline"),
        ):
            def _stop_soon():
                time.sleep(0.15)
                stop_evt.set()

            threading.Thread(target=_stop_soon, daemon=True).start()
            buf = io.StringIO()
            with redirect_stdout(buf):
                vc.heartbeat_loop(
                    stop_event=stop_evt,
                    machine_id="CFX-MC-01",
                    kiosk_token="kiosk-secret-mc01-test",
                    api_base=self.api_base,
                    interval_seconds=0.05,
                )
        self.assertIn("Unavailable for CFX-MC-01: URLError", buf.getvalue())
        self.assertNotIn("kiosk-secret-mc01-test", buf.getvalue())

    def test_main_starts_heartbeat_before_connect_arduino_and_keeps_beating_while_waiting(self):
        old_machine = vc.MACHINE_ID
        old_token = vc.CAFFIX_KIOSK_TOKEN
        old_base = vc.CAFFIX_API_BASE
        old_interval = vc.HEARTBEAT_INTERVAL_SECONDS
        vc.MACHINE_ID = "CFX-MC-01"
        vc.CAFFIX_KIOSK_TOKEN = "kiosk-secret-mc01-test"
        vc.CAFFIX_API_BASE = self.api_base
        vc.HEARTBEAT_INTERVAL_SECONDS = 0.05

        calls_at_arduino_entry = {}

        def _blocking_connect_arduino():
            calls_at_arduino_entry["thread_alive_on_entry"] = (
                vc.heartbeat_thread is not None and vc.heartbeat_thread.is_alive()
            )
            # Simulate disconnected Arduino retrying while heartbeat continues firing
            time.sleep(0.25)
            calls_at_arduino_entry["heartbeats_while_waiting"] = self.state.heartbeat_calls
            raise KeyboardInterrupt()

        fake_client = mock.MagicMock()
        try:
            with mock.patch.object(vc, "ensure_firestore_client", return_value=fake_client), \
                 mock.patch.object(vc, "connect_arduino", side_effect=_blocking_connect_arduino):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    vc.main()

            self.assertTrue(
                calls_at_arduino_entry.get("thread_alive_on_entry"),
                "Heartbeat thread must already be started BEFORE connect_arduino()",
            )
            self.assertGreaterEqual(
                calls_at_arduino_entry.get("heartbeats_while_waiting", 0),
                2,
                "Heartbeat must continue firing while connect_arduino() is waiting",
            )
            self.assertIsNone(
                vc.heartbeat_thread,
                "Heartbeat thread must be cleaned up on KeyboardInterrupt during startup",
            )
            self.assertTrue(vc.heartbeat_stop_event.is_set())
        finally:
            vc.stop_heartbeat_thread()
            vc.MACHINE_ID = old_machine
            vc.CAFFIX_KIOSK_TOKEN = old_token
            vc.CAFFIX_API_BASE = old_base
            vc.HEARTBEAT_INTERVAL_SECONDS = old_interval

    def test_main_startup_failure_or_sigterm_cleans_up_heartbeat_and_preserves_missing_token_safety(self):
        old_machine = vc.MACHINE_ID
        old_token = vc.CAFFIX_KIOSK_TOKEN
        old_base = vc.CAFFIX_API_BASE
        old_interval = vc.HEARTBEAT_INTERVAL_SECONDS
        vc.MACHINE_ID = "CFX-MC-01"
        vc.CAFFIX_KIOSK_TOKEN = "kiosk-secret-mc01-test"
        vc.CAFFIX_API_BASE = self.api_base
        vc.HEARTBEAT_INTERVAL_SECONDS = 0.05

        try:
            # 1. Startup failure (e.g. missing serviceAccountKey.json) stops heartbeat thread cleanly
            with mock.patch.object(
                vc, "ensure_firestore_client", side_effect=FileNotFoundError("no creds")
            ):
                with self.assertRaises(FileNotFoundError):
                    vc.main()
            self.assertIsNone(vc.heartbeat_thread)
            self.assertTrue(vc.heartbeat_stop_event.is_set())

            # 2. SIGTERM handler during main() triggers SystemExit and stops heartbeat thread cleanly
            def _simulate_sigterm():
                vc._handle_sigterm(15, None)

            with mock.patch.object(vc, "ensure_firestore_client", return_value=mock.MagicMock()), \
                 mock.patch.object(vc, "connect_arduino", side_effect=_simulate_sigterm):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    vc.main()
            self.assertIsNone(vc.heartbeat_thread)
            self.assertTrue(vc.heartbeat_stop_event.is_set())

            # 3. Missing CAFFIX_KIOSK_TOKEN does not crash main() controller startup
            vc.CAFFIX_KIOSK_TOKEN = ""
            fake_watch = mock.MagicMock()
            fake_query = mock.MagicMock()
            fake_query.where.return_value = fake_query
            fake_query.on_snapshot.return_value = fake_watch
            fake_client = mock.MagicMock()
            fake_client.collection.return_value = fake_query
            with mock.patch.object(vc, "ensure_firestore_client", return_value=fake_client), \
                 mock.patch.object(vc, "connect_arduino", return_value=mock.MagicMock()), \
                 mock.patch.object(vc, "load_existing_orders"), \
                 mock.patch.object(vc.time, "sleep", side_effect=KeyboardInterrupt()):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    vc.main()
            fake_query.where.assert_called_once()
            fake_query.on_snapshot.assert_called_once()
            fake_watch.unsubscribe.assert_called_once()
            self.assertIn("CAFFIX_KIOSK_TOKEN not configured", buf.getvalue())
        finally:
            vc.stop_heartbeat_thread()
            vc.MACHINE_ID = old_machine
            vc.CAFFIX_KIOSK_TOKEN = old_token
            vc.CAFFIX_API_BASE = old_base
            vc.HEARTBEAT_INTERVAL_SECONDS = old_interval

    def test_existing_order_filtering_and_command_builder_preserved(self):
        old_machine_id = vc.MACHINE_ID
        vc.MACHINE_ID = "CFX-MC-01"
        try:
            self.assertEqual(
                vc.build_coffee_command(
                    {"product_name": "Irish Emerald", "base": "milk", "extra_sugar": 1}
                ),
                "IRISH,MILK,1",
            )
            self.assertEqual(
                vc.build_coffee_command(
                    {"product_name": "Classic Crest", "base": "water", "extra_sugar": 0}
                ),
                "CLASSIC,WATER,0",
            )
            self.assertTrue(vc.order_belongs_to_this_machine({"machine_id": "CFX-MC-01"}))
            self.assertFalse(vc.order_belongs_to_this_machine({"machine_id": "CFX-MC-02"}))
            self.assertFalse(vc.order_belongs_to_this_machine({"machine_id": "CFX-MC-03"}))
            self.assertTrue(
                vc.is_order_eligible_for_local_controller(
                    {"machine_id": "CFX-MC-01", "status": "PAID", "dispense_status": "QUEUED"}
                )
            )
            self.assertTrue(
                vc.is_order_eligible_for_local_controller(
                    {"machine_id": "CFX-MC-01", "status": "COMPLETED", "dispense_status": "QUEUED"}
                )
            )
            self.assertFalse(
                vc.is_order_eligible_for_local_controller(
                    {"machine_id": "CFX-MC-01", "status": "PAID", "dispense_status": "PENDING"}
                )
            )
            self.assertFalse(
                vc.is_order_eligible_for_local_controller(
                    {"machine_id": "CFX-MC-01", "status": "COMPLETED", "dispense_status": "EXPIRED"}
                )
            )
            self.assertFalse(
                vc.is_order_eligible_for_local_controller(
                    {"machine_id": "CFX-MC-01", "status": "PAID", "dispense_status": "QUEUED", "refund_status": "FULL"}
                )
            )
            self.assertFalse(
                vc.is_order_eligible_for_local_controller(
                    {"machine_id": "CFX-MC-01", "status": "PAID", "dispense_status": "QUEUED", "refund_status": "PENDING"}
                )
            )
            self.assertFalse(
                vc.is_order_eligible_for_local_controller(
                    {"machine_id": "CFX-MC-01", "status": "PAID", "dispense_status": "QUEUED", "pending_refund_amount_paise": 100}
                )
            )
            self.assertFalse(
                vc.is_order_eligible_for_local_controller(
                    {
                        "machine_id": "CFX-MC-01",
                        "status": "PAID",
                        "dispense_status": "QUEUED",
                        "expires_at": "2020-01-01T00:00:00Z",
                    }
                )
            )
        finally:
            vc.MACHINE_ID = old_machine_id

    def test_paid_queued_lifecycle_writes_dispensing_then_dispensed_or_uncertain(self):
        old_machine_id = vc.MACHINE_ID
        vc.MACHINE_ID = "CFX-MC-01"
        vc.processed_orders.clear()
        vc.orders_in_progress.clear()
        vc.pending_outcome_writes.clear()

        class _FakeTx:
            def __init__(self, lock):
                self._lock = lock

            def set(self, doc_ref, updates, merge=False):
                doc_ref.set(updates, merge=merge)

            def run(self, fn):
                with self._lock:
                    return fn(self)

        class _FakeClient:
            def __init__(self):
                self._lock = threading.Lock()

            def transaction(self):
                return _FakeTx(self._lock)

        class _FakeDocRef:
            def __init__(self, doc_id, initial_data, client):
                self.id = doc_id
                self._client = client
                self.data = dict(initial_data)
                self.writes = []

            def get(self, transaction=None):
                return SimpleNamespace(
                    exists=True,
                    id=self.id,
                    to_dict=lambda: dict(self.data),
                )

            def set(self, updates, merge=False):
                self.writes.append(dict(updates))
                if merge:
                    self.data.update(updates)
                else:
                    self.data = dict(updates)

        try:
            client = _FakeClient()
            # 1. Successful PAID + QUEUED order: writes DISPENSING before send_to_arduino, then DISPENSED after DONE
            doc_ok = _FakeDocRef(
                "CFX-TEST-OK",
                {
                    "id": "CFX-TEST-OK",
                    "machine_id": "CFX-MC-01",
                    "status": "PAID",
                    "dispense_status": "QUEUED",
                    "product_name": "Hazel Gold",
                    "base": "milk",
                    "extra_sugar": 1,
                    "amount": 1,
                },
                client=client,
            )
            change_ok = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(
                    id="CFX-TEST-OK",
                    reference=doc_ok,
                    to_dict=lambda: dict(doc_ok.data),
                ),
            )

            observed_during_arduino = {}

            def _fake_arduino_ok(cmd, expected="DONE", timeout=180):
                observed_during_arduino["cmd"] = cmd
                observed_during_arduino["status_before_done"] = doc_ok.data.get("dispense_status")
                observed_during_arduino["started_at_before_done"] = doc_ok.data.get("dispense_started_at")
                return True

            with mock.patch.object(vc, "send_to_arduino", side_effect=_fake_arduino_ok):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    vc.process_firestore_change(change_ok)

            self.assertEqual(observed_during_arduino["cmd"], "HAZELNUT,MILK,1")
            self.assertEqual(observed_during_arduino["status_before_done"], "DISPENSING")
            self.assertIsNotNone(observed_during_arduino["started_at_before_done"])
            self.assertEqual(len(doc_ok.writes), 2)
            self.assertEqual(doc_ok.writes[0]["dispense_status"], "DISPENSING")
            self.assertEqual(doc_ok.writes[1]["dispense_status"], "DISPENSED")
            self.assertTrue(doc_ok.writes[1]["dispensed"])
            self.assertEqual(doc_ok.writes[1]["dispense_outcome"], "DISPENSED")
            self.assertIn("CFX-TEST-OK", vc.processed_orders)

            # 2. Timeout / disconnect after sending command: writes DISPENSING, then FAILED + UNCERTAIN + DURING_DISPENSE
            doc_fail = _FakeDocRef(
                "CFX-TEST-TIMEOUT",
                {
                    "id": "CFX-TEST-TIMEOUT",
                    "machine_id": "CFX-MC-01",
                    "status": "PAID",
                    "dispense_status": "QUEUED",
                    "product_name": "Vanilla Velvet",
                    "base": "water",
                    "extra_sugar": 0,
                    "amount": 1,
                },
                client=client,
            )
            change_fail = SimpleNamespace(
                type=SimpleNamespace(name="MODIFIED"),
                document=SimpleNamespace(
                    id="CFX-TEST-TIMEOUT",
                    reference=doc_fail,
                    to_dict=lambda: dict(doc_fail.data),
                ),
            )

            with mock.patch.object(vc, "send_to_arduino", return_value=False):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    vc.process_firestore_change(change_fail)

            self.assertEqual(len(doc_fail.writes), 2)
            self.assertEqual(doc_fail.writes[0]["dispense_status"], "DISPENSING")
            self.assertEqual(doc_fail.writes[1]["dispense_status"], "FAILED")
            self.assertFalse(doc_fail.writes[1]["dispensed"])
            self.assertEqual(doc_fail.writes[1]["dispense_outcome"], "UNCERTAIN")
            self.assertEqual(doc_fail.writes[1]["failure_stage"], "DURING_DISPENSE")
            self.assertIsNone(doc_fail.data.get("dispensed_at"))
            self.assertIn("CFX-TEST-TIMEOUT", vc.processed_orders)
        finally:
            vc.MACHINE_ID = old_machine_id
            vc.processed_orders.clear()
            vc.orders_in_progress.clear()
            vc.pending_outcome_writes.clear()

    def test_area1_atomic_claim_safety_no_fallback_and_concurrent_single_winner(self):
        old_machine_id = vc.MACHINE_ID
        vc.MACHINE_ID = "CFX-MC-01"
        vc.processed_orders.clear()
        vc.orders_in_progress.clear()

        class _LockingTx:
            def __init__(self, lock, fail_tx=False):
                self._lock = lock
                self._fail_tx = fail_tx

            def set(self, doc_ref, updates, merge=False):
                doc_ref.set(updates, merge=merge)

            def run(self, fn):
                if self._fail_tx:
                    raise RuntimeError("Simulated Firestore transaction conflict/network abort")
                with self._lock:
                    return fn(self)

        class _LockingClient:
            def __init__(self, fail_tx=False):
                self._lock = threading.Lock()
                self.fail_tx = fail_tx
                self.tx_calls = 0

            def transaction(self):
                self.tx_calls += 1
                return _LockingTx(self._lock, fail_tx=self.fail_tx)

        class _AtomicDocRef:
            def __init__(self, doc_id, initial_data, client):
                self.id = doc_id
                self._client = client
                self.data = dict(initial_data)
                self.writes = []

            def get(self, transaction=None):
                if transaction is None:
                    raise AssertionError("Non-transactional get() is forbidden during claim!")
                return SimpleNamespace(
                    exists=True,
                    id=self.id,
                    to_dict=lambda: dict(self.data),
                )

            def set(self, updates, merge=False):
                self.writes.append(dict(updates))
                if merge:
                    self.data.update(updates)
                else:
                    self.data = dict(updates)

        try:
            # 1a. Client without .transaction() must NEVER fall back to non-atomic claim
            doc_no_tx = _AtomicDocRef(
                "CFX-NO-TX",
                {
                    "id": "CFX-NO-TX",
                    "machine_id": "CFX-MC-01",
                    "status": "PAID",
                    "dispense_status": "QUEUED",
                    "product_name": "Classic Crest",
                    "base": "water",
                    "extra_sugar": 1,
                },
                client=SimpleNamespace(),  # No .transaction() attribute
            )
            with mock.patch.object(vc, "ensure_firestore_client", return_value=SimpleNamespace()):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    res_no_tx = vc.claim_order_in_firestore(
                        "CFX-NO-TX",
                        doc_ref=doc_no_tx,
                        fallback_data=doc_no_tx.data,
                    )
            self.assertIsNone(res_no_tx, "Must refuse claim when client lacks transaction support")
            self.assertEqual(len(doc_no_tx.writes), 0)

            # 1b. Transaction error must return None and NEVER trigger Arduino dispensing
            failing_client = _LockingClient(fail_tx=True)
            doc_tx_err = _AtomicDocRef(
                "CFX-TX-ERR",
                {
                    "id": "CFX-TX-ERR",
                    "machine_id": "CFX-MC-01",
                    "status": "PAID",
                    "dispense_status": "QUEUED",
                    "product_name": "Classic Crest",
                    "base": "water",
                    "extra_sugar": 1,
                },
                client=failing_client,
            )
            change_tx_err = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(
                    id="CFX-TX-ERR",
                    reference=doc_tx_err,
                    to_dict=lambda: dict(doc_tx_err.data),
                ),
            )
            arduino_called = []
            with mock.patch.object(vc, "send_to_arduino", side_effect=lambda *a, **k: arduino_called.append(True)):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    vc.process_firestore_change(change_tx_err)
            self.assertEqual(len(arduino_called), 0, "Arduino must NEVER be called when transaction fails")
            self.assertEqual(doc_tx_err.data["dispense_status"], "QUEUED")

            # 1c. Two concurrent claim attempts for the same order -> exactly ONE succeeds
            race_client = _LockingClient(fail_tx=False)
            doc_race = _AtomicDocRef(
                "CFX-RACE-01",
                {
                    "id": "CFX-RACE-01",
                    "machine_id": "CFX-MC-01",
                    "status": "PAID",
                    "dispense_status": "QUEUED",
                    "product_name": "Irish Emerald",
                    "base": "milk",
                    "extra_sugar": 1,
                },
                client=race_client,
            )
            barrier = threading.Barrier(2)
            claim_results = []
            results_lock = threading.Lock()

            def _attempt_claim():
                barrier.wait(timeout=2.0)
                res = vc.claim_order_in_firestore(
                    "CFX-RACE-01",
                    doc_ref=doc_race,
                    client=race_client,
                )
                with results_lock:
                    claim_results.append(res)

            t1 = threading.Thread(target=_attempt_claim)
            t2 = threading.Thread(target=_attempt_claim)
            t1.start()
            t2.start()
            t1.join(timeout=3.0)
            t2.join(timeout=3.0)

            winners = [r for r in claim_results if r is not None]
            losers = [r for r in claim_results if r is None]
            self.assertEqual(len(winners), 1, "Exactly one concurrent claim attempt must succeed")
            self.assertEqual(len(losers), 1, "Second concurrent claim attempt must be rejected")
            self.assertEqual(len(doc_race.writes), 1)
            self.assertEqual(doc_race.data["dispense_status"], "DISPENSING")
        finally:
            vc.MACHINE_ID = old_machine_id
            vc.processed_orders.clear()
            vc.orders_in_progress.clear()

    def test_area2_startup_order_recovery_and_listener_reconnect_dedup(self):
        old_machine_id = vc.MACHINE_ID
        vc.MACHINE_ID = "CFX-MC-01"
        vc.processed_orders.clear()
        vc.orders_in_progress.clear()
        vc.pending_outcome_writes.clear()

        class _Tx:
            def __init__(self, lock):
                self._lock = lock

            def set(self, doc_ref, updates, merge=False):
                doc_ref.set(updates, merge=merge)

            def run(self, fn):
                with self._lock:
                    return fn(self)

        class _StoreClient:
            def __init__(self, docs_map):
                self._lock = threading.Lock()
                self.docs_map = docs_map

            def transaction(self):
                return _Tx(self._lock)

            def collection(self, _name):
                return self

            def where(self, *args, **kwargs):
                return self

            def stream(self):
                return [
                    SimpleNamespace(
                        id=doc_id,
                        reference=ref,
                        to_dict=lambda r=ref: dict(r.data),
                    )
                    for doc_id, ref in self.docs_map.items()
                    if ref.data.get("machine_id") == "CFX-MC-01"
                ]

        class _DocRef:
            def __init__(self, doc_id, data):
                self.id = doc_id
                self._client = None
                self.data = dict(data)
                self.writes = []

            def get(self, transaction=None):
                return SimpleNamespace(
                    exists=True,
                    id=self.id,
                    to_dict=lambda: dict(self.data),
                )

            def set(self, updates, merge=False):
                self.writes.append(dict(updates))
                if merge:
                    self.data.update(updates)
                else:
                    self.data = dict(updates)

        try:
            docs = {
                "CFX-STARTUP-ELIGIBLE": _DocRef(
                    "CFX-STARTUP-ELIGIBLE",
                    {
                        "id": "CFX-STARTUP-ELIGIBLE",
                        "machine_id": "CFX-MC-01",
                        "status": "PAID",
                        "dispense_status": "QUEUED",
                        "product_name": "Classic Crest",
                        "base": "water",
                        "extra_sugar": 1,
                        "amount": 1,
                    },
                ),
                "CFX-HIST-COMPLETED": _DocRef(
                    "CFX-HIST-COMPLETED",
                    {
                        "id": "CFX-HIST-COMPLETED",
                        "machine_id": "CFX-MC-01",
                        "status": "COMPLETED",
                        "dispense_status": "DISPENSED",
                        "dispensed": True,
                        "product_name": "Classic Crest",
                        "base": "water",
                        "extra_sugar": 1,
                    },
                ),
                "CFX-HIST-EXPIRED": _DocRef(
                    "CFX-HIST-EXPIRED",
                    {
                        "id": "CFX-HIST-EXPIRED",
                        "machine_id": "CFX-MC-01",
                        "status": "PAID",
                        "dispense_status": "EXPIRED",
                        "expired_at": "2026-11-16T06:16:00Z",
                        "product_name": "Classic Crest",
                        "base": "water",
                        "extra_sugar": 1,
                    },
                ),
                "CFX-HIST-REFUNDED": _DocRef(
                    "CFX-HIST-REFUNDED",
                    {
                        "id": "CFX-HIST-REFUNDED",
                        "machine_id": "CFX-MC-01",
                        "status": "PAID",
                        "dispense_status": "QUEUED",
                        "refund_status": "FULL",
                        "total_refunded_amount_paise": 100,
                        "product_name": "Classic Crest",
                        "base": "water",
                        "extra_sugar": 1,
                    },
                ),
                "CFX-HIST-DISPENSING": _DocRef(
                    "CFX-HIST-DISPENSING",
                    {
                        "id": "CFX-HIST-DISPENSING",
                        "machine_id": "CFX-MC-01",
                        "status": "PAID",
                        "dispense_status": "DISPENSING",
                        "dispense_started_at": "2026-11-16T06:01:00Z",
                        "product_name": "Classic Crest",
                        "base": "water",
                        "extra_sugar": 1,
                    },
                ),
                "CFX-HIST-UNCERTAIN": _DocRef(
                    "CFX-HIST-UNCERTAIN",
                    {
                        "id": "CFX-HIST-UNCERTAIN",
                        "machine_id": "CFX-MC-01",
                        "status": "PAID",
                        "dispense_status": "FAILED",
                        "dispense_outcome": "UNCERTAIN",
                        "failure_stage": "DURING_DISPENSE",
                        "product_name": "Classic Crest",
                        "base": "water",
                        "extra_sugar": 1,
                    },
                ),
                "CFX-OTHER-MC02": _DocRef(
                    "CFX-OTHER-MC02",
                    {
                        "id": "CFX-OTHER-MC02",
                        "machine_id": "CFX-MC-02",
                        "status": "PAID",
                        "dispense_status": "QUEUED",
                        "product_name": "Classic Crest",
                        "base": "water",
                        "extra_sugar": 1,
                    },
                ),
            }
            client = _StoreClient(docs)
            for ref in docs.values():
                ref._client = client

            dispensed_commands = []
            with mock.patch.object(vc, "ensure_firestore_client", return_value=client), \
                 mock.patch.object(vc, "send_to_arduino", side_effect=lambda cmd, **kw: (dispensed_commands.append(cmd) or True)):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    # 1. Startup order scan
                    vc.load_existing_orders()
                    self.assertNotIn("CFX-STARTUP-ELIGIBLE", vc.processed_orders)
                    self.assertIn("CFX-HIST-COMPLETED", vc.processed_orders)
                    self.assertIn("CFX-HIST-EXPIRED", vc.processed_orders)
                    self.assertIn("CFX-HIST-REFUNDED", vc.processed_orders)
                    self.assertIn("CFX-HIST-DISPENSING", vc.processed_orders)
                    self.assertIn("CFX-HIST-UNCERTAIN", vc.processed_orders)

                    # 2. Initial listener snapshot delivery (ADDED for all machine docs)
                    initial_changes = [
                        SimpleNamespace(
                            type=SimpleNamespace(name="ADDED"),
                            document=SimpleNamespace(
                                id=doc_id,
                                reference=ref,
                                to_dict=lambda r=ref: dict(r.data),
                            ),
                        )
                        for doc_id, ref in docs.items()
                    ]
                    vc.on_snapshot(None, initial_changes, None)

                    # 3. Simulate listener reconnect + duplicate ADDED and MODIFIED notifications
                    reconnect_changes = [
                        SimpleNamespace(
                            type=SimpleNamespace(name=evt_type),
                            document=SimpleNamespace(
                                id=doc_id,
                                reference=ref,
                                to_dict=lambda r=ref: dict(r.data),
                            ),
                        )
                        for evt_type in ("ADDED", "MODIFIED")
                        for doc_id, ref in docs.items()
                    ]
                    vc.on_snapshot(None, reconnect_changes, None)

            self.assertEqual(
                dispensed_commands,
                ["CLASSIC,WATER,1"],
                "Pre-existing eligible PAID/QUEUED order must be dispensed exactly once across startup and reconnects",
            )
            self.assertEqual(docs["CFX-STARTUP-ELIGIBLE"].data["dispense_status"], "DISPENSED")
            self.assertTrue(docs["CFX-STARTUP-ELIGIBLE"].data["dispensed"])
        finally:
            vc.MACHINE_ID = old_machine_id
            vc.processed_orders.clear()
            vc.orders_in_progress.clear()
            vc.pending_outcome_writes.clear()

    def test_area3_firestore_outcome_write_failure_never_redispenses_and_recovers(self):
        old_machine_id = vc.MACHINE_ID
        vc.MACHINE_ID = "CFX-MC-01"
        vc.processed_orders.clear()
        vc.orders_in_progress.clear()
        vc.pending_outcome_writes.clear()

        class _Tx:
            def __init__(self, lock):
                self._lock = lock

            def set(self, doc_ref, updates, merge=False):
                doc_ref.set(updates, merge=merge)

            def run(self, fn):
                with self._lock:
                    return fn(self)

        class _Client:
            def __init__(self):
                self._lock = threading.Lock()

            def transaction(self):
                return _Tx(self._lock)

        class _FlakyDocRef:
            def __init__(self, doc_id, initial_data, client):
                self.id = doc_id
                self._client = client
                self.data = dict(initial_data)
                self.writes = []
                self.fail_post_claim_writes = False

            def get(self, transaction=None):
                return SimpleNamespace(
                    exists=True,
                    id=self.id,
                    to_dict=lambda: dict(self.data),
                )

            def set(self, updates, merge=False):
                if self.fail_post_claim_writes and updates.get("dispense_status") == "DISPENSED":
                    raise ConnectionError("Firestore network unreachable during DISPENSED write")
                self.writes.append(dict(updates))
                if merge:
                    self.data.update(updates)
                else:
                    self.data = dict(updates)

        try:
            client = _Client()
            doc_flaky = _FlakyDocRef(
                "CFX-OUTCOME-NETFAIL",
                {
                    "id": "CFX-OUTCOME-NETFAIL",
                    "machine_id": "CFX-MC-01",
                    "status": "PAID",
                    "dispense_status": "QUEUED",
                    "product_name": "Mocha Bliss",
                    "base": "milk",
                    "extra_sugar": 1,
                    "amount": 1,
                },
                client=client,
            )
            doc_flaky.fail_post_claim_writes = True

            change_evt = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(
                    id="CFX-OUTCOME-NETFAIL",
                    reference=doc_flaky,
                    to_dict=lambda: dict(doc_flaky.data),
                ),
            )

            arduino_calls = []
            with mock.patch.object(vc, "send_to_arduino", side_effect=lambda cmd, **kw: (arduino_calls.append(cmd) or True)):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    vc.process_firestore_change(change_evt)
                    # Replay ADDED and MODIFIED events while Firestore still shows DISPENSING
                    vc.on_snapshot(None, [change_evt], None)

            self.assertEqual(arduino_calls, ["MOCHA,MILK,1"], "Arduino must NEVER be called a second time when DISPENSED write fails")
            self.assertIn("CFX-OUTCOME-NETFAIL", vc.processed_orders)
            self.assertEqual(doc_flaky.data["dispense_status"], "DISPENSING")
            self.assertIn("CFX-OUTCOME-NETFAIL", vc.pending_outcome_writes)

            # Now restore Firestore connectivity and verify automatic flush recovery without touching Arduino
            doc_flaky.fail_post_claim_writes = False
            buf2 = io.StringIO()
            with redirect_stdout(buf2):
                vc.on_snapshot(None, [], None)

            self.assertEqual(len(arduino_calls), 1)
            self.assertNotIn("CFX-OUTCOME-NETFAIL", vc.pending_outcome_writes)
            self.assertEqual(doc_flaky.data["dispense_status"], "DISPENSED")
            self.assertTrue(doc_flaky.data["dispensed"])
        finally:
            vc.MACHINE_ID = old_machine_id
            vc.processed_orders.clear()
            vc.orders_in_progress.clear()
            vc.pending_outcome_writes.clear()

    def test_area4_pre_dispense_vs_during_dispense_failure_classification(self):
        old_machine_id = vc.MACHINE_ID
        old_arduino = vc.arduino
        vc.MACHINE_ID = "CFX-MC-01"
        vc.processed_orders.clear()
        vc.orders_in_progress.clear()
        vc.pending_outcome_writes.clear()

        class _Tx:
            def __init__(self, lock):
                self._lock = lock

            def set(self, doc_ref, updates, merge=False):
                doc_ref.set(updates, merge=merge)

            def run(self, fn):
                with self._lock:
                    return fn(self)

        class _Client:
            def __init__(self):
                self._lock = threading.Lock()

            def transaction(self):
                return _Tx(self._lock)

        class _DocRef:
            def __init__(self, doc_id, client):
                self.id = doc_id
                self._client = client
                self.data = {
                    "id": doc_id,
                    "machine_id": "CFX-MC-01",
                    "status": "PAID",
                    "dispense_status": "QUEUED",
                    "product_name": "Classic Crest",
                    "base": "water",
                    "extra_sugar": 1,
                    "amount": 1,
                    "captured_amount_paise": 100,
                    "razorpay_payment_id": f"pay_{doc_id}",
                    "refund_status": "NONE",
                    "total_refunded_amount_paise": 0,
                    "pending_refund_amount_paise": 0,
                }
                self.writes = []

            def get(self, transaction=None):
                return SimpleNamespace(
                    exists=True,
                    id=self.id,
                    to_dict=lambda: dict(self.data),
                )

            def set(self, updates, merge=False):
                self.writes.append(dict(updates))
                if merge:
                    self.data.update(updates)
                else:
                    self.data = dict(updates)

        def _is_eligible_for_auto_refund(order_doc):
            """
            Mirrors backend evaluateAutoRefundEligibility() for FAILED/DISPENSED orders:
            Only demonstrably zero-byte transmission (FAILED + NOT_DISPENSED + PRE_DISPENSE
            with dispense_started_at == None and claimed_at == None) is eligible.
            """
            if order_doc.get("dispensed") is True or order_doc.get("dispense_status") == "DISPENSED":
                return False
            if order_doc.get("dispense_outcome") == "UNCERTAIN" or order_doc.get("failure_stage") == "DURING_DISPENSE":
                return False
            if order_doc.get("dispense_started_at") is not None or order_doc.get("claimed_at") is not None:
                return False
            return (
                order_doc.get("dispense_status") == "FAILED"
                and order_doc.get("dispense_outcome") == "NOT_DISPENSED"
                and order_doc.get("failure_stage") == "PRE_DISPENSE"
            )

        try:
            client = _Client()
            expected_cmd_len = len(b"CLASSIC,WATER,1\n")  # 16 bytes

            # 1. Arduino disconnected before any write attempt -> PRE_DISPENSE / NOT_DISPENSED (Auto-Refund ELIGIBLE)
            vc.arduino = None
            doc1 = _DocRef("CFX-A4-DISC-BEFORE", client)
            evt1 = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(id=doc1.id, reference=doc1, to_dict=lambda: dict(doc1.data)),
            )
            with redirect_stdout(io.StringIO()):
                vc.process_firestore_change(evt1)
            self.assertEqual(doc1.data["dispense_status"], "FAILED")
            self.assertFalse(doc1.data["dispensed"])
            self.assertEqual(doc1.data["dispense_outcome"], "NOT_DISPENSED")
            self.assertEqual(doc1.data["failure_stage"], "PRE_DISPENSE")
            self.assertEqual(doc1.data["failure_reason"], "ARDUINO_DISCONNECTED_BEFORE_COMMAND")
            self.assertIsNone(doc1.data["dispense_started_at"])
            self.assertIsNone(doc1.data["claimed_at"])
            self.assertTrue(_is_eligible_for_auto_refund(doc1.data))

            # 2. Zero-byte write (serial write returns 0 cleanly without exception) -> PRE_DISPENSE / NOT_DISPENSED (Auto-Refund ELIGIBLE)
            fake_serial_zero = mock.MagicMock()
            fake_serial_zero.is_open = True
            fake_serial_zero.out_waiting = 0
            fake_serial_zero.write.return_value = 0
            vc.arduino = fake_serial_zero
            doc2 = _DocRef("CFX-A4-ZERO-WRITE", client)
            evt2 = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(id=doc2.id, reference=doc2, to_dict=lambda: dict(doc2.data)),
            )
            with redirect_stdout(io.StringIO()):
                vc.process_firestore_change(evt2)
            self.assertEqual(doc2.data["dispense_status"], "FAILED")
            self.assertFalse(doc2.data["dispensed"])
            self.assertEqual(doc2.data["dispense_outcome"], "NOT_DISPENSED")
            self.assertEqual(doc2.data["failure_stage"], "PRE_DISPENSE")
            self.assertEqual(doc2.data["failure_reason"], "SERIAL_WRITE_ZERO_BYTES")
            self.assertIsNone(doc2.data["dispense_started_at"])
            self.assertIsNone(doc2.data["claimed_at"])
            self.assertTrue(_is_eligible_for_auto_refund(doc2.data))

            # 3. Partial-byte write (0 < written < expected_bytes) -> DURING_DISPENSE / UNCERTAIN (Auto-Refund BLOCKED)
            fake_serial_partial = mock.MagicMock()
            fake_serial_partial.is_open = True
            fake_serial_partial.out_waiting = 0
            fake_serial_partial.write.return_value = 5  # Partial: 5 of 16 bytes
            vc.arduino = fake_serial_partial
            doc3 = _DocRef("CFX-A4-PARTIAL-WRITE", client)
            evt3 = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(id=doc3.id, reference=doc3, to_dict=lambda: dict(doc3.data)),
            )
            with redirect_stdout(io.StringIO()):
                vc.process_firestore_change(evt3)
            self.assertEqual(doc3.data["dispense_status"], "FAILED")
            self.assertFalse(doc3.data["dispensed"])
            self.assertEqual(doc3.data["dispense_outcome"], "UNCERTAIN")
            self.assertEqual(doc3.data["failure_stage"], "DURING_DISPENSE")
            self.assertEqual(doc3.data["failure_reason"], "SERIAL_PARTIAL_WRITE_UNCERTAIN")
            self.assertIsNotNone(doc3.data["dispense_started_at"])
            self.assertFalse(_is_eligible_for_auto_refund(doc3.data))

            # 4. SerialTimeoutException during write -> DURING_DISPENSE / UNCERTAIN (Auto-Refund BLOCKED)
            serial_timeout_cls = getattr(vc.serial, "SerialTimeoutException", TimeoutError)
            fake_serial_write_timeout = mock.MagicMock()
            fake_serial_write_timeout.is_open = True
            fake_serial_write_timeout.write.side_effect = serial_timeout_cls("Write timeout expired")
            vc.arduino = fake_serial_write_timeout
            doc4 = _DocRef("CFX-A4-WRITE-TIMEOUT", client)
            evt4 = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(id=doc4.id, reference=doc4, to_dict=lambda: dict(doc4.data)),
            )
            with redirect_stdout(io.StringIO()):
                vc.process_firestore_change(evt4)
            self.assertEqual(doc4.data["dispense_status"], "FAILED")
            self.assertFalse(doc4.data["dispensed"])
            self.assertEqual(doc4.data["dispense_outcome"], "UNCERTAIN")
            self.assertEqual(doc4.data["failure_stage"], "DURING_DISPENSE")
            self.assertEqual(doc4.data["failure_reason"], "SERIAL_WRITE_TIMEOUT_UNCERTAIN")
            self.assertIsNotNone(doc4.data["dispense_started_at"])
            self.assertFalse(_is_eligible_for_auto_refund(doc4.data))

            # 5. Exception after partial transmission -> DURING_DISPENSE / UNCERTAIN (Auto-Refund BLOCKED)
            transmitted_wire_bytes = bytearray()

            def _partial_tx_then_raise(payload):
                transmitted_wire_bytes.extend(payload[:7])
                raise OSError("USB serial disconnected mid-write after 7 bytes")

            fake_serial_partial_exc = mock.MagicMock()
            fake_serial_partial_exc.is_open = True
            fake_serial_partial_exc.write.side_effect = _partial_tx_then_raise
            vc.arduino = fake_serial_partial_exc
            doc5 = _DocRef("CFX-A4-PARTIAL-EXC", client)
            evt5 = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(id=doc5.id, reference=doc5, to_dict=lambda: dict(doc5.data)),
            )
            with redirect_stdout(io.StringIO()):
                vc.process_firestore_change(evt5)
            self.assertEqual(bytes(transmitted_wire_bytes), b"CLASSIC")
            self.assertEqual(doc5.data["dispense_status"], "FAILED")
            self.assertFalse(doc5.data["dispensed"])
            self.assertEqual(doc5.data["dispense_outcome"], "UNCERTAIN")
            self.assertEqual(doc5.data["failure_stage"], "DURING_DISPENSE")
            self.assertEqual(doc5.data["failure_reason"], "SERIAL_WRITE_EXCEPTION_UNCERTAIN")
            self.assertIsNotNone(doc5.data["dispense_started_at"])
            self.assertFalse(_is_eligible_for_auto_refund(doc5.data))

            # 6. Full command transmission followed by missing DONE (timeout) -> DURING_DISPENSE / UNCERTAIN (Auto-Refund BLOCKED)
            fake_serial_timeout = mock.MagicMock()
            fake_serial_timeout.is_open = True
            fake_serial_timeout.out_waiting = 0
            fake_serial_timeout.write.return_value = expected_cmd_len
            vc.arduino = fake_serial_timeout
            doc6 = _DocRef("CFX-A4-TIMEOUT-AFTER", client)
            evt6 = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(id=doc6.id, reference=doc6, to_dict=lambda: dict(doc6.data)),
            )
            with mock.patch.object(vc, "wait_for_message", return_value=None), \
                 redirect_stdout(io.StringIO()):
                vc.process_firestore_change(evt6)
            self.assertEqual(doc6.data["dispense_status"], "FAILED")
            self.assertFalse(doc6.data["dispensed"])
            self.assertEqual(doc6.data["dispense_outcome"], "UNCERTAIN")
            self.assertEqual(doc6.data["failure_stage"], "DURING_DISPENSE")
            self.assertEqual(doc6.data["failure_reason"], "ARDUINO_RESPONSE_TIMEOUT_AFTER_COMMAND")
            self.assertIsNotNone(doc6.data["dispense_started_at"])
            self.assertFalse(_is_eligible_for_auto_refund(doc6.data))

            # 7. Full command transmission followed by disconnect during wait -> DURING_DISPENSE / UNCERTAIN (Auto-Refund BLOCKED)
            fake_serial_disc_after = mock.MagicMock()
            fake_serial_disc_after.is_open = True
            fake_serial_disc_after.out_waiting = 0
            fake_serial_disc_after.write.return_value = expected_cmd_len

            def _disconnect_during_wait(*_a, **_kw):
                fake_serial_disc_after.is_open = False
                return None

            vc.arduino = fake_serial_disc_after
            doc7 = _DocRef("CFX-A4-DISC-AFTER", client)
            evt7 = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(id=doc7.id, reference=doc7, to_dict=lambda: dict(doc7.data)),
            )
            with mock.patch.object(vc, "wait_for_message", side_effect=_disconnect_during_wait), \
                 redirect_stdout(io.StringIO()):
                vc.process_firestore_change(evt7)
            self.assertEqual(doc7.data["dispense_status"], "FAILED")
            self.assertFalse(doc7.data["dispensed"])
            self.assertEqual(doc7.data["dispense_outcome"], "UNCERTAIN")
            self.assertEqual(doc7.data["failure_stage"], "DURING_DISPENSE")
            self.assertEqual(doc7.data["failure_reason"], "ARDUINO_DISCONNECTED_AFTER_COMMAND_TRANSMISSION")
            self.assertIsNotNone(doc7.data["dispense_started_at"])
            self.assertFalse(_is_eligible_for_auto_refund(doc7.data))

            # 8. Successful DONE response -> DISPENSED (Auto-Refund BLOCKED)
            fake_serial_done = mock.MagicMock()
            fake_serial_done.is_open = True
            fake_serial_done.out_waiting = 0
            fake_serial_done.write.return_value = expected_cmd_len
            vc.arduino = fake_serial_done
            doc8 = _DocRef("CFX-A4-DONE", client)
            evt8 = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(id=doc8.id, reference=doc8, to_dict=lambda: dict(doc8.data)),
            )
            with mock.patch.object(vc, "wait_for_message", return_value="DONE"), \
                 redirect_stdout(io.StringIO()):
                vc.process_firestore_change(evt8)
            self.assertEqual(doc8.data["dispense_status"], "DISPENSED")
            self.assertTrue(doc8.data["dispensed"])
            self.assertEqual(doc8.data["dispense_outcome"], "DISPENSED")
            self.assertIsNotNone(doc8.data["dispensed_at"])
            self.assertFalse(_is_eligible_for_auto_refund(doc8.data))
        finally:
            vc.arduino = old_arduino
            vc.MACHINE_ID = old_machine_id
            vc.processed_orders.clear()
            vc.orders_in_progress.clear()
            vc.pending_outcome_writes.clear()


if __name__ == "__main__":
    unittest.main(verbosity=2)

