/**
 * Franchise dealer module, Pune PMR area booking (owner brief 20-Nov-2026; docs/franchise/README.md).
 *
 * Pure helpers shared by the server and the screens: zone estimates, IST dates (validity, reminders, tail),
 * amounts, the launch-offer counter and zone geometry. No secrets and no database here — client bundles
 * import this file. Money is in paise, times are Date (UTC instants) shown in IST.
 */

export const IST_OFFSET_MS = 330 * 60 * 1000;

/* ------------------------------------------------------------------ statuses and labels */

/** Zone status (brief 21-Nov-2026 08.06 §5.6). SOLD_OUT is set and cleared by the system only. */
export const ZONE_STATUSES = ["AVAILABLE", "COMING_SOON", "RESERVED", "ON_HOLD", "SOLD_OUT", "INACTIVE"] as const;
export type ZoneStatus = (typeof ZONE_STATUSES)[number];
export const ADMIN_ZONE_STATUSES = ["AVAILABLE", "COMING_SOON", "RESERVED", "ON_HOLD", "INACTIVE"] as const satisfies readonly ZoneStatus[];

export const ZONE_TIERS = ["PREMIER", "STANDARD", "EMERGING"] as const;
export type ZoneTier = (typeof ZONE_TIERS)[number];

/** A coupon's scope: all zones, or any of zone sets / tiers / zones. */
export type CouponScope = { all: true } | { all?: false; zoneSets?: string[]; tiers?: ZoneTier[]; zones?: string[] };

export const ALLOCATION_STATUSES = [
  "RESERVED",
  "PAYMENT_PENDING_VERIFICATION",
  "ACTIVE",
  "SUSPENDED",
  "EXPIRED",
  "TERMINATED",
  "CANCELLED",
  "RESERVATION_EXPIRED",
  "PAYMENT_FAILED",
] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

/** These hold a slot (brief §4.4); every other status frees it. */
export const OCCUPYING_STATUSES = ["RESERVED", "PAYMENT_PENDING_VERIFICATION", "ACTIVE", "SUSPENDED"] as const satisfies readonly AllocationStatus[];

export const ALLOCATION_STATUS_LABELS: Record<AllocationStatus, string> = {
  RESERVED: "Reserved (payment not started)",
  PAYMENT_PENDING_VERIFICATION: "Payment being verified",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  EXPIRED: "Expired",
  TERMINATED: "Terminated",
  CANCELLED: "Cancelled",
  RESERVATION_EXPIRED: "Reservation expired",
  PAYMENT_FAILED: "Payment failed",
};

export const BOOKING_STATUSES = ["RESERVED", "PAYMENT_PENDING", "PAID", "FAILED", "EXPIRED", "CANCELLED", "REFUNDED"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export type ZoneBadge = "AVAILABLE" | "ONE_LEFT" | "COMING_SOON" | "RESERVED" | "ON_HOLD" | "SOLD_OUT" | "INACTIVE";

export const ZONE_BADGE_LABELS: Record<ZoneBadge, string> = {
  AVAILABLE: "Available",
  ONE_LEFT: "1 slot left",
  COMING_SOON: "Coming soon",
  RESERVED: "Reserved",
  ON_HOLD: "Temporarily unavailable",
  SOLD_OUT: "Sold out",
  INACTIVE: "Not available",
};

export const ZONE_STATUS_LABELS: Record<ZoneStatus, string> = {
  AVAILABLE: "Available",
  COMING_SOON: "Coming Soon",
  RESERVED: "Reserved",
  ON_HOLD: "On Hold",
  SOLD_OUT: "Sold Out",
  INACTIVE: "Inactive",
};

/** The badge of a zone card on the booking page (brief §5.6). */
export function zoneBadge(status: ZoneStatus, maxOwners: number, occupied: number): ZoneBadge {
  if (status !== "AVAILABLE") return status;
  const free = Math.max(0, maxOwners - occupied);
  if (free <= 0) return "SOLD_OUT";
  return free === 1 && maxOwners > 1 ? "ONE_LEFT" : "AVAILABLE";
}

export const ESTIMATE_DISCLOSURE =
  "Estimated total business of all shops in the area (merchant GMV), from Gokesari's November 2026 territory estimates. It is not Gokesari's revenue and not a promise of franchise earnings.";

export const ILLUSTRATION_DISCLOSURE = "Illustration, not guaranteed income; excludes GST and TDS.";

export const FRANCHISE_CONTACT_PHONE = "+91 91751 93009";

/* ------------------------------------------------------------------ money */

const INR = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const INR2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ₹1,50,000 (whole rupees) or ₹1,50,000.50 from paise, Indian digit grouping. */
export function rupees(paise: number | bigint | null | undefined): string {
  const p = Number(paise ?? 0);
  const r = p / 100;
  return `₹${Number.isInteger(r) ? INR.format(r) : INR2.format(r)}`;
}

/** "4,914" crore from hundredths of a crore (491400 → "4,914"; 314880 → "3,148.80"). */
export function crore(hundredths: number): string {
  const v = hundredths / 100;
  return Number.isInteger(v) ? INR.format(v) : INR2.format(v);
}

/** GST on a base, rounded to the paisa. */
export function gstOn(basePaise: number, gstRateBp: number): number {
  return Math.round((Math.max(0, basePaise) * Math.max(0, gstRateBp)) / 10_000);
}


/** basis points of an amount, rounded to the paisa. */
export function bpOf(paise: number, bp: number): number {
  return Math.round((Math.max(0, paise) * Math.max(0, bp)) / 10_000);
}

/* ------------------------------------------------------------------ zone estimates */

export interface ZoneEstimateInput {
  estShopCount: number;
  /** ₹ lakh per shop per month, two decimals (e.g. 14.5, 16.4). */
  gmvPerShopLakh: number | string;
}

export interface ZoneEstimate {
  shops: number;
  gmvPerShopLakh: number;
  /** Hundredths of a crore, so 333.50 Cr = 33350 (exact; no float drift). */
  monthlyCrHundredths: number;
  annualCrHundredths: number;
}


/* ------------------------------------------------------------------ zone ids */

const ZONE_ID = /^(\d{1,3})([A-Z]?)(?:-(\d{1,2}))?$/;

/** 1A, 1B, 2A … 70, 66-1 in natural order (brief §4.2). */
export function zoneSortKey(zoneId: string): number {
  const m = ZONE_ID.exec(zoneId.trim().toUpperCase());
  if (!m) return 1_000_000;
  const letter = m[2] ? m[2].charCodeAt(0) - 64 : 0;
  return Number(m[1]) * 10_000 + letter * 100 + (m[3] ? Number(m[3]) : 0);
}

export function compareZoneIds(a: string, b: string): number {
  return zoneSortKey(a) - zoneSortKey(b) || a.localeCompare(b);
}

/* ------------------------------------------------------------------ IST dates */

/** The IST calendar date (YYYY-MM-DD) of an instant. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant of hh:mm:ss IST on a YYYY-MM-DD date. */
export function istInstant(date: string, hh = 0, mm = 0, ss = 0, ms = 0): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss, ms) - IST_OFFSET_MS);
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Adds months to a YYYY-MM-DD date, clamping to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

/** Whole IST calendar days from `from` to `to` (to − from). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The last moment of a validity: 23:59:59 IST of `date`. */
export const endOfIstDay = (date: string) => istInstant(date, 23, 59, 59);

/**
 * Expiry of an allocation activated at `activatedAt` for `months`: activation + months − 1 day, at
 * 23:59:59 IST (brief §4.5 step 7). 20-Nov-2026 14:00 IST + 12 months → 19-Nov-2027 23:59:59 IST.
 */
export function allocationExpiry(activatedAt: Date, months: number): Date {
  return endOfIstDay(addDays(addMonths(istDate(activatedAt), months), -1));
}

/** A renewal extends the same allocation by `months` from its current expiry date (same slot, brief §9.3). */
export function renewedExpiry(currentExpiresAt: Date, months: number): Date {
  return endOfIstDay(addMonths(istDate(currentExpiresAt), months));
}

export type TailMode = "fixed_end_of_year_3" | "years_after_lapse";

/**
 * When recurring commission on the allocation's shops stops for good (brief §9.5).
 * fixed_end_of_year_3: the end of year `tailYears` (default 3) counted from the chain's first activation —
 * never before the allocation itself expires. years_after_lapse: `tailYears` years after the expiry.
 */
export function tailEndAt(input: { chainStartAt: Date; expiresAt: Date; mode: TailMode; tailYears: number }): Date {
  if (input.mode === "years_after_lapse") return endOfIstDay(addMonths(istDate(input.expiresAt), input.tailYears * 12));
  const endOfYearN = allocationExpiry(input.chainStartAt, input.tailYears * 12);
  return endOfYearN.getTime() > input.expiresAt.getTime() ? endOfYearN : input.expiresAt;
}

/** Renewal is open from `windowDays` before expiry up to the expiry moment (brief §9.3). */
export function renewalOpen(expiresAt: Date, now: Date, windowDays: number): boolean {
  if (now.getTime() > expiresAt.getTime()) return false;
  return daysBetween(istDate(now), istDate(expiresAt)) <= windowDays;
}

export type ReminderKind = "D30" | "D15" | "DAILY";

/**
 * The reminder due today for an area expiring at `expiresAt` (brief §9.1): 30 days before, 15 days before,
 * then every day from 14 days before up to and including the expiry day. Null when none is due.
 */
export function reminderDue(expiresAt: Date, now: Date): { kind: ReminderKind; daysLeft: number } | null {
  const daysLeft = daysBetween(istDate(now), istDate(expiresAt));
  if (daysLeft === 30) return { kind: "D30", daysLeft };
  if (daysLeft === 15) return { kind: "D15", daysLeft };
  if (daysLeft >= 0 && daysLeft <= 14) return { kind: "DAILY", daysLeft };
  return null;
}

/** The hour (0–23) in IST of an instant. */
export function istHour(at: Date): number {
  return new Date(at.getTime() + IST_OFFSET_MS).getUTCHours();
}

/** "19-Nov-2027, 23.59 IST" — the owner's report format. */
export function formatIst(at: Date | string | null | undefined, withTime = true): string {
  if (!at) return "—";
  const d = typeof at === "string" ? new Date(at) : at;
  const s = new Date(d.getTime() + IST_OFFSET_MS);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][s.getUTCMonth()];
  const day = `${String(s.getUTCDate()).padStart(2, "0")}-${mon}-${s.getUTCFullYear()}`;
  if (!withTime) return day;
  return `${day}, ${String(s.getUTCHours()).padStart(2, "0")}.${String(s.getUTCMinutes()).padStart(2, "0")} IST`;
}

/** YYYY-MM of an instant in IST. */
export const istMonth = (at: Date) => istDate(at).slice(0, 7);

/** The UTC instants bounding an IST calendar month (start inclusive, end exclusive). */
export function istMonthBounds(month: string): { start: Date; end: Date } {
  const start = istInstant(`${month}-01`);
  const end = istInstant(addMonths(`${month}-01`, 1));
  return { start, end };
}

/** The payout day: the `day`th of the month, moved to the next working day when it is a Sunday or a listed bank holiday. */
export function payoutDate(month: string, day: number, holidays: readonly string[], skipSundays = true): string {
  let d = `${month}-${String(day).padStart(2, "0")}`;
  const off = new Set(holidays);
  for (let i = 0; i < 15; i++) {
    const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (!off.has(d) && !(skipSundays && weekday === 0)) return d;
    d = addDays(d, 1);
  }
  return d;
}

/* ------------------------------------------------------------------ launch offer */

export type LaunchCloseRule = "first_limit_reached" | "owners_only" | "areas_only";

export interface LaunchState {
  open: boolean;
  /** Launch places left for the public counter ("X of 25 launch places left"). */
  placesLeft: number;
  placesTotal: number;
  owners: number;
  areas: number;
}

/** The launch offer (brief §3.1): counted on verified payments; closes on the configured limit. */
export function launchState(input: { owners: number; areas: number; maxOwners: number; maxAreas: number; closeRule: LaunchCloseRule; closedAt?: Date | null }): LaunchState {
  const ownersLeft = Math.max(0, input.maxOwners - input.owners);
  const areasLeft = Math.max(0, input.maxAreas - input.areas);
  const [left, total] =
    input.closeRule === "owners_only"
      ? [ownersLeft, input.maxOwners]
      : input.closeRule === "areas_only"
        ? [areasLeft, input.maxAreas]
        : [Math.min(ownersLeft, areasLeft), Math.min(input.maxOwners, input.maxAreas)];
  return { open: !input.closedAt && left > 0, placesLeft: input.closedAt ? 0 : left, placesTotal: total, owners: input.owners, areas: input.areas };
}

/* ------------------------------------------------------------------ geometry */

export type LatLng = [number, number];

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray casting on [lat, lng] (a zone is a few km across: a flat plane is exact enough). A point on an edge counts as inside. */
export function pointInPolygon(p: LatLng, polygon: readonly LatLng[]): boolean {
  const [y, x] = p;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if (onSegment(p, polygon[i], polygon[j])) return true;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function cross(o: LatLng, a: LatLng, b: LatLng): number {
  return (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
}

function onSegment(p: LatLng, a: LatLng, b: LatLng): boolean {
  return (
    Math.abs(cross(a, b, p)) < 1e-12 &&
    Math.min(a[0], b[0]) - 1e-12 <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) + 1e-12 &&
    Math.min(a[1], b[1]) - 1e-12 <= p[1] &&
    p[1] <= Math.max(a[1], b[1]) + 1e-12
  );
}

/** True when segments ab and cd cross at a point inside both (touching ends do not count). */
export function segmentsCross(a: LatLng, b: LatLng, c: LatLng, d: LatLng): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** A closed ring without its repeated last point. */
export function openRing(polygon: readonly LatLng[]): LatLng[] {
  const ring = polygon.map((p) => [Number(p[0]), Number(p[1])] as LatLng);
  if (ring.length > 1) {
    const [a, b] = [ring[0], ring[ring.length - 1]];
    if (a[0] === b[0] && a[1] === b[1]) ring.pop();
  }
  return ring;
}

/** A circle as a 48-point polygon (for overlap checks and the map). */
export function circlePolygon(center: LatLng, radiusM: number, points = 48): LatLng[] {
  const out: LatLng[] = [];
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos(rad(center[0])));
  for (let i = 0; i < points; i++) {
    const t = (2 * Math.PI * i) / points;
    out.push([center[0] + dLat * Math.sin(t), center[1] + dLng * Math.cos(t)]);
  }
  return out;
}

export interface BoundaryShape {
  shape: "POLYGON" | "CIRCLE";
  polygon?: LatLng[] | null;
  center?: LatLng | null;
  radiusM?: number | null;
}

/** The ring a boundary covers (a circle as a polygon). */
export function boundaryRing(b: BoundaryShape): LatLng[] {
  if (b.shape === "CIRCLE") {
    if (!b.center || !b.radiusM) return [];
    return circlePolygon(b.center, b.radiusM);
  }
  return openRing(b.polygon ?? []);
}

/** Is the point inside the boundary? */
export function boundaryContains(b: BoundaryShape, p: LatLng): boolean {
  if (b.shape === "CIRCLE") return !!b.center && !!b.radiusM && distanceM(b.center, p) <= b.radiusM;
  const ring = openRing(b.polygon ?? []);
  return ring.length >= 3 && pointInPolygon(p, ring);
}

export interface BoundaryCheck {
  ok: boolean;
  errors: string[];
  /** The farthest boundary point from the reference point, metres. */
  maxDistanceM: number;
}

/** Brief §6: at least 3 points, no crossing edges, every point within `maxRadiusKm` of the reference point. */
export function validateBoundary(b: BoundaryShape & { ref: LatLng | null }, maxRadiusKm: number): BoundaryCheck {
  const errors: string[] = [];
  const limit = maxRadiusKm * 1000;
  if (!b.ref) errors.push("Set the zone's reference point first.");
  if (b.shape === "CIRCLE") {
    if (!b.radiusM || b.radiusM <= 0) errors.push("The circle needs a radius.");
    if (b.radiusM && b.radiusM > limit) errors.push(`The radius is ${(b.radiusM / 1000).toFixed(2)} km; the limit is ${maxRadiusKm} km.`);
    const centre = b.center ?? b.ref;
    const max = b.ref && centre ? distanceM(b.ref, centre) + (b.radiusM ?? 0) : b.radiusM ?? 0;
    if (b.ref && centre && max > limit + 1) errors.push(`Part of the circle is ${(max / 1000).toFixed(2)} km from the reference point; the limit is ${maxRadiusKm} km.`);
    return { ok: errors.length === 0, errors, maxDistanceM: Math.round(max) };
  }
  const ring = openRing(b.polygon ?? []);
  if (ring.length < 3) errors.push("A polygon needs at least 3 points.");
  for (const [lat, lng] of ring) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      errors.push("A point is not a valid latitude / longitude.");
      break;
    }
  }
  for (let i = 0; i < ring.length; i++) {
    for (let j = i + 1; j < ring.length; j++) {
      const a1 = ring[i];
      const a2 = ring[(i + 1) % ring.length];
      const b1 = ring[j];
      const b2 = ring[(j + 1) % ring.length];
      if (segmentsCross(a1, a2, b1, b2)) {
        errors.push("The polygon's edges cross each other.");
        i = ring.length;
        break;
      }
    }
  }
  let max = 0;
  if (b.ref) for (const p of ring) max = Math.max(max, distanceM(b.ref, p));
  if (b.ref && max > limit + 1) errors.push(`The farthest point is ${(max / 1000).toFixed(2)} km from the reference point; the limit is ${maxRadiusKm} km.`);
  return { ok: errors.length === 0, errors, maxDistanceM: Math.round(max) };
}

/** Do two rings overlap (share any area)? Touching edges do not count. */
export function ringsOverlap(a: readonly LatLng[], b: readonly LatLng[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  const strictlyInside = (p: LatLng, ring: readonly LatLng[]) => pointInPolygon(p, ring) && !ring.some((_, k) => onSegment(p, ring[k], ring[(k + 1) % ring.length]));
  return a.some((p) => strictlyInside(p, b)) || b.some((p) => strictlyInside(p, a)) || strictlyInside(centroid(a), b) || strictlyInside(centroid(b), a);
}

export function centroid(ring: readonly LatLng[]): LatLng {
  const n = ring.length || 1;
  return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
}

/**
 * Reads boundary polygons from GeoJSON (a FeatureCollection, a Feature or a geometry). Each feature needs
 * `properties.zone_id` (or `zoneId` / `id`). Coordinates in GeoJSON are [lng, lat]; returned as [lat, lng].
 */
export function polygonsFromGeoJson(input: unknown): { zoneId: string; polygon: LatLng[] }[] {
  const out: { zoneId: string; polygon: LatLng[] }[] = [];
  const visit = (node: unknown, zoneId: string | null) => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; features?: unknown[]; geometry?: unknown; properties?: Record<string, unknown>; coordinates?: unknown; id?: unknown };
    if (n.type === "FeatureCollection") return n.features?.forEach((f) => visit(f, null));
    if (n.type === "Feature") {
      const p = n.properties ?? {};
      const id = String(p.zone_id ?? p.zoneId ?? p.ZONE_ID ?? n.id ?? zoneId ?? "").trim().toUpperCase();
      return visit(n.geometry, id || null);
    }
    if (n.type === "Polygon" && zoneId) {
      const ring = (n.coordinates as number[][][] | undefined)?.[0] ?? [];
      out.push({ zoneId, polygon: openRing(ring.map(([lng, lat]) => [lat, lng] as LatLng)) });
    }
    if (n.type === "MultiPolygon" && zoneId) {
      const ring = (n.coordinates as number[][][][] | undefined)?.[0]?.[0] ?? [];
      out.push({ zoneId, polygon: openRing(ring.map(([lng, lat]) => [lat, lng] as LatLng)) });
    }
  };
  visit(input, null);
  return out;
}

/* ------------------------------------------------------------------ codes and agreement */

/** New franchise / Model A codes (brief §2.2, §3.2): prefix + 6 characters of the referral-code alphabet. */
export const PREFIXED_CODE = /^GK[DTAF]-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

export const FRANCHISE_AGREEMENT_VERSION = "2026-11-22";

export const FRANCHISE_AGREEMENT_TEXT = [
  "GoKesari Territory Franchise — responsibilities and rules (version 2026-11-22).",
  "The franchise fee (₹1,50,000 per area per 12 months plus GST during the launch offer) is paid 100% in advance, online only, and is non-refundable, subject to applicable law.",
  "Each area is valid for 12 months from the verified payment. Renewal is manual, at the fee then in force, from 30 days before expiry until 23:59:59 IST on the expiry day; it is never charged automatically. After expiry the area ends, the franchise code stops working for new shops in it, and the slot is released to anyone.",
  "Earnings: one-time, on each activated shop's registration fee (excluding GST): 25% on shops I register myself with my franchise code, and 4% / 3% on shops my team registers in my area (one / two levels below me). Recurring: 20% of GoKesari's actual order commission on completed orders of my area's shops, plus a performance bonus of 0 to 5 percentage points published by GoKesari. These are the rates in force today; GoKesari publishes the current rates on the franchise page and a change applies from the next month. Recurring commission on shops already registered continues until the tail end (end of year 3 from the first activation), then stops. Payout on the 5th of each month after TDS, with a statement. Figures shown by GoKesari are illustrations, not guaranteed income.",
  "Paying before my dealer KYC is approved: the area is booked for me at payment, but it goes live — my franchise code, my team's shops and commission — only once GoKesari approves my dealer KYC and bank account. If they are not complete within 30 days of the payment, GoKesari may refund the fee and release the area.",
  "My responsibilities: onboard shops (GST/PAN, licences, bank details, fee paid in the app only); set shops up (products, prices, photos, stock, orders, wallet, delivery, QR sticker); give first-line support and raise tickets to GoKesari within 24 hours; visit inactive shops; hire, train and pay my own field team; promote GoKesari only with approved material.",
  "I must not: collect money outside the app or in cash, charge shops any extra fee, promise earnings or returns, change GoKesari prices, commit anything on GoKesari's behalf, or use misleading material.",
  "GoKesari provides the platform, payments, training, marketing material, the dashboard, second-level support, monthly statements and the payout on the 5th.",
  "Violations: a warning, then a record on my account, then suspension or termination by GoKesari under this agreement. Every step is logged.",
  "Up to two franchise owners may hold the same area; I will not see the other owner's shops, customers or earnings.",
];
