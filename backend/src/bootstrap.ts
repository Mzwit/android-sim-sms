import type { FastifyBaseLogger } from 'fastify';
import type { Db } from './db.js';
import { withTx } from './db.js';
import { audit } from './lib/audit.js';
import { generatePassword } from './lib/crypto.js';
import { hashPassword } from './auth/password.js';

/**
 * First-run administrator for hosts without a shell (e.g. Render free tier).
 * Only acts when BOOTSTRAP_ADMIN_EMAIL is set AND no administrator exists yet.
 * The random temporary password is written once to the server log, which only
 * the hosting account owner can read, and must be changed at first sign-in.
 */
export async function bootstrapAdmin(db: Db, email: string | undefined, name: string | undefined, log: FastifyBaseLogger) {
  if (!email) return;
  const temp = generatePassword();
  const hash = await hashPassword(temp);
  const created = await withTx(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(726810003)');
    const { rows } = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM administrators');
    if (rows[0]!.n > 0) return false;
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO administrators (email, display_name, password_hash, role_id, must_change_password)
       VALUES ($1, $2, $3, (SELECT id FROM roles WHERE code = 'SUPER_ADMIN'), true) RETURNING id`,
      [email, name ?? 'Administrator', hash],
    );
    await audit(tx, { actorType: 'SYSTEM', action: 'admin.bootstrapped', entityType: 'administrator', entityId: ins.rows[0]!.id, details: { email } });
    return true;
  });
  if (created) {
    const line = '='.repeat(64);
    // Deliberately printed with console so it is not filtered by LOG_LEVEL.
    console.log(`\n${line}\n FIRST ADMINISTRATOR CREATED\n   email:              ${email}\n   temporary password: ${temp}\n You must change it at first sign-in. It is not shown again.\n${line}\n`);
    log.warn({ email }, 'bootstrap administrator created; temporary password printed above');
  }
}
