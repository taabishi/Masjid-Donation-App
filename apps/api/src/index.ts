import { buildServices } from './bootstrap.js';
import { runBackgroundJobs } from './jobs.js';

// Long-running server (local development, Render, Railway, Fly...). Applies migrations at startup
// and runs the background jobs on a timer. On Vercel see serverless.ts instead.
const { app, repo, payments, port } = await buildServices(process.env, { runMigrations: true, seedDemoData: true });

const tick = () => runBackgroundJobs(repo, payments).catch((e) => console.error('background run failed', e));
setInterval(tick, 60_000);
void tick();

app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
