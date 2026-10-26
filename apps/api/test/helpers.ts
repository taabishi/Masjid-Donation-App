import { createPgDb, createPgliteDb, migrate, type Db } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { seedDemoMosques } from '../src/seed.js';
import type { FeePolicy } from '../src/types.js';

/**
 * A fresh database with the real migrations applied. In-memory Postgres (PGlite) by default; set
 * TEST_DATABASE_URL (a server where we may CREATE DATABASE, e.g. postgres://postgres@localhost:5433/postgres?sslmode=disable)
 * to run the same tests against a real server through the `pg` driver used in production.
 */
async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createPgliteDb();
  const name = 'test_' + Math.random().toString(36).slice(2, 10);
  const admin = await createPgDb(url);
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(url);
  u.pathname = '/' + name;
  const db = await createPgDb(u.toString());
  return {
    ...db,
    close: async () => {
      await db.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}

export async function newRepo(opts: { seed?: boolean; policy?: Partial<FeePolicy> } = {}) {
  const db = await freshDb();
  await migrate(db);
  const repo = new Repo(db, db, { passThroughProcessingFees: true, platformFeeBps: 0, ...opts.policy });
  if (opts.seed) await seedDemoMosques(repo);
  return { db, repo };
}
