import assert from 'assert';
import bcrypt from 'bcryptjs';
import http from 'http';

process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-vending.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nWAVE3_13_TEST_KEY\n-----END PRIVATE KEY-----';
process.env.JWT_SECRET = 'caffix-test-wave3-13-jwt-secret-key-2026';
process.env.KIOSK_ADMIN_ENABLED = 'false';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDB, resetMockDatabaseForColdStartSimulation } = require('../config/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  setFirestoreForTesting,
  createProductionSuperAdminInFirebase
} = require('../utils/firebase');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  runProductionSuperAdminBootstrap
} = require('../scripts/bootstrapProdSuperAdmin');

const PORT = 5097;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

class BootstrapMockFirestore {
  public collections = new Map<string, Map<string, any>>();
  public writeCount = 0;
  public docVersions = new Map<string, number>();
  public lastTransactionOps: string[] = [];
  public contentionRetries = 0;

  private getCol(name: string): Map<string, any> {
    let col = this.collections.get(name);
    if (!col) {
      col = new Map<string, any>();
      this.collections.set(name, col);
    }
    return col;
  }

  private applyDocSet(colName: string, id: string, payload: any, opts?: { merge?: boolean }) {
    const colMap = this.getCol(colName);
    this.writeCount++;
    const docKey = `${colName}/${id}`;
    this.docVersions.set(docKey, (this.docVersions.get(docKey) || 0) + 1);
    const existing = colMap.get(id);
    if (opts?.merge && existing && typeof existing === 'object') {
      colMap.set(id, {
        ...JSON.parse(JSON.stringify(existing)),
        ...JSON.parse(JSON.stringify(payload))
      });
    } else {
      colMap.set(id, JSON.parse(JSON.stringify(payload)));
    }
  }

  collection(colName: string) {
    const self = this;
    const colMap = this.getCol(colName);
    return {
      doc(docId: string) {
        const id = String(docId);
        return {
          id,
          __colName: colName,
          __docKey: `${colName}/${id}`,
          async get() {
            const has = colMap.has(id);
            const raw = colMap.get(id);
            return {
              id,
              exists: has,
              data: () => (raw ? JSON.parse(JSON.stringify(raw)) : undefined)
            };
          },
          async set(payload: any, opts?: { merge?: boolean }) {
            self.applyDocSet(colName, id, payload, opts);
          }
        };
      },
      where(field: string, op: string, value: any) {
        const match = () => {
          const list: Array<{ id: string; data: () => any }> = [];
          for (const [id, data] of colMap.entries()) {
            if (op === '==' && data && data[field] === value) {
              list.push({ id, data: () => JSON.parse(JSON.stringify(data)) });
            }
          }
          return list;
        };
        return {
          limit(max: number) {
            return {
              async get() {
                const sliced = match().slice(0, max);
                return { empty: sliced.length === 0, docs: sliced, forEach: (cb: (d: any) => void) => sliced.forEach(cb) };
              }
            };
          },
          async get() {
            const docs = match();
            return { empty: docs.length === 0, docs, forEach: (cb: (d: any) => void) => docs.forEach(cb) };
          }
        };
      },
      async get() {
        const docs: Array<{ id: string; data: () => any }> = [];
        for (const [id, data] of colMap.entries()) {
          docs.push({ id, data: () => JSON.parse(JSON.stringify(data)) });
        }
        return { empty: docs.length === 0, docs, forEach: (cb: (d: any) => void) => docs.forEach(cb) };
      }
    };
  }

  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const staged: Array<{ ref: any; payload: any; opts?: { merge?: boolean } }> = [];
      const readVersions = new Map<string, number>();
      const ops: string[] = [];
      let hasWritten = false;

      const tx = {
        get: async (refOrQuery: any) => {
          if (hasWritten) {
            throw new Error('Firestore transaction violation: read attempted after write');
          }
          if (refOrQuery?.__docKey) {
            const key = String(refOrQuery.__docKey);
            if (!readVersions.has(key)) {
              readVersions.set(key, this.docVersions.get(key) || 0);
            }
            ops.push(`read:${key}`);
          } else {
            ops.push('read:query');
          }
          return refOrQuery.get();
        },
        set: (ref: any, payload: any, opts?: { merge?: boolean }) => {
          hasWritten = true;
          ops.push(`write:${ref.__docKey || ref.id}`);
          staged.push({ ref, payload, opts });
        }
      };

      const res = await fn(tx);

      let conflict = false;
      for (const [docKey, seenVersion] of readVersions.entries()) {
        if ((this.docVersions.get(docKey) || 0) !== seenVersion) {
          conflict = true;
          break;
        }
      }
      if (conflict) {
        if (attempt < maxAttempts) {
          this.contentionRetries++;
          continue;
        }
        throw new Error('ABORTED: Firestore transaction contention on lock document');
      }

      for (const w of staged) {
        this.applyDocSet(w.ref.__colName, w.ref.id, w.payload, w.opts);
      }
      this.lastTransactionOps = ops;
      return res;
    }
    throw new Error('Transaction failed after max attempts');
  }
}

function makeMockIO(answers: {
  confirmProject: string;
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  logs?: string[];
}) {
  const logs = answers.logs || [];
  let textStep = 0;
  let hiddenStep = 0;
  return {
    askText: async (_prompt: string) => {
      textStep += 1;
      if (textStep === 1) return answers.confirmProject;
      if (textStep === 2) return answers.name;
      if (textStep === 3) return answers.email;
      throw new Error(`Unexpected text prompt step ${textStep}`);
    },
    askHidden: async (_prompt: string) => {
      hiddenStep += 1;
      if (hiddenStep === 1) return answers.password;
      if (hiddenStep === 2) return answers.confirmPassword;
      throw new Error(`Unexpected hidden prompt step ${hiddenStep}`);
    },
    log: (msg: string) => logs.push(msg)
  };
}

async function api(
  method: string,
  urlPath: string,
  body?: any,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function runWave313Tests() {
  console.log('\n=============================================================');
  console.log('Running Wave 3.13 Production Super Admin Bootstrap Tests');
  console.log('=============================================================\n');

  const fs = new BootstrapMockFirestore();
  setFirestoreForTesting({ firestoreInstance: fs, initError: null, clearStores: true });
  await initDB();
  resetMockDatabaseForColdStartSimulation();

  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  const savedEnv = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
    STAGING_FIREBASE_PROJECT_ID: process.env.STAGING_FIREBASE_PROJECT_ID
  };

  try {
    // -------------------------------------------------------------------------
    // 1. Successful interactive bootstrap + exact schema + login/RBAC compatibility
    // -------------------------------------------------------------------------
    console.log('1. Testing Production Super Admin bootstrap schema, bcrypt hash, hidden prompt & login/RBAC flow...');
    const strongPass = 'Caffix$ProdAdmin_2026!';
    const capturedLogs: string[] = [];
    const created = await runProductionSuperAdminBootstrap({
      io: makeMockIO({
        confirmProject: 'caffix-vending',
        name: 'Production Root Admin',
        email: 'Root.Admin@Caffix.com',
        password: strongPass,
        confirmPassword: strongPass,
        logs: capturedLogs
      })
    });

    assert.strictEqual(created.projectId, 'caffix-vending');
    assert.strictEqual(created.email, 'root.admin@caffix.com');
    assert.strictEqual(created.role, 'admin');
    assert.ok(created.id.startsWith('usr_'));

    // Ensure logs and return object never contain plaintext password or bcrypt hash
    const serializedLogs = capturedLogs.join('\n');
    assert.ok(!serializedLogs.includes(strongPass), 'Logs must never contain plaintext password');
    assert.ok(!serializedLogs.includes('$2'), 'Logs must never contain bcrypt password hash');
    assert.strictEqual((created as any).password, undefined, 'Return metadata must not include password');

    const storedDoc = fs.collections.get('users')!.get(created.id);
    assert.ok(storedDoc, 'User document must exist in Firestore users collection');
    assert.strictEqual(storedDoc.id, created.id);
    assert.strictEqual(storedDoc.name, 'Production Root Admin');
    assert.strictEqual(storedDoc.email, 'root.admin@caffix.com');
    assert.strictEqual(storedDoc.role, 'admin');
    assert.strictEqual(storedDoc.setup_token_hash, null);
    assert.strictEqual(storedDoc.setup_token_expires_at, null);
    assert.strictEqual(storedDoc.must_change_password, 0);
    assert.ok(storedDoc.updated_at);
    assert.ok(storedDoc.password.startsWith('$2'), 'Password must be bcrypt-hashed');
    assert.strictEqual(bcrypt.compareSync(strongPass, storedDoc.password), true);

    const storedLock = fs.collections.get('system_locks')?.get('production_super_admin_bootstrap');
    assert.ok(storedLock, 'Bootstrap lock document system_locks/production_super_admin_bootstrap must be created');
    assert.strictEqual(storedLock.id, 'production_super_admin_bootstrap');
    assert.strictEqual(storedLock.completed, true);
    assert.strictEqual(storedLock.super_admin_user_id, created.id);
    assert.strictEqual(storedLock.super_admin_email, 'root.admin@caffix.com');
    assert.strictEqual(storedLock.project_id, 'caffix-vending');
    assert.ok(storedLock.bootstrapped_at);
    assert.strictEqual(
      fs.lastTransactionOps[0],
      'read:system_locks/production_super_admin_bootstrap',
      'Transaction must read system_locks/production_super_admin_bootstrap first'
    );
    const firstWriteIdx = fs.lastTransactionOps.findIndex((op) => op.startsWith('write:'));
    assert.ok(firstWriteIdx >= 4, 'All 4 transaction reads must complete before any write');
    assert.ok(
      fs.lastTransactionOps.slice(0, firstWriteIdx).every((op) => op.startsWith('read:')),
      'All reads must precede writes in the Firestore transaction'
    );

    // Authenticate against real /api/auth/login (admin portal) & /api/auth/me
    const adminLoginRes = await api('POST', '/auth/login', {
      email: 'root.admin@caffix.com',
      password: strongPass,
      portal: 'admin'
    });
    assert.strictEqual(adminLoginRes.status, 200, `Admin login failed: ${JSON.stringify(adminLoginRes.data)}`);
    assert.strictEqual(adminLoginRes.data.data.role, 'admin');
    assert.ok(adminLoginRes.data.token);

    const meRes = await api('GET', '/auth/me?portal=admin', undefined, {
      Authorization: `Bearer ${adminLoginRes.data.token}`
    });
    assert.strictEqual(meRes.status, 200);
    assert.strictEqual(meRes.data.data.id, created.id);
    assert.strictEqual(meRes.data.data.role, 'admin');

    // Admin must remain blocked from Owner portal
    const ownerPortalLogin = await api('POST', '/auth/login', {
      email: 'root.admin@caffix.com',
      password: strongPass,
      portal: 'owner'
    });
    assert.strictEqual(ownerPortalLogin.status, 403);

    // -------------------------------------------------------------------------
    // 2. Abort on existing Super Admin or existing email without overwriting
    // -------------------------------------------------------------------------
    console.log('2. Testing create-only atomic abort when Super Admin or target email already exists...');
    const writesBeforeDuplicate = fs.writeCount;
    await assert.rejects(
      () =>
        runProductionSuperAdminBootstrap({
          io: makeMockIO({
            confirmProject: 'caffix-vending',
            name: 'Overwrite Attempt',
            email: 'root.admin@caffix.com',
            password: 'AnotherStrong#Pass99!',
            confirmPassword: 'AnotherStrong#Pass99!'
          })
        }),
      /already exists/i
    );
    await assert.rejects(
      () =>
        runProductionSuperAdminBootstrap({
          io: makeMockIO({
            confirmProject: 'caffix-vending',
            name: 'Second Admin Attempt',
            email: 'second.admin@caffix.com',
            password: 'AnotherStrong#Pass99!',
            confirmPassword: 'AnotherStrong#Pass99!'
          })
        }),
      /already exists/i
    );
    assert.strictEqual(fs.writeCount, writesBeforeDuplicate, 'Aborted bootstrap must cause 0 Firestore writes');

    // Also test existing non-admin account (owner) with same email is never escalated or modified
    const ownerFs = new BootstrapMockFirestore();
    const origOwnerPasswordHash = bcrypt.hashSync('ExistingOwner#Pass2026!', 10);
    await ownerFs.collection('users').doc('usr_existing_owner').set({
      id: 'usr_existing_owner',
      name: 'Existing Owner',
      email: 'owner@caffix.com',
      password: origOwnerPasswordHash,
      role: 'owner',
      setup_token_hash: null,
      setup_token_expires_at: null,
      must_change_password: 0,
      updated_at: new Date().toISOString()
    });
    setFirestoreForTesting({ firestoreInstance: ownerFs, initError: null, clearStores: true });
    const ownerWritesBefore = ownerFs.writeCount;
    await assert.rejects(
      () =>
        runProductionSuperAdminBootstrap({
          io: makeMockIO({
            confirmProject: 'caffix-vending',
            name: 'Escalation Attempt',
            email: 'owner@caffix.com',
            password: 'NewStrong#AdminPass99!',
            confirmPassword: 'NewStrong#AdminPass99!'
          })
        }),
      /already exists/i
    );
    assert.strictEqual(ownerFs.writeCount, ownerWritesBefore);
    assert.strictEqual(ownerFs.collections.get('users')!.get('usr_existing_owner').role, 'owner');
    assert.strictEqual(ownerFs.collections.get('users')!.get('usr_existing_owner').password, origOwnerPasswordHash);

    // -------------------------------------------------------------------------
    // 3. Reject staging, preview, mismatched confirmation, and missing Firestore
    // -------------------------------------------------------------------------
    console.log('3. Testing strict caffix-vending project guard (rejects caffix-staging & preview)...');
    const cleanFs = new BootstrapMockFirestore();
    setFirestoreForTesting({ firestoreInstance: cleanFs, initError: null, clearStores: true });

    try {
      process.env.FIREBASE_PROJECT_ID = 'caffix-staging';
      await assert.rejects(
        () =>
          runProductionSuperAdminBootstrap({
            io: makeMockIO({
              confirmProject: 'caffix-vending',
              name: 'Admin',
              email: 'admin@caffix.com',
              password: strongPass,
              confirmPassword: strongPass
            })
          }),
        /caffix-vending/
      );

      process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
      process.env.VERCEL_ENV = 'preview';
      await assert.rejects(
        () =>
          createProductionSuperAdminInFirebase({
            name: 'Admin',
            email: 'admin@caffix.com',
            passwordHash: bcrypt.hashSync(strongPass, 10),
            expectedProjectId: 'caffix-vending'
          }),
        /production/i
      );

      process.env.VERCEL_ENV = 'production';
      process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-staging.iam.gserviceaccount.com';
      await assert.rejects(
        () =>
          runProductionSuperAdminBootstrap({
            io: makeMockIO({
              confirmProject: 'caffix-vending',
              name: 'Admin',
              email: 'admin@caffix.com',
              password: strongPass,
              confirmPassword: strongPass
            })
          }),
        /caffix-staging/
      );

      process.env.FIREBASE_CLIENT_EMAIL = savedEnv.FIREBASE_CLIENT_EMAIL;
      await assert.rejects(
        () =>
          runProductionSuperAdminBootstrap({
            io: makeMockIO({
              confirmProject: 'caffix-staging',
              name: 'Admin',
              email: 'admin@caffix.com',
              password: strongPass,
              confirmPassword: strongPass
            })
          }),
        /did not match/i
      );
      assert.strictEqual(cleanFs.writeCount, 0, 'Rejected project checks must write 0 docs');
    } finally {
      Object.assign(process.env, savedEnv);
    }

    // -------------------------------------------------------------------------
    // 4. Password policy & confirmation checks
    // -------------------------------------------------------------------------
    console.log('4. Testing strong password policy & mismatch rejections...');
    const weakCases: Array<{ pwd: string; confirm?: string; pattern: RegExp }> = [
      { pwd: 'Short1!', pattern: /minimum 12/i },
      { pwd: 'alllowercase123!', pattern: /uppercase/i },
      { pwd: 'ALLUPPERCASE123!', pattern: /lowercase/i },
      { pwd: 'NoDigitsHere!!', pattern: /digit/i },
      { pwd: 'NoSpecialChar123', pattern: /special character/i },
      { pwd: 'Password123!', pattern: /too weak/i },
      { pwd: 'RootAdmin#Pass123!', pattern: /email username/i },
      { pwd: strongPass, confirm: 'Different$Pass99!', pattern: /do not match/i }
    ];
    for (const tc of weakCases) {
      await assert.rejects(
        () =>
          runProductionSuperAdminBootstrap({
            io: makeMockIO({
              confirmProject: 'caffix-vending',
              name: 'Prod Admin',
              email: 'rootadmin@caffix.com',
              password: tc.pwd,
              confirmPassword: tc.confirm ?? tc.pwd
            })
          }),
        tc.pattern
      );
    }
    assert.strictEqual(cleanFs.writeCount, 0);

    // -------------------------------------------------------------------------
    // 5. Verify no HTTP bootstrap endpoint exists
    // -------------------------------------------------------------------------
    console.log('5. Verifying zero HTTP bootstrap routes exist on backend API...');
    for (const endpoint of ['/bootstrap', '/auth/bootstrap', '/admin/bootstrap']) {
      const res = await api('POST', endpoint, { email: 'a@b.com' });
      assert.strictEqual(res.status, 404, `Unexpected route responded on ${endpoint}`);
    }

    // -------------------------------------------------------------------------
    // 6. Concurrent bootstrap race protection via system_locks/production_super_admin_bootstrap
    // -------------------------------------------------------------------------
    console.log('6. Testing concurrent bootstrap race protection & pre-existing lock abort...');
    const concurrentFs = new BootstrapMockFirestore();
    setFirestoreForTesting({ firestoreInstance: concurrentFs, initError: null, clearStores: true });

    const [attemptA, attemptB] = await Promise.allSettled([
      runProductionSuperAdminBootstrap({
        io: makeMockIO({
          confirmProject: 'caffix-vending',
          name: 'Concurrent Admin A',
          email: 'concurrent.a@caffix.com',
          password: 'Concurrent#AdminPass1!',
          confirmPassword: 'Concurrent#AdminPass1!'
        })
      }),
      runProductionSuperAdminBootstrap({
        io: makeMockIO({
          confirmProject: 'caffix-vending',
          name: 'Concurrent Admin B',
          email: 'concurrent.b@caffix.com',
          password: 'Concurrent#AdminPass2!',
          confirmPassword: 'Concurrent#AdminPass2!'
        })
      })
    ]);

    const fulfilled = [attemptA, attemptB].filter(
      (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled'
    );
    const rejected = [attemptA, attemptB].filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected'
    );

    assert.strictEqual(fulfilled.length, 1, 'At most one concurrent bootstrap attempt must succeed');
    assert.strictEqual(rejected.length, 1, 'Second concurrent bootstrap attempt must abort');
    assert.match(String(rejected[0].reason?.message || rejected[0].reason), /already exists/i);
    assert.ok(concurrentFs.contentionRetries >= 1, 'Expected concurrent transaction contention on lock doc');

    const concurrentUsers = concurrentFs.collections.get('users');
    assert.strictEqual(concurrentUsers?.size, 1, 'Only one Super Admin document must exist after concurrent run');
    assert.strictEqual(concurrentFs.writeCount, 2, 'Expected exactly 2 writes total (1 user + 1 lock doc)');
    const winner = fulfilled[0].value;
    const concurrentLock = concurrentFs.collections.get('system_locks')?.get('production_super_admin_bootstrap');
    assert.ok(concurrentLock);
    assert.strictEqual(concurrentLock.super_admin_user_id, winner.id);
    assert.strictEqual(concurrentLock.super_admin_email, winner.email);

    // Pre-existing lock doc alone must also abort with 0 writes even when users collection is empty
    const lockedOnlyFs = new BootstrapMockFirestore();
    await lockedOnlyFs.collection('system_locks').doc('production_super_admin_bootstrap').set({
      id: 'production_super_admin_bootstrap',
      completed: true
    });
    setFirestoreForTesting({ firestoreInstance: lockedOnlyFs, initError: null, clearStores: true });
    const lockedWritesBefore = lockedOnlyFs.writeCount;
    await assert.rejects(
      () =>
        runProductionSuperAdminBootstrap({
          io: makeMockIO({
            confirmProject: 'caffix-vending',
            name: 'Post-Lock Admin',
            email: 'postlock@caffix.com',
            password: 'AnotherValid#Secret99!',
            confirmPassword: 'AnotherValid#Secret99!'
          })
        }),
      /bootstrap lock already exists/i
    );
    assert.strictEqual(lockedOnlyFs.writeCount, lockedWritesBefore, 'Pre-existing lock abort must cause 0 writes');
    assert.strictEqual(lockedOnlyFs.collections.get('users')?.size || 0, 0);

    console.log('\nALL WAVE 3.13 PRODUCTION SUPER ADMIN BOOTSTRAP TESTS PASSED!\n');
  } finally {
    Object.assign(process.env, savedEnv);
    setFirestoreForTesting({ firestoreInstance: null, initError: null, clearStores: true });
    server.close();
  }
}

runWave313Tests().catch((err) => {
  console.error('Wave 3.13 test suite failed:', err);
  process.exit(1);
});

