import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run several statements (no parameters), e.g. a migration file. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Run `fn` in a transaction: commits if it resolves, rolls back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * In-process Postgres (WASM) for tests and local development. Same SQL dialect and semantics as the
 * production database. Pass a directory to persist, or nothing for an in-memory database.
 */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dataDir);
  await db.waitReady;
  const wrap = (h: { query: typeof db.query; exec: typeof db.exec }): Queryable => ({
    query: async (sql, params) => ({ rows: (await h.query(sql, params as unknown[])).rows as never[] }),
    exec: async (sql) => void (await h.exec(sql)),
  });
  return { ...wrap(db), transaction: (fn) => db.transaction((tx) => fn(wrap(tx as never))), close: () => db.close() };
}

/**
 * Postgres over the network, e.g. Supabase. Works with the direct connection, the session pooler, and the
 * transaction pooler (we use ordinary transactions and row locks, no named prepared statements or session state).
 * Serverless hosts (Vercel) should use the transaction pooler; always-on servers the session pooler or direct.
 *
 * TLS is verified. Supabase's certificate chain is not in the system trust store, so set
 * DATABASE_CA_CERT to the PEM from the Supabase dashboard (Database > Settings > SSL).
 */
export async function createPgDb(connectionString: string, opts: { caCert?: string; insecureSsl?: boolean; maxConnections?: number } = {}): Promise<Db> {
  const pg = await import('pg');
  // `?sslmode=disable` is the only way to turn TLS off (local development servers)
  const noTls = new URL(connectionString).searchParams.get('sslmode') === 'disable';
  const ssl = noTls ? false : opts.insecureSsl ? { rejectUnauthorized: false } : opts.caCert ? { ca: opts.caCert } : true;
  const pool = new pg.default.Pool({ connectionString: stripSslParams(connectionString), ssl, max: opts.maxConnections ?? 10 });
  const wrap = (h: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Queryable => ({
    query: async (sql, params) => ({ rows: (await h.query(sql, params)).rows as never[] }),
    exec: async (sql) => void (await h.query(sql)),
  });
  return {
    ...wrap(pool),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// `?sslmode=...` in the URL would override the explicit `ssl` option above
function stripSslParams(url: string) {
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  return u.toString();
}

/** Apply any migrations in ./migrations that haven't run yet, each in its own transaction. */
export async function migrate(db: Db, dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log(`applied migration ${file}`);
  }
}
