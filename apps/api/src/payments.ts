import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type { Mosque, User } from './types.js';

export interface SavedMethod {
  id: string;
  type: 'card' | 'us_bank_account';
  label: string; // e.g. "Visa •••• 4242"
}

export interface ChargeRequest {
  donationId: string;
  methodType: SavedMethod['type'];
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
  /** Processor fee in cents when already known; null/undefined means look it up later with getFee. */
  feeCents?: number | null;
  error?: string;
}

export type WebhookEvent =
  | { kind: 'payment'; reference: string; status: 'succeeded' | 'failed' }
  | { kind: 'refund'; reference: string; totalRefundedCents: number }
  | { kind: 'dispute'; reference: string; disputeId: string; amountCents: number; outcome: 'opened' | 'won' }
  | { kind: 'account'; accountId: string; ready: boolean }
  | { kind: 'ignored' };

/** Result of an action that may need the user to finish in a hosted Stripe page. `url` is null when nothing more is needed. */
export interface HostedStep {
  url: string | null;
}

/**
 * Payment boundary. Routes only know this interface.
 * Money flow: donors pay the PLATFORM (platform-level Customer + saved payment method -> PaymentIntent).
 * What each mosque is owed is tracked in our ledger; money moves to a mosque later via transfer().
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
  /** Processor fee for a succeeded charge, or null if it isn't available (yet). */
  getFee(reference: string): Promise<number | null>;
  /** Move money from the platform balance to a mosque's connected account. */
  transfer(req: { accountId: string; amountCents: number; idempotencyKey: string }): Promise<{ reference: string }>;
  /** Total funds the provider holds for the platform (available + pending), or null if unknown. */
  getBalanceCents(): Promise<number | null>;
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
  private fees = new Map<string, number>();
  private balance = 0;
  async charge(req: ChargeRequest): Promise<ChargeResult> {
    // roughly Stripe's US pricing: 2.9% + 30c for cards, 0.8% capped at $5 for bank debits
    const fee = req.methodType === 'card' ? Math.round(req.amountCents * 0.029) + 30 : Math.min(Math.round(req.amountCents * 0.008), 500);
    const reference = 'mock_' + randomUUID();
    this.fees.set(reference, fee);
    this.balance += req.amountCents - fee;
    return { status: 'succeeded', reference, feeCents: fee };
  }
  async getFee(reference: string) {
    return this.fees.get(reference) ?? null;
  }
  async transfer(req: { amountCents: number }) {
    this.balance -= req.amountCents;
    return { reference: 'mock_tr_' + randomUUID() };
  }
  async getBalanceCents() {
    return this.balance;
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

  private static EXPAND = ['latest_charge.balance_transaction'];

  /** Pull the processor fee out of an expanded PaymentIntent, if Stripe has it yet. */
  private static feeOf(pi: Stripe.PaymentIntent): number | null {
    const charge = pi.latest_charge;
    if (!charge || typeof charge === 'string') return null;
    const bt = charge.balance_transaction;
    return bt && typeof bt !== 'string' ? bt.fee : null;
  }

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    try {
      // Charged on the platform account; the mosque is only recorded in metadata (our ledger owns who is owed what).
      const pi = await this.stripe.paymentIntents.create(
        {
          amount: req.amountCents,
          currency: 'usd',
          customer: req.customerId,
          payment_method: req.paymentMethodId,
          confirm: true,
          off_session: true,
          description: req.description,
          metadata: { mosqueId: req.mosque.id, donationId: req.donationId },
          expand: StripePaymentProvider.EXPAND,
        },
        { idempotencyKey: req.idempotencyKey },
      );
      if (pi.status === 'succeeded') return { status: 'succeeded', reference: pi.id, feeCents: StripePaymentProvider.feeOf(pi) };
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

  async getFee(reference: string) {
    const pi = await this.stripe.paymentIntents.retrieve(reference, { expand: StripePaymentProvider.EXPAND });
    return pi.status === 'succeeded' ? StripePaymentProvider.feeOf(pi) : null;
  }

  async transfer(req: { accountId: string; amountCents: number; idempotencyKey: string }) {
    const t = await this.stripe.transfers.create(
      { amount: req.amountCents, currency: 'usd', destination: req.accountId },
      { idempotencyKey: req.idempotencyKey },
    );
    return { reference: t.id };
  }

  async getBalanceCents() {
    const b = await this.stripe.balance.retrieve();
    const usd = (xs: { currency: string; amount: number }[]) => xs.filter((x) => x.currency === 'usd').reduce((s, x) => s + x.amount, 0);
    return usd(b.available) + usd(b.pending);
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): WebhookEvent {
    if (!this.webhookSecret || !signature) throw new Error('Webhook not configured');
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    switch (event.type) {
      case 'payment_intent.succeeded':
        return { kind: 'payment', reference: event.data.object.id, status: 'succeeded' };
      case 'payment_intent.payment_failed':
        return { kind: 'payment', reference: event.data.object.id, status: 'failed' };
      case 'charge.refunded': {
        const c = event.data.object;
        const pi = typeof c.payment_intent === 'string' ? c.payment_intent : c.payment_intent?.id;
        return pi ? { kind: 'refund', reference: pi, totalRefundedCents: c.amount_refunded } : { kind: 'ignored' };
      }
      case 'charge.dispute.created':
      case 'charge.dispute.closed': {
        const d = event.data.object;
        const pi = typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id;
        if (!pi) return { kind: 'ignored' };
        if (event.type === 'charge.dispute.created') {
          // "warning_*" statuses are inquiries: no funds are withdrawn yet
          if (d.status.startsWith('warning')) return { kind: 'ignored' };
          return { kind: 'dispute', reference: pi, disputeId: d.id, amountCents: d.amount, outcome: 'opened' };
        }
        return d.status === 'won' ? { kind: 'dispute', reference: pi, disputeId: d.id, amountCents: d.amount, outcome: 'won' } : { kind: 'ignored' };
      }
      case 'account.updated': {
        const a = event.data.object;
        return { kind: 'account', accountId: a.id, ready: !!a.charges_enabled && !!a.details_submitted };
      }
      default:
        return { kind: 'ignored' };
    }
  }
}
