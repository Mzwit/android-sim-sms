import pg from 'pg';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';

/** Recreate the test schema once per test run, then apply all migrations. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://smsgw:devpass@localhost:5432/smsgw_test';
  if (!/test/i.test(url)) throw new Error(`Refusing to reset a database whose URL does not contain "test": ${url}`);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await c.end();
  const db = createPool(url, 1);
  await runMigrations(db);
  await db.end();
}
