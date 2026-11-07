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

// In-memory mirror of synced Firebase orders, machines, and users (for local verification and testing when Firebase Admin credentials are not configured)
const syncedOrdersStore = new Map<string, any>();
const syncedMachinesStore = new Map<string, any>();
const syncedUsersStore = new Map<string, any>();

export const HEARTBEAT_TIMEOUT_MS = 90 * 1000; // 90 seconds offline timeout
export type DesiredMode = 'RUNNING' | 'MAINTENANCE';
export type ConnectionStatus = 'ONLINE' | 'OFFLINE';

export function normalizeDesiredMode(modeOrStatus?: string | null): DesiredMode {
  if (!modeOrStatus) return 'RUNNING';
  const normalized = String(modeOrStatus).trim().toUpperCase();
  if (normalized === 'MAINTENANCE') {
    return 'MAINTENANCE';
  }
  return 'RUNNING';
}

export function desiredModeToLegacyStatus(desiredMode: DesiredMode): 'online' | 'maintenance' {
  return desiredMode === 'MAINTENANCE' ? 'maintenance' : 'online';
}

export function computeConnectionStatus(
  lastSeen?: string | null,
  nowMs: number = Date.now()
): ConnectionStatus {
  if (!lastSeen || typeof lastSeen !== 'string' || !lastSeen.trim()) {
    return 'OFFLINE';
  }
  const parsedMs = Date.parse(lastSeen);
  if (Number.isNaN(parsedMs)) {
    return 'OFFLINE';
  }
  const elapsedMs = nowMs - parsedMs;
  // Allow small clock skew up to 30s into the future, and up to 90s in the past
  return elapsedMs <= HEARTBEAT_TIMEOUT_MS && elapsedMs >= -30_000 ? 'ONLINE' : 'OFFLINE';
}

export function getSyncedFirebaseOrder(orderId: string): any | undefined {
  return syncedOrdersStore.get(orderId);
}

export function getAllSyncedFirebaseOrders(): any[] {
  return Array.from(syncedOrdersStore.values());
}

export function getSyncedFirebaseMachine(machineId: string): any | undefined {
  return syncedMachinesStore.get(machineId);
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

/**
 * Targeted partial update for Owner/Admin desired_mode ('RUNNING' | 'MAINTENANCE').
 * Strictly preserves `last_seen`, `owner_id`, `estimated_inventory`, and `products`.
 */
export async function updateMachineDesiredModeInFirebase(
  machineId: string,
  desiredMode: DesiredMode
): Promise<void> {
  if (!machineId) return;
  const normalizedMode = normalizeDesiredMode(desiredMode);
  const legacyStatus = desiredModeToLegacyStatus(normalizedMode);
  const nowIso = new Date().toISOString();

  const existingLocal = syncedMachinesStore.get(machineId) || { id: machineId };
  syncedMachinesStore.set(machineId, {
    ...existingLocal,
    id: machineId,
    desired_mode: normalizedMode,
    status: legacyStatus,
    mode_updated_at: nowIso,
    updated_at: nowIso
  });

  if (!firestore) {
    return;
  }

  try {
    await firestore.collection('machines').doc(machineId).set(
      {
        id: machineId,
        desired_mode: normalizedMode,
        status: legacyStatus,
        mode_updated_at: nowIso,
        updated_at: nowIso
      },
      { merge: true }
    );
    logger.info(`Updated machine ${machineId} desired_mode=${normalizedMode} in Firestore`);
  } catch (error) {
    logger.error(`Failed to update desired_mode for machine ${machineId} in Firestore:`, error);
  }
}

/**
 * Targeted partial update for Raspberry Pi heartbeat (`last_seen` ONLY).
 * Strictly preserves `desired_mode`, `status`, `owner_id`, `estimated_inventory`, and `products`.
 */
export async function updateMachineHeartbeatInFirebase(
  machineId: string,
  lastSeenIso: string = new Date().toISOString()
): Promise<void> {
  if (!machineId) return;

  const existingLocal = syncedMachinesStore.get(machineId) || { id: machineId };
  syncedMachinesStore.set(machineId, {
    ...existingLocal,
    id: machineId,
    last_seen: lastSeenIso
  });

  if (!firestore) {
    return;
  }

  try {
    await firestore.collection('machines').doc(machineId).set(
      {
        id: machineId,
        last_seen: lastSeenIso
      },
      { merge: true }
    );
    logger.debug(`Updated heartbeat last_seen for machine ${machineId} in Firestore`);
  } catch (error) {
    logger.error(`Failed to update heartbeat for machine ${machineId} in Firestore:`, error);
  }
}

/**
 * Targeted partial update for software-estimated inventory levels.
 */
export async function updateMachineInventoryInFirebase(
  machineId: string,
  inventory: {
    milk_level: number;
    coffee_level: number;
    vanilla_level: number;
    hazelnut_level: number;
    irish_level: number;
    mocha_level: number;
    water_level: number;
  }
): Promise<void> {
  if (!machineId || !inventory) return;
  const nowIso = new Date().toISOString();
  const estimatedInventory = {
    milk_level: Number(inventory.milk_level),
    coffee_level: Number(inventory.coffee_level),
    vanilla_level: Number(inventory.vanilla_level),
    hazelnut_level: Number(inventory.hazelnut_level),
    irish_level: Number(inventory.irish_level),
    mocha_level: Number(inventory.mocha_level),
    water_level: Number(inventory.water_level)
  };

  const existingLocal = syncedMachinesStore.get(machineId) || { id: machineId };
  syncedMachinesStore.set(machineId, {
    ...existingLocal,
    id: machineId,
    estimated_inventory: estimatedInventory,
    inventory_source: 'software_estimated',
    inventory_updated_at: nowIso,
    updated_at: nowIso
  });

  if (!firestore) {
    return;
  }

  try {
    await firestore.collection('machines').doc(machineId).set(
      {
        id: machineId,
        estimated_inventory: estimatedInventory,
        inventory_source: 'software_estimated',
        inventory_updated_at: nowIso,
        updated_at: nowIso
      },
      { merge: true }
    );
    logger.info(`Synced software-estimated inventory for machine ${machineId} to Firestore`);
  } catch (error) {
    logger.error(`Failed to sync inventory for machine ${machineId} to Firestore:`, error);
  }
}

/**
 * Targeted partial update for machine ownership (`owner_id` ONLY).
 * Strictly preserves `desired_mode`, `status`, `last_seen`, `estimated_inventory`, and `products`.
 */
export async function updateMachineOwnerInFirebase(
  machineId: string,
  ownerId: string | null
): Promise<void> {
  if (!machineId) return;
  const normalizedOwnerId = ownerId && String(ownerId).trim() !== '' ? String(ownerId).trim() : null;
  const nowIso = new Date().toISOString();

  const existingLocal = syncedMachinesStore.get(machineId) || { id: machineId };
  syncedMachinesStore.set(machineId, {
    ...existingLocal,
    id: machineId,
    owner_id: normalizedOwnerId,
    owner_updated_at: nowIso,
    updated_at: nowIso
  });

  if (!firestore) {
    return;
  }

  try {
    await firestore.collection('machines').doc(machineId).set(
      {
        id: machineId,
        owner_id: normalizedOwnerId,
        owner_updated_at: nowIso,
        updated_at: nowIso
      },
      { merge: true }
    );
    logger.info(`Updated machine ${machineId} owner_id=${normalizedOwnerId ?? 'null'} in Firestore`);
  } catch (error) {
    logger.error(`Failed to update owner_id for machine ${machineId} in Firestore:`, error);
  }
}

/**
 * Targeted partial update for a single product's price and availability on a specific machine.
 * Strictly preserves all other products in `products` as well as `desired_mode`, `status`,
 * `last_seen`, `owner_id`, and `estimated_inventory`.
 */
export async function updateMachineProductInFirebase(
  machineId: string,
  productId: number,
  productConfig: {
    price: number;
    is_available: boolean;
    updated_at?: string;
  }
): Promise<void> {
  if (!machineId || !productId) return;
  const pidKey = String(Number(productId));
  const nowIso = productConfig.updated_at || new Date().toISOString();
  const entry = {
    product_id: Number(productId),
    price: Number(productConfig.price),
    is_available: Boolean(productConfig.is_available),
    updated_at: nowIso
  };

  const existingLocal = syncedMachinesStore.get(machineId) || { id: machineId };
  const existingProducts =
    existingLocal.products && typeof existingLocal.products === 'object'
      ? { ...existingLocal.products }
      : {};
  existingProducts[pidKey] = entry;

  syncedMachinesStore.set(machineId, {
    ...existingLocal,
    id: machineId,
    products: existingProducts,
    updated_at: nowIso
  });

  if (!firestore) {
    return;
  }

  try {
    await firestore.collection('machines').doc(machineId).set(
      {
        id: machineId,
        products: {
          [pidKey]: entry
        },
        updated_at: nowIso
      },
      { merge: true }
    );
    logger.info(
      `Updated machine ${machineId} product ${pidKey} (price=₹${entry.price}, is_available=${entry.is_available}) in Firestore`
    );
  } catch (error) {
    logger.error(`Failed to update product ${pidKey} for machine ${machineId} in Firestore:`, error);
  }
}

/**
 * Authoritative read-through & hydration for per-machine product prices and availability.
 * Uses the global `products` catalog as default, overlaid with machine-specific overrides
 * from Firestore (`machines/{machineId}.products`) and `machine_products` in SQLite/MockDatabase.
 */
export async function getAuthoritativeMachineProducts(
  machineId: string,
  db: any
): Promise<
  Array<{
    id: number;
    product_id: number;
    machine_id: string;
    name: string;
    default_price: number;
    price: number;
    is_available: boolean;
    description: string;
    image: string;
    updated_at: string | null;
  }>
> {
  const catalogProducts = await db.all('SELECT * FROM products');
  const sortedCatalog = [...catalogProducts].sort((a, b) => Number(a.id) - Number(b.id));

  const remoteMachine = await getMachineFromFirebase(machineId);
  const remoteProductsMap =
    remoteMachine?.products && typeof remoteMachine.products === 'object'
      ? remoteMachine.products
      : null;

  // Hydrate local `machine_products` table from Firestore overrides if newer or missing locally
  if (remoteProductsMap) {
    for (const [key, rawVal] of Object.entries(remoteProductsMap)) {
      const val = rawVal as any;
      const pid = Number(val?.product_id ?? key);
      if (!Number.isInteger(pid) || pid <= 0 || val?.price === undefined) continue;

      const remotePrice = Number(val.price);
      const remoteAvailInt = val.is_available === false || val.is_available === 0 ? 0 : 1;
      const remoteUpdated = val.updated_at || remoteMachine?.updated_at || new Date().toISOString();

      const localOverride = await db.get(
        'SELECT * FROM machine_products WHERE machine_id = ? AND product_id = ?',
        [machineId, pid]
      );

      if (
        !localOverride ||
        !localOverride.updated_at ||
        remoteUpdated >= localOverride.updated_at
      ) {
        await db.run(
          'INSERT OR REPLACE INTO machine_products (machine_id, product_id, price, is_available, updated_at) VALUES (?, ?, ?, ?, ?)',
          [machineId, pid, remotePrice, remoteAvailInt, remoteUpdated]
        );
      }
    }
  }

  const localOverrides = await db.all(
    'SELECT * FROM machine_products WHERE machine_id = ?',
    [machineId]
  );
  const overrideByProductId = new Map<number, any>();
  for (const row of localOverrides) {
    overrideByProductId.set(Number(row.product_id), row);
  }

  return sortedCatalog.map((p: any) => {
    const pid = Number(p.id);
    const override = overrideByProductId.get(pid);
    const effectivePrice =
      override && override.price !== undefined && override.price !== null
        ? Number(override.price)
        : Number(p.price);
    const effectiveAvailable =
      override && override.is_available !== undefined && override.is_available !== null
        ? Number(override.is_available) !== 0
        : true;

    return {
      id: pid,
      product_id: pid,
      machine_id: machineId,
      name: p.name,
      default_price: Number(p.price),
      price: effectivePrice,
      is_available: effectiveAvailable,
      description: p.description,
      image: p.image,
      updated_at: override?.updated_at || null
    };
  });
}

export async function getAuthoritativeMachineProduct(
  machineId: string,
  productId: number,
  db: any
): Promise<{
  id: number;
  product_id: number;
  machine_id: string;
  name: string;
  default_price: number;
  price: number;
  is_available: boolean;
  description: string;
  image: string;
  updated_at: string | null;
} | null> {
  const products = await getAuthoritativeMachineProducts(machineId, db);
  return products.find((p) => Number(p.id) === Number(productId)) || null;
}

/**
 * Safe registration/metadata sync to Firestore.
 * Uses a transaction so existing Firestore fields (`desired_mode`, `last_seen`, `owner_id`, `estimated_inventory`, `products`)
 * are NEVER overwritten by local default seed values.
 */
export async function syncMachineToFirebase(machine: any): Promise<void> {
  if (!machine || !machine.id) {
    return;
  }

  const desiredMode = normalizeDesiredMode(machine.desired_mode || machine.status);
  const legacyStatus = desiredModeToLegacyStatus(desiredMode);
  const nowIso = new Date().toISOString();

  const existingMirror = syncedMachinesStore.get(machine.id) || {};
  syncedMachinesStore.set(machine.id, {
    ...existingMirror,
    id: machine.id,
    machine_name: machine.machine_name ?? existingMirror.machine_name,
    location: machine.location ?? existingMirror.location,
    desired_mode: existingMirror.desired_mode ?? desiredMode,
    status: existingMirror.status ?? legacyStatus,
    last_seen: existingMirror.last_seen ?? (machine.last_seen || null),
    owner_id: 'owner_id' in existingMirror ? existingMirror.owner_id : (machine.owner_id ?? null),
    ...(machine.kiosk_token ? { kiosk_token: machine.kiosk_token } : {}),
    updated_at: existingMirror.updated_at || nowIso
  });

  if (!firestore) {
    return;
  }

  try {
    const docRef = firestore.collection('machines').doc(machine.id);
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const existing = snap.exists ? snap.data() || {} : {};
      const resolvedMode = existing.desired_mode
        ? normalizeDesiredMode(existing.desired_mode)
        : existing.status
        ? normalizeDesiredMode(existing.status)
        : desiredMode;

      const payload: any = {
        id: machine.id,
        machine_name: existing.machine_name || machine.machine_name,
        location: existing.location || machine.location,
        desired_mode: resolvedMode,
        status: desiredModeToLegacyStatus(resolvedMode),
        last_seen: existing.last_seen ?? (machine.last_seen || null),
        owner_id: 'owner_id' in existing ? existing.owner_id : (machine.owner_id ?? null),
        updated_at: existing.updated_at || nowIso
      };
      if (machine.kiosk_token && !existing.kiosk_token) {
        payload.kiosk_token = machine.kiosk_token;
      }
      tx.set(docRef, payload, { merge: true });
    });
    logger.info(`Synced machine metadata ${machine.id} to Firestore without overwriting state`);
  } catch (error) {
    logger.error(`Failed to sync machine ${machine.id} to Firestore:`, error);
  }
}

export async function getMachineFromFirebase(machineId: string): Promise<any | null> {
  if (!machineId) {
    return null;
  }
  if (!firestore) {
    return syncedMachinesStore.get(machineId) || null;
  }
  try {
    const snap = await firestore.collection('machines').doc(machineId).get();
    if (snap.exists) {
      const data = snap.data() || null;
      if (data) {
        syncedMachinesStore.set(machineId, data);
      }
      return data;
    }
  } catch (error) {
    logger.error(`Failed to fetch machine ${machineId} from Firestore:`, error);
  }
  return syncedMachinesStore.get(machineId) || null;
}

export async function getAllMachinesFromFirebase(): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  for (const [k, v] of syncedMachinesStore.entries()) {
    result.set(k, v);
  }
  if (!firestore) {
    return result;
  }
  try {
    const snapshot = await firestore.collection('machines').get();
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data) {
        const id = data.id || doc.id;
        result.set(id, { ...data, id });
        syncedMachinesStore.set(id, { ...data, id });
      }
    });
  } catch (error) {
    logger.error('Failed to fetch all machines from Firestore:', error);
  }
  return result;
}

/**
 * Authoritative read-through & hydration for a single machine.
 * Uses Firestore (or syncedMachinesStore in local tests) as the authoritative source of truth,
 * prevents local SQLite/MockDatabase seed defaults from overwriting newer Firestore data,
 * and computes real-time `connection_status` from `last_seen` (90s timeout) separately from `desired_mode`.
 */
export async function getAuthoritativeMachineState(machineId: string, db: any): Promise<any | null> {
  if (!machineId) return null;

  let localMachine = await db.get('SELECT * FROM machines WHERE id = ?', [machineId]);
  const remoteMachine = await getMachineFromFirebase(machineId);

  if (!localMachine && !remoteMachine) {
    return null;
  }

  // Merge with Firestore taking precedence over local seed defaults
  const resolvedMachineName =
    remoteMachine?.machine_name || localMachine?.machine_name || `Kiosk-${machineId}`;
  const resolvedLocation =
    remoteMachine?.location || localMachine?.location || 'Registered Location';

  // Determine desired_mode: prefer Firestore if present, otherwise local DB
  const resolvedDesiredMode: DesiredMode =
    remoteMachine?.desired_mode !== undefined
      ? normalizeDesiredMode(remoteMachine.desired_mode)
      : remoteMachine?.status !== undefined
      ? normalizeDesiredMode(remoteMachine.status)
      : normalizeDesiredMode(localMachine?.desired_mode || localMachine?.status);

  const resolvedLegacyStatus = desiredModeToLegacyStatus(resolvedDesiredMode);

  // Determine last_seen: pick whichever timestamp is newer between Firestore and local DB
  const remoteLastSeen = remoteMachine?.last_seen && String(remoteMachine.last_seen).trim() ? String(remoteMachine.last_seen).trim() : null;
  const localLastSeen = localMachine?.last_seen && String(localMachine.last_seen).trim() ? String(localMachine.last_seen).trim() : null;
  let resolvedLastSeen: string | null = remoteLastSeen || localLastSeen || null;
  if (remoteLastSeen && localLastSeen) {
    const rMs = Date.parse(remoteLastSeen);
    const lMs = Date.parse(localLastSeen);
    if (!Number.isNaN(rMs) && !Number.isNaN(lMs)) {
      resolvedLastSeen = rMs >= lMs ? remoteLastSeen : localLastSeen;
    }
  }

  const resolvedKioskToken = remoteMachine?.kiosk_token || localMachine?.kiosk_token || null;

  // Determine owner_id: if remoteMachine has an explicit owner_id property (including null after unassignment), use it;
  // otherwise fall back to localMachine.owner_id. Preserve string UUIDs ('usr_...').
  let resolvedOwnerId: string | null = null;
  if (remoteMachine && 'owner_id' in remoteMachine) {
    resolvedOwnerId =
      remoteMachine.owner_id !== null && remoteMachine.owner_id !== undefined && String(remoteMachine.owner_id).trim() !== ''
        ? String(remoteMachine.owner_id).trim()
        : null;
  } else if (localMachine?.owner_id !== null && localMachine?.owner_id !== undefined && String(localMachine.owner_id).trim() !== '') {
    resolvedOwnerId = String(localMachine.owner_id).trim();
  }

  const resolvedUpdatedAt =
    remoteMachine?.updated_at || localMachine?.updated_at || new Date().toISOString();

  // Hydrate local DB cache from authoritative state
  if (!localMachine) {
    await db.run(
      'INSERT INTO machines (id, machine_name, location, status, last_seen, kiosk_token, desired_mode, owner_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        machineId,
        resolvedMachineName,
        resolvedLocation,
        resolvedLegacyStatus,
        resolvedLastSeen || '',
        resolvedKioskToken,
        resolvedDesiredMode,
        resolvedOwnerId,
        resolvedUpdatedAt
      ]
    );
  } else {
    await db.run(
      'UPDATE machines SET machine_name = ?, location = ?, desired_mode = ?, status = ?, last_seen = ?, kiosk_token = ?, owner_id = ?, updated_at = ? WHERE id = ?',
      [
        resolvedMachineName,
        resolvedLocation,
        resolvedDesiredMode,
        resolvedLegacyStatus,
        resolvedLastSeen || '',
        resolvedKioskToken,
        resolvedOwnerId,
        resolvedUpdatedAt,
        machineId
      ]
    );
  }

  // Ensure local inventory row exists and hydrate from Firestore estimated_inventory if Firestore has it
  let localInv = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [machineId]);
  if (!localInv) {
    await db.run(
      'INSERT INTO inventory (machine_id, milk_level, coffee_level, vanilla_level, hazelnut_level, irish_level, mocha_level, water_level, updated_at) VALUES (?, 100, 100, 100, 100, 100, 100, 100, ?)',
      [machineId, resolvedUpdatedAt]
    );
    localInv = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [machineId]);
  }

  const remoteInv = remoteMachine?.estimated_inventory;
  if (remoteInv && typeof remoteInv === 'object') {
    const remoteInvUpdated = remoteMachine?.inventory_updated_at || remoteMachine?.updated_at || '';
    const localInvUpdated = localInv?.updated_at || '2026-01-01T00:00:00.000Z';
    if (!localInvUpdated || remoteInvUpdated >= localInvUpdated) {
      await db.run(
        'UPDATE inventory SET milk_level = ?, coffee_level = ?, vanilla_level = ?, hazelnut_level = ?, irish_level = ?, mocha_level = ?, water_level = ?, updated_at = ? WHERE machine_id = ?',
        [
          remoteInv.milk_level ?? localInv.milk_level,
          remoteInv.coffee_level ?? localInv.coffee_level,
          remoteInv.vanilla_level ?? localInv.vanilla_level,
          remoteInv.hazelnut_level ?? localInv.hazelnut_level,
          remoteInv.irish_level ?? localInv.irish_level,
          remoteInv.mocha_level ?? localInv.mocha_level,
          remoteInv.water_level ?? localInv.water_level,
          remoteInvUpdated || new Date().toISOString(),
          machineId
        ]
      );
      localInv = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [machineId]);
    }
  }

  const connectionStatus = computeConnectionStatus(resolvedLastSeen);

  return {
    id: machineId,
    machine_name: resolvedMachineName,
    location: resolvedLocation,
    desired_mode: resolvedDesiredMode,
    connection_status: connectionStatus,
    status: resolvedLegacyStatus,
    maintenance: resolvedDesiredMode === 'MAINTENANCE',
    last_seen: resolvedLastSeen,
    kiosk_token: resolvedKioskToken,
    owner_id: resolvedOwnerId,
    updated_at: resolvedUpdatedAt,
    inventory_source: 'software_estimated',
    inventory: {
      milk_level: localInv?.milk_level ?? 100,
      coffee_level: localInv?.coffee_level ?? 100,
      vanilla_level: localInv?.vanilla_level ?? 100,
      hazelnut_level: localInv?.hazelnut_level ?? 100,
      irish_level: localInv?.irish_level ?? 100,
      mocha_level: localInv?.mocha_level ?? 100,
      water_level: localInv?.water_level ?? 100
    }
  };
}

/**
 * Authoritative read-through & hydration for all machines.
 */
export async function getAuthoritativeMachinesList(db: any): Promise<any[]> {
  const localMachines = await db.all('SELECT * FROM machines');
  const remoteMachinesMap = await getAllMachinesFromFirebase();

  const allMachineIds = new Set<string>();
  for (const m of localMachines) {
    if (m?.id) allMachineIds.add(m.id);
  }
  for (const mId of remoteMachinesMap.keys()) {
    if (mId) allMachineIds.add(mId);
  }

  const results: any[] = [];
  for (const mId of allMachineIds) {
    const state = await getAuthoritativeMachineState(mId, db);
    if (state) {
      results.push(state);
    }
  }
  return results;
}

/**
 * Authoritative Firestore Synchronization & Read-Through for Users (Owner & Admin accounts)
 */
export async function syncUserToFirebase(user: {
  id: string;
  name: string;
  email: string;
  password: string;
  role: 'admin' | 'kiosk' | 'owner';
  setup_token_hash?: string | null;
  setup_token_expires_at?: string | null;
  must_change_password?: number;
  updated_at?: string;
}): Promise<void> {
  if (!user || !user.id) return;
  const userId = String(user.id);
  const nowIso = user.updated_at || new Date().toISOString();

  const payload = {
    id: userId,
    name: user.name,
    email: String(user.email).toLowerCase(),
    password: user.password,
    role: user.role,
    setup_token_hash: user.setup_token_hash ?? null,
    setup_token_expires_at: user.setup_token_expires_at ?? null,
    must_change_password: user.must_change_password ?? 0,
    updated_at: nowIso
  };

  syncedUsersStore.set(userId, payload);

  if (!firestore) {
    return;
  }

  try {
    await firestore.collection('users').doc(userId).set(payload, { merge: true });
    logger.info(`Synced user ${payload.email} (id=${userId}, role=${payload.role}) to Firestore`);
  } catch (error) {
    logger.error(`Failed to sync user ${userId} to Firestore:`, error);
  }
}

async function hydrateLocalUserFromAuthoritativeRecord(record: any, db: any): Promise<any> {
  if (!record || !record.id) return null;
  const userId = String(record.id);
  const email = String(record.email).toLowerCase();
  const existingById = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  const existingByEmail = existingById || (await db.get('SELECT * FROM users WHERE email = ?', [email]));

  if (!existingByEmail) {
    await db.run(
      'INSERT INTO users (id, name, email, password, role, setup_token_hash, setup_token_expires_at, must_change_password, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        userId,
        record.name,
        email,
        record.password,
        record.role,
        record.setup_token_hash ?? null,
        record.setup_token_expires_at ?? null,
        record.must_change_password ?? 0,
        record.updated_at || new Date().toISOString()
      ]
    );
  } else {
    await db.run(
      'UPDATE users SET name = ?, email = ?, password = ?, role = ?, setup_token_hash = ?, setup_token_expires_at = ?, must_change_password = ?, updated_at = ? WHERE id = ?',
      [
        record.name,
        email,
        record.password,
        record.role,
        record.setup_token_hash ?? null,
        record.setup_token_expires_at ?? null,
        record.must_change_password ?? 0,
        record.updated_at || new Date().toISOString(),
        String(existingByEmail.id)
      ]
    );
  }
  return await db.get('SELECT * FROM users WHERE email = ?', [email]);
}

export async function getAuthoritativeUserByEmail(email: string, db: any): Promise<any | null> {
  if (!email) return null;
  const normalizedEmail = String(email).trim().toLowerCase();

  let remoteUser: any = null;
  for (const u of syncedUsersStore.values()) {
    if (String(u.email).toLowerCase() === normalizedEmail) {
      remoteUser = u;
      break;
    }
  }

  if (firestore) {
    try {
      const snap = await firestore
        .collection('users')
        .where('email', '==', normalizedEmail)
        .limit(1)
        .get();
      if (!snap.empty) {
        const doc = snap.docs[0];
        const data = doc.data();
        remoteUser = { ...data, id: data.id || doc.id };
        syncedUsersStore.set(String(remoteUser.id), remoteUser);
      }
    } catch (error) {
      logger.error(`Failed to query user by email ${normalizedEmail} from Firestore:`, error);
    }
  }

  if (remoteUser) {
    return await hydrateLocalUserFromAuthoritativeRecord(remoteUser, db);
  }

  return await db.get('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
}

export async function getAuthoritativeUserById(userId: string | number, db: any): Promise<any | null> {
  if (userId === undefined || userId === null) return null;
  const normalizedId = String(userId).trim();

  let remoteUser: any = syncedUsersStore.get(normalizedId) || null;

  if (firestore) {
    try {
      const snap = await firestore.collection('users').doc(normalizedId).get();
      if (snap.exists) {
        const data = snap.data();
        if (data) {
          remoteUser = { ...data, id: data.id || snap.id };
          syncedUsersStore.set(normalizedId, remoteUser);
        }
      }
    } catch (error) {
      logger.error(`Failed to fetch user by id ${normalizedId} from Firestore:`, error);
    }
  }

  if (remoteUser) {
    return await hydrateLocalUserFromAuthoritativeRecord(remoteUser, db);
  }

  return await db.get('SELECT * FROM users WHERE id = ?', [normalizedId]);
}

export async function getAuthoritativeUserBySetupTokenHash(tokenHash: string, db: any): Promise<any | null> {
  if (!tokenHash) return null;

  let remoteUser: any = null;
  for (const u of syncedUsersStore.values()) {
    if (u.setup_token_hash && u.setup_token_hash === tokenHash) {
      remoteUser = u;
      break;
    }
  }

  if (firestore) {
    try {
      const snap = await firestore
        .collection('users')
        .where('setup_token_hash', '==', tokenHash)
        .limit(1)
        .get();
      if (!snap.empty) {
        const doc = snap.docs[0];
        const data = doc.data();
        remoteUser = { ...data, id: data.id || doc.id };
        syncedUsersStore.set(String(remoteUser.id), remoteUser);
      }
    } catch (error) {
      logger.error('Failed to query user by setup_token_hash from Firestore:', error);
    }
  }

  if (remoteUser) {
    return await hydrateLocalUserFromAuthoritativeRecord(remoteUser, db);
  }

  return await db.get('SELECT * FROM users WHERE setup_token_hash = ?', [tokenHash]);
}

export async function getAuthoritativeOwnersList(db: any): Promise<any[]> {
  if (firestore) {
    try {
      const snap = await firestore.collection('users').where('role', '==', 'owner').get();
      snap.forEach((doc) => {
        const data = doc.data();
        if (data) {
          const id = String(data.id || doc.id);
          syncedUsersStore.set(id, { ...data, id });
        }
      });
    } catch (error) {
      logger.error('Failed to query owners from Firestore:', error);
    }
  }

  for (const u of syncedUsersStore.values()) {
    if (u.role === 'owner') {
      await hydrateLocalUserFromAuthoritativeRecord(u, db);
    }
  }

  return await db.all('SELECT * FROM users WHERE role = ?', ['owner']);
}

// Per-token-hash atomic lock to serialize concurrent password setup attempts within an instance
const setupTokenLocks = new Map<string, Promise<any>>();

export interface ConsumeSetupTokenResult {
  success: boolean;
  reason?: 'INVALID_OR_USED' | 'EMAIL_MISMATCH' | 'EXPIRED';
  user?: {
    id: string;
    name: string;
    email: string;
    role: 'admin' | 'kiosk' | 'owner';
  };
}

async function performAtomicSetupTokenConsumption(
  tokenHash: string,
  hashedPassword: string,
  expectedEmail: string | undefined,
  db: any
): Promise<ConsumeSetupTokenResult> {
  const normalizedExpectedEmail = expectedEmail ? String(expectedEmail).trim().toLowerCase() : undefined;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // 1. Locate candidate user by tokenHash across Firestore, in-memory mirror, or local DB
  const candidateUser = await getAuthoritativeUserBySetupTokenHash(tokenHash, db);
  if (!candidateUser || !candidateUser.setup_token_hash || candidateUser.setup_token_hash !== tokenHash) {
    return { success: false, reason: 'INVALID_OR_USED' };
  }

  const userId = String(candidateUser.id);

  // 2. If Firestore is connected, execute an atomic Firestore transaction on users/{userId}
  if (firestore) {
    const docRef = firestore.collection('users').doc(userId);
    const txOutcome = await firestore.runTransaction(async (tx): Promise<ConsumeSetupTokenResult> => {
      const snap = await tx.get(docRef);
      if (!snap.exists) {
        return { success: false, reason: 'INVALID_OR_USED' };
      }
      const data = snap.data() || {};
      if (!data.setup_token_hash || data.setup_token_hash !== tokenHash) {
        return { success: false, reason: 'INVALID_OR_USED' };
      }
      if (
        normalizedExpectedEmail &&
        String(data.email || '').toLowerCase() !== normalizedExpectedEmail
      ) {
        return { success: false, reason: 'EMAIL_MISMATCH' };
      }
      const expMs = data.setup_token_expires_at ? Date.parse(data.setup_token_expires_at) : NaN;
      if (Number.isNaN(expMs) || nowMs > expMs) {
        return { success: false, reason: 'EXPIRED' };
      }

      tx.set(
        docRef,
        {
          password: hashedPassword,
          setup_token_hash: null,
          setup_token_expires_at: null,
          must_change_password: 0,
          updated_at: nowIso
        },
        { merge: true }
      );

      return {
        success: true,
        user: {
          id: userId,
          name: data.name || candidateUser.name,
          email: String(data.email || candidateUser.email).toLowerCase(),
          role: data.role || candidateUser.role
        }
      };
    });

    if (!txOutcome.success) {
      return txOutcome;
    }
  } else {
    // 3. In-memory Firestore mirror check & atomic consumption
    const mirrorUser = syncedUsersStore.get(userId) || candidateUser;
    if (!mirrorUser.setup_token_hash || mirrorUser.setup_token_hash !== tokenHash) {
      return { success: false, reason: 'INVALID_OR_USED' };
    }
    if (
      normalizedExpectedEmail &&
      String(mirrorUser.email || '').toLowerCase() !== normalizedExpectedEmail
    ) {
      return { success: false, reason: 'EMAIL_MISMATCH' };
    }
    const expMs = mirrorUser.setup_token_expires_at ? Date.parse(mirrorUser.setup_token_expires_at) : NaN;
    if (Number.isNaN(expMs) || nowMs > expMs) {
      return { success: false, reason: 'EXPIRED' };
    }
  }

  // 4. Conditional atomic SQL update in SQLite / MockDatabase (`WHERE id = ? AND setup_token_hash = ?`)
  const dbResult = await db.run(
    'UPDATE users SET password = ?, setup_token_hash = NULL, setup_token_expires_at = NULL, must_change_password = 0, updated_at = ? WHERE id = ? AND setup_token_hash = ?',
    [hashedPassword, nowIso, userId, tokenHash]
  );

  if (!dbResult || dbResult.changes !== 1) {
    return { success: false, reason: 'INVALID_OR_USED' };
  }

  // 5. Update in-memory Firestore mirror with invalidated token
  syncedUsersStore.set(userId, {
    id: userId,
    name: candidateUser.name,
    email: String(candidateUser.email).toLowerCase(),
    password: hashedPassword,
    role: candidateUser.role,
    setup_token_hash: null,
    setup_token_expires_at: null,
    must_change_password: 0,
    updated_at: nowIso
  });

  return {
    success: true,
    user: {
      id: userId,
      name: candidateUser.name,
      email: String(candidateUser.email).toLowerCase(),
      role: candidateUser.role
    }
  };
}

export async function consumeSetupTokenAtomically(
  tokenHash: string,
  hashedPassword: string,
  expectedEmail: string | undefined,
  db: any
): Promise<ConsumeSetupTokenResult> {
  const prevLock = setupTokenLocks.get(tokenHash) || Promise.resolve();
  const nextPromise = prevLock
    .catch(() => {})
    .then(() => performAtomicSetupTokenConsumption(tokenHash, hashedPassword, expectedEmail, db));

  setupTokenLocks.set(tokenHash, nextPromise);
  try {
    return await nextPromise;
  } finally {
    if (setupTokenLocks.get(tokenHash) === nextPromise) {
      setupTokenLocks.delete(tokenHash);
    }
  }
}

/**
 * Authoritative Firestore Order Read-Through & Hydration
 * Preserves historical charged `amount` on each order across Vercel serverless cold starts.
 */
async function hydrateLocalOrderFromAuthoritativeRecord(remoteOrder: any, db: any): Promise<any | null> {
  if (!remoteOrder || !remoteOrder.id) return null;
  const orderId = String(remoteOrder.id);
  const existing = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);

  if (!existing) {
    await db.run(
      'INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_order_id, extra_sugar, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        orderId,
        Number(remoteOrder.product_id),
        Number(remoteOrder.amount),
        String(remoteOrder.status || 'PENDING').toUpperCase(),
        String(remoteOrder.machine_id),
        remoteOrder.created_at || new Date().toISOString(),
        remoteOrder.razorpay_order_id || null,
        remoteOrder.extra_sugar ?? 1,
        remoteOrder.base || 'water'
      ]
    );
    if (remoteOrder.razorpay_payment_id || remoteOrder.razorpay_signature) {
      await db.run(
        'UPDATE orders SET razorpay_payment_id = ?, razorpay_signature = ? WHERE id = ?',
        [
          remoteOrder.razorpay_payment_id || null,
          remoteOrder.razorpay_signature || null,
          orderId
        ]
      );
    }
  } else {
    if (remoteOrder.status && remoteOrder.status !== existing.status) {
      await db.run('UPDATE orders SET status = ? WHERE id = ?', [
        String(remoteOrder.status).toUpperCase(),
        orderId
      ]);
    }
    if (remoteOrder.razorpay_payment_id && !existing.razorpay_payment_id) {
      await db.run(
        'UPDATE orders SET razorpay_payment_id = ?, razorpay_signature = ? WHERE id = ?',
        [
          remoteOrder.razorpay_payment_id,
          remoteOrder.razorpay_signature || existing.razorpay_signature || null,
          orderId
        ]
      );
    }
  }

  return await db.get(
    `SELECT o.*, p.name as product_name, p.description as product_desc
     FROM orders o
     JOIN products p ON o.product_id = p.id
     WHERE o.id = ?`,
    [orderId]
  );
}

export async function getAuthoritativeOrderById(orderId: string, db: any): Promise<any | null> {
  if (!orderId) return null;
  const normalizedId = String(orderId).trim();

  let remoteOrder: any = syncedOrdersStore.get(normalizedId) || null;

  if (firestore) {
    try {
      const snap = await firestore.collection('orders').doc(normalizedId).get();
      if (snap.exists) {
        const data = snap.data();
        if (data) {
          remoteOrder = { ...data, id: data.id || snap.id };
          syncedOrdersStore.set(normalizedId, remoteOrder);
        }
      }
    } catch (error) {
      logger.error(`Failed to fetch order ${normalizedId} from Firestore:`, error);
    }
  }

  if (remoteOrder) {
    return await hydrateLocalOrderFromAuthoritativeRecord(remoteOrder, db);
  }

  return await db.get(
    `SELECT o.*, p.name as product_name, p.description as product_desc
     FROM orders o
     JOIN products p ON o.product_id = p.id
     WHERE o.id = ?`,
    [normalizedId]
  );
}

export async function getAuthoritativeOrderByRazorpayOrderId(
  rpOrderId: string,
  db: any
): Promise<any | null> {
  if (!rpOrderId) return null;
  const normalizedRpId = String(rpOrderId).trim();

  let remoteOrder: any = null;
  for (const o of syncedOrdersStore.values()) {
    if (o.razorpay_order_id && o.razorpay_order_id === normalizedRpId) {
      remoteOrder = o;
      break;
    }
  }

  if (firestore) {
    try {
      const snap = await firestore
        .collection('orders')
        .where('razorpay_order_id', '==', normalizedRpId)
        .limit(1)
        .get();
      if (!snap.empty) {
        const doc = snap.docs[0];
        const data = doc.data();
        if (data) {
          remoteOrder = { ...data, id: data.id || doc.id };
          syncedOrdersStore.set(String(remoteOrder.id), remoteOrder);
        }
      }
    } catch (error) {
      logger.error(`Failed to query order by razorpay_order_id ${normalizedRpId} from Firestore:`, error);
    }
  }

  if (remoteOrder) {
    return await hydrateLocalOrderFromAuthoritativeRecord(remoteOrder, db);
  }

  return await db.get('SELECT * FROM orders WHERE razorpay_order_id = ?', [normalizedRpId]);
}

export async function getAuthoritativeOrders(
  db: any,
  filterMachineIds?: string[]
): Promise<any[]> {
  if (firestore) {
    try {
      const snap = await firestore.collection('orders').get();
      snap.forEach((doc) => {
        const data = doc.data();
        if (data) {
          const id = String(data.id || doc.id);
          syncedOrdersStore.set(id, { ...data, id });
        }
      });
    } catch (error) {
      logger.error('Failed to fetch orders from Firestore:', error);
    }
  }

  for (const o of syncedOrdersStore.values()) {
    await hydrateLocalOrderFromAuthoritativeRecord(o, db);
  }

  if (filterMachineIds !== undefined) {
    if (filterMachineIds.length === 0) {
      return [];
    }
    const allowedSet = new Set(filterMachineIds.map((m) => String(m).trim()));
    if (filterMachineIds.length === 1) {
      return await db.all(
        `SELECT o.*, p.name as product_name 
         FROM orders o
         JOIN products p ON o.product_id = p.id
         WHERE o.machine_id = ?
         ORDER BY o.created_at DESC`,
        [filterMachineIds[0]]
      );
    }
    const allOrders = await db.all(
      `SELECT o.*, p.name as product_name 
       FROM orders o
       JOIN products p ON o.product_id = p.id
       ORDER BY o.created_at DESC`
    );
    return allOrders.filter((o: any) => allowedSet.has(String(o.machine_id).trim()));
  }

  return await db.all(
    `SELECT o.*, p.name as product_name 
     FROM orders o
     JOIN products p ON o.product_id = p.id
     ORDER BY o.created_at DESC`
  );
}
