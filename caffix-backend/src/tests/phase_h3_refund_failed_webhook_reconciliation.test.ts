import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_WEBHOOK_SECRET = 'unit_wh_secret_alpha_987654';
process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'preview';
process.env.NODE_ENV = 'test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_unit_webhook';
process.env.RAZORPAY_KEY_SECRET = 'unit_key_secret_beta_123456';
process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
delete process.env.STRICT_FIREBASE_VALIDATION;

import {
  initDB,
  getDB,
  resetMockDatabaseForColdStartSimulation
} from '../config/db';
import {
  resetFirestoreSeedStateForTesting,
  setFirestoreForTesting
} from '../utils/firebase';
import {
  clearSyncedRefundsStore,
  createPendingRefundReservation,
  markRefundProcessed,
  recordPendingRefundGatewayId
} from '../utils/refunds';
import { handleRazorpayWebhook } from '../controllers/paymentController';

class InMemoryFirestoreWithTx {
  private collections = new Map<string, Map<string, any>>();
  private subcollections = new Map<string, Map<string, any>>();

  private getColMap(name: string): Map<string, any> {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
    return this.collections.get(name)!;
  }

  private getSubColMap(parentDocPath: string, subName: string): Map<string, any> {
    const key = `${parentDocPath}/${subName}`;
    if (!this.subcollections.has(key)) {
      this.subcollections.set(key, new Map());
    }
    return this.subcollections.get(key)!;
  }

  private makeQuery(items: Array<{ id: string; path: string; data: any }>) {
    const buildQueryObj = (
      currentFilters: Array<(doc: any) => boolean>,
      limitN?: number
    ): any => ({
      where(field: string, op: string, val: any) {
        const nextFilters = [
          ...currentFilters,
          (doc: any) => {
            const actual = doc[field];
            if (op === '==') return actual === val;
            if (op === 'in') return Array.isArray(val) && val.includes(actual);
            if (op === '>=') return String(actual || '') >= String(val);
            if (op === '<=') return String(actual || '') <= String(val);
            if (op === '<') return String(actual || '') < String(val);
            return true;
          }
        ];
        return buildQueryObj(nextFilters, limitN);
      },
      orderBy() {
        return buildQueryObj(currentFilters, limitN);
      },
      limit(n: number) {
        return buildQueryObj(currentFilters, n);
      },
      async get() {
        let matched = items.filter((item) => currentFilters.every((fn) => fn(item.data)));
        if (limitN !== undefined) {
          matched = matched.slice(0, limitN);
        }
        const docs = matched.map((item) => ({
          id: item.id,
          exists: true,
          ref: { path: item.path },
          data: () => ({ ...item.data })
        }));
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
          forEach: (cb: (d: any) => void) => docs.forEach(cb)
        };
      }
    });
    return buildQueryObj([]);
  }

  private makeDocRef(map: Map<string, any>, docId: string, docPath: string): any {
    const self = this;
    return {
      id: docId,
      path: docPath,
      async set(data: any, opts?: { merge?: boolean }) {
        if (opts?.merge && map.has(docId)) {
          map.set(docId, { ...map.get(docId), ...data });
        } else {
          map.set(docId, { ...data });
        }
      },
      async get() {
        const existing = map.get(docId);
        return {
          id: docId,
          exists: Boolean(existing),
          ref: self.makeDocRef(map, docId, docPath),
          data: () => (existing ? { ...existing } : undefined)
        };
      },
      collection: (subName: string) => {
        const subMap = self.getSubColMap(docPath, subName);
        const subItems = Array.from(subMap.entries()).map(([id, data]) => ({
          id,
          path: `${docPath}/${subName}/${id}`,
          data
        }));
        return {
          ...self.makeQuery(subItems),
          doc: (subId: string) =>
            self.makeDocRef(subMap, subId, `${docPath}/${subName}/${subId}`)
        };
      }
    };
  }

  collection(name: string): any {
    const colMap = this.getColMap(name);
    const items = Array.from(colMap.entries()).map(([id, data]) => ({
      id,
      path: `${name}/${id}`,
      data
    }));

    return {
      ...this.makeQuery(items),
      doc: (docId: string) => this.makeDocRef(colMap, docId, `${name}/${docId}`)
    };
  }

  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      async get(target: any) {
        return await target.get();
      },
      set(target: any, data: any, opts?: { merge?: boolean }) {
        target.set(data, opts);
      }
    };
    return await fn(tx);
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

async function seedOrder(
  mockFs: InMemoryFirestoreWithTx,
  orderId: string,
  paymentId: string,
  capturedPaise: number = 100
) {
  const now = new Date().toISOString();
  await mockFs.collection('orders').doc(orderId).set({
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

async function runTests() {
  console.log('\n======================================================================');
  console.log('Running CAFFIX Phase H.3 — refund.failed Webhook Reconciliation Tests');
  console.log('======================================================================\n');

  resetMockDatabaseForColdStartSimulation();
  const db = await initDB();
  assert.strictEqual(getDB(), db);
  assert.strictEqual(db.constructor.name, 'MockDatabase');

  const mockFs = new InMemoryFirestoreWithTx();
  setFirestoreForTesting({ firestoreInstance: mockFs, clearStores: true });
  resetFirestoreSeedStateForTesting();
  clearSyncedRefundsStore();

  await mockFs.collection('machines').doc('CFX-MC-02').set({
    id: 'CFX-MC-02',
    machine_name: 'TWO',
    location: 'AHM',
    desired_mode: 'RUNNING',
    status: 'online'
  });

  // 1. Normal refund.failed with receipt
  console.log('1. Testing normal refund.failed with receipt...');
  {
    const orderId = 'ORD-RF-FAIL-1';
    const paymentId = 'pay_rf_fail_1';
    await seedOrder(mockFs, orderId, paymentId, 100);

    const resv = await createPendingRefundReservation(db, {
      orderId,
      amount_paise: 100,
      reason: 'test_receipt_match',
      initiated_by: 'admin@caffix.com',
      idempotency_key: 'idem_rf_fail_1'
    });
    await recordPendingRefundGatewayId(db, {
      refundId: resv.refund.id,
      razorpay_refund_id: 'rfnd_fail_1'
    });

    const req = buildSignedWebhookReq(
      {
        id: 'evt_rf_fail_1',
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_fail_1',
              payment_id: paymentId,
              receipt: resv.refund.id,
              amount: 100,
              currency: 'INR',
              error_code: 'BANK_DECLINED',
              error_description: 'Issuer declined refund'
            }
          }
        }
      },
      'evt_rf_fail_1'
    );
    const res = mockResponse();
    await handleRazorpayWebhook(req, res, (err: any) => { if (err) throw err; });
    assert.strictEqual(res.statusCode, 200);

    const rootDoc = (await mockFs.collection('refunds').doc(resv.refund.id).get()).data();
    const subDoc = (await mockFs.collection('orders').doc(orderId).collection('refunds').doc(resv.refund.id).get()).data();
    const orderDoc = (await mockFs.collection('orders').doc(orderId).get()).data();

    assert.strictEqual(rootDoc.status, 'FAILED');
    assert.strictEqual(subDoc.status, 'FAILED');
    assert.strictEqual(rootDoc.error_code, 'BANK_DECLINED');
    assert.strictEqual(subDoc.error_code, 'BANK_DECLINED');
    assert.strictEqual(orderDoc.pending_refund_amount_paise, 0);
    assert.strictEqual(orderDoc.total_refunded_amount_paise, 0);
    assert.strictEqual(orderDoc.refund_status, 'FAILED');
    console.log('   PASS: Normal refund.failed with receipt released pending amount and synced root + subcollection.');
  }

  // 2. refund.failed with razorpay_refund_id only (no receipt)
  console.log('2. Testing refund.failed with razorpay_refund_id only (no receipt)...');
  {
    const orderId = 'ORD-RF-FAIL-2';
    const paymentId = 'pay_rf_fail_2';
    await seedOrder(mockFs, orderId, paymentId, 100);

    const resv = await createPendingRefundReservation(db, {
      orderId,
      amount_paise: 100,
      reason: 'test_rp_refund_id_match',
      initiated_by: 'admin@caffix.com',
      idempotency_key: 'idem_rf_fail_2'
    });
    await recordPendingRefundGatewayId(db, {
      refundId: resv.refund.id,
      razorpay_refund_id: 'rfnd_fail_only_2'
    });

    const req = buildSignedWebhookReq(
      {
        id: 'evt_rf_fail_2',
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_fail_only_2',
              payment_id: paymentId,
              receipt: null,
              amount: 100,
              currency: 'INR',
              error_code: 'GATEWAY_ERROR',
              error_description: 'Gateway refund failed'
            }
          }
        }
      },
      'evt_rf_fail_2'
    );
    const res = mockResponse();
    await handleRazorpayWebhook(req, res, (err: any) => { if (err) throw err; });
    assert.strictEqual(res.statusCode, 200);

    const rootDoc = (await mockFs.collection('refunds').doc(resv.refund.id).get()).data();
    const subDoc = (await mockFs.collection('orders').doc(orderId).collection('refunds').doc(resv.refund.id).get()).data();
    const orderDoc = (await mockFs.collection('orders').doc(orderId).get()).data();

    assert.strictEqual(rootDoc.status, 'FAILED');
    assert.strictEqual(subDoc.status, 'FAILED');
    assert.strictEqual(orderDoc.pending_refund_amount_paise, 0);
    assert.strictEqual(orderDoc.refund_status, 'FAILED');
    console.log('   PASS: refund.failed with razorpay_refund_id matched and updated both collections.');
  }

  // 3 & 4. refund.failed without receipt or razorpay_refund_id AFTER Vercel MockDatabase cold-start reset
  console.log('3 & 4. Testing refund.failed without receipt/refund_id across Vercel MockDatabase cold start...');
  {
    const orderId = 'ORD-RF-FAIL-COLD-3';
    const paymentId = 'pay_rf_fail_cold_3';
    await seedOrder(mockFs, orderId, paymentId, 100);

    // Reservation exists in Firestore (e.g., created before gateway timeout, so razorpay_refund_id is null)
    const resv = await createPendingRefundReservation(db, {
      orderId,
      amount_paise: 100,
      reason: 'test_cold_start_payment_fallback',
      initiated_by: 'admin@caffix.com',
      idempotency_key: 'idem_rf_fail_cold_3'
    });

    // Simulate Vercel serverless cold start: empty MockDatabase & empty in-memory syncedRefundsStore
    resetMockDatabaseForColdStartSimulation();
    const coldDb = await initDB();
    clearSyncedRefundsStore();
    const memRows = await coldDb.all('SELECT * FROM refunds WHERE razorpay_payment_id = ? AND status = ?', [paymentId, 'PENDING']);
    assert.strictEqual(memRows.length, 0, 'MockDatabase must start empty after cold start');

    const req = buildSignedWebhookReq(
      {
        id: 'evt_rf_fail_cold_3',
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: '',
              payment_id: paymentId,
              receipt: null,
              amount: 100,
              currency: 'INR',
              error_code: 'UPI_REFUND_FAILED',
              error_description: 'UPI bank reversal failed'
            }
          }
        }
      },
      'evt_rf_fail_cold_3'
    );
    const res = mockResponse();
    await handleRazorpayWebhook(req, res, (err: any) => { if (err) throw err; });
    assert.strictEqual(res.statusCode, 200);

    const rootDoc = (await mockFs.collection('refunds').doc(resv.refund.id).get()).data();
    const subDoc = (await mockFs.collection('orders').doc(orderId).collection('refunds').doc(resv.refund.id).get()).data();
    const orderDoc = (await mockFs.collection('orders').doc(orderId).get()).data();

    assert.strictEqual(rootDoc.status, 'FAILED');
    assert.strictEqual(subDoc.status, 'FAILED');
    assert.strictEqual(orderDoc.pending_refund_amount_paise, 0);
    assert.strictEqual(orderDoc.total_refunded_amount_paise, 0);
    assert.strictEqual(orderDoc.refund_status, 'FAILED');

    // Also verify MockDatabase.all SQL filtering directly for non-Firestore mode compatibility
    const nowSql = new Date().toISOString();
    const insertSql = `INSERT INTO refunds (
      id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id,
      amount_paise, currency, status, reason, notes, initiated_by,
      source, idempotency_key, error_code, error_description,
      created_at, updated_at, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await coldDb.run(insertSql, [
      'RFND-SQL-1', 'ORD-SQL-1', 'CFX-MC-02', 'pay_sql_target', null,
      100, 'INR', 'PENDING', 'test', null, 'admin',
      'SUPER_ADMIN_PORTAL', 'idem_sql_filter_1', null, null,
      nowSql, nowSql, null
    ]);
    await coldDb.run(insertSql, [
      'RFND-SQL-2', 'ORD-SQL-2', 'CFX-MC-02', 'pay_sql_other', null,
      100, 'INR', 'PENDING', 'test', null, 'admin',
      'SUPER_ADMIN_PORTAL', 'idem_sql_filter_2', null, null,
      nowSql, nowSql, null
    ]);
    await coldDb.run(insertSql, [
      'RFND-SQL-3', 'ORD-SQL-3', 'CFX-MC-02', 'pay_sql_target', null,
      100, 'INR', 'PROCESSED', 'test', null, 'admin',
      'SUPER_ADMIN_PORTAL', 'idem_sql_filter_3', null, null,
      nowSql, nowSql, nowSql
    ]);
    const filteredMockRows = await coldDb.all(
      'SELECT * FROM refunds WHERE razorpay_payment_id = ? AND status = ?',
      ['pay_sql_target', 'PENDING']
    );
    assert.strictEqual(filteredMockRows.length, 1);
    assert.strictEqual(filteredMockRows[0].id, 'RFND-SQL-1');
    console.log('   PASS: Cold-start Firestore fallback + MockDatabase SQL WHERE filtering both verified.');
  }

  // 5. Duplicate refund.failed webhook (deduplication + idempotent replay)
  console.log('5. Testing duplicate refund.failed webhook deduplication...');
  {
    const reqDup = buildSignedWebhookReq(
      {
        id: 'evt_rf_fail_cold_3',
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: '',
              payment_id: 'pay_rf_fail_cold_3',
              receipt: null,
              amount: 100,
              currency: 'INR',
              error_code: 'UPI_REFUND_FAILED'
            }
          }
        }
      },
      'evt_rf_fail_cold_3'
    );
    const resDup = mockResponse();
    await handleRazorpayWebhook(reqDup, resDup, (err: any) => { if (err) throw err; });
    assert.strictEqual(resDup.statusCode, 200);
    assert.strictEqual(resDup.body?.deduplicated, true);

    const orderDoc = (await mockFs.collection('orders').doc('ORD-RF-FAIL-COLD-3').get()).data();
    assert.strictEqual(orderDoc.pending_refund_amount_paise, 0);
    assert.strictEqual(orderDoc.refund_status, 'FAILED');
    assert.strictEqual(orderDoc.refund_version, 2, 'Duplicate webhook must not re-mutate order refund_version');
    console.log('   PASS: Duplicate refund.failed event deduplicated cleanly.');
  }

  // 6. Already PROCESSED refund receiving late FAILED event
  console.log('6. Testing already PROCESSED refund receiving late refund.failed event...');
  {
    const orderId = 'ORD-RF-PROC-LATE-FAIL';
    const paymentId = 'pay_rf_proc_late';
    await seedOrder(mockFs, orderId, paymentId, 100);

    const resv = await createPendingRefundReservation(db, {
      orderId,
      amount_paise: 100,
      reason: 'test_terminal_protection',
      initiated_by: 'admin@caffix.com',
      idempotency_key: 'idem_rf_proc_late'
    });
    await markRefundProcessed(db, {
      refundId: resv.refund.id,
      razorpay_refund_id: 'rfnd_proc_late_1'
    });

    // Simulate stale local MockDatabase entry still saying PENDING while Firestore says PROCESSED
    resetMockDatabaseForColdStartSimulation();
    const staleDb = await initDB();
    await staleDb.run(
      `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, currency, status, reason, notes, initiated_by, source, idempotency_key, error_code, error_description, created_at, updated_at, processed_at)
       VALUES (?, ?, 'CFX-MC-02', ?, 'rfnd_proc_late_1', 100, 'INR', 'PENDING', 'stale', NULL, 'admin', 'SUPER_ADMIN_PORTAL', 'idem_rf_proc_late_stale', NULL, NULL, ?, ?, NULL)`,
      [resv.refund.id, orderId, paymentId, new Date().toISOString(), new Date().toISOString()]
    );

    const reqByRpId = buildSignedWebhookReq(
      {
        id: 'evt_late_fail_by_rpid',
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_proc_late_1',
              payment_id: paymentId,
              receipt: null,
              amount: 100,
              currency: 'INR',
              error_code: 'LATE_WEBHOOK_ERROR'
            }
          }
        }
      },
      'evt_late_fail_by_rpid'
    );
    const res1 = mockResponse();
    await handleRazorpayWebhook(reqByRpId, res1, (err: any) => { if (err) throw err; });
    assert.strictEqual(res1.statusCode, 200);

    // Also test late FAILED without receipt or razorpay_refund_id
    const reqNoIds = buildSignedWebhookReq(
      {
        id: 'evt_late_fail_no_ids',
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: '',
              payment_id: paymentId,
              receipt: null,
              amount: 100,
              currency: 'INR',
              error_code: 'LATE_WEBHOOK_ERROR'
            }
          }
        }
      },
      'evt_late_fail_no_ids'
    );
    const res2 = mockResponse();
    await handleRazorpayWebhook(reqNoIds, res2, (err: any) => { if (err) throw err; });
    assert.strictEqual(res2.statusCode, 200);

    const rootDoc = (await mockFs.collection('refunds').doc(resv.refund.id).get()).data();
    const subDoc = (await mockFs.collection('orders').doc(orderId).collection('refunds').doc(resv.refund.id).get()).data();
    const orderDoc = (await mockFs.collection('orders').doc(orderId).get()).data();

    assert.strictEqual(rootDoc.status, 'PROCESSED');
    assert.strictEqual(subDoc.status, 'PROCESSED');
    assert.strictEqual(orderDoc.total_refunded_amount_paise, 100);
    assert.strictEqual(orderDoc.pending_refund_amount_paise, 0);
    assert.strictEqual(orderDoc.refund_status, 'FULL');
    console.log('   PASS: Already PROCESSED refund preserved even against stale local cache & late FAILED webhooks.');
  }

  // 7. Multiple pending refunds for the same payment
  console.log('7. Testing multiple pending refunds for the same payment...');
  {
    const orderId = 'ORD-RF-MULTI-PEND';
    const paymentId = 'pay_rf_multi_pend';
    await seedOrder(mockFs, orderId, paymentId, 10000);

    const resvA = await createPendingRefundReservation(db, {
      orderId,
      amount_paise: 3000,
      reason: 'partial_pending_A',
      initiated_by: 'admin@caffix.com',
      idempotency_key: 'idem_multi_pend_A'
    });
    const resvB = await createPendingRefundReservation(db, {
      orderId,
      amount_paise: 4000,
      reason: 'partial_pending_B',
      initiated_by: 'admin@caffix.com',
      idempotency_key: 'idem_multi_pend_B'
    });

    resetMockDatabaseForColdStartSimulation();
    await initDB();
    clearSyncedRefundsStore();

    // 7a. Ambiguous refund.failed without receipt or razorpay_refund_id must release NEITHER
    const reqAmbiguous = buildSignedWebhookReq(
      {
        id: 'evt_multi_ambig',
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: '',
              payment_id: paymentId,
              receipt: null,
              amount: 3000,
              currency: 'INR',
              error_code: 'AMBIGUOUS_FAILURE'
            }
          }
        }
      },
      'evt_multi_ambig'
    );
    const resAmbig = mockResponse();
    await handleRazorpayWebhook(reqAmbiguous, resAmbig, (err: any) => { if (err) throw err; });
    assert.strictEqual(resAmbig.statusCode, 200);

    const docA1 = (await mockFs.collection('refunds').doc(resvA.refund.id).get()).data();
    const docB1 = (await mockFs.collection('refunds').doc(resvB.refund.id).get()).data();
    const ord1 = (await mockFs.collection('orders').doc(orderId).get()).data();
    assert.strictEqual(docA1.status, 'PENDING');
    assert.strictEqual(docB1.status, 'PENDING');
    assert.strictEqual(ord1.pending_refund_amount_paise, 7000);

    // 7b. Once A settles to PROCESSED, a subsequent refund.failed without IDs uniquely resolves B
    await markRefundProcessed(db, {
      refundId: resvA.refund.id,
      razorpay_refund_id: 'rfnd_multi_A'
    });
    resetMockDatabaseForColdStartSimulation();
    await initDB();
    clearSyncedRefundsStore();

    const reqUniqueB = buildSignedWebhookReq(
      {
        id: 'evt_multi_unique_B',
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: '',
              payment_id: paymentId,
              receipt: null,
              amount: 4000,
              currency: 'INR',
              error_code: 'UNIQUE_B_FAILURE'
            }
          }
        }
      },
      'evt_multi_unique_B'
    );
    const resUniqueB = mockResponse();
    await handleRazorpayWebhook(reqUniqueB, resUniqueB, (err: any) => { if (err) throw err; });
    assert.strictEqual(resUniqueB.statusCode, 200);

    const docA2 = (await mockFs.collection('refunds').doc(resvA.refund.id).get()).data();
    const docB2 = (await mockFs.collection('refunds').doc(resvB.refund.id).get()).data();
    const subB2 = (await mockFs.collection('orders').doc(orderId).collection('refunds').doc(resvB.refund.id).get()).data();
    const ord2 = (await mockFs.collection('orders').doc(orderId).get()).data();

    assert.strictEqual(docA2.status, 'PROCESSED');
    assert.strictEqual(docB2.status, 'FAILED');
    assert.strictEqual(subB2.status, 'FAILED');
    assert.strictEqual(ord2.total_refunded_amount_paise, 3000);
    assert.strictEqual(ord2.pending_refund_amount_paise, 0);
    assert.strictEqual(ord2.refund_status, 'PARTIAL');
    console.log('   PASS: Ambiguous multiple PENDING refunds preserved; unique remaining PENDING refund released after sibling settled.');
  }

  console.log('\nALL PHASE H.3 REFUND.FAILED WEBHOOK RECONCILIATION TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
