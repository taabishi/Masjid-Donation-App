import { randomUUID } from 'node:crypto';
import type { Mosque, User } from './store.js';

export interface ChargeRequest {
  amountCents: number;
  donor: User;
  mosque: Mosque;
  description: string;
}

export interface ChargeResult {
  ok: boolean;
  reference?: string;
  error?: string;
}

/**
 * Payment boundary. The routes only know this interface, so a real provider
 * (e.g. Stripe Connect: onboard each mosque as a connected account, save the
 * donor's payment method, create PaymentIntents with transfer_data) can be
 * dropped in without touching route code.
 */
export interface PaymentProvider {
  /** Start payout onboarding for a mosque; returns the connected account id. */
  connectMosque(mosque: Mosque): Promise<string>;
  charge(req: ChargeRequest): Promise<ChargeResult>;
}

/** Development provider: every charge succeeds, nothing real is moved. */
export class MockPaymentProvider implements PaymentProvider {
  async connectMosque(mosque: Mosque) {
    return 'acct_mock_' + mosque.id.slice(0, 8);
  }
  async charge(_req: ChargeRequest): Promise<ChargeResult> {
    return { ok: true, reference: 'mock_' + randomUUID() };
  }
}
