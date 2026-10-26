import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { newId, type Mosque, type Role, type Store, type User } from './store.js';
import type { PaymentProvider } from './payments.js';

const MIN_CENTS = 100; // $1
const MAX_CENTS = 1_000_000; // $10,000

interface AuthedRequest extends Request {
  user?: User;
}

export function createApp(store: Store, payments: PaymentProvider, jwtSecret: string) {
  const app = express();
  app.use(cors());
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

  // ---------- donations ----------
  const amountSchema = z.number().int().min(MIN_CENTS).max(MAX_CENTS);
  const donationSchema = z.object({ mosqueId: z.string(), amountCents: amountSchema, causeId: z.string().optional() });

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
    const result = await payments.charge({ amountCents: body.amountCents, donor: req.user!, mosque, description: `Donation to ${mosque.name}` });
    const donation = {
      id: newId(),
      userId: req.user!.id,
      mosqueId: mosque.id,
      causeId: body.causeId,
      amountCents: body.amountCents,
      status: result.ok ? ('succeeded' as const) : ('failed' as const),
      paymentRef: result.reference,
      createdAt: new Date().toISOString(),
    };
    d().donations.push(donation);
    store.save();
    if (!result.ok) return res.status(402).json({ error: result.error ?? 'Payment failed' });
    res.status(201).json(donation);
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
  });

  const recurringView = (r: ReturnType<typeof d>['recurring'][number]) => ({
    ...r,
    mosqueName: d().mosques.find((m) => m.id === r.mosqueId)?.name ?? 'Unknown',
  });

  app.post('/recurring', auth(), (req: AuthedRequest, res) => {
    const body = parse(recurringSchema, req.body, res);
    if (!body) return;
    if (!checkTarget(body.mosqueId, body.causeId, res)) return;
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

  app.get('/admin/mosque', auth('admin'), (req: AuthedRequest, res) => {
    const m = adminMosque(req);
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

  app.post('/admin/payouts/connect', auth('admin'), async (req: AuthedRequest, res) => {
    const m = adminMosque(req);
    m.payoutAccountId = await payments.connectMosque(m);
    m.payoutsConnected = true;
    store.save();
    res.json({ payoutsConnected: true });
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
