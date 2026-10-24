import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit URL-safe random token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Stable hash of a JSON-serialisable value (keys sorted) for idempotency checks. */
export function hashJson(value: unknown): Buffer {
  return sha256(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}

/** Human-friendly random password: 20 chars from an unambiguous alphabet. */
export function generatePassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%';
  const out: string[] = [];
  while (out.length < length) {
    const b = randomBytes(1)[0]!;
    // rejection sampling avoids modulo bias
    if (b < Math.floor(256 / alphabet.length) * alphabet.length) out.push(alphabet[b % alphabet.length]!);
  }
  return out.join('');
}
