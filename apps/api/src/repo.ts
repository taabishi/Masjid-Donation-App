import type { Db, Queryable } from './db.js';
import { newId } from './types.js';
import type { Cause, Donation, FeePolicy, Frequency, LedgerEntry, LedgerType, Mosque, Payout, Recurring, Role, User } from './types.js';

// bigint comes back as number (PGlite) or string (pg); timestamptz as Date
const num = (v: unknown) => Number(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const userOf = (r: Row): User => ({
  id: r.id, name: r.name, email: r.email, passwordHash: r.password_hash, role: r.role as Role,
  mosqueId: r.mosque_id ?? undefined, paymentCustomerId: r.payment_customer_id ?? undefined,
});
const donationOf = (r: Row): Donation => ({
  id: r.id, userId: r.user_id, mosqueId: r.mosque_id, causeId: r.cause_id ?? undefined, amountCents: num(r.amount_cents),
  status: r.status, recurringId: r.recurring_id ?? undefined, paymentRef: r.payment_ref ?? undefined, createdAt: iso(r.created_at),
});
const recurringOf = (r: Row): Recurring => ({
  id: r.id, userId: r.user_id, mosqueId: r.mosque_id, causeId: r.cause_id ?? undefined, amountCents: num(r.amount_cents),
  frequency: r.frequency as Frequency, paymentMethodId: r.payment_method_id ?? undefined, nextDate: iso(r.next_date),
  active: r.active, createdAt: iso(r.created_at),
});
const payoutOf = (r: Row): Payout => ({
  id: r.id, mosqueId: r.mosque_id, amountCents: num(r.amount_cents), method: r.method, status: r.status,
  reference: r.reference ?? undefined, createdAt: iso(r.created_at),
});
const entryOf = (r: Row): LedgerEntry => ({
  id: r.id, key: r.key, createdAt: iso(r.created_at), account: r.account, type: r.type as LedgerType, amountCents: num(r.amount_cents),
  donationId: r.donation_id ?? undefined, payoutId: r.payout_id ?? undefined,
});

export type MosqueWithFavorite = Mosque & { isFavorite: boolean };

export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';

/** Typed access to the database. All SQL lives here. */
export class Repo {
  constructor(
    private q: Queryable,
    private db: Db,
    public policy: FeePolicy = { passThroughProcessingFees: true, platformFeeBps: 0 },
  ) {}

  /** Run `fn` atomically; nested calls are not supported. */
  transaction<T>(fn: (r: Repo) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new Repo(tx, this.db, this.policy)));
  }

  close() {
    return this.db.close();
  }

  // ---------- users ----------
  async findUserByEmail(email: string) {
    const { rows } = await this.q.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] ? userOf(rows[0]) : undefined;
  }
  async findUser(id: string) {
    const { rows } = await this.q.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? userOf(rows[0]) : undefined;
  }
  async createUser(u: User) {
    await this.q.query(
      'INSERT INTO users (id, name, email, password_hash, role, mosque_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [u.id, u.name, u.email, u.passwordHash, u.role, u.mosqueId ?? null],
    );
  }
  /** Set the payment customer id once; if another request won the race, return theirs. */
  async setPaymentCustomer(userId: string, customerId: string) {
    const { rows } = await this.q.query(
      'UPDATE users SET payment_customer_id = COALESCE(payment_customer_id, $2) WHERE id = $1 RETURNING payment_customer_id',
      [userId, customerId],
    );
    return rows[0].payment_customer_id as string;
  }

  // ---------- mosques ----------
  private async withCauses(rows: Row[]): Promise<MosqueWithFavorite[]> {
    if (!rows.length) return [];
    const causes = await this.q.query('SELECT * FROM causes WHERE mosque_id = ANY($1::text[]) ORDER BY seq', [rows.map((r) => r.id)]);
    const byMosque = new Map<string, Cause[]>();
    for (const c of causes.rows) {
      const list = byMosque.get(c.mosque_id) ?? [];
      list.push({ id: c.id, title: c.title, description: c.description });
      byMosque.set(c.mosque_id, list);
    }
    return rows.map((r) => ({
      id: r.id, name: r.name, city: r.city, state: r.state, address: r.address, description: r.description,
      causes: byMosque.get(r.id) ?? [], payoutsConnected: r.payouts_connected, payoutAccountId: r.payout_account_id ?? undefined,
      isFavorite: !!r.is_favorite,
    }));
  }

  private static FAV = 'EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = $1 AND f.mosque_id = m.id) AS is_favorite';

  /** `userId` only decides the isFavorite flag. */
  async searchMosques(search: string, userId: string | null) {
    const like = `%${search.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    const { rows } = await this.q.query(
      `SELECT m.*, ${Repo.FAV} FROM mosques m
       WHERE lower(m.name) LIKE $2 OR lower(m.city) LIKE $2 OR lower(m.state) LIKE $2 ORDER BY m.name`,
      [userId, like],
    );
    return this.withCauses(rows);
  }
  async getMosque(id: string, userId: string | null = null) {
    const { rows } = await this.q.query(`SELECT m.*, ${Repo.FAV} FROM mosques m WHERE m.id = $2`, [userId, id]);
    return (await this.withCauses(rows))[0];
  }
  async listMosques() {
    const { rows } = await this.q.query('SELECT m.*, false AS is_favorite FROM mosques m ORDER BY m.name');
    return this.withCauses(rows);
  }
  async countMosques() {
    return num((await this.q.query('SELECT count(*)::int AS n FROM mosques')).rows[0].n);
  }
  async findMosqueByPayoutAccount(accountId: string) {
    const { rows } = await this.q.query('SELECT id FROM mosques WHERE payout_account_id = $1', [accountId]);
    return rows[0] ? this.getMosque(rows[0].id) : undefined;
  }
  async createMosque(m: Omit<Mosque, 'causes'> & { causes: Cause[] }) {
    await this.q.query(
      'INSERT INTO mosques (id, name, city, state, address, description, payouts_connected, payout_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [m.id, m.name, m.city, m.state, m.address, m.description, m.payoutsConnected, m.payoutAccountId ?? null],
    );
    for (const c of m.causes) await this.addCause(m.id, c);
  }
  async updateMosqueProfile(id: string, p: { name: string; city: string; state: string; address: string; description: string }) {
    await this.q.query('UPDATE mosques SET name=$2, city=$3, state=$4, address=$5, description=$6 WHERE id=$1', [id, p.name, p.city, p.state, p.address, p.description]);
  }
  async setMosquePayout(id: string, accountId: string | undefined, connected: boolean) {
    await this.q.query('UPDATE mosques SET payout_account_id = COALESCE($2, payout_account_id), payouts_connected = $3 WHERE id = $1', [id, accountId ?? null, connected]);
  }
  async addCause(mosqueId: string, c: Cause) {
    await this.q.query('INSERT INTO causes (id, mosque_id, title, description) VALUES ($1,$2,$3,$4)', [c.id, mosqueId, c.title, c.description]);
  }
  async updateCause(mosqueId: string, c: Cause) {
    const { rows } = await this.q.query('UPDATE causes SET title=$3, description=$4 WHERE id=$1 AND mosque_id=$2 RETURNING id', [c.id, mosqueId, c.title, c.description]);
    return rows.length > 0;
  }
  async deleteCause(mosqueId: string, id: string) {
    await this.q.query('DELETE FROM causes WHERE id=$1 AND mosque_id=$2', [id, mosqueId]);
  }

  // ---------- favorites ----------
  async favoriteMosques(userId: string) {
    const { rows } = await this.q.query(
      `SELECT m.*, true AS is_favorite FROM mosques m JOIN favorites f ON f.mosque_id = m.id WHERE f.user_id = $1 ORDER BY m.name`,
      [userId],
    );
    return this.withCauses(rows);
  }
  async addFavorite(userId: string, mosqueId: string) {
    await this.q.query('INSERT INTO favorites (user_id, mosque_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, mosqueId]);
  }
  async removeFavorite(userId: string, mosqueId: string) {
    await this.q.query('DELETE FROM favorites WHERE user_id=$1 AND mosque_id=$2', [userId, mosqueId]);
  }

  // ---------- donations ----------
  /**
   * Insert a donation. If a donation with the same provider payment id already exists (a retried charge
   * that Stripe de-duplicated), return the existing one instead of creating a duplicate.
   */
  async createDonation(d: Donation): Promise<Donation> {
    const { rows } = await this.q.query(
      `INSERT INTO donations (id, user_id, mosque_id, cause_id, amount_cents, status, recurring_id, payment_ref, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (payment_ref) DO NOTHING RETURNING *`,
      [d.id, d.userId, d.mosqueId, d.causeId ?? null, d.amountCents, d.status, d.recurringId ?? null, d.paymentRef ?? null, d.createdAt],
    );
    if (rows[0]) return donationOf(rows[0]);
    return (await this.donationByRef(d.paymentRef!))!;
  }
  async donationByRef(ref: string) {
    const { rows } = await this.q.query('SELECT * FROM donations WHERE payment_ref = $1', [ref]);
    return rows[0] ? donationOf(rows[0]) : undefined;
  }
  async setDonationStatus(id: string, status: Donation['status']) {
    await this.q.query('UPDATE donations SET status = $2 WHERE id = $1', [id, status]);
  }
  async donationsForUser(userId: string) {
    const { rows } = await this.q.query(
      `SELECT d.*, m.name AS mosque_name FROM donations d JOIN mosques m ON m.id = d.mosque_id
       WHERE d.user_id = $1 ORDER BY d.created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({ ...donationOf(r), mosqueName: r.mosque_name as string }));
  }
  /** Succeeded donations that have no ledger settlement yet (fee not known at charge time). */
  async unsettledDonations() {
    const { rows } = await this.q.query(
      `SELECT d.* FROM donations d
       WHERE d.status = 'succeeded' AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.key = 'don:' || d.id || ':gross')
       ORDER BY d.created_at`,
    );
    return rows.map(donationOf);
  }
  async adminReport(mosqueId: string) {
    const total = (await this.q.query(
      `SELECT COALESCE(SUM(amount_cents),0)::text AS sum, count(*)::int AS n,
              COALESCE(SUM(amount_cents) FILTER (WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text AS month
       FROM donations WHERE mosque_id = $1 AND status = 'succeeded'`,
      [mosqueId],
    )).rows[0];
    const recurring = (await this.q.query('SELECT count(*)::int AS n FROM recurring WHERE mosque_id=$1 AND active', [mosqueId])).rows[0].n;
    const recent = (await this.q.query(
      `SELECT d.id, d.amount_cents, d.created_at, d.recurring_id, u.name AS donor_name, c.title AS cause
       FROM donations d JOIN users u ON u.id = d.user_id LEFT JOIN causes c ON c.id = d.cause_id
       WHERE d.mosque_id = $1 AND d.status = 'succeeded' ORDER BY d.created_at DESC LIMIT 100`,
      [mosqueId],
    )).rows;
    return {
      totalCents: num(total.sum), thisMonthCents: num(total.month), donationCount: num(total.n), activeRecurring: num(recurring),
      donations: recent.map((r) => ({
        id: r.id as string, amountCents: num(r.amount_cents), createdAt: iso(r.created_at), recurring: !!r.recurring_id,
        donorName: r.donor_name as string, cause: (r.cause ?? undefined) as string | undefined,
      })),
    };
  }

  // ---------- recurring ----------
  async createRecurring(r: Recurring) {
    await this.q.query(
      `INSERT INTO recurring (id, user_id, mosque_id, cause_id, amount_cents, frequency, payment_method_id, next_date, active, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [r.id, r.userId, r.mosqueId, r.causeId ?? null, r.amountCents, r.frequency, r.paymentMethodId ?? null, r.nextDate, r.active, r.createdAt],
    );
  }
  async activeRecurringForUser(userId: string) {
    const { rows } = await this.q.query(
      `SELECT r.*, m.name AS mosque_name FROM recurring r JOIN mosques m ON m.id = r.mosque_id
       WHERE r.user_id = $1 AND r.active ORDER BY r.created_at`,
      [userId],
    );
    return rows.map((r) => ({ ...recurringOf(r), mosqueName: r.mosque_name as string }));
  }
  async cancelRecurring(userId: string, id: string) {
    const { rows } = await this.q.query('UPDATE recurring SET active = false WHERE id=$1 AND user_id=$2 AND active RETURNING id', [id, userId]);
    return rows.length > 0;
  }
  async dueRecurring(now: Date) {
    const { rows } = await this.q.query('SELECT * FROM recurring WHERE active AND next_date <= $1 ORDER BY next_date', [now.toISOString()]);
    return rows.map(recurringOf);
  }
  async advanceRecurring(id: string, nextDate: string) {
    await this.q.query('UPDATE recurring SET next_date = $2 WHERE id = $1', [id, nextDate]);
  }
  async deactivateRecurring(id: string) {
    await this.q.query('UPDATE recurring SET active = false WHERE id = $1', [id]);
  }
  /** Schedules that used a removed payment method fall back to the donor's next saved method. */
  async clearRecurringMethod(userId: string, methodId: string) {
    await this.q.query('UPDATE recurring SET payment_method_id = NULL WHERE user_id=$1 AND payment_method_id=$2', [userId, methodId]);
  }

  // ---------- ledger ----------
  /** Insert an entry; returns false (and changes nothing) if the key was already posted. */
  async postEntry(e: { key: string; account: string; type: LedgerType; amountCents: number; donationId?: string; payoutId?: string; at?: Date }) {
    if (!Number.isSafeInteger(e.amountCents)) throw new Error('ledger amounts must be integer cents');
    const { rows } = await this.q.query(
      `INSERT INTO ledger_entries (id, key, created_at, account, type, amount_cents, donation_id, payout_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (key) DO NOTHING RETURNING id`,
      [newId(), e.key, (e.at ?? new Date()).toISOString(), e.account, e.type, e.amountCents, e.donationId ?? null, e.payoutId ?? null],
    );
    return rows.length > 0;
  }
  async hasKey(key: string) {
    return (await this.q.query('SELECT 1 FROM ledger_entries WHERE key = $1', [key])).rows.length > 0;
  }
  async balanceOf(account: string) {
    return num((await this.q.query('SELECT COALESCE(SUM(amount_cents),0)::text AS s FROM ledger_entries WHERE account = $1', [account])).rows[0].s);
  }
  async balancesByAccount() {
    const { rows } = await this.q.query('SELECT account, SUM(amount_cents)::text AS s FROM ledger_entries GROUP BY account');
    return new Map(rows.map((r) => [r.account as string, num(r.s)]));
  }
  async ledgerTotal() {
    return num((await this.q.query('SELECT COALESCE(SUM(amount_cents),0)::text AS s FROM ledger_entries')).rows[0].s);
  }
  async refundedSoFar(donationId: string) {
    return -num((await this.q.query(`SELECT COALESCE(SUM(amount_cents),0)::text AS s FROM ledger_entries WHERE donation_id=$1 AND type='refund'`, [donationId])).rows[0].s);
  }
  async recentLedger(account?: string, limit = 200) {
    const { rows } = await this.q.query(
      'SELECT * FROM ledger_entries WHERE ($1::text IS NULL OR account = $1) ORDER BY created_at DESC, id LIMIT $2',
      [account ?? null, limit],
    );
    return rows.map(entryOf);
  }
  /** Serialize concurrent ledger work on one donation or mosque (call inside a transaction). */
  async lockDonation(id: string) {
    await this.q.query('SELECT id FROM donations WHERE id = $1 FOR UPDATE', [id]);
  }
  async lockMosque(id: string) {
    await this.q.query('SELECT id FROM mosques WHERE id = $1 FOR UPDATE', [id]);
  }

  // ---------- payouts ----------
  async insertPayout(p: Payout) {
    await this.q.query(
      'INSERT INTO payouts (id, mosque_id, amount_cents, method, status, reference, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [p.id, p.mosqueId, p.amountCents, p.method, p.status, p.reference ?? null, p.createdAt],
    );
  }
  async setPayoutStatus(id: string, status: Payout['status'], reference?: string) {
    await this.q.query('UPDATE payouts SET status = $2, reference = COALESCE($3, reference) WHERE id = $1', [id, status, reference ?? null]);
  }
  async payoutsForMosque(mosqueId: string) {
    const { rows } = await this.q.query(`SELECT * FROM payouts WHERE mosque_id = $1 AND status <> 'failed' ORDER BY created_at DESC`, [mosqueId]);
    return rows.map(payoutOf);
  }
}
