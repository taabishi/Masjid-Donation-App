// On a physical phone or Android emulator, set EXPO_PUBLIC_API_URL to your computer's LAN IP / 10.0.2.2.
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface Cause { id: string; title: string; description: string }
export interface Mosque {
  id: string; name: string; city: string; state: string; address: string; description: string;
  causes: Cause[]; acceptingDonations: boolean; isFavorite: boolean;
}
export interface User { id: string; name: string; email: string; role: 'donor' | 'admin'; mosqueId?: string; operator?: boolean }
export type VerificationStatus = 'unverified' | 'pending_review' | 'verified' | 'rejected';
export interface EinLookup {
  status: 'found' | 'not_found' | 'unavailable';
  record?: { name: string; city?: string; state?: string; subsectionCode?: number };
  nameMatch?: 'exact' | 'close' | 'different';
  stateMatch?: boolean;
  is501c3?: boolean;
}
export interface Verification {
  status: VerificationStatus; note?: string; ein?: string; legalName?: string; lookup?: EinLookup;
  documents: { id: string; filename: string; createdAt: string }[];
}
export interface ReviewItem {
  mosqueId: string; name: string; city: string; state: string; adminEmail?: string; status: VerificationStatus;
  ein?: string; legalName?: string; lookup?: EinLookup; note?: string; submittedAt?: string;
  documents: { id: string; filename: string; contentType: string; sizeBytes: number }[];
}
export interface PaymentMethod { id: string; type: 'card' | 'us_bank_account'; label: string }
export interface Donation {
  id: string; mosqueId: string; mosqueName: string; amountCents: number; status: string; recurringId?: string; createdAt: string;
}
export interface Recurring {
  id: string; mosqueId: string; mosqueName: string; amountCents: number; frequency: 'weekly' | 'monthly'; nextDate: string; causeId?: string;
}
export interface AdminReport {
  summary: { totalCents: number; thisMonthCents: number; donationCount: number; activeRecurring: number; balanceCents: number };
  payouts: { id: string; amountCents: number; method: 'stripe_transfer' | 'ach_manual'; status: string; createdAt: string }[];
  donations: { id: string; amountCents: number; createdAt: string; recurring: boolean; donorName: string; cause?: string }[];
}

let token: string | null = null;
let onUnauthorized: () => void = () => {};
export const setToken = (t: string | null) => { token = t; };
export const setOnUnauthorized = (fn: () => void) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

/** Upload raw file bytes (e.g. a determination letter). */
export async function upload<T>(path: string, body: Blob, contentType: string, filename: string): Promise<T> {
  const res = await fetch(API_URL + path, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-filename': filename, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(data?.error ?? `Upload failed (${res.status})`, data?.code);
  return data as T;
}

/** Fetch a protected file as a Blob (web only use: open in a new tab). */
export async function downloadBlob(path: string): Promise<Blob> {
  const res = await fetch(API_URL + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(`Download failed (${res.status})`);
  return res.blob();
}

export async function api<T = void>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection.');
  }
  if (res.status === 401 && token) onUnauthorized();
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, data?.code);
  return data as T;
}
