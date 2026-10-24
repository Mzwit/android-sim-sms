import pg from 'pg';

// Return BIGINT/NUMERIC as JS numbers where safe; counts are well below 2^53.
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max, application_name: 'smsgw-backend' });
  pool.on('error', (err) => {
    // An idle client errored (e.g. DB restarted). pg will create a new one on next use.
    console.error('[db] idle client error:', err.message);
  });
  return pool;
}

/**
 * Run fn inside a transaction. Rolls back on any thrown error.
 * Serialization failures / deadlocks are retried a few times.
 */
export async function withTx<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  opts: { isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'; retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const client = await db.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? 'READ COMMITTED'}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if ((code === '40001' || code === '40P01') && attempt < retries) {
        await new Promise((r) => setTimeout(r, 20 * 2 ** attempt + Math.random() * 20));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
