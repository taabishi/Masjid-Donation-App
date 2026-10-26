import type { PaymentProvider } from './payments.js';
import { settleDonation } from './ledger.js';
import type { Repo } from './repo.js';
import { newId, type Donation, type Mosque, type User } from './types.js';

export type DonateOutcome =
  | { ok: true; donation: Donation }
  | { ok: false; code: 'no_payment_method' | 'payment_failed'; error: string; donation?: Donation };

/**
 * Charge a donor's saved payment method and record the result.
 * Throws if the payment provider is unreachable (nothing is recorded, so the caller can retry safely
 * with the same idempotencyKey).
 */
export async function chargeDonation(
  repo: Repo,
  payments: PaymentProvider,
  opts: {
    user: User;
    mosque: Mosque;
    amountCents: number;
    causeId?: string;
    paymentMethodId?: string;
    recurringId?: string;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<DonateOutcome> {
  const { user, mosque } = opts;
  const noMethod = { ok: false as const, code: 'no_payment_method' as const, error: 'Add a payment method first' };
  if (!user.paymentCustomerId) return noMethod;

  const methods = await payments.listMethods(user.paymentCustomerId);
  const method = opts.paymentMethodId ? methods.find((m) => m.id === opts.paymentMethodId) : methods[0];
  if (!method) return noMethod;

  // every donation gets its id up front so it can be tagged on the charge for reconciliation
  const id = newId();
  const result = await payments.charge({
    donationId: id,
    methodType: method.type,
    amountCents: opts.amountCents,
    customerId: user.paymentCustomerId,
    paymentMethodId: method.id,
    mosque,
    description: `${opts.recurringId ? 'Recurring donation' : 'Donation'} to ${mosque.name}`,
    idempotencyKey: opts.idempotencyKey,
  });

  const donation: Donation = {
    id,
    userId: user.id,
    mosqueId: mosque.id,
    causeId: opts.causeId,
    amountCents: opts.amountCents,
    status: result.status,
    recurringId: opts.recurringId,
    paymentRef: result.reference,
    createdAt: (opts.now ?? new Date()).toISOString(),
  };
  const saved = await repo.createDonation(donation); // returns the existing row if this charge was already recorded
  // when the fee isn't known yet (e.g. bank debits) the periodic settleUnsettled sweep records it
  if (saved.status === 'succeeded' && typeof result.feeCents === 'number') await settleDonation(repo, saved, result.feeCents);
  if (result.status === 'failed') return { ok: false, code: 'payment_failed', error: result.error ?? 'Payment failed', donation: saved };
  return { ok: true, donation: saved };
}
