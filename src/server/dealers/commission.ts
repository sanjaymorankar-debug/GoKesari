/**
 * Dealer commission and rating (docs/dealer-programme, GKS-CM-001…003).
 *
 * Milestones, accrued once per shop at the moment they happen (no cron):
 *   REGISTERED          the shop is attributed to a dealer and its fee is paid
 *   VERIFIED_CATALOGUE  every mandatory seller document verified and at least
 *                       catalogueMinProducts active products
 *   ACTIVATED           the shop is approved
 * Hooks call checkCommissionMilestones(shopId) after attribution, fee payment,
 * document verification, approval and product creation.
 *
 * Amount = fixed ₹ + percent of the registration fee actually paid (before
 * GST, after any coupon) under the rule in force — the most specific ACTIVE
 * rule for the milestone, the shop's scope (WHOLESALE for wholesale stores,
 * STANDARD otherwise, or ALL) and its district, effective today. The rule's
 * id and version are stored on the entry, so a later rule change never alters
 * it. Rating bonus (flag dealer_rating_bonus_enabled for the shop's district):
 * (rating − 5.0) percentage points — added to the percent for a percentage
 * rule; for a fixed-only rule figured on the fee (or on the fixed amount, by
 * setting). Never negative.
 *
 * Cap: everything accrued for one shop (bonus included, reversals netted)
 * stays within capPaise; the part above it is a separate PENDING entry that
 * only an admin override releases (audited).
 *
 * Who earns: the dealer the shop is attributed to (employees are for
 * reporting); not GoKesari Direct, not a likely duplicate, a branch only when
 * branchEligible. A suspended or terminated dealer's entries go ON_HOLD for an
 * admin to decide; reactivation releases them.
 *
 * Ledger: EARNED → APPROVED (admin) → PAID (payout batch with the bank
 * reference); PENDING (above cap) → APPROVED with an override; REVERSED (fee
 * refunded, fraud, duplicate — with a reason). A reversal after payment is a
 * negative entry carried into the dealer's next payout.
 *
 * Only ADMIN changes rules, settings, slabs and ratings, approves and pays
 * (checked here, not only in routes). Every change is audited with the old
 * value, the new value and the reason.
 */
import { and, asc, desc, eq, gte, inArray, isNull, like, lte, ne, or, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  COMMISSION_MILESTONES,
  dealerCommissionLedger,
  dealerCommissionRules,
  dealerCommissionSettings,
  dealerPayoutBatches,
  dealerRatingHistory,
  dealerRatingSlabs,
  dealers,
  shopAttributions,
  shopProducts,
  shops,
  type CommissionMilestone,
  type CommissionStatus,
  type DealerCommissionEntry,
  type DealerCommissionRule,
  type DealerCommissionSettings,
  type Shop,
  type UserRole,
} from "@/server/db/schema";
import { stateCodeOfArea } from "@/lib/indian-states";
import { touchSellerRow } from "@/server/db/split/gate";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { flagCoversDistrict, getFeatureFlag } from "@/server/services/feature-flags";
import { districtCodeForPincode } from "@/server/services/geo-areas";
import { notify } from "@/server/services/notifications";
import { deferredReviewDocTypes, hasDocumentWaiver, missingMandatoryDocuments } from "@/server/services/shop-onboarding";

interface Actor {
  id: string;
  role: UserRole;
}

const WHOLESALE_TYPES = new Set(["WHOLESALE_STORE"]);
/**
 * Note on an ACTIVATED entry held because an admin approved the shop without its
 * seller documents (0109, owner 28 Oct 2026): released — with the shop's rating
 * credit — once the documents are verified. Only that release (or an admin)
 * frees it; a dealer's reactivation does not.
 */
export const DOCUMENTS_HOLD_NOTE = "held: shop approved without its documents — released when they are verified";
const today = () => new Date().toISOString().slice(0, 10);

function requireAdmin(actor: Actor, what: string) {
  if (actor.role !== "ADMIN") throw forbidden(`Only an admin can ${what}.`);
}

function requireReason(reason: string | null | undefined, min = 5): string {
  const r = (reason ?? "").trim();
  if (r.length < min) throw validationFailed("Give the reason for the change (it is kept in the audit log).", { fields: { reason: "Required." } });
  return r.slice(0, 500);
}

/* =============================================================== settings */

export async function getCommissionSettings(client: DbClient = db): Promise<DealerCommissionSettings> {
  const [row] = await client.select().from(dealerCommissionSettings).where(eq(dealerCommissionSettings.id, "default"));
  return row ?? { id: "default", capPaise: 99_900, fixedBonusBase: "FEE", catalogueMinProducts: 10, branchEligible: false, updatedBy: null, updatedAt: new Date(0) };
}

export async function setCommissionSettings(
  patch: Partial<Pick<DealerCommissionSettings, "capPaise" | "fixedBonusBase" | "catalogueMinProducts" | "branchEligible">>,
  reason: string,
  actor: Actor,
): Promise<DealerCommissionSettings> {
  requireAdmin(actor, "change commission settings");
  const why = requireReason(reason);
  if (patch.capPaise != null && (!Number.isInteger(patch.capPaise) || patch.capPaise < 0 || patch.capPaise > 100_000_000)) throw validationFailed("Cap: whole paise, 0 or more.");
  if (patch.catalogueMinProducts != null && (!Number.isInteger(patch.catalogueMinProducts) || patch.catalogueMinProducts < 1 || patch.catalogueMinProducts > 10_000)) {
    throw validationFailed("Catalogue size: 1 to 10,000 products.");
  }
  return db.transaction(async (tx) => {
    await tx.insert(dealerCommissionSettings).values({ id: "default" }).onConflictDoNothing();
    const [before] = await tx.select().from(dealerCommissionSettings).where(eq(dealerCommissionSettings.id, "default")).for("update");
    const [after] = await tx
      .update(dealerCommissionSettings)
      .set({ ...patch, updatedBy: actor.id, updatedAt: new Date() })
      .where(eq(dealerCommissionSettings.id, "default"))
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_COMMISSION_SETTINGS_CHANGED,
        entityType: "dealer_commission_settings",
        entityId: "default",
        previousValue: { capPaise: before.capPaise, fixedBonusBase: before.fixedBonusBase, catalogueMinProducts: before.catalogueMinProducts, branchEligible: before.branchEligible },
        newValue: { capPaise: after.capPaise, fixedBonusBase: after.fixedBonusBase, catalogueMinProducts: after.catalogueMinProducts, branchEligible: after.branchEligible, reason: why },
      },
      tx,
    );
    return after;
  });
}

/* ================================================================== rules */

export interface RuleInput {
  /** Edit an existing rule (a new version); omit to create a rule. */
  ruleKey?: string | null;
  shopScope: DealerCommissionRule["shopScope"];
  districtCode?: string | null;
  milestone: CommissionMilestone;
  fixedPaise: number;
  percentBp: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

/** Current rules (ACTIVE), and with `all` their earlier versions. */
export async function listCommissionRules(options: { all?: boolean } = {}): Promise<DealerCommissionRule[]> {
  return db
    .select()
    .from(dealerCommissionRules)
    .where(options.all ? sql`true` : eq(dealerCommissionRules.status, "ACTIVE"))
    .orderBy(asc(dealerCommissionRules.milestone), asc(dealerCommissionRules.shopScope), desc(dealerCommissionRules.version));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ADMIN only. Creates a rule (version 1) or edits one: the current version is
 * SUPERSEDED and a new version takes its place — entries already accrued keep
 * the version they were earned under. A reason is required.
 */
export async function saveCommissionRule(input: RuleInput, reason: string, actor: Actor): Promise<DealerCommissionRule> {
  requireAdmin(actor, "change commission rules");
  const why = requireReason(reason);
  if (!COMMISSION_MILESTONES.includes(input.milestone)) throw validationFailed("Unknown milestone.");
  if (!Number.isInteger(input.fixedPaise) || input.fixedPaise < 0 || input.fixedPaise > 100_000_000) throw validationFailed("Fixed amount: whole paise, 0 or more.");
  if (!Number.isInteger(input.percentBp) || input.percentBp < 0 || input.percentBp > 10_000) throw validationFailed("Percentage: 0 to 100% (basis points 0–10,000).");
  if (input.fixedPaise === 0 && input.percentBp === 0) throw validationFailed("Give a fixed amount, a percentage, or both.");
  if (!DATE.test(input.effectiveFrom) || (input.effectiveTo && (!DATE.test(input.effectiveTo) || input.effectiveTo < input.effectiveFrom))) {
    throw validationFailed("Effective dates: YYYY-MM-DD, the end on or after the start.");
  }
  return db.transaction(async (tx) => {
    let ruleKey = input.ruleKey ?? null;
    let version = 1;
    let previous: DealerCommissionRule | null = null;
    if (ruleKey) {
      const versions = await tx.select().from(dealerCommissionRules).where(eq(dealerCommissionRules.ruleKey, ruleKey)).orderBy(desc(dealerCommissionRules.version)).for("update");
      if (versions.length === 0) throw notFound("Rule");
      previous = versions.find((v) => v.status === "ACTIVE") ?? versions[0];
      version = versions[0].version + 1;
      await tx.update(dealerCommissionRules).set({ status: "SUPERSEDED" }).where(and(eq(dealerCommissionRules.ruleKey, ruleKey), eq(dealerCommissionRules.status, "ACTIVE")));
    } else {
      ruleKey = crypto.randomUUID();
    }
    const [row] = await tx
      .insert(dealerCommissionRules)
      .values({
        ruleKey,
        version,
        shopScope: input.shopScope,
        districtCode: input.districtCode || null,
        milestone: input.milestone,
        fixedPaise: input.fixedPaise,
        percentBp: input.percentBp,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo || null,
        changeReason: why,
        createdBy: actor.id,
      })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_COMMISSION_RULE_CHANGED,
        entityType: "dealer_commission_rule",
        entityId: ruleKey,
        previousValue: previous ? ruleAudit(previous) : null,
        newValue: { ...ruleAudit(row), reason: why },
      },
      tx,
    );
    return row;
  });
}

const ruleAudit = (r: DealerCommissionRule) => ({
  version: r.version,
  shopScope: r.shopScope,
  districtCode: r.districtCode,
  milestone: r.milestone,
  fixedPaise: r.fixedPaise,
  percentBp: r.percentBp,
  effectiveFrom: r.effectiveFrom,
  effectiveTo: r.effectiveTo,
});

/** ADMIN only: switch a rule off (no new accruals under it). */
export async function disableCommissionRule(ruleKey: string, reason: string, actor: Actor): Promise<void> {
  requireAdmin(actor, "change commission rules");
  const why = requireReason(reason);
  const changed = await db.update(dealerCommissionRules).set({ status: "DISABLED" }).where(and(eq(dealerCommissionRules.ruleKey, ruleKey), eq(dealerCommissionRules.status, "ACTIVE"))).returning();
  if (changed.length === 0) throw notFound("Active rule");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DEALER_COMMISSION_RULE_CHANGED,
    entityType: "dealer_commission_rule",
    entityId: ruleKey,
    previousValue: ruleAudit(changed[0]),
    newValue: { status: "DISABLED", reason: why },
  });
}

/** The rule in force for this shop and milestone today: district-specific beats every-district, a scope beats ALL. */
/** The area itself and its state ("MH-PUN" → ["MH-PUN", "MH"]); [] when unknown. */
function areaAndState(code: string | null): string[] {
  if (!code) return [];
  const state = stateCodeOfArea(code);
  return state && state !== code ? [code, state] : [code];
}

export async function ruleFor(shop: Pick<Shop, "shopType">, districtCode: string | null, milestone: CommissionMilestone, client: DbClient = db): Promise<DealerCommissionRule | null> {
  const scope = WHOLESALE_TYPES.has(shop.shopType) ? "WHOLESALE" : "STANDARD";
  const d = today();
  const rows = await client
    .select()
    .from(dealerCommissionRules)
    .where(
      and(
        eq(dealerCommissionRules.milestone, milestone),
        eq(dealerCommissionRules.status, "ACTIVE"),
        lte(dealerCommissionRules.effectiveFrom, d),
        or(isNull(dealerCommissionRules.effectiveTo), gte(dealerCommissionRules.effectiveTo, d)),
        inArray(dealerCommissionRules.shopScope, [scope, "ALL"]),
        // A rule for the district, for its whole state ("KA"), or for everywhere.
        districtCode ? or(isNull(dealerCommissionRules.districtCode), inArray(dealerCommissionRules.districtCode, areaAndState(districtCode))) : isNull(dealerCommissionRules.districtCode),
      ),
    );
  rows.sort((a, b) => {
    // Most specific first: district (4) over state (2) over everywhere; a shop-type rule over "all".
    const score = (r: DealerCommissionRule) => (r.districtCode ? (r.districtCode === districtCode && r.districtCode !== stateCodeOfArea(districtCode) ? 4 : 2) : 0) + (r.shopScope === "ALL" ? 0 : 1);
    return score(b) - score(a) || b.createdAt.getTime() - a.createdAt.getTime();
  });
  return rows[0] ?? null;
}

/* =============================================================== amounts */

/** The registration fee actually paid, before GST, after any coupon. */
export function feeBasePaise(shop: Pick<Shop, "registrationFeeBasePaise" | "registrationFeeDiscountPaise" | "registrationFeePaise" | "registrationFeeGstPaise">): number {
  // A fee an admin waived for this shop (its fee set to zero; the base stays on record): nothing was collected.
  if (shop.registrationFeePaise != null && Number(shop.registrationFeePaise) === 0) return 0;
  if (shop.registrationFeeBasePaise != null) return Math.max(0, Number(shop.registrationFeeBasePaise) - Number(shop.registrationFeeDiscountPaise ?? 0));
  return Math.max(0, Number(shop.registrationFeePaise ?? 0) - Number(shop.registrationFeeGstPaise ?? 0));
}

/** (rating − 5.0) percentage points, in basis points; never negative. */
export function bonusBpForRating(rating: number): number {
  return Math.max(0, Math.round((rating - 5) * 100));
}

export interface CommissionAmount {
  basePaise: number;
  bonusBp: number;
  bonusPaise: number;
  totalPaise: number;
}

/**
 * fixed + percent of the fee; the bonus adds points to a percentage rule, and
 * for a fixed-only rule is figured on the fee or on the fixed amount.
 */
export function commissionAmount(rule: Pick<DealerCommissionRule, "fixedPaise" | "percentBp">, feePaise: number, bonusBp: number, fixedBonusBase: "FEE" | "BASE_AMOUNT"): CommissionAmount {
  const basePaise = rule.fixedPaise + Math.round((feePaise * rule.percentBp) / 10_000);
  const bonusPaise =
    bonusBp === 0
      ? 0
      : rule.percentBp > 0 || fixedBonusBase === "FEE"
        ? Math.round((feePaise * bonusBp) / 10_000)
        : Math.round((rule.fixedPaise * bonusBp) / 10_000);
  return { basePaise, bonusBp, bonusPaise, totalPaise: basePaise + bonusPaise };
}

/* ============================================================= milestones */

async function activeProducts(shopId: string, client: DbClient): Promise<number> {
  const [row] = await client.select({ n: sql<number>`count(*)::int` }).from(shopProducts).where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.isActive, true)));
  return row?.n ?? 0;
}

/**
 * Accrues every milestone the shop has reached and not yet been paid for
 * (idempotent; the unique index on shop + milestone guards double accrual).
 * Cheap when the programme is off: one read of the flag.
 */
export async function checkCommissionMilestones(shopId: string, actor: Actor | null = null): Promise<DealerCommissionEntry[]> {
  const flag = await getFeatureFlag("dealer_programme_enabled");
  if (!flag.enabled) return [];
  const [row] = await db.select({ a: shopAttributions, shop: shops }).from(shopAttributions).innerJoin(shops, eq(shops.id, shopAttributions.shopId)).where(eq(shopAttributions.shopId, shopId));
  if (!row || row.a.status !== "ACTIVE") return [];
  const district = await districtCodeForPincode(row.shop.pincode);
  if (!flagCoversDistrict(flag, district)) return [];

  const settings = await getCommissionSettings();
  const missing = await missingMandatoryDocuments(row.shop);
  // Approved by an admin without its documents (0109), or live with its Shop Act still in review
  // (onboarding wizard, owner decision B, 0113), and still not verified: activation is held.
  const awaitingDocuments = missing.length > 0 && ((await hasDocumentWaiver(shopId)) || (await deferredReviewDocTypes(shopId)).size > 0);
  const reached: CommissionMilestone[] = [];
  if (row.shop.feePaymentStatus === "PAID") reached.push("REGISTERED");
  if (missing.length === 0 && (await activeProducts(shopId, db)) >= settings.catalogueMinProducts) reached.push("VERIFIED_CATALOGUE");
  if (row.shop.status === "APPROVED") reached.push("ACTIVATED");

  const out: DealerCommissionEntry[] = [];
  for (const milestone of reached) {
    out.push(...(await accrue(row.shop, row.a.dealerId, row.a.salespersonId, milestone, district, settings, actor, { holdForDocuments: milestone === "ACTIVATED" && awaitingDocuments })));
  }
  // No rating credit until the documents are verified; then the held activation is released.
  if (awaitingDocuments) return out;
  await releaseDocumentHold(shopId, actor);
  if (reached.includes("ACTIVATED") && !row.a.activatedAt) {
    await db.update(shopAttributions).set({ activatedAt: new Date(), updatedAt: new Date() }).where(and(eq(shopAttributions.shopId, shopId), isNull(shopAttributions.activatedAt)));
    await recountRating(row.a.dealerId, "a shop activated", null);
  }
  return out;
}

/** Never lets commission break the caller (approval, payment, a product upload): logs and returns []. */
export async function checkCommissionMilestonesSafely(shopId: string, actor: Actor | null = null): Promise<DealerCommissionEntry[]> {
  try {
    return await checkCommissionMilestones(shopId, actor);
  } catch (error) {
    console.error("[dealers] commission milestone check failed", shopId, error instanceof Error ? error.message : error);
    return [];
  }
}

async function accrue(
  shop: Shop,
  dealerId: string,
  salespersonId: string | null,
  milestone: CommissionMilestone,
  district: string | null,
  settings: DealerCommissionSettings,
  actor: Actor | null,
  options: { holdForDocuments?: boolean } = {},
): Promise<DealerCommissionEntry[]> {
  return db.transaction(async (tx) => {
    // The dealer row is the gate: the cap sums this shop's other entries (split layout: touched after the lock).
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, dealerId)).for("update");
    await touchSellerRow(tx, dealers, dealerId);
    if (!dealer || dealer.isInternal) return [];
    const [already] = await tx
      .select({ id: dealerCommissionLedger.id })
      .from(dealerCommissionLedger)
      .where(and(eq(dealerCommissionLedger.shopId, shop.id), eq(dealerCommissionLedger.milestone, milestone), eq(dealerCommissionLedger.kind, "ACCRUAL")));
    if (already) return [];
    const [attribution] = await tx.select().from(shopAttributions).where(eq(shopAttributions.shopId, shop.id));
    if (!attribution || attribution.status !== "ACTIVE" || attribution.dealerId !== dealerId) return [];
    if (attribution.matchKind === "DUPLICATE") return [];
    if (attribution.matchKind === "BRANCH" && !settings.branchEligible) return [];
    const rule = await ruleFor(shop, district, milestone, tx);
    if (!rule) return [];

    const fee = feeBasePaise(shop);
    const bonusOn = flagCoversDistrict(await getFeatureFlag("dealer_rating_bonus_enabled"), district);
    const bonusBp = bonusOn ? bonusBpForRating(dealer.rating) : 0;
    const amount = commissionAmount(rule, fee, bonusBp, settings.fixedBonusBase);
    const [{ net }] = await tx
      .select({ net: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}) filter (where ${dealerCommissionLedger.status} <> 'REVERSED' and not ${dealerCommissionLedger.aboveCap}), 0)::int` })
      .from(dealerCommissionLedger)
      .where(eq(dealerCommissionLedger.shopId, shop.id));
    const room = Math.max(0, settings.capPaise - net);
    const within = Math.min(amount.totalPaise, room);
    const above = amount.totalPaise - within;
    const held = dealer.status === "APPROVED" && !options.holdForDocuments ? null : "EARNED";
    const docsNote = options.holdForDocuments ? DOCUMENTS_HOLD_NOTE : null;
    const common = {
      dealerId,
      salespersonId,
      shopId: shop.id,
      milestone,
      kind: "ACCRUAL" as const,
      ruleId: rule.id,
      ruleVersion: rule.version,
      feePaise: fee,
      basePaise: amount.basePaise,
      rating: dealer.rating,
      bonusBp,
      bonusPaise: amount.bonusPaise,
      createdBy: actor?.id ?? null,
    };
    const rows = [];
    if (within > 0 || above === 0) {
      rows.push({ ...common, amountPaise: within, aboveCap: false, status: (held ? "ON_HOLD" : "EARNED") as CommissionStatus, heldFromStatus: held as CommissionStatus | null, note: docsNote });
    }
    if (above > 0) {
      rows.push({
        ...common,
        amountPaise: above,
        aboveCap: true,
        status: (held ? "ON_HOLD" : "PENDING") as CommissionStatus,
        heldFromStatus: (held ? "PENDING" : null) as CommissionStatus | null,
        note: [docsNote, `above the per-shop cap of ₹${(settings.capPaise / 100).toLocaleString("en-IN")} — needs an admin override`].filter(Boolean).join("; "),
      });
    }
    // dealer_commission_ledger has more than one unique key, so no ON CONFLICT: the check above (under the dealer lock) guards it.
    const inserted = rows.length ? await tx.insert(dealerCommissionLedger).values(rows).returning() : [];
    await recordAudit(
      {
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        action: AUDIT_ACTIONS.DEALER_COMMISSION_ACCRUED,
        entityType: "shop",
        entityId: shop.id,
        newValue: { dealerId, milestone, ruleId: rule.id, ruleVersion: rule.version, feePaise: fee, ...amount, capPaise: settings.capPaise, abovePaise: above, held: Boolean(held), heldForDocuments: Boolean(docsNote) },
      },
      tx,
    );
    return inserted;
  });
}

/* ============================================================= reversals */

/**
 * Reverses every commission of a shop (fee refunded, fraud, duplicate): unpaid
 * entries become REVERSED; a paid one gets a negative entry carried into the
 * dealer's next payout. The shop stops counting for the dealer's rating.
 */
export async function reverseShopCommission(shopId: string, reason: string, actor: Actor | null): Promise<number> {
  const why = (reason ?? "").trim().slice(0, 500) || "reversed";
  const result = await db.transaction(async (tx) => {
    const [attribution] = await tx.select().from(shopAttributions).where(eq(shopAttributions.shopId, shopId)).for("update");
    if (!attribution) return null;
    const entries = await tx
      .select()
      .from(dealerCommissionLedger)
      .where(and(eq(dealerCommissionLedger.shopId, shopId), eq(dealerCommissionLedger.kind, "ACCRUAL"), ne(dealerCommissionLedger.status, "REVERSED")));
    let n = 0;
    for (const e of entries) {
      const [already] = await tx.select({ id: dealerCommissionLedger.id }).from(dealerCommissionLedger).where(eq(dealerCommissionLedger.reversesId, e.id));
      if (already) continue;
      if (e.status === "PAID") {
        await tx.insert(dealerCommissionLedger).values({
          dealerId: e.dealerId,
          salespersonId: e.salespersonId,
          shopId,
          milestone: e.milestone,
          kind: "REVERSAL",
          ruleId: e.ruleId,
          ruleVersion: e.ruleVersion,
          amountPaise: -e.amountPaise,
          status: "EARNED",
          reversesId: e.id,
          note: `reversal after payment: ${why}`,
          createdBy: actor?.id ?? null,
        });
      } else {
        await tx.update(dealerCommissionLedger).set({ status: "REVERSED", payoutBatchId: null, note: `reversed: ${why}`, updatedAt: new Date() }).where(eq(dealerCommissionLedger.id, e.id));
      }
      n += 1;
    }
    await tx.update(shopAttributions).set({ status: "REVERSED", note: `reversed: ${why}`, updatedAt: new Date() }).where(eq(shopAttributions.shopId, shopId));
    await recordAudit(
      {
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        action: AUDIT_ACTIONS.DEALER_COMMISSION_REVERSED,
        entityType: "shop",
        entityId: shopId,
        newValue: { dealerId: attribution.dealerId, entries: n, reason: why },
      },
      tx,
    );
    return { dealerId: attribution.dealerId, n };
  });
  if (!result) return 0;
  await recountRating(result.dealerId, `a shop was reversed: ${why}`, null);
  return result.n;
}

export async function reverseShopCommissionSafely(shopId: string, reason: string, actor: Actor | null): Promise<void> {
  try {
    if (!(await getFeatureFlag("dealer_programme_enabled")).enabled) return;
    await reverseShopCommission(shopId, reason, actor);
  } catch (error) {
    console.error("[dealers] commission reversal failed", shopId, error instanceof Error ? error.message : error);
  }
}

/** ADMIN only: reverse one entry with a reason (fraud, error). */
export async function reverseEntry(entryId: string, reason: string, actor: Actor): Promise<void> {
  requireAdmin(actor, "reverse commission");
  const why = requireReason(reason);
  await db.transaction(async (tx) => {
    const [e] = await tx.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.id, entryId)).for("update");
    if (!e || e.kind !== "ACCRUAL") throw notFound("Commission entry");
    if (e.status === "REVERSED") throw conflict("Already reversed.");
    if (e.status === "PAID") {
      await tx.insert(dealerCommissionLedger).values({ dealerId: e.dealerId, salespersonId: e.salespersonId, shopId: e.shopId, milestone: e.milestone, kind: "REVERSAL", ruleId: e.ruleId, ruleVersion: e.ruleVersion, amountPaise: -e.amountPaise, status: "EARNED", reversesId: e.id, note: `reversal after payment: ${why}`, createdBy: actor.id });
    } else {
      await tx.update(dealerCommissionLedger).set({ status: "REVERSED", payoutBatchId: null, note: `reversed: ${why}`, updatedAt: new Date() }).where(eq(dealerCommissionLedger.id, e.id));
    }
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_COMMISSION_REVERSED, entityType: "dealer_commission_entry", entityId: e.id, previousValue: { status: e.status, amountPaise: e.amountPaise }, newValue: { reason: why } }, tx);
  });
}

/* =========================================================== approval, hold */

/**
 * ADMIN only. EARNED → APPROVED; a PENDING above-cap entry needs
 * `capOverride` with a reason (audited). ON_HOLD entries are released or
 * reversed, not approved.
 */
export async function approveEntries(entryIds: string[], actor: Actor, options: { capOverride?: boolean; reason?: string } = {}): Promise<number> {
  requireAdmin(actor, "approve commission");
  if (entryIds.length === 0) return 0;
  const why = options.capOverride ? requireReason(options.reason) : (options.reason ?? null);
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(dealerCommissionLedger).where(inArray(dealerCommissionLedger.id, entryIds)).for("update");
    let n = 0;
    for (const e of rows) {
      if (e.status === "EARNED" && !e.aboveCap) {
        // proceed
      } else if (e.status === "PENDING" && e.aboveCap) {
        if (!options.capOverride) throw conflict("Above the per-shop cap: approving needs an explicit cap override with a reason.");
      } else continue;
      await tx.update(dealerCommissionLedger).set({ status: "APPROVED", approvedBy: actor.id, approvedAt: new Date(), updatedAt: new Date() }).where(eq(dealerCommissionLedger.id, e.id));
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: e.aboveCap ? AUDIT_ACTIONS.DEALER_COMMISSION_CAP_OVERRIDE : AUDIT_ACTIONS.DEALER_COMMISSION_APPROVED,
          entityType: "dealer_commission_entry",
          entityId: e.id,
          previousValue: { status: e.status },
          newValue: { status: "APPROVED", amountPaise: e.amountPaise, reason: why },
        },
        tx,
      );
      n += 1;
    }
    return n;
  });
}

/** Dealer suspended / terminated → their open entries ON_HOLD; reactivated → released. */
export async function holdDealerCommission(dealerId: string, hold: boolean, actor: Actor | null): Promise<number> {
  const rows = await db.transaction(async (tx) => {
    if (hold) {
      const open = await tx
        .select()
        .from(dealerCommissionLedger)
        .where(and(eq(dealerCommissionLedger.dealerId, dealerId), inArray(dealerCommissionLedger.status, ["EARNED", "PENDING", "APPROVED"]), isNull(dealerCommissionLedger.payoutBatchId)));
      for (const e of open) await tx.update(dealerCommissionLedger).set({ status: "ON_HOLD", heldFromStatus: e.status, updatedAt: new Date() }).where(eq(dealerCommissionLedger.id, e.id));
      return open.length;
    }
    // Entries held for a shop's documents stay held: only the documents release them.
    const held = (await tx.select().from(dealerCommissionLedger).where(and(eq(dealerCommissionLedger.dealerId, dealerId), eq(dealerCommissionLedger.status, "ON_HOLD")))).filter(
      (e) => !e.note?.startsWith(DOCUMENTS_HOLD_NOTE),
    );
    for (const e of held) await tx.update(dealerCommissionLedger).set({ status: e.heldFromStatus ?? "EARNED", heldFromStatus: null, updatedAt: new Date() }).where(eq(dealerCommissionLedger.id, e.id));
    return held.length;
  });
  if (rows) {
    await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.DEALER_COMMISSION_HOLD, entityType: "dealer", entityId: dealerId, newValue: { hold, entries: rows } });
  }
  return rows;
}

/**
 * The shop's documents are now verified: entries held for them go back to their
 * status (still ON_HOLD, without the note, while the dealer itself is on hold),
 * audited. Called from checkCommissionMilestones; nothing to do for most shops.
 */
async function releaseDocumentHold(shopId: string, actor: Actor | null): Promise<number> {
  const released = await db.transaction(async (tx) => {
    const held = await tx
      .select()
      .from(dealerCommissionLedger)
      .where(and(eq(dealerCommissionLedger.shopId, shopId), eq(dealerCommissionLedger.status, "ON_HOLD"), like(dealerCommissionLedger.note, `${DOCUMENTS_HOLD_NOTE}%`)))
      .for("update");
    if (held.length === 0) return [];
    const statusOf = new Map((await tx.select({ id: dealers.id, status: dealers.status }).from(dealers).where(inArray(dealers.id, [...new Set(held.map((e) => e.dealerId))]))).map((d) => [d.id, d.status]));
    const rows = held.map((e) => ({ e, dealerStatus: statusOf.get(e.dealerId) }));
    for (const { e, dealerStatus } of rows) {
      const note = e.note!.slice(DOCUMENTS_HOLD_NOTE.length).replace(/^; /, "") || null;
      const status = dealerStatus === "APPROVED" ? (e.heldFromStatus ?? "EARNED") : "ON_HOLD";
      await tx
        .update(dealerCommissionLedger)
        .set({ status, heldFromStatus: status === "ON_HOLD" ? e.heldFromStatus : null, note, updatedAt: new Date() })
        .where(eq(dealerCommissionLedger.id, e.id));
    }
    return rows;
  });
  if (released.length) {
    await recordAudit({
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      action: AUDIT_ACTIONS.DEALER_COMMISSION_HOLD,
      entityType: "shop",
      entityId: shopId,
      newValue: { released: true, reason: "the shop's documents are verified", entries: released.map((r) => r.e.id) },
    });
  }
  return released.length;
}

/** ADMIN only: release one held entry (back to its status) after a decision. */
export async function releaseHeldEntry(entryId: string, reason: string, actor: Actor): Promise<void> {
  requireAdmin(actor, "release held commission");
  const why = requireReason(reason);
  const [e] = await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.id, entryId));
  if (!e || e.status !== "ON_HOLD") throw conflict("Only a held entry can be released.");
  await db.update(dealerCommissionLedger).set({ status: e.heldFromStatus ?? "EARNED", heldFromStatus: null, updatedAt: new Date() }).where(eq(dealerCommissionLedger.id, entryId));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_COMMISSION_HOLD, entityType: "dealer_commission_entry", entityId: entryId, newValue: { released: true, reason: why } });
}

/* ================================================================ payouts */

/**
 * ADMIN only: a payout for one dealer — every APPROVED entry plus any negative
 * reversal not yet settled, netted. Refused when the net is not positive (the
 * negative balance is carried to the next one).
 */
export async function createPayoutBatch(dealerId: string, actor: Actor, note?: string | null) {
  requireAdmin(actor, "create payouts");
  return db.transaction(async (tx) => {
    await tx.select({ id: dealers.id }).from(dealers).where(eq(dealers.id, dealerId)).for("update");
    await touchSellerRow(tx, dealers, dealerId);
    const rows = await tx
      .select()
      .from(dealerCommissionLedger)
      .where(
        and(
          eq(dealerCommissionLedger.dealerId, dealerId),
          isNull(dealerCommissionLedger.payoutBatchId),
          or(eq(dealerCommissionLedger.status, "APPROVED"), and(eq(dealerCommissionLedger.kind, "REVERSAL"), inArray(dealerCommissionLedger.status, ["EARNED", "APPROVED"]))),
        ),
      );
    const total = rows.reduce((s, r) => s + r.amountPaise, 0);
    if (rows.length === 0 || total <= 0) throw conflict(total < 0 ? `The dealer owes ₹${(-total / 100).toLocaleString("en-IN")} from reversals; it is carried to the next payout.` : "Nothing approved to pay.");
    const [batch] = await tx.insert(dealerPayoutBatches).values({ dealerId, totalPaise: total, note: note?.trim().slice(0, 300) || null, createdBy: actor.id }).returning();
    await tx.update(dealerCommissionLedger).set({ payoutBatchId: batch.id, updatedAt: new Date() }).where(inArray(dealerCommissionLedger.id, rows.map((r) => r.id)));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_PAYOUT_SAVED, entityType: "dealer_payout_batch", entityId: batch.id, newValue: { dealerId, totalPaise: total, entries: rows.length, status: "DRAFT" } }, tx);
    return batch;
  });
}

/**
 * ADMIN only: the bank transfer was made (outside GoKesari) — record its
 * reference; every entry becomes PAID. Reconciled: the entries must still add
 * up to the batch total.
 */
export async function markPayoutPaid(batchId: string, paymentReference: string, actor: Actor) {
  requireAdmin(actor, "record payouts");
  const ref = paymentReference.trim().slice(0, 120);
  if (ref.length < 3) throw validationFailed("Enter the bank / UTR reference of the transfer.", { fields: { paymentReference: "Required." } });
  const batch = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.id, batchId)).for("update");
    if (!b) throw notFound("Payout");
    if (b.status !== "DRAFT") throw conflict("This payout is already closed.");
    const rows = await tx.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.payoutBatchId, batchId));
    const sum = rows.reduce((s, r) => s + r.amountPaise, 0);
    if (sum !== b.totalPaise) throw conflict(`Does not reconcile: entries add up to ₹${sum / 100}, the payout is ₹${b.totalPaise / 100}. Cancel it and create it again.`);
    const now = new Date();
    await tx.update(dealerCommissionLedger).set({ status: "PAID", updatedAt: now }).where(eq(dealerCommissionLedger.payoutBatchId, batchId));
    const [paid] = await tx.update(dealerPayoutBatches).set({ status: "PAID", paymentReference: ref, paidBy: actor.id, paidAt: now }).where(eq(dealerPayoutBatches.id, batchId)).returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_PAYOUT_SAVED, entityType: "dealer_payout_batch", entityId: batchId, previousValue: { status: "DRAFT" }, newValue: { status: "PAID", paymentReference: ref, totalPaise: b.totalPaise } }, tx);
    return paid;
  });
  const [dealer] = await db.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, batch.dealerId));
  if (dealer?.userId) {
    await notify({ userId: dealer.userId, type: NOTIFICATION_TYPES.DEALER_PAYOUT_PAID, vars: { amount: `₹${(batch.totalPaise / 100).toLocaleString("en-IN")}`, reference: ref }, actionUrl: "/dealer", dedupeKey: `dealer-payout:${batchId}` });
  }
  return batch;
}

/** ADMIN only: cancel a draft payout; its entries go back to waiting. */
export async function cancelPayout(batchId: string, actor: Actor): Promise<void> {
  requireAdmin(actor, "cancel payouts");
  await db.transaction(async (tx) => {
    const [b] = await tx.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.id, batchId)).for("update");
    if (!b || b.status !== "DRAFT") throw conflict("Only a draft payout can be cancelled.");
    await tx.update(dealerCommissionLedger).set({ payoutBatchId: null, updatedAt: new Date() }).where(eq(dealerCommissionLedger.payoutBatchId, batchId));
    await tx.update(dealerPayoutBatches).set({ status: "CANCELLED" }).where(eq(dealerPayoutBatches.id, batchId));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_PAYOUT_SAVED, entityType: "dealer_payout_batch", entityId: batchId, newValue: { status: "CANCELLED" } }, tx);
  });
}

/* ============================================================ the ledger */

export interface LedgerRow {
  id: string;
  dealerId: string;
  dealerName: string;
  shopId: string;
  shopName: string;
  milestone: CommissionMilestone;
  kind: string;
  status: CommissionStatus;
  amountPaise: number;
  basePaise: number;
  bonusBp: number;
  bonusPaise: number;
  feePaise: number;
  rating: number | null;
  ruleVersion: number | null;
  aboveCap: boolean;
  payoutBatchId: string | null;
  note: string | null;
  createdAt: Date;
}

export async function listLedger(filter: { dealerId?: string; status?: CommissionStatus } = {}): Promise<LedgerRow[]> {
  const rows = await db
    .select({ e: dealerCommissionLedger, dealerName: dealers.legalName, shopName: shops.name })
    .from(dealerCommissionLedger)
    .innerJoin(dealers, eq(dealers.id, dealerCommissionLedger.dealerId))
    .innerJoin(shops, eq(shops.id, dealerCommissionLedger.shopId))
    .where(and(filter.dealerId ? eq(dealerCommissionLedger.dealerId, filter.dealerId) : sql`true`, filter.status ? eq(dealerCommissionLedger.status, filter.status) : sql`true`))
    .orderBy(desc(dealerCommissionLedger.createdAt))
    .limit(2000);
  return rows.map((r) => ({
    id: r.e.id,
    dealerId: r.e.dealerId,
    dealerName: r.dealerName,
    shopId: r.e.shopId,
    shopName: r.shopName,
    milestone: r.e.milestone,
    kind: r.e.kind,
    status: r.e.status,
    amountPaise: r.e.amountPaise,
    basePaise: r.e.basePaise,
    bonusBp: r.e.bonusBp,
    bonusPaise: r.e.bonusPaise,
    feePaise: r.e.feePaise,
    rating: r.e.rating,
    ruleVersion: r.e.ruleVersion,
    aboveCap: r.e.aboveCap,
    payoutBatchId: r.e.payoutBatchId,
    note: r.e.note,
    createdAt: r.e.createdAt,
  }));
}

/** Totals by status (paise); reversals count against EARNED until settled. */
export async function commissionSummary(dealerId: string): Promise<Record<"earned" | "pending" | "approved" | "paid" | "reversed" | "onHold", number>> {
  const rows = await db
    .select({ status: dealerCommissionLedger.status, kind: dealerCommissionLedger.kind, sum: sql<number>`sum(${dealerCommissionLedger.amountPaise})::int` })
    .from(dealerCommissionLedger)
    .where(eq(dealerCommissionLedger.dealerId, dealerId))
    .groupBy(dealerCommissionLedger.status, dealerCommissionLedger.kind);
  const out = { earned: 0, pending: 0, approved: 0, paid: 0, reversed: 0, onHold: 0 };
  for (const r of rows) {
    const key = ({ EARNED: "earned", PENDING: "pending", APPROVED: "approved", PAID: "paid", REVERSED: "reversed", ON_HOLD: "onHold" } as const)[r.status];
    out[key] += r.sum;
  }
  return out;
}

export async function listPayouts(dealerId?: string) {
  return db.select().from(dealerPayoutBatches).where(dealerId ? eq(dealerPayoutBatches.dealerId, dealerId) : sql`true`).orderBy(desc(dealerPayoutBatches.createdAt)).limit(500);
}

/** A dealer's statement as CSV (their own rows only). */
export function statementCsv(rows: LedgerRow[]): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Date", "Shop", "Milestone", "Kind", "Status", "Fee (Rs)", "Base (Rs)", "Rating", "Bonus %", "Bonus (Rs)", "Amount (Rs)", "Rule version", "Payout", "Note"];
  const lines = rows.map((r) =>
    [r.createdAt.toISOString().slice(0, 10), r.shopName, r.milestone, r.kind, r.status, r.feePaise / 100, r.basePaise / 100, r.rating ?? "", r.bonusBp / 100, r.bonusPaise / 100, r.amountPaise / 100, r.ruleVersion ?? "", r.payoutBatchId ?? "", r.note ?? ""].map(esc).join(","),
  );
  return [head.map(esc).join(","), ...lines].join("\n");
}

/* ================================================================= rating */

export async function listRatingSlabs() {
  return db.select().from(dealerRatingSlabs).orderBy(asc(dealerRatingSlabs.minShops));
}

const validRating = (r: number) => Number.isFinite(r) && r >= 0 && r <= 10 && Math.round(r * 2) === r * 2;

/** ADMIN only: add or change a slab (activated shops → rating, 0.5 steps, at most 10). Audited with a reason. */
export async function saveRatingSlab(minShops: number, rating: number, reason: string, actor: Actor): Promise<void> {
  requireAdmin(actor, "change the rating slabs");
  const why = requireReason(reason);
  if (!Number.isInteger(minShops) || minShops < 0 || minShops > 1_000_000) throw validationFailed("Shops: a whole number, 0 or more.");
  if (!validRating(rating)) throw validationFailed("Rating: 0 to 10 in steps of 0.5.");
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(dealerRatingSlabs).where(eq(dealerRatingSlabs.minShops, minShops)).for("update");
    if (before) await tx.update(dealerRatingSlabs).set({ rating }).where(eq(dealerRatingSlabs.id, before.id));
    // One unique key besides the primary key… so no ON CONFLICT; the row lock above decides.
    else await tx.insert(dealerRatingSlabs).values({ minShops, rating, createdBy: actor.id });
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_RATING_SLAB_CHANGED, entityType: "dealer_rating_slab", entityId: String(minShops), previousValue: before ? { minShops, rating: before.rating } : null, newValue: { minShops, rating, reason: why } }, tx);
  });
}

/** ADMIN only: remove a slab (the 0-shop slab stays). */
export async function deleteRatingSlab(minShops: number, reason: string, actor: Actor): Promise<void> {
  requireAdmin(actor, "change the rating slabs");
  const why = requireReason(reason);
  if (minShops === 0) throw conflict("The 0-shop slab is the base rating and cannot be removed.");
  const deleted = await db.delete(dealerRatingSlabs).where(eq(dealerRatingSlabs.minShops, minShops)).returning();
  if (deleted.length === 0) throw notFound("Slab");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_RATING_SLAB_CHANGED, entityType: "dealer_rating_slab", entityId: String(minShops), previousValue: { minShops, rating: deleted[0].rating }, newValue: { deleted: true, reason: why } });
}

/** The slab rating for a count, and the next slab (for progress bars). */
export function slabFor(slabs: { minShops: number; rating: number }[], count: number) {
  const sorted = [...slabs].sort((a, b) => a.minShops - b.minShops);
  let current = { minShops: 0, rating: 5 };
  for (const s of sorted) if (s.minShops <= count) current = s;
  const next = sorted.find((s) => s.minShops > count && s.rating > current.rating) ?? null;
  return { current, next };
}

/**
 * Recounts a dealer's activated shops (not duplicates, not reversed) and sets
 * the rating: the slab's rating, never below the admin's start rating, at
 * most 10 — or the admin's downgrade until the next slab is reached. Applies
 * to commission accrued from now on only.
 */
export async function recountRating(dealerId: string, reason: string, actor: Actor | null): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(shopAttributions)
    .where(and(eq(shopAttributions.dealerId, dealerId), eq(shopAttributions.status, "ACTIVE"), ne(shopAttributions.matchKind, "DUPLICATE"), sql`${shopAttributions.activatedAt} IS NOT NULL`));
  const slabs = await listRatingSlabs();
  const { current } = slabFor(slabs, n);
  return db.transaction(async (tx) => {
    const [d] = await tx.select().from(dealers).where(eq(dealers.id, dealerId)).for("update");
    if (!d) return 0;
    let override = d.ratingOverride;
    let until = d.ratingOverrideUntilShops;
    if (override != null && until != null && n >= until) {
      override = null;
      until = null;
    }
    const auto = Math.min(10, Math.max(d.startRating, current.rating));
    const rating = override ?? auto;
    if (rating !== d.rating || n !== d.activatedShops || override !== d.ratingOverride) {
      await tx.update(dealers).set({ rating, activatedShops: n, ratingOverride: override, ratingOverrideUntilShops: until, updatedAt: new Date() }).where(eq(dealers.id, dealerId));
      if (rating !== d.rating) {
        await tx.insert(dealerRatingHistory).values({ dealerId, oldRating: d.rating, newRating: rating, kind: "AUTO", activatedShops: n, reason, changedBy: actor?.id ?? null });
        await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.DEALER_RATING_CHANGED, entityType: "dealer", entityId: dealerId, previousValue: { rating: d.rating }, newValue: { rating, activatedShops: n, reason } }, tx);
      }
    }
    return rating;
  });
}

/** ADMIN only: a proven dealer starts higher (e.g. 6.0 → +1.0% from day one). Audited. */
export async function setStartRating(dealerId: string, rating: number, reason: string, actor: Actor): Promise<number> {
  requireAdmin(actor, "set a dealer's starting rating");
  const why = requireReason(reason);
  if (!validRating(rating)) throw validationFailed("Rating: 0 to 10 in steps of 0.5.");
  const [d] = await db.select().from(dealers).where(eq(dealers.id, dealerId));
  if (!d) throw notFound("Dealer");
  await db.update(dealers).set({ startRating: rating, updatedAt: new Date() }).where(eq(dealers.id, dealerId));
  await db.insert(dealerRatingHistory).values({ dealerId, oldRating: d.rating, newRating: Math.max(rating, d.rating), kind: "START", activatedShops: d.activatedShops, reason: why, changedBy: actor.id });
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_RATING_CHANGED, entityType: "dealer", entityId: dealerId, previousValue: { startRating: d.startRating }, newValue: { startRating: rating, reason: why } });
  return recountRating(dealerId, `start rating set: ${why}`, actor);
}

/**
 * ADMIN only: lower a dealer's rating for quality or fraud, with a reason the
 * dealer sees. It holds until the dealer reaches the next slab above today's
 * count; then the slab decides again.
 */
export async function downgradeRating(dealerId: string, rating: number, reason: string, actor: Actor): Promise<number> {
  requireAdmin(actor, "change a dealer's rating");
  const why = requireReason(reason);
  if (!validRating(rating)) throw validationFailed("Rating: 0 to 10 in steps of 0.5.");
  const [d] = await db.select().from(dealers).where(eq(dealers.id, dealerId));
  if (!d) throw notFound("Dealer");
  if (rating >= d.rating) throw validationFailed("A manual change can only lower the rating; raise a dealer's starting rating instead.");
  const { next } = slabFor(await listRatingSlabs(), d.activatedShops);
  await db.update(dealers).set({ rating, ratingOverride: rating, ratingOverrideUntilShops: next?.minShops ?? null, updatedAt: new Date() }).where(eq(dealers.id, dealerId));
  await db.insert(dealerRatingHistory).values({ dealerId, oldRating: d.rating, newRating: rating, kind: "MANUAL", activatedShops: d.activatedShops, reason: why, changedBy: actor.id });
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_RATING_CHANGED, entityType: "dealer", entityId: dealerId, previousValue: { rating: d.rating }, newValue: { rating, manual: true, untilShops: next?.minShops ?? null, reason: why } });
  if (d.userId) {
    await notify({ userId: d.userId, type: NOTIFICATION_TYPES.DEALER_RATING_CHANGED, vars: { rating: rating.toFixed(1), reason: why }, actionUrl: "/dealer", dedupeKey: `dealer-rating:${dealerId}:${Date.now()}` });
  }
  return rating;
}

export interface RatingView {
  rating: number;
  bonusBp: number;
  startRating: number;
  activatedShops: number;
  override: { rating: number; untilShops: number | null } | null;
  next: { minShops: number; rating: number; shopsToGo: number } | null;
  slabs: { minShops: number; rating: number }[];
  history: { oldRating: number; newRating: number; kind: string; reason: string; activatedShops: number; createdAt: Date }[];
}

export async function ratingView(dealerId: string): Promise<RatingView> {
  const [d] = await db.select().from(dealers).where(eq(dealers.id, dealerId));
  if (!d) throw notFound("Dealer");
  const slabs = (await listRatingSlabs()).map((s) => ({ minShops: s.minShops, rating: s.rating }));
  const { next } = slabFor(slabs, d.activatedShops);
  const history = await db.select().from(dealerRatingHistory).where(eq(dealerRatingHistory.dealerId, dealerId)).orderBy(desc(dealerRatingHistory.createdAt)).limit(50);
  return {
    rating: d.rating,
    bonusBp: bonusBpForRating(d.rating),
    startRating: d.startRating,
    activatedShops: d.activatedShops,
    override: d.ratingOverride != null ? { rating: d.ratingOverride, untilShops: d.ratingOverrideUntilShops } : null,
    next: next ? { minShops: next.minShops, rating: next.rating, shopsToGo: next.minShops - d.activatedShops } : null,
    slabs,
    history: history.map((h) => ({ oldRating: h.oldRating, newRating: h.newRating, kind: h.kind, reason: h.reason, activatedShops: h.activatedShops, createdAt: h.createdAt })),
  };
}

/** The rates that apply to a dealer's shops now (read-only, for the dealer). */
export async function applicableRates(): Promise<{ milestone: CommissionMilestone; shopScope: string; districtCode: string | null; fixedPaise: number; percentBp: number; effectiveFrom: string; effectiveTo: string | null }[]> {
  const d = today();
  const rows = await db
    .select()
    .from(dealerCommissionRules)
    .where(and(eq(dealerCommissionRules.status, "ACTIVE"), lte(dealerCommissionRules.effectiveFrom, d), or(isNull(dealerCommissionRules.effectiveTo), gte(dealerCommissionRules.effectiveTo, d))))
    .orderBy(asc(dealerCommissionRules.milestone));
  return rows.map((r) => ({ milestone: r.milestone, shopScope: r.shopScope, districtCode: r.districtCode, fixedPaise: r.fixedPaise, percentBp: r.percentBp, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo }));
}
