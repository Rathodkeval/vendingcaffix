import io
import json
import os
import subprocess
import sys
import tempfile
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
        self._temp_dir = tempfile.TemporaryDirectory()
        self._old_lockout_env = os.environ.get("CAFFIX_DISPENSE_LOCKOUT_FILE")
        self._old_state_dir_env = os.environ.get("CAFFIX_STATE_DIR")
        os.environ["CAFFIX_STATE_DIR"] = self._temp_dir.name
        os.environ["CAFFIX_DISPENSE_LOCKOUT_FILE"] = os.path.join(
            self._temp_dir.name, "dispense_lockout.json"
        )
        vc.clear_dispense_lockout(confirm_machine_safe=True, operator="test-setup")
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
        try:
            vc.clear_dispense_lockout(confirm_machine_safe=True, operator="test-teardown")
        except Exception:
            pass
        if self._old_lockout_env is None:
            os.environ.pop("CAFFIX_DISPENSE_LOCKOUT_FILE", None)
        else:
            os.environ["CAFFIX_DISPENSE_LOCKOUT_FILE"] = self._old_lockout_env
        if self._old_state_dir_env is None:
            os.environ.pop("CAFFIX_STATE_DIR", None)
        else:
            os.environ["CAFFIX_STATE_DIR"] = self._old_state_dir_env
        self._temp_dir.cleanup()
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
        old_arduino = vc.arduino
        old_responsive = vc._arduino_responsive
        fake_ser = mock.MagicMock()
        fake_ser.is_open = True
        fake_ser.readline.return_value = b"CAFFIX_ARDUINO\n"
        vc.arduino = fake_ser
        vc._arduino_responsive = True
        self.state.fail_http_503 = True
        buf = io.StringIO()
        try:
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
        finally:
            vc.stop_heartbeat_thread()
            vc.arduino = old_arduino
            vc._arduino_responsive = old_responsive

    def test_network_error_does_not_crash_heartbeat_loop(self):
        old_arduino = vc.arduino
        old_responsive = vc._arduino_responsive
        fake_ser = mock.MagicMock()
        fake_ser.is_open = True
        fake_ser.readline.return_value = b"CAFFIX_ARDUINO\n"
        vc.arduino = fake_ser
        vc._arduino_responsive = True
        stop_evt = threading.Event()
        try:
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
        finally:
            vc.arduino = old_arduino
            vc._arduino_responsive = old_responsive

    def test_main_requires_responsive_arduino_before_heartbeat_and_suppresses_when_unresponsive(self):
        old_machine = vc.MACHINE_ID
        old_token = vc.CAFFIX_KIOSK_TOKEN
        old_base = vc.CAFFIX_API_BASE
        old_interval = vc.HEARTBEAT_INTERVAL_SECONDS
        old_arduino = vc.arduino
        old_responsive = vc._arduino_responsive
        vc.MACHINE_ID = "CFX-MC-01"
        vc.CAFFIX_KIOSK_TOKEN = "kiosk-secret-mc01-test"
        vc.CAFFIX_API_BASE = self.api_base
        vc.HEARTBEAT_INTERVAL_SECONDS = 0.05
        vc.arduino = None
        vc._arduino_responsive = False
        vc.arduino_reconnect_event.clear()

        observations = {}

        def _blocking_connect_arduino():
            observations["thread_alive_during_connect"] = (
                vc.heartbeat_thread is not None and vc.heartbeat_thread.is_alive()
            )
            time.sleep(0.15)
            observations["heartbeats_while_waiting_for_arduino"] = self.state.heartbeat_calls
            raise KeyboardInterrupt()

        fake_client = mock.MagicMock()
        try:
            # 1. Machine must NOT start heartbeat or report ONLINE while waiting for connect_arduino()
            with mock.patch.object(vc, "ensure_firestore_client", return_value=fake_client), \
                 mock.patch.object(vc, "connect_arduino", side_effect=_blocking_connect_arduino):
                with redirect_stdout(io.StringIO()):
                    vc.main()

            self.assertFalse(
                observations.get("thread_alive_during_connect"),
                "Heartbeat thread must NOT start before connect_arduino() connects",
            )
            self.assertEqual(
                observations.get("heartbeats_while_waiting_for_arduino"),
                0,
                "Zero heartbeats allowed when Arduino is not connected",
            )

            # 2. Connected & responsive Arduino -> sends ONLINE heartbeats; loses PING response -> suppresses ONLINE heartbeats
            ping_state = {"responsive": True}
            fake_ser = mock.MagicMock()
            fake_ser.is_open = True
            fake_ser.readline.side_effect = (
                lambda: b"CAFFIX_ARDUINO\n" if ping_state["responsive"] else b""
            )
            vc.arduino = fake_ser
            vc._arduino_responsive = True

            buf = io.StringIO()
            with redirect_stdout(buf):
                t = vc.start_heartbeat_thread(
                    machine_id="CFX-MC-01",
                    kiosk_token="kiosk-secret-mc01-test",
                    api_base=self.api_base,
                    interval_seconds=0.05,
                    timeout=2.0,
                    require_arduino=True,
                )
                self.assertIsNotNone(t)
                time.sleep(0.18)
                calls_while_responsive = self.state.heartbeat_calls
                self.assertGreaterEqual(calls_while_responsive, 1)

                # Simulate Arduino becoming unresponsive to PING (without touching USB physically)
                ping_state["responsive"] = False
                with mock.patch.object(vc, "ARDUINO_PING_TIMEOUT_SECONDS", 0.05):
                    time.sleep(0.22)
                calls_after_unresponsive = self.state.heartbeat_calls
                vc.stop_heartbeat_thread(timeout=2.0)

            self.assertLessEqual(
                calls_after_unresponsive - calls_while_responsive,
                1,
                "Heartbeat loop must stop sending ONLINE heartbeats once PING fails",
            )
            self.assertIn("suppressing ONLINE heartbeat until Arduino is ready", buf.getvalue())
            self.assertTrue(vc.arduino_reconnect_event.is_set())
        finally:
            vc.stop_heartbeat_thread()
            vc.arduino_reconnect_event.clear()
            vc.arduino = old_arduino
            vc._arduino_responsive = old_responsive
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
            self.assertTrue(vc.is_dispense_locked_out())
            vc.clear_dispense_lockout(confirm_machine_safe=True)

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
            self.assertTrue(vc.is_dispense_locked_out())
            vc.clear_dispense_lockout(confirm_machine_safe=True)

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
            self.assertTrue(vc.is_dispense_locked_out())
            vc.clear_dispense_lockout(confirm_machine_safe=True)

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
            self.assertTrue(vc.is_dispense_locked_out())
            vc.clear_dispense_lockout(confirm_machine_safe=True)

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
            self.assertTrue(vc.is_dispense_locked_out())
            vc.clear_dispense_lockout(confirm_machine_safe=True)

            # 8. Successful DONE response -> DISPENSED (Auto-Refund BLOCKED, no lockout)
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
            self.assertFalse(vc.is_dispense_locked_out())
        finally:
            vc.arduino = old_arduino
            vc.MACHINE_ID = old_machine_id
            vc.processed_orders.clear()
            vc.orders_in_progress.clear()
            vc.pending_outcome_writes.clear()

    def test_serial_rx_buffer_cleared_before_dispense_command(self):
        old_arduino = vc.arduino
        old_responsive = vc._arduino_responsive

        class _BufferedSerial:
            def __init__(self):
                self.is_open = True
                self.out_waiting = 0
                self.rx_queue = [b"DONE\n"]  # Stale leftover DONE sitting in RX buffer!
                self.events = []

            def reset_input_buffer(self):
                self.events.append("reset_input_buffer")
                self.rx_queue.clear()

            def write(self, payload):
                self.events.append(("write", payload.decode("ascii")))
                return len(payload)

            def flush(self):
                self.events.append("flush")

            def readline(self):
                if self.rx_queue:
                    return self.rx_queue.pop(0)
                time.sleep(0.01)
                return b""

            def close(self):
                self.is_open = False

        try:
            ser = _BufferedSerial()
            vc.arduino = ser
            vc._arduino_responsive = True

            with redirect_stdout(io.StringIO()):
                res = vc.execute_arduino_dispense_for_order("CLASSIC,WATER,1", timeout=0.08)

            self.assertEqual(ser.events[0], "reset_input_buffer")
            self.assertEqual(ser.events[1], ("write", "CLASSIC,WATER,1\n"))
            self.assertFalse(res["success"], "Stale DONE in RX buffer must be flushed before write and never count as success")
            self.assertEqual(res["failure_stage"], "DURING_DISPENSE")
            self.assertEqual(res["failure_reason"], "ARDUINO_RESPONSE_TIMEOUT_AFTER_COMMAND")
        finally:
            vc.arduino = old_arduino
            vc._arduino_responsive = old_responsive

    def test_immediate_arduino_error_responses_no_cup_and_error(self):
        old_arduino = vc.arduino
        old_responsive = vc._arduino_responsive
        try:
            for err_line, expected_reason in (
                (b"NO_CUP\n", "ARDUINO_ERROR_NO_CUP"),
                (b"ERROR\n", "ARDUINO_ERROR_ERROR"),
                (b"ERROR:VALVE_JAM\n", "ARDUINO_ERROR_ERROR_VALVE_JAM"),
            ):
                fake_ser = mock.MagicMock()
                fake_ser.is_open = True
                fake_ser.out_waiting = 0
                fake_ser.write.return_value = len(b"HAZELNUT,MILK,1\n")
                fake_ser.readline.side_effect = [err_line]
                vc.arduino = fake_ser
                vc._arduino_responsive = True

                t0 = time.monotonic()
                with redirect_stdout(io.StringIO()):
                    res = vc.execute_arduino_dispense_for_order("HAZELNUT,MILK,1", timeout=30.0)
                elapsed = time.monotonic() - t0

                self.assertLess(elapsed, 0.5, f"{err_line!r} must return immediately without 30s/180s wait")
                self.assertFalse(res["success"])
                self.assertEqual(res["failure_stage"], "DURING_DISPENSE")
                self.assertEqual(res["failure_reason"], expected_reason)
                self.assertTrue(vc.is_dispense_locked_out())
                fake_ser.reset_input_buffer.assert_called_once()
                vc.clear_dispense_lockout(confirm_machine_safe=True)
        finally:
            vc.arduino = old_arduino
            vc._arduino_responsive = old_responsive

    def test_automatic_serial_reconnection_after_disconnect_write_flush_and_read_errors(self):
        old_machine_id = vc.MACHINE_ID
        old_arduino = vc.arduino
        old_responsive = vc._arduino_responsive
        vc.MACHINE_ID = "CFX-MC-01"
        vc.processed_orders.clear()
        vc.orders_in_progress.clear()
        vc.pending_outcome_writes.clear()
        vc.arduino_reconnect_event.clear()

        recovered_instances = []
        lock_states_during_handshake = []

        def _fake_serial_factory(port, baudrate, timeout, write_timeout):
            lock_states_during_handshake.append(("Serial.__init__", vc.arduino_lock.locked()))
            s = mock.MagicMock()
            s.port = port
            s.baudrate = baudrate
            s.is_open = True
            s.out_waiting = 0
            s.readline.side_effect = [b"CAFFIX_ARDUINO\n", b"DONE\n"]

            def _write_check_lock(payload):
                if payload == b"PING\n":
                    lock_states_during_handshake.append(("PING.write", vc.arduino_lock.locked()))
                return len(payload)

            s.write.side_effect = _write_check_lock
            recovered_instances.append(s)
            return s

        fake_port = SimpleNamespace(device="/dev/ttyACM0", description="Arduino GIGA R1")

        try:
            failure_modes = ["disconnected", "write_error", "flush_error", "read_error"]
            for mode in failure_modes:
                vc.arduino_reconnect_event.clear()

                if mode == "disconnected":
                    vc.arduino = None
                    vc._arduino_responsive = False
                    with redirect_stdout(io.StringIO()):
                        res_fail = vc.execute_arduino_dispense_for_order("CLASSIC,WATER,1", timeout=0.5)
                    self.assertEqual(res_fail["failure_stage"], "PRE_DISPENSE")
                    self.assertFalse(vc.is_dispense_locked_out())
                else:
                    bad_ser = mock.MagicMock()
                    bad_ser.is_open = True
                    bad_ser.out_waiting = 0
                    if mode == "write_error":
                        bad_ser.write.side_effect = OSError("USB cable pulled mid-write")
                    elif mode == "flush_error":
                        bad_ser.write.return_value = len(b"CLASSIC,WATER,1\n")
                        bad_ser.flush.side_effect = OSError("USB flush failure")
                    elif mode == "read_error":
                        bad_ser.write.return_value = len(b"CLASSIC,WATER,1\n")
                        bad_ser.readline.side_effect = OSError("USB read I/O error")
                    vc.arduino = bad_ser
                    vc._arduino_responsive = True

                    with redirect_stdout(io.StringIO()):
                        res_fail = vc.execute_arduino_dispense_for_order("CLASSIC,WATER,1", timeout=0.5)
                    self.assertEqual(res_fail["failure_stage"], "DURING_DISPENSE")
                    self.assertTrue(vc.is_dispense_locked_out(), f"{mode}: uncertain failure must latch lockout")

                # Must have closed serial, cleared responsive flag, and scheduled reconnect
                self.assertIsNone(vc.arduino, f"{mode}: dead serial handle must be cleared")
                self.assertFalse(vc._arduino_responsive, f"{mode}: responsive flag must be cleared")
                self.assertTrue(vc.arduino_reconnect_event.is_set(), f"{mode}: reconnect must be scheduled")

                # Reconcile reconnects cleanly to newly enumerated /dev/ttyACM0 Arduino without deadlocking
                with mock.patch.object(vc.serial.tools.list_ports, "comports", return_value=[fake_port]), \
                     mock.patch.object(vc.serial, "Serial", side_effect=_fake_serial_factory), \
                     mock.patch.object(vc.time, "sleep"), \
                     redirect_stdout(io.StringIO()):
                    reconnected = vc.reconcile_arduino_connection_once()

                self.assertIsNotNone(reconnected, f"{mode}: automatic reconnect must restore Arduino handle")
                self.assertTrue(vc._arduino_responsive)
                self.assertFalse(vc.arduino_reconnect_event.is_set())

                if mode != "disconnected":
                    # Reconnecting USB / passing PING must NEVER auto-clear a latched fault
                    self.assertTrue(vc.is_dispense_locked_out())
                    vc.clear_dispense_lockout(confirm_machine_safe=True, operator="test")

                # Subsequent order now dispenses and receives DONE cleanly!
                with redirect_stdout(io.StringIO()):
                    res_ok = vc.execute_arduino_dispense_for_order("CLASSIC,WATER,1", timeout=0.5)
                self.assertTrue(res_ok["success"], f"{mode}: subsequent dispense after reconnect must succeed")

            self.assertTrue(lock_states_during_handshake)
            for stage, is_locked in lock_states_during_handshake:
                self.assertFalse(is_locked, f"arduino_lock must be released before {stage}")
        finally:
            vc.arduino = old_arduino
            vc._arduino_responsive = old_responsive
            vc.arduino_reconnect_event.clear()
            vc.MACHINE_ID = old_machine_id
            vc.processed_orders.clear()
            vc.orders_in_progress.clear()
            vc.pending_outcome_writes.clear()

    def test_reconcile_arduino_connection_no_deadlock_and_preserves_machine_lock(self):
        old_arduino = vc.arduino
        old_responsive = vc._arduino_responsive
        vc.arduino_reconnect_event.set()
        handshake_lock_observations = []

        def _fake_serial_factory(port, baudrate, timeout, write_timeout):
            handshake_lock_observations.append(("serial_open", vc.arduino_lock.locked()))
            s = mock.MagicMock()
            s.port = port
            s.baudrate = baudrate
            s.is_open = True
            s.out_waiting = 0
            s.readline.side_effect = [b"CAFFIX_ARDUINO\n"]

            def _ping_write(payload):
                handshake_lock_observations.append(("ping_write", vc.arduino_lock.locked()))
                return len(payload)

            s.write.side_effect = _ping_write
            return s

        stale_ser = mock.MagicMock()
        stale_ser.is_open = True
        vc.arduino = stale_ser
        vc._arduino_responsive = False
        fake_port = SimpleNamespace(device="/dev/ttyACM0", description="Arduino GIGA R1")

        try:
            # 1. While machine_lock is held by an active dispense, reconcile returns immediately without interrupting serial
            with vc.machine_lock:
                res_busy = vc.reconcile_arduino_connection_once()
            self.assertIs(res_busy, stale_ser)
            stale_ser.close.assert_not_called()

            # 2. Run reconcile_arduino_connection_once on a separate thread with strict timeout to prove no deadlock
            result_holder = []
            with mock.patch.object(vc.serial.tools.list_ports, "comports", return_value=[fake_port]), \
                 mock.patch.object(vc.serial, "Serial", side_effect=_fake_serial_factory), \
                 mock.patch.object(vc.time, "sleep"), \
                 redirect_stdout(io.StringIO()):
                worker = threading.Thread(
                    target=lambda: result_holder.append(vc.reconcile_arduino_connection_once()),
                    daemon=True,
                )
                worker.start()
                worker.join(timeout=2.0)

            self.assertFalse(worker.is_alive(), "reconcile_arduino_connection_once deadlocked")
            self.assertEqual(len(result_holder), 1)
            self.assertIsNotNone(result_holder[0])
            stale_ser.close.assert_called_once()
            self.assertFalse(vc.arduino_lock.locked())
            self.assertEqual(
                handshake_lock_observations,
                [("serial_open", False), ("ping_write", False)],
            )

            # 3. Also verify send_to_arduino -> send_raw_command -> ensure_connection reconnects without deadlocking arduino_lock
            vc.arduino = None
            vc._arduino_responsive = False
            send_result = []
            with mock.patch.object(vc.serial.tools.list_ports, "comports", return_value=[fake_port]), \
                 mock.patch.object(
                     vc.serial,
                     "Serial",
                     side_effect=lambda *a, **kw: SimpleNamespace(
                         is_open=True,
                         out_waiting=0,
                         reset_input_buffer=lambda: None,
                         reset_output_buffer=lambda: None,
                         write=lambda p: len(p),
                         flush=lambda: None,
                         readline=mock.MagicMock(side_effect=[b"CAFFIX_ARDUINO\n", b"DONE\n"]),
                         close=lambda: None,
                     ),
                 ), \
                 mock.patch.object(vc.time, "sleep"), \
                 redirect_stdout(io.StringIO()):
                send_worker = threading.Thread(
                    target=lambda: send_result.append(vc.send_to_arduino("CLASSIC,WATER,1", expected="DONE", timeout=1.0)),
                    daemon=True,
                )
                send_worker.start()
                send_worker.join(timeout=2.0)

            self.assertFalse(send_worker.is_alive(), "send_to_arduino reconnecting deadlocked arduino_lock")
            self.assertEqual(send_result, [True])
        finally:
            vc.arduino = old_arduino
            vc._arduino_responsive = old_responsive
            vc.arduino_reconnect_event.clear()

    def test_machine_lockout_lifecycle_after_uncertain_timeout(self):
        old_machine_id = vc.MACHINE_ID
        old_arduino = vc.arduino
        old_responsive = vc._arduino_responsive
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

        try:
            client = _Client()
            payload_len = len(b"CLASSIC,WATER,1\n")

            # Req 4: Timeout after full command transmission latches machine-level lockout
            ser_timeout = mock.MagicMock()
            ser_timeout.is_open = True
            ser_timeout.out_waiting = 0
            ser_timeout.write.return_value = payload_len
            vc.arduino = ser_timeout
            vc._arduino_responsive = True

            doc_uncertain = _DocRef("CFX-LOCK-TIMEOUT-1", client)
            evt_uncertain = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(id=doc_uncertain.id, reference=doc_uncertain, to_dict=lambda: dict(doc_uncertain.data)),
            )
            with mock.patch.object(vc, "wait_for_message", return_value=None), \
                 redirect_stdout(io.StringIO()):
                vc.process_firestore_change(evt_uncertain)

            self.assertEqual(doc_uncertain.data["dispense_status"], "FAILED")
            self.assertEqual(doc_uncertain.data["dispense_outcome"], "UNCERTAIN")
            self.assertEqual(doc_uncertain.data["failure_stage"], "DURING_DISPENSE")
            self.assertEqual(doc_uncertain.data["failure_reason"], "ARDUINO_RESPONSE_TIMEOUT_AFTER_COMMAND")
            self.assertIn("CFX-LOCK-TIMEOUT-1", vc.processed_orders)
            self.assertTrue(vc.is_dispense_locked_out())
            self.assertTrue(os.path.exists(vc.get_dispense_lockout_file_path()))

            # Req 5: New queued order cannot be claimed or dispensed while locked out
            doc_queued = _DocRef("CFX-LOCK-QUEUED-2", client)
            evt_queued = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(id=doc_queued.id, reference=doc_queued, to_dict=lambda: dict(doc_queued.data)),
            )
            ser_healthy_check = mock.MagicMock()
            ser_healthy_check.is_open = True
            ser_healthy_check.out_waiting = 0
            ser_healthy_check.write.side_effect = lambda p: len(p)
            ser_healthy_check.readline.side_effect = [b"CAFFIX_ARDUINO\n", b"CAFFIX_ARDUINO\n", b"DONE\n"]
            vc.arduino = ser_healthy_check
            vc._arduino_responsive = True

            with redirect_stdout(io.StringIO()):
                vc.process_firestore_change(evt_queued)
                direct_claim = vc.claim_order_in_firestore(
                    doc_queued.id, doc_ref=doc_queued, client=client
                )

            self.assertIsNone(direct_claim)
            self.assertEqual(doc_queued.data["dispense_status"], "QUEUED")
            self.assertEqual(doc_queued.writes, [])
            ser_healthy_check.write.assert_not_called()

            # Req 6: Heartbeat is suppressed during lockout even with responsive Arduino
            stop_evt = threading.Event()
            hb_thread = threading.Thread(
                target=vc.heartbeat_loop,
                kwargs={
                    "stop_event": stop_evt,
                    "machine_id": "CFX-MC-01",
                    "kiosk_token": "kiosk-secret-mc01-test",
                    "api_base": self.api_base,
                    "interval_seconds": 0.05,
                    "require_arduino": True,
                },
                daemon=True,
            )
            with redirect_stdout(io.StringIO()):
                hb_thread.start()
                time.sleep(0.18)
                stop_evt.set()
                hb_thread.join(timeout=2.0)
            self.assertEqual(self.state.heartbeat_calls, 0, "ONLINE heartbeats must be suppressed during lockout")

            # Req 7: Reconnecting USB + passing PING + simulated restart must NOT clear lockout
            vc.arduino = None
            vc._arduino_responsive = False
            fake_port = SimpleNamespace(device="/dev/ttyACM0", description="Arduino GIGA R1")
            with mock.patch.object(vc.serial.tools.list_ports, "comports", return_value=[fake_port]), \
                 mock.patch.object(
                     vc.serial,
                     "Serial",
                     return_value=SimpleNamespace(
                         is_open=True,
                         out_waiting=0,
                         reset_input_buffer=lambda: None,
                         reset_output_buffer=lambda: None,
                         write=lambda p: len(p),
                         flush=lambda: None,
                         readline=mock.MagicMock(side_effect=[b"CAFFIX_ARDUINO\n", b"CAFFIX_ARDUINO\n"]),
                         close=lambda: None,
                     ),
                 ), \
                 mock.patch.object(vc.time, "sleep"), \
                 redirect_stdout(io.StringIO()):
                reconnected = vc.reconcile_arduino_connection_once()
                ready_now = vc.is_arduino_ready(probe_when_idle=True)

            self.assertIsNotNone(reconnected)
            self.assertTrue(ready_now)
            self.assertTrue(vc.is_dispense_locked_out(), "USB reconnect / PING must NOT clear lockout")

            # Simulate controller restart: wipe in-memory cache and confirm disk marker keeps lockout active
            with vc.dispense_lockout_lock:
                vc._dispense_lockout_state = None
                vc._dispense_lockout_disk_checked = False
            self.assertTrue(vc.is_dispense_locked_out())

            # Req 8: Only explicit documented recovery procedure (with --confirm-machine-safe) clears lockout
            with self.assertRaises(ValueError):
                vc.clear_dispense_lockout(confirm_machine_safe=False)
            self.assertTrue(vc.is_dispense_locked_out())

            with redirect_stdout(io.StringIO()):
                rc_no_confirm = vc.run_cli(["--clear-lockout"])
            self.assertNotEqual(rc_no_confirm, 0)
            self.assertTrue(vc.is_dispense_locked_out())

            with redirect_stdout(io.StringIO()):
                rc_confirmed = vc.run_cli([
                    "--clear-lockout",
                    "--confirm-machine-safe",
                    "--operator",
                    "qa-tech",
                    "--notes",
                    "Cup tray cleared and motors idle",
                ])
            self.assertEqual(rc_confirmed, 0)
            self.assertFalse(vc.is_dispense_locked_out())
            self.assertFalse(os.path.exists(vc.get_dispense_lockout_file_path()))

            # Original uncertain order stays FAILED/UNCERTAIN in processed_orders and is never retried
            with redirect_stdout(io.StringIO()):
                vc.process_firestore_change(evt_uncertain)
            self.assertEqual(doc_uncertain.data["dispense_status"], "FAILED")
            self.assertEqual(doc_uncertain.data["dispense_outcome"], "UNCERTAIN")

            # Req 9: Once lockout is cleared, queued order claims and successful DONE records DISPENSED
            ser_done = mock.MagicMock()
            ser_done.is_open = True
            ser_done.out_waiting = 0
            ser_done.write.return_value = payload_len
            ser_done.readline.side_effect = [b"DONE\n"]
            vc.arduino = ser_done
            vc._arduino_responsive = True

            with redirect_stdout(io.StringIO()):
                vc.process_firestore_change(evt_queued)

            self.assertEqual(doc_queued.data["dispense_status"], "DISPENSED")
            self.assertTrue(doc_queued.data["dispensed"])
            self.assertEqual(doc_queued.data["dispense_outcome"], "DISPENSED")
            self.assertIsNotNone(doc_queued.data["dispensed_at"])
            self.assertFalse(vc.is_dispense_locked_out())
        finally:
            vc.arduino = old_arduino
            vc._arduino_responsive = old_responsive
            vc.MACHINE_ID = old_machine_id
            vc.processed_orders.clear()
            vc.orders_in_progress.clear()
            vc.pending_outcome_writes.clear()

    def test_default_state_dir_not_temp_directory(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CAFFIX_STATE_DIR", None)
            os.environ.pop("STATE_DIRECTORY", None)
            os.environ.pop("CAFFIX_DISPENSE_LOCKOUT_FILE", None)

            default_dir = vc.get_dispense_state_dir()
            lockout_file = vc.get_dispense_lockout_file_path()
            temp_root = os.path.abspath(tempfile.gettempdir())
            self.assertFalse(
                os.path.abspath(default_dir).startswith(temp_root),
                f"Default state dir must never be a temporary directory: {default_dir}",
            )
            self.assertNotIn("/tmp", default_dir.replace("\\", "/"))
            self.assertTrue(lockout_file.startswith(default_dir))

            os.environ["STATE_DIRECTORY"] = "/var/lib/caffix"
            self.assertEqual(
                vc.get_dispense_state_dir(),
                os.path.abspath("/var/lib/caffix"),
            )

    def test_lockout_persistence_failure_fails_closed(self):
        old_machine_id = vc.MACHINE_ID
        old_arduino = vc.arduino
        old_responsive = vc._arduino_responsive
        old_token = vc.CAFFIX_KIOSK_TOKEN
        old_base = vc.CAFFIX_API_BASE
        vc.MACHINE_ID = "CFX-MC-01"
        vc.CAFFIX_KIOSK_TOKEN = "kiosk-secret-mc01-test"
        vc.CAFFIX_API_BASE = self.api_base
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

        try:
            os.environ.pop("CAFFIX_DISPENSE_LOCKOUT_FILE", None)
            persistent_state_dir = os.path.join(self._temp_dir.name, "persistent_state")
            os.environ["CAFFIX_STATE_DIR"] = persistent_state_dir
            vc.clear_dispense_lockout(confirm_machine_safe=True, operator="test-init")

            client = _Client()
            payload_len = len(b"CLASSIC,WATER,1\n")

            ser_timeout = mock.MagicMock()
            ser_timeout.is_open = True
            ser_timeout.out_waiting = 0
            ser_timeout.write.return_value = payload_len
            vc.arduino = ser_timeout
            vc._arduino_responsive = True

            doc_uncertain = _DocRef("CFX-PERSIST-FAIL-1", client)
            evt_uncertain = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(
                    id=doc_uncertain.id,
                    reference=doc_uncertain,
                    to_dict=lambda: dict(doc_uncertain.data),
                ),
            )

            # Pre-command WAL writes durably BEFORE serial write; then atomic os.replace fails during latch_dispense_lockout
            original_replace = vc.os.replace
            replace_calls = {"count": 0}

            def _replace_fail_on_lockout(src, dst):
                replace_calls["count"] += 1
                if "dispense_lockout_" in os.path.basename(dst):
                    raise OSError("Read-only file system on lockout replace")
                return original_replace(src, dst)

            with mock.patch.object(vc, "wait_for_message", return_value=None), \
                 mock.patch.object(vc.os, "replace", side_effect=_replace_fail_on_lockout), \
                 redirect_stdout(io.StringIO()):
                with self.assertRaises(vc.LockoutPersistenceError):
                    vc.process_firestore_change(evt_uncertain)

            # Firestore outcome MUST STILL be safely recorded as UNCERTAIN / DURING_DISPENSE (not stuck DISPENSING)
            self.assertEqual(doc_uncertain.data["dispense_status"], "FAILED")
            self.assertEqual(doc_uncertain.data["dispense_outcome"], "UNCERTAIN")
            self.assertEqual(doc_uncertain.data["failure_stage"], "DURING_DISPENSE")
            self.assertIn("CFX-PERSIST-FAIL-1", vc.processed_orders)
            # Pre-command WAL must remain on disk because lockout replace failed
            self.assertTrue(os.path.exists(vc.get_dispense_inflight_file_path()))

            # Controller MUST fail closed immediately
            self.assertTrue(vc.is_dispense_locked_out())
            self.assertTrue(vc.lockout_persistence_failed_event.is_set())
            lock_state = vc.get_dispense_lockout_state()
            self.assertFalse(lock_state.get("persisted"))
            self.assertTrue(lock_state.get("persistence_failed"))

            # Verify lockout persistence failure CANNOT be bypassed across a genuine process restart
            restart_env = dict(os.environ)
            restart_env["CAFFIX_MACHINE_ID"] = "CFX-MC-01"
            restart_env["CAFFIX_STATE_DIR"] = persistent_state_dir
            restart_env.pop("CAFFIX_DISPENSE_LOCKOUT_FILE", None)
            p_restart = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "import vending_controller as vc; "
                    "assert vc.is_dispense_locked_out(), 'Restart after persistence failure MUST stay locked out'; "
                    "print(vc.get_dispense_lockout_state()['failure_reason'])",
                ],
                cwd=os.path.dirname(os.path.abspath(__file__)),
                env=restart_env,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(p_restart.returncode, 0, f"Restart failed open: {p_restart.stderr}")

            # Subsequent queued order MUST NOT be claimed or dispensed
            doc_next = _DocRef("CFX-PERSIST-FAIL-NEXT", client)
            evt_next = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(
                    id=doc_next.id,
                    reference=doc_next,
                    to_dict=lambda: dict(doc_next.data),
                ),
            )
            ser_healthy = mock.MagicMock()
            ser_healthy.is_open = True
            ser_healthy.out_waiting = 0
            ser_healthy.readline.side_effect = [b"CAFFIX_ARDUINO\n", b"DONE\n"]
            vc.arduino = ser_healthy
            vc._arduino_responsive = True

            with redirect_stdout(io.StringIO()):
                vc.process_firestore_change(evt_next)
                claimed_next = vc.claim_order_in_firestore(
                    doc_next.id, doc_ref=doc_next, client=client
                )
                direct_exec = vc.execute_arduino_dispense_for_order("CLASSIC,WATER,1")

            self.assertIsNone(claimed_next)
            self.assertEqual(doc_next.data["dispense_status"], "QUEUED")
            self.assertEqual(direct_exec["failure_stage"], "LOCKED_OUT")
            ser_healthy.write.assert_not_called()

            # Heartbeat MUST remain suppressed while failed closed
            stop_evt = threading.Event()
            with redirect_stdout(io.StringIO()):
                t = threading.Thread(
                    target=vc.heartbeat_loop,
                    kwargs={
                        "stop_event": stop_evt,
                        "machine_id": "CFX-MC-01",
                        "kiosk_token": "kiosk-secret-mc01-test",
                        "api_base": self.api_base,
                        "interval_seconds": 0.05,
                        "require_arduino": True,
                    },
                    daemon=True,
                )
                t.start()
                time.sleep(0.12)
                stop_evt.set()
                t.join(timeout=2.0)
            self.assertEqual(self.state.heartbeat_calls, 0)

            # Also verify file write failure, file fsync failure, and POSIX directory fsync failure all raise LockoutPersistenceError & stay locked out
            for fail_label, patch_ctx in (
                ("write_error", mock.patch.object(vc.os, "fdopen", side_effect=OSError("Disk write error"))),
                ("file_fsync_error", mock.patch.object(vc.os, "fsync", side_effect=OSError("I/O fsync error"))),
                ("dir_fsync_error", mock.patch.object(vc, "_fsync_directory", side_effect=OSError("Dir fsync error"))),
            ):
                vc.clear_dispense_lockout(confirm_machine_safe=True, operator="test-subcase")
                with patch_ctx, redirect_stdout(io.StringIO()):
                    with self.assertRaises(vc.LockoutPersistenceError, msg=fail_label):
                        vc.latch_dispense_lockout(order_id=f"ORD-{fail_label}", command="CLASSIC,WATER,1")
                self.assertTrue(vc.is_dispense_locked_out(), f"{fail_label}: must remain locked out in memory")
                self.assertTrue(vc.lockout_persistence_failed_event.is_set(), f"{fail_label}: must flag persistence failure")

            # Verify POSIX directory fsync itself never swallows os.fsync errors when os.name != 'nt'
            with mock.patch.object(vc.os, "name", "posix"), \
                 mock.patch.object(vc.os, "open", return_value=42), \
                 mock.patch.object(vc.os, "fsync", side_effect=OSError("Directory fsync failed")), \
                 mock.patch.object(vc.os, "close") as mock_dir_close:
                with self.assertRaises(OSError):
                    vc._fsync_directory(persistent_state_dir)
                mock_dir_close.assert_called_once_with(42)

            # Startup verification MUST fail closed if state directory is not writable
            vc.clear_dispense_lockout(confirm_machine_safe=True, operator="test-subcase")
            with mock.patch.object(vc, "verify_dispense_state_dir_writable", side_effect=OSError("Permission denied")), \
                 mock.patch.object(vc, "ensure_firestore_client") as mock_fs, \
                 redirect_stdout(io.StringIO()):
                with self.assertRaises(OSError):
                    vc.main()
            mock_fs.assert_not_called()
        finally:
            vc.clear_dispense_lockout(confirm_machine_safe=True, operator="test-cleanup")
            vc.arduino = old_arduino
            vc._arduino_responsive = old_responsive
            vc.MACHINE_ID = old_machine_id
            vc.CAFFIX_KIOSK_TOKEN = old_token
            vc.CAFFIX_API_BASE = old_base
            vc.processed_orders.clear()
            vc.orders_in_progress.clear()
            vc.pending_outcome_writes.clear()

    def test_lockout_survives_real_process_restart_and_arduino_reconnect(self):
        repo_dir = os.path.dirname(os.path.abspath(__file__))
        persistent_state_dir = os.path.join(self._temp_dir.name, "prod_state_dir")
        os.makedirs(persistent_state_dir, mode=0o750, exist_ok=True)

        child_env = dict(os.environ)
        child_env["CAFFIX_MACHINE_ID"] = "CFX-MC-01"
        child_env["CAFFIX_STATE_DIR"] = persistent_state_dir
        child_env.pop("CAFFIX_DISPENSE_LOCKOUT_FILE", None)

        # Subprocess 1: full command transmission followed by missing DONE -> persists durable lockout file
        proc1_code = (
            "from unittest import mock\n"
            "import vending_controller as vc\n"
            "ser = mock.MagicMock()\n"
            "ser.is_open = True\n"
            "ser.out_waiting = 0\n"
            "ser.write.return_value = len(b'CLASSIC,WATER,1\\n')\n"
            "vc.arduino = ser\n"
            "vc._arduino_responsive = True\n"
            "with mock.patch.object(vc, 'wait_for_message', return_value=None):\n"
            "    res = vc.execute_arduino_dispense_for_order('CLASSIC,WATER,1', timeout=0.05, order_id='ORD-SUB-1')\n"
            "assert res['failure_stage'] == 'DURING_DISPENSE'\n"
            "assert vc.is_dispense_locked_out()\n"
        )
        p1 = subprocess.run(
            [sys.executable, "-c", proc1_code],
            cwd=repo_dir,
            env=child_env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(p1.returncode, 0, f"Subprocess 1 failed: {p1.stderr}")

        expected_lockout_file = os.path.join(
            persistent_state_dir, "dispense_lockout_CFX-MC-01.json"
        )
        self.assertTrue(os.path.exists(expected_lockout_file))

        # Subprocess 2: brand new controller OS process restarts, reconnects Arduino via PING,
        # and verifies lockout STILL survives restart and Arduino reconnection until explicit recovery
        proc2_code = (
            "from types import SimpleNamespace\n"
            "from unittest import mock\n"
            "import threading\n"
            "import vending_controller as vc\n"
            "assert vc.is_dispense_locked_out(), 'Lockout must survive fresh process restart'\n"
            "fake_port = SimpleNamespace(device='/dev/ttyACM0', description='Arduino GIGA R1')\n"
            "fake_ser = SimpleNamespace(\n"
            "    is_open=True, out_waiting=0,\n"
            "    reset_input_buffer=lambda: None, reset_output_buffer=lambda: None,\n"
            "    write=lambda p: len(p), flush=lambda: None,\n"
            "    readline=mock.MagicMock(side_effect=[b'CAFFIX_ARDUINO\\n', b'CAFFIX_ARDUINO\\n']),\n"
            "    close=lambda: None,\n"
            ")\n"
            "with mock.patch.object(vc.serial.tools.list_ports, 'comports', return_value=[fake_port]), \\\n"
            "     mock.patch.object(vc.serial, 'Serial', return_value=fake_ser), \\\n"
            "     mock.patch.object(vc.time, 'sleep'):\n"
            "    reconnected = vc.reconcile_arduino_connection_once()\n"
            "    ready = vc.is_arduino_ready(probe_when_idle=True)\n"
            "assert reconnected is not None and ready is True\n"
            "assert vc.is_dispense_locked_out(), 'Arduino reconnect + PING must NOT clear lockout after restart'\n"
            "assert vc.run_cli(['--lockout-status']) == 2\n"
            "exec_res = vc.execute_arduino_dispense_for_order('CLASSIC,WATER,1', order_id='ORD-SUB-2')\n"
            "assert exec_res['failure_stage'] == 'LOCKED_OUT'\n"
            "assert vc.run_cli(['--clear-lockout', '--confirm-machine-safe', '--operator', 'restart-test']) == 0\n"
            "assert not vc.is_dispense_locked_out()\n"
        )
        p2 = subprocess.run(
            [sys.executable, "-c", proc2_code],
            cwd=repo_dir,
            env=child_env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(p2.returncode, 0, f"Subprocess 2 failed:\nSTDOUT:{p2.stdout}\nSTDERR:{p2.stderr}")
        self.assertFalse(os.path.exists(expected_lockout_file))

    def test_safe_lockout_recovery_blocks_running_controller_and_failed_delete(self):
        old_machine_id = vc.MACHINE_ID
        vc.MACHINE_ID = "CFX-MC-01"
        os.environ.pop("CAFFIX_DISPENSE_LOCKOUT_FILE", None)
        state_dir = os.path.join(self._temp_dir.name, "recovery_guard_state")
        os.environ["CAFFIX_STATE_DIR"] = state_dir
        repo_dir = os.path.dirname(os.path.abspath(__file__))

        try:
            with redirect_stdout(io.StringIO()):
                vc.latch_dispense_lockout(
                    order_id="ORD-REC-GUARD",
                    command="CLASSIC,WATER,1",
                    failure_reason="ARDUINO_RESPONSE_TIMEOUT_AFTER_COMMAND",
                )
            lockout_file = vc.get_dispense_lockout_file_path()
            self.assertTrue(os.path.exists(lockout_file))

            # 1. Cannot clear while machine_lock is held (active dispense)
            with vc.machine_lock:
                with self.assertRaises(RuntimeError):
                    vc.clear_dispense_lockout(confirm_machine_safe=True, operator="tech")
            self.assertTrue(vc.is_dispense_locked_out())

            # 2. Cannot clear while another controller process holds the cross-process runtime lock
            holder_env = dict(os.environ)
            holder_env["CAFFIX_MACHINE_ID"] = "CFX-MC-01"
            holder_env["CAFFIX_STATE_DIR"] = state_dir
            holder = subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    "import time, vending_controller as vc; "
                    "vc.acquire_controller_runtime_lock(); "
                    "print('LOCKED', flush=True); "
                    "time.sleep(10)",
                ],
                cwd=repo_dir,
                env=holder_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                ready_line = holder.stdout.readline().strip()
                self.assertEqual(ready_line, "LOCKED")
                with self.assertRaises(RuntimeError):
                    vc.clear_dispense_lockout(confirm_machine_safe=True, operator="tech")
                self.assertTrue(vc.is_dispense_locked_out())
            finally:
                holder.terminate()
                holder.wait(timeout=5)
                holder.stdout.close()
                holder.stderr.close()

            # 3. Failed lockout-file deletion MUST raise and MUST NEVER leave controller unlocked in memory
            with mock.patch.object(vc.os, "remove", side_effect=PermissionError("Operation not permitted")):
                with self.assertRaises(RuntimeError):
                    vc.clear_dispense_lockout(confirm_machine_safe=True, operator="tech")
            self.assertTrue(vc.is_dispense_locked_out(), "Failed delete must NEVER unlock in memory")
            self.assertTrue(os.path.exists(lockout_file))

            # 4. Once controller is stopped and deletion succeeds, recovery succeeds cleanly
            with redirect_stdout(io.StringIO()):
                vc.clear_dispense_lockout(confirm_machine_safe=True, operator="tech")
            self.assertFalse(vc.is_dispense_locked_out())
            self.assertFalse(os.path.exists(lockout_file))
        finally:
            try:
                vc.clear_dispense_lockout(confirm_machine_safe=True, operator="test-cleanup")
            except Exception:
                pass
            vc.MACHINE_ID = old_machine_id

    def test_arduino_port_identification_excludes_sim7600_and_unknown_ports(self):
        sim7600_ports = [
            SimpleNamespace(
                device="/dev/ttyUSB0",
                description="SimTech, Incorporated SIM7600 Diagnostic",
                manufacturer="SimTech",
                product="SIM7600",
                interface="",
                hwid="USB VID:PID=1E0E:9001",
                vid=0x1E0E,
                pid=0x9001,
            ),
            SimpleNamespace(
                device="/dev/ttyUSB2",
                description="SimTech AT Port",
                manufacturer="Qualcomm",
                product="SIM7600E-H",
                interface="AT",
                hwid="USB VID:PID=1E0E:9001",
                vid=0x1E0E,
                pid=0x9001,
            ),
            SimpleNamespace(
                device="/dev/ttyUSB3",
                description="USB Serial Converter",
                manufacturer="FTDI",
                product="FT232R",
                interface="",
                hwid="USB VID:PID=0403:6001",
                vid=0x0403,
                pid=0x6001,
            ),
            SimpleNamespace(
                device="/dev/ttyAMA0",
                description="ttyAMA0",
                manufacturer="",
                product="",
                interface="",
                hwid="",
                vid=None,
                pid=None,
            ),
            SimpleNamespace(
                device="/dev/ttyACM1",
                description="Arduino GIGA R1 Bootloader",
                manufacturer="Arduino",
                product="GIGA R1 DFU",
                interface="",
                hwid="USB VID:PID=2341:0366",
                vid=0x2341,
                pid=0x0366,
            ),
        ]
        arduino_giga = SimpleNamespace(
            device="/dev/ttyACM0",
            description="GIGA R1 WiFi",
            manufacturer="Arduino",
            product="GIGA R1",
            interface="CDC",
            hwid="USB VID:PID=2341:0266",
            vid=0x2341,
            pid=0x0266,
        )

        old_arduino = vc.arduino
        old_responsive = vc._arduino_responsive
        opened_devices = []

        def _fake_serial(port, baudrate, timeout, write_timeout):
            opened_devices.append(port)
            return SimpleNamespace(
                is_open=True,
                out_waiting=0,
                reset_input_buffer=lambda: None,
                reset_output_buffer=lambda: None,
                write=lambda p: len(p),
                flush=lambda: None,
                readline=mock.MagicMock(side_effect=[b"CAFFIX_ARDUINO\n"]),
                close=lambda: None,
            )

        try:
            # 1. With only SIM7600 + FTDI + ttyAMA0 + DFU present, ZERO ports are opened or sent PING
            with mock.patch.object(vc.serial.tools.list_ports, "comports", return_value=sim7600_ports), \
                 mock.patch.object(vc.serial, "Serial", side_effect=_fake_serial), \
                 mock.patch.object(vc.time, "sleep"), \
                 redirect_stdout(io.StringIO()):
                found_none = vc.try_connect_arduino_once()
            self.assertIsNone(found_none)
            self.assertEqual(opened_devices, [], "SIM7600 / unknown ports must NEVER be opened or probed with PING")

            # 2. When Arduino GIGA R1 (VID 0x2341, PID 0x0266) is also present, ONLY it is opened & probed
            with mock.patch.object(vc.serial.tools.list_ports, "comports", return_value=sim7600_ports + [arduino_giga]), \
                 mock.patch.object(vc.serial, "Serial", side_effect=_fake_serial), \
                 mock.patch.object(vc.time, "sleep"), \
                 redirect_stdout(io.StringIO()):
                found_giga = vc.try_connect_arduino_once()
            self.assertIsNotNone(found_giga)
            self.assertEqual(opened_devices, ["/dev/ttyACM0"])

            # 3. Configured stable path override via CAFFIX_ARDUINO_PORT selects that path directly
            opened_devices.clear()
            stable_by_id = "/dev/serial/by-id/usb-Arduino_GIGA_R1_123456-if00"
            with mock.patch.dict(os.environ, {"CAFFIX_ARDUINO_PORT": stable_by_id}), \
                 mock.patch.object(vc.serial.tools.list_ports, "comports", return_value=sim7600_ports), \
                 mock.patch.object(vc.serial, "Serial", side_effect=_fake_serial), \
                 mock.patch.object(vc.time, "sleep"), \
                 redirect_stdout(io.StringIO()):
                found_by_id = vc.try_connect_arduino_once()
            self.assertIsNotNone(found_by_id)
            self.assertEqual(opened_devices, [stable_by_id])
        finally:
            vc.arduino = old_arduino
            vc._arduino_responsive = old_responsive

    def test_extra_sugar_maps_to_milk_powder_log_without_changing_command(self):
        old_machine_id = vc.MACHINE_ID
        old_arduino = vc.arduino
        old_responsive = vc._arduino_responsive
        vc.MACHINE_ID = "CFX-MC-01"
        vc.processed_orders.clear()
        vc.orders_in_progress.clear()

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
                }

            def get(self, transaction=None):
                return SimpleNamespace(exists=True, id=self.id, to_dict=lambda: dict(self.data))

            def set(self, updates, merge=False):
                if merge:
                    self.data.update(updates)
                else:
                    self.data = dict(updates)

        try:
            client = _Client()
            doc = _DocRef("ORD-LOG-CHECK", client)
            evt = SimpleNamespace(
                type=SimpleNamespace(name="ADDED"),
                document=SimpleNamespace(id=doc.id, reference=doc, to_dict=lambda: dict(doc.data)),
            )
            sent_payloads = []
            ser = mock.MagicMock()
            ser.is_open = True
            ser.out_waiting = 0
            ser.write.side_effect = lambda p: (sent_payloads.append(p.decode("ascii")) or len(p))
            ser.readline.side_effect = [b"DONE\n"]
            vc.arduino = ser
            vc._arduino_responsive = True

            buf = io.StringIO()
            with redirect_stdout(buf):
                vc.process_firestore_change(evt)

            logs = buf.getvalue()
            self.assertEqual(sent_payloads, ["CLASSIC,WATER,1\n"])
            self.assertIn("Milk Powder : 1", logs)
            self.assertIn("(mapped to Arduino 3rd parameter milk_powder=1)", logs)
            self.assertNotIn("not sent as Arduino third parameter", logs)
        finally:
            vc.arduino = old_arduino
            vc._arduino_responsive = old_responsive
            vc.MACHINE_ID = old_machine_id
            vc.processed_orders.clear()
            vc.orders_in_progress.clear()


if __name__ == "__main__":
    unittest.main(verbosity=2)

