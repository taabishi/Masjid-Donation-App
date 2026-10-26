/** Settings that must be present for a production deployment. Returns a list of problems (empty = fine). */
export function productionConfigProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) problems.push('JWT_SECRET must be set to a random string of at least 32 characters');
  if (!env.DATABASE_URL) problems.push('DATABASE_URL is required');
  if (!env.CORS_ORIGINS) problems.push('CORS_ORIGINS is required (comma-separated web app origins, e.g. https://your-app.vercel.app)');
  if (!env.API_PUBLIC_URL) problems.push('API_PUBLIC_URL is required (this API\'s public https address)');
  if (!env.STRIPE_SECRET_KEY && env.ALLOW_MOCK_PAYMENTS !== 'true') {
    problems.push('STRIPE_SECRET_KEY is required. For a demo with fake payments set ALLOW_MOCK_PAYMENTS=true (no real money moves)');
  }
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) problems.push('STRIPE_WEBHOOK_SECRET is required when Stripe is enabled');
  return problems;
}
