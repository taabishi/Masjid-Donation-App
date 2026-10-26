import { randomUUID } from 'node:crypto';
import type { EinLookup } from './directory.js';

export type Role = 'donor' | 'admin';
export type Frequency = 'weekly' | 'monthly';
export type VerificationStatus = 'unverified' | 'pending_review' | 'verified' | 'rejected';

export interface User {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  mosqueId?: string; // set for admins
  paymentCustomerId?: string; // provider customer id, created on first use
}

export interface Cause {
  id: string;
  title: string;
  description: string;
}

export interface Mosque {
  id: string;
  name: string;
  city: string;
  state: string;
  address: string;
  description: string;
  causes: Cause[];
  payoutsConnected: boolean;
  payoutAccountId?: string;
  /** Only 'verified' organizations can receive donations or payouts. */
  verificationStatus: VerificationStatus;
  ein?: string;
  legalName?: string;
  verificationNote?: string;
  einLookup?: EinLookup;
}

export interface Donation {
  id: string;
  userId: string;
  mosqueId: string;
  causeId?: string;
  amountCents: number;
  status: 'succeeded' | 'processing' | 'failed';
  recurringId?: string;
  paymentRef?: string;
  createdAt: string;
}

export interface Recurring {
  id: string;
  userId: string;
  mosqueId: string;
  causeId?: string;
  amountCents: number;
  frequency: Frequency;
  paymentMethodId?: string;
  nextDate: string;
  active: boolean;
  createdAt: string;
}

/**
 * One line in the append-only money ledger. `amountCents` is signed from the account's point of view
 * (positive = we owe that account more). `account` is a mosque id or 'platform'.
 * Entries are never edited or deleted; corrections are new entries. `key` makes posting idempotent.
 */
export type LedgerType =
  | 'donation'
  | 'processing_fee'
  | 'platform_fee'
  | 'refund'
  | 'dispute'
  | 'dispute_reversal'
  | 'payout'
  | 'payout_reversal';

export interface LedgerEntry {
  id: string;
  key: string;
  createdAt: string;
  account: string;
  type: LedgerType;
  amountCents: number;
  donationId?: string;
  payoutId?: string;
}

export interface Payout {
  id: string;
  mosqueId: string;
  amountCents: number;
  method: 'stripe_transfer' | 'ach_manual';
  status: 'pending' | 'completed' | 'failed';
  reference?: string;
  createdAt: string;
}

export interface FeePolicy {
  /** true: Stripe's fee is deducted from the mosque's share; false: the platform absorbs it. */
  passThroughProcessingFees: boolean;
  /** Platform's cut in basis points (100 = 1%). */
  platformFeeBps: number;
}

export const newId = () => randomUUID();
