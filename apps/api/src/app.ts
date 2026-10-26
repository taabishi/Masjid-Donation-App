import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { newId, type Mosque, type Role, type Store, type User } from './store.js';
import type { PaymentProvider } from './payments.js';
import { chargeDonation } from './donate.js';

const MIN_CENTS = 100; // $1
const MAX_CENTS = 1_000_000; // $10,000

interface AuthedRequest extends Request {
  user?: User;
}

export interface AppOptions {
  /** Public base URL of this API, used for hosted-page return links. */
  apiPublicUrl: string;
  /** URL prefixes the return page may redirect back to (web app origin, native deep-link schemes). */
  allowedReturnPrefixes: string[];
}

export function createApp(store: Store, payments: PaymentProvider, jwtSecret: string, opts: AppOptions = { apiPublicUrl: 'http://localhost:4000', allowedReturnPrefixes: ['http://localhost:8081', 'masjiddonation://', 'exp://'] }) {
  const app = express();
  app.use(cors());

  // Stripe signs the raw body, so this must be registered before express.json().
  app.post('/webhooks/payments', express.raw({ type: '*/*' }), (req, res) => {
    let event;
    try {
      event = payments.parseWebhook(req.body as Buffer, req.headers['stripe-signature'] as string | undefined);
    } catch {
      return res.status(400).json({ error: 'Invalid webhook' });
    }
    if (event.kind === 'payment') {
      const don = store.data.donations.find((x) => x.paymentRef === event.reference);
      if (don && don.status !== event.status) {
        don.status = event.status;
        store.save();
      }
    } else if (event.kind === 'account') {
      const m = store.data.mosques.find((x) => x.payoutAccountId === event.accountId);
      if (m && m.payoutsConnected !== event.ready) {
        m.payoutsConnected = event.ready;
        store.save();
      }
    }
    res.json({ received: true });
  });

  app.use(express.json());

  const d = () => store.data;
  const publicUser = (u: User) => ({ id: u.id, name: u.name, email: u.email, role: u.role, mosqueId: u.mosqueId });
  const sign = (u: User) => jwt.sign({ sub: u.id }, jwtSecret, { expiresIn: '30d' });

  const auth = (role?: Role) => (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not signed in' });
    try {
      const payload = jwt.verify(header.slice(7), jwtSecret) as { sub: string };
      const user = d().users.find((u) => u.id === payload.sub);
      if (!user) return res.status(401).json({ error: 'Not signed in' });
      if (role && user.role !== role) return res.status(403).json({ error: 'Not allowed' });
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: 'Not signed in' });
    }
  };

  const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown, res: Response): z.infer<T> | undefined => {
    const r = schema.safeParse(body);
    if (!r.success) {
      res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
      return undefined;
    }
    return r.data;
  };

  const mosqueView = (m: Mosque, userId?: string) => ({
    id: m.id,
    name: m.name,
    city: m.city,
    state: m.state,
    address: m.address,
    description: m.description,
    causes: m.causes,
    acceptingDonations: m.payoutsConnected,
    isFavorite: userId ? d().favorites.some((f) => f.userId === userId && f.mosqueId === m.id) : false,
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
    if (d().users.some((u) => u.email === body.email)) return res.status(409).json({ error: 'Email already registered' });
    const user: User = {
      id: newId(),
      name: body.name,
      email: body.email,
      passwordHash: await bcrypt.hash(body.password, 10),
      role: body.mosque ? 'admin' : 'donor',
    };
    if (body.mosque) {
      const mosque: Mosque = {
        id: newId(),
        ...body.mosque,
        causes: [{ id: newId(), title: 'General Fund', description: 'Day-to-day operations and upkeep.' }],
        payoutsConnected: false,
      };
      d().mosques.push(mosque);
      user.mosqueId = mosque.id;
    }
    d().users.push(user);
    store.save();
    res.status(201).json({ token: sign(user), user: publicUser(user) });
  });

  app.post('/auth/login', async (req, res) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string() }), req.body, res);
    if (!body) return;
    const user = d().users.find((u) => u.email === body.email);
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) return res.status(401).json({ error: 'Invalid email or password' });
    res.json({ token: sign(user), user: publicUser(user) });
  });

  app.get('/me', auth(), (req: AuthedRequest, res) => res.json(publicUser(req.user!)));

  // ---------- browsing mosques (donor) ----------
  app.get('/mosques', auth(), (req: AuthedRequest, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const list = d().mosques.filter((m) => !q || [m.name, m.city, m.state].some((s) => s.toLowerCase().includes(q)));
    res.json(list.map((m) => mosqueView(m, req.user!.id)));
  });

  app.get('/mosques/:id', auth(), (req: AuthedRequest, res) => {
    const m = d().mosques.find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'Mosque not found' });
    res.json(mosqueView(m, req.user!.id));
  });

  // ---------- favorites ----------
  app.get('/favorites', auth(), (req: AuthedRequest, res) => {
    const ids = d().favorites.filter((f) => f.userId === req.user!.id).map((f) => f.mosqueId);
    res.json(d().mosques.filter((m) => ids.includes(m.id)).map((m) => mosqueView(m, req.user!.id)));
  });

  app.put('/favorites/:mosqueId', auth(), (req: AuthedRequest, res) => {
    const mosqueId = String(req.params.mosqueId);
    if (!d().mosques.some((m) => m.id === mosqueId)) return res.status(404).json({ error: 'Mosque not found' });
    if (!d().favorites.some((f) => f.userId === req.user!.id && f.mosqueId === mosqueId)) {
      d().favorites.push({ userId: req.user!.id, mosqueId });
      store.save();
    }
    res.status(204).end();
  });

  app.delete('/favorites/:mosqueId', auth(), (req: AuthedRequest, res) => {
    d().favorites = d().favorites.filter((f) => !(f.userId === req.user!.id && f.mosqueId === req.params.mosqueId));
    store.save();
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
    if (!user.paymentCustomerId) {
      user.paymentCustomerId = await payments.createCustomer(user);
      store.save();
    }
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
    // schedules that used this method fall back to the donor's next saved method
    for (const r of d().recurring) if (r.userId === req.user!.id && r.paymentMethodId === req.params.id) r.paymentMethodId = undefined;
    store.save();
    res.status(204).end();
  });

  // ---------- donations ----------
  const amountSchema = z.number().int().min(MIN_CENTS).max(MAX_CENTS);
  const donationSchema = z.object({ mosqueId: z.string(), amountCents: amountSchema, causeId: z.string().optional(), paymentMethodId: z.string().optional() });

  const checkTarget = (mosqueId: string, causeId: string | undefined, res: Response) => {
    const mosque = d().mosques.find((m) => m.id === mosqueId);
    if (!mosque) return void res.status(404).json({ error: 'Mosque not found' });
    if (!mosque.payoutsConnected) return void res.status(409).json({ error: 'This mosque is not accepting donations yet' });
    if (causeId && !mosque.causes.some((c) => c.id === causeId)) return void res.status(400).json({ error: 'Unknown cause' });
    return mosque;
  };

  app.post('/donations', auth(), async (req: AuthedRequest, res) => {
    const body = parse(donationSchema, req.body, res);
    if (!body) return;
    const mosque = checkTarget(body.mosqueId, body.causeId, res);
    if (!mosque) return;
    try {
      // a fresh key per request: donors may legitimately give the same amount twice
      const out = await chargeDonation(store, payments, { user: req.user!, mosque, ...body, idempotencyKey: `don-${newId()}` });
      if (!out.ok) return res.status(out.code === 'no_payment_method' ? 409 : 402).json({ error: out.error, code: out.code });
      res.status(201).json(out.donation);
    } catch (e) {
      console.error('payment provider error', e);
      res.status(502).json({ error: 'Payment service is unavailable. You were not charged.' });
    }
  });

  app.get('/donations', auth(), (req: AuthedRequest, res) => {
    const list = d()
      .donations.filter((x) => x.userId === req.user!.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((x) => ({ ...x, mosqueName: d().mosques.find((m) => m.id === x.mosqueId)?.name ?? 'Unknown' }));
    res.json(list);
  });

  // ---------- recurring ----------
  const recurringSchema = z.object({
    mosqueId: z.string(),
    amountCents: amountSchema,
    frequency: z.enum(['weekly', 'monthly']),
    causeId: z.string().optional(),
    paymentMethodId: z.string().optional(),
  });

  const recurringView = (r: ReturnType<typeof d>['recurring'][number]) => ({
    ...r,
    mosqueName: d().mosques.find((m) => m.id === r.mosqueId)?.name ?? 'Unknown',
  });

  app.post('/recurring', auth(), async (req: AuthedRequest, res) => {
    const body = parse(recurringSchema, req.body, res);
    if (!body) return;
    if (!checkTarget(body.mosqueId, body.causeId, res)) return;
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
    d().recurring.push(r);
    store.save();
    res.status(201).json(recurringView(r));
  });

  app.get('/recurring', auth(), (req: AuthedRequest, res) => {
    res.json(d().recurring.filter((r) => r.userId === req.user!.id && r.active).map(recurringView));
  });

  app.delete('/recurring/:id', auth(), (req: AuthedRequest, res) => {
    const r = d().recurring.find((x) => x.id === req.params.id && x.userId === req.user!.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    r.active = false;
    store.save();
    res.status(204).end();
  });

  // ---------- admin (mosque) ----------
  const adminMosque = (req: AuthedRequest) => d().mosques.find((m) => m.id === req.user!.mosqueId)!;

  app.get('/admin/mosque', auth('admin'), async (req: AuthedRequest, res) => {
    const m = adminMosque(req);
    // pick up onboarding finished on the provider's hosted page (webhooks may lag or be unconfigured)
    if (!m.payoutsConnected && m.payoutAccountId) {
      try {
        m.payoutsConnected = await payments.isMosqueReady(m.payoutAccountId);
        store.save();
      } catch (e) {
        console.error('payout status check failed', e);
      }
    }
    res.json({ ...mosqueView(m), payoutsConnected: m.payoutsConnected });
  });

  app.put('/admin/mosque', auth('admin'), (req: AuthedRequest, res) => {
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
    Object.assign(adminMosque(req), body);
    store.save();
    res.json(mosqueView(adminMosque(req)));
  });

  // Returns { url } for the provider's hosted onboarding page, or { url: null, payoutsConnected: true } when no onboarding is needed.
  app.post('/admin/payouts/connect', auth('admin'), async (req: AuthedRequest, res) => {
    const body = parse(returnSchema, req.body, res);
    if (!body) return;
    const m = adminMosque(req);
    const step = await payments.beginMosqueOnboarding(m, returnLink(body.returnUrl));
    m.payoutAccountId = step.accountId;
    if (!step.url) m.payoutsConnected = await payments.isMosqueReady(step.accountId);
    store.save();
    res.json({ url: step.url, payoutsConnected: m.payoutsConnected });
  });

  const causeSchema = z.object({ title: z.string().trim().min(1), description: z.string().trim().default('') });

  app.post('/admin/causes', auth('admin'), (req: AuthedRequest, res) => {
    const body = parse(causeSchema, req.body, res);
    if (!body) return;
    const cause = { id: newId(), ...body };
    adminMosque(req).causes.push(cause);
    store.save();
    res.status(201).json(cause);
  });

  app.put('/admin/causes/:id', auth('admin'), (req: AuthedRequest, res) => {
    const body = parse(causeSchema, req.body, res);
    if (!body) return;
    const cause = adminMosque(req).causes.find((c) => c.id === req.params.id);
    if (!cause) return res.status(404).json({ error: 'Not found' });
    Object.assign(cause, body);
    store.save();
    res.json(cause);
  });

  app.delete('/admin/causes/:id', auth('admin'), (req: AuthedRequest, res) => {
    const m = adminMosque(req);
    m.causes = m.causes.filter((c) => c.id !== req.params.id);
    store.save();
    res.status(204).end();
  });

  app.get('/admin/donations', auth('admin'), (req: AuthedRequest, res) => {
    const m = adminMosque(req);
    const all = d().donations.filter((x) => x.mosqueId === m.id && x.status === 'succeeded');
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const sum = (xs: typeof all) => xs.reduce((s, x) => s + x.amountCents, 0);
    res.json({
      summary: {
        totalCents: sum(all),
        thisMonthCents: sum(all.filter((x) => x.createdAt >= monthStart)),
        donationCount: all.length,
        activeRecurring: d().recurring.filter((r) => r.mosqueId === m.id && r.active).length,
      },
      // donor names are shown to the mosque admin; email is intentionally not exposed
      donations: all
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100)
        .map((x) => ({
          id: x.id,
          amountCents: x.amountCents,
          createdAt: x.createdAt,
          recurring: !!x.recurringId,
          donorName: d().users.find((u) => u.id === x.userId)?.name ?? 'Anonymous',
          cause: m.causes.find((c) => c.id === x.causeId)?.title,
        })),
    });
  });

  return app;
}
