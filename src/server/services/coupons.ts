/**
 * Order-level coupons (feature F7).
 *
 * A coupon takes a flat amount or a percentage off the goods of the whole
 * order — every shop in the cart together — subject to a minimum order value,
 * start / expiry dates, a total usage limit and a per-customer limit. A
 * multi-shop order's discount is split across its sub-orders in proportion to
 * each shop's goods value. Everything is decided on the server; the client
 * only sends the code. Off (rule "coupons") → codes are refused.
 *
 * One "use" of a coupon is one checkout request, however many shops it spans.
 * Limits are re-checked under a row lock on the coupon inside each order's
 * transaction, so two checkouts can never both take the last use.
 */
import { and, desc, eq, ne, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { db, type DbClient } from "@/server/db";
import { couponRedemptions, coupons, type Coupon } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";

export const normalizeCode = (code: string) => code.trim().toUpperCase();

/** Discount on `goodsPaise` (before limits/eligibility), never more than the goods. */
export function couponDiscount(coupon: Pick<Coupon, "discountType" | "flatPaise" | "percent" | "maxDiscountPaise">, goodsPaise: number): number {
  const raw =
    coupon.discountType === "FLAT"
      ? (coupon.flatPaise ?? 0)
      : Math.floor((goodsPaise * (coupon.percent ?? 0)) / 100);
  const capped = coupon.maxDiscountPaise != null ? Math.min(raw, coupon.maxDiscountPaise) : raw;
  return Math.max(0, Math.min(capped, goodsPaise));
}

/**
 * Splits `total` across `weights` proportionally, in whole paise, summing
 * exactly to `total` (largest remainder; ties to the earlier entry).
 */
export function splitProportionally(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const shares = exact.map(Math.floor);
  let left = total - shares.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i] += 1;
    left -= 1;
  }
  return shares;
}

async function usesExcluding(couponId: string, requestId: string, userId: string | null, client: DbClient): Promise<number> {
  const [row] = await client
    .select({ n: sql<number>`count(distinct ${couponRedemptions.requestId})::int` })
    .from(couponRedemptions)
    .where(
      and(
        eq(couponRedemptions.couponId, couponId),
        ne(couponRedemptions.requestId, requestId),
        userId ? eq(couponRedemptions.userId, userId) : undefined,
      ),
    );
  return row?.n ?? 0;
}

/** Every rule except the limits that need a lock. Throws a customer-readable error. */
function assertUsable(coupon: Coupon | undefined, goodsPaise: number, now: Date): asserts coupon is Coupon {
  if (!coupon || !coupon.active) throw validationFailed("That coupon code isn't valid.");
  if (coupon.startsAt && coupon.startsAt > now) throw validationFailed("That coupon isn't active yet.");
  if (coupon.expiresAt && coupon.expiresAt <= now) throw validationFailed("That coupon has expired.");
  if (goodsPaise < coupon.minOrderPaise) {
    throw validationFailed(`This coupon needs a minimum order of ${formatPaise(coupon.minOrderPaise)}.`);
  }
}

async function assertWithinLimits(coupon: Coupon, userId: string, requestId: string, client: DbClient) {
  if (coupon.usageLimit != null && (await usesExcluding(coupon.id, requestId, null, client)) >= coupon.usageLimit) {
    throw conflict("This coupon has been fully used.");
  }
  if (coupon.perCustomerLimit != null && (await usesExcluding(coupon.id, requestId, userId, client)) >= coupon.perCustomerLimit) {
    throw conflict("You've already used this coupon.");
  }
}

export interface CouponQuote {
  code: string;
  couponId: string;
  description: string | null;
  discountPaise: number;
  /** Per shop, in the order of `groups`. */
  shares: { shopId: string; discountPaise: number }[];
}

/** Validates a code against a cart's per-shop goods and prices the discount. */
export async function quoteCoupon(
  code: string,
  userId: string,
  requestId: string,
  groups: { shopId: string; goodsPaise: number }[],
  now: Date = new Date(),
): Promise<CouponQuote> {
  if (!(await getRule("coupons")).enabled) throw validationFailed("Coupons aren't available right now.");
  const coupon = await db.query.coupons.findFirst({ where: eq(coupons.code, normalizeCode(code)) });
  const goodsPaise = groups.reduce((n, g) => n + g.goodsPaise, 0);
  assertUsable(coupon, goodsPaise, now);
  await assertWithinLimits(coupon, userId, requestId, db);
  const discountPaise = couponDiscount(coupon, goodsPaise);
  const split = splitProportionally(discountPaise, groups.map((g) => g.goodsPaise));
  return {
    code: coupon.code,
    couponId: coupon.id,
    description: coupon.description,
    discountPaise,
    shares: groups.map((g, i) => ({ shopId: g.shopId, discountPaise: split[i] })),
  };
}

/**
 * Inside one sub-order's transaction: lock the coupon, re-check it is still
 * usable for this request, and record the redemption. Returns the discount
 * actually applied (never more than this order's goods).
 */
export async function redeemCouponForOrder(
  tx: DbClient,
  input: { couponId: string; userId: string; requestId: string; orderId: string; sharePaise: number; orderGoodsPaise: number },
  now: Date = new Date(),
): Promise<number> {
  const [coupon] = await tx.select().from(coupons).where(eq(coupons.id, input.couponId)).for("update");
  if (!coupon || !coupon.active || (coupon.expiresAt && coupon.expiresAt <= now)) {
    throw conflict("That coupon is no longer available. Remove it and try again.");
  }
  await assertWithinLimits(coupon, input.userId, input.requestId, tx);
  const discountPaise = Math.max(0, Math.min(input.sharePaise, input.orderGoodsPaise));
  await tx.insert(couponRedemptions).values({
    couponId: coupon.id,
    userId: input.userId,
    orderId: input.orderId,
    requestId: input.requestId,
    discountPaise,
  });
  return discountPaise;
}

/* ---------------------------------------------------------------- admin */

export interface CouponInput {
  code: string;
  description?: string | null;
  discountType: "FLAT" | "PERCENT";
  flatPaise?: number | null;
  percent?: number | null;
  maxDiscountPaise?: number | null;
  minOrderPaise?: number;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  usageLimit?: number | null;
  perCustomerLimit?: number | null;
  active?: boolean;
}

export async function listCoupons() {
  const rows = await db.select().from(coupons).orderBy(desc(coupons.createdAt));
  const uses = await db
    .select({ couponId: couponRedemptions.couponId, n: sql<number>`count(distinct ${couponRedemptions.requestId})::int` })
    .from(couponRedemptions)
    .groupBy(couponRedemptions.couponId);
  const byId = new Map(uses.map((u) => [u.couponId, u.n]));
  return rows.map((c) => ({ ...c, uses: byId.get(c.id) ?? 0 }));
}

export async function saveCoupon(input: CouponInput, actor: { id: string; role: string }, id?: string) {
  const code = normalizeCode(input.code);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw validationFailed("Use 3–32 letters, digits, - or _ for the code.");
  if (input.discountType === "FLAT" && !(input.flatPaise && input.flatPaise > 0)) throw validationFailed("Enter the amount off.");
  if (input.discountType === "PERCENT" && !(input.percent && input.percent >= 1 && input.percent <= 100)) {
    throw validationFailed("Enter a percentage between 1 and 100.");
  }
  if (input.startsAt && input.expiresAt && input.expiresAt <= input.startsAt) throw validationFailed("Expiry must be after the start.");
  const values = {
    code,
    description: input.description?.trim() || null,
    discountType: input.discountType,
    flatPaise: input.discountType === "FLAT" ? input.flatPaise! : null,
    percent: input.discountType === "PERCENT" ? input.percent! : null,
    maxDiscountPaise: input.discountType === "PERCENT" ? (input.maxDiscountPaise ?? null) : null,
    minOrderPaise: input.minOrderPaise ?? 0,
    startsAt: input.startsAt ?? null,
    expiresAt: input.expiresAt ?? null,
    usageLimit: input.usageLimit ?? null,
    perCustomerLimit: input.perCustomerLimit === undefined ? 1 : input.perCustomerLimit,
    active: input.active ?? true,
    updatedAt: new Date(),
  };
  const clash = await db.query.coupons.findFirst({ where: eq(coupons.code, code) });
  if (clash && clash.id !== id) throw conflict("A coupon with that code already exists.");
  let row: Coupon | undefined;
  if (id) {
    [row] = await db.update(coupons).set(values).where(eq(coupons.id, id)).returning();
    if (!row) throw notFound("Coupon");
  } else {
    [row] = await db.insert(coupons).values({ ...values, createdBy: actor.id }).returning();
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role as never,
    action: AUDIT_ACTIONS.COUPON_SAVED,
    entityType: "coupon",
    entityId: row.id,
    newValue: values,
  });
  return row;
}
