import { settleUnsettled } from './ledger.js';
import type { PaymentProvider } from './payments.js';
import { processDueRecurring } from './recurring.js';
import type { Repo } from './repo.js';

/** Background work: charge due recurring donations, then settle any donations whose fee wasn't known yet. */
export async function runBackgroundJobs(repo: Repo, payments: PaymentProvider) {
  const recurring = await processDueRecurring(repo, payments);
  const settled = await settleUnsettled(repo, payments);
  return { recurring, settled };
}
