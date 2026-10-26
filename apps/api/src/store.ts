import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type Role = 'donor' | 'admin';
export type Frequency = 'weekly' | 'monthly';

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

export interface Favorite {
  userId: string;
  mosqueId: string;
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

export interface Data {
  ledger: LedgerEntry[];
  payouts: Payout[];
  users: User[];
  mosques: Mosque[];
  favorites: Favorite[];
  donations: Donation[];
  recurring: Recurring[];
}

export const newId = () => randomUUID();

export function seedData(): Data {
  const mk = (name: string, city: string, state: string, address: string, description: string, causes: [string, string][]): Mosque => ({
    id: newId(),
    name,
    city,
    state,
    address,
    description,
    causes: causes.map(([title, d]) => ({ id: newId(), title, description: d })),
    payoutsConnected: true,
    payoutAccountId: 'acct_demo_' + name.replace(/\W/g, '').toLowerCase(),
  });
  return {
    ledger: [],
    payouts: [],
    users: [],
    favorites: [],
    donations: [],
    recurring: [],
    mosques: [
      mk('Masjid Al-Noor', 'Dearborn', 'MI', '123 Ford Rd', 'A community masjid serving families since 1985.', [
        ['General Fund', 'Utilities, upkeep and daily operations.'],
        ['Weekend School', 'Quran and Islamic studies for children.'],
      ]),
      mk('Islamic Center of Riverside', 'Riverside', 'CA', '45 Palm Ave', 'Prayer, education and outreach.', [
        ['General Fund', 'Utilities, upkeep and daily operations.'],
        ['Expansion Project', 'Raising funds for a new prayer hall.'],
      ]),
      mk('Masjid At-Taqwa', 'Brooklyn', 'NY', '1266 Bedford Ave', 'Historic masjid in the heart of Bed-Stuy.', [
        ['General Fund', 'Utilities, upkeep and daily operations.'],
        ['Food Pantry', 'Weekly groceries for neighbors in need.'],
      ]),
    ],
  };
}

/** Tiny JSON-file backed store; swap for a real database before production. */
export class Store {
  data: Data;
  policy: FeePolicy = { passThroughProcessingFees: true, platformFeeBps: 0 };
  ledgerKeys = new Set<string>();
  constructor(private file?: string, seed = true) {
    if (file && fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      this.data = seed ? seedData() : { ledger: [], payouts: [], users: [], mosques: [], favorites: [], donations: [], recurring: [] };
      this.save();
    }
    // files written before the ledger existed
    this.data.ledger ??= [];
    this.data.payouts ??= [];
    for (const e of this.data.ledger) this.ledgerKeys.add(e.key);
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
