import type { Frequency, Store } from './store.js';
import { newId } from './store.js';
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
  for (const r of store.data.recurring) {
    if (!r.active) continue;
    // catch up at most one charge per run so a long outage doesn't double-bill
    if (new Date(r.nextDate) > now) continue;
    const donor = store.data.users.find((u) => u.id === r.userId);
    const mosque = store.data.mosques.find((m) => m.id === r.mosqueId);
    if (!donor || !mosque) {
      r.active = false;
      continue;
    }
    const result = mosque.payoutsConnected
      ? await payments.charge({ amountCents: r.amountCents, donor, mosque, description: `Recurring donation to ${mosque.name}` })
      : { ok: false as const, error: 'Mosque cannot accept payments' };
    store.data.donations.push({
      id: newId(),
      userId: r.userId,
      mosqueId: r.mosqueId,
      causeId: r.causeId,
      amountCents: r.amountCents,
      status: result.ok ? 'succeeded' : 'failed',
      recurringId: r.id,
      paymentRef: result.reference,
      createdAt: now.toISOString(),
    });
    let next = addPeriod(r.nextDate, r.frequency);
    while (new Date(next) <= now) next = addPeriod(next, r.frequency);
    r.nextDate = next;
    processed++;
  }
  if (processed) store.save();
  return processed;
}
