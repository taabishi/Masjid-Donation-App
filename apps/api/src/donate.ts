import type { PaymentProvider } from './payments.js';
import { newId, type Donation, type Mosque, type Store, type User } from './store.js';

export type DonateOutcome =
  | { ok: true; donation: Donation }
  | { ok: false; code: 'no_payment_method' | 'payment_failed'; error: string; donation?: Donation };

/**
 * Charge a donor's saved payment method and record the result.
 * Throws if the payment provider is unreachable (nothing is recorded, so the caller can retry safely
 * with the same idempotencyKey).
 */
export async function chargeDonation(
  store: Store,
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

  const result = mosque.payoutsConnected
    ? await payments.charge({
        amountCents: opts.amountCents,
        customerId: user.paymentCustomerId,
        paymentMethodId: method.id,
        mosque,
        description: `${opts.recurringId ? 'Recurring donation' : 'Donation'} to ${mosque.name}`,
        idempotencyKey: opts.idempotencyKey,
      })
    : { status: 'failed' as const, error: 'Mosque cannot accept payments' };

  const donation: Donation = {
    id: newId(),
    userId: user.id,
    mosqueId: mosque.id,
    causeId: opts.causeId,
    amountCents: opts.amountCents,
    status: result.status,
    recurringId: opts.recurringId,
    paymentRef: result.reference,
    createdAt: (opts.now ?? new Date()).toISOString(),
  };
  store.data.donations.push(donation);
  store.save();
  if (result.status === 'failed') return { ok: false, code: 'payment_failed', error: result.error ?? 'Payment failed', donation };
  return { ok: true, donation };
}
