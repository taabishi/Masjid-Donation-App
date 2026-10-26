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
  status: 'succeeded' | 'failed';
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
  nextDate: string;
  active: boolean;
  createdAt: string;
}

export interface Favorite {
  userId: string;
  mosqueId: string;
}

export interface Data {
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
  constructor(private file?: string) {
    if (file && fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      this.data = seedData();
      this.save();
    }
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
