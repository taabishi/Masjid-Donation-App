// On a physical phone or Android emulator, set EXPO_PUBLIC_API_URL to your computer's LAN IP / 10.0.2.2.
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface Cause { id: string; title: string; description: string }
export interface Mosque {
  id: string; name: string; city: string; state: string; address: string; description: string;
  causes: Cause[]; acceptingDonations: boolean; isFavorite: boolean;
}
export interface User { id: string; name: string; email: string; role: 'donor' | 'admin'; mosqueId?: string }
export interface PaymentMethod { id: string; type: 'card' | 'us_bank_account'; label: string }
export interface Donation {
  id: string; mosqueId: string; mosqueName: string; amountCents: number; status: string; recurringId?: string; createdAt: string;
}
export interface Recurring {
  id: string; mosqueId: string; mosqueName: string; amountCents: number; frequency: 'weekly' | 'monthly'; nextDate: string; causeId?: string;
}
export interface AdminReport {
  summary: { totalCents: number; thisMonthCents: number; donationCount: number; activeRecurring: number };
  donations: { id: string; amountCents: number; createdAt: string; recurring: boolean; donorName: string; cause?: string }[];
}

let token: string | null = null;
let onUnauthorized: () => void = () => {};
export const setToken = (t: string | null) => { token = t; };
export const setOnUnauthorized = (fn: () => void) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(message: string, public code?: string) { super(message); }
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
