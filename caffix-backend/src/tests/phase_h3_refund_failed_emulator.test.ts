import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Firestore } from 'firebase-admin/firestore';

const EMULATOR_HOST = '127.0.0.1:8088';
const EMULATOR_PROJECT_ID = 'demo-caffix-emulator';
const TEST_WEBHOOK_SECRET = 'emulator_wh_secret_alpha_987654';

// Configure isolated Firebase Firestore Emulator environment BEFORE importing backend modules
process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
process.env.FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
delete process.env.STRICT_FIREBASE_VALIDATION;
process.env.NODE_ENV = 'test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_emulator_webhook';
process.env.RAZORPAY_KEY_SECRET = 'emulator_key_secret_beta_123456';
process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

import {
  initDB,
  getDB,
  resetMockDatabaseForColdStartSimulation
} from '../config/db';
import {
  ensureFirebaseReady,
  getFirestoreInstance,
  isFirestoreActive,
  resetFirestoreSeedStateForTesting
} from '../utils/firebase';
import {
  clearSyncedRefundsStore,
  createPendingRefundReservation,
  markRefundProcessed
} from '../utils/refunds';
import { handleRazorpayWebhook } from '../controllers/paymentController';

async function clearEmulatorDatabase() {
  const url = `http://${EMULATOR_HOST}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Failed to clear Firestore Emulator database: HTTP ${res.status}`);
  }
}

function buildSignedWebhookReq(body: any, eventId?: string) {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  const signature = crypto
    .createHmac('sha256', TEST_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return {
    headers: {
      'x-razorpay-signature': signature,
      ...(eventId ? { 'x-razorpay-event-id': eventId } : {})
    },
    rawBody,
    body
  } as any;
}

function mockResponse() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    }
  };
  return res;
}

async function seedEmulatorOrder(
  firestore: Firestore,
  orderId: string,
  paymentId: string,
  capturedPaise: number = 100
) {
  const now = new Date().toISOString();
  await firestore.collection('orders').doc(orderId).set({
    id: orderId,
    machine_id: 'CFX-MC-02',
    product_id: 1,
    product_name: 'Classic Crest',
    coffee: 'Classic Crest',
    amount: capturedPaise / 100,
    captured_amount_paise: capturedPaise,
    status: 'PAID',
    dispense_status: 'QUEUED',
    refund_status: 'NONE',
    total_refunded_amount_paise: 0,
    pending_refund_amount_paise: 0,
    last_refunded_at: null,
    refund_version: 0,
    razorpay_order_id: `order_${orderId}`,
    razorpay_payment_id: paymentId,
    created_at: now,
    updated_at: now
  });
}

async function snapshotState(
  firestore: Firestore,
  orderId: string,
  refundIds: string[],
  eventIds: string[] = []
) {
  const orderSnap = await firestore.collection('orders').doc(orderId).get();
  const orderData = orderSnap.data() || null;

  const refunds: Record<string, any> = {};
  for (const rId of refundIds) {
    const rootSnap = await firestore.collection('refunds').doc(rId).get();
    const subSnap = await firestore
      .collection('orders')
      .doc(orderId)
      .collection('refunds')
      .doc(rId)
      .get();
    refunds[rId] = {
      root: rootSnap.exists
        ? {
            id: rootSnap.data()?.id,
            status: rootSnap.data()?.status,
            razorpay_payment_id: rootSnap.data()?.razorpay_payment_id,
            razorpay_refund_id: rootSnap.data()?.razorpay_refund_id,
            amount_paise: rootSnap.data()?.amount_paise,
            error_code: rootSnap.data()?.error_code
          }
        : null,
      subcollection: subSnap.exists
        ? {
            id: subSnap.data()?.id,
            status: subSnap.data()?.status,
            razorpay_payment_id: subSnap.data()?.razorpay_payment_id,
            razorpay_refund_id: subSnap.data()?.razorpay_refund_id,
            amount_paise: subSnap.data()?.amount_paise,
            error_code: subSnap.data()?.error_code
          }
        : null
    };
  }

  const webhookEvents: Record<string, any> = {};
  for (const eId of eventIds) {
    const whSnap = await firestore.collection('webhook_events').doc(`razorpay_${eId}`).get();
    webhookEvents[eId] = whSnap.exists
      ? {
          status: whSnap.data()?.status,
          event_type: whSnap.data()?.event_type,
          claim_count: whSnap.data()?.claim_count
        }
      : null;
  }

  return {
    order: orderData
      ? {
          id: orderData.id,
          status: orderData.status,
          dispense_status: orderData.dispense_status,
          captured_amount_paise: orderData.captured_amount_paise,
          refund_status: orderData.refund_status,
          pending_refund_amount_paise: orderData.pending_refund_amount_paise,
          total_refunded_amount_paise: orderData.total_refunded_amount_paise,
          refund_version: orderData.refund_version
        }
      : null,
    refunds,
    webhookEvents
  };
}

async function runEmulatorTests() {
  console.log('\n========================================================================');
  console.log('Running CAFFIX Phase 2 — Firebase Firestore Emulator Integration Tests');
  console.log(`Target Emulator Host: http://${EMULATOR_HOST}`);
  console.log(`Isolated Project ID: ${EMULATOR_PROJECT_ID}`);
  console.log('========================================================================\n');

  await clearEmulatorDatabase();
  ensureFirebaseReady();
  const firestore = getFirestoreInstance();
  assert(firestore, 'Firestore Emulator client must be initialized');
  assert.strictEqual(isFirestoreActive(), true, 'Firestore Emulator must be active');

  // Now switch db layer into Vercel MockDatabase mode while keeping Firestore Emulator connected
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'preview';
  resetMockDatabaseForColdStartSimulation();
  const db = await initDB();
  assert.strictEqual(getDB(), db);
  assert.strictEqual(db.constructor.name, 'MockDatabase');
  resetFirestoreSeedStateForTesting();
  clearSyncedRefundsStore();

  await firestore.collection('machines').doc('CFX-MC-02').set({
    id: 'CFX-MC-02',
    machine_name: 'TWO',
    location: 'AHM',
    desired_mode: 'RUNNING',
    status: 'online'
  });

  // --------------------------------------------------------------------------
  // SCENARIO 1: Cold-start refund.failed without receipt or razorpay_refund_id
  // --------------------------------------------------------------------------
  console.log('--- Scenario 1: refund.failed (NO receipt, NO razorpay_refund_id, Vercel MockDatabase cold start) ---');
  const order1 = 'ORD-EMU-RF-FAIL-1';
  const pay1 = 'pay_emu_rf_fail_1';
  const evt1 = 'evt_emu_rf_fail_1';
  await seedEmulatorOrder(firestore, order1, pay1, 100);
  const resv1 = await createPendingRefundReservation(db, {
    orderId: order1,
    amount_paise: 100,
    reason: 'emulator_cold_start_test',
    initiated_by: 'admin@caffix.com',
    idempotency_key: 'idem_emu_rf_fail_1'
  });

  // Simulate Vercel serverless cold start (empty MockDatabase & empty in-memory syncedRefundsStore)
  resetMockDatabaseForColdStartSimulation();
  const coldDb1 = await initDB();
  clearSyncedRefundsStore();
  const coldRows = await coldDb1.all('SELECT * FROM refunds WHERE razorpay_payment_id = ? AND status = ?', [pay1, 'PENDING']);
  assert.strictEqual(coldRows.length, 0, 'MockDatabase must be empty after cold start');

  const s1Before = await snapshotState(firestore, order1, [resv1.refund.id], [evt1]);
  console.log('Scenario 1 BEFORE:', JSON.stringify(s1Before));

  const req1 = buildSignedWebhookReq(
    {
      id: evt1,
      event: 'refund.failed',
      payload: {
        refund: {
          entity: {
            id: '',
            payment_id: pay1,
            receipt: null,
            amount: 100,
            currency: 'INR',
            error_code: 'UPI_REVERSAL_FAILED',
            error_description: 'UPI bank reversal rejected'
          }
        }
      }
    },
    evt1
  );
  const res1 = mockResponse();
  await handleRazorpayWebhook(req1, res1, (err: any) => { if (err) throw err; });
  assert.strictEqual(res1.statusCode, 200);

  const s1After = await snapshotState(firestore, order1, [resv1.refund.id], [evt1]);
  console.log('Scenario 1 AFTER:', JSON.stringify(s1After));

  assert.strictEqual(s1After.order?.refund_status, 'FAILED');
  assert.strictEqual(s1After.order?.pending_refund_amount_paise, 0);
  assert.strictEqual(s1After.order?.total_refunded_amount_paise, 0);
  assert.strictEqual(s1After.order?.refund_version, 2);
  assert.strictEqual(s1After.refunds[resv1.refund.id].root?.status, 'FAILED');
  assert.strictEqual(s1After.refunds[resv1.refund.id].subcollection?.status, 'FAILED');
  assert.strictEqual(s1After.refunds[resv1.refund.id].root?.error_code, 'UPI_REVERSAL_FAILED');
  assert.strictEqual(s1After.refunds[resv1.refund.id].subcollection?.error_code, 'UPI_REVERSAL_FAILED');
  assert.strictEqual(s1After.webhookEvents[evt1]?.status, 'PROCESSED');
  console.log('PASS Scenario 1\n');

  // --------------------------------------------------------------------------
  // SCENARIO 2: Duplicate refund.failed webhook delivery
  // --------------------------------------------------------------------------
  console.log('--- Scenario 2: Duplicate refund.failed webhook delivery ---');
  const s2Before = await snapshotState(firestore, order1, [resv1.refund.id], [evt1]);
  console.log('Scenario 2 BEFORE:', JSON.stringify(s2Before));

  const req2 = buildSignedWebhookReq(
    {
      id: evt1,
      event: 'refund.failed',
      payload: {
        refund: {
          entity: {
            id: '',
            payment_id: pay1,
            receipt: null,
            amount: 100,
            currency: 'INR',
            error_code: 'UPI_REVERSAL_FAILED'
          }
        }
      }
    },
    evt1
  );
  const res2 = mockResponse();
  await handleRazorpayWebhook(req2, res2, (err: any) => { if (err) throw err; });
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(res2.body?.deduplicated, true);

  const s2After = await snapshotState(firestore, order1, [resv1.refund.id], [evt1]);
  console.log('Scenario 2 AFTER:', JSON.stringify(s2After));
  assert.deepStrictEqual(s2After, s2Before);
  console.log('PASS Scenario 2\n');

  // --------------------------------------------------------------------------
  // SCENARIO 3: Already PROCESSED refund receiving late FAILED event
  // --------------------------------------------------------------------------
  console.log('--- Scenario 3: Already PROCESSED refund receiving late refund.failed event ---');
  const order3 = 'ORD-EMU-PROC-3';
  const pay3 = 'pay_emu_proc_3';
  const evt3a = 'evt_emu_proc_late_rpid';
  const evt3b = 'evt_emu_proc_late_noids';
  await seedEmulatorOrder(firestore, order3, pay3, 100);
  const resv3 = await createPendingRefundReservation(db, {
    orderId: order3,
    amount_paise: 100,
    reason: 'emulator_terminal_protection',
    initiated_by: 'admin@caffix.com',
    idempotency_key: 'idem_emu_proc_3'
  });
  await markRefundProcessed(db, {
    refundId: resv3.refund.id,
    razorpay_refund_id: 'rfnd_emu_proc_3'
  });

  // Cold-start + inject stale PENDING cache row in MockDatabase to verify Firestore takes precedence
  resetMockDatabaseForColdStartSimulation();
  const staleDb3 = await initDB();
  clearSyncedRefundsStore();
  await staleDb3.run(
    `INSERT INTO refunds (
      id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id,
      amount_paise, currency, status, reason, notes, initiated_by,
      source, idempotency_key, error_code, error_description,
      created_at, updated_at, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      resv3.refund.id, order3, 'CFX-MC-02', pay3, 'rfnd_emu_proc_3',
      100, 'INR', 'PENDING', 'stale_cache', null, 'admin@caffix.com',
      'SUPER_ADMIN_PORTAL', 'idem_stale_cache_3', null, null,
      new Date().toISOString(), new Date().toISOString(), null
    ]
  );

  const s3Before = await snapshotState(firestore, order3, [resv3.refund.id], [evt3a, evt3b]);
  console.log('Scenario 3 BEFORE:', JSON.stringify(s3Before));

  // 3a. Late refund.failed matching by razorpay_refund_id
  const req3a = buildSignedWebhookReq(
    {
      id: evt3a,
      event: 'refund.failed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_emu_proc_3',
            payment_id: pay3,
            receipt: null,
            amount: 100,
            currency: 'INR',
            error_code: 'LATE_ERROR_BY_RPID'
          }
        }
      }
    },
    evt3a
  );
  const res3a = mockResponse();
  await handleRazorpayWebhook(req3a, res3a, (err: any) => { if (err) throw err; });
  assert.strictEqual(res3a.statusCode, 200);

  // 3b. Late refund.failed without receipt or razorpay_refund_id
  const req3b = buildSignedWebhookReq(
    {
      id: evt3b,
      event: 'refund.failed',
      payload: {
        refund: {
          entity: {
            id: '',
            payment_id: pay3,
            receipt: null,
            amount: 100,
            currency: 'INR',
            error_code: 'LATE_ERROR_NO_IDS'
          }
        }
      }
    },
    evt3b
  );
  const res3b = mockResponse();
  await handleRazorpayWebhook(req3b, res3b, (err: any) => { if (err) throw err; });
  assert.strictEqual(res3b.statusCode, 200);

  const s3After = await snapshotState(firestore, order3, [resv3.refund.id], [evt3a, evt3b]);
  console.log('Scenario 3 AFTER:', JSON.stringify(s3After));

  assert.strictEqual(s3After.order?.refund_status, 'FULL');
  assert.strictEqual(s3After.order?.total_refunded_amount_paise, 100);
  assert.strictEqual(s3After.order?.pending_refund_amount_paise, 0);
  assert.strictEqual(s3After.order?.refund_version, 2);
  assert.strictEqual(s3After.refunds[resv3.refund.id].root?.status, 'PROCESSED');
  assert.strictEqual(s3After.refunds[resv3.refund.id].subcollection?.status, 'PROCESSED');
  assert.strictEqual(s3After.webhookEvents[evt3a]?.status, 'PROCESSED');
  assert.strictEqual(s3After.webhookEvents[evt3b]?.status, 'PROCESSED');
  console.log('PASS Scenario 3\n');

  // --------------------------------------------------------------------------
  // SCENARIO 4: Multiple pending refunds for one payment
  // --------------------------------------------------------------------------
  console.log('--- Scenario 4: Multiple PENDING refunds for one payment ---');
  const order4 = 'ORD-EMU-MULTI-4';
  const pay4 = 'pay_emu_multi_4';
  const evt4a = 'evt_emu_multi_ambig';
  const evt4b = 'evt_emu_multi_unique_b';
  await seedEmulatorOrder(firestore, order4, pay4, 10000);
  const resv4A = await createPendingRefundReservation(db, {
    orderId: order4,
    amount_paise: 3000,
    reason: 'emu_partial_pending_A',
    initiated_by: 'admin@caffix.com',
    idempotency_key: 'idem_emu_multi_4A'
  });
  const resv4B = await createPendingRefundReservation(db, {
    orderId: order4,
    amount_paise: 4000,
    reason: 'emu_partial_pending_B',
    initiated_by: 'admin@caffix.com',
    idempotency_key: 'idem_emu_multi_4B'
  });

  resetMockDatabaseForColdStartSimulation();
  await initDB();
  clearSyncedRefundsStore();

  const s4BeforeAmbig = await snapshotState(firestore, order4, [resv4A.refund.id, resv4B.refund.id], [evt4a, evt4b]);
  console.log('Scenario 4A BEFORE (2 PENDING):', JSON.stringify(s4BeforeAmbig));

  // 4A. Ambiguous refund.failed without receipt or razorpay_refund_id -> releases neither
  const req4a = buildSignedWebhookReq(
    {
      id: evt4a,
      event: 'refund.failed',
      payload: {
        refund: {
          entity: {
            id: '',
            payment_id: pay4,
            receipt: null,
            amount: 3000,
            currency: 'INR',
            error_code: 'AMBIGUOUS_BANK_FAILURE'
          }
        }
      }
    },
    evt4a
  );
  const res4a = mockResponse();
  await handleRazorpayWebhook(req4a, res4a, (err: any) => { if (err) throw err; });
  assert.strictEqual(res4a.statusCode, 200);

  const s4AfterAmbig = await snapshotState(firestore, order4, [resv4A.refund.id, resv4B.refund.id], [evt4a]);
  console.log('Scenario 4A AFTER (preserved both):', JSON.stringify(s4AfterAmbig));
  assert.strictEqual(s4AfterAmbig.order?.pending_refund_amount_paise, 7000);
  assert.strictEqual(s4AfterAmbig.order?.refund_status, 'PENDING');
  assert.strictEqual(s4AfterAmbig.refunds[resv4A.refund.id].root?.status, 'PENDING');
  assert.strictEqual(s4AfterAmbig.refunds[resv4B.refund.id].root?.status, 'PENDING');

  // 4B. Settle A -> PROCESSED, then send refund.failed without IDs -> uniquely matches remaining PENDING B
  await markRefundProcessed(db, {
    refundId: resv4A.refund.id,
    razorpay_refund_id: 'rfnd_emu_multi_4A'
  });
  resetMockDatabaseForColdStartSimulation();
  await initDB();
  clearSyncedRefundsStore();

  const s4BeforeUniqueB = await snapshotState(firestore, order4, [resv4A.refund.id, resv4B.refund.id], [evt4a, evt4b]);
  console.log('Scenario 4B BEFORE (1 PROCESSED, 1 PENDING):', JSON.stringify(s4BeforeUniqueB));

  const req4b = buildSignedWebhookReq(
    {
      id: evt4b,
      event: 'refund.failed',
      payload: {
        refund: {
          entity: {
            id: '',
            payment_id: pay4,
            receipt: null,
            amount: 4000,
            currency: 'INR',
            error_code: 'UNIQUE_PENDING_B_FAILED'
          }
        }
      }
    },
    evt4b
  );
  const res4b = mockResponse();
  await handleRazorpayWebhook(req4b, res4b, (err: any) => { if (err) throw err; });
  assert.strictEqual(res4b.statusCode, 200);

  const s4AfterUniqueB = await snapshotState(firestore, order4, [resv4A.refund.id, resv4B.refund.id], [evt4a, evt4b]);
  console.log('Scenario 4B AFTER (A=PROCESSED, B=FAILED):', JSON.stringify(s4AfterUniqueB));

  assert.strictEqual(s4AfterUniqueB.refunds[resv4A.refund.id].root?.status, 'PROCESSED');
  assert.strictEqual(s4AfterUniqueB.refunds[resv4A.refund.id].subcollection?.status, 'PROCESSED');
  assert.strictEqual(s4AfterUniqueB.refunds[resv4B.refund.id].root?.status, 'FAILED');
  assert.strictEqual(s4AfterUniqueB.refunds[resv4B.refund.id].subcollection?.status, 'FAILED');
  assert.strictEqual(s4AfterUniqueB.order?.total_refunded_amount_paise, 3000);
  assert.strictEqual(s4AfterUniqueB.order?.pending_refund_amount_paise, 0);
  assert.strictEqual(s4AfterUniqueB.order?.refund_status, 'PARTIAL');
  assert.strictEqual(s4AfterUniqueB.webhookEvents[evt4b]?.status, 'PROCESSED');
  console.log('PASS Scenario 4\n');

  console.log('ALL PHASE 2 FIREBASE FIRESTORE EMULATOR INTEGRATION TESTS PASSED!\n');
}

runEmulatorTests().catch((err) => {
  console.error('\nEMULATOR INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
