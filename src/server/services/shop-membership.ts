/**
 * Shop membership (D-69, owner 25 Oct 2026): "if they have not renewed the
 * membership they can be marked as not online".
 *
 * A fully paid registration fee or renewal extends shops.membership_valid_until
 * by rule shopMembership.periodMonths. Once that date is more than graceDays
 * behind, the shop is closed to customers the same way as a shop that paused
 * its orders (serviceability.ts walletOrderGate / withWalletGate) until a
 * renewal is recorded. A shop with no end date is never affected, nor is an
 * exempt shop (0189: the per-shop exemption, or rule exemptShopTypes /
 * exemptCategorySlugs).
 *
 * 0197 (docs/shop-membership-renewal-2026-11): every extension is a row in
 * shop_membership_periods. The fee payments of a shop (REGISTRATION_FEE,
 * RENEWAL, and the REFUND / REVERSAL rows that correct them) form one pool;
 * each period consumes its fee from it. A part payment opens no period (it
 * waits for the rest), and a refund or reversal that leaves the periods
 * unpaid takes the latest ones back.
 */
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import { shopCategories, shopCategoryMapping, shopMembershipPeriods, shops, type Shop, type ShopMembershipPeriod, type ShopPayment } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";

const DAY_MS = 86_400_000;

/** `date` plus whole calendar months (the 31st becomes the month's last day). */
export function addMonths(date: Date, months: number): Date {
  const out = new Date(date);
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

/** The new end after a payment on `paidAt`: from the current end while it lasts, else from the payment. */
export function membershipEndAfterPayment(current: Date | null, paidAt: Date, periodMonths: number): Date {
  return addMonths(current && current > paidAt ? current : paidAt, periodMonths);
}

/* ============================================================ exemptions */

export interface MembershipExemptionRule {
  exemptShopTypes?: readonly string[];
  exemptCategorySlugs?: readonly string[];
}

/** 0189: exempt by the admin's per-shop switch, its shop type, or one of its shop categories. */
export function isMembershipExempt(
  shop: { membershipExempt?: boolean | null; shopType?: string | null },
  rule: MembershipExemptionRule,
  categorySlugs: readonly string[] = [],
): boolean {
  if (shop.membershipExempt) return true;
  if (shop.shopType && (rule.exemptShopTypes ?? []).includes(shop.shopType)) return true;
  const slugs = rule.exemptCategorySlugs ?? [];
  return slugs.length > 0 && categorySlugs.some((s) => slugs.includes(s));
}

/** The shop category slugs of each shop (for the category exemption). */
export async function shopCategorySlugsByShop(shopIds: string[], client: DbClient = db): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (shopIds.length === 0) return out;
  const rows = await client
    .select({ shopId: shopCategoryMapping.shopId, slug: shopCategories.slug })
    .from(shopCategoryMapping)
    .innerJoin(shopCategories, eq(shopCategories.id, shopCategoryMapping.categoryId))
    .where(inArray(shopCategoryMapping.shopId, shopIds));
  for (const r of rows) out.set(r.shopId, [...(out.get(r.shopId) ?? []), r.slug]);
  return out;
}

/** SQL on the outer `shops` row: true when the shop is exempt (raw names, as in the order gate). */
function exemptionSql(rule: MembershipExemptionRule): SQL {
  const parts: SQL[] = [sql`shops.membership_exempt`];
  const types = rule.exemptShopTypes ?? [];
  if (types.length > 0) parts.push(sql`shops.shop_type::text in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})`);
  const slugs = rule.exemptCategorySlugs ?? [];
  if (slugs.length > 0) {
    parts.push(
      sql`exists (select 1 from shop_category_mapping scm join shop_categories sc on sc.id = scm.category_id where scm.shop_id = shops.id and sc.slug in (${sql.join(slugs.map((s) => sql`${s}`), sql`, `)}))`,
    );
  }
  return sql`(${sql.join(parts, sql` or `)})`;
}

/* ================================================================ status */

export type MembershipState = "NONE" | "ACTIVE" | "DUE_SOON" | "GRACE" | "LAPSED" | "EXEMPT";

export interface MembershipStatus {
  state: MembershipState;
  validUntil: Date | null;
  /** When the shop stops (or stopped) being online: the end plus the grace days. Null when exempt. */
  offlineFrom: Date | null;
  /** False when rule shopMembership is off or the shop is exempt: a lapsed membership closes nothing. */
  enforced: boolean;
}

/**
 * 0206: when the shop goes offline — the end plus its grace days (the shop's own, else the rule's), or a
 * grace an admin / the 0206 migration gave until a later moment.
 */
export function offlineFromOf(
  until: Date,
  shop: { registrationGraceDays?: number | null; registrationGraceUntil?: Date | null },
  graceDays: number,
): Date {
  const days = shop.registrationGraceDays ?? graceDays;
  const byDays = new Date(until.getTime() + Math.max(0, days) * DAY_MS);
  const extra = shop.registrationGraceUntil ?? null;
  return extra && extra > byDays ? extra : byDays;
}

export function membershipStatus(
  shop: Pick<Shop, "membershipValidUntil"> & {
    membershipExempt?: boolean | null;
    shopType?: string | null;
    registrationGraceDays?: number | null;
    registrationGraceUntil?: Date | null;
  },
  rule: { enabled: boolean; graceDays: number; reminderDays: number } & MembershipExemptionRule,
  now = new Date(),
  categorySlugs: readonly string[] = [],
): MembershipStatus {
  const until = shop.membershipValidUntil;
  if (isMembershipExempt(shop, rule, categorySlugs)) return { state: "EXEMPT", validUntil: until, offlineFrom: null, enforced: false };
  if (!until) return { state: "NONE", validUntil: null, offlineFrom: null, enforced: rule.enabled };
  const offlineFrom = offlineFromOf(until, shop, rule.graceDays);
  let state: MembershipState = "ACTIVE";
  if (now >= until) state = rule.enabled && now >= offlineFrom ? "LAPSED" : "GRACE";
  else if (until.getTime() - now.getTime() <= rule.reminderDays * DAY_MS) state = "DUE_SOON";
  return { state, validUntil: until, offlineFrom, enforced: rule.enabled };
}

/** SQL on the outer `shops` row: true while the membership keeps the shop online. */
export async function membershipOrderGate(): Promise<SQL> {
  const rule = await getRule("shopMembership");
  if (!rule.enabled) return sql`true`;
  // Raw names, as in walletOrderGate: the condition sits in queries over `shops`.
  return sql`(${stillOnlineSql(rule.graceDays)} or ${exemptionSql(rule)})`;
}

/** SQL on the outer `shops` row (raw names): no end date, or still inside the end plus its grace (0206 overrides). */
function stillOnlineSql(graceDays: number): SQL {
  return sql`(shops.membership_valid_until is null
    or shops.membership_valid_until > now() - make_interval(days => coalesce(shops.registration_grace_days, ${graceDays}))
    or coalesce(shops.registration_grace_until > now(), false))`;
}

/**
 * 0206 (owner brief 25-Nov-2026): false for a shop customers must not find — registration EXPIRED (past its
 * grace while rule shopMembership is enforced; the stored status, kept current by every payment and admin
 * change at once and by the registration job every 15 minutes). Search, nearby, home discovery, price
 * comparison and the shop / QR page add it; orders already placed are not affected.
 */
export const registrationListed: SQL = sql`(${shops.registrationStatus} <> 'EXPIRED')`;

/** The shops among `shopIds` that are not online because their membership lapsed. */
export async function membershipLapsedShopIds(shopIds: string[]): Promise<Set<string>> {
  if (shopIds.length === 0) return new Set();
  const rule = await getRule("shopMembership");
  if (!rule.enabled) return new Set();
  const rows = await db
    .select({ id: shops.id })
    .from(shops)
    .where(
      and(
        inArray(shops.id, shopIds),
        isNotNull(shops.membershipValidUntil),
        sql`not ${stillOnlineSql(rule.graceDays)}`,
        sql`not ${exemptionSql(rule)}`,
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/* ========================================================= renewal fee */

export interface RenewalQuote {
  basePaise: number;
  gstRateBp: number;
  gstPaise: number;
  totalPaise: number;
  /** RULE: rule renewalFeePaise. SHOP_BASE: the shop's registration base fee. SHOP_TOTAL: its registration total (no breakdown kept). */
  source: "RULE" | "SHOP_BASE" | "SHOP_TOTAL" | "SHOP_TYPE" | "SHOP_OVERRIDE";
}

/** The renewal fee: base (rule, else the shop's registration base without its coupon), plus GST when addGst. */
export function renewalQuoteFrom(
  shop: Pick<Shop, "registrationFeeBasePaise" | "registrationFeePaise"> & { renewalFeePaise?: number | null; shopType?: string | null },
  rule: { renewalFeePaise: number; addGst: boolean },
  gstRateBp: number,
  /** 0206: renewal fee before GST per shop type (rule shopRegistrationSubscription.renewalFeeByShopType). */
  byShopType: Readonly<Record<string, number>> = {},
): RenewalQuote {
  let basePaise: number;
  let source: RenewalQuote["source"];
  const typeFee = shop.shopType ? byShopType[shop.shopType] : undefined;
  if (shop.renewalFeePaise != null && shop.renewalFeePaise > 0) {
    // 0206: the admin set this shop's own renewal fee.
    basePaise = shop.renewalFeePaise;
    source = "SHOP_OVERRIDE";
  } else if (typeFee != null && typeFee > 0) {
    basePaise = typeFee;
    source = "SHOP_TYPE";
  } else if (rule.renewalFeePaise > 0) {
    basePaise = rule.renewalFeePaise;
    source = "RULE";
  } else if (shop.registrationFeeBasePaise != null) {
    basePaise = shop.registrationFeeBasePaise;
    source = "SHOP_BASE";
  } else {
    // Registered before the breakdown was kept: the total it paid, GST included as it was then.
    const total = Math.max(0, shop.registrationFeePaise ?? 0);
    return { basePaise: total, gstRateBp: 0, gstPaise: 0, totalPaise: total, source: "SHOP_TOTAL" };
  }
  const rate = rule.addGst ? Math.max(0, gstRateBp) : 0;
  const gstPaise = Math.round((basePaise * rate) / 10_000);
  return { basePaise, gstRateBp: rate, gstPaise, totalPaise: basePaise + gstPaise, source };
}

/** The renewal fee today: GST at the registration fee's rate in force (Admin → Statutory), else the shop's own rate. */
export async function renewalFeeQuote(
  shop: Pick<Shop, "registrationFeeBasePaise" | "registrationFeePaise" | "registrationFeeGstRateBp"> & { renewalFeePaise?: number | null; shopType?: string | null },
  at: Date = new Date(),
  client: DbClient = db,
): Promise<RenewalQuote> {
  const [rule, sub] = await Promise.all([getRule("shopMembership"), getRule("shopRegistrationSubscription")]);
  let rate = shop.registrationFeeGstRateBp ?? 0;
  const typeFee = shop.shopType ? sub.renewalFeeByShopType[shop.shopType] : undefined;
  const fixedBase = (shop.renewalFeePaise ?? 0) > 0 || (typeFee ?? 0) > 0 || rule.renewalFeePaise > 0;
  if (rule.addGst && (fixedBase || shop.registrationFeeBasePaise != null)) {
    try {
      const { registrationFeeGstRateBp } = await import("./registration-fee-coupons");
      rate = await registrationFeeGstRateBp(at, client);
    } catch (error) {
      // No GST row in force: the shop's own registration rate (never a silent 0 when it had one).
      console.error("[shop-membership] GST rate for the renewal fee not found; using the shop's registration rate", error);
    }
  }
  return renewalQuoteFrom(shop, rule, rate, sub.renewalFeeByShopType);
}

/* ============================================================== periods */

/** Pure: does a fee pool with `unallocatedPaise` cover the next period's fee? (a 0 fee needs a payment). */
export function poolCoversNextPeriod(unallocatedPaise: number, nextFeePaise: number): boolean {
  return unallocatedPaise >= Math.max(0, nextFeePaise);
}

/**
 * Pure: the periods (newest first, LEGACY never) to take back so the pool is no longer short.
 * `unallocatedPaise` is negative when the refunds / reversals left periods unpaid.
 */
export function periodsToRollBack<P extends { id: string; kind: string; feePaise: number }>(newestFirst: P[], unallocatedPaise: number): P[] {
  const out: P[] = [];
  let balance = unallocatedPaise;
  for (const p of newestFirst) {
    if (balance >= 0) break;
    if (p.kind === "LEGACY") break;
    out.push(p);
    balance += p.feePaise;
  }
  return out;
}

/**
 * Pure: the membership end once `period` is taken back. The latest period restores the end before it;
 * an older one (a later period, or a referral month, already added time after it) takes its length off.
 */
export function membershipEndAfterRollback(current: Date | null, period: Pick<ShopMembershipPeriod, "periodStart" | "periodEnd" | "previousValidUntil">): Date | null {
  if (!current) return null;
  if (current.getTime() === period.periodEnd.getTime()) return period.previousValidUntil ?? period.periodStart;
  return new Date(current.getTime() - (period.periodEnd.getTime() - period.periodStart.getTime()));
}

/** Net of the fee payments: REGISTRATION_FEE, RENEWAL and REFUND rows, and reversals of those. */
async function feePoolNetPaise(tx: DbClient, shopId: string): Promise<number> {
  const result = await tx.execute(sql`
    select coalesce(sum(p.amount_paise), 0)::bigint as net
    from shop_payments p
    left join shop_payments o on o.id = p.reversal_of_id
    where p.shop_id = ${shopId}
      and (p.payment_type in ('REGISTRATION_FEE', 'RENEWAL', 'REFUND')
        or (p.payment_type = 'REVERSAL' and o.payment_type in ('REGISTRATION_FEE', 'RENEWAL', 'REFUND')))`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { net: string | number }[];
  return Number(rows[0]?.net ?? 0);
}

async function activePeriods(tx: DbClient, shopId: string): Promise<ShopMembershipPeriod[]> {
  return tx
    .select()
    .from(shopMembershipPeriods)
    .where(and(eq(shopMembershipPeriods.shopId, shopId), isNull(shopMembershipPeriods.voidedAt)))
    .orderBy(desc(shopMembershipPeriods.createdAt), desc(shopMembershipPeriods.periodEnd));
}

/**
 * Adds one period to the membership and records it (the shop row is locked by the caller). Used by the
 * self-registration webhook (a fully paid fee) and by settleMembershipAfterPayment.
 */
export async function extendMembership(
  tx: DbClient,
  shopId: string,
  paidAt: Date,
  period: { kind?: "REGISTRATION" | "RENEWAL"; feePaise?: number; shopPaymentId?: string | null; paymentIntentId?: string | null; quote?: RenewalQuote | null } = {},
): Promise<Date> {
  const rule = await getRule("shopMembership");
  const [shop] = await tx.select({ until: shops.membershipValidUntil }).from(shops).where(eq(shops.id, shopId));
  const previous = shop?.until ?? null;
  const start = previous && previous > paidAt ? previous : paidAt;
  const until = membershipEndAfterPayment(previous, paidAt, rule.periodMonths);
  await tx.update(shops).set({ membershipValidUntil: until, updatedAt: new Date() }).where(eq(shops.id, shopId));
  const [row] = await tx.insert(shopMembershipPeriods).values({
    shopId,
    kind: period.kind ?? "REGISTRATION",
    periodStart: start,
    periodEnd: until,
    previousValidUntil: previous,
    feePaise: Math.max(0, period.feePaise ?? 0),
    basePaise: period.quote?.basePaise ?? null,
    gstRateBp: period.quote?.gstRateBp ?? null,
    gstPaise: period.quote?.gstPaise ?? null,
    shopPaymentId: period.shopPaymentId ?? null,
    paymentIntentId: period.paymentIntentId ?? null,
  }).returning({ id: shopMembershipPeriods.id });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.SHOP_MEMBERSHIP_PERIOD_OPENED,
      entityType: "shop",
      entityId: shopId,
      previousValue: { validUntil: previous?.toISOString() ?? null },
      newValue: { periodId: row.id, kind: period.kind ?? "REGISTRATION", validUntil: until.toISOString(), feePaise: period.feePaise ?? 0, shopPaymentId: period.shopPaymentId ?? null },
    },
    tx,
  );
  return until;
}

export interface MembershipSettlement {
  /** The period this payment completed, or null (a part payment, or not enough after earlier refunds). */
  periodEnd: Date | null;
  feePaise: number;
  unallocatedPaise: number;
}

/**
 * After a REGISTRATION_FEE or RENEWAL payment (inside recordPayment's transaction, shop row locked):
 * opens a period only when the pool now covers the next period's fee — the registration fee for the
 * first period, the renewal fee after that. At most one period per payment.
 */
export async function settleMembershipAfterPayment(
  tx: DbClient,
  shop: Pick<Shop, "id" | "registrationFeePaise" | "registrationFeeBasePaise" | "registrationFeeGstRateBp"> & { renewalFeePaise?: number | null; shopType?: string | null },
  payment: Pick<ShopPayment, "id" | "paidAt">,
  options: { quote?: RenewalQuote | null; paymentIntentId?: string | null } = {},
): Promise<MembershipSettlement> {
  const [net, periods] = await Promise.all([feePoolNetPaise(tx, shop.id), activePeriods(tx, shop.id)]);
  const allocated = periods.reduce((sum, p) => sum + p.feePaise, 0);
  const unallocated = net - allocated;
  const first = periods.length === 0;
  const quote = first ? null : (options.quote ?? (await renewalFeeQuote(shop, payment.paidAt, tx)));
  const fee = first ? Math.max(0, shop.registrationFeePaise ?? 0) : quote!.totalPaise;
  if (!poolCoversNextPeriod(unallocated, fee)) return { periodEnd: null, feePaise: fee, unallocatedPaise: unallocated };
  const periodEnd = await extendMembership(tx, shop.id, payment.paidAt, {
    kind: first ? "REGISTRATION" : "RENEWAL",
    feePaise: fee,
    shopPaymentId: payment.id,
    paymentIntentId: options.paymentIntentId ?? null,
    quote,
  });
  return { periodEnd, feePaise: fee, unallocatedPaise: unallocated - fee };
}

/**
 * After a REFUND, or a REVERSAL of a fee payment (in the correcting transaction): while the pool no
 * longer pays for the periods, the latest ones are voided and the membership end goes back with them.
 * LEGACY periods (before 0189) are never taken back. Returns the voided periods.
 */
export async function rollBackUnpaidMembershipPeriods(tx: DbClient, shopId: string, correctionPaymentId: string, reason: string): Promise<ShopMembershipPeriod[]> {
  const [shop] = await tx.select({ until: shops.membershipValidUntil }).from(shops).where(eq(shops.id, shopId)).for("update");
  if (!shop) return [];
  const [net, periods] = await Promise.all([feePoolNetPaise(tx, shopId), activePeriods(tx, shopId)]);
  const unallocated = net - periods.reduce((sum, p) => sum + p.feePaise, 0);
  const voided = periodsToRollBack(periods, unallocated);
  if (voided.length === 0) return [];
  let until = shop.until;
  const now = new Date();
  for (const p of voided) {
    until = membershipEndAfterRollback(until, p);
    await tx
      .update(shopMembershipPeriods)
      .set({ voidedAt: now, voidReason: reason.slice(0, 500), voidedByPaymentId: correctionPaymentId })
      .where(and(eq(shopMembershipPeriods.id, p.id), isNull(shopMembershipPeriods.voidedAt)));
  }
  await tx.update(shops).set({ membershipValidUntil: until, updatedAt: now }).where(eq(shops.id, shopId));
  await recordAudit(
    {
      action: AUDIT_ACTIONS.SHOP_MEMBERSHIP_PERIOD_VOIDED,
      entityType: "shop",
      entityId: shopId,
      previousValue: { validUntil: shop.until?.toISOString() ?? null },
      newValue: { periodIds: voided.map((p) => p.id), validUntil: until?.toISOString() ?? null, correctionPaymentId, reason },
    },
    tx,
  );
  return voided;
}

/** A shop's renewal history (newest first), voided periods included. */
export async function listMembershipPeriods(shopId: string, client: DbClient = db): Promise<ShopMembershipPeriod[]> {
  return client
    .select()
    .from(shopMembershipPeriods)
    .where(and(eq(shopMembershipPeriods.shopId, shopId), ne(shopMembershipPeriods.kind, "LEGACY")))
    .orderBy(desc(shopMembershipPeriods.createdAt));
}

/* ======================================== 0206 registration subscription */

/** The registration subscription's status (owner brief 25-Nov-2026), as stored in shops.registration_status. */
export type RegistrationStatus = "UNPAID" | "ACTIVE" | "EXPIRING_SOON" | "GRACE" | "EXPIRED" | "EXEMPT";
export const REGISTRATION_STATUSES: readonly RegistrationStatus[] = ["UNPAID", "ACTIVE", "EXPIRING_SOON", "GRACE", "EXPIRED", "EXEMPT"];

/** Pure: is the registration fee still (partly) owed? Same rule as registrationFeeDue (registration-fee-payment.ts). */
export function registrationFeeOwed(shop: Pick<Shop, "registrationFeePaise" | "amountPaidPaise" | "feePaymentStatus">): boolean {
  if (shop.feePaymentStatus === "PAID" || shop.feePaymentStatus === "CANCELLED" || shop.feePaymentStatus === "REFUNDED") return false;
  return (shop.registrationFeePaise ?? 0) - (shop.amountPaidPaise ?? 0) > 0;
}

/** Pure: the registration status from the membership state (no end date + fee owed = UNPAID). */
export function registrationStatusOf(
  shop: Pick<Shop, "registrationFeePaise" | "amountPaidPaise" | "feePaymentStatus">,
  membership: Pick<MembershipStatus, "state">,
): RegistrationStatus {
  switch (membership.state) {
    case "EXEMPT":
      return "EXEMPT";
    case "NONE":
      return registrationFeeOwed(shop) ? "UNPAID" : "ACTIVE";
    case "DUE_SOON":
      return "EXPIRING_SOON";
    case "GRACE":
      return "GRACE";
    case "LAPSED":
      return "EXPIRED";
    default:
      return "ACTIVE";
  }
}

/**
 * 0206: inside recordPayment's transaction, after a REGISTRATION_FEE or RENEWAL payment. Notes the last
 * payment; when it opened a period, sets the start date (first period) and ends an "Expire now" or a
 * migration grace — the new period stands on its own.
 */
export async function noteRegistrationPayment(
  tx: DbClient,
  shopId: string,
  payment: Pick<ShopPayment, "id" | "paidAt" | "amountPaise">,
  periodEnd: Date | null,
): Promise<void> {
  if (payment.amountPaise <= 0) return;
  const [shop] = await tx.select({ start: shops.registrationStartDate }).from(shops).where(eq(shops.id, shopId));
  await tx
    .update(shops)
    .set({
      lastRegistrationPaymentId: payment.id,
      lastRegistrationPaymentAt: payment.paidAt,
      ...(periodEnd
        ? {
            registrationGraceDays: null,
            registrationGraceUntil: null,
            ...(shop?.start ? {} : { registrationStartDate: payment.paidAt }),
          }
        : {}),
    })
    .where(eq(shops.id, shopId));
}


/** 0206: recomputes and stores one shop's registration status. Returns it (null: no such shop). */
export async function refreshRegistrationStatus(shopId: string, now = new Date(), client: DbClient = db): Promise<RegistrationStatus | null> {
  const rule = await getRule("shopMembership");
  const [shop] = await client.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) return null;
  const slugs = rule.exemptCategorySlugs.length > 0 ? ((await shopCategorySlugsByShop([shopId], client)).get(shopId) ?? []) : [];
  const status = registrationStatusOf(shop, membershipStatus(shop, rule, now, slugs));
  if (status !== shop.registrationStatus || !shop.registrationStatusAt) {
    await client.update(shops).set({ registrationStatus: status, registrationStatusAt: now }).where(eq(shops.id, shopId));
  }
  return status;
}

/** refreshRegistrationStatus that never throws (after a payment's commit: the daily job catches up). */
export async function refreshRegistrationStatusSafely(shopId: string): Promise<void> {
  await refreshRegistrationStatus(shopId).catch((error) => console.error("[registration-subscription] status refresh failed", shopId, error));
}
