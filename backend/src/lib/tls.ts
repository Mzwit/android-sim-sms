import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** SHA-256 fingerprint (hex, lower case) of the server certificate, for phone pinning. */
export function certFingerprint(certPath?: string): string | null {
  if (!certPath) return null;
  try {
    const cert = new X509Certificate(readFileSync(certPath));
    return cert.fingerprint256.replace(/:/g, '').toLowerCase();
  } catch {
    return null;
  }
}
