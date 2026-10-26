/**
 * Lookup of an organization's tax-exempt status by EIN, used to help a human reviewer.
 * It never approves anything on its own: anyone can type someone else's EIN.
 */

export interface NonprofitRecord {
  ein: string; // 9 digits
  name: string;
  city?: string;
  state?: string;
  /** IRS subsection code: 3 means 501(c)(3). */
  subsectionCode?: number;
  nteeCode?: string;
  rulingDate?: string;
}

export interface NonprofitDirectory {
  /** Returns null if the EIN is not in the directory. Throws if the directory can't be reached. */
  lookupEin(ein: string): Promise<NonprofitRecord | null>;
}

export interface EinLookup {
  status: 'found' | 'not_found' | 'unavailable';
  record?: NonprofitRecord;
  /** How the name the applicant typed compares to the directory's name. */
  nameMatch?: 'exact' | 'close' | 'different';
  stateMatch?: boolean;
  is501c3?: boolean;
  checkedAt: string;
}

/** Strip punctuation/spaces; returns the 9 digits, or null if it isn't a plausible EIN. */
export function normalizeEin(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  if (!/^\d{9}$/.test(digits) || /^0+$/.test(digits)) return null;
  return digits;
}

export const formatEin = (ein: string) => `${ein.slice(0, 2)}-${ein.slice(2)}`;

const STOP = new Set(['inc', 'incorporated', 'the', 'of', 'and', 'a', 'corp', 'corporation', 'llc', 'association', 'assn']);
const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !STOP.has(t)),
  );

export function nameMatch(typed: string, official: string): 'exact' | 'close' | 'different' {
  const a = tokens(typed);
  const b = tokens(official);
  if (!a.size || !b.size) return 'different';
  const inter = [...a].filter((t) => b.has(t)).length;
  const jaccard = inter / (a.size + b.size - inter);
  return jaccard === 1 ? 'exact' : jaccard >= 0.5 ? 'close' : 'different';
}

/** Run the directory lookup and compare it with what the applicant typed. Never throws. */
export async function checkEin(dir: NonprofitDirectory, ein: string, legalName: string, state: string, now = new Date()): Promise<EinLookup> {
  const checkedAt = now.toISOString();
  try {
    const record = await dir.lookupEin(ein);
    if (!record) return { status: 'not_found', checkedAt };
    return {
      status: 'found',
      record,
      nameMatch: nameMatch(legalName, record.name),
      stateMatch: !!record.state && record.state.toUpperCase() === state.trim().toUpperCase(),
      is501c3: record.subsectionCode === 3,
      checkedAt,
    };
  } catch (e) {
    console.error('EIN directory lookup failed', e);
    return { status: 'unavailable', checkedAt };
  }
}

/**
 * ProPublica Nonprofit Explorer (data derived from IRS filings). Free, no key.
 * NOTE: the response parsing below follows ProPublica's documented v2 shape
 * (`organization.{ein,name,city,state,subsection_code,ntee_code,ruling_date}`) but has not been run
 * against the live API from this environment. Churches and many small organizations are absent from it.
 */
export class ProPublicaDirectory implements NonprofitDirectory {
  constructor(
    private baseUrl = 'https://projects.propublica.org/nonprofits/api/v2',
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async lookupEin(ein: string): Promise<NonprofitRecord | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/organizations/${ein}.json`, {
      headers: { accept: 'application/json', 'user-agent': 'masjid-donation-box/0.1' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`directory responded ${res.status}`);
    const body = (await res.json()) as { organization?: Record<string, unknown> };
    const o = body.organization;
    if (!o || o.ein == null) return null;
    const sub = Number(o.subsection_code);
    return {
      ein: String(o.ein).padStart(9, '0'),
      name: String(o.name ?? ''),
      city: o.city ? String(o.city) : undefined,
      state: o.state ? String(o.state) : undefined,
      subsectionCode: Number.isFinite(sub) && sub > 0 ? sub : undefined,
      nteeCode: o.ntee_code ? String(o.ntee_code) : undefined,
      rulingDate: o.ruling_date ? String(o.ruling_date) : undefined,
    };
  }
}
