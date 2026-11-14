import copy
import threading
import unittest
from types import SimpleNamespace

from rpi_order_processor import (
    CLAIMED_DISPENSE_STATES,
    NON_PROCESSABLE_DISPENSE_STATES,
    MachineOrderProcessor,
)


class FakeSnapshot:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = copy.deepcopy(data)
        self.exists = data is not None

    def to_dict(self):
        return copy.deepcopy(self._data)


class FakeDocRef:
    def __init__(self, store, doc_id):
        self._store = store
        self.id = doc_id

    def get(self, transaction=None):
        return FakeSnapshot(self.id, self._store.docs.get(self.id))

    def set(self, payload, merge=False):
        if merge and self.id in self._store.docs:
            merged = copy.deepcopy(self._store.docs[self.id])
            merged.update(copy.deepcopy(payload))
            self._store.docs[self.id] = merged
        else:
            self._store.docs[self.id] = copy.deepcopy(payload)


class FakeTransaction:
    def __init__(self):
        self._read_only = False
        self._id = b"fake-tx"
        self._max_attempts = 1

    def _begin(self, retry_id=None):
        return None

    def _commit(self):
        return []

    def _rollback(self):
        return None

    def _clean_up(self):
        return None

    def set(self, doc_ref, payload, merge=False):
        doc_ref.set(payload, merge=merge)


class FakeCollection:
    def __init__(self, store):
        self._store = store

    def where(self, filter=None):
        self._filter = filter
        return self

    def on_snapshot(self, callback):
        self._store.listener_callbacks.append(callback)
        return lambda: None


class FakeFirestoreDB:
    def __init__(self, docs=None):
        self.docs = copy.deepcopy(docs or {})
        self.listener_callbacks = []

    def collection(self, name):
        return FakeCollection(self)

    def doc_ref(self, doc_id):
        return FakeDocRef(self, doc_id)

    def transaction(self):
        return FakeTransaction()


class TestRpiOrderProcessorSafety(unittest.TestCase):
    def test_machine_isolation_and_eligible_statuses(self):
        proc = MachineOrderProcessor(machine_id="CFX-MC-01")
        # Rejects other machine
        self.assertFalse(
            proc.can_process_order(
                {"id": "ORD-1", "machine_id": "CFX-MC-02", "status": "PAID", "dispense_status": "QUEUED"}
            )
        )
        # Rejects unpaid statuses
        for unpaid in ("PENDING", "FAILED", "CANCELLED"):
            self.assertFalse(
                proc.can_process_order(
                    {"id": "ORD-2", "machine_id": "CFX-MC-01", "status": unpaid, "dispense_status": "PENDING"}
                )
            )
        # Accepts PAID/QUEUED for matching machine
        self.assertTrue(
            proc.can_process_order(
                {"id": "ORD-3", "machine_id": "CFX-MC-01", "status": "PAID", "dispense_status": "QUEUED"}
            )
        )

    def test_rejects_claimed_and_failed_dispense_states(self):
        proc = MachineOrderProcessor(machine_id="CFX-MC-01")
        self.assertTrue({"CLAIMING", "DISPENSING", "DISPENSED", "COMPLETED"}.issubset(CLAIMED_DISPENSE_STATES))
        self.assertIn("FAILED", NON_PROCESSABLE_DISPENSE_STATES)

        for blocked_state in ("CLAIMING", "DISPENSING", "DISPENSED", "COMPLETED", "FAILED", "CANCELLED", "failed"):
            self.assertFalse(
                proc.can_process_order(
                    {
                        "id": f"ORD-{blocked_state}",
                        "machine_id": "CFX-MC-01",
                        "status": "PAID",
                        "dispense_status": blocked_state,
                    }
                ),
                f"Expected dispense_status={blocked_state} to be rejected",
            )

    def test_rejects_full_refund_and_pending_refund_reservation(self):
        proc = MachineOrderProcessor(machine_id="CFX-MC-01")

        self.assertFalse(
            proc.can_process_order(
                {
                    "id": "ORD-REF-FULL",
                    "machine_id": "CFX-MC-01",
                    "status": "PAID",
                    "dispense_status": "QUEUED",
                    "refund_status": "FULL",
                    "pending_refund_amount_paise": 0,
                }
            )
        )

        self.assertFalse(
            proc.can_process_order(
                {
                    "id": "ORD-REF-PEND",
                    "machine_id": "CFX-MC-01",
                    "status": "PAID",
                    "dispense_status": "QUEUED",
                    "refund_status": "PENDING",
                    "pending_refund_amount_paise": 5000,
                }
            )
        )

        # Fail closed on malformed pending_refund_amount_paise
        self.assertFalse(
            proc.can_process_order(
                {
                    "id": "ORD-REF-BAD",
                    "machine_id": "CFX-MC-01",
                    "status": "PAID",
                    "dispense_status": "QUEUED",
                    "pending_refund_amount_paise": "not-a-number",
                }
            )
        )

        # Partial refund with zero pending reservation remains eligible
        self.assertTrue(
            proc.can_process_order(
                {
                    "id": "ORD-REF-PARTIAL",
                    "machine_id": "CFX-MC-01",
                    "status": "PAID",
                    "dispense_status": "QUEUED",
                    "refund_status": "PARTIAL",
                    "pending_refund_amount_paise": 0,
                }
            )
        )

    def test_duplicate_snapshot_and_restart_do_not_redispense(self):
        order_id = "ORD-DUP-1"
        db = FakeFirestoreDB(
            {
                order_id: {
                    "id": order_id,
                    "machine_id": "CFX-MC-01",
                    "status": "PAID",
                    "dispense_status": "QUEUED",
                    "dispensed": False,
                }
            }
        )
        dispense_calls = []

        def fake_arduino(order):
            dispense_calls.append(order["id"])
            return True

        proc1 = MachineOrderProcessor(machine_id="CFX-MC-01", firestore_db=db, arduino_dispense_callback=fake_arduino)
        proc1.start_firestore_listener("orders")
        on_snapshot = db.listener_callbacks[0]

        change = SimpleNamespace(
            type=SimpleNamespace(name="ADDED"),
            document=SimpleNamespace(
                id=order_id,
                reference=db.doc_ref(order_id),
                to_dict=lambda: copy.deepcopy(db.docs[order_id]),
            ),
        )
        on_snapshot(None, [change], None)
        on_snapshot(None, [change], None)

        self.assertEqual(dispense_calls, [order_id])
        self.assertEqual(db.docs[order_id]["dispense_status"], "DISPENSED")
        self.assertTrue(db.docs[order_id]["dispensed"])

        # Simulate RPi restart (fresh MachineOrderProcessor, empty _processed_order_ids) + Firestore replay
        proc2 = MachineOrderProcessor(machine_id="CFX-MC-01", firestore_db=db, arduino_dispense_callback=fake_arduino)
        result_after_restart = proc2.claim_and_process_order(order_id, doc_ref=db.doc_ref(order_id))
        self.assertFalse(result_after_restart)
        self.assertEqual(dispense_calls, [order_id])

    def test_failed_dispense_not_redispensed_on_snapshot_replay_or_restart(self):
        order_id = "ORD-FAIL-REPLAY-1"
        db = FakeFirestoreDB(
            {
                order_id: {
                    "id": order_id,
                    "machine_id": "CFX-MC-01",
                    "status": "PAID",
                    "dispense_status": "QUEUED",
                    "dispensed": False,
                }
            }
        )
        attempts = []

        def failing_arduino(order):
            attempts.append(order["id"])
            return False

        proc1 = MachineOrderProcessor(machine_id="CFX-MC-01", firestore_db=db, arduino_dispense_callback=failing_arduino)
        first_ok = proc1.claim_and_process_order(order_id, doc_ref=db.doc_ref(order_id))
        self.assertFalse(first_ok)
        self.assertEqual(attempts, [order_id])
        self.assertEqual(db.docs[order_id]["dispense_status"], "FAILED")
        self.assertFalse(db.docs[order_id]["dispensed"])

        # Simulate Firestore MODIFIED snapshot replay into a brand-new restarted processor instance
        proc2 = MachineOrderProcessor(machine_id="CFX-MC-01", firestore_db=db, arduino_dispense_callback=failing_arduino)
        proc2.start_firestore_listener("orders")
        on_snapshot = db.listener_callbacks[-1]

        replay_change = SimpleNamespace(
            type=SimpleNamespace(name="MODIFIED"),
            document=SimpleNamespace(
                id=order_id,
                reference=db.doc_ref(order_id),
                to_dict=lambda: copy.deepcopy(db.docs[order_id]),
            ),
        )
        on_snapshot(None, [replay_change], None)
        # Also test direct transactional claim invocation after restart
        self.assertFalse(proc2.claim_and_process_order(order_id, doc_ref=db.doc_ref(order_id)))
        # Also test standalone fallback claim mode without doc_ref
        self.assertFalse(
            proc2.claim_and_process_order(order_id, order_snapshot_data=copy.deepcopy(db.docs[order_id]))
        )
        self.assertEqual(attempts, [order_id])


if __name__ == "__main__":
    unittest.main()

