import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { runMigrations } from '../migrate.js';

const config = loadConfig();
const db = createPool(config.databaseUrl, 1);
try {
  const r = await runMigrations(db);
  console.log(`Applied: ${r.applied.length ? r.applied.join(', ') : '(none)'}; already applied: ${r.skipped.length}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
