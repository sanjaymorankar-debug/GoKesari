/** Shared helpers and types for the Admin → Franchise console (final brief 21-Nov-2026 §9). */
export type Json = Record<string, unknown>;
export type Act = (fn: () => Promise<unknown>, ok: string) => Promise<void>;
export type Ask = (q: string) => string | null;

export type Tier = "PREMIER" | "STANDARD" | "EMERGING";

export interface AdminZone {
  zoneId: string;
  zoneSetCode: string;
  setName: string;
  clusterNo: number;
  name: string;
  region: string;
  civicBody: string | null;
  reason: string;
  status: string;
  statusLabel: string;
  statusReason: string | null;
  badge: string;
  maxOwners: number;
  occupied: number;
  active: number;
  slotsFree: number;
  reservedForDealerId: string | null;
  reservedUntil: string | null;
  tier: Tier | null;
  tierName: string | null;
  tierColour: string | null;
  diffBp: number;
  vsAverage: string;
  metric: "INDEX" | "ANNUAL_CR" | null;
  value: number | null;
  source: string | null;
  asOf: string | null;
  provisional: boolean;
  feePaise: number | null;
  areas: string[];
  isTest: boolean;
}

export interface StatusHistoryRow {
  id: string;
  zoneId: string;
  oldStatus: string | null;
  newStatus: string;
  reason: string;
  reservedForDealerId: string | null;
  reservedUntil: string | null;
  changedBy: string | null;
  scheduledFor: string | null;
  appliedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

export async function call<T = any>(url: string, method: string, body?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error?.message ?? `${res.status}`);
  return payload as T;
}

/** A `datetime-local` value typed in IST → ISO (UTC); empty → null. */
export const istInputToIso = (v: string): string | null => (v ? new Date(`${v}:00+05:30`).toISOString() : null);

/** ISO → a `datetime-local` value in IST. */
export function isoToIstInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 5.5 * 3_600_000);
  return d.toISOString().slice(0, 16);
}

export const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = {
  AVAILABLE: "success",
  COMING_SOON: "info",
  RESERVED: "warning",
  ON_HOLD: "warning",
  SOLD_OUT: "danger",
  INACTIVE: "neutral",
};
export const COUPON_XLSX = "/api/admin/franchise/coupons?format=xlsx";
