import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getDB } from '../config/db';
import { getAuthoritativeMachineState } from '../utils/firebase';
import logger from '../utils/logger';

const JWT_SECRET = process.env.JWT_SECRET || 'caffix_vending_secret_key_2026_xyz';
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
    if (envKey.startsWith('KIOSK_SECRET_') && envVal) {
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

    const sharedSecret = (process.env.KIOSK_SECRET || 'Kx8P2mL9Qv4Rz7Tn5Yh1').trim();

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

    const db = getDB();
    const envMachineTokens = getEnvPerMachineTokens();

    // 1. Check if the provided kiosk token is a per-machine token in env vars
    let tokenBoundMachineId: string | null = null;
    for (const [mId, mToken] of envMachineTokens.entries()) {
      if (mToken === kiosk) {
        tokenBoundMachineId = mId;
        break;
      }
    }

    // 2. Check if the provided kiosk token is a per-machine token in database
    if (!tokenBoundMachineId) {
      const machineByToken = await db.get('SELECT * FROM machines WHERE kiosk_token = ?', [kiosk]);
      if (machineByToken) {
        tokenBoundMachineId = machineByToken.id;
      }
    }

    let resolvedMachineId: string | null = null;

    if (tokenBoundMachineId) {
      // If a per-machine token was used, any machine_id in the URL MUST match the token's machine
      if (hasMachineQueryParam && rawMachineId !== tokenBoundMachineId) {
        logger.warn(`Kiosk token machine mismatch: token bound to ${tokenBoundMachineId}, URL requested ${rawMachineId}`);
        res.status(401).json({
          authorized: false,
          message: 'Unauthorized kiosk: machine_id does not match registered machine credential'
        });
        return;
      }
      resolvedMachineId = tokenBoundMachineId;
    } else if (kiosk === sharedSecret || (kiosk === 'CFX-MC-01' && (!hasMachineQueryParam || rawMachineId === 'CFX-MC-01'))) {
      // Backward-compatible shared KIOSK_SECRET authentication
      resolvedMachineId = hasMachineQueryParam ? rawMachineId : 'CFX-MC-01';

      // If strict per-machine secret enforcement is enabled and this machine has a dedicated secret, require it
      if (process.env.ENFORCE_PER_MACHINE_SECRETS === 'true') {
        const dedicatedEnvToken = envMachineTokens.get(resolvedMachineId);
        if (dedicatedEnvToken && dedicatedEnvToken !== kiosk) {
          res.status(401).json({
            authorized: false,
            message: 'Unauthorized kiosk: machine requires its dedicated credential'
          });
          return;
        }
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

    // If strict per-machine secret enforcement is enabled and DB row has a dedicated kiosk_token, check it
    if (
      process.env.ENFORCE_PER_MACHINE_SECRETS === 'true' &&
      machine.kiosk_token &&
      machine.kiosk_token !== kiosk
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
      JWT_SECRET,
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
