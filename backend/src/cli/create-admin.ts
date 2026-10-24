/**
 * Create an administrator from the command line (used for the first account).
 *
 *   npm run admin:create -- --email you@example.org --name "Your Name" [--role SUPER_ADMIN]
 *
 * A random temporary password is printed once; it must be changed at first sign-in.
 * No default or hard-coded administrator exists.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createPool, withTx } from '../db.js';
import { runMigrations } from '../migrate.js';
import { hashPassword } from '../auth/password.js';
import { generatePassword } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'SUPER_ADMIN' } },
});
if (!values.email || !values.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) {
  console.error('Usage: npm run admin:create -- --email you@example.org --name "Your Name" [--role SUPER_ADMIN]');
  process.exit(2);
}

const config = loadConfig();
const db = createPool(config.databaseUrl, 2);
try {
  await runMigrations(db);
  const temp = generatePassword();
  const hash = await hashPassword(temp);
  await withTx(db, async (tx) => {
    const r = await tx.query<{ id: number }>('SELECT id FROM roles WHERE code = $1', [values.role]);
    if (!r.rows[0]) throw new Error(`Unknown role ${values.role}`);
    const ex = await tx.query('SELECT 1 FROM administrators WHERE email = $1', [values.email]);
    if (ex.rowCount) throw new Error(`An administrator with email ${values.email} already exists`);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO administrators (email, display_name, password_hash, role_id, must_change_password)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [values.email, values.name, hash, r.rows[0].id],
    );
    await audit(tx, { actorType: 'SYSTEM', action: 'admin.created_cli', entityType: 'administrator', entityId: rows[0]!.id, details: { email: values.email, role: values.role } });
  });
  console.log('\nAdministrator created.');
  console.log(`  Email:              ${values.email}`);
  console.log(`  Role:               ${values.role}`);
  console.log(`  Temporary password: ${temp}`);
  console.log('\nThis password is shown only once. You must change it at first sign-in.\n');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
