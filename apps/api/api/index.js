// Vercel function: serves the whole Express API (see vercel.json for the rewrite to /api).
import { createHandler } from '../dist/serverless.js';

let handler;

export default async function (req, res) {
  // reuse the initialized app across invocations; if start-up failed, try again next time
  handler ??= createHandler(process.env).catch((e) => {
    handler = undefined;
    throw e;
  });
  (await handler)(req, res);
}
