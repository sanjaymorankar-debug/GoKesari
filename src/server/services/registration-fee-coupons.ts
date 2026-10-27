/**
 * The one-time registration fee on Add my shop, as the owner pays it (owner,
 * 27 Oct 2026):
 *
 *   base fee (Admin → Registration fee, ₹999 — or rule registrationFeeByTurnover
 *   when an admin switches it on)
 *   − a registration-fee coupon, if the owner has one
 *   + GST on the rest, at the rate in force for GoKesari's registration fee
 *     (Admin → Statutory, PLATFORM_FEE_GST: 18%)
 *   = the total, snapshotted on the shop as registration_fee_paise.
 *
 * Coupons are admin-only and audited. Their limits (total uses, uses per owner)
 * are checked again under a row lock on the coupon when the shop is saved, so
 * two registrations can never both take the last use.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import {
  feeForTurnover,
  registrationCouponDiscount,
  registrationFeeBreakdown,
  type RegistrationFeeBreakdown,
} from "@/lib/registration-fee";
import { db, type DbClient } from "@/server/db";
import { registrationFeeCoupons, shops, type RegistrationFeeCoupon, type UserRole } from "@/server/db/schema";
import { touchSellerRow } from "@/server/db/split/gate";
import { istDay, platformFeeGstRateOn, statutoryResolver } from "@/server/statutory/rates";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { resolveFeeForNewRegistration } from "./registration-fees";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

export const normalizeCouponCode = (code: string) => code.trim().toUpperCase();

/** A refusal shown next to the coupon field on the form. */
const couponError = (message: string) =>
  validationFailed(message, { fields: { couponCode: message } });

/** GST rate (basis points) on GoKesari's registration fee today. */
export async function registrationFeeGstRateBp(at: Date = new Date(), client: DbClient = db): Promise<number> {
  return platformFeeGstRateOn("REGISTRATION_FEE", istDay(at), statutoryResolver(client));
}

/**
 * The base fee for a new registration: rule registrationFeeByTurnover when it
 * gives one, otherwise the flat fee. `feeId` is the flat fee row it came from.
 */
export async function baseRegistrationFee(
  turnoverRupees: number | null,
  client: DbClient = db,
): Promise<{ basePaise: number; feeId: string | null }> {
  const [scheduled, rule] = await Promise.all([resolveFeeForNewRegistration(client), getRule("registrationFeeByTurnover")]);
  const fromRule = rule.enabled && turnoverRupees !== null ? feeForTurnover(turnoverRupees, rule) : null;
  return fromRule === null
    ? { basePaise: scheduled.amountPaise, feeId: scheduled.feeId }
    : { basePaise: fromRule, feeId: null };
}

function assertUsable(coupon: RegistrationFeeCoupon | undefined, now: Date): asserts coupon is RegistrationFeeCoupon {
  if (!coupon || !coupon.active) throw couponError("That coupon code isn't valid.");
  if (coupon.startsAt && coupon.startsAt > now) throw couponError("That coupon isn't active yet.");
  if (coupon.expiresAt && coupon.expiresAt <= now) throw couponError("That coupon has expired.");
}

/** Shops registered with the coupon (all, or one owner's). */
async function usesOf(couponId: string, ownerId: string | null, client: DbClient): Promise<number> {
  const [row] = await client
    .select({ n: sql<number>`count(*)::int` })
    .from(shops)
    .where(
      and(
        eq(shops.registrationFeeCouponId, couponId),
        isNull(shops.deletedAt),
        ownerId ? eq(shops.ownerId, ownerId) : undefined,
      ),
    );
  return row?.n ?? 0;
}

async function assertWithinLimits(coupon: RegistrationFeeCoupon, ownerId: string, client: DbClient) {
  if (coupon.usageLimit != null && (await usesOf(coupon.id, null, client)) >= coupon.usageLimit) {
    throw couponError("This coupon has been fully used.");
  }
  if (coupon.perOwnerLimit != null && (await usesOf(coupon.id, ownerId, client)) >= coupon.perOwnerLimit) {
    throw couponError("You've already used this coupon.");
  }
}

export interface RegistrationFeeQuote extends RegistrationFeeBreakdown {
  couponCode: string | null;
  couponDescription: string | null;
}

/**
 * What a new registration would pay, with an optional coupon — for the form,
 * before Submit. The fee actually charged is computed again when the shop is
 * saved (registerShop), never taken from this.
 */
export async function quoteRegistrationFee(
  input: { ownerId: string; couponCode?: string | null; turnoverRupees?: number | null },
  now: Date = new Date(),
): Promise<RegistrationFeeQuote> {
  const [{ basePaise }, gstRateBp] = await Promise.all([
    baseRegistrationFee(input.turnoverRupees ?? null),
    registrationFeeGstRateBp(now),
  ]);
  const code = input.couponCode ? normalizeCouponCode(input.couponCode) : "";
  if (!code) return { ...registrationFeeBreakdown(basePaise, 0, gstRateBp), couponCode: null, couponDescription: null };

  const coupon = await db.query.registrationFeeCoupons.findFirst({ where: eq(registrationFeeCoupons.code, code) });
  assertUsable(coupon, now);
  await assertWithinLimits(coupon, input.ownerId, db);
  if (basePaise === 0) throw couponError("There is no registration fee to reduce.");
  return {
    ...registrationFeeBreakdown(basePaise, registrationCouponDiscount(coupon, basePaise), gstRateBp),
    couponCode: coupon.code,
    couponDescription: coupon.description,
  };
}

/**
 * Inside registerShop's transaction: lock the coupon, check it again for this
 * owner, and return it. The shop row written in the same transaction is the use.
 */
export async function lockRegistrationFeeCoupon(
  tx: DbClient,
  code: string,
  ownerId: string,
  now: Date = new Date(),
): Promise<RegistrationFeeCoupon> {
  const [coupon] = await tx
    .select()
    .from(registrationFeeCoupons)
    .where(eq(registrationFeeCoupons.code, normalizeCouponCode(code)))
    .for("update");
  if (coupon) await touchSellerRow(tx, registrationFeeCoupons, coupon.id);
  assertUsable(coupon, now);
  await assertWithinLimits(coupon, ownerId, tx);
  return coupon;
}

/* ---------------------------------------------------------------- admin */

export interface RegistrationFeeCouponInput {
  code: string;
  description?: string | null;
  discountType: "FLAT" | "PERCENT";
  flatPaise?: number | null;
  percent?: number | null;
  maxDiscountPaise?: number | null;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  usageLimit?: number | null;
  perOwnerLimit?: number | null;
  active?: boolean;
}

export async function listRegistrationFeeCoupons() {
  const [rows, uses] = await Promise.all([
    db.select().from(registrationFeeCoupons).orderBy(desc(registrationFeeCoupons.createdAt)),
    db
      .select({ couponId: shops.registrationFeeCouponId, n: sql<number>`count(*)::int` })
      .from(shops)
      .where(and(sql`${shops.registrationFeeCouponId} IS NOT NULL`, isNull(shops.deletedAt)))
      .groupBy(shops.registrationFeeCouponId),
  ]);
  const byId = new Map(uses.map((u) => [u.couponId, u.n]));
  return rows.map((c) => ({ ...c, uses: byId.get(c.id) ?? 0 }));
}

export async function saveRegistrationFeeCoupon(input: RegistrationFeeCouponInput, actor: Actor, id?: string) {
  const code = normalizeCouponCode(input.code);
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
    startsAt: input.startsAt ?? null,
    expiresAt: input.expiresAt ?? null,
    usageLimit: input.usageLimit ?? null,
    perOwnerLimit: input.perOwnerLimit === undefined ? 1 : input.perOwnerLimit,
    active: input.active ?? true,
    updatedAt: new Date(),
  };
  const clash = await db.query.registrationFeeCoupons.findFirst({ where: eq(registrationFeeCoupons.code, code) });
  if (clash && clash.id !== id) throw conflict("A coupon with that code already exists.");
  let row: RegistrationFeeCoupon | undefined;
  if (id) {
    [row] = await db.update(registrationFeeCoupons).set(values).where(eq(registrationFeeCoupons.id, id)).returning();
    if (!row) throw notFound("Coupon");
  } else {
    [row] = await db.insert(registrationFeeCoupons).values({ ...values, createdBy: actor.id }).returning();
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.REGISTRATION_FEE_COUPON_SAVED,
    entityType: "registration_fee_coupon",
    entityId: row.id,
    newValue: values,
  });
  return row;
}
