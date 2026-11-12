import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getDB } from '../config/db';
import { getAuthoritativeMachineState, getAuthoritativeMachinesList } from '../utils/firebase';
import { ServiceUnavailableError } from '../utils/errors';
import {
  getJwtSecret,
  constantTimeEqual,
  isVercelProduction,
  isMockSecretValue
} from '../utils/security';
import logger from '../utils/logger';

const MACHINE_ID_REGEX = /^CFX-MC-\d{2,4}$/;

function getEnvPerMachineTokens(): Map<string, string> {
  const map = new Map<string, string>();
  const rawKeys = process.env.KIOSK_MACHINE_KEYS || '';
  if (rawKeys.trim()) {
    for (const pair of rawKeys.split(',')) {
      const [mId, token] = pair.split(':').map(s => s.trim());
      if (mId && token) {
        map.set(mId, token);
      }
    }
  }
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envKey.startsWith('KIOSK_SECRET_') && envVal && envVal.trim()) {
      const mId = envKey.replace('KIOSK_SECRET_', '').replace(/_/g, '-');
      map.set(mId, envVal.trim());
    }
  }
  return map;
}

export async function ensureMachineRegisteredInLocalDB(machineId: string): Promise<any | null> {
  const db = getDB();
  return await getAuthoritativeMachineState(machineId, db);
}

export const verifyKiosk = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const kiosk = typeof req.query.kiosk === 'string' ? req.query.kiosk.trim() : '';
    const hasMachineQueryParam = Object.prototype.hasOwnProperty.call(req.query, 'machine_id');
    const rawMachineId = typeof req.query.machine_id === 'string' ? req.query.machine_id.trim() : '';

    const sharedSecret = (process.env.KIOSK_SECRET || '').trim();
    const validSharedSecret =
      sharedSecret && (!isVercelProduction() || !isMockSecretValue(sharedSecret))
        ? sharedSecret
        : '';

    const db = getDB();
    const envMachineTokens = getEnvPerMachineTokens();

    // Hydrate authoritative machine records (and per-machine kiosk_token) from Firestore if needed
    await getAuthoritativeMachinesList(db);
    const allMachineTokenRows: Array<{ id: string; kiosk_token: string | null }> = await db.all(
      'SELECT id, kiosk_token FROM machines WHERE kiosk_token IS NOT NULL AND kiosk_token != ""'
    );
    const dbMachineTokenRows = allMachineTokenRows.filter(
      (r): r is { id: string; kiosk_token: string } =>
        Boolean(r?.kiosk_token && String(r.kiosk_token).trim())
    );
    const hasAnyConfiguredCredential =
      Boolean(validSharedSecret) ||
      envMachineTokens.size > 0 ||
      dbMachineTokenRows.length > 0;

    if (isVercelProduction() && !hasAnyConfiguredCredential) {
      return next(
        new ServiceUnavailableError(
          'Kiosk authentication unavailable: no kiosk credentials are configured for Production'
        )
      );
    }

    if (!kiosk) {
      res.status(401).json({
        authorized: false,
        message: 'Unauthorized kiosk: missing kiosk credential'
      });
      return;
    }

    // If machine_id query parameter was explicitly included in the URL, it must be non-empty and valid format
    if (hasMachineQueryParam) {
      if (!rawMachineId || !MACHINE_ID_REGEX.test(rawMachineId)) {
        logger.warn(`Rejected invalid machine_id parameter: "${rawMachineId}"`);
        res.status(401).json({
          authorized: false,
          message: 'Unauthorized kiosk: invalid machine_id format'
        });
        return;
      }
    }

    // 1. Check if the provided kiosk token is a per-machine token in env vars
    let tokenBoundMachineId: string | null = null;
    for (const [mId, mToken] of envMachineTokens.entries()) {
      if (constantTimeEqual(mToken, kiosk)) {
        tokenBoundMachineId = mId;
        break;
      }
    }

    // 2. Check if the provided kiosk token is a per-machine token in database / Firestore
    if (!tokenBoundMachineId) {
      for (const row of dbMachineTokenRows) {
        if (row.kiosk_token && constantTimeEqual(String(row.kiosk_token), kiosk)) {
          tokenBoundMachineId = row.id;
          break;
        }
      }
    }

    let resolvedMachineId: string | null = null;

    if (tokenBoundMachineId) {
      // A per-machine token can ONLY authenticate its own bound machine
      if (hasMachineQueryParam && rawMachineId !== tokenBoundMachineId) {
        logger.warn(`Kiosk token machine mismatch: token bound to ${tokenBoundMachineId}, URL requested ${rawMachineId}`);
        res.status(401).json({
          authorized: false,
          message: 'Unauthorized kiosk: machine_id does not match registered machine credential'
        });
        return;
      }
      resolvedMachineId = tokenBoundMachineId;
    } else if (validSharedSecret && constantTimeEqual(kiosk, validSharedSecret)) {
      resolvedMachineId = hasMachineQueryParam ? rawMachineId : 'CFX-MC-01';

      // If this machine has a dedicated token (env or DB), never allow the shared secret to authenticate it
      const dedicatedEnvToken = envMachineTokens.get(resolvedMachineId);
      const dbDedicated = dbMachineTokenRows.find((r) => r.id === resolvedMachineId)?.kiosk_token;
      if (dedicatedEnvToken || (process.env.ENFORCE_PER_MACHINE_SECRETS === 'true' && dbDedicated) || dbDedicated) {
        res.status(401).json({
          authorized: false,
          message: 'Unauthorized kiosk: machine requires its dedicated credential'
        });
        return;
      }
    } else {
      res.status(401).json({
        authorized: false,
        message: 'Unauthorized kiosk'
      });
      return;
    }

    // 3. Verify that resolvedMachineId is a registered machine
    const machine = await ensureMachineRegisteredInLocalDB(resolvedMachineId);
    if (!machine) {
      logger.warn(`Kiosk verification rejected for unregistered machine_id: ${resolvedMachineId}`);
      res.status(401).json({
        authorized: false,
        message: `Unauthorized kiosk: machine ${resolvedMachineId} is not registered`
      });
      return;
    }

    // If strict per-machine secret enforcement is enabled and DB row has a dedicated kiosk_token, verify it
    if (
      process.env.ENFORCE_PER_MACHINE_SECRETS === 'true' &&
      machine.kiosk_token &&
      !constantTimeEqual(String(machine.kiosk_token), kiosk)
    ) {
      res.status(401).json({
        authorized: false,
        message: 'Unauthorized kiosk: invalid credential for this machine'
      });
      return;
    }

    // 4. Issue a machine-scoped JWT so all subsequent API calls from this kiosk are cryptographically bound to machine.id
    const token = jwt.sign(
      {
        id: `kiosk_${machine.id}`,
        email: `${machine.id.toLowerCase()}@caffix.com`,
        role: 'kiosk',
        name: machine.machine_name,
        machine_id: machine.id
      },
      getJwtSecret(),
      { expiresIn: '24h' }
    );

    res.status(200).json({
      authorized: true,
      machine_id: machine.id,
      machine_name: machine.machine_name,
      token
    });
  } catch (error) {
    next(error);
  }
};
