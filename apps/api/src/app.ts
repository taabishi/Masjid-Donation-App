import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { newId, type Mosque, type Role, type User } from './types.js';
import type { PaymentProvider } from './payments.js';
import { chargeDonation } from './donate.js';
import { completePayout, createPayout, failPayout, PayoutError, PLATFORM, reconcile, recordDispute, recordRefund, settleDonation } from './ledger.js';
import { isUniqueViolation, type MosqueWithFavorite, type Repo } from './repo.js';
import { checkEin, formatEin, normalizeEin, ProPublicaDirectory, type NonprofitDirectory } from './directory.js';

// Card fees are ~2.9% + 30c, so tiny gifts lose a large share to fees. Keep in sync with the app.
const MIN_CENTS = 500; // $5
const MAX_CENTS = 1_000_000; // $10,000

interface AuthedRequest extends Request {
  user?: User;
}

export interface AppOptions {
  /** Public base URL of this API, used for hosted-page return links. */
  apiPublicUrl: string;
  /** URL prefixes the return page may redirect back to (web app origin, native deep-link schemes). */
  allowedReturnPrefixes: string[];
  /** Emails allowed to use the /ops platform-operator endpoints (balances, payouts, reconciliation, verification). */
  operatorEmails: string[];
  /** Tax-exempt directory used to pre-check EINs for the reviewer. */
  directory?: NonprofitDirectory;
  /** Browser origins allowed to call the API. Empty/omitted = any origin (development only). Native apps send no Origin and are unaffected. */
  corsOrigins?: string[];
}

export function createApp(
  repo: Repo,
  payments: PaymentProvider,
  jwtSecret: string,
  opts: AppOptions = { apiPublicUrl: 'http://localhost:4000', allowedReturnPrefixes: ['http://localhost:8081', 'masjiddonation://', 'exp://'], operatorEmails: [] },
) {
  const app = express();
  app.use(cors(opts.corsOrigins?.length ? { origin: opts.corsOrigins } : undefined));

  app.get('/health', (_req, res) => res.json({ ok: true })); // for the hosting platform's health check

  // Stripe signs the raw body, so this must be registered before express.json().
  app.post('/webhooks/payments', express.raw({ type: '*/*' }), async (req, res) => {
    let event;
    try {
      event = payments.parseWebhook(req.body as Buffer, req.headers['stripe-signature'] as string | undefined);
    } catch {
      return res.status(400).json({ error: 'Invalid webhook' });
    }
    try {
      if (event.kind === 'payment') {
        const don = await repo.donationByRef(event.reference);
        if (don && event.status === 'succeeded') {
          if (don.status !== 'succeeded') await repo.setDonationStatus(don.id, 'succeeded');
          const fee = await payments.getFee(event.reference);
          if (fee !== null) await settleDonation(repo, { ...don, status: 'succeeded' }, fee);
        } else if (don && don.status === 'processing') {
          await repo.setDonationStatus(don.id, 'failed');
        }
      } else if (event.kind === 'refund') {
        const don = await repo.donationByRef(event.reference);
        if (don) await recordRefund(repo, don, event.totalRefundedCents);
      } else if (event.kind === 'dispute') {
        const don = await repo.donationByRef(event.reference);
        if (don) await recordDispute(repo, don, event.disputeId, event.amountCents, event.outcome);
      } else if (event.kind === 'account') {
        const m = await repo.findMosqueByPayoutAccount(event.accountId);
        if (m && m.payoutsConnected !== event.ready) await repo.setMosquePayout(m.id, undefined, event.ready);
      }
    } catch (e) {
      console.error('webhook handling failed', e);
      return res.status(500).json({ error: 'Failed' }); // Stripe will retry; handlers are idempotent
    }
    res.json({ received: true });
  });

  app.use(express.json());

  const directory = opts.directory ?? new ProPublicaDirectory();
  const isOperator = (u: User) => opts.operatorEmails.includes(u.email);
  const publicUser = (u: User) => ({ id: u.id, name: u.name, email: u.email, role: u.role, mosqueId: u.mosqueId, operator: isOperator(u) });
  const sign = (u: User) => jwt.sign({ sub: u.id }, jwtSecret, { expiresIn: '30d' });

  const auth = (role?: Role) => async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not signed in' });
    let sub: string;
    try {
      sub = (jwt.verify(header.slice(7), jwtSecret) as { sub: string }).sub;
    } catch {
      return res.status(401).json({ error: 'Not signed in' });
    }
    const user = await repo.findUser(sub);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    if (role && user.role !== role) return res.status(403).json({ error: 'Not allowed' });
    req.user = user;
    next();
  };

  const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown, res: Response): z.infer<T> | undefined => {
    const r = schema.safeParse(body);
    if (!r.success) {
      res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
      return undefined;
    }
    return r.data;
  };

  const mosqueView = (m: MosqueWithFavorite) => ({
    id: m.id,
    name: m.name,
    city: m.city,
    state: m.state,
    address: m.address,
    description: m.description,
    causes: m.causes,
    // only verified organizations can receive donations; the platform collects on their behalf and pays out later
    acceptingDonations: m.verificationStatus === 'verified',
    isFavorite: m.isFavorite,
  });

  // ---------- auth ----------
  const registerSchema = z.object({
    name: z.string().trim().min(1),
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(8),
    // present only when an organization is signing up as an admin
    mosque: z
      .object({
        name: z.string().trim().min(1),
        city: z.string().trim().min(1),
        state: z.string().trim().min(1),
        address: z.string().trim().default(''),
        description: z.string().trim().default(''),
      })
      .optional(),
  });

  app.post('/auth/register', async (req, res) => {
    const body = parse(registerSchema, req.body, res);
    if (!body) return;
    if (await repo.findUserByEmail(body.email)) return res.status(409).json({ error: 'Email already registered' });
    const user: User = {
      id: newId(),
      name: body.name,
      email: body.email,
      passwordHash: await bcrypt.hash(body.password, 10),
      role: body.mosque ? 'admin' : 'donor',
    };
    try {
      await repo.transaction(async (tx) => {
        if (body.mosque) {
          const mosque: Mosque = {
            id: newId(),
            ...body.mosque,
            causes: [{ id: newId(), title: 'General Fund', description: 'Day-to-day operations and upkeep.' }],
            payoutsConnected: false,
            verificationStatus: 'unverified',
          };
          await tx.createMosque(mosque);
          user.mosqueId = mosque.id;
        }
        await tx.createUser(user);
      });
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(409).json({ error: 'Email already registered' });
      throw e;
    }
    res.status(201).json({ token: sign(user), user: publicUser(user) });
  });

  app.post('/auth/login', async (req, res) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string() }), req.body, res);
    if (!body) return;
    const user = await repo.findUserByEmail(body.email);
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) return res.status(401).json({ error: 'Invalid email or password' });
    res.json({ token: sign(user), user: publicUser(user) });
  });

  app.get('/me', auth(), (req: AuthedRequest, res) => res.json(publicUser(req.user!)));

  // ---------- browsing mosques (donor) ----------
  app.get('/mosques', auth(), async (req: AuthedRequest, res) => {
    const list = await repo.searchMosques(String(req.query.q ?? '').trim(), req.user!.id);
    res.json(list.map(mosqueView));
  });

  app.get('/mosques/:id', auth(), async (req: AuthedRequest, res) => {
    const m = await repo.getMosque(String(req.params.id), req.user!.id);
    if (!m) return res.status(404).json({ error: 'Mosque not found' });
    res.json(mosqueView(m));
  });

  // ---------- favorites ----------
  app.get('/favorites', auth(), async (req: AuthedRequest, res) => {
    res.json((await repo.favoriteMosques(req.user!.id)).map(mosqueView));
  });

  app.put('/favorites/:mosqueId', auth(), async (req: AuthedRequest, res) => {
    const mosqueId = String(req.params.mosqueId);
    if (!(await repo.getMosque(mosqueId))) return res.status(404).json({ error: 'Mosque not found' });
    await repo.addFavorite(req.user!.id, mosqueId);
    res.status(204).end();
  });

  app.delete('/favorites/:mosqueId', auth(), async (req: AuthedRequest, res) => {
    await repo.removeFavorite(req.user!.id, String(req.params.mosqueId));
    res.status(204).end();
  });

  // ---------- hosted-page return ----------
  const allowedReturn = (url: unknown): url is string =>
    typeof url === 'string' && opts.allowedReturnPrefixes.some((p) => url.startsWith(p));

  /** Stripe's hosted pages redirect here; we bounce the user back into the app (web URL or deep link). */
  app.get('/payment-return', (req, res) => {
    const to = req.query.to;
    if (!allowedReturn(to)) return res.status(400).send('Invalid return address');
    const safe = to.replace(/"/g, '%22');
    res
      .type('html')
      .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${safe}"><title>Returning…</title><body style="font-family:sans-serif;text-align:center;padding:48px"><p>All set.</p><p><a href="${safe}">Return to Masjid Donation Box</a></p>`);
  });

  const returnLink = (to: string) => `${opts.apiPublicUrl}/payment-return?to=${encodeURIComponent(to)}`;
  const returnSchema = z.object({ returnUrl: z.string() }).refine((b) => allowedReturn(b.returnUrl), { message: 'returnUrl not allowed', path: ['returnUrl'] });

  const customerFor = async (user: User) => {
    if (user.paymentCustomerId) return user.paymentCustomerId;
    const created = await payments.createCustomer(user);
    // if two requests race, the first stored id wins and is used by both
    user.paymentCustomerId = await repo.setPaymentCustomer(user.id, created);
    return user.paymentCustomerId;
  };

  // ---------- payment methods (donor) ----------
  app.get('/payment-methods', auth(), async (req: AuthedRequest, res) => {
    const id = req.user!.paymentCustomerId;
    res.json(id ? await payments.listMethods(id) : []);
  });

  // Returns { url } to open (Stripe-hosted page for cards / Apple Pay / Google Pay / bank accounts), or { url: null } if nothing to open.
  app.post('/payment-methods', auth(), async (req: AuthedRequest, res) => {
    const body = parse(returnSchema, req.body, res);
    if (!body) return;
    res.json(await payments.beginAddPaymentMethod(await customerFor(req.user!), returnLink(body.returnUrl)));
  });

  app.delete('/payment-methods/:id', auth(), async (req: AuthedRequest, res) => {
    const customerId = req.user!.paymentCustomerId;
    if (!customerId) return res.status(404).json({ error: 'Not found' });
    try {
      await payments.removeMethod(customerId, String(req.params.id));
    } catch {
      return res.status(404).json({ error: 'Not found' });
    }
    await repo.clearRecurringMethod(req.user!.id, String(req.params.id));
    res.status(204).end();
  });

  // ---------- donations ----------
  const amountSchema = z.number().int().min(MIN_CENTS).max(MAX_CENTS);
  const donationSchema = z.object({ mosqueId: z.string(), amountCents: amountSchema, causeId: z.string().optional(), paymentMethodId: z.string().optional() });

  const checkTarget = async (mosqueId: string, causeId: string | undefined, res: Response) => {
    const mosque = await repo.getMosque(mosqueId);
    if (!mosque) return void res.status(404).json({ error: 'Mosque not found' });
    if (mosque.verificationStatus !== 'verified') return void res.status(409).json({ error: 'This organization is not accepting donations yet', code: 'not_accepting' });
    if (causeId && !mosque.causes.some((c) => c.id === causeId)) return void res.status(400).json({ error: 'Unknown cause' });
    return mosque;
  };

  app.post('/donations', auth(), async (req: AuthedRequest, res) => {
    const body = parse(donationSchema, req.body, res);
    if (!body) return;
    const mosque = await checkTarget(body.mosqueId, body.causeId, res);
    if (!mosque) return;
    try {
      // a fresh key per request: donors may legitimately give the same amount twice
      const out = await chargeDonation(repo, payments, { user: req.user!, mosque, ...body, idempotencyKey: `don-${newId()}` });
      if (!out.ok) return res.status(out.code === 'no_payment_method' ? 409 : 402).json({ error: out.error, code: out.code });
      res.status(201).json(out.donation);
    } catch (e) {
      console.error('payment provider error', e);
      res.status(502).json({ error: 'Payment service is unavailable. You were not charged.' });
    }
  });

  app.get('/donations', auth(), async (req: AuthedRequest, res) => {
    res.json(await repo.donationsForUser(req.user!.id));
  });

  // ---------- recurring ----------
  const recurringSchema = z.object({
    mosqueId: z.string(),
    amountCents: amountSchema,
    frequency: z.enum(['weekly', 'monthly']),
    causeId: z.string().optional(),
    paymentMethodId: z.string().optional(),
  });

  app.post('/recurring', auth(), async (req: AuthedRequest, res) => {
    const body = parse(recurringSchema, req.body, res);
    if (!body) return;
    const mosque = await checkTarget(body.mosqueId, body.causeId, res);
    if (!mosque) return;
    const customerId = req.user!.paymentCustomerId;
    const methods = customerId ? await payments.listMethods(customerId) : [];
    if (!methods.length || (body.paymentMethodId && !methods.some((m) => m.id === body.paymentMethodId))) {
      return res.status(409).json({ error: 'Add a payment method first', code: 'no_payment_method' });
    }
    const now = new Date();
    // first charge is one period from now; donors can give right away with a one-time donation
    const r = {
      id: newId(),
      userId: req.user!.id,
      ...body,
      nextDate: new Date(now.getTime() + (body.frequency === 'weekly' ? 7 : 30) * 86_400_000).toISOString(),
      active: true,
      createdAt: now.toISOString(),
    };
    await repo.createRecurring(r);
    res.status(201).json({ ...r, mosqueName: mosque.name });
  });

  app.get('/recurring', auth(), async (req: AuthedRequest, res) => {
    res.json(await repo.activeRecurringForUser(req.user!.id));
  });

  app.delete('/recurring/:id', auth(), async (req: AuthedRequest, res) => {
    if (!(await repo.cancelRecurring(req.user!.id, String(req.params.id)))) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  });

  // ---------- admin (mosque) ----------
  const adminMosque = async (req: AuthedRequest) => (await repo.getMosque(req.user!.mosqueId!))!;

  app.get('/admin/mosque', auth('admin'), async (req: AuthedRequest, res) => {
    let m = await adminMosque(req);
    // pick up onboarding finished on the provider's hosted page (webhooks may lag or be unconfigured)
    if (!m.payoutsConnected && m.payoutAccountId) {
      try {
        if (await payments.isMosqueReady(m.payoutAccountId)) {
          await repo.setMosquePayout(m.id, undefined, true);
          m = { ...m, payoutsConnected: true };
        }
      } catch (e) {
        console.error('payout status check failed', e);
      }
    }
    res.json({ ...mosqueView(m), payoutsConnected: m.payoutsConnected, verificationStatus: m.verificationStatus });
  });

  app.put('/admin/mosque', auth('admin'), async (req: AuthedRequest, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1),
        city: z.string().trim().min(1),
        state: z.string().trim().min(1),
        address: z.string().trim(),
        description: z.string().trim(),
      }),
      req.body,
      res,
    );
    if (!body) return;
    await repo.updateMosqueProfile(req.user!.mosqueId!, body);
    res.json(mosqueView(await adminMosque(req)));
  });

  // Returns { url } for the provider's hosted onboarding page, or { url: null, payoutsConnected: true } when no onboarding is needed.
  app.post('/admin/payouts/connect', auth('admin'), async (req: AuthedRequest, res) => {
    const body = parse(returnSchema, req.body, res);
    if (!body) return;
    const m = await adminMosque(req);
    if (m.verificationStatus !== 'verified') return res.status(409).json({ error: 'Your organization must be verified before connecting payouts.' });
    const step = await payments.beginMosqueOnboarding(m, returnLink(body.returnUrl));
    const connected = step.url ? m.payoutsConnected : await payments.isMosqueReady(step.accountId);
    await repo.setMosquePayout(m.id, step.accountId, connected);
    res.json({ url: step.url, payoutsConnected: connected });
  });

  const causeSchema = z.object({ title: z.string().trim().min(1), description: z.string().trim().default('') });

  app.post('/admin/causes', auth('admin'), async (req: AuthedRequest, res) => {
    const body = parse(causeSchema, req.body, res);
    if (!body) return;
    const cause = { id: newId(), ...body };
    await repo.addCause(req.user!.mosqueId!, cause);
    res.status(201).json(cause);
  });

  app.put('/admin/causes/:id', auth('admin'), async (req: AuthedRequest, res) => {
    const body = parse(causeSchema, req.body, res);
    if (!body) return;
    const cause = { id: String(req.params.id), ...body };
    if (!(await repo.updateCause(req.user!.mosqueId!, cause))) return res.status(404).json({ error: 'Not found' });
    res.json(cause);
  });

  app.delete('/admin/causes/:id', auth('admin'), async (req: AuthedRequest, res) => {
    await repo.deleteCause(req.user!.mosqueId!, String(req.params.id));
    res.status(204).end();
  });

  app.get('/admin/donations', auth('admin'), async (req: AuthedRequest, res) => {
    const mosqueId = req.user!.mosqueId!;
    const { donations, ...summary } = await repo.adminReport(mosqueId);
    res.json({
      // balanceCents = collected for this mosque and not yet paid out
      summary: { ...summary, balanceCents: await repo.balanceOf(mosqueId) },
      payouts: (await repo.payoutsForMosque(mosqueId)).map((x) => ({ id: x.id, amountCents: x.amountCents, method: x.method, status: x.status, createdAt: x.createdAt })),
      // donor names are shown to the mosque admin; email is intentionally not exposed
      donations,
    });
  });

  // ---------- verification (mosque admin) ----------
  const MAX_DOC_BYTES = 5 * 1024 * 1024;
  const MAX_DOCS = 5;
  const DOC_TYPES: Record<string, (b: Buffer) => boolean> = {
    'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
    'image/png': (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    'image/jpeg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  };

  const verificationView = async (m: MosqueWithFavorite) => ({
    status: m.verificationStatus,
    note: m.verificationNote,
    ein: m.ein ? formatEin(m.ein) : undefined,
    legalName: m.legalName,
    lookup: m.einLookup,
    documents: (await repo.listDocuments(m.id)).map(({ id, filename, createdAt }) => ({ id, filename, createdAt })),
  });

  app.get('/admin/verification', auth('admin'), async (req: AuthedRequest, res) => {
    res.json(await verificationView(await adminMosque(req)));
  });

  const verificationSchema = z.object({ ein: z.string(), legalName: z.string().trim().min(1).max(200) });

  app.post('/admin/verification', auth('admin'), async (req: AuthedRequest, res) => {
    const body = parse(verificationSchema, req.body, res);
    if (!body) return;
    const ein = normalizeEin(body.ein);
    if (!ein) return res.status(400).json({ error: 'Enter a 9-digit EIN, e.g. 12-3456789' });
    const m = await adminMosque(req);
    if (m.verificationStatus === 'verified') return res.status(409).json({ error: 'Already verified. Contact support to change your EIN.' });
    const lookup = await checkEin(directory, ein, body.legalName, m.state);
    try {
      await repo.submitVerification(m.id, req.user!.id, { ein, legalName: body.legalName, lookup });
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(409).json({ error: 'This EIN is already registered by another account. Contact support if that is a mistake.' });
      throw e;
    }
    res.status(201).json(await verificationView((await adminMosque(req))!));
  });

  // Upload a determination letter or other proof. Raw bytes in the body, Content-Type set to the file's type, X-Filename header.
  app.post('/admin/verification/documents', auth('admin'), express.raw({ type: Object.keys(DOC_TYPES), limit: MAX_DOC_BYTES }), async (req: AuthedRequest, res) => {
    const m = await adminMosque(req);
    if (m.verificationStatus === 'verified') return res.status(409).json({ error: 'Already verified' });
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
    const data = req.body as Buffer;
    if (!DOC_TYPES[type] || !Buffer.isBuffer(data) || !data.length) return res.status(415).json({ error: 'Upload a PDF, PNG or JPEG file' });
    if (!DOC_TYPES[type](data)) return res.status(415).json({ error: 'File contents do not match its type' });
    if ((await repo.listDocuments(m.id)).length >= MAX_DOCS) return res.status(409).json({ error: `At most ${MAX_DOCS} documents` });
    const filename = String(req.headers['x-filename'] ?? 'document').replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'document';
    const id = newId();
    await repo.addDocument(m.id, { id, filename, contentType: type, data });
    res.status(201).json({ id, filename });
  });

  // ---------- platform operator ----------
  const operator = (req: AuthedRequest, res: Response, next: NextFunction) =>
    opts.operatorEmails.includes(req.user!.email) ? next() : void res.status(403).json({ error: 'Not allowed' });

  app.get('/ops/balances', auth(), operator, async (_req, res) => {
    const balances = await repo.balancesByAccount();
    const rows = (await repo.listMosques()).map((m) => ({
      mosqueId: m.id,
      name: m.name,
      owedCents: balances.get(m.id) ?? 0,
      payoutsConnected: m.payoutsConnected,
    }));
    res.json({ mosques: rows, platformCents: balances.get(PLATFORM) ?? 0, totalOwedCents: rows.reduce((s, r) => s + r.owedCents, 0) });
  });

  app.get('/ops/verifications', auth(), operator, async (req, res) => {
    const status = ['pending_review', 'verified', 'rejected', 'unverified'].includes(String(req.query.status)) ? String(req.query.status) : 'pending_review';
    const rows = await repo.verificationQueue(status);
    res.json(
      rows.map((m) => ({
        mosqueId: m.id, name: m.name, city: m.city, state: m.state, adminEmail: m.adminEmail, status: m.verificationStatus,
        ein: m.ein ? formatEin(m.ein) : undefined, legalName: m.legalName, lookup: m.einLookup, note: m.verificationNote,
        submittedAt: m.submittedAt, documents: m.documents.map(({ id, filename, contentType, sizeBytes }) => ({ id, filename, contentType, sizeBytes })),
      })),
    );
  });

  app.get('/ops/verifications/:mosqueId/documents/:docId', auth(), operator, async (req, res) => {
    const doc = await repo.getDocument(String(req.params.mosqueId), String(req.params.docId));
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res
      .set({ 'content-type': doc.contentType, 'content-disposition': `attachment; filename="${doc.filename.replace(/"/g, '')}"`, 'x-content-type-options': 'nosniff' })
      .send(doc.data);
  });

  const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).optional() });

  app.post('/ops/verifications/:mosqueId', auth(), operator, async (req: AuthedRequest, res) => {
    const body = parse(decisionSchema, req.body, res);
    if (!body) return;
    if (body.decision === 'reject' && !body.note) return res.status(400).json({ error: 'Give a reason when rejecting, so the organization knows what to fix' });
    if (!(await repo.decideVerification(String(req.params.mosqueId), req.user!.id, body.decision, body.note))) {
      return res.status(409).json({ error: 'This organization is not awaiting review' });
    }
    res.json({ ok: true });
  });

  app.get('/ops/ledger', auth(), operator, async (req, res) => {
    res.json(await repo.recentLedger(req.query.account ? String(req.query.account) : undefined));
  });

  app.get('/ops/reconcile', auth(), operator, async (req, res) => {
    const bankCents = Math.trunc(Number(req.query.bankCents ?? 0)) || 0;
    res.json(await reconcile(repo, payments, bankCents));
  });

  const payoutSchema = z.object({
    mosqueId: z.string(),
    amountCents: z.number().int().positive(),
    method: z.enum(['stripe_transfer', 'ach_manual']),
    reference: z.string().trim().optional(), // e.g. the bank's ACH trace number, for ach_manual
  });

  app.post('/ops/payouts', auth(), operator, async (req, res) => {
    const body = parse(payoutSchema, req.body, res);
    if (!body) return;
    const mosque = await repo.getMosque(body.mosqueId);
    if (!mosque) return res.status(404).json({ error: 'Mosque not found' });
    if (mosque.verificationStatus !== 'verified') return res.status(409).json({ error: 'This organization is not verified.' });
    if (body.method === 'stripe_transfer' && !(mosque.payoutsConnected && mosque.payoutAccountId)) {
      return res.status(409).json({ error: 'This mosque has not finished payout onboarding. Use ach_manual or wait for onboarding.' });
    }
    let payout;
    try {
      payout = await createPayout(repo, mosque.id, body.amountCents, body.method);
    } catch (e) {
      if (e instanceof PayoutError) return res.status(409).json({ error: e.message });
      throw e;
    }
    if (body.method === 'ach_manual') {
      // the operator sends the ACH from the bank; this records that it happened
      await completePayout(repo, payout, body.reference);
      return res.status(201).json(payout);
    }
    try {
      const t = await payments.transfer({ accountId: mosque.payoutAccountId!, amountCents: payout.amountCents, idempotencyKey: `payout-${payout.id}` });
      await completePayout(repo, payout, t.reference);
      res.status(201).json(payout);
    } catch (e) {
      console.error('transfer failed', e);
      await failPayout(repo, payout); // credit the mosque's balance back
      res.status(502).json({ error: 'Transfer failed; the balance was restored.' });
    }
  });

  // Express 5 forwards rejected async handlers here
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) return void res.status(status).json({ error: status === 413 ? 'File too large' : 'Bad request' });
    console.error('unhandled error', err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
