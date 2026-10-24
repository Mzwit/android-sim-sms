import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { buildApp } from './app.js';

async function main() {
  const config = loadConfig();
  const db = createPool(config.databaseUrl, config.dbPoolMax);
  if (process.env.MIGRATE_ON_START !== 'false') {
    const r = await runMigrations(db);
    if (r.applied.length) console.log(`[migrate] applied: ${r.applied.join(', ')}`);
  }
  const app = await buildApp({ config, db });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await db.end();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  const scheme = config.tlsCertPath ? 'https' : 'http';
  app.log.info(`SMS gateway backend on ${scheme}://${config.host}:${config.port}  (API docs: /docs)`);
}

main().catch((err) => {
  console.error('[fatal]', err instanceof Error ? err.message : err);
  process.exit(1);
});
