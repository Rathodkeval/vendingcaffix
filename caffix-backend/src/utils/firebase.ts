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

export async function syncOrderToFirebase(order: any): Promise<void> {
  if (!firestore) {
    logger.debug(`Firebase Firestore not initialized. Bypassed syncing order: ${order.id}`);
    return;
  }

  try {
    // Sanitize order properties to remove undefined values before uploading to Firestore
    const sanitizedOrder: any = {};
    for (const key of Object.keys(order)) {
      if (order[key] !== undefined) {
        sanitizedOrder[key] = order[key];
      }
    }

    await firestore.collection('orders').doc(order.id).set({
      ...sanitizedOrder,
      updated_at: new Date().toISOString()
    }, { merge: true });
    
    logger.info(`Successfully synced order ${order.id} to Firestore`);
  } catch (error) {
    logger.error(`Failed to sync order ${order.id} to Firestore:`, error);
  }
}
