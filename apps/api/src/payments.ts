import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type { Mosque, User } from './store.js';

export interface SavedMethod {
  id: string;
  type: 'card' | 'us_bank_account';
  label: string; // e.g. "Visa •••• 4242"
}

export interface ChargeRequest {
  amountCents: number;
  customerId: string;
  paymentMethodId: string;
  mosque: Mosque;
  description: string;
  idempotencyKey: string;
}

export interface ChargeResult {
  // 'processing' = accepted but not settled yet (bank debits take days)
  status: 'succeeded' | 'processing' | 'failed';
  reference?: string;
  error?: string;
}

export type WebhookEvent =
  | { kind: 'payment'; reference: string; status: 'succeeded' | 'failed' }
  | { kind: 'account'; accountId: string; ready: boolean }
  | { kind: 'ignored' };

/** Result of an action that may need the user to finish in a hosted Stripe page. `url` is null when nothing more is needed. */
export interface HostedStep {
  url: string | null;
}

/**
 * Payment boundary. Routes only know this interface.
 * Money flow: platform-level Customer + saved payment method -> PaymentIntent with
 * transfer_data.destination = the mosque's Stripe Connect account.
 */
export interface PaymentProvider {
  readonly name: 'mock' | 'stripe';
  /** Start (or resume) payout onboarding for a mosque. */
  beginMosqueOnboarding(mosque: Mosque, returnUrl: string): Promise<HostedStep & { accountId: string }>;
  /** True once the mosque's account can accept charges. */
  isMosqueReady(accountId: string): Promise<boolean>;
  createCustomer(user: User): Promise<string>;
  /** Hosted page where a donor adds a card, Apple Pay / Google Pay, or a US bank account. */
  beginAddPaymentMethod(customerId: string, returnUrl: string): Promise<HostedStep>;
  listMethods(customerId: string): Promise<SavedMethod[]>;
  removeMethod(customerId: string, methodId: string): Promise<void>;
  charge(req: ChargeRequest): Promise<ChargeResult>;
  parseWebhook(rawBody: Buffer, signature: string | undefined): WebhookEvent;
}

/** Development provider: nothing real is moved, hosted steps complete instantly. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  private methods = new Map<string, SavedMethod[]>();

  async beginMosqueOnboarding(mosque: Mosque) {
    return { accountId: 'acct_mock_' + mosque.id.slice(0, 8), url: null };
  }
  async isMosqueReady() {
    return true;
  }
  async createCustomer() {
    return 'cus_mock_' + randomUUID();
  }
  async beginAddPaymentMethod(customerId: string) {
    const list = this.methods.get(customerId) ?? [];
    list.push(
      list.length % 2 === 0
        ? { id: 'pm_mock_' + randomUUID(), type: 'card', label: 'Visa •••• 4242' }
        : { id: 'pm_mock_' + randomUUID(), type: 'us_bank_account', label: 'Test Bank •••• 6789' },
    );
    this.methods.set(customerId, list);
    return { url: null };
  }
  async listMethods(customerId: string) {
    return this.methods.get(customerId) ?? [];
  }
  async removeMethod(customerId: string, methodId: string) {
    this.methods.set(customerId, (this.methods.get(customerId) ?? []).filter((m) => m.id !== methodId));
  }
  async charge(): Promise<ChargeResult> {
    return { status: 'succeeded', reference: 'mock_' + randomUUID() };
  }
  parseWebhook(): WebhookEvent {
    return { kind: 'ignored' };
  }
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  constructor(
    private stripe: Stripe,
    private webhookSecret: string | undefined,
  ) {}

  async beginMosqueOnboarding(mosque: Mosque, returnUrl: string) {
    const accountId =
      mosque.payoutAccountId ??
      (
        await this.stripe.accounts.create({
          type: 'express',
          country: 'US',
          business_type: 'non_profit',
          business_profile: { name: mosque.name },
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          metadata: { mosqueId: mosque.id },
        })
      ).id;
    const link = await this.stripe.accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      return_url: returnUrl,
      refresh_url: returnUrl,
    });
    return { accountId, url: link.url };
  }

  async isMosqueReady(accountId: string) {
    const a = await this.stripe.accounts.retrieve(accountId);
    return !!a.charges_enabled && !!a.details_submitted;
  }

  async createCustomer(user: User) {
    const c = await this.stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user.id } });
    return c.id;
  }

  async beginAddPaymentMethod(customerId: string, returnUrl: string) {
    // No payment_method_types: methods (cards, Apple Pay, Google Pay, US bank accounts)
    // are controlled from the Stripe Dashboard's payment method settings.
    const session = await this.stripe.checkout.sessions.create({
      mode: 'setup',
      customer: customerId,
      currency: 'usd',
      success_url: returnUrl,
      cancel_url: returnUrl,
    });
    return { url: session.url };
  }

  async listMethods(customerId: string) {
    const res = await this.stripe.customers.listPaymentMethods(customerId, { limit: 20 });
    const out: SavedMethod[] = [];
    for (const pm of res.data) {
      if (pm.type === 'card' && pm.card) {
        const brand = pm.card.brand.charAt(0).toUpperCase() + pm.card.brand.slice(1);
        out.push({ id: pm.id, type: 'card', label: `${brand} •••• ${pm.card.last4}` });
      } else if (pm.type === 'us_bank_account' && pm.us_bank_account) {
        out.push({ id: pm.id, type: 'us_bank_account', label: `${pm.us_bank_account.bank_name} •••• ${pm.us_bank_account.last4}` });
      }
    }
    return out;
  }

  async removeMethod(customerId: string, methodId: string) {
    // make sure the method belongs to this customer before detaching
    const pm = await this.stripe.paymentMethods.retrieve(methodId);
    if (pm.customer !== customerId) throw new Error('Payment method not found');
    await this.stripe.paymentMethods.detach(methodId);
  }

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    if (!req.mosque.payoutAccountId) return { status: 'failed', error: 'Mosque cannot accept payments' };
    try {
      const pi = await this.stripe.paymentIntents.create(
        {
          amount: req.amountCents,
          currency: 'usd',
          customer: req.customerId,
          payment_method: req.paymentMethodId,
          confirm: true,
          off_session: true,
          description: req.description,
          transfer_data: { destination: req.mosque.payoutAccountId },
          metadata: { mosqueId: req.mosque.id },
        },
        { idempotencyKey: req.idempotencyKey },
      );
      if (pi.status === 'succeeded') return { status: 'succeeded', reference: pi.id };
      if (pi.status === 'processing') return { status: 'processing', reference: pi.id };
      return { status: 'failed', reference: pi.id, error: 'Payment needs additional verification. Please re-add your payment method.' };
    } catch (e) {
      const err = e as Stripe.errors.StripeError;
      if (err.type === 'StripeCardError') return { status: 'failed', error: err.message };
      if (err.type === 'StripeInvalidRequestError' || err.type === 'StripeAuthenticationError' || err.type === 'StripePermissionError') {
        console.error('Stripe request rejected:', err.message);
        return { status: 'failed', error: 'Payment could not be processed.' };
      }
      throw e; // network/API outage: let the caller decide, don't record a false failure
    }
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): WebhookEvent {
    if (!this.webhookSecret || !signature) throw new Error('Webhook not configured');
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    switch (event.type) {
      case 'payment_intent.succeeded':
        return { kind: 'payment', reference: event.data.object.id, status: 'succeeded' };
      case 'payment_intent.payment_failed':
        return { kind: 'payment', reference: event.data.object.id, status: 'failed' };
      case 'account.updated': {
        const a = event.data.object;
        return { kind: 'account', accountId: a.id, ready: !!a.charges_enabled && !!a.details_submitted };
      }
      default:
        return { kind: 'ignored' };
    }
  }
}
