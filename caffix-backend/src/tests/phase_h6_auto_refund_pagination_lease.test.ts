import assert from 'assert';
import { FieldPath } from 'firebase-admin/firestore';

delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
delete process.env.STRICT_FIREBASE_VALIDATION;
process.env.JWT_SECRET = 'phase-h6-test-jwt-secret-2026';
process.env.KIOSK_SECRET = 'phase-h6-test-kiosk-secret-2026';
process.env.CRON_SECRET = 'phase-h6-test-cron-secret-2026';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDB } = require('../config/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  AUTO_REFUND_CRON_LOCK_DOC_ID,
  AUTO_REFUND_STATE_COLLECTION,
  getAutoRefundCursorInFirebase,
  getAutoRefundSweepControlInFirebase,
  getManualReviewAnomalyOrdersFromFirebase,
  getPendingRefundOrdersFromFirebase,
  releaseAutoRefundLeaseInFirebase,
  resetFirestoreSeedStateForTesting,
  setFirestoreForTesting
} = require('../utils/firebase');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { clearSyncedRefundsStore } = require('../utils/refunds');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRazorpayRefundClientForTesting } = require('../utils/razorpayRefundClient');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  evaluateAutoRefundEligibility,
  reconcilePendingRefundsForOrder,
  runAutoRefundSweep
} = require('../services/autoRefundService');

type StoreMap = Map<string, Map<string, any>>;

class MockFirestore {
  private collections: StoreMap = new Map();
  public writeCount = 0;
  public queryErrorMachines = new Set<string>();
  public onBeforeTxCommitHook: ((txId: number) => void) | null = null;
  private txSeq = 0;

  clear() {
    this.collections.clear();
    this.writeCount = 0;
    this.queryErrorMachines.clear();
    this.onBeforeTxCommitHook = null;
  }

  private getCol(name: string): Map<string, any> {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
    return this.collections.get(name)!;
  }

  seed(col: string, id: string, data: any) {
    this.getCol(col).set(id, JSON.parse(JSON.stringify(data)));
  }

  readRaw(col: string, id: string): any | null {
    const val = this.getCol(col).get(id);
    return val ? JSON.parse(JSON.stringify(val)) : null;
  }

  private makeDocSnap(col: string, id: string) {
    const data = this.getCol(col).get(id);
    return {
      id,
      exists: Boolean(data),
      data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined)
    };
  }

  collection(colName: string): any {
    const self = this;

    const buildQuery = (
      filters: Array<{ field: string; op: string; val: any }> = [],
      orders: Array<{ field: any; dir: 'asc' | 'desc' }> = [],
      startAfterVals: any[] | null = null,
      limitVal: number | null = null
    ): any => ({
      where(field: string, op: string, val: any) {
        return buildQuery([...filters, { field, op, val }], orders, startAfterVals, limitVal);
      },
      orderBy(field: any, dir: 'asc' | 'desc' = 'asc') {
        return buildQuery(filters, [...orders, { field, dir }], startAfterVals, limitVal);
      },
      startAfter(...vals: any[]) {
        return buildQuery(filters, orders, vals, limitVal);
      },
      limit(n: number) {
        return buildQuery(filters, orders, startAfterVals, n);
      },
      async get() {
        const machineFilter = filters.find((f) => f.field === 'machine_id' && f.op === '==');
        if (machineFilter && self.queryErrorMachines.has(String(machineFilter.val))) {
          throw new Error(`Injected Firestore query failure for ${machineFilter.val}`);
        }

        let entries = Array.from(self.getCol(colName).entries()).map(([id, data]) => ({
          id,
          data: JSON.parse(JSON.stringify(data))
        }));

        for (const f of filters) {
          entries = entries.filter(({ data }) => {
            const v = data[f.field];
            if (f.op === '==') return v === f.val;
            if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(v);
            if (f.op === '>') return Number(v) > Number(f.val);
            return true;
          });
        }

        const isDocIdField = (field: any) =>
          field === '__name__' || field === FieldPath.documentId() || (typeof field === 'object' && field !== null);

        const getSortVal = (entry: { id: string; data: any }, field: any) =>
          isDocIdField(field) ? entry.id : entry.data[field];

        if (orders.length > 0) {
          entries.sort((a, b) => {
            for (const o of orders) {
              const av = getSortVal(a, o.field);
              const bv = getSortVal(b, o.field);
              let cmp = 0;
              if (typeof av === 'number' && typeof bv === 'number') {
                cmp = av - bv;
              } else {
                cmp = String(av ?? '').localeCompare(String(bv ?? ''));
              }
              if (cmp !== 0) return o.dir === 'desc' ? -cmp : cmp;
            }
            return 0;
          });
        }

        if (startAfterVals && startAfterVals.length > 0 && orders.length > 0) {
          entries = entries.filter((entry) => {
            for (let i = 0; i < Math.min(orders.length, startAfterVals.length); i += 1) {
              const av = getSortVal(entry, orders[i].field);
              const tv = startAfterVals[i];
              let cmp = 0;
              if (typeof av === 'number' && typeof tv === 'number') cmp = av - tv;
              else cmp = String(av ?? '').localeCompare(String(tv ?? ''));
              if (cmp !== 0) return orders[i].dir === 'desc' ? cmp < 0 : cmp > 0;
            }
            return false;
          });
        }

        if (limitVal !== null) {
          entries = entries.slice(0, limitVal);
        }

        const docs = entries.map((e) => ({
          id: e.id,
          exists: true,
          data: () => JSON.parse(JSON.stringify(e.data))
        }));
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
          forEach: (cb: (d: any) => void) => docs.forEach(cb)
        };
      }
    });

    return {
      ...buildQuery(),
      doc(id: string) {
        return {
          __col: colName,
          __id: id,
          id,
          async get() {
            return self.makeDocSnap(colName, id);
          },
          async set(data: any, opts?: { merge?: boolean }) {
            self.writeCount += 1;
            const prev = opts?.merge ? self.getCol(colName).get(id) || {} : {};
            self.getCol(colName).set(id, JSON.parse(JSON.stringify({ ...prev, ...data })));
          },
          collection(subName: string) {
            return self.collection(`${colName}/${id}/${subName}`);
          }
        };
      }
    };
  }

  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const txId = ++this.txSeq;
    const reads = new Map<string, string>();
    const pendingWrites: Array<{ col: string; id: string; data: any; merge?: boolean }> = [];

    const tx = {
      get: async (ref: any) => {
        if (!ref.__id && typeof ref.get === 'function') {
          return ref.get();
        }
        const snap = this.makeDocSnap(ref.__col, ref.__id);
        reads.set(`${ref.__col}::${ref.__id}`, JSON.stringify(snap.data() ?? null));
        return snap;
      },
      set: (ref: any, data: any, opts?: { merge?: boolean }) => {
        pendingWrites.push({ col: ref.__col, id: ref.__id, data, merge: opts?.merge });
      },
      update: (ref: any, data: any) => {
        pendingWrites.push({ col: ref.__col, id: ref.__id, data, merge: true });
      }
    };

    const result = await fn(tx);
    if (this.onBeforeTxCommitHook) {
      this.onBeforeTxCommitHook(txId);
    }

    // Optimistic concurrency check on read-set
    for (const [key, prevJson] of reads.entries()) {
      const [col, id] = key.split('::');
      const curData = this.getCol(col).get(id) ?? null;
      if (JSON.stringify(curData) !== prevJson) {
        throw new Error(`TRANSACTION_CONFLICT on ${col}/${id}`);
      }
    }

    for (const w of pendingWrites) {
      this.writeCount += 1;
      const prev = w.merge ? this.getCol(w.col).get(w.id) || {} : {};
      this.getCol(w.col).set(w.id, JSON.parse(JSON.stringify({ ...prev, ...w.data })));
    }
    return result;
  }
}

function makeOrder(
  id: string,
  machineId: string,
  createdAtIso: string,
  overrides: Record<string, any> = {}
) {
  return {
    id,
    machine_id: machineId,
    product_id: 1,
    product_name: 'Espresso',
    amount: 50,
    captured_amount_paise: 5000,
    total_refunded_amount_paise: 0,
    pending_refund_amount_paise: 0,
    refund_status: 'NONE',
    status: 'PAID',
    dispense_status: 'QUEUED',
    dispensed: false,
    razorpay_payment_id: `pay_${id}`,
    created_at: createdAtIso,
    paid_at: createdAtIso,
    ...overrides
  };
}

async function runTests() {
  await initDB();
  const mockFs = new MockFirestore();
  setFirestoreForTesting({ firestoreInstance: mockFs as any });

  let gatewayCreateCalls = 0;
  let gatewayFetchCalls = 0;
  setRazorpayRefundClientForTesting({
    payments: {
      refund: async (paymentId: string, opts: any) => {
        gatewayCreateCalls += 1;
        return {
          id: `rfnd_${paymentId}_${gatewayCreateCalls}`,
          payment_id: paymentId,
          amount: opts.amount,
          currency: 'INR',
          status: 'processed'
        };
      }
    },
    refunds: {
      fetch: async (refundId: string) => {
        gatewayFetchCalls += 1;
        return { id: refundId, status: 'processed', amount: 5000, currency: 'INR' };
      }
    }
  });

  const resetEnv = () => {
    mockFs.clear();
    clearSyncedRefundsStore();
    resetFirestoreSeedStateForTesting();
    gatewayCreateCalls = 0;
    gatewayFetchCalls = 0;
    mockFs.seed('machines', 'CFX-MC-01', { id: 'CFX-MC-01', name: 'M1' });
  };

  // -----------------------------------------------------------------------
  // TEST 1: Fail-closed missing & unknown dispense_status + manual review
  // -----------------------------------------------------------------------
  {
    resetEnv();
    const baseMs = Date.parse('2026-11-28T10:00:00.000Z');
    const oldIso = new Date(baseMs - 10 * 60_000).toISOString();
    mockFs.seed('orders', 'ord_missing_ds', makeOrder('ord_missing_ds', 'CFX-MC-01', oldIso, { dispense_status: undefined }));
    mockFs.seed('orders', 'ord_unknown_ds', makeOrder('ord_unknown_ds', 'CFX-MC-01', oldIso, { dispense_status: 'MYSTERY_STATE' }));
    mockFs.seed('orders', 'ord_completed_anom', makeOrder('ord_completed_anom', 'CFX-MC-01', oldIso, { status: 'COMPLETED', dispense_status: 'DISPENSED', dispensed: false, refund_status: 'NONE' }));

    const evalMissing = evaluateAutoRefundEligibility(mockFs.readRaw('orders', 'ord_missing_ds'), baseMs);
    const evalUnknown = evaluateAutoRefundEligibility(mockFs.readRaw('orders', 'ord_unknown_ds'), baseMs);
    assert.strictEqual(evalMissing.eligible, false);
    assert.strictEqual(evalMissing.skipReason, 'UNCERTAIN_DISPENSE_OUTCOME');
    assert.strictEqual(evalUnknown.eligible, false);
    assert.strictEqual(evalUnknown.skipReason, 'UNCERTAIN_DISPENSE_OUTCOME');

    const anomalies = await getManualReviewAnomalyOrdersFromFirebase(null, { machineId: 'CFX-MC-01', limit: 20 });
    const anomalyIds = anomalies.map((a: any) => a.id);
    assert(anomalyIds.includes('ord_missing_ds'));
    assert(anomalyIds.includes('ord_unknown_ds'));
    assert(anomalyIds.includes('ord_completed_anom'));

    const sweep = await runAutoRefundSweep({ nowMs: baseMs, limit: 20 });
    assert.strictEqual(sweep.eligible, 0);
    assert.strictEqual(gatewayCreateCalls, 0);
    assert(Number(sweep.manual_review_anomaly_count) >= 3);
    console.log('PASS: Test 1 - Fail-closed missing/unknown dispense_status & manual review');
  }

  // -----------------------------------------------------------------------
  // TEST 2: > 2,000 ineligible orders & non-expired order rediscovery
  // -----------------------------------------------------------------------
  {
    resetEnv();
    const baseMs = Date.parse('2026-11-28T10:00:00.000Z');
    // 2,100 DISPENSED orders + 1 expired QUEUED order
    for (let i = 0; i < 2100; i += 1) {
      const ts = new Date(baseMs - 60 * 60_000 + i * 100).toISOString();
      mockFs.seed('orders', `disp_${String(i).padStart(4, '0')}`, makeOrder(`disp_${String(i).padStart(4, '0')}`, 'CFX-MC-01', ts, { dispense_status: 'DISPENSED', dispensed: true }));
    }
    const expIso = new Date(baseMs - 10 * 60_000).toISOString();
    mockFs.seed('orders', 'queued_exp_after_disp', makeOrder('queued_exp_after_disp', 'CFX-MC-01', expIso));

    const sweep = await runAutoRefundSweep({ nowMs: baseMs, limit: 20 });
    assert.strictEqual(sweep.eligible, 1);
    assert.strictEqual(sweep.refunded_processed, 1);
    assert.strictEqual(gatewayCreateCalls, 1);
    console.log('PASS: Test 2a - > 2,000 DISPENSED orders do not block eligible QUEUED order');
  }

  {
    resetEnv();
    const baseMs = Date.parse('2026-11-28T10:00:00.000Z');
    // Non-expired Order A (2m old) followed by eligible Order B (FAILED PRE_DISPENSE)
    const twoMinAgo = new Date(baseMs - 2 * 60_000).toISOString();
    const oneMinAgo = new Date(baseMs - 1 * 60_000).toISOString();
    mockFs.seed('orders', 'ord_A_young', makeOrder('ord_A_young', 'CFX-MC-01', twoMinAgo, { dispense_status: 'QUEUED' }));
    mockFs.seed('orders', 'ord_B_failed', makeOrder('ord_B_failed', 'CFX-MC-01', oneMinAgo, { dispense_status: 'FAILED', failure_stage: 'PRE_DISPENSE', dispense_outcome: 'NOT_DISPENSED' }));

    const s1 = await runAutoRefundSweep({ nowMs: baseMs, limit: 20 });
    assert.strictEqual(s1.eligible, 1);
    assert.strictEqual(s1.skipped_not_expired, 1);
    assert.strictEqual(gatewayCreateCalls, 1);

    // Advance clock by 4 minutes -> ord_A_young is now 6m old; wrap-around rediscovers it!
    const s2 = await runAutoRefundSweep({ nowMs: baseMs + 4 * 60_000, limit: 20 });
    assert.strictEqual(s2.eligible, 1);
    assert.strictEqual(gatewayCreateCalls, 2);
    console.log('PASS: Test 2b - Non-expired order passed by cursor is rediscovered after wrap-around');
  }

  // -----------------------------------------------------------------------
  // TEST 3: Exact 100, 200, 300 queue boundaries & quota stop
  // -----------------------------------------------------------------------
  for (const count of [100, 200, 300]) {
    resetEnv();
    const baseMs = Date.parse('2026-11-28T10:00:00.000Z');
    const twoMinAgo = baseMs - 2 * 60_000;
    for (let i = 0; i < count; i += 1) {
      const id = `q_${String(i).padStart(4, '0')}`;
      mockFs.seed('orders', id, makeOrder(id, 'CFX-MC-01', new Date(twoMinAgo + i).toISOString()));
    }

    const s1 = await runAutoRefundSweep({ nowMs: baseMs, limit: 20 });
    assert.strictEqual(s1.eligible, 0);
    const cur1 = await getAutoRefundCursorInFirebase('CFX-MC-01');
    if (count < 300) {
      assert.strictEqual(cur1.last_order_id, null, `Count ${count} should wrap to null`);
    } else {
      assert.strictEqual(cur1.last_order_id, 'q_0299', 'Count 300 hits scan cap and must NOT reset cursor');
      const s2 = await runAutoRefundSweep({ nowMs: baseMs, limit: 20 });
      assert.strictEqual(s2.errors, 0);
      const cur2 = await getAutoRefundCursorInFirebase('CFX-MC-01');
      assert.strictEqual(cur2.last_order_id, null, 'Sweep 2 probes empty after q_0299 and resets cursor');
    }
  }
  console.log('PASS: Test 3 - Exact 100, 200, 300 end-of-queue boundaries');

  // -----------------------------------------------------------------------
  // TEST 4: Identical created_at tie-breaking + multi-machine fairness + rotation errors + explicit machine_id
  // -----------------------------------------------------------------------
  {
    resetEnv();
    const baseMs = Date.parse('2026-11-28T10:00:00.000Z');
    const sameTs = new Date(baseMs - 10 * 60_000).toISOString();
    for (const id of ['ord_a', 'ord_b', 'ord_c', 'ord_d', 'ord_e']) {
      mockFs.seed('orders', id, makeOrder(id, 'CFX-MC-01', sameTs));
    }
    const s1 = await runAutoRefundSweep({ nowMs: baseMs, limit: 2 });
    assert.strictEqual(s1.eligible, 2);
    assert.strictEqual((await getAutoRefundCursorInFirebase('CFX-MC-01')).last_order_id, 'ord_b');
    const s2 = await runAutoRefundSweep({ nowMs: baseMs, limit: 2 });
    assert.strictEqual(s2.eligible, 2);
    assert.strictEqual((await getAutoRefundCursorInFirebase('CFX-MC-01')).last_order_id, 'ord_d');
    const s3 = await runAutoRefundSweep({ nowMs: baseMs, limit: 2 });
    assert.strictEqual(s3.eligible, 1);
    assert.strictEqual((await getAutoRefundCursorInFirebase('CFX-MC-01')).last_order_id, null);
    console.log('PASS: Test 4a - Identical created_at tie-breaking with FieldPath.documentId()');
  }

  {
    resetEnv();
    mockFs.seed('machines', 'CFX-MC-02', { id: 'CFX-MC-02', name: 'M2' });
    mockFs.seed('machines', 'CFX-MC-03', { id: 'CFX-MC-03', name: 'M3' });
    const baseMs = Date.parse('2026-11-28T10:00:00.000Z');
    const expIso = new Date(baseMs - 10 * 60_000).toISOString();
    // Corrupt MC-02 cursor, inject query error on MC-01, leave MC-03 healthy
    mockFs.seed(AUTO_REFUND_STATE_COLLECTION, 'cursor_CFX-MC-02', {
      machine_id: 'CFX-MC-02',
      last_created_at: 'not-a-valid-date',
      last_order_id: 'bad',
      version: 1
    });
    mockFs.queryErrorMachines.add('CFX-MC-01');
    mockFs.seed('orders', 'mc2_1', makeOrder('mc2_1', 'CFX-MC-02', expIso));
    mockFs.seed('orders', 'mc3_1', makeOrder('mc3_1', 'CFX-MC-03', expIso));

    // Explicit machine_id sweep does NOT touch machine_rr_index
    const rrBefore = (await getAutoRefundSweepControlInFirebase()).machine_rr_index;
    await runAutoRefundSweep({ nowMs: baseMs, machineId: 'CFX-MC-03', limit: 5 });
    const rrAfterExplicit = (await getAutoRefundSweepControlInFirebase()).machine_rr_index;
    assert.strictEqual(rrAfterExplicit, rrBefore, 'Explicit machine_id must not mutate machine_rr_index');

    // Fleet sweep continues past MC-01 error and resets corrupted MC-02 cursor
    const fleet = await runAutoRefundSweep({ nowMs: baseMs, limit: 10 });
    assert.strictEqual(fleet.errors, 1);
    assert.strictEqual(fleet.eligible, 1); // mc2_1 processed after cursor reset
    const rrAfterFleet = (await getAutoRefundSweepControlInFirebase()).machine_rr_index;
    assert.strictEqual(rrAfterFleet, (rrBefore + 1) % 3);
    console.log('PASS: Test 4b - Multi-machine rotation resilience & explicit machine_id isolation');
  }

  // -----------------------------------------------------------------------
  // TEST 5: Pending refund discovery (refunds + zero/missing pending_refund_amount_paise)
  // -----------------------------------------------------------------------
  {
    resetEnv();
    const baseMs = Date.parse('2026-11-28T10:00:00.000Z');
    const oldIso = new Date(baseMs - 10 * 60_000).toISOString();
    mockFs.seed('orders', 'ord_zero_pending', makeOrder('ord_zero_pending', 'CFX-MC-01', oldIso, {
      refund_status: 'PENDING',
      pending_refund_amount_paise: 0
    }));
    mockFs.seed('orders', 'ord_from_refunds_col', makeOrder('ord_from_refunds_col', 'CFX-MC-01', oldIso, {
      refund_status: 'NONE',
      pending_refund_amount_paise: 0
    }));
    mockFs.seed('refunds', 'rfnd_pending_1', {
      id: 'rfnd_pending_1',
      order_id: 'ord_from_refunds_col',
      machine_id: 'CFX-MC-01',
      status: 'PENDING',
      amount_paise: 5000,
      created_at: oldIso
    });

    const pending = await getPendingRefundOrdersFromFirebase(null, { limit: 20, hydrateLocal: false });
    const pendingIds = pending.map((p: any) => p.id);
    assert(pendingIds.includes('ord_zero_pending'));
    assert(pendingIds.includes('ord_from_refunds_col'));
    console.log('PASS: Test 5 - Pending refund discovery via refunds collection & zero pending_refund_amount_paise');
  }

  // -----------------------------------------------------------------------
  // TEST 6: Lease safety, atomic renewal, durable PENDING intent, & dry_run invariance
  // -----------------------------------------------------------------------
  {
    resetEnv();
    const baseMs = Date.parse('2026-11-28T10:00:00.000Z');
    const expIso = new Date(baseMs - 10 * 60_000).toISOString();
    mockFs.seed('orders', 'ord_lease_1', makeOrder('ord_lease_1', 'CFX-MC-01', expIso));

    // Active lease blocks fleet AND explicit machine_id sweeps
    mockFs.seed('system_locks', AUTO_REFUND_CRON_LOCK_DOC_ID, {
      active: true,
      lock_id: 'lock-B',
      owner: 'other_sweep',
      locked_until_ms: Date.now() + 60_000
    });
    const blockedFleet = await runAutoRefundSweep({ nowMs: baseMs, limit: 10 });
    const blockedMachine = await runAutoRefundSweep({ nowMs: baseMs, machineId: 'CFX-MC-01', limit: 10 });
    assert.strictEqual(blockedFleet.skipped_due_to_active_run, true);
    assert.strictEqual(blockedMachine.skipped_due_to_active_run, true);

    // Old sweep A cannot release lock-B
    await releaseAutoRefundLeaseInFirebase('lock-A');
    assert.strictEqual(mockFs.readRaw('system_locks', AUTO_REFUND_CRON_LOCK_DOC_ID).lock_id, 'lock-B');
    assert.strictEqual(mockFs.readRaw('system_locks', AUTO_REFUND_CRON_LOCK_DOC_ID).active, true);

    // dry_run=true writes 0 documents and calls 0 gateway methods
    const writesBeforeDry = mockFs.writeCount;
    const dryRes = await runAutoRefundSweep({ nowMs: baseMs, dryRun: true, limit: 10 });
    assert.strictEqual(dryRes.dry_run, true);
    assert.strictEqual(dryRes.eligible, 1);
    assert.strictEqual(mockFs.writeCount, writesBeforeDry, 'dry_run=true must perform zero Firestore writes');
    assert.strictEqual(gatewayCreateCalls, 0);
    console.log('PASS: Test 6a - Lease mutual exclusion, safe release, and dry_run zero-write isolation');
  }

  {
    // Near-expiry safety margin inside transaction + ambiguous reconciliation no-auto-retry
    resetEnv();
    const baseMs = Date.parse('2026-11-28T10:00:00.000Z');
    const expIso = new Date(baseMs - 10 * 60_000).toISOString();
    mockFs.seed('orders', 'ord_tx_fence', makeOrder('ord_tx_fence', 'CFX-MC-01', expIso));

    // Simulate Sweep B taking over lock right before Sweep A commits its transaction
    let hookTriggered = false;
    mockFs.onBeforeTxCommitHook = () => {
      if (!hookTriggered) {
        // Only intercept the order/refund transaction, not the initial lease acquisition
        const curLock = mockFs.readRaw('system_locks', AUTO_REFUND_CRON_LOCK_DOC_ID);
        if (curLock && curLock.active === true && curLock.lock_id && curLock.lock_id !== 'lock-B') {
          hookTriggered = true;
          mockFs.seed('system_locks', AUTO_REFUND_CRON_LOCK_DOC_ID, {
            active: true,
            lock_id: 'lock-B',
            owner: 'sweep_B',
            locked_until_ms: Date.now() + 90_000
          });
        }
      }
    };

    const abortedSweep = await runAutoRefundSweep({ nowMs: baseMs, limit: 10 });
    mockFs.onBeforeTxCommitHook = null;
    assert.strictEqual(abortedSweep.aborted_due_to_lease_loss, true);
    assert.strictEqual(gatewayCreateCalls, 0, 'Replaced lease must prevent any gateway call');
    assert.strictEqual(mockFs.readRaw('orders', 'ord_tx_fence').refund_status, 'NONE');

    // Ambiguous PENDING reconciliation must NOT auto-resubmit
    mockFs.seed('orders', 'ord_ambig', makeOrder('ord_ambig', 'CFX-MC-01', expIso, {
      refund_status: 'PENDING',
      pending_refund_amount_paise: 5000
    }));
    mockFs.seed('orders/ord_ambig/refunds', 'rfnd_ambig', {
      id: 'rfnd_ambig',
      order_id: 'ord_ambig',
      machine_id: 'CFX-MC-01',
      status: 'PENDING',
      amount_paise: 5000,
      razorpay_refund_id: null,
      idempotency_key: 'auto_refund_ord_ambig',
      created_at: expIso
    });
    const reconRes = await reconcilePendingRefundsForOrder(null, mockFs.readRaw('orders', 'ord_ambig'));
    assert.strictEqual(reconRes.stillPending, 1);
    assert.strictEqual(gatewayCreateCalls, 0, 'Ambiguous PENDING refund must never auto-resubmit');
    console.log('PASS: Test 6b - Transactional lease fencing & no auto-retry on ambiguous PENDING');
  }

  console.log('\nALL PHASE H.6 PAGINATION & LEASE REGRESSION TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
