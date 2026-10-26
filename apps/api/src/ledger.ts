import type { PaymentProvider } from './payments.js';
import type { Repo } from './repo.js';
import { newId, type Donation, type Payout } from './types.js';

export const PLATFORM = 'platform';

/**
 * Ledger rules (entries live in the append-only `ledger_entries` table; amounts are signed integer
 * cents from the account's point of view, `account` is a mosque id or 'platform'):
 *  - every posting has a unique key, so retries and duplicate webhooks can never double-post;
 *  - a donation's entries sum to the cash that actually reached Stripe (gross minus Stripe's fee);
 *  - corrections are new entries, never edits (the database rejects UPDATE/DELETE).
 * Multi-entry changes run inside a transaction so they are all-or-nothing.
 */

export const isSettled = (repo: Repo, donationId: string) => repo.hasKey(`don:${donationId}:gross`);

/** Record a successful donation, splitting it between mosque and platform per the fee policy. */
export async function settleDonation(repo: Repo, donation: Donation, feeCents: number) {
  if (donation.status !== 'succeeded') throw new Error('only succeeded donations can be settled');
  await repo.transaction(async (tx) => {
    await tx.lockDonation(donation.id);
    if (await isSettled(tx, donation.id)) return;
    const { passThroughProcessingFees, platformFeeBps } = tx.policy;
    const platformFee = Math.floor((donation.amountCents * platformFeeBps) / 10_000);
    const base = { donationId: donation.id };
    const k = `don:${donation.id}`;
    await tx.postEntry({ ...base, key: `${k}:fee`, account: passThroughProcessingFees ? donation.mosqueId : PLATFORM, type: 'processing_fee', amountCents: -feeCents });
    if (platformFee) {
      await tx.postEntry({ ...base, key: `${k}:pfee-m`, account: donation.mosqueId, type: 'platform_fee', amountCents: -platformFee });
      await tx.postEntry({ ...base, key: `${k}:pfee-p`, account: PLATFORM, type: 'platform_fee', amountCents: platformFee });
    }
    await tx.postEntry({ ...base, key: `${k}:gross`, account: donation.mosqueId, type: 'donation', amountCents: donation.amountCents });
  });
}

/** Record a (possibly partial) refund. `totalRefundedCents` is the cumulative amount refunded so far. */
export async function recordRefund(repo: Repo, donation: Donation, totalRefundedCents: number) {
  await repo.transaction(async (tx) => {
    await tx.lockDonation(donation.id);
    if (!(await isSettled(tx, donation.id))) return;
    const delta = totalRefundedCents - (await tx.refundedSoFar(donation.id));
    if (delta <= 0) return;
    await tx.postEntry({ key: `refund:${donation.id}:${totalRefundedCents}`, account: donation.mosqueId, type: 'refund', amountCents: -delta, donationId: donation.id });
  });
}

/** A chargeback pulls the money out of our Stripe balance straight away, so the mosque's share drops now. */
export async function recordDispute(repo: Repo, donation: Donation, disputeId: string, amountCents: number, outcome: 'opened' | 'won') {
  await repo.transaction(async (tx) => {
    await tx.lockDonation(donation.id);
    if (!(await isSettled(tx, donation.id))) return;
    if (outcome === 'opened') {
      await tx.postEntry({ key: `dispute:${disputeId}:open`, account: donation.mosqueId, type: 'dispute', amountCents: -amountCents, donationId: donation.id });
    } else if (await tx.hasKey(`dispute:${disputeId}:open`)) {
      await tx.postEntry({ key: `dispute:${disputeId}:won`, account: donation.mosqueId, type: 'dispute_reversal', amountCents, donationId: donation.id });
    }
  });
}

export class PayoutError extends Error {}

/**
 * Reserve money for a payout. The ledger is debited in the same transaction that checks the balance
 * (with the mosque row locked), so two concurrent payouts can never spend the same money.
 * If the transfer later fails, failPayout credits it back.
 */
export async function createPayout(repo: Repo, mosqueId: string, amountCents: number, method: Payout['method']): Promise<Payout> {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new PayoutError('Invalid amount');
  return repo.transaction(async (tx) => {
    await tx.lockMosque(mosqueId);
    if (amountCents > (await tx.balanceOf(mosqueId))) throw new PayoutError('Amount exceeds the balance owed to this mosque');
    const payout: Payout = { id: newId(), mosqueId, amountCents, method, status: 'pending', createdAt: new Date().toISOString() };
    await tx.insertPayout(payout);
    await tx.postEntry({ key: `payout:${payout.id}`, account: mosqueId, type: 'payout', amountCents: -amountCents, payoutId: payout.id });
    return payout;
  });
}

export async function completePayout(repo: Repo, payout: Payout, reference?: string) {
  await repo.setPayoutStatus(payout.id, 'completed', reference);
  payout.status = 'completed';
  payout.reference = reference;
}

export async function failPayout(repo: Repo, payout: Payout) {
  await repo.transaction(async (tx) => {
    await tx.setPayoutStatus(payout.id, 'failed');
    await tx.postEntry({ key: `payout-reversal:${payout.id}`, account: payout.mosqueId, type: 'payout_reversal', amountCents: payout.amountCents, payoutId: payout.id });
  });
  payout.status = 'failed';
}

/**
 * Settle succeeded donations whose processor fee wasn't known at charge time (bank debits, or a
 * fee lookup that failed). Run periodically; safe to repeat.
 */
export async function settleUnsettled(repo: Repo, payments: PaymentProvider) {
  let settled = 0;
  for (const d of await repo.unsettledDonations()) {
    if (!d.paymentRef) continue;
    try {
      const fee = await payments.getFee(d.paymentRef);
      if (fee === null) continue;
      await settleDonation(repo, d, fee);
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
export async function reconcile(repo: Repo, payments: PaymentProvider, bankCents = 0): Promise<Reconciliation> {
  const ledgerTotalCents = await repo.ledgerTotal();
  const providerBalanceCents = await payments.getBalanceCents();
  return {
    ledgerTotalCents,
    providerBalanceCents,
    diffCents: providerBalanceCents === null ? null : providerBalanceCents + bankCents - ledgerTotalCents,
    unsettledDonations: (await repo.unsettledDonations()).length,
  };
}
