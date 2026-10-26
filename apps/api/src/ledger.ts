import type { PaymentProvider } from './payments.js';
import { newId, type Donation, type LedgerEntry, type LedgerType, type Payout, type Store } from './store.js';

export const PLATFORM = 'platform';

/**
 * Append a ledger entry. Returns false (and does nothing) if an entry with this key already exists,
 * which makes every caller safe to retry and every webhook safe to receive twice.
 */
export function post(
  store: Store,
  e: { key: string; account: string; type: LedgerType; amountCents: number; donationId?: string; payoutId?: string; at?: Date },
): boolean {
  if (!Number.isSafeInteger(e.amountCents)) throw new Error('ledger amounts must be integer cents');
  if (store.ledgerKeys.has(e.key)) return false;
  const entry: LedgerEntry = {
    id: newId(),
    key: e.key,
    createdAt: (e.at ?? new Date()).toISOString(),
    account: e.account,
    type: e.type,
    amountCents: e.amountCents,
    donationId: e.donationId,
    payoutId: e.payoutId,
  };
  store.data.ledger.push(entry);
  store.ledgerKeys.add(e.key);
  return true;
}

/** Amount we currently owe an account (a mosque id, or 'platform' for the platform's own share). */
export function balanceOf(store: Store, account: string): number {
  let sum = 0;
  for (const e of store.data.ledger) if (e.account === account) sum += e.amountCents;
  return sum;
}

export const isSettled = (store: Store, donationId: string) => store.ledgerKeys.has(`don:${donationId}:gross`);

/**
 * Record a successful donation. Money in = gross - processor fee, split between mosque and platform
 * according to the store's fee policy, so the entries always sum to what actually landed in Stripe.
 */
export function settleDonation(store: Store, donation: Donation, feeCents: number) {
  if (donation.status !== 'succeeded') throw new Error('only succeeded donations can be settled');
  if (isSettled(store, donation.id)) return;
  const { passThroughProcessingFees, platformFeeBps } = store.policy;
  const platformFee = Math.floor((donation.amountCents * platformFeeBps) / 10_000);
  const base = { donationId: donation.id, at: new Date() };
  const k = `don:${donation.id}`;
  // post the gross key last: its presence is what marks the donation as fully settled
  post(store, { ...base, key: `${k}:fee`, account: passThroughProcessingFees ? donation.mosqueId : PLATFORM, type: 'processing_fee', amountCents: -feeCents });
  if (platformFee) {
    post(store, { ...base, key: `${k}:pfee-m`, account: donation.mosqueId, type: 'platform_fee', amountCents: -platformFee });
    post(store, { ...base, key: `${k}:pfee-p`, account: PLATFORM, type: 'platform_fee', amountCents: platformFee });
  }
  post(store, { ...base, key: `${k}:gross`, account: donation.mosqueId, type: 'donation', amountCents: donation.amountCents });
  store.save();
}

/** Record a (possibly partial) refund. `totalRefundedCents` is the cumulative amount refunded so far. */
export function recordRefund(store: Store, donation: Donation, totalRefundedCents: number) {
  if (!isSettled(store, donation.id)) return;
  let already = 0;
  for (const e of store.data.ledger) if (e.donationId === donation.id && e.type === 'refund') already -= e.amountCents;
  const delta = totalRefundedCents - already;
  if (delta <= 0) return;
  post(store, { key: `refund:${donation.id}:${totalRefundedCents}`, account: donation.mosqueId, type: 'refund', amountCents: -delta, donationId: donation.id });
  store.save();
}

/** A chargeback pulls the money out of our Stripe balance straight away, so the mosque's share drops now. */
export function recordDispute(store: Store, donation: Donation, disputeId: string, amountCents: number, outcome: 'opened' | 'won') {
  if (!isSettled(store, donation.id)) return;
  if (outcome === 'opened') {
    post(store, { key: `dispute:${disputeId}:open`, account: donation.mosqueId, type: 'dispute', amountCents: -amountCents, donationId: donation.id });
  } else if (store.ledgerKeys.has(`dispute:${disputeId}:open`)) {
    post(store, { key: `dispute:${disputeId}:won`, account: donation.mosqueId, type: 'dispute_reversal', amountCents, donationId: donation.id });
  }
  store.save();
}

/**
 * Reserve money for a payout. The ledger is debited immediately so the same money can't be paid twice;
 * if the transfer then fails it is credited back by failPayout.
 */
export function createPayout(store: Store, mosqueId: string, amountCents: number, method: Payout['method']): Payout {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('Invalid amount');
  if (amountCents > balanceOf(store, mosqueId)) throw new Error('Amount exceeds the balance owed to this mosque');
  const payout: Payout = { id: newId(), mosqueId, amountCents, method, status: 'pending', createdAt: new Date().toISOString() };
  store.data.payouts.push(payout);
  post(store, { key: `payout:${payout.id}`, account: mosqueId, type: 'payout', amountCents: -amountCents, payoutId: payout.id });
  store.save();
  return payout;
}

export function completePayout(store: Store, payout: Payout, reference?: string) {
  payout.status = 'completed';
  payout.reference = reference;
  store.save();
}

export function failPayout(store: Store, payout: Payout) {
  if (payout.status === 'failed') return;
  payout.status = 'failed';
  post(store, { key: `payout-reversal:${payout.id}`, account: payout.mosqueId, type: 'payout_reversal', amountCents: payout.amountCents, payoutId: payout.id });
  store.save();
}

/**
 * Settle succeeded donations whose processor fee wasn't known at charge time (bank debits, or a
 * fee lookup that failed). Run periodically; safe to repeat.
 */
export async function settleUnsettled(store: Store, payments: PaymentProvider) {
  let settled = 0;
  for (const d of store.data.donations) {
    if (d.status !== 'succeeded' || !d.paymentRef || isSettled(store, d.id)) continue;
    try {
      const fee = await payments.getFee(d.paymentRef);
      if (fee === null) continue;
      settleDonation(store, d, fee);
      settled++;
    } catch (e) {
      console.error(`could not settle donation ${d.id}`, e);
    }
  }
  return settled;
}

export interface Reconciliation {
  ledgerTotalCents: number;
  providerBalanceCents: number | null;
  /** providerBalance + bank - ledgerTotal. Should be ~0; investigate anything persistent (e.g. dispute fees are not yet ledgered). */
  diffCents: number | null;
  unsettledDonations: number;
}

/**
 * Compare everything the ledger says we hold against the cash that exists. `bankCents` is donation money
 * you hold outside Stripe (e.g. swept to your bank, not yet sent to mosques); pass it so manual ACH payouts reconcile.
 */
export async function reconcile(store: Store, payments: PaymentProvider, bankCents = 0): Promise<Reconciliation> {
  const ledgerTotalCents = store.data.ledger.reduce((s, e) => s + e.amountCents, 0);
  const providerBalanceCents = await payments.getBalanceCents();
  return {
    ledgerTotalCents,
    providerBalanceCents,
    diffCents: providerBalanceCents === null ? null : providerBalanceCents + bankCents - ledgerTotalCents,
    unsettledDonations: store.data.donations.filter((d) => d.status === 'succeeded' && !isSettled(store, d.id)).length,
  };
}
