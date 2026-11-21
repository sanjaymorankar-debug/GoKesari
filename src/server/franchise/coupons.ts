/**
 * Coupon codes on franchise fees (owner's final brief 21-Nov-2026 §5.7). Admin-only management; one coupon per
 * order; the discount comes off the zone fees before GST and never changes a commission. A use is HELD at checkout,
 * USED when the payment succeeds and RELEASED when it fails, times out or the booking is fully refunded. Validated
 * on the server at checkout and again when the payment is started.
 */
import ExcelJS from "exceljs";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { formatIst, type CouponScope, type ZoneTier } from "@/lib/franchise";
import { couponDiscounts, inScope, normaliseCouponCode, type CartLine } from "@/lib/franchise-zones";
import { db, type DbClient } from "@/server/db";
import {
  dealers,
  franchiseAllocations,
  franchiseBookings,
  franchiseCouponAssignments,
  franchiseCouponRedemptions,
  franchiseCoupons,
  users,
  type FranchiseCoupon,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

interface Actor {
  id: string;
  role: UserRole;
}

export interface CouponInput {
  code: string;
  name: string;
  note?: string | null;
  discountType: "PERCENT" | "FLAT";
  /** % coupons: basis points (1000 = 10%). */
  percentBp?: number | null;
  flatPaise?: number | null;
  maxDiscountPaise?: number | null;
  scope: CouponScope;
  appliesOn: "NEW" | "RENEWAL" | "BOTH";
  visibility: "PUBLIC" | "PRIVATE";
  startsAt: Date;
  endsAt: Date;
  totalLimit?: number | null;
  perDealerLimit?: number | null;
  minCartPaise?: number | null;
  firstPurchaseOnly?: boolean;
  launchOnly?: boolean;
}

const requireAdmin = (actor: Actor) => {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can manage franchise coupons.");
};

function clean(input: CouponInput) {
  const code = normaliseCouponCode(input.code);
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw validationFailed("The code is 3–30 letters, digits, - or _.");
  if (!input.name?.trim()) throw validationFailed("Give the coupon a name.");
  if (input.discountType === "PERCENT" && !(Number.isInteger(input.percentBp) && input.percentBp! >= 1 && input.percentBp! <= 10_000)) throw validationFailed("A % coupon needs a value between 0.01% and 100%.");
  if (input.discountType === "FLAT" && !(Number.isInteger(input.flatPaise) && input.flatPaise! > 0)) throw validationFailed("A flat coupon needs an amount.");
  if (!(input.endsAt.getTime() > input.startsAt.getTime())) throw validationFailed("The end must be after the start.");
  const scope: CouponScope = input.scope.all ? { all: true } : { zoneSets: input.scope.zoneSets ?? [], tiers: input.scope.tiers ?? [], zones: input.scope.zones ?? [] };
  if (!scope.all && !(scope.zoneSets?.length || scope.tiers?.length || scope.zones?.length)) throw validationFailed("Choose where the coupon applies: all zones, or zone sets / tiers / zones.");
  const pos = (n: number | null | undefined) => (n == null ? null : Math.max(1, Math.trunc(n)));
  return {
    code,
    name: input.name.trim().slice(0, 100),
    note: input.note?.trim().slice(0, 500) || null,
    discountType: input.discountType,
    percentBp: input.discountType === "PERCENT" ? input.percentBp! : null,
    flatPaise: input.discountType === "FLAT" ? input.flatPaise! : null,
    maxDiscountPaise: input.discountType === "PERCENT" ? pos(input.maxDiscountPaise) : null,
    scope,
    appliesOn: input.appliesOn,
    visibility: input.visibility,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    totalLimit: pos(input.totalLimit),
    perDealerLimit: pos(input.perDealerLimit),
    minCartPaise: input.minCartPaise == null ? null : Math.max(0, Math.trunc(input.minCartPaise)),
    firstPurchaseOnly: !!input.firstPurchaseOnly,
    launchOnly: !!input.launchOnly,
  };
}

export async function createCoupon(input: CouponInput, actor: Actor): Promise<FranchiseCoupon> {
  requireAdmin(actor);
  const values = clean(input);
  const [dup] = await db.select({ id: franchiseCoupons.id }).from(franchiseCoupons).where(sql`lower(${franchiseCoupons.code}) = lower(${values.code})`);
  if (dup) throw conflict(`The code ${values.code} already exists.`);
  const [row] = await db.insert(franchiseCoupons).values({ ...values, createdBy: actor.id }).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_CONFIG_CHANGED, entityType: "franchise_coupon", entityId: row.id, newValue: values });
  return row;
}

export async function updateCoupon(id: string, input: CouponInput, actor: Actor): Promise<FranchiseCoupon> {
  requireAdmin(actor);
  const values = clean(input);
  const [before] = await db.select().from(franchiseCoupons).where(eq(franchiseCoupons.id, id));
  if (!before) throw notFound("Coupon");
  if (before.code !== values.code) {
    const [used] = await db.select({ id: franchiseCouponRedemptions.id }).from(franchiseCouponRedemptions).where(eq(franchiseCouponRedemptions.couponId, id)).limit(1);
    if (used) throw conflict("A coupon that has been used keeps its code.");
  }
  const [row] = await db.update(franchiseCoupons).set({ ...values, updatedAt: new Date() }).where(eq(franchiseCoupons.id, id)).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_CONFIG_CHANGED, entityType: "franchise_coupon", entityId: id, previousValue: before as unknown as Record<string, unknown>, newValue: values });
  return row;
}

export async function setCouponPaused(id: string, paused: boolean, actor: Actor): Promise<void> {
  requireAdmin(actor);
  const rows = await db.update(franchiseCoupons).set({ status: paused ? "PAUSED" : "ACTIVE", updatedAt: new Date() }).where(eq(franchiseCoupons.id, id)).returning();
  if (!rows.length) throw notFound("Coupon");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_CONFIG_CHANGED, entityType: "franchise_coupon", entityId: id, newValue: { status: paused ? "PAUSED" : "ACTIVE" } });
}

/** Assigns a private coupon to dealers by dealer code / mobile / e-mail (one per line). */
export async function assignCoupon(id: string, who: { dealerId?: string; mobileE164?: string; email?: string }[], actor: Actor): Promise<number> {
  requireAdmin(actor);
  const [c] = await db.select().from(franchiseCoupons).where(eq(franchiseCoupons.id, id));
  if (!c) throw notFound("Coupon");
  let added = 0;
  for (const w of who) {
    const one = { dealerId: w.dealerId ?? null, mobileE164: w.mobileE164?.trim() || null, email: w.email?.trim().toLowerCase() || null };
    if ([one.dealerId, one.mobileE164, one.email].filter(Boolean).length !== 1) continue;
    await db.insert(franchiseCouponAssignments).values({ couponId: id, ...one, createdBy: actor.id });
    added++;
  }
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_CONFIG_CHANGED, entityType: "franchise_coupon", entityId: id, newValue: { assigned: added } });
  return added;
}

export async function removeAssignment(assignmentId: string, actor: Actor): Promise<void> {
  requireAdmin(actor);
  await db.delete(franchiseCouponAssignments).where(eq(franchiseCouponAssignments.id, assignmentId));
}

/* ================================================================ checking a code */

/** Uses that count against the limits: USED, and HELD ones whose hold has not run out. */
async function usesOf(client: DbClient, couponId: string, dealerId?: string): Promise<number> {
  const [r] = await client
    .select({ n: sql<number>`count(*)::int` })
    .from(franchiseCouponRedemptions)
    .where(and(eq(franchiseCouponRedemptions.couponId, couponId), dealerId ? eq(franchiseCouponRedemptions.ownerDealerId, dealerId) : undefined, or(eq(franchiseCouponRedemptions.status, "USED"), and(eq(franchiseCouponRedemptions.status, "HELD"), gt(franchiseCouponRedemptions.heldUntil, new Date())))));
  return Number(r?.n ?? 0);
}

/** Expired = past its end date, or every use taken (§5.7: automatic). */
export async function couponState(c: FranchiseCoupon, now: Date = new Date(), client: DbClient = db): Promise<"ACTIVE" | "PAUSED" | "EXPIRED" | "SCHEDULED"> {
  if (c.status === "PAUSED") return "PAUSED";
  if (c.endsAt.getTime() <= now.getTime()) return "EXPIRED";
  if (c.totalLimit != null && (await usesOf(client, c.id)) >= c.totalLimit) return "EXPIRED";
  if (c.startsAt.getTime() > now.getTime()) return "SCHEDULED";
  return "ACTIVE";
}

export interface CouponCheck {
  coupon: FranchiseCoupon;
  /** Per cart line (same order), before GST. */
  discounts: number[];
  totalDiscountPaise: number;
}

/**
 * Validates `code` for this dealer and cart (§5.7) and works out the discount. Throws a clear reason when it is
 * rejected: expired, paused, not valid for these zones, limit reached, not assigned to you, minimum value not met,
 * first purchase only, launch dealers only, not for renewals / new purchases.
 */
export async function checkCoupon(
  code: string,
  ctx: { dealerId: string; kind: "NEW" | "RENEWAL"; lines: CartLine[]; launchEligible: boolean; excludeBookingId?: string | null; now?: Date },
  client: DbClient = db,
): Promise<CouponCheck> {
  const now = ctx.now ?? new Date();
  const norm = normaliseCouponCode(code);
  const [c] = await client.select().from(franchiseCoupons).where(sql`lower(${franchiseCoupons.code}) = lower(${norm})`);
  if (!c) throw validationFailed(`Coupon ${norm} does not exist.`);
  if (c.status === "PAUSED") throw validationFailed(`Coupon ${norm} is paused.`);
  if (c.startsAt.getTime() > now.getTime()) throw validationFailed(`Coupon ${norm} starts on ${formatIst(c.startsAt)}.`);
  if (c.endsAt.getTime() <= now.getTime()) throw validationFailed(`Coupon ${norm} expired on ${formatIst(c.endsAt)}.`);
  if (c.appliesOn !== "BOTH" && c.appliesOn !== ctx.kind) throw validationFailed(c.appliesOn === "NEW" ? `Coupon ${norm} is for new purchases only, not renewals.` : `Coupon ${norm} is for renewals only.`);
  if (c.visibility === "PRIVATE" && !(await assignedTo(client, c.id, ctx.dealerId))) throw validationFailed(`Coupon ${norm} is not assigned to you.`);
  if (c.launchOnly && !ctx.launchEligible) throw validationFailed(`Coupon ${norm} is only for the first 25 launch-offer dealers.`);
  if (c.firstPurchaseOnly) {
    const [had] = await client.select({ id: franchiseAllocations.id }).from(franchiseAllocations).where(and(eq(franchiseAllocations.ownerDealerId, ctx.dealerId), inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED", "EXPIRED", "TERMINATED"]))).limit(1);
    if (had || ctx.kind === "RENEWAL") throw validationFailed(`Coupon ${norm} is for a first franchise purchase only.`);
  }
  // A use held by this very booking (re-validation at payment) does not count against it.
  const own = ctx.excludeBookingId ? await client.select({ id: franchiseCouponRedemptions.id }).from(franchiseCouponRedemptions).where(and(eq(franchiseCouponRedemptions.bookingId, ctx.excludeBookingId), eq(franchiseCouponRedemptions.couponId, c.id), eq(franchiseCouponRedemptions.status, "HELD"))) : [];
  const mine = own.length;
  if (c.totalLimit != null && (await usesOf(client, c.id)) - mine >= c.totalLimit) throw validationFailed(`Coupon ${norm} has reached its limit of uses.`);
  if (c.perDealerLimit != null && (await usesOf(client, c.id, ctx.dealerId)) - mine >= c.perDealerLimit) throw validationFailed(`You have already used coupon ${norm} the most times allowed.`);
  const eligible = ctx.lines.filter((l) => inScope(c.scope, l));
  if (!eligible.length) throw validationFailed(`Coupon ${norm} is not valid for ${ctx.lines.length === 1 ? "this zone" : "these zones"}.`);
  const list = ctx.lines.reduce((s, l) => s + l.listPaise, 0);
  if (c.minCartPaise != null && list < c.minCartPaise) throw validationFailed(`Coupon ${norm} needs a cart of at least ₹${Math.round(c.minCartPaise / 100).toLocaleString("en-IN")} before GST.`);
  const discounts = couponDiscounts({ discountType: c.discountType, percentBp: c.percentBp, flatPaise: c.flatPaise == null ? null : Number(c.flatPaise), maxDiscountPaise: c.maxDiscountPaise == null ? null : Number(c.maxDiscountPaise), scope: c.scope }, ctx.lines);
  return { coupon: c, discounts, totalDiscountPaise: discounts.reduce((s, v) => s + v, 0) };
}

async function assignedTo(client: DbClient, couponId: string, dealerId: string): Promise<boolean> {
  const [d] = await client.select({ id: dealers.id, phone: dealers.mobileE164, email: users.email, userPhone: users.phone }).from(dealers).leftJoin(users, eq(users.id, dealers.userId)).where(eq(dealers.id, dealerId));
  if (!d) return false;
  const rows = await client.select().from(franchiseCouponAssignments).where(eq(franchiseCouponAssignments.couponId, couponId));
  const phones = [d.phone, d.userPhone].filter(Boolean) as string[];
  return rows.some((r) => r.dealerId === dealerId || (r.mobileE164 && phones.includes(r.mobileE164)) || (r.email && d.email && r.email.toLowerCase() === d.email.toLowerCase()));
}

/** Holds a use for a booking until `heldUntil` (replaces any earlier hold of the same booking). */
export async function holdRedemption(client: DbClient, input: { couponId: string; dealerId: string; bookingId: string; discountPaise: number; heldUntil: Date }): Promise<void> {
  await client.delete(franchiseCouponRedemptions).where(and(eq(franchiseCouponRedemptions.bookingId, input.bookingId), eq(franchiseCouponRedemptions.status, "HELD")));
  await client.insert(franchiseCouponRedemptions).values({ couponId: input.couponId, ownerDealerId: input.dealerId, bookingId: input.bookingId, discountPaise: input.discountPaise, heldUntil: input.heldUntil, status: "HELD" });
}

export async function extendHold(client: DbClient, bookingId: string, heldUntil: Date): Promise<void> {
  await client.update(franchiseCouponRedemptions).set({ heldUntil }).where(and(eq(franchiseCouponRedemptions.bookingId, bookingId), eq(franchiseCouponRedemptions.status, "HELD")));
}

/** Payment succeeded: the use counts. */
export async function markRedemptionUsed(client: DbClient, bookingId: string, at: Date = new Date()): Promise<void> {
  await client.update(franchiseCouponRedemptions).set({ status: "USED", usedAt: at }).where(and(eq(franchiseCouponRedemptions.bookingId, bookingId), sql`${franchiseCouponRedemptions.status} <> 'RELEASED'`));
}

/** Payment failed / timed out / booking cancelled / fully refunded: the use is released. */
export async function releaseRedemption(client: DbClient, bookingId: string, reason: string, at: Date = new Date()): Promise<void> {
  await client.update(franchiseCouponRedemptions).set({ status: "RELEASED", releasedAt: at, releaseReason: reason.slice(0, 200) }).where(and(eq(franchiseCouponRedemptions.bookingId, bookingId), sql`${franchiseCouponRedemptions.status} <> 'RELEASED'`));
}

/* ================================================================ admin views and report */

export interface CouponRow {
  coupon: FranchiseCoupon;
  state: "ACTIVE" | "PAUSED" | "EXPIRED" | "SCHEDULED";
  uses: number;
  dealers: number;
  discountPaise: number;
  revenueAfterDiscountPaise: number;
  assignments: { id: string; dealerId: string | null; mobileE164: string | null; email: string | null }[];
}

export async function listCoupons(): Promise<CouponRow[]> {
  const coupons = await db.select().from(franchiseCoupons).orderBy(desc(franchiseCoupons.createdAt));
  if (!coupons.length) return [];
  const ids = coupons.map((c) => c.id);
  const [used, assignments] = await Promise.all([
    db
      .select({ couponId: franchiseCouponRedemptions.couponId, dealerId: franchiseCouponRedemptions.ownerDealerId, discount: franchiseCouponRedemptions.discountPaise, base: franchiseBookings.basePaise })
      .from(franchiseCouponRedemptions)
      .innerJoin(franchiseBookings, eq(franchiseBookings.id, franchiseCouponRedemptions.bookingId))
      .where(and(inArray(franchiseCouponRedemptions.couponId, ids), eq(franchiseCouponRedemptions.status, "USED"))),
    db.select().from(franchiseCouponAssignments).where(inArray(franchiseCouponAssignments.couponId, ids)),
  ]);
  const out: CouponRow[] = [];
  for (const c of coupons) {
    const u = used.filter((r) => r.couponId === c.id);
    out.push({
      coupon: c,
      state: await couponState(c),
      uses: u.length,
      dealers: new Set(u.map((r) => r.dealerId)).size,
      discountPaise: u.reduce((s, r) => s + Number(r.discount), 0),
      revenueAfterDiscountPaise: u.reduce((s, r) => s + Number(r.base), 0),
      assignments: assignments.filter((a) => a.couponId === c.id).map((a) => ({ id: a.id, dealerId: a.dealerId, mobileE164: a.mobileE164, email: a.email })),
    });
  }
  return out;
}

export interface CouponUseRow {
  code: string;
  dealer: string;
  bookingId: string;
  kind: string;
  zones: string;
  listPaise: number;
  discountPaise: number;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  usedAt: Date | null;
}

/** Every successful use (§5.7 report): dealer, zones, discount given and revenue after discount. */
export async function couponUses(couponId?: string): Promise<CouponUseRow[]> {
  const rows = await db
    .select({ r: franchiseCouponRedemptions, b: franchiseBookings, code: franchiseCoupons.code, dealer: dealers.legalName })
    .from(franchiseCouponRedemptions)
    .innerJoin(franchiseBookings, eq(franchiseBookings.id, franchiseCouponRedemptions.bookingId))
    .innerJoin(franchiseCoupons, eq(franchiseCoupons.id, franchiseCouponRedemptions.couponId))
    .innerJoin(dealers, eq(dealers.id, franchiseCouponRedemptions.ownerDealerId))
    .where(and(eq(franchiseCouponRedemptions.status, "USED"), couponId ? eq(franchiseCouponRedemptions.couponId, couponId) : undefined))
    .orderBy(desc(franchiseCouponRedemptions.usedAt));
  const bookingIds = rows.map((r) => r.b.id);
  const allocs = bookingIds.length ? await db.select({ bookingId: franchiseAllocations.bookingId, zoneId: franchiseAllocations.zoneId }).from(franchiseAllocations).where(inArray(franchiseAllocations.bookingId, bookingIds)) : [];
  return rows.map(({ r, b, code, dealer }) => ({
    code,
    dealer,
    bookingId: b.id,
    kind: b.kind,
    zones: allocs.filter((a) => a.bookingId === b.id).map((a) => a.zoneId).join(", "),
    listPaise: Number(b.listPaise),
    discountPaise: Number(r.discountPaise),
    basePaise: Number(b.basePaise),
    gstPaise: Number(b.gstPaise),
    totalPaise: Number(b.totalPaise),
    usedAt: r.usedAt,
  }));
}

/** The coupon report as an Excel workbook (summary + uses), times in IST. */
export async function couponReportXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GoKesari";
  const s = wb.addWorksheet("Coupons");
  s.columns = [
    { header: "Code", key: "code", width: 16 },
    { header: "Name", key: "name", width: 26 },
    { header: "Type", key: "type", width: 10 },
    { header: "Value", key: "value", width: 12 },
    { header: "State", key: "state", width: 11 },
    { header: "Uses", key: "uses", width: 8 },
    { header: "Dealers", key: "dealers", width: 9 },
    { header: "Discount given (₹)", key: "discount", width: 18 },
    { header: "Revenue after discount (₹)", key: "revenue", width: 24 },
    { header: "Valid (IST)", key: "valid", width: 40 },
  ];
  for (const r of await listCoupons()) {
    s.addRow({ code: r.coupon.code, name: r.coupon.name, type: r.coupon.discountType, value: r.coupon.discountType === "PERCENT" ? `${(r.coupon.percentBp ?? 0) / 100}%` : `₹${Number(r.coupon.flatPaise ?? 0) / 100}`, state: r.state, uses: r.uses, dealers: r.dealers, discount: r.discountPaise / 100, revenue: r.revenueAfterDiscountPaise / 100, valid: `${formatIst(r.coupon.startsAt)} – ${formatIst(r.coupon.endsAt)}` });
  }
  const u = wb.addWorksheet("Uses");
  u.columns = [
    { header: "Code", key: "code", width: 14 },
    { header: "Dealer", key: "dealer", width: 28 },
    { header: "Kind", key: "kind", width: 10 },
    { header: "Zones", key: "zones", width: 30 },
    { header: "List fee (₹)", key: "list", width: 14 },
    { header: "Discount (₹)", key: "discount", width: 13 },
    { header: "Taxable (₹)", key: "base", width: 13 },
    { header: "GST (₹)", key: "gst", width: 11 },
    { header: "Total paid (₹)", key: "total", width: 14 },
    { header: "Used (IST)", key: "used", width: 22 },
  ];
  for (const r of await couponUses()) u.addRow({ code: r.code, dealer: r.dealer, kind: r.kind, zones: r.zones, list: r.listPaise / 100, discount: r.discountPaise / 100, base: r.basePaise / 100, gst: r.gstPaise / 100, total: r.totalPaise / 100, used: r.usedAt ? formatIst(r.usedAt) : "" });
  for (const ws of [s, u]) ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export type { CartLine, ZoneTier };
