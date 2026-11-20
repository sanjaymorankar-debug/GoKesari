/**
 * GoKesari Health Prime (owner brief §5): paid listing plans for doctors' clinics, home-care providers and
 * medical equipment stores — plans, purchase and renewal, expiry with grace, instant booking, priority
 * placement (labelled), virtual numbers with call tracking, profile analytics, pay-per-booking.
 *
 * Money rules come only from data: prices from health.prime_plans (admin-built, paise, per term), the
 * rule health (primeGstBp, primeTermDiscountBp — used only when a plan has no explicit price for a term —,
 * primeGraceDays, payPerBooking, feePerBookingPaise, freeListingManualApproval, telephonyProvider).
 * Nothing about price is in code.
 *
 *  - Plans may be scoped to a city and / or a specialty: a shop sees, per audience and tier, the most
 *    specific ACTIVE plan that applies (city + specialty > city > specialty > general).
 *  - Purchase: quote (price for the term, coupon %, GST 18% shown separately) → prime_subscriptions
 *    PENDING_PAYMENT → payment intent HEALTH_PRIME → on capture (in the capture transaction): ACTIVE from
 *    max(now, the shop's current plan's end) (renewals stack), invoice PRM/<FY>/<000001> (≤ 16 characters), coupon used,
 *    renewal reminder (7 days before) and expiry scheduled; after commit: instant booking on, virtual
 *    number, notice to the owner.
 *  - Expiry: at ends_at → GRACE for primeGraceDays (still Prime) → EXPIRED: Free listing again, virtual
 *    number released, booking requests need the clinic's confirmation again. Bookings already made are
 *    never touched.
 *  - Ranking: Prime only adds a bounded, labelled boost in Find a doctor (find-doctor.ts); Free listings
 *    are never hidden.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { addDays, financialYear, istDateKey } from "@/lib/consult/time";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { PRIME_AUDIENCES, PRIME_FEATURE_LABELS, PRIME_TERM_MONTHS, PRIME_TERMS, PRIME_TERMS_NOTE, PRIME_TIER_LABELS, PRIME_TIERS, type PrimeAudience, type PrimeTerm, type PrimeTier } from "@/lib/health/constants";
import { db, type DbClient } from "@/server/db";
import {
  consultBookings,
  consultCategories,
  consultMemberCategories,
  consultMembers,
  consultProfiles,
  financialAdjustments,
  healthAppointmentLinks,
  healthCareProviderProfiles,
  healthDoctorProfiles,
  healthEquipmentStoreProfiles,
  healthPrimeCoupons,
  healthPrimePlans,
  healthPrimeSubscriptions,
  paymentIntents,
  scheduledNotices,
  shops,
  users,
  type ConsultBooking,
  type HealthPrimeCoupon,
  type HealthPrimePlan,
  type HealthPrimeSubscription,
  type PaymentIntentRow,
  type ScheduledNotice,
} from "@/server/db/schema";
import { createPaymentIntent, isLive, redirectUrlOf, type PaymentIntentRef } from "@/server/payments/intents";
import type { AfterCommit } from "@/server/payments/purpose-handlers";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify, NOTIFICATION_TYPES } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { isHealthStaff, requireHealthEnabled, type HealthActor } from "./access";
import { publishHealthEvent } from "./events";
import { activeVirtualNumber, assignVirtualNumber, bumpProfileStats, recentCalls, releaseVirtualNumber } from "./telephony";
import { nextNumber } from "./timeline";

export const PRIME_PATH = "/shop/health/prime";
export const PRIME_RENEWAL_KIND = "HEALTH_PRIME_RENEWAL";
export const PRIME_EXPIRY_KIND = "HEALTH_PRIME_EXPIRY";
const DAY_MS = 86_400_000;
const TIER_RANK: Record<PrimeTier, number> = { FREE: 0, PRIME: 1, PRIME_PLUS: 2 };

/* ================================================================ prices */

export type TermPrices = Record<PrimeTerm, number | null>;

/**
 * The plan's price for a term, in paise: the explicit price when the admin set one, else the monthly
 * price × months less the rule's term discount. Null: the plan is not offered for that term.
 */
export function termPricePaise(plan: Pick<HealthPrimePlan, "prices">, term: PrimeTerm, termDiscountBp: { QUARTERLY: number; YEARLY: number }): number | null {
  const prices = (plan.prices ?? {}) as Partial<Record<PrimeTerm, number | null>>;
  const explicit = prices[term];
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) return Math.round(explicit);
  const monthly = prices.MONTHLY;
  if (typeof monthly !== "number" || !Number.isFinite(monthly) || monthly < 0) return null;
  if (term === "MONTHLY") return Math.round(monthly);
  const months = PRIME_TERM_MONTHS[term];
  return Math.round((monthly * months * (10_000 - termDiscountBp[term])) / 10_000);
}

export function termPrices(plan: Pick<HealthPrimePlan, "prices">, termDiscountBp: { QUARTERLY: number; YEARLY: number }): TermPrices {
  return { MONTHLY: termPricePaise(plan, "MONTHLY", termDiscountBp), QUARTERLY: termPricePaise(plan, "QUARTERLY", termDiscountBp), YEARLY: termPricePaise(plan, "YEARLY", termDiscountBp) };
}

/** Coupon % off the plan price, then GST on what is left (GST is always shown on its own line). */
export function priceBreakdown(pricePaise: number, percentOff: number, gstBp: number): { discountPaise: number; taxablePaise: number; gstPaise: number; totalPaise: number } {
  const discountPaise = Math.min(pricePaise, Math.round((pricePaise * Math.max(0, Math.min(100, percentOff))) / 100));
  const taxablePaise = pricePaise - discountPaise;
  const gstPaise = Math.round((taxablePaise * gstBp) / 10_000);
  return { discountPaise, taxablePaise, gstPaise, totalPaise: taxablePaise + gstPaise };
}

/** Calendar months later (the 31st becomes the month's last day). */
export function addMonths(at: Date, months: number): Date {
  const d = new Date(at.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/* ================================================================ plans */

export interface PrimePlanView {
  id: string;
  code: string;
  name: string;
  audience: PrimeAudience;
  tier: PrimeTier;
  tierLabel: string;
  description: string | null;
  features: Record<string, boolean>;
  featureList: string[];
  quotas: Record<string, number>;
  prices: Record<string, number | null>;
  termPrices: TermPrices;
  city: string | null;
  specialty: string | null;
  status: string;
  sortOrder: number;
}

function toView(p: HealthPrimePlan, discount: { QUARTERLY: number; YEARLY: number }): PrimePlanView {
  const features = (p.features ?? {}) as Record<string, boolean>;
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    audience: p.audience as PrimeAudience,
    tier: p.tier as PrimeTier,
    tierLabel: PRIME_TIER_LABELS[p.tier as PrimeTier] ?? p.tier,
    description: p.description,
    features,
    featureList: Object.entries(features)
      .filter(([, on]) => on)
      .map(([k]) => PRIME_FEATURE_LABELS[k] ?? k),
    quotas: (p.quotas ?? {}) as Record<string, number>,
    prices: (p.prices ?? {}) as Record<string, number | null>,
    termPrices: termPrices(p, discount),
    city: p.city,
    specialty: p.specialty,
    status: p.status,
    sortOrder: p.sortOrder,
  };
}

/** Plans (ACTIVE only unless asked), for an audience or all, in display order. */
export async function listPlans(audience?: PrimeAudience | null, options: { includeInactive?: boolean } = {}): Promise<PrimePlanView[]> {
  const rule = await getRule("health");
  const where = [];
  if (audience) where.push(eq(healthPrimePlans.audience, audience));
  if (!options.includeInactive) where.push(eq(healthPrimePlans.status, "ACTIVE"));
  const rows = await db
    .select()
    .from(healthPrimePlans)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(healthPrimePlans.sortOrder), asc(healthPrimePlans.code));
  return rows.map((p) => toView(p, rule.primeTermDiscountBp));
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export interface ShopScope {
  shopId: string;
  shopName: string;
  ownerId: string;
  city: string;
  specialties: Set<string>;
  audiences: PrimeAudience[];
}

/** Which Prime audiences a shop belongs to, its city and its doctors' specialties (slugs and names). */
export async function shopScope(shopId: string, client: DbClient = db): Promise<ShopScope> {
  const [shop] = await client.select({ id: shops.id, name: shops.name, ownerId: shops.ownerId, city: shops.city, shopType: shops.shopType, deletedAt: shops.deletedAt }).from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.deletedAt) throw notFound("Shop");
  const [dp, care, equip, cats] = await Promise.all([
    client.select({ specialties: healthDoctorProfiles.specialties }).from(healthDoctorProfiles).where(eq(healthDoctorProfiles.shopId, shopId)),
    client.select({ id: healthCareProviderProfiles.id }).from(healthCareProviderProfiles).where(eq(healthCareProviderProfiles.shopId, shopId)).limit(1),
    client.select({ id: healthEquipmentStoreProfiles.shopId }).from(healthEquipmentStoreProfiles).where(eq(healthEquipmentStoreProfiles.shopId, shopId)).limit(1),
    client
      .select({ slug: consultCategories.slug, name: consultCategories.name, requiredDoc: consultCategories.requiredDoc })
      .from(consultMemberCategories)
      .innerJoin(consultMembers, eq(consultMembers.id, consultMemberCategories.memberId))
      .innerJoin(consultCategories, eq(consultCategories.id, consultMemberCategories.categoryId))
      .where(and(eq(consultMembers.shopId, shopId), eq(consultMembers.status, "ACTIVE"))),
  ]);
  const audiences: PrimeAudience[] = [];
  if (dp.length || shop.shopType === "DOCTOR_CLINIC" || shop.shopType === "SUPER_SPECIALITY_CLINIC" || cats.some((c) => c.requiredDoc === "MEDICAL_REGISTRATION")) audiences.push("DOCTOR");
  if (care.length) audiences.push("CARE_PROVIDER");
  if (equip.length || shop.shopType === "MEDICAL_EQUIPMENT") audiences.push("EQUIPMENT_STORE");
  const specialties = new Set<string>();
  for (const c of cats) {
    specialties.add(norm(c.slug));
    specialties.add(norm(c.name));
  }
  for (const d of dp) for (const s of d.specialties ?? []) specialties.add(norm(s));
  return { shopId, shopName: shop.name, ownerId: shop.ownerId, city: shop.city, specialties, audiences };
}

/** How specific a plan is for a shop (higher wins), or null when it does not apply there. */
export function planSpecificity(plan: Pick<HealthPrimePlan, "city" | "specialty">, scope: Pick<ShopScope, "city" | "specialties">): number | null {
  if (plan.city && norm(plan.city) !== norm(scope.city)) return null;
  if (plan.specialty && !scope.specialties.has(norm(plan.specialty))) return null;
  return (plan.city ? 2 : 0) + (plan.specialty ? 1 : 0);
}

/** Per audience and tier, the most specific active plan for the shop. */
export function pickEffectivePlans<T extends Pick<HealthPrimePlan, "audience" | "tier" | "city" | "specialty" | "sortOrder" | "status">>(plans: readonly T[], scope: Pick<ShopScope, "city" | "specialties" | "audiences">): T[] {
  const best = new Map<string, { plan: T; score: number }>();
  for (const p of plans) {
    if (p.status !== "ACTIVE" || !scope.audiences.includes(p.audience as PrimeAudience)) continue;
    const score = planSpecificity(p, scope);
    if (score == null) continue;
    const key = `${p.audience}:${p.tier}`;
    const cur = best.get(key);
    if (!cur || score > cur.score || (score === cur.score && p.sortOrder < cur.plan.sortOrder)) best.set(key, { plan: p, score });
  }
  return [...best.values()].map((v) => v.plan).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** The plans this shop can see and buy (prices as it will pay them). */
export async function plansForShop(shopId: string): Promise<PrimePlanView[]> {
  const [scope, rule] = await Promise.all([shopScope(shopId), getRule("health")]);
  const rows = await db.select().from(healthPrimePlans).where(eq(healthPrimePlans.status, "ACTIVE"));
  return pickEffectivePlans(rows, scope).map((p) => toView(p, rule.primeTermDiscountBp));
}

/* ================================================================ tier */

export interface PrimeTierInfo {
  shopId: string;
  tier: PrimeTier;
  label: string;
  features: Record<string, boolean>;
  quotas: Record<string, number>;
  subscriptionId: string | null;
  planId: string | null;
  planName: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  graceUntil: Date | null;
  inGrace: boolean;
}

type SubWithPlan = { s: HealthPrimeSubscription; p: HealthPrimePlan };

async function effectiveSubs(shopIds: readonly string[], now: Date, client: DbClient = db): Promise<SubWithPlan[]> {
  if (!shopIds.length) return [];
  const graceDays = (await getRule("health")).primeGraceDays;
  const at = now.toISOString();
  return client
    .select({ s: healthPrimeSubscriptions, p: healthPrimePlans })
    .from(healthPrimeSubscriptions)
    .innerJoin(healthPrimePlans, eq(healthPrimePlans.id, healthPrimeSubscriptions.planId))
    .where(
      and(
        inArray(healthPrimeSubscriptions.shopId, shopIds as string[]),
        inArray(healthPrimeSubscriptions.status, ["ACTIVE", "GRACE"]),
        lte(healthPrimeSubscriptions.startsAt, now),
        sql`${at}::timestamptz < coalesce(${healthPrimeSubscriptions.graceUntil}, ${healthPrimeSubscriptions.endsAt} + make_interval(days => ${graceDays}::int))`,
      ),
    );
}

function tierFrom(shopId: string, subs: SubWithPlan[], now: Date): PrimeTierInfo {
  const best = subs
    .filter((x) => x.s.shopId === shopId)
    .sort((a, b) => TIER_RANK[b.s.tier as PrimeTier] - TIER_RANK[a.s.tier as PrimeTier] || (b.s.endsAt?.getTime() ?? 0) - (a.s.endsAt?.getTime() ?? 0))[0];
  if (!best) return { shopId, tier: "FREE", label: PRIME_TIER_LABELS.FREE, features: {}, quotas: {}, subscriptionId: null, planId: null, planName: null, startsAt: null, endsAt: null, graceUntil: null, inGrace: false };
  const tier = best.s.tier as PrimeTier;
  return {
    shopId,
    tier,
    label: PRIME_TIER_LABELS[tier],
    features: (best.p.features ?? {}) as Record<string, boolean>,
    quotas: (best.p.quotas ?? {}) as Record<string, number>,
    subscriptionId: best.s.id,
    planId: best.p.id,
    planName: best.p.name,
    startsAt: best.s.startsAt,
    endsAt: best.s.endsAt,
    graceUntil: best.s.graceUntil,
    inGrace: best.s.status === "GRACE" || (best.s.endsAt != null && best.s.endsAt.getTime() <= now.getTime()),
  };
}

/** The shop's tier now: an ACTIVE plan, or one in its grace days, counts; otherwise the Free listing. */
export async function primeTierForShop(shopId: string, now: Date = new Date(), client: DbClient = db): Promise<PrimeTierInfo> {
  const info = tierFrom(shopId, await effectiveSubs([shopId], now, client), now);
  if (info.tier !== "FREE") return info;
  // Free: the Free plan's features for the shop's audience, when the admin built one.
  try {
    const scope = await shopScope(shopId, client);
    const rows = await client.select().from(healthPrimePlans).where(and(eq(healthPrimePlans.status, "ACTIVE"), eq(healthPrimePlans.tier, "FREE")));
    const free = pickEffectivePlans(rows, scope)[0];
    if (free) return { ...info, features: (free.features ?? {}) as Record<string, boolean>, quotas: (free.quotas ?? {}) as Record<string, number>, planId: free.id, planName: free.name };
  } catch {
    /* a shop that is gone stays Free */
  }
  return info;
}

/** Tiers of many shops at once (search ranking). Free shops get empty features. */
export async function primeTiersForShops(shopIds: readonly string[], now: Date = new Date()): Promise<Map<string, PrimeTierInfo>> {
  const ids = [...new Set(shopIds)];
  const subs = await effectiveSubs(ids, now);
  return new Map(ids.map((id) => [id, tierFrom(id, subs, now)]));
}

/* ================================================================ access */

/** The shop's owner (buys, sees invoices and analytics) or Health staff; anyone else gets a 404. */
export async function requirePrimeAccess(shopId: string, actor: HealthActor): Promise<{ role: "OWNER" | "STAFF"; ownerId: string }> {
  const [shop] = await db.select({ ownerId: shops.ownerId, deletedAt: shops.deletedAt }).from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.deletedAt) throw notFound("Shop");
  if (shop.ownerId === actor.id) return { role: "OWNER", ownerId: shop.ownerId };
  if (isHealthStaff(actor)) return { role: "STAFF", ownerId: shop.ownerId };
  throw notFound("Shop");
}

function requireStaff(actor: HealthActor): void {
  if (!isHealthStaff(actor)) throw forbidden("Only GoKesari Health staff can change Prime plans and coupons.");
}

/* ================================================================ quote */

export const purchaseInput = z.object({
  planId: z.string().uuid(),
  term: z.enum(PRIME_TERMS),
  couponCode: z
    .string()
    .trim()
    .max(40)
    .transform((s) => s.toUpperCase())
    .nullish(),
});

export interface PrimeQuote {
  planId: string;
  planCode: string;
  planName: string;
  tier: PrimeTier;
  audience: PrimeAudience;
  term: PrimeTerm;
  months: number;
  /** Monthly price × months (what the term would cost month by month). */
  listPaise: number | null;
  pricePaise: number;
  termSavingPaise: number;
  couponCode: string | null;
  couponPercent: number;
  discountPaise: number;
  taxablePaise: number;
  gstBp: number;
  gstPaise: number;
  totalPaise: number;
}

async function validCoupon(code: string | null | undefined, now: Date, client: DbClient = db): Promise<HealthPrimeCoupon | null> {
  if (!code) return null;
  const [c] = await client.select().from(healthPrimeCoupons).where(eq(healthPrimeCoupons.code, code.toUpperCase()));
  const bad = (msg: string) => validationFailed(msg, { fields: { couponCode: msg } });
  if (!c || c.status !== "ACTIVE") throw bad("This coupon code is not valid.");
  if (c.validUntil && c.validUntil.getTime() <= now.getTime()) throw bad("This coupon has expired.");
  if (c.maxUses != null && c.used >= c.maxUses) throw bad("This coupon has been used up.");
  return c;
}

/** What the shop would pay for a plan and term (with an optional coupon) — computed on the server only. */
export async function quotePrime(shopId: string, raw: unknown, now: Date = new Date()): Promise<PrimeQuote> {
  const input = purchaseInput.parse(raw);
  const rule = await getRule("health");
  const scope = await shopScope(shopId);
  if (!scope.audiences.length) throw forbidden("Prime is for doctors' clinics, home-care providers and medical equipment stores.");
  const rows = await db.select().from(healthPrimePlans).where(eq(healthPrimePlans.status, "ACTIVE"));
  const plan = pickEffectivePlans(rows, scope).find((p) => p.id === input.planId);
  if (!plan) throw notFound("Plan");
  if (plan.tier === "FREE") throw validationFailed("The Free listing needs no plan.");
  const price = termPricePaise(plan, input.term, rule.primeTermDiscountBp);
  if (price == null) throw validationFailed("This plan is not offered for that term.", { fields: { term: "Not offered." } });
  const coupon = await validCoupon(input.couponCode, now);
  const months = PRIME_TERM_MONTHS[input.term];
  const monthly = termPricePaise(plan, "MONTHLY", rule.primeTermDiscountBp);
  const listPaise = monthly == null ? null : monthly * months;
  const parts = priceBreakdown(price, coupon?.percentOff ?? 0, rule.primeGstBp);
  return {
    planId: plan.id,
    planCode: plan.code,
    planName: plan.name,
    tier: plan.tier as PrimeTier,
    audience: plan.audience as PrimeAudience,
    term: input.term,
    months,
    listPaise,
    pricePaise: price,
    termSavingPaise: listPaise != null ? Math.max(0, listPaise - price) : 0,
    couponCode: coupon?.code ?? null,
    couponPercent: coupon?.percentOff ?? 0,
    gstBp: rule.primeGstBp,
    ...parts,
  };
}

/* ================================================================ purchase */

/**
 * The owner buys (or renews) a plan: a PENDING_PAYMENT subscription and its payment. A fully discounted
 * plan (100% coupon) is active at once. Returns where to pay.
 */
export async function startPrimePurchase(
  shopId: string,
  raw: unknown,
  actor: HealthActor,
  now: Date = new Date(),
): Promise<{ subscription: HealthPrimeSubscription; checkoutUrl: string | null; intentId: string | null; quote: PrimeQuote }> {
  await requireHealthEnabled();
  const access = await requirePrimeAccess(shopId, actor);
  if (access.role !== "OWNER") throw forbidden("Only the shop's owner can buy a plan.");
  const quote = await quotePrime(shopId, raw, now);
  // A purchase already waiting for the same payment: reuse its checkout (never two charges for one click).
  const pending = await db
    .select()
    .from(healthPrimeSubscriptions)
    .where(and(eq(healthPrimeSubscriptions.shopId, shopId), eq(healthPrimeSubscriptions.status, "PENDING_PAYMENT"), eq(healthPrimeSubscriptions.planId, quote.planId), eq(healthPrimeSubscriptions.term, quote.term), eq(healthPrimeSubscriptions.totalPaise, quote.totalPaise)))
    .orderBy(desc(healthPrimeSubscriptions.createdAt))
    .limit(1);
  if (pending[0]?.paymentIntentId && (pending[0].couponCode ?? null) === quote.couponCode) {
    const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, pending[0].paymentIntentId));
    if (intent && isLive(intent)) return { subscription: pending[0], checkoutUrl: redirectUrlOf(intent), intentId: intent.id, quote };
  }
  const [sub] = await db
    .insert(healthPrimeSubscriptions)
    .values({
      shopId,
      planId: quote.planId,
      tier: quote.tier,
      term: quote.term,
      status: "PENDING_PAYMENT",
      pricePaise: quote.pricePaise,
      discountPaise: quote.discountPaise,
      gstPaise: quote.gstPaise,
      totalPaise: quote.totalPaise,
      couponCode: quote.couponCode,
      boughtBy: actor.id,
    })
    .returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_PRIME_SUBSCRIPTION, entityType: "health_prime_subscription", entityId: sub.id, newValue: { event: "started", shopId, planCode: quote.planCode, term: quote.term, totalPaise: quote.totalPaise, couponCode: quote.couponCode } });

  if (quote.totalPaise <= 0) {
    const tasks: (() => Promise<void>)[] = [];
    await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(healthPrimeSubscriptions).where(eq(healthPrimeSubscriptions.id, sub.id)).for("update");
      await activateSubscription(tx, locked, now, (t) => void tasks.push(t));
    });
    for (const t of tasks) await t().catch((e) => console.error("[health] prime after-activation step failed", sub.id, e));
    const [after] = await db.select().from(healthPrimeSubscriptions).where(eq(healthPrimeSubscriptions.id, sub.id));
    return { subscription: after, checkoutUrl: null, intentId: null, quote };
  }

  const [owner] = await db.select({ name: users.name, email: users.email, phone: users.phone }).from(users).where(eq(users.id, actor.id));
  const created = await createPaymentIntent({
    purpose: "HEALTH_PRIME",
    referenceId: sub.id,
    userId: actor.id,
    amountPaise: quote.totalPaise,
    customer: { id: actor.id, name: owner?.name ?? actor.name ?? "GoKesari seller", email: owner?.email ?? null, phone: owner?.phone ?? null },
    description: `GoKesari Health ${quote.planName} (${quote.term.toLowerCase()})`,
    idempotencyKey: `health-prime:${sub.id}`,
    mode: "CHECKOUT",
    returnPath: `${PRIME_PATH}?shopId=${shopId}&paid=${sub.id}`,
  });
  const [updated] = await db.update(healthPrimeSubscriptions).set({ paymentIntentId: created.intent.id, updatedAt: new Date() }).where(eq(healthPrimeSubscriptions.id, sub.id)).returning();
  const checkoutUrl = created.checkout ? (created.checkout.kind === "HOSTED_URL" ? created.checkout.url : (created.checkout.url ?? null)) : created.linkUrl;
  return { subscription: updated, checkoutUrl, intentId: created.intent.id, quote };
}

const renewalKey = (id: string) => `health-prime-renewal:${id}`;
const expiryKey = (id: string) => `health-prime-expiry:${id}`;
const graceKey = (id: string) => `health-prime-grace:${id}`;

async function scheduleNotice(client: DbClient, kind: string, key: string, dueAt: Date, payload: Record<string, string>, now: Date): Promise<void> {
  await client
    .insert(scheduledNotices)
    .values({ kind, key, dueAt, payload })
    .onConflictDoUpdate({ target: scheduledNotices.key, set: { kind, dueAt, payload, sentAt: null, cancelledAt: null, updatedAt: now } });
}

/**
 * Makes a paid (or fully discounted) subscription ACTIVE, inside the caller's transaction (the subscription
 * row locked). Renewals stack after the shop's current plan. Side effects go to afterCommit.
 */
async function activateSubscription(client: DbClient, sub: HealthPrimeSubscription, now: Date, afterCommit: AfterCommit): Promise<HealthPrimeSubscription | null> {
  if (sub.invoiceNumber || (sub.status !== "PENDING_PAYMENT" && sub.status !== "CANCELLED")) return null;
  // One activation per shop at a time, so two renewals paid together still stack.
  await client.execute(sql`select pg_advisory_xact_lock(hashtext(${`health-prime:${sub.shopId}`}))`);
  const [plan] = await client.select().from(healthPrimePlans).where(eq(healthPrimePlans.id, sub.planId));
  const [{ lastEnd }] = await client
    .select({ lastEnd: sql<string | null>`max(${healthPrimeSubscriptions.endsAt})` })
    .from(healthPrimeSubscriptions)
    .where(and(eq(healthPrimeSubscriptions.shopId, sub.shopId), ne(healthPrimeSubscriptions.id, sub.id), eq(healthPrimeSubscriptions.status, "ACTIVE"), gt(healthPrimeSubscriptions.endsAt, now)));
  const startsAt = lastEnd && new Date(lastEnd).getTime() > now.getTime() ? new Date(lastEnd) : now;
  const endsAt = addMonths(startsAt, PRIME_TERM_MONTHS[sub.term as PrimeTerm] ?? 1);
  const fy = financialYear(now);
  const n = await nextNumber(client, `PRIME-${fy}`);
  // GST Rule 46: at most 16 characters — PRM/<yyyy-yy as yyyy>/<000001>, e.g. PRM/2627/000001.
  const invoiceNumber = `PRM/${fy.replace(/^20(\d\d)-(\d\d)$/, "$1$2")}/${String(n).padStart(6, "0")}`;
  const [active] = await client
    .update(healthPrimeSubscriptions)
    .set({ status: "ACTIVE", startsAt, endsAt, graceUntil: null, invoiceNumber, updatedAt: now })
    .where(eq(healthPrimeSubscriptions.id, sub.id))
    .returning();
  if (sub.couponCode) await client.update(healthPrimeCoupons).set({ used: sql`${healthPrimeCoupons.used} + 1` }).where(eq(healthPrimeCoupons.code, sub.couponCode));
  const remindAt = new Date(Math.max(now.getTime(), endsAt.getTime() - 7 * DAY_MS));
  await scheduleNotice(client, PRIME_RENEWAL_KIND, renewalKey(sub.id), remindAt, { subscriptionId: sub.id }, now);
  await scheduleNotice(client, PRIME_EXPIRY_KIND, expiryKey(sub.id), endsAt, { subscriptionId: sub.id, stage: "END" }, now);
  const [shop] = await client.select({ ownerId: shops.ownerId, name: shops.name }).from(shops).where(eq(shops.id, sub.shopId));
  await publishHealthEvent({ name: "prime.subscribed", userIds: [shop?.ownerId], shopId: sub.shopId, subjectId: sub.id, payload: { subscriptionId: sub.id, tier: sub.tier, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } }, client);
  await recordAudit({ actorId: sub.boughtBy, action: AUDIT_ACTIONS.HEALTH_PRIME_SUBSCRIPTION, entityType: "health_prime_subscription", entityId: sub.id, newValue: { event: "activated", invoiceNumber, startsAt, endsAt, totalPaise: sub.totalPaise } }, client);
  const features = (plan?.features ?? {}) as Record<string, boolean>;
  afterCommit(async () => {
    await syncInstantBooking(sub.shopId);
    if (features.virtualNumber) await assignVirtualNumber(sub.shopId);
    if (shop?.ownerId) {
      const from = startsAt.getTime() > now.getTime() + 60_000 ? ` from ${istDateKey(startsAt)}` : "";
      await notify({
        userId: shop.ownerId,
        type: NOTIFICATION_TYPES.HEALTH_PRIME,
        vars: { text: `${plan?.name ?? "Prime"} for ${shop.name} is active${from} until ${istDateKey(endsAt)}. Tax invoice ${invoiceNumber}.` },
        actionUrl: `${PRIME_PATH}?shopId=${sub.shopId}`,
        channels: ["PUSH"],
        dedupeKey: `health-prime-active:${sub.id}`,
        metadata: { subscriptionId: sub.id },
      });
    }
  });
  return active;
}

/** Purpose handler (purpose-handlers.ts), inside the capture transaction. */
export async function onPrimePaymentCaptured(intent: PaymentIntentRef, client: DbClient, afterCommit?: AfterCommit): Promise<void> {
  const [sub] = await client.select().from(healthPrimeSubscriptions).where(eq(healthPrimeSubscriptions.id, intent.referenceId)).for("update");
  if (!sub || sub.invoiceNumber) return;
  if (intent.amountPaise !== sub.totalPaise) {
    await recordAudit({ action: AUDIT_ACTIONS.HEALTH_PRIME_SUBSCRIPTION, entityType: "health_prime_subscription", entityId: sub.id, newValue: { problem: "amount_mismatch", intentId: intent.id, intentAmount: intent.amountPaise, expected: sub.totalPaise } }, client);
  }
  if (sub.paymentIntentId !== intent.id) await client.update(healthPrimeSubscriptions).set({ paymentIntentId: intent.id }).where(eq(healthPrimeSubscriptions.id, sub.id));
  // processing.ts always passes afterCommit; a direct caller outside a transaction may run the steps at once.
  const later: AfterCommit = afterCommit ?? ((task) => void task().catch((e) => console.error("[health] prime after-capture step failed", sub.id, e)));
  await activateSubscription(client, { ...sub, paymentIntentId: intent.id }, new Date(), later);
}

/** Purpose handler (ended-handlers.ts): an unpaid purchase is cancelled. */
export async function onPrimePaymentEnded(intent: PaymentIntentRow, to: "FAILED" | "EXPIRED", client: DbClient): Promise<void> {
  const [sub] = await client.select().from(healthPrimeSubscriptions).where(eq(healthPrimeSubscriptions.id, intent.referenceId)).for("update");
  if (!sub || sub.status !== "PENDING_PAYMENT" || (sub.paymentIntentId && sub.paymentIntentId !== intent.id)) return;
  await client.update(healthPrimeSubscriptions).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(healthPrimeSubscriptions.id, sub.id));
  await recordAudit({ action: AUDIT_ACTIONS.HEALTH_PRIME_SUBSCRIPTION, entityType: "health_prime_subscription", entityId: sub.id, newValue: { event: "payment_ended", to, intentId: intent.id } }, client);
}

/* ================================================================ renewal / expiry */

/** HEALTH_PRIME_RENEWAL: 7 days before the end, unless the shop already renewed. */
export async function sendPrimeRenewalNotice(notice: ScheduledNotice, now: Date = new Date()): Promise<boolean> {
  const id = notice.payload.subscriptionId;
  if (!id) return false;
  const [row] = await db.select({ s: healthPrimeSubscriptions, p: healthPrimePlans, shopName: shops.name, ownerId: shops.ownerId }).from(healthPrimeSubscriptions).innerJoin(healthPrimePlans, eq(healthPrimePlans.id, healthPrimeSubscriptions.planId)).innerJoin(shops, eq(shops.id, healthPrimeSubscriptions.shopId)).where(eq(healthPrimeSubscriptions.id, id));
  if (!row || row.s.status !== "ACTIVE" || !row.s.endsAt || !row.s.autoRenewReminders) return false;
  const [renewed] = await db
    .select({ id: healthPrimeSubscriptions.id })
    .from(healthPrimeSubscriptions)
    .where(and(eq(healthPrimeSubscriptions.shopId, row.s.shopId), ne(healthPrimeSubscriptions.id, id), eq(healthPrimeSubscriptions.status, "ACTIVE"), gt(healthPrimeSubscriptions.endsAt, row.s.endsAt)))
    .limit(1);
  if (renewed) return false;
  void now;
  await notify({
    userId: row.ownerId,
    type: NOTIFICATION_TYPES.HEALTH_PRIME_RENEWAL,
    vars: { plan: row.p.name, shopName: row.shopName, endsOn: istDateKey(row.s.endsAt) },
    actionUrl: `${PRIME_PATH}?shopId=${row.s.shopId}`,
    channels: ["PUSH"],
    dedupeKey: `${notice.key}:${row.s.endsAt.getTime()}`,
    metadata: { subscriptionId: id },
  });
  await publishHealthEvent({ name: "prime.renewal_due", userIds: [row.ownerId], shopId: row.s.shopId, subjectId: id, payload: { subscriptionId: id, endsAt: row.s.endsAt.toISOString() } });
  return true;
}

/**
 * HEALTH_PRIME_EXPIRY. Stage END (at ends_at): GRACE until ends_at + primeGraceDays (another notice then) —
 * or EXPIRED at once when a renewal already follows or there are no grace days. Stage GRACE_END: EXPIRED.
 * Once the shop has no Prime left: back to the Free listing (virtual number released, booking requests
 * confirmed by the clinic). Bookings are never touched.
 */
export async function applyPrimeExpiryNotice(notice: ScheduledNotice, now: Date = new Date()): Promise<boolean> {
  const id = notice.payload.subscriptionId;
  const stage = notice.payload.stage === "GRACE_END" ? "GRACE_END" : "END";
  if (!id) return false;
  const rule = await getRule("health");
  const outcome = await db.transaction(async (tx) => {
    const [sub] = await tx.select().from(healthPrimeSubscriptions).where(eq(healthPrimeSubscriptions.id, id)).for("update");
    if (!sub || !sub.endsAt) return null;
    if (stage === "END") {
      if (sub.status !== "ACTIVE" || sub.endsAt.getTime() > now.getTime() + 60_000) return null;
      const [next] = await tx
        .select({ id: healthPrimeSubscriptions.id })
        .from(healthPrimeSubscriptions)
        .where(and(eq(healthPrimeSubscriptions.shopId, sub.shopId), ne(healthPrimeSubscriptions.id, sub.id), eq(healthPrimeSubscriptions.status, "ACTIVE"), lte(healthPrimeSubscriptions.startsAt, sub.endsAt), gt(healthPrimeSubscriptions.endsAt, now)))
        .limit(1);
      if (next || rule.primeGraceDays === 0) {
        await tx.update(healthPrimeSubscriptions).set({ status: "EXPIRED", updatedAt: now }).where(eq(healthPrimeSubscriptions.id, id));
        return { sub, to: "EXPIRED" as const, renewed: Boolean(next) };
      }
      const graceUntil = new Date(sub.endsAt.getTime() + rule.primeGraceDays * DAY_MS);
      await tx.update(healthPrimeSubscriptions).set({ status: "GRACE", graceUntil, updatedAt: now }).where(eq(healthPrimeSubscriptions.id, id));
      await scheduleNotice(tx, PRIME_EXPIRY_KIND, graceKey(id), graceUntil, { subscriptionId: id, stage: "GRACE_END" }, now);
      return { sub: { ...sub, graceUntil }, to: "GRACE" as const, renewed: false };
    }
    if (sub.status !== "GRACE" || (sub.graceUntil && sub.graceUntil.getTime() > now.getTime() + 60_000)) return null;
    await tx.update(healthPrimeSubscriptions).set({ status: "EXPIRED", updatedAt: now }).where(eq(healthPrimeSubscriptions.id, id));
    return { sub, to: "EXPIRED" as const, renewed: false };
  });
  if (!outcome) return false;
  const { sub } = outcome;
  const [shop] = await db.select({ ownerId: shops.ownerId, name: shops.name }).from(shops).where(eq(shops.id, sub.shopId));
  await recordAudit({ action: AUDIT_ACTIONS.HEALTH_PRIME_SUBSCRIPTION, entityType: "health_prime_subscription", entityId: id, newValue: { event: outcome.to === "GRACE" ? "grace" : "expired", renewed: outcome.renewed } });
  if (outcome.to === "GRACE") {
    if (shop) {
      await notify({
        userId: shop.ownerId,
        type: NOTIFICATION_TYPES.HEALTH_PRIME,
        vars: { text: `Your Prime plan for ${shop.name} ended on ${istDateKey(sub.endsAt!)}. Prime stays on until ${istDateKey(sub.graceUntil!)}; renew before then to keep instant booking and priority placement. Bookings already made stay valid.` },
        actionUrl: `${PRIME_PATH}?shopId=${sub.shopId}`,
        channels: ["PUSH"],
        dedupeKey: `health-prime-grace:${id}`,
        metadata: { subscriptionId: id },
      });
    }
    await publishHealthEvent({ name: "prime.renewal_due", userIds: [shop?.ownerId], shopId: sub.shopId, subjectId: id, payload: { subscriptionId: id, stage: "GRACE", graceUntil: sub.graceUntil?.toISOString() ?? null } });
    return true;
  }
  const tier = await primeTierForShop(sub.shopId, now);
  if (tier.tier === "FREE" || !tier.features.virtualNumber) await releaseVirtualNumber(sub.shopId, now);
  await syncInstantBooking(sub.shopId, now);
  if (tier.tier === "FREE") {
    await publishHealthEvent({ name: "prime.expired", userIds: [shop?.ownerId], shopId: sub.shopId, subjectId: id, payload: { subscriptionId: id } });
    if (shop) {
      await notify({
        userId: shop.ownerId,
        type: NOTIFICATION_TYPES.HEALTH_PRIME,
        vars: { text: `Prime for ${shop.name} has ended; your profile is on the Free listing again. Bookings already made stay valid. Renew any time from your Prime page.` },
        actionUrl: `${PRIME_PATH}?shopId=${sub.shopId}`,
        channels: ["PUSH"],
        dedupeKey: `health-prime-expired:${id}`,
        metadata: { subscriptionId: id },
      });
    }
  }
  return true;
}

/* ================================================================ instant booking */

/**
 * Rule health.freeListingManualApproval on: a clinic with a health doctor profile takes booking requests it
 * confirms while it is on the Free listing, and instant bookings while Prime / Prime Plus (with instant
 * booking) is on. Returns the manual-approval setting written, or null when nothing applies.
 */
export async function syncInstantBooking(shopId: string, now: Date = new Date()): Promise<boolean | null> {
  const rule = await getRule("health");
  if (!rule.freeListingManualApproval) return null;
  const [dp] = await db.select({ id: healthDoctorProfiles.id }).from(healthDoctorProfiles).where(eq(healthDoctorProfiles.shopId, shopId)).limit(1);
  if (!dp) return null;
  const tier = await primeTierForShop(shopId, now);
  const manual = !(tier.tier !== "FREE" && tier.features.instantBooking !== false);
  const rows = await db.update(consultProfiles).set({ manualApproval: manual, updatedAt: now }).where(and(eq(consultProfiles.shopId, shopId), ne(consultProfiles.manualApproval, manual))).returning({ id: consultProfiles.id });
  if (rows.length) await recordAudit({ action: AUDIT_ACTIONS.HEALTH_PRIME_SUBSCRIPTION, entityType: "consult_profile", entityId: rows[0].id, newValue: { event: "instant_booking", manualApproval: manual, tier: tier.tier } });
  return manual;
}

/** Re-applies the Free / Prime booking mode to every clinic with a doctor profile (after the rule changes). */
export async function syncInstantBookingForAllClinics(actor: HealthActor, now: Date = new Date()): Promise<{ clinics: number }> {
  requireStaff(actor);
  const rows = await db.selectDistinct({ shopId: healthDoctorProfiles.shopId }).from(healthDoctorProfiles);
  for (const r of rows) await syncInstantBooking(r.shopId, now);
  return { clinics: rows.length };
}

/* ================================================================ analytics */

/** One public profile view (IST day). Never throws. */
export async function recordProfileView(shopId: string, now: Date = new Date()): Promise<void> {
  try {
    await bumpProfileStats(shopId, now, { views: 1 });
  } catch (error) {
    console.error("[health] profile view not counted", shopId, error);
  }
}

export interface ProfileAnalytics {
  days: number;
  views: number;
  calls: number;
  missedCalls: number;
  bookings: number;
  /** Bookings per 100 profile views. */
  conversionPct: number | null;
}

export async function profileAnalytics(shopId: string, days: number, now: Date = new Date()): Promise<ProfileAnalytics> {
  const from = addDays(istDateKey(now), -(days - 1));
  const [r] = await db.execute<{ views: number; calls: number; missed: number; bookings: number }>(sql`
    select coalesce(sum(views), 0)::int as views, coalesce(sum(calls), 0)::int as calls,
           coalesce(sum(missed_calls), 0)::int as missed, coalesce(sum(bookings), 0)::int as bookings
      from health.profile_stats where shop_id = ${shopId} and day >= ${from}::date`);
  const views = Number(r?.views ?? 0);
  const bookings = Number(r?.bookings ?? 0);
  return { days, views, calls: Number(r?.calls ?? 0), missedCalls: Number(r?.missed ?? 0), bookings, conversionPct: views > 0 ? Math.round((bookings / views) * 1000) / 10 : null };
}

/* ================================================================ bookings */

/**
 * A new Health booking (booking.ts, after it is created): counted in the clinic's stats; with rule
 * payPerBooking on, a Free-listing clinic is charged feePerBookingPaise from its payout for a NEW patient
 * (one with no earlier live booking at that clinic) — once per booking. Prime clinics are not charged
 * (pay-per-booking is the "no subscription" model). Never throws.
 */
export async function onHealthBookingCreated(booking: ConsultBooking): Promise<void> {
  try {
    await bumpProfileStats(booking.shopId, booking.createdAt ?? new Date(), { bookings: 1 });
  } catch (error) {
    console.error("[health] booking not counted", booking.id, error);
  }
  try {
    await chargePerBooking(booking);
  } catch (error) {
    console.error("[health] pay-per-booking fee failed", booking.id, error);
  }
}

export async function chargePerBooking(booking: ConsultBooking, now: Date = new Date()): Promise<boolean> {
  const rule = await getRule("health");
  if (!rule.payPerBooking || rule.feePerBookingPaise <= 0) return false;
  if (["CANCELLED", "REJECTED", "EXPIRED"].includes(booking.status)) return false;
  const [link] = await db.select({ patientId: healthAppointmentLinks.patientId }).from(healthAppointmentLinks).where(eq(healthAppointmentLinks.bookingId, booking.id));
  if (!link) return false;
  if ((await primeTierForShop(booking.shopId, now)).tier !== "FREE") return false;
  const [earlier] = await db
    .select({ id: consultBookings.id })
    .from(healthAppointmentLinks)
    .innerJoin(consultBookings, eq(consultBookings.id, healthAppointmentLinks.bookingId))
    .where(
      and(
        eq(healthAppointmentLinks.patientId, link.patientId),
        eq(consultBookings.shopId, booking.shopId),
        ne(consultBookings.id, booking.id),
        inArray(consultBookings.status, ["CONFIRMED", "PENDING_APPROVAL", "COMPLETED", "NO_SHOW"]),
      ),
    )
    .limit(1);
  if (earlier) return false;
  const rows = await db
    .insert(financialAdjustments)
    .values({
      type: "SHOP_ADJUSTMENT",
      party: "SHOP",
      shopId: booking.shopId,
      amountPaise: -rule.feePerBookingPaise,
      reason: `GoKesari Health booking fee (new patient), appointment ${booking.bookingNumber}`,
      idempotencyKey: `healthppb:${booking.id}`,
    })
    .onConflictDoNothing()
    .returning({ id: financialAdjustments.id });
  if (rows.length) await recordAudit({ action: AUDIT_ACTIONS.HEALTH_PRIME_SUBSCRIPTION, entityType: "consult_booking", entityId: booking.id, newValue: { event: "pay_per_booking", feePaise: rule.feePerBookingPaise, shopId: booking.shopId } });
  return rows.length > 0;
}

/* ================================================================ shop view */

export interface PrimeSubscriptionRow {
  id: string;
  planName: string;
  tier: string;
  term: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  graceUntil: string | null;
  pricePaise: number;
  discountPaise: number;
  gstPaise: number;
  totalPaise: number;
  couponCode: string | null;
  invoiceNumber: string | null;
  createdAt: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function shopSubscriptions(shopId: string): Promise<PrimeSubscriptionRow[]> {
  const rows = await db
    .select({ s: healthPrimeSubscriptions, planName: healthPrimePlans.name })
    .from(healthPrimeSubscriptions)
    .innerJoin(healthPrimePlans, eq(healthPrimePlans.id, healthPrimeSubscriptions.planId))
    .where(eq(healthPrimeSubscriptions.shopId, shopId))
    .orderBy(desc(healthPrimeSubscriptions.createdAt))
    .limit(100);
  return rows.map(({ s, planName }) => ({
    id: s.id,
    planName,
    tier: s.tier,
    term: s.term,
    status: s.status,
    startsAt: iso(s.startsAt),
    endsAt: iso(s.endsAt),
    graceUntil: iso(s.graceUntil),
    pricePaise: s.pricePaise,
    discountPaise: s.discountPaise,
    gstPaise: s.gstPaise,
    totalPaise: s.totalPaise,
    couponCode: s.couponCode,
    invoiceNumber: s.invoiceNumber,
    createdAt: s.createdAt.toISOString(),
  }));
}

export interface PrimeShopView {
  shop: { id: string; name: string; city: string };
  audiences: PrimeAudience[];
  role: "OWNER" | "STAFF";
  tier: Omit<PrimeTierInfo, "startsAt" | "endsAt" | "graceUntil"> & { startsAt: string | null; endsAt: string | null; graceUntil: string | null };
  plans: PrimePlanView[];
  termsNote: string;
  gstBp: number;
  graceDays: number;
  termDiscountBp: { QUARTERLY: number; YEARLY: number };
  payPerBooking: { on: boolean; feePaise: number };
  subscriptions: PrimeSubscriptionRow[];
  virtualNumber: { number: string; forwardTo: string; assignedAt: string } | null;
  calls: { id: string; caller: string; startedAt: string; durationSeconds: number; status: string }[];
  analytics: ProfileAnalytics[];
}

/** Everything the shop's Prime page shows. */
export async function primeShopView(shopId: string, actor: HealthActor, now: Date = new Date()): Promise<PrimeShopView> {
  const access = await requirePrimeAccess(shopId, actor);
  const [scope, rule, tier, plans, subscriptions, vn, calls, a7, a30, a90] = await Promise.all([
    shopScope(shopId),
    getRule("health"),
    primeTierForShop(shopId, now),
    plansForShop(shopId),
    shopSubscriptions(shopId),
    activeVirtualNumber(shopId),
    recentCalls(shopId, 30),
    profileAnalytics(shopId, 7, now),
    profileAnalytics(shopId, 30, now),
    profileAnalytics(shopId, 90, now),
  ]);
  return {
    shop: { id: shopId, name: scope.shopName, city: scope.city },
    audiences: scope.audiences,
    role: access.role,
    tier: { ...tier, startsAt: iso(tier.startsAt), endsAt: iso(tier.endsAt), graceUntil: iso(tier.graceUntil) },
    plans,
    termsNote: PRIME_TERMS_NOTE,
    gstBp: rule.primeGstBp,
    graceDays: rule.primeGraceDays,
    termDiscountBp: rule.primeTermDiscountBp,
    payPerBooking: { on: rule.payPerBooking, feePaise: rule.feePerBookingPaise },
    subscriptions,
    virtualNumber: vn ? { number: vn.number, forwardTo: vn.forwardTo.replace(/\d(?=\d{4})/g, "X"), assignedAt: vn.assignedAt.toISOString() } : null,
    calls: calls.map((c) => ({ id: c.id, caller: c.callerMasked, startedAt: c.startedAt.toISOString(), durationSeconds: c.durationSeconds, status: c.status })),
    analytics: [a7, a30, a90],
  };
}

/* ================================================================ admin */

const rupeesToPaise = (r: number | null | undefined) => (r == null ? null : Math.round(r * 100));

export const planInput = z
  .object({
    id: z.string().uuid().nullish(),
    code: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9_]{3,40}$/, "3–40 capital letters, digits or _.")),
    name: z.string().trim().min(2).max(80),
    audience: z.enum(PRIME_AUDIENCES),
    tier: z.enum(PRIME_TIERS),
    description: z.string().trim().max(600).nullish(),
    features: z.record(z.string().max(40), z.boolean()).default({}),
    quotas: z.record(z.string().max(40), z.number().int().min(0).max(1_000_000)).default({}),
    /** Rupees; empty for QUARTERLY / YEARLY = monthly × months less the rule's term discount. */
    pricesRupees: z.object({ MONTHLY: z.number().min(0).max(10_000_000).nullish(), QUARTERLY: z.number().min(0).max(10_000_000).nullish(), YEARLY: z.number().min(0).max(10_000_000).nullish() }),
    city: z.string().trim().max(80).nullish(),
    specialty: z.string().trim().max(80).nullish(),
    status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
    sortOrder: z.number().int().min(0).max(10_000).default(100),
  })
  .superRefine((v, ctx) => {
    const p = v.pricesRupees;
    if (v.tier !== "FREE" && p.MONTHLY == null && p.QUARTERLY == null && p.YEARLY == null) ctx.addIssue({ code: "custom", path: ["pricesRupees", "MONTHLY"], message: "Enter at least one price." });
    if (v.tier === "FREE" && [p.MONTHLY, p.QUARTERLY, p.YEARLY].some((x) => x != null && x > 0)) ctx.addIssue({ code: "custom", path: ["pricesRupees", "MONTHLY"], message: "The Free listing has no price." });
  });

/** Admin: adds or changes a plan (prices take effect for the next purchase; paid plans keep their price). */
export async function savePlan(raw: unknown, actor: HealthActor): Promise<HealthPrimePlan> {
  requireStaff(actor);
  const input = planInput.parse(raw);
  const prices: Record<string, number> = {};
  for (const t of PRIME_TERMS) {
    const v = rupeesToPaise(input.pricesRupees[t]);
    if (v != null) prices[t] = v;
  }
  const values = {
    code: input.code,
    name: input.name,
    audience: input.audience,
    tier: input.tier,
    description: input.description ?? null,
    features: input.features,
    quotas: input.quotas,
    prices,
    city: input.city?.trim() || null,
    specialty: input.specialty?.trim() || null,
    status: input.status,
    sortOrder: input.sortOrder,
    updatedBy: actor.id,
    updatedAt: new Date(),
  };
  const [clash] = await db.select({ id: healthPrimePlans.id }).from(healthPrimePlans).where(and(eq(healthPrimePlans.code, input.code), input.id ? ne(healthPrimePlans.id, input.id) : undefined));
  if (clash) throw conflict("Another plan already has this code.");
  let before: HealthPrimePlan | null = null;
  let row: HealthPrimePlan;
  if (input.id) {
    [before] = await db.select().from(healthPrimePlans).where(eq(healthPrimePlans.id, input.id));
    if (!before) throw notFound("Plan");
    [row] = await db.update(healthPrimePlans).set(values).where(eq(healthPrimePlans.id, input.id)).returning();
  } else {
    [row] = await db.insert(healthPrimePlans).values(values).returning();
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.HEALTH_PRIME_PLAN,
    entityType: "health_prime_plan",
    entityId: row.id,
    previousValue: before ? { prices: before.prices, status: before.status, features: before.features, city: before.city, specialty: before.specialty } : null,
    newValue: { code: row.code, prices: row.prices, status: row.status, features: row.features, city: row.city, specialty: row.specialty },
  });
  return row;
}

export async function savePlanStatus(planId: string, status: "ACTIVE" | "INACTIVE", actor: HealthActor): Promise<HealthPrimePlan> {
  requireStaff(actor);
  const [before] = await db.select().from(healthPrimePlans).where(eq(healthPrimePlans.id, planId));
  if (!before) throw notFound("Plan");
  const [row] = await db.update(healthPrimePlans).set({ status: z.enum(["ACTIVE", "INACTIVE"]).parse(status), updatedBy: actor.id, updatedAt: new Date() }).where(eq(healthPrimePlans.id, planId)).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_PRIME_PLAN, entityType: "health_prime_plan", entityId: planId, previousValue: { status: before.status }, newValue: { status: row.status } });
  return row;
}

export const couponInput = z.object({
  code: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9_-]{3,30}$/, "3–30 capital letters, digits, - or _.")),
  percentOff: z.number().int().min(1).max(100),
  maxUses: z.number().int().min(1).max(1_000_000).nullish(),
  validUntil: z.string().datetime({ offset: true }).nullish(),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
});

export async function listCoupons(actor: HealthActor): Promise<HealthPrimeCoupon[]> {
  requireStaff(actor);
  return db.select().from(healthPrimeCoupons).orderBy(desc(healthPrimeCoupons.createdAt));
}

/** Admin: adds or changes a coupon (uses so far are kept). */
export async function saveCoupon(raw: unknown, actor: HealthActor): Promise<HealthPrimeCoupon> {
  requireStaff(actor);
  const input = couponInput.parse(raw);
  const values = { code: input.code, percentOff: input.percentOff, maxUses: input.maxUses ?? null, validUntil: input.validUntil ? new Date(input.validUntil) : null, status: input.status };
  const [before] = await db.select().from(healthPrimeCoupons).where(eq(healthPrimeCoupons.code, input.code));
  const [row] = await db.insert(healthPrimeCoupons).values(values).onConflictDoUpdate({ target: healthPrimeCoupons.code, set: { percentOff: values.percentOff, maxUses: values.maxUses, validUntil: values.validUntil, status: values.status } }).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_PRIME_PLAN, entityType: "health_prime_coupon", entityId: null, previousValue: before ? { code: before.code, percentOff: before.percentOff, maxUses: before.maxUses, status: before.status } : null, newValue: { code: row.code, percentOff: row.percentOff, maxUses: row.maxUses, validUntil: row.validUntil, status: row.status } });
  return row;
}

export interface AdminSubscriptionRow extends PrimeSubscriptionRow {
  shopId: string;
  shopName: string;
  city: string;
  planCode: string;
}

export async function listSubscriptionsAdmin(actor: HealthActor, filter: { status?: string | null; shopId?: string | null; limit?: number } = {}): Promise<AdminSubscriptionRow[]> {
  requireStaff(actor);
  const where = [];
  if (filter.status) where.push(eq(healthPrimeSubscriptions.status, filter.status));
  if (filter.shopId) where.push(eq(healthPrimeSubscriptions.shopId, filter.shopId));
  const rows = await db
    .select({ s: healthPrimeSubscriptions, planName: healthPrimePlans.name, planCode: healthPrimePlans.code, shopName: shops.name, city: shops.city })
    .from(healthPrimeSubscriptions)
    .innerJoin(healthPrimePlans, eq(healthPrimePlans.id, healthPrimeSubscriptions.planId))
    .innerJoin(shops, eq(shops.id, healthPrimeSubscriptions.shopId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(healthPrimeSubscriptions.createdAt))
    .limit(Math.min(filter.limit ?? 200, 1000));
  return rows.map(({ s, planName, planCode, shopName, city }) => ({
    id: s.id,
    shopId: s.shopId,
    shopName,
    city,
    planCode,
    planName,
    tier: s.tier,
    term: s.term,
    status: s.status,
    startsAt: iso(s.startsAt),
    endsAt: iso(s.endsAt),
    graceUntil: iso(s.graceUntil),
    pricePaise: s.pricePaise,
    discountPaise: s.discountPaise,
    gstPaise: s.gstPaise,
    totalPaise: s.totalPaise,
    couponCode: s.couponCode,
    invoiceNumber: s.invoiceNumber,
    createdAt: s.createdAt.toISOString(),
  }));
}

export interface RevenueRow {
  month: string;
  planCode: string;
  planName: string;
  city: string;
  count: number;
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
}

/** Admin: paid Prime plans (invoiced) by IST month of payment, plan and city. */
export async function primeRevenueReport(actor: HealthActor, range: { from?: string | null; to?: string | null } = {}): Promise<{ rows: RevenueRow[]; totals: { count: number; taxablePaise: number; gstPaise: number; totalPaise: number } }> {
  requireStaff(actor);
  const from = range.from && /^\d{4}-\d{2}-\d{2}$/.test(range.from) ? range.from : "2000-01-01";
  const to = range.to && /^\d{4}-\d{2}-\d{2}$/.test(range.to) ? range.to : "2999-12-31";
  const rows = await db.execute<{ month: string; plan_code: string; plan_name: string; city: string; n: number; taxable: string; gst: string; total: string }>(sql`
    with paid as (
      select s.*, coalesce(pi.captured_at, s.updated_at) as paid_at
        from health.prime_subscriptions s
        left join payment_intents pi on pi.id = s.payment_intent_id
       where s.invoice_number is not null
    )
    select to_char(p.paid_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month, pl.code as plan_code, pl.name as plan_name,
           coalesce(sh.city, '—') as city, count(*)::int as n,
           sum(p.price_paise - p.discount_paise)::bigint as taxable, sum(p.gst_paise)::bigint as gst, sum(p.total_paise)::bigint as total
      from paid p
      join health.prime_plans pl on pl.id = p.plan_id
      join shops sh on sh.id = p.shop_id
     where (p.paid_at at time zone 'Asia/Kolkata')::date between ${from}::date and ${to}::date
     group by 1, 2, 3, 4
     order by 1 desc, 2, 4`);
  const out = rows.map((r) => ({ month: r.month, planCode: r.plan_code, planName: r.plan_name, city: r.city, count: Number(r.n), taxablePaise: Number(r.taxable), gstPaise: Number(r.gst), totalPaise: Number(r.total) }));
  return {
    rows: out,
    totals: out.reduce((t, r) => ({ count: t.count + r.count, taxablePaise: t.taxablePaise + r.taxablePaise, gstPaise: t.gstPaise + r.gstPaise, totalPaise: t.totalPaise + r.totalPaise }), { count: 0, taxablePaise: 0, gstPaise: 0, totalPaise: 0 }),
  };
}

/** Subscriptions with an invoice (for the invoice PDF and lists). */
export async function invoicedSubscription(subscriptionId: string): Promise<HealthPrimeSubscription | null> {
  const [s] = await db.select().from(healthPrimeSubscriptions).where(and(eq(healthPrimeSubscriptions.id, subscriptionId), isNotNull(healthPrimeSubscriptions.invoiceNumber)));
  return s ?? null;
}
