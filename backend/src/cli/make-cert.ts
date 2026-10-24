/**
 * Create a self-signed TLS certificate for running the server on your own network.
 * The Android app pins this certificate's fingerprint during pairing (shown in the QR).
 *
 *   npm run cert -- --ip 192.168.1.20 [--name office-pc] [--out ../certs]
 */
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { X509Certificate } from 'node:crypto';

const { values } = parseArgs({ options: { ip: { type: 'string', multiple: true }, name: { type: 'string', default: 'sms-gateway.local' }, out: { type: 'string', default: '../certs' }, days: { type: 'string', default: '825' } } });
const ips = values.ip ?? [];
if (!ips.length) {
  console.error('Pass the PC\'s LAN IP address: npm run cert -- --ip 192.168.1.20  (find it with: ipconfig)');
  process.exit(2);
}
const altNames = [
  { type: 2, value: values.name! },
  { type: 2, value: 'localhost' },
  { type: 7, ip: '127.0.0.1' },
  ...ips.map((ip) => ({ type: 7, ip })),
];
const pems = await selfsigned.generate([{ name: 'commonName', value: values.name! }], {
  days: Number(values.days),
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ],
} as never);
const out = path.resolve(values.out!);
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'server.crt'), pems.cert);
writeFileSync(path.join(out, 'server.key'), pems.private);
try { chmodSync(path.join(out, 'server.key'), 0o600); } catch { /* Windows */ }
const fp = new X509Certificate(pems.cert).fingerprint256.replace(/:/g, '').toLowerCase();
console.log(`Certificate written to ${out}\n  valid for: ${[values.name, ...ips].join(', ')}\n  SHA-256 fingerprint: ${fp}\nThe pairing QR includes this fingerprint automatically.`);
