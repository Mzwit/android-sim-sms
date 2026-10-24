import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPool } from '../src/db.js';
import { migrationsDir, runMigrations } from '../src/migrate.js';
import { audit } from '../src/lib/audit.js';
import { TEST_DB_URL, createAdmin, resetDb } from './helpers.js';

const db = createPool(TEST_DB_URL, 4);
afterAll(() => db.end());
beforeEach(() => resetDb(db));

async function contact(phone: string) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO contacts (phone_e164, phone_raw, is_valid) VALUES ($1, $1, true) RETURNING id`,
    [phone],
  );
  return rows[0]!.id;
}

describe('migrations', () => {
  it('are idempotent: re-running applies nothing', async () => {
    const r = await runMigrations(db);
    expect(r.applied).toEqual([]);
    expect(r.skipped.length).toBeGreaterThan(0);
  });

  it('refuse to run when an applied migration was edited', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    await cp(migrationsDir(), dir, { recursive: true });
    await writeFile(path.join(dir, '001_init.sql'), '-- tampered\n', { flag: 'a' });
    await expect(runMigrations(db, dir)).rejects.toThrow(/modified after it was applied/);
  });

  it('serialise concurrent runners with an advisory lock', async () => {
    const results = await Promise.all([runMigrations(db), runMigrations(db), runMigrations(db)]);
    expect(results.every((r) => r.applied.length === 0)).toBe(true);
  });
});

describe('constraints', () => {
  it('a phone number can only belong to one live contact', async () => {
    await contact('+26876000001');
    await expect(contact('+26876000001')).rejects.toMatchObject({ code: '23505' });
  });

  it('a soft-deleted contact frees its number', async () => {
    const id = await contact('+26876000002');
    await db.query('UPDATE contacts SET deleted_at = now() WHERE id = $1', [id]);
    await expect(contact('+26876000002')).resolves.toBeTypeOf('string');
  });

  it('rejects malformed E.164 and valid-without-number', async () => {
    await expect(db.query(`INSERT INTO contacts (phone_e164, phone_raw, is_valid) VALUES ('76123456', 'x', true)`)).rejects.toMatchObject({ code: '23514' });
    await expect(db.query(`INSERT INTO contacts (phone_e164, phone_raw, is_valid) VALUES (NULL, 'x', true)`)).rejects.toMatchObject({ code: '23514' });
  });

  it('a recipient cannot be added to the same campaign twice', async () => {
    const admin = await createAdmin(db);
    const cid = await contact('+26876000003');
    const { rows } = await db.query<{ id: string }>(`INSERT INTO campaigns (name, body_template, created_by) VALUES ('c', 'hi', $1) RETURNING id`, [admin.id]);
    const ins = () =>
      db.query(`INSERT INTO campaign_recipients (campaign_id, contact_id, phone_e164, decision) VALUES ($1, $2, '+26876000003', 'INCLUDED')`, [rows[0]!.id, cid]);
    await ins();
    await expect(ins()).rejects.toMatchObject({ code: '23505' });
  });

  it('message state must agree with its lease', async () => {
    await expect(
      db.query(`INSERT INTO messages (phone_e164, body, encoding, segment_count, status) VALUES ('+26876000004', 'x', 'GSM7', 1, 'LEASED')`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.query(`INSERT INTO messages (phone_e164, body, encoding, segment_count, status) VALUES ('+26876000004', 'x', 'GSM7', 1, 'DELIVERD')`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('only one active suppression per number', async () => {
    await db.query(`INSERT INTO suppressions (phone_e164, reason, source) VALUES ('+26876000005', 'OPT_OUT', 't')`);
    await expect(db.query(`INSERT INTO suppressions (phone_e164, reason, source) VALUES ('+26876000005', 'ADMIN', 't')`)).rejects.toMatchObject({ code: '23505' });
    await db.query(`UPDATE suppressions SET lifted_at = now() WHERE phone_e164 = '+26876000005'`);
    await db.query(`INSERT INTO suppressions (phone_e164, reason, source) VALUES ('+26876000005', 'ADMIN', 't')`);
  });
});

describe('audit log', () => {
  it('is append-only', async () => {
    await audit(db, { actorType: 'SYSTEM', action: 'test.event' });
    await expect(db.query(`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM audit_logs`)).rejects.toThrow(/retention purge/);
  });

  it('can be purged only inside an explicit retention transaction', async () => {
    await audit(db, { actorType: 'SYSTEM', action: 'test.old' });
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL app.audit_purge = 'on'`);
      const r = await c.query(`DELETE FROM audit_logs WHERE action = 'test.old'`);
      await c.query('COMMIT');
      expect(r.rowCount).toBe(1);
    } finally {
      c.release();
    }
    // The flag does not leak out of the transaction.
    await audit(db, { actorType: 'SYSTEM', action: 'test.new' });
    await expect(db.query(`DELETE FROM audit_logs`)).rejects.toThrow();
  });
});
