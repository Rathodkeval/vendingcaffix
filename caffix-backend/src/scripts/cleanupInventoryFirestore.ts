import fs from 'fs';
import path from 'path';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, Firestore, FieldValue } from 'firebase-admin/firestore';

export const DEPRECATED_ROOT_COLLECTIONS = ['inventory_ledger', 'refill_idempotency'] as const;
export const DEPRECATED_MACHINE_SUBCOLLECTIONS = ['inventory_ledger'] as const;
export const DEPRECATED_MACHINE_FIELDS = [
  'estimated_inventory',
  'inventory',
  'inventory_source',
  'inventory_updated_at'
] as const;

export const PROTECTED_CORE_COLLECTIONS = [
  'machines',
  'orders',
  'users',
  'refunds',
  'refund_idempotency',
  'webhook_events',
  'system_locks'
] as const;

export interface MachineFieldCleanupTarget {
  machineId: string;
  fieldsPresent: string[];
  preservedCoreFields: string[];
}

export interface SubcollectionCleanupTarget {
  parentMachineId: string;
  subcollection: string;
  documentCount: number;
  sampleDocIds: string[];
}

export interface InventoryCleanupPlan {
  projectId: string;
  mode: 'DRY_RUN' | 'EXECUTE';
  inspectedAt: string;
  rootCollections: Array<{
    collection: string;
    documentCount: number;
    sampleDocIds: string[];
  }>;
  machineSubcollections: SubcollectionCleanupTarget[];
  machineDocumentsWithInventoryFields: MachineFieldCleanupTarget[];
  protectedCollectionsStatus: {
    machinesCount: number;
    ordersSampledChecked: number;
    cfxMc03Present: boolean;
  };
  totals: {
    documentsToDelete: number;
    machineDocumentsToUpdate: number;
  };
}

export function parseCleanupCliArgs(argv: string[]): {
  execute: boolean;
  confirmProject: string;
  backupOut: string;
} {
  let execute = false;
  let confirmProject = '';
  let backupOut = '';

  for (const arg of argv) {
    if (arg === '--execute') {
      execute = true;
    } else if (arg.startsWith('--confirm-project=')) {
      confirmProject = arg.slice('--confirm-project='.length).trim();
    } else if (arg.startsWith('--backup-out=')) {
      backupOut = arg.slice('--backup-out='.length).trim();
    }
  }

  return { execute, confirmProject, backupOut };
}

function initFirestoreFromEnv(): { firestore: Firestore; projectId: string } {
  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  const emulatorHost = String(process.env.FIRESTORE_EMULATOR_HOST || '').trim();

  if (!projectId && !emulatorHost) {
    throw new Error(
      'Missing FIREBASE_PROJECT_ID. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY (or FIRESTORE_EMULATOR_HOST) before running.'
    );
  }

  if (getApps().length === 0) {
    if (emulatorHost) {
      initializeApp({ projectId: projectId || 'demo-caffix-emulator' });
    } else {
      if (!clientEmail || !privateKey) {
        throw new Error(
          'Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY for live Firestore access.'
        );
      }
      initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey
        })
      });
    }
  }

  return {
    firestore: getFirestore(),
    projectId: projectId || 'demo-caffix-emulator'
  };
}

/**
 * Inspects Firestore and builds a complete dry-run cleanup plan without mutating any document.
 */
export async function buildInventoryCleanupPlan(
  firestore: Firestore,
  projectId: string,
  mode: 'DRY_RUN' | 'EXECUTE' = 'DRY_RUN'
): Promise<InventoryCleanupPlan> {
  const rootCollections: InventoryCleanupPlan['rootCollections'] = [];
  let totalDocsToDelete = 0;

  for (const colName of DEPRECATED_ROOT_COLLECTIONS) {
    const snap = await firestore.collection(colName).get();
    totalDocsToDelete += snap.size;
    rootCollections.push({
      collection: colName,
      documentCount: snap.size,
      sampleDocIds: snap.docs.slice(0, 5).map((d) => d.id)
    });
  }

  const machinesSnap = await firestore.collection('machines').get();
  const machineSubcollections: SubcollectionCleanupTarget[] = [];
  const machineDocumentsWithInventoryFields: MachineFieldCleanupTarget[] = [];
  let cfxMc03Present = false;

  for (const mDoc of machinesSnap.docs) {
    const mId = mDoc.id;
    if (mId === 'CFX-MC-03') cfxMc03Present = true;
    const data = mDoc.data() || {};

    for (const subName of DEPRECATED_MACHINE_SUBCOLLECTIONS) {
      const subSnap = await firestore
        .collection('machines')
        .doc(mId)
        .collection(subName)
        .get();
      if (!subSnap.empty) {
        totalDocsToDelete += subSnap.size;
        machineSubcollections.push({
          parentMachineId: mId,
          subcollection: subName,
          documentCount: subSnap.size,
          sampleDocIds: subSnap.docs.slice(0, 5).map((d) => d.id)
        });
      }
    }

    const fieldsPresent = DEPRECATED_MACHINE_FIELDS.filter((f) => f in data);
    if (fieldsPresent.length > 0) {
      const preservedCoreFields = Object.keys(data).filter(
        (k) => !(DEPRECATED_MACHINE_FIELDS as readonly string[]).includes(k)
      );
      machineDocumentsWithInventoryFields.push({
        machineId: mId,
        fieldsPresent: [...fieldsPresent],
        preservedCoreFields
      });
    }
  }

  const ordersSampleSnap = await firestore.collection('orders').limit(5).get();

  return {
    projectId,
    mode,
    inspectedAt: new Date().toISOString(),
    rootCollections,
    machineSubcollections,
    machineDocumentsWithInventoryFields,
    protectedCollectionsStatus: {
      machinesCount: machinesSnap.size,
      ordersSampledChecked: ordersSampleSnap.size,
      cfxMc03Present
    },
    totals: {
      documentsToDelete: totalDocsToDelete,
      machineDocumentsToUpdate: machineDocumentsWithInventoryFields.length
    }
  };
}

/**
 * Exports a JSON backup snapshot and removes deprecated inventory data ONLY when explicitly executed.
 */
export async function executeInventoryCleanupMigration(
  firestore: Firestore,
  plan: InventoryCleanupPlan,
  options: { backupOutPath?: string } = {}
): Promise<{ backupFilePath: string; deletedDocuments: number; updatedMachines: number }> {
  const backupData: Record<string, any> = {
    projectId: plan.projectId,
    exportedAt: new Date().toISOString(),
    rootCollections: {},
    machineSubcollections: {},
    machineInventoryFields: {}
  };

  for (const rc of plan.rootCollections) {
    const snap = await firestore.collection(rc.collection).get();
    backupData.rootCollections[rc.collection] = snap.docs.map((d) => ({
      id: d.id,
      data: d.data()
    }));
  }

  for (const sub of plan.machineSubcollections) {
    const snap = await firestore
      .collection('machines')
      .doc(sub.parentMachineId)
      .collection(sub.subcollection)
      .get();
    const key = `machines/${sub.parentMachineId}/${sub.subcollection}`;
    backupData.machineSubcollections[key] = snap.docs.map((d) => ({
      id: d.id,
      data: d.data()
    }));
  }

  for (const mf of plan.machineDocumentsWithInventoryFields) {
    const snap = await firestore.collection('machines').doc(mf.machineId).get();
    const data = snap.data() || {};
    const fieldBackup: Record<string, any> = {};
    for (const f of mf.fieldsPresent) {
      fieldBackup[f] = data[f];
    }
    backupData.machineInventoryFields[mf.machineId] = fieldBackup;
  }

  const backupFilePath =
    options.backupOutPath ||
    path.resolve(
      process.cwd(),
      `firestore-inventory-backup-${plan.projectId}-${Date.now()}.json`
    );
  fs.mkdirSync(path.dirname(backupFilePath), { recursive: true });
  fs.writeFileSync(backupFilePath, JSON.stringify(backupData, null, 2), 'utf-8');

  let deletedDocuments = 0;
  let updatedMachines = 0;

  // Batch delete in chunks of <= 450 operations to stay within Firestore 500-op batch limits
  const batchDeleteDocs = async (refs: FirebaseFirestore.DocumentReference[]) => {
    for (let i = 0; i < refs.length; i += 450) {
      const batch = firestore.batch();
      const slice = refs.slice(i, i + 450);
      for (const ref of slice) {
        batch.delete(ref);
      }
      await batch.commit();
      deletedDocuments += slice.length;
    }
  };

  for (const rc of plan.rootCollections) {
    if (rc.documentCount === 0) continue;
    const snap = await firestore.collection(rc.collection).get();
    await batchDeleteDocs(snap.docs.map((d) => d.ref));
  }

  for (const sub of plan.machineSubcollections) {
    const snap = await firestore
      .collection('machines')
      .doc(sub.parentMachineId)
      .collection(sub.subcollection)
      .get();
    if (!snap.empty) {
      await batchDeleteDocs(snap.docs.map((d) => d.ref));
    }
  }

  for (const mf of plan.machineDocumentsWithInventoryFields) {
    const updatePayload: Record<string, any> = {};
    for (const f of mf.fieldsPresent) {
      updatePayload[f] = FieldValue.delete();
    }
    await firestore.collection('machines').doc(mf.machineId).update(updatePayload);
    updatedMachines += 1;
  }

  return { backupFilePath, deletedDocuments, updatedMachines };
}

export function formatCleanupPlanReport(plan: InventoryCleanupPlan): string {
  const lines: string[] = [
    '========================================================================',
    `CAFFIX Firestore Inventory Cleanup Plan [${plan.mode}]`,
    `Target Project : ${plan.projectId}`,
    `Inspected At   : ${plan.inspectedAt}`,
    '========================================================================',
    '',
    '1. Root Collections Scheduled for Deletion:'
  ];

  for (const rc of plan.rootCollections) {
    lines.push(
      `   - ${rc.collection}: ${rc.documentCount} doc(s)` +
        (rc.sampleDocIds.length > 0 ? ` (sample IDs: ${rc.sampleDocIds.join(', ')})` : '')
    );
  }

  lines.push('', '2. Machine Subcollections Scheduled for Deletion:');
  if (plan.machineSubcollections.length === 0) {
    lines.push('   - (none found)');
  } else {
    for (const sub of plan.machineSubcollections) {
      lines.push(
        `   - machines/${sub.parentMachineId}/${sub.subcollection}: ${sub.documentCount} doc(s)`
      );
    }
  }

  lines.push('', '3. Machine Document Inventory Fields Scheduled for Removal (FieldValue.delete()):');
  if (plan.machineDocumentsWithInventoryFields.length === 0) {
    lines.push('   - (none found)');
  } else {
    for (const mf of plan.machineDocumentsWithInventoryFields) {
      lines.push(
        `   - machines/${mf.machineId}: remove [${mf.fieldsPresent.join(', ')}] | preserve [${mf.preservedCoreFields.join(', ')}]`
      );
    }
  }

  lines.push(
    '',
    '4. Protected Core Data Verification (UNTOUCHED):',
    `   - machines docs present : ${plan.protectedCollectionsStatus.machinesCount} (CFX-MC-03 present=${plan.protectedCollectionsStatus.cfxMc03Present})`,
    `   - protected collections : ${PROTECTED_CORE_COLLECTIONS.join(', ')}`,
    '',
    '5. Summary:',
    `   - Total docs to delete    : ${plan.totals.documentsToDelete}`,
    `   - Machine docs to prune   : ${plan.totals.machineDocumentsToUpdate}`,
    '========================================================================'
  );

  return lines.join('\n');
}

async function main() {
  const { execute, confirmProject, backupOut } = parseCleanupCliArgs(process.argv.slice(2));
  const { firestore, projectId } = initFirestoreFromEnv();

  const plan = await buildInventoryCleanupPlan(
    firestore,
    projectId,
    execute ? 'EXECUTE' : 'DRY_RUN'
  );

  console.log(formatCleanupPlanReport(plan));

  if (!execute) {
    console.log(
      '\nDRY-RUN COMPLETE: No Firestore documents or fields were modified or deleted.'
    );
    console.log(
      `To execute after explicit approval, run with: --execute --confirm-project=${projectId}`
    );
    return;
  }

  if (confirmProject !== projectId) {
    throw new Error(
      `Safety check failed: --confirm-project="${confirmProject}" does not match target FIREBASE_PROJECT_ID="${projectId}". Aborting without changes.`
    );
  }

  const result = await executeInventoryCleanupMigration(firestore, plan, {
    backupOutPath: backupOut || undefined
  });
  console.log('\nMIGRATION EXECUTED SUCCESSFULLY:');
  console.log(`- JSON backup written : ${result.backupFilePath}`);
  console.log(`- Documents deleted   : ${result.deletedDocuments}`);
  console.log(`- Machines updated    : ${result.updatedMachines}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Firestore inventory cleanup failed:', err?.message || err);
    process.exit(1);
  });
}

