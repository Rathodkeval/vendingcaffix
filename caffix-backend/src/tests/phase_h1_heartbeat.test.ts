import assert from 'assert';
import http from 'http';
import jwt from 'jsonwebtoken';
import { initializeApp, getApps, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const EMULATOR_HOST = '127.0.0.1:8088';
const EMULATOR_PROJECT_ID = 'demo-caffix-emulator';

process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
process.env.FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
process.env.VERCEL = '1';
delete process.env.VERCEL_ENV;
delete process.env.STRICT_FIREBASE_VALIDATION;
process.env.JWT_SECRET = 'phase-h1-heartbeat-jwt-secret-2026';
process.env.KIOSK_SECRET = 'phase-h1-shared-kiosk-secret-2026';
process.env.ENFORCE_PER_MACHINE_SECRETS = 'true';

import app from '../index';
import { initDB, getDB, resetMockDatabaseForColdStartSimulation } from '../config/db';
import {
  HEARTBEAT_TIMEOUT_MS,
  computeConnectionStatus,
  getAuthoritativeMachineState,
  resetFirestoreSeedStateForTesting,
  setFirestoreForTesting
} from '../utils/firebase';
import { getJwtSecret } from '../utils/security';

const PORT = 5099;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function clearEmulatorDatabase() {
  const url = `http://${EMULATOR_HOST}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Failed to clear emulator database: HTTP ${res.status}`);
  }
}

async function api(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, body: payload };
}

async function runTests() {
  console.log('\n======================================================================');
  console.log('Running CAFFIX Phase H.1 — Heartbeat & Connectivity Regression Tests');
  console.log('======================================================================\n');

  for (const a of getApps()) await deleteApp(a);
  const fbApp = initializeApp({ projectId: EMULATOR_PROJECT_ID });
  const firestore = getFirestore(fbApp);
  setFirestoreForTesting({ firestoreInstance: firestore, clearStores: true });
  resetFirestoreSeedStateForTesting();
  await clearEmulatorDatabase();

  await initDB();
  const db = getDB();

  const mc1TokenSecret = 'mc01_per_machine_token_h1';
  const mc2TokenSecret = 'mc02_per_machine_token_h1';

  await firestore.collection('machines').doc('CFX-MC-01').set({
    id: 'CFX-MC-01',
    machine_name: 'ONE',
    location: 'Mumbai',
    desired_mode: 'RUNNING',
    status: 'online',
    last_seen: null,
    owner_id: 'usr_owner_1',
    kiosk_token: mc1TokenSecret,
    estimated_inventory: {
      water_level: 88,
      coffee_level: 77,
      milk_level: 66,
      vanilla_level: 90,
      hazelnut_level: 91,
      irish_level: 92,
      mocha_level: 93
    },
    updated_at: '2026-11-16T00:00:00.000Z'
  });

  await firestore.collection('machines').doc('CFX-MC-02').set({
    id: 'CFX-MC-02',
    machine_name: 'TWO',
    location: 'Delhi',
    desired_mode: 'RUNNING',
    status: 'online',
    last_seen: null,
    owner_id: 'usr_owner_2',
    kiosk_token: mc2TokenSecret,
    updated_at: '2026-11-16T00:00:00.000Z'
  });

  await firestore.collection('machines').doc('CFX-MC-03').set({
    id: 'CFX-MC-03',
    machine_name: 'THREE',
    location: 'Pune',
    desired_mode: 'RUNNING',
    status: 'online',
    last_seen: null,
    owner_id: null,
    kiosk_token: 'mc03_per_machine_token_h1',
    updated_at: '2026-11-16T00:00:00.000Z'
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', () => resolve()));

  try {
    const adminToken = jwt.sign(
      { id: 'usr_admin_1', email: 'admin@test.local', role: 'admin', portal: 'admin' },
      getJwtSecret(),
      { expiresIn: '1h' }
    );

    console.log('1. Checking initial OFFLINE state and browser polling non-mutation...');
    const verifyRes = await api(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(mc1TokenSecret)}&machine_id=CFX-MC-01`
    );
    assert.strictEqual(verifyRes.status, 200);
    assert.strictEqual(verifyRes.body.authorized, true);
    assert.strictEqual(verifyRes.body.machine_id, 'CFX-MC-01');
    const mc1Jwt = verifyRes.body.token;
    assert.ok(mc1Jwt, 'Kiosk verify must issue bound JWT');

    // Browser polling /api/machine-status must NOT set last_seen
    const statusBefore = await api('GET', '/machine-status?machine_id=CFX-MC-01', mc1Jwt);
    assert.strictEqual(statusBefore.status, 200);
    assert.strictEqual(statusBefore.body.data.connection_status, 'OFFLINE');
    assert.strictEqual(statusBefore.body.data.last_seen, null);
    console.log('   PASS: Initial OFFLINE state and read-only machine-status verified.');

    console.log('2. Testing authenticated POST /api/machines/CFX-MC-01/heartbeat...');
    const hbRes = await api('POST', '/machines/CFX-MC-01/heartbeat', mc1Jwt);
    assert.strictEqual(hbRes.status, 200);
    assert.strictEqual(hbRes.body.data.id, 'CFX-MC-01');
    assert.strictEqual(hbRes.body.data.connection_status, 'ONLINE');
    assert.strictEqual(hbRes.body.data.desired_mode, 'RUNNING');
    const recordedLastSeen = hbRes.body.data.last_seen;
    assert.ok(typeof recordedLastSeen === 'string' && !Number.isNaN(Date.parse(recordedLastSeen)));

    const fsSnap = await firestore.collection('machines').doc('CFX-MC-01').get();
    const fsData = fsSnap.data() || {};
    assert.strictEqual(fsData.last_seen, recordedLastSeen);
    assert.strictEqual(fsData.desired_mode, 'RUNNING');
    assert.strictEqual(fsData.owner_id, 'usr_owner_1');
    assert.strictEqual(fsData.kiosk_token, mc1TokenSecret);
    assert.strictEqual(fsData.estimated_inventory?.coffee_level, 77);
    console.log('   PASS: Heartbeat updated Firestore last_seen cleanly without clobbering machine fields.');

    console.log('3. Testing Admin /api/machines, Kiosk /api/machine-status, and cross-machine isolation...');
    const machinesRes = await api('GET', '/machines', adminToken);
    assert.strictEqual(machinesRes.status, 200);
    const fleet: any[] = machinesRes.body.data || [];
    const mc1 = fleet.find((m) => m.id === 'CFX-MC-01');
    const mc2 = fleet.find((m) => m.id === 'CFX-MC-02');
    const mc3 = fleet.find((m) => m.id === 'CFX-MC-03');
    assert.strictEqual(mc1?.connection_status, 'ONLINE');
    assert.strictEqual(mc1?.last_seen, recordedLastSeen);
    assert.strictEqual(mc2?.connection_status, 'OFFLINE');
    assert.strictEqual(mc2?.last_seen, null);
    assert.strictEqual(mc3?.connection_status, 'OFFLINE');
    assert.strictEqual(mc3?.last_seen, null);

    // Kiosk status endpoint confirms ONLINE
    const statusAfter = await api('GET', '/machine-status?machine_id=CFX-MC-01', mc1Jwt);
    assert.strictEqual(statusAfter.status, 200);
    assert.strictEqual(statusAfter.body.data.connection_status, 'ONLINE');
    assert.strictEqual(statusAfter.body.data.last_seen, recordedLastSeen);

    // CFX-MC-01 token cannot heartbeat CFX-MC-02 or CFX-MC-03
    const crossHb = await api('POST', '/machines/CFX-MC-02/heartbeat', mc1Jwt);
    assert.strictEqual(crossHb.status, 403);
    console.log('   PASS: Portal/kiosk ONLINE visibility and 403 cross-machine heartbeat isolation verified.');

    console.log('4. Testing 90s offline timeout, clock-skew guard, and Vercel cold-start read-through...');
    assert.strictEqual(HEARTBEAT_TIMEOUT_MS, 90_000);
    const staleIso = new Date(Date.now() - 95_000).toISOString();
    assert.strictEqual(computeConnectionStatus(staleIso), 'OFFLINE');
    const futureSkewIso = new Date(Date.now() + 45_000).toISOString();
    assert.strictEqual(computeConnectionStatus(futureSkewIso), 'OFFLINE');
    assert.strictEqual(computeConnectionStatus(new Date().toISOString()), 'ONLINE');

    // Simulate expired heartbeat in Firestore and cold start MockDatabase
    await firestore.collection('machines').doc('CFX-MC-01').set({ last_seen: staleIso }, { merge: true });
    resetMockDatabaseForColdStartSimulation();
    resetFirestoreSeedStateForTesting();
    setFirestoreForTesting({ firestoreInstance: firestore, clearStores: true });
    await initDB();
    const stateAfterExpiry = await getAuthoritativeMachineState('CFX-MC-01', getDB());
    assert.strictEqual(stateAfterExpiry?.connection_status, 'OFFLINE');

    // New heartbeat restores ONLINE
    const recoverHb = await api('POST', '/machines/CFX-MC-01/heartbeat', mc1Jwt);
    assert.strictEqual(recoverHb.status, 200);
    assert.strictEqual(recoverHb.body.data.connection_status, 'ONLINE');
    console.log('   PASS: 90s timeout, clock-skew rejection, cold-start hydration, and recovery verified.');

    console.log('\nALL PHASE H.1 HEARTBEAT & CONNECTIVITY TESTS PASSED!\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const a of getApps()) await deleteApp(a);
  }
}

runTests().catch((err) => {
  console.error('Phase H.1 heartbeat tests failed:', err);
  process.exit(1);
});

