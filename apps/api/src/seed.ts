import type { Repo } from './repo.js';
import { newId } from './types.js';

/** Demo mosques for local development with the mock payment provider. Only inserts into an empty database. */
export async function seedDemoMosques(repo: Repo) {
  if ((await repo.countMosques()) > 0) return;
  const mk = async (name: string, city: string, state: string, address: string, description: string, causes: [string, string][]) =>
    repo.createMosque({
      id: newId(), name, city, state, address, description,
      causes: causes.map(([title, d]) => ({ id: newId(), title, description: d })),
      payoutsConnected: true,
      verificationStatus: 'verified',
      payoutAccountId: 'acct_demo_' + name.replace(/\W/g, '').toLowerCase(),
    });
  await mk('Masjid Al-Noor', 'Dearborn', 'MI', '123 Ford Rd', 'A community masjid serving families since 1985.', [
    ['General Fund', 'Utilities, upkeep and daily operations.'],
    ['Weekend School', 'Quran and Islamic studies for children.'],
  ]);
  await mk('Islamic Center of Riverside', 'Riverside', 'CA', '45 Palm Ave', 'Prayer, education and outreach.', [
    ['General Fund', 'Utilities, upkeep and daily operations.'],
    ['Expansion Project', 'Raising funds for a new prayer hall.'],
  ]);
  await mk('Masjid At-Taqwa', 'Brooklyn', 'NY', '1266 Bedford Ave', 'Historic masjid in the heart of Bed-Stuy.', [
    ['General Fund', 'Utilities, upkeep and daily operations.'],
    ['Food Pantry', 'Weekly groceries for neighbors in need.'],
  ]);
}
