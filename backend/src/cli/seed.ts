/**
 * Development sample data. Refuses to run when NODE_ENV=production.
 *
 *   npm run seed                 # 60 contacts, 3 groups
 *   npm run seed -- --contacts 6000
 *
 * WARNING: generated numbers are syntactically valid Eswatini mobile numbers
 * and may belong to real people. Every seeded contact is tagged SEED_DATA and
 * placed in "Demo data – do not send". Never point a real gateway at a campaign
 * built from seed data; use the mock telephony layer instead.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createPool, withTx } from '../db.js';
import { runMigrations } from '../migrate.js';

const { values } = parseArgs({ options: { contacts: { type: 'string', default: '60' } } });
const n = Number(values.contacts);
if (!Number.isInteger(n) || n < 1 || n > 50000) {
  console.error('--contacts must be 1..50000');
  process.exit(2);
}
const config = loadConfig();
if (config.nodeEnv === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(2);
}

const FIRST = ['Sipho', 'Thandeka', 'Lindiwe', 'Bongani', 'Nomvula', 'Sibusiso', 'Zanele', 'Mandla', 'Nokuthula', 'Themba', 'Ayanda', 'Phindile'];
const LAST = ['Dlamini', 'Simelane', 'Nkambule', 'Mamba', 'Shongwe', 'Magagula', 'Motsa', 'Hlophe', 'Mavuso', 'Ndlovu', 'Zwane', 'Khumalo'];

const db = createPool(config.databaseUrl, 2);
try {
  await runMigrations(db);
  await withTx(db, async (tx) => {
    const groups: Record<string, string> = {};
    for (const [name, desc] of [
      ['Demo data – do not send', 'All generated sample contacts'],
      ['Demo – Students', 'Sample subgroup'],
      ['Demo – Staff', 'Sample subgroup'],
    ] as const) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO contact_groups (name, description) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description RETURNING id`,
        [name, desc],
      );
      groups[name] = rows[0]!.id;
    }
    const prefixes = ['76', '78', '79'];
    let inserted = 0;
    for (let i = 0; i < n; i++) {
      const invalid = i % 40 === 39; // ~2.5% invalid rows, kept and flagged
      const national = invalid ? `7${String(i).padStart(5, '0')}` : `${prefixes[i % 3]}${String(900000 + i).slice(-6)}`;
      const e164 = invalid ? null : `+268${national}`;
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO contacts (phone_e164, phone_raw, is_valid, validation_error, first_name, last_name, reference_no, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY['SEED_DATA', $8])
         ON CONFLICT (phone_e164) WHERE deleted_at IS NULL AND phone_e164 IS NOT NULL DO NOTHING RETURNING id`,
        [
          e164,
          national,
          !invalid,
          invalid ? 'INVALID_NUMBER: Not a valid number for SZ (check digit count)' : null,
          FIRST[i % FIRST.length],
          LAST[Math.floor(i / FIRST.length) % LAST.length],
          `REF-${String(i + 1).padStart(5, '0')}`,
          i % 2 ? 'student' : 'staff',
        ],
      );
      const id = rows[0]?.id;
      if (!id) continue;
      inserted++;
      await tx.query('INSERT INTO group_memberships (group_id, contact_id) VALUES ($1, $3), ($2, $3) ON CONFLICT DO NOTHING', [
        groups['Demo data – do not send'],
        i % 2 ? groups['Demo – Students'] : groups['Demo – Staff'],
        id,
      ]);
      // 90% consented; every 25th withdrew; the rest have no record.
      if (i % 10 !== 9) {
        await tx.query(
          `INSERT INTO consent_records (contact_id, status, source, evidence, effective_at)
           VALUES ($1, 'GRANTED', 'Seed: registration form', 'demo', now() - interval '30 days')`,
          [id],
        );
      }
      if (i % 25 === 24 && e164) {
        await tx.query(`INSERT INTO suppressions (phone_e164, reason, source) VALUES ($1, 'OPT_OUT', 'Seed: replied STOP') ON CONFLICT DO NOTHING`, [e164]);
        await tx.query(`INSERT INTO consent_records (contact_id, status, source) VALUES ($1, 'WITHDRAWN', 'Seed: replied STOP')`, [id]);
      }
    }
    console.log(`Seeded ${inserted} contacts (${n - inserted} already existed) into 3 demo groups.`);
  });
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
