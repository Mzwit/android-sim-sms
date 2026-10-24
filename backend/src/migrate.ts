import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locate migrations/ both when running from src/ (tsx) and dist/src/ (compiled). */
export function migrationsDir(): string {
  const candidates = [path.resolve(here, '../migrations'), path.resolve(here, '../../migrations')];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply every migrations/NNN_*.sql file not yet recorded in schema_migrations.
 * Each file runs in its own transaction. A session-level advisory lock stops
 * two processes migrating at the same time. A checksum guards against edited
 * migrations that were already applied.
 */
export async function runMigrations(db: Db, dir = migrationsDir()): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => /^\d{3,}_.+\.sql$/.test(f)).sort();
  const client = await db.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock(726810001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.filename, r.checksum]));
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) {
          throw new Error(`Migration ${file} was modified after it was applied. Create a new migration instead.`);
        }
        result.skipped.push(file);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock(726810001)').catch(() => undefined);
    client.release();
  }
}
