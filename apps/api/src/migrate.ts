import { createPgDb, migrate } from './db.js';
import { Repo } from './repo.js';
import { seedDemoMosques } from './seed.js';

// Apply pending SQL migrations to DATABASE_URL, then exit. Run at deploy time (see vercel.json) or by hand.
// In demo mode (no Stripe key) also adds the demo mosques once. Done here rather than at request time so
// that several serverless instances starting together can't insert them twice.
const url = process.env.DATABASE_URL;
if (!url) {
  console.log('DATABASE_URL not set: skipping migrations');
} else {
  const db = await createPgDb(url, { caCert: process.env.DATABASE_CA_CERT, insecureSsl: process.env.DATABASE_SSL_INSECURE === 'true', maxConnections: 1 });
  await migrate(db);
  if (!process.env.STRIPE_SECRET_KEY) await seedDemoMosques(new Repo(db, db));
  await db.close();
  console.log('migrations up to date');
}
