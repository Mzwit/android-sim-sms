import { hash, verify } from '@node-rs/argon2';

// OWASP 2024 recommendation for argon2id: m=19 MiB, t=2, p=1 (minimum).
// We use 64 MiB / t=3, which takes ~100–200 ms on a typical PC.
const OPTIONS = { memoryCost: 65536, timeCost: 3, parallelism: 1, outputLen: 32 } as const;
// Lighter parameters for automated tests only.
const TEST_OPTIONS = { memoryCost: 8192, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

const opts = () => (process.env.NODE_ENV === 'test' ? TEST_OPTIONS : OPTIONS);

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, { ...opts(), algorithm: 2 /* Argon2id */ });
}

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain);
  } catch {
    return false;
  }
}

// Used to keep timing similar when the email does not exist.
let dummyHash: Promise<string> | undefined;
export async function burnVerify(plain: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummyHash, plain);
}

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

/** Length-first policy (NIST SP 800-63B): >= 12 chars, not trivially weak, not the email. */
export function checkPasswordPolicy(password: string, email?: string): PasswordCheck {
  const problems: string[] = [];
  if (password.length < 12) problems.push('Use at least 12 characters');
  if (password.length > 256) problems.push('Use at most 256 characters');
  if (/^(.)\1+$/.test(password)) problems.push('Do not repeat one character');
  const lower = password.toLowerCase();
  const weak = ['password', '123456789', 'qwerty', 'letmein', 'admin123', 'eswatini', 'welcome1'];
  if (weak.some((w) => lower.includes(w)) && password.length < 20) problems.push('Avoid common passwords');
  if (email) {
    const local = email.split('@')[0]!.toLowerCase();
    if (local.length >= 4 && lower.includes(local)) problems.push('Do not include your email name');
  }
  return { ok: problems.length === 0, problems };
}
