import type { Frequency, Store } from './store.js';
import { chargeDonation } from './donate.js';
import type { PaymentProvider } from './payments.js';

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
export async function processDueRecurring(store: Store, payments: PaymentProvider, now = new Date()) {
  let processed = 0;
  for (const r of [...store.data.recurring]) {
    if (!r.active || new Date(r.nextDate) > now) continue;
    const user = store.data.users.find((u) => u.id === r.userId);
    const mosque = store.data.mosques.find((m) => m.id === r.mosqueId);
    if (!user || !mosque) {
      r.active = false;
      continue;
    }
    try {
      // the key is stable per schedule + due date, so retrying after an outage can't double-charge
      await chargeDonation(store, payments, {
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
    r.nextDate = next;
    processed++;
  }
  if (processed) store.save();
  return processed;
}
