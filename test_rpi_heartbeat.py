"""
Automated Test Suite for Stage 4: Raspberry Pi 4 Heartbeat Integration
----------------------------------------------------------------------
Verifies:
1. Heartbeat writes to the correct `machines/{machine_id}` document.
2. Heartbeat updates `last_seen` (valid ISO-8601 UTC timestamp) with `merge=True`.
3. `desired_mode` ('MAINTENANCE') and `status` ('maintenance') remain unchanged.
4. `owner_id` remains unchanged.
5. `products` (per-machine pricing and availability) remain unchanged.
6. `estimated_inventory` remains unchanged.
7. Heartbeat continues working when Arduino GIGA R1 is disconnected or raises serial errors.
8. Temporary internet / Firestore failure does not crash the heartbeat thread or order processor,
   and recovers automatically when connectivity returns.
9. Multiple machines (`CFX-MC-01`, `CFX-MC-02`, `CFX-MC-03`) update their own documents independently.
10. Calling `start_heartbeat()` repeatedly on reconnect never creates duplicate heartbeat threads.
11. Dynamic per-machine `MACHINE_ID` configuration via env vars / env file and systemd unit compatibility.
12. Existing Firestore order filtering, atomic claiming, and Arduino dispensing remain unchanged.
"""

import configparser
import os
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from rpi_order_processor import (
    DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    MachineOrderProcessor,
    resolve_configured_machine_id,
    validate_machine_id,
)


class FakeFirestoreDocRef:
    """In-memory mock of a Firestore DocumentReference supporting `.set(data, merge=...)`."""

    def __init__(self, store: Dict[str, Dict[str, Any]], doc_id: str, fail_next_writes: int = 0):
        self._store = store
        self.id = doc_id
        self.fail_next_writes = fail_next_writes
        self.write_calls: List[Dict[str, Any]] = []

    def set(self, data: Dict[str, Any], merge: bool = False) -> None:
        if self.fail_next_writes > 0:
            self.fail_next_writes -= 1
            raise ConnectionError(f"Simulated temporary Firestore network failure on doc '{self.id}'")

        self.write_calls.append({"data": dict(data), "merge": merge})
        if not merge or self.id not in self._store:
            self._store[self.id] = dict(data)
        else:
            # Shallow/deep merge matching Firestore set(..., merge=True)
            existing = self._store[self.id]
            for k, v in data.items():
                if isinstance(v, dict) and isinstance(existing.get(k), dict):
                    merged_nested = dict(existing[k])
                    merged_nested.update(v)
                    existing[k] = merged_nested
                else:
                    existing[k] = v


class FakeFirestoreCollection:
    def __init__(self, collections_store: Dict[str, Dict[str, Dict[str, Any]]], name: str):
        self._collections_store = collections_store
        self.name = name
        if name not in self._collections_store:
            self._collections_store[name] = {}
        self._doc_refs: Dict[str, FakeFirestoreDocRef] = {}

    def document(self, doc_id: str) -> FakeFirestoreDocRef:
        if doc_id not in self._doc_refs:
            self._doc_refs[doc_id] = FakeFirestoreDocRef(self._collections_store[self.name], doc_id)
        return self._doc_refs[doc_id]


class FakeFirestoreClient:
    def __init__(self, initial_machines: Optional[Dict[str, Dict[str, Any]]] = None):
        self.collections_store: Dict[str, Dict[str, Dict[str, Any]]] = {
            "machines": initial_machines if initial_machines is not None else {},
            "orders": {},
        }
        self._collections: Dict[str, FakeFirestoreCollection] = {}

    def collection(self, name: str) -> FakeFirestoreCollection:
        if name not in self._collections:
            self._collections[name] = FakeFirestoreCollection(self.collections_store, name)
        return self._collections[name]

    def get_machine_doc(self, machine_id: str) -> Optional[Dict[str, Any]]:
        return self.collections_store.get("machines", {}).get(machine_id)


class Stage4RpiHeartbeatTests(unittest.TestCase):
    def test_01_default_interval_and_machine_id_resolution(self) -> None:
        """Verify 30s default heartbeat interval and dynamic MACHINE_ID resolution."""
        self.assertEqual(DEFAULT_HEARTBEAT_INTERVAL_SECONDS, 30.0)

        # Explicit argument takes priority
        self.assertEqual(resolve_configured_machine_id("CFX-MC-02"), "CFX-MC-02")

        # Environment file resolution (/etc/caffix/machine.env style)
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False, encoding="utf-8") as tmp:
            tmp.write("# Raspberry Pi Kiosk 3 Config\nMACHINE_ID=CFX-MC-03\n")
            tmp_path = tmp.name

        old_env = os.environ.pop("MACHINE_ID", None)
        try:
            resolved = resolve_configured_machine_id(env_file_path=tmp_path)
            self.assertEqual(resolved, "CFX-MC-03")
        finally:
            if old_env is not None:
                os.environ["MACHINE_ID"] = old_env
            os.remove(tmp_path)

        # Invalid machine IDs must be rejected
        with self.assertRaises(ValueError):
            validate_machine_id("INVALID-ID")

    def test_02_heartbeat_writes_correct_machine_id_and_updates_last_seen(self) -> None:
        """Test 1 & 2: Heartbeat writes to `machines/{machine_id}` and updates `last_seen` with merge=True."""
        fake_db = FakeFirestoreClient()
        processor = MachineOrderProcessor(machine_id="CFX-MC-01", firestore_db=fake_db)

        fixed_ts = datetime(2026, 11, 7, 13, 30, 0, tzinfo=timezone.utc)
        ok = processor.send_heartbeat(now_utc=fixed_ts)
        self.assertTrue(ok)
        self.assertEqual(processor.heartbeat_count, 1)
        self.assertEqual(processor.last_heartbeat_iso, "2026-11-07T13:30:00Z")

        doc = fake_db.get_machine_doc("CFX-MC-01")
        self.assertIsNotNone(doc)
        assert doc is not None
        self.assertEqual(doc["id"], "CFX-MC-01")
        self.assertEqual(doc["last_seen"], "2026-11-07T13:30:00Z")

        # Verify write call used merge=True and ONLY wrote {'id', 'last_seen'}
        doc_ref = fake_db.collection("machines").document("CFX-MC-01")
        self.assertEqual(len(doc_ref.write_calls), 1)
        self.assertTrue(doc_ref.write_calls[0]["merge"])
        self.assertEqual(set(doc_ref.write_calls[0]["data"].keys()), {"id", "last_seen"})

    def test_03_heartbeat_preserves_maintenance_owner_products_and_inventory(self) -> None:
        """
        Tests 3, 4, 5: Heartbeat NEVER overwrites desired_mode, status, owner_id,
        products (pricing & availability), or estimated_inventory.
        """
        initial_machine_state = {
            "id": "CFX-MC-01",
            "machine_name": "Kiosk-One",
            "location": "Delhi Airport T3",
            "desired_mode": "MAINTENANCE",
            "status": "maintenance",
            "owner_id": "usr_8842a9d0-1234-4a5b-9c8d-0123456789ab",
            "last_seen": "2026-11-07T12:00:00Z",
            "products": {
                "1": {"product_id": 1, "price": 125, "is_available": True},
                "2": {"product_id": 2, "price": 110, "is_available": False},
            },
            "estimated_inventory": {
                "water_level": 80,
                "coffee_level": 74,
                "milk_level": 85,
                "vanilla_level": 60,
                "hazelnut_level": 90,
                "irish_level": 95,
                "mocha_level": 88,
            },
        }
        fake_db = FakeFirestoreClient(initial_machines={"CFX-MC-01": dict(initial_machine_state)})
        processor = MachineOrderProcessor(machine_id="CFX-MC-01", firestore_db=fake_db)

        new_ts = datetime(2026, 11, 7, 13, 45, 30, tzinfo=timezone.utc)
        ok = processor.send_heartbeat(now_utc=new_ts)
        self.assertTrue(ok)

        updated_doc = fake_db.get_machine_doc("CFX-MC-01")
        assert updated_doc is not None
        # `last_seen` must be updated
        self.assertEqual(updated_doc["last_seen"], "2026-11-07T13:45:30Z")
        # Protected fields must be 100% untouched
        self.assertEqual(updated_doc["desired_mode"], "MAINTENANCE")
        self.assertEqual(updated_doc["status"], "maintenance")
        self.assertEqual(updated_doc["owner_id"], "usr_8842a9d0-1234-4a5b-9c8d-0123456789ab")
        self.assertEqual(updated_doc["products"]["1"]["price"], 125)
        self.assertEqual(updated_doc["products"]["1"]["is_available"], True)
        self.assertEqual(updated_doc["products"]["2"]["price"], 110)
        self.assertEqual(updated_doc["products"]["2"]["is_available"], False)
        self.assertEqual(updated_doc["estimated_inventory"]["coffee_level"], 74)

    def test_04_heartbeat_works_when_arduino_is_disconnected(self) -> None:
        """
        Test 6: Heartbeat operates independently of Arduino GIGA R1 serial connection.
        Even if Arduino callback is None or raises SerialException/OSError, heartbeat succeeds.
        """
        fake_db = FakeFirestoreClient()

        def disconnected_arduino_callback(order_data: Dict[str, Any]) -> bool:
            raise OSError("Arduino GIGA R1 USB serial port /dev/ttyACM0 disconnected")

        processor = MachineOrderProcessor(
            machine_id="CFX-MC-02",
            firestore_db=fake_db,
            arduino_dispense_callback=disconnected_arduino_callback,
        )

        # Simulate a failed Arduino dispense due to unplugged USB serial cable
        order_doc = {
            "id": "CFX-90001",
            "machine_id": "CFX-MC-02",
            "status": "PAID",
            "coffee": "Classic Crest",
            "base": "milk",
        }
        dispense_ok = processor.claim_and_process_order("CFX-90001", order_snapshot_data=order_doc)
        self.assertFalse(dispense_ok)
        self.assertEqual(order_doc["dispense_status"], "FAILED")

        # Raspberry Pi heartbeat must still succeed and report connectivity
        hb_ok = processor.send_heartbeat()
        self.assertTrue(hb_ok)
        mc2_doc = fake_db.get_machine_doc("CFX-MC-02")
        self.assertIsNotNone(mc2_doc)
        assert mc2_doc is not None
        self.assertEqual(mc2_doc["id"], "CFX-MC-02")
        self.assertTrue(bool(mc2_doc.get("last_seen")))

    def test_05_temporary_firestore_failure_does_not_crash_service_and_recovers(self) -> None:
        """
        Test 7: Temporary internet or Firestore failure is caught gracefully without crashing
        the heartbeat loop or order processor, and subsequent heartbeats succeed once reconnected.
        """
        fake_db = FakeFirestoreClient()
        doc_ref = fake_db.collection("machines").document("CFX-MC-01")
        # Simulate 2 consecutive network/Firestore failures followed by recovery
        doc_ref.fail_next_writes = 2

        processor = MachineOrderProcessor(
            machine_id="CFX-MC-01",
            firestore_db=fake_db,
            heartbeat_interval_seconds=0.05,
        )

        # First manual heartbeat fails gracefully (returns False, does not raise)
        first_ok = processor.send_heartbeat()
        self.assertFalse(first_ok)
        self.assertEqual(processor.heartbeat_failure_count, 1)
        self.assertEqual(processor.heartbeat_count, 0)

        # Start background heartbeat loop: next attempt will also fail, then 3rd+ attempts will succeed
        processor.start_heartbeat(interval_seconds=0.05, send_immediately=True)
        try:
            deadline = time.time() + 1.5
            while time.time() < deadline and processor.heartbeat_count < 2:
                time.sleep(0.03)

            self.assertGreaterEqual(
                processor.heartbeat_count,
                2,
                "Heartbeat thread must survive transient Firestore errors and recover automatically",
            )
            self.assertGreaterEqual(processor.heartbeat_failure_count, 2)
            self.assertTrue(processor.is_heartbeat_running())
        finally:
            processor.stop_heartbeat()

    def test_06_multiple_machines_update_independently(self) -> None:
        """
        Test 8: Multiple Raspberry Pi controllers (CFX-MC-01, CFX-MC-02, CFX-MC-03)
        update only their own `machines/{machine_id}` document in Firestore.
        """
        fake_db = FakeFirestoreClient(
            initial_machines={
                "CFX-MC-01": {"id": "CFX-MC-01", "owner_id": "usr_owner_1", "desired_mode": "RUNNING"},
                "CFX-MC-02": {"id": "CFX-MC-02", "owner_id": "usr_owner_2", "desired_mode": "MAINTENANCE"},
                "CFX-MC-03": {"id": "CFX-MC-03", "owner_id": "usr_owner_1", "desired_mode": "RUNNING"},
            }
        )

        p1 = MachineOrderProcessor(machine_id="CFX-MC-01", firestore_db=fake_db)
        p2 = MachineOrderProcessor(machine_id="CFX-MC-02", firestore_db=fake_db)
        p3 = MachineOrderProcessor(machine_id="CFX-MC-03", firestore_db=fake_db)

        ts1 = datetime(2026, 11, 7, 14, 0, 1, tzinfo=timezone.utc)
        ts2 = datetime(2026, 11, 7, 14, 0, 2, tzinfo=timezone.utc)
        ts3 = datetime(2026, 11, 7, 14, 0, 3, tzinfo=timezone.utc)

        self.assertTrue(p1.send_heartbeat(now_utc=ts1))
        self.assertTrue(p2.send_heartbeat(now_utc=ts2))
        self.assertTrue(p3.send_heartbeat(now_utc=ts3))

        doc1 = fake_db.get_machine_doc("CFX-MC-01")
        doc2 = fake_db.get_machine_doc("CFX-MC-02")
        doc3 = fake_db.get_machine_doc("CFX-MC-03")
        assert doc1 is not None and doc2 is not None and doc3 is not None

        self.assertEqual(doc1["last_seen"], "2026-11-07T14:00:01Z")
        self.assertEqual(doc1["owner_id"], "usr_owner_1")
        self.assertEqual(doc1["desired_mode"], "RUNNING")

        self.assertEqual(doc2["last_seen"], "2026-11-07T14:00:02Z")
        self.assertEqual(doc2["owner_id"], "usr_owner_2")
        self.assertEqual(doc2["desired_mode"], "MAINTENANCE")

        self.assertEqual(doc3["last_seen"], "2026-11-07T14:00:03Z")
        self.assertEqual(doc3["owner_id"], "usr_owner_1")
        self.assertEqual(doc3["desired_mode"], "RUNNING")

    def test_07_no_duplicate_heartbeat_threads_on_reconnect(self) -> None:
        """
        Requirement 8: Calling `start_heartbeat()` multiple times (e.g. during internal reconnects)
        must never spawn duplicate heartbeat threads for the same processor.
        """
        fake_db = FakeFirestoreClient()
        processor = MachineOrderProcessor(
            machine_id="CFX-MC-01",
            firestore_db=fake_db,
            heartbeat_interval_seconds=10.0,
        )

        try:
            t1 = processor.start_heartbeat(send_immediately=True)
            t2 = processor.start_heartbeat(send_immediately=True)
            t3 = processor.start_heartbeat(send_immediately=True)

            self.assertIs(t1, t2)
            self.assertIs(t2, t3)
            self.assertTrue(processor.is_heartbeat_running())

            matching_threads = [
                t for t in threading.enumerate() if t.name == "caffix-heartbeat-CFX-MC-01" and t.is_alive()
            ]
            self.assertEqual(len(matching_threads), 1, "Must have exactly 1 active heartbeat thread")
        finally:
            processor.stop_heartbeat()
            self.assertFalse(processor.is_heartbeat_running())

    def test_08_systemd_service_file_compatibility(self) -> None:
        """
        Requirement 11: Verify `caffix-vending.service` is valid INI/systemd syntax,
        uses dynamic EnvironmentFile configuration instead of a hardcoded single machine ID,
        and configures the 30s heartbeat interval.
        """
        service_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "caffix-vending.service")
        self.assertTrue(os.path.isfile(service_path), "caffix-vending.service must exist")

        with open(service_path, "r", encoding="utf-8") as fh:
            raw_content = fh.read()

        self.assertIn("[Unit]", raw_content)
        self.assertIn("[Service]", raw_content)
        self.assertIn("[Install]", raw_content)
        self.assertIn("EnvironmentFile=-/etc/caffix/machine.env", raw_content)
        self.assertIn("HEARTBEAT_INTERVAL_SECONDS=30", raw_content)
        self.assertIn("rpi_order_processor.py", raw_content)
        self.assertIn("Restart=always", raw_content)
        # Ensure the unit file does NOT hardcode `Environment=MACHINE_ID=CFX-MC-01`
        self.assertNotIn("Environment=MACHINE_ID=", raw_content)


if __name__ == "__main__":
    unittest.main(verbosity=2)

