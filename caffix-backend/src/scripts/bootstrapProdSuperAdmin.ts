import readline from 'readline';
import bcrypt from 'bcryptjs';
import {
  PRODUCTION_FIREBASE_PROJECT_ID,
  STAGING_FIREBASE_PROJECT_ID,
  createProductionSuperAdminInFirebase,
  CreatedProdSuperAdminResult
} from '../utils/firebase';
import { isMockSecretValue } from '../utils/security';

export interface BootstrapPromptIO {
  askText: (prompt: string) => Promise<string>;
  askHidden: (prompt: string) => Promise<string>;
  log?: (message: string) => void;
}

export interface BootstrapScriptOptions {
  io?: BootstrapPromptIO;
}

const FORBIDDEN_WEAK_PASSWORDS = new Set([
  'admin123',
  'kiosk123',
  'password',
  'password123',
  'password123!',
  'caffix123',
  'caffixadmin',
  'changeme',
  'qwerty123',
  '123456789012'
]);

export function assertProductionBootstrapEnvironment(
  env: NodeJS.ProcessEnv = process.env
): void {
  const projectId = String(env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = String(env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = String(env.FIREBASE_PRIVATE_KEY || '').trim();
  const vercelEnv = String(env.VERCEL_ENV || '').trim().toLowerCase();
  const stagingOverride = String(env.STAGING_FIREBASE_PROJECT_ID || '').trim();

  if (vercelEnv && vercelEnv !== 'production') {
    throw new Error(
      `Aborted: VERCEL_ENV="${vercelEnv}" is not "production". Refusing to run Production Super Admin bootstrap.`
    );
  }

  if (projectId !== PRODUCTION_FIREBASE_PROJECT_ID) {
    throw new Error(
      `Aborted: FIREBASE_PROJECT_ID must strictly equal "${PRODUCTION_FIREBASE_PROJECT_ID}" (received "${projectId || '<unset>'}"). Refusing staging or unverified project.`
    );
  }

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Aborted: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY must all be provided in environment variables.'
    );
  }

  if (isMockSecretValue(clientEmail) || isMockSecretValue(privateKey)) {
    throw new Error(
      'Aborted: Mock or placeholder Firebase credentials are not permitted for Production Super Admin bootstrap.'
    );
  }

  if (clientEmail.toLowerCase().includes(STAGING_FIREBASE_PROJECT_ID)) {
    throw new Error(
      `Aborted: FIREBASE_CLIENT_EMAIL appears to target staging project "${STAGING_FIREBASE_PROJECT_ID}".`
    );
  }

  if (stagingOverride && stagingOverride === PRODUCTION_FIREBASE_PROJECT_ID) {
    throw new Error(
      `Aborted: Conflicting STAGING_FIREBASE_PROJECT_ID="${stagingOverride}".`
    );
  }

  // Enforce strict Production mode inside firebase.ts `ensureFirebaseReady()`
  env.VERCEL_ENV = 'production';
}

export function validateSuperAdminName(rawName: string): string {
  const name = String(rawName || '').trim();
  if (name.length < 2 || name.length > 80) {
    throw new Error('Super Admin name must be between 2 and 80 characters.');
  }
  return name;
}

export function validateSuperAdminEmail(rawEmail: string): string {
  const email = String(rawEmail || '').trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!email || !emailRegex.test(email) || email.length > 160) {
    throw new Error('Invalid Super Admin email address.');
  }
  return email;
}

export function validateSuperAdminPasswordPolicy(password: string, email?: string): void {
  const pwd = String(password || '');
  if (pwd.length < 12) {
    throw new Error('Password policy violation: minimum 12 characters required.');
  }
  if (pwd.length > 128) {
    throw new Error('Password policy violation: maximum 128 characters allowed.');
  }
  if (!/[A-Z]/.test(pwd)) {
    throw new Error('Password policy violation: must include at least one uppercase letter.');
  }
  if (!/[a-z]/.test(pwd)) {
    throw new Error('Password policy violation: must include at least one lowercase letter.');
  }
  if (!/[0-9]/.test(pwd)) {
    throw new Error('Password policy violation: must include at least one digit.');
  }
  if (!/[^A-Za-z0-9]/.test(pwd)) {
    throw new Error('Password policy violation: must include at least one special character.');
  }
  if (FORBIDDEN_WEAK_PASSWORDS.has(pwd.toLowerCase())) {
    throw new Error('Password policy violation: chosen password is too weak or matches forbidden default credentials.');
  }
  if (/^(.)\1+$/.test(pwd)) {
    throw new Error('Password policy violation: password cannot consist of a single repeated character.');
  }
  if (email) {
    const localPart = email.split('@')[0]?.toLowerCase() || '';
    if (localPart.length >= 3 && pwd.toLowerCase().includes(localPart)) {
      throw new Error('Password policy violation: password must not contain your email username.');
    }
  }
}

function createInteractiveTextPrompter() {
  return (promptText: string): Promise<string> => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    return new Promise((resolve) => {
      rl.question(promptText, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  };
}

/**
 * getpass-equivalent hidden stdin reader for Node.js TTY sessions.
 * Reads characters in raw mode without echoing them to stdout so passwords are never displayed.
 */
function readHiddenPasswordFromTty(promptText: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.reject(
      new Error(
        'Hidden interactive TTY input is required for password entry (piped/non-TTY stdin is disabled for security).'
      )
    );
  }

  return new Promise((resolve, reject) => {
    process.stdout.write(promptText);
    const stdin = process.stdin;
    const wasRaw = Boolean((stdin as any).isRaw);
    let buffer = '';

    const cleanup = () => {
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // ignore if stream closed
      }
      stdin.pause();
    };

    const onData = (chunk: Buffer) => {
      const str = chunk.toString('utf8');
      for (const ch of str) {
        if (ch === '\r' || ch === '\n') {
          process.stdout.write('\n');
          cleanup();
          resolve(buffer);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl+C
          process.stdout.write('\n');
          cleanup();
          reject(new Error('Bootstrap aborted by operator (SIGINT).'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
          }
          continue;
        }
        buffer += ch;
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export async function runProductionSuperAdminBootstrap(
  options: BootstrapScriptOptions = {}
): Promise<CreatedProdSuperAdminResult> {
  const io: BootstrapPromptIO = options.io || {
    askText: createInteractiveTextPrompter(),
    askHidden: readHiddenPasswordFromTty,
    log: (msg: string) => console.log(msg)
  };
  const log = io.log || ((msg: string) => console.log(msg));

  assertProductionBootstrapEnvironment(process.env);

  log(`CAFFIX Production Super Admin One-Time Bootstrap (${PRODUCTION_FIREBASE_PROJECT_ID})`);
  const confirmProject = String(
    await io.askText(
      `Confirm target Firebase project by typing "${PRODUCTION_FIREBASE_PROJECT_ID}": `
    )
  ).trim();

  if (confirmProject !== PRODUCTION_FIREBASE_PROJECT_ID) {
    throw new Error(
      `Aborted: confirmation "${confirmProject}" did not match "${PRODUCTION_FIREBASE_PROJECT_ID}".`
    );
  }

  const name = validateSuperAdminName(await io.askText('Super Admin Full Name: '));
  const email = validateSuperAdminEmail(await io.askText('Super Admin Email: '));

  let password = await io.askHidden('Super Admin Password (hidden, min 12 chars): ');
  const confirmPassword = await io.askHidden('Confirm Super Admin Password (hidden): ');

  if (password !== confirmPassword) {
    password = '';
    throw new Error('Aborted: Password and confirmation do not match.');
  }

  try {
    validateSuperAdminPasswordPolicy(password, email);
    const passwordHash = bcrypt.hashSync(password, 10);
    password = '';

    const result = await createProductionSuperAdminInFirebase({
      name,
      email,
      passwordHash,
      expectedProjectId: PRODUCTION_FIREBASE_PROJECT_ID
    });

    log(
      `Super Admin bootstrapped cleanly in ${result.projectId}: id=${result.id}, email=${result.email}, role=${result.role}`
    );
    return result;
  } finally {
    password = '';
  }
}

if (require.main === module) {
  runProductionSuperAdminBootstrap()
    .then(() => {
      process.exit(0);
    })
    .catch((err: any) => {
      console.error(`Production Super Admin bootstrap failed: ${err?.message || 'Unknown error'}`);
      process.exit(1);
    });
}

