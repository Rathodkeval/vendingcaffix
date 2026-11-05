import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import logger from './logger';

let firestore: Firestore | null = null;

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
// Parse environment variable newlines for Vercel/Docker hosts
const privateKey = process.env.FIREBASE_PRIVATE_KEY
  ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : undefined;

if (projectId && clientEmail && privateKey) {
  try {
    if (getApps().length === 0) {
      initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    }
    firestore = getFirestore();
    logger.info('Firebase Admin SDK initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize Firebase Admin SDK:', error);
  }
} else {
  logger.warn('Firebase credentials not set. Firestore synchronization is disabled.');
}

// In-memory mirror of synced Firebase orders (for local verification and testing when Firebase Admin credentials are not configured)
const syncedOrdersStore = new Map<string, any>();

export function getSyncedFirebaseOrder(orderId: string): any | undefined {
  return syncedOrdersStore.get(orderId);
}

export function getAllSyncedFirebaseOrders(): any[] {
  return Array.from(syncedOrdersStore.values());
}

export async function syncOrderToFirebase(order: any): Promise<void> {
  // Sanitize order properties to remove undefined values before uploading to Firestore
  const sanitizedOrder: any = {};
  for (const key of Object.keys(order)) {
    if (order[key] !== undefined) {
      sanitizedOrder[key] = order[key];
    }
  }

  // Keep only extra_sugar in Firebase console (always 1)
  delete sanitizedOrder.sugar;
  sanitizedOrder.extra_sugar = 1;

  // Ensure coffee field is populated alongside product_name for Raspberry Pi compatibility
  if (sanitizedOrder.product_name && !sanitizedOrder.coffee) {
    sanitizedOrder.coffee = sanitizedOrder.product_name;
  }

  const nowIso = new Date().toISOString();

  // Maintain local mirror for deterministic inspection
  const existingLocal = syncedOrdersStore.get(order.id) || {};
  const terminalDispenseStates = ['DISPENSING', 'DISPENSED'];
  let nextDispenseStatus = existingLocal.dispense_status;
  if (!terminalDispenseStates.includes(existingLocal.dispense_status)) {
    if (sanitizedOrder.status === 'PAID' || sanitizedOrder.status === 'COMPLETED') {
      nextDispenseStatus = 'QUEUED';
    } else if (sanitizedOrder.status === 'PENDING') {
      nextDispenseStatus = 'PENDING';
    } else if (sanitizedOrder.status === 'CANCELLED' || sanitizedOrder.status === 'FAILED') {
      nextDispenseStatus = sanitizedOrder.status;
    }
  }

  const mergedPayload = {
    ...existingLocal,
    ...sanitizedOrder,
    ...(nextDispenseStatus ? { dispense_status: nextDispenseStatus } : {}),
    updated_at: nowIso
  };
  syncedOrdersStore.set(order.id, mergedPayload);

  if (!firestore) {
    logger.debug(`Firebase Firestore not initialized. Stored order in local mirror: ${order.id} (machine_id: ${sanitizedOrder.machine_id})`);
    return;
  }

  try {
    const docRef = firestore.collection('orders').doc(order.id);
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const existingData = snap.exists ? snap.data() || {} : {};

      // Never overwrite machine_id once an order document exists in Firestore
      if (existingData.machine_id && existingData.machine_id !== sanitizedOrder.machine_id) {
        logger.warn(`Prevented machine_id overwrite on order ${order.id}: existing=${existingData.machine_id}, attempted=${sanitizedOrder.machine_id}`);
        sanitizedOrder.machine_id = existingData.machine_id;
      }

      // Prevent duplicate dispensing: if Raspberry Pi has already claimed or dispensed this order,
      // do not reset dispense_status or dispensed flags
      const alreadyClaimedOrDispensed =
        existingData.dispensed === true ||
        existingData.dispense_status === 'DISPENSING' ||
        existingData.dispense_status === 'DISPENSED';

      const payloadToWrite: any = {
        ...sanitizedOrder,
        updated_at: nowIso
      };

      if (!alreadyClaimedOrDispensed) {
        if (sanitizedOrder.status === 'PAID' || sanitizedOrder.status === 'COMPLETED') {
          payloadToWrite.dispense_status = 'QUEUED';
        } else if (sanitizedOrder.status === 'PENDING' && !existingData.dispense_status) {
          payloadToWrite.dispense_status = 'PENDING';
        }
      }

      tx.set(docRef, payloadToWrite, { merge: true });
    });

    logger.info(`Successfully synced order ${order.id} (machine_id: ${sanitizedOrder.machine_id}) to Firestore`);
  } catch (error) {
    logger.error(`Failed to sync order ${order.id} to Firestore:`, error);
  }
}

export async function syncMachineToFirebase(machine: any): Promise<void> {
  if (!firestore || !machine || !machine.id) {
    return;
  }
  try {
    await firestore.collection('machines').doc(machine.id).set({
      id: machine.id,
      machine_name: machine.machine_name,
      location: machine.location,
      status: machine.status || 'online',
      last_seen: machine.last_seen || new Date().toISOString(),
      ...(machine.kiosk_token ? { kiosk_token: machine.kiosk_token } : {})
    }, { merge: true });
    logger.info(`Synced machine ${machine.id} to Firestore`);
  } catch (error) {
    logger.error(`Failed to sync machine ${machine.id} to Firestore:`, error);
  }
}

export async function getMachineFromFirebase(machineId: string): Promise<any | null> {
  if (!firestore || !machineId) {
    return null;
  }
  try {
    const snap = await firestore.collection('machines').doc(machineId).get();
    if (snap.exists) {
      return snap.data() || null;
    }
  } catch (error) {
    logger.error(`Failed to fetch machine ${machineId} from Firestore:`, error);
  }
  return null;
}
