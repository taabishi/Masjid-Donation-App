import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildServices } from './bootstrap.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Entry point for Vercel functions. Differences from the long-running server:
 *  - no migrations or demo data here (they run once at deploy time: `npm run migrate`, part of the Vercel build);
 *  - few database connections per function instance (many instances may run at once);
 *  - background jobs are triggered by Vercel Cron via GET /jobs/run instead of a timer.
 */
export function createHandler(env: NodeJS.ProcessEnv): Promise<Handler> {
  return buildServices(env, { runMigrations: false, seedDemoData: false, maxConnections: 3 }).then(({ app }) => app);
}
