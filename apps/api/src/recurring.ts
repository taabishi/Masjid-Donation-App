import type { Frequency } from './types.js';
import { chargeDonation } from './donate.js';
import type { PaymentProvider } from './payments.js';
import type { Repo } from './repo.js';

export function addPeriod(iso: string, freq: Frequency): string {
  const d = new Date(iso);
  if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d.toISOString();
}

/** Charge every active schedule that is due. Safe to call repeatedly. */
export async function processDueRecurring(repo: Repo, payments: PaymentProvider, now = new Date()) {
  let processed = 0;
  for (const r of await repo.dueRecurring(now)) {
    const user = await repo.findUser(r.userId);
    const mosque = await repo.getMosque(r.mosqueId);
    if (!user || !mosque) {
      await repo.deactivateRecurring(r.id);
      continue;
    }
    // an organization that is no longer verified is skipped (nothing is charged) and the schedule moves on
    try {
      // the key is stable per schedule + due date, so retrying after an outage (or a second server
      // instance running the same sweep) can't double-charge: Stripe returns the same payment and
      // the donations table de-duplicates on its id
      await chargeDonation(repo, payments, {
        user,
        mosque,
        amountCents: r.amountCents,
        causeId: r.causeId,
        paymentMethodId: r.paymentMethodId,
        recurringId: r.id,
        idempotencyKey: `rec-${r.id}-${r.nextDate}`,
        now,
      });
    } catch (e) {
      console.error(`recurring ${r.id}: provider unavailable, will retry`, e);
      continue; // leave nextDate alone
    }
    // charge at most once per run; skip any periods missed during downtime
    let next = addPeriod(r.nextDate, r.frequency);
    while (new Date(next) <= now) next = addPeriod(next, r.frequency);
    await repo.advanceRecurring(r.id, next);
    processed++;
  }
  return processed;
}
