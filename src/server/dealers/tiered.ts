/**
 * TIERED dealer commission (owner brief, 2 Nov 2026; docs/dealer-programme/TIERED_COMMISSION.md).
 *
 * A dealer an admin moved to TIERED (dealers.commission_model) runs a network of
 * at most three levels — the MAIN_DEALER (the dealers row, level 1), TEAM_LEADs
 * (level 2) and AGENTs (level 3 under a lead, or level 2 straight under the main
 * dealer). Values from rule dealerTieredCommission, a dealer's own rates on the
 * dealer. Per shop, on the registration fee actually paid (before GST, after any
 * coupon — feeBasePaise):
 *
 *   direct        directBp to whoever signed the shop (agent, lead or main
 *                 dealer), moved by the dealer's rating as in the standard
 *                 model (flag dealer_rating_bonus_enabled) — the direct part only
 *   lead override leadOverrideBp to an agent's team lead
 *   main override mainOverrideBp to the main dealer on every shop a member signed
 *   development   a promoted lead's former lead, developmentBp for developmentMonths
 *
 * A missing level is not paid and nobody earns twice on a shop (20 + 5 + 3 = 28%
 * at most). firstPartBp of the direct part is earned at ACTIVATED (DIRECT_1);
 * the rest (DIRECT_2) and every override at TRADING — tradingOrders delivered
 * orders within tradingDays of activation. Not reached in time: those parts
 * lapse, with a zero ledger entry saying so. Who earns what is frozen in
 * dealer_tier_shop_plans at activation, so a promotion later never changes it.
 *
 * Also: a renewal commission (renewalBp of a paid renewal, before GST) to the
 * direct earner while the shop is active; monthly target bonuses; promotion of
 * an agent to team lead (he takes the agents he recruited with him); sub-agent
 * requests an admin approves; the agent agreement every payee accepts before
 * earning (entries wait ON_HOLD until then).
 *
 * The per-shop cap (dealer_commission_settings.cap_paise) covers the shop's
 * registration commission at every level (DIRECT_1, DIRECT_2, both overrides);
 * the part above it waits PENDING for an admin override, as today. Reversals
 * (refund, waiver, fraud, duplicate) take back every level for the shop —
 * reverseShopCommission in commission.ts, with negative carry-forward.
 *
 * Only ADMIN changes models, rates, roles and approves (checked here, not only
 * in routes); a main dealer may add members to his own network. Everything is
 * audited with the old value, the new value and the reason.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

import { checkAccountNumber, checkIfsc } from "@/lib/bank-accounts";
import { createHash } from "node:crypto";

import { AGENT_AGREEMENT_TEXT, AGENT_AGREEMENT_VERSION, type CommissionEntryType, type NetworkRole, type TeamRole } from "@/lib/dealer-tiers";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { encryptSecret, panBlindIndex } from "@/lib/pan-crypto";
import { db, type DbClient } from "@/server/db";
import {
  dealerAgreementAcceptances,
  dealerCommissionLedger,
  dealerSalespeople,
  dealerTeamDevelopments,
  dealerTeamMappingHistory,
  dealerTeamRequests,
  dealerTierShopPlans,
  dealers,
  orderStatusHistory,
  orders,
  referralCodes,
  shopAttributions,
  shopPayments,
  shops,
  users,
  type CommissionStatus,
  type Dealer,
  type DealerCommissionEntry,
  type DealerCommissionSettings,
  type DealerSalesperson,
  type DealerTeamMapping,
  type DealerTierShopPlan,
  type LedgerMilestone,
  type Shop,
  type UserRole,
} from "@/server/db/schema";
import { touchSellerRow } from "@/server/db/split/gate";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { flagCoversDistrict, getFeatureFlag } from "@/server/services/feature-flags";
import { notify } from "@/server/services/notifications";
import { registrationFeeGstRateBp } from "@/server/services/registration-fee-coupons";
import { grantRole } from "@/server/services/roles";
import { addMonths } from "@/server/services/shop-membership";
import { getRule } from "@/server/services/settings";
import { DOCUMENTS_HOLD_NOTE, feeBasePaise, getCommissionSettings, ratingAdjustmentBp } from "./commission";

interface Actor {
  id: string;
  role: UserRole;
}

export type TierRule = Awaited<ReturnType<typeof tierRule>>;
export const tierRule = () => getRule("dealerTieredCommission");

/** The agreement's text fingerprint, kept with every acceptance. */
export const AGENT_AGREEMENT_SHA256 = createHash("sha256").update(AGENT_AGREEMENT_TEXT.join("\n")).digest("hex");

/** Note on an entry waiting for its payee to accept the agent agreement; acceptance releases it. */
export const AGREEMENT_HOLD_NOTE = "held: the agent agreement is not accepted yet — released when it is";
/** The registration-commission entry types the per-shop cap covers. */
export const CAPPED_TYPES: CommissionEntryType[] = ["DIRECT_1", "DIRECT_2", "OVERRIDE_LEAD", "OVERRIDE_MAIN"];
/** The cap also counts what the shop earned on the standard model (BASE), so nothing is paid twice. */
const CAP_COUNTED_TYPES: CommissionEntryType[] = ["BASE", ...CAPPED_TYPES];

/**
 * True when the shop already earned commission on the standard model (a BASE accrual, paid or not).
 * Such a shop stays on the standard model when its dealer moves to TIERED (grandfathered): it never
 * gets a TIERED plan, so its registration fee is never paid on twice.
 */
export async function hasStandardCommission(client: DbClient, shopId: string): Promise<boolean> {
  const [row] = await client
    .select({ id: dealerCommissionLedger.id })
    .from(dealerCommissionLedger)
    .where(and(eq(dealerCommissionLedger.shopId, shopId), eq(dealerCommissionLedger.kind, "ACCRUAL"), eq(dealerCommissionLedger.entryType, "BASE")))
    .limit(1);
  return Boolean(row);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function requireAdmin(actor: Actor, what: string) {
  if (actor.role !== "ADMIN") throw forbidden(`Only an admin can ${what}.`);
}

function requireReason(reason: string | null | undefined, min = 5): string {
  const r = (reason ?? "").trim();
  if (r.length < min) throw validationFailed("Give the reason for the change (it is kept in the audit log).", { fields: { reason: "Required." } });
  return r.slice(0, 500);
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/* ================================================================ amounts */

export interface TierRates {
  directBp: number;
  leadOverrideBp: number;
  mainOverrideBp: number;
  firstPartBp: number;
}

/** A TIERED dealer's rates: their own, or the rule's defaults. */
export function tierRatesFor(dealer: Pick<Dealer, "tierDirectBp" | "tierLeadOverrideBp" | "tierMainOverrideBp">, rule: Pick<TierRule, "directBp" | "leadOverrideBp" | "mainOverrideBp" | "firstPartBp">): TierRates {
  return {
    directBp: dealer.tierDirectBp ?? rule.directBp,
    leadOverrideBp: dealer.tierLeadOverrideBp ?? rule.leadOverrideBp,
    mainOverrideBp: dealer.tierMainOverrideBp ?? rule.mainOverrideBp,
    firstPartBp: rule.firstPartBp,
  };
}

export interface TierAmounts {
  /** The whole direct part (rating applied), split into part 1 and part 2 (part1 + part2 = direct). */
  directPaise: number;
  direct1Paise: number;
  direct2Paise: number;
  leadPaise: number;
  mainPaise: number;
  developmentPaise: number;
  totalPaise: number;
}

/**
 * The commission on one shop. `hasLead` / `hasMain`: whether those levels exist
 * and are not the direct earner (nobody earns twice). Rounded to the paisa;
 * part 2 is the direct part less part 1, so the two always add up.
 */
export function tierAmounts(
  feePaise: number,
  rates: TierRates,
  options: { ratingAdjustmentBp?: number; hasLead: boolean; hasMain: boolean; developmentBp?: number },
): TierAmounts {
  const fee = Math.max(0, Math.round(feePaise));
  const directBp = Math.max(0, rates.directBp + (options.ratingAdjustmentBp ?? 0));
  const directPaise = Math.round((fee * directBp) / 10_000);
  const direct1Paise = Math.round((directPaise * rates.firstPartBp) / 10_000);
  const direct2Paise = directPaise - direct1Paise;
  const leadPaise = options.hasLead ? Math.round((fee * rates.leadOverrideBp) / 10_000) : 0;
  const mainPaise = options.hasMain ? Math.round((fee * rates.mainOverrideBp) / 10_000) : 0;
  const developmentPaise = Math.round((fee * (options.developmentBp ?? 0)) / 10_000);
  return { directPaise, direct1Paise, direct2Paise, leadPaise, mainPaise, developmentPaise, totalPaise: directPaise + leadPaise + mainPaise + developmentPaise };
}

/** The renewal fee before GST: a recorded renewal payment includes GST at the registration-fee rate. */
export function renewalBasePaise(amountPaise: number, gstRateBp: number): number {
  return Math.max(0, Math.round((amountPaise * 10_000) / (10_000 + Math.max(0, gstRateBp))));
}

/** Income-tax TDS on a payout (rule dealerPayoutTds), with catch-up when the threshold is first passed. */
export function tdsForPayout(input: { grossPaise: number; yearGrossBeforePaise: number; yearTdsBeforePaise: number; rateBp: number; thresholdPaise: number; enabled: boolean }): number {
  if (!input.enabled || input.grossPaise <= 0 || input.rateBp <= 0) return 0;
  const yearGross = input.yearGrossBeforePaise + input.grossPaise;
  if (yearGross <= input.thresholdPaise) return 0;
  const due = Math.round((yearGross * input.rateBp) / 10_000) - input.yearTdsBeforePaise;
  return Math.max(0, Math.min(input.grossPaise, due));
}

/** The Indian financial year (April–March, IST) an instant falls in: [start, end). */
export function financialYearBounds(at: Date): { start: Date; end: Date } {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  const start = new Date(Date.UTC(y, 3, 1) - 330 * 60_000);
  const end = new Date(Date.UTC(y + 1, 3, 1) - 330 * 60_000);
  return { start, end };
}

/* ================================================================ network */

/** The member's level: 2 under the main dealer, 3 under a lead. The main dealer is 1. */
export const levelOf = (m: Pick<DealerSalesperson, "depth"> | null) => (m ? m.depth : 1);
export const roleOf = (m: Pick<DealerSalesperson, "teamRole"> | null): NetworkRole => (m ? m.teamRole : "MAIN_DEALER");

export function agreementAccepted(payee: { agreementVersion: string | null } | null, dealer: Pick<Dealer, "tierAgreementVersion">): boolean {
  return payee ? payee.agreementVersion === AGENT_AGREEMENT_VERSION : dealer.tierAgreementVersion === AGENT_AGREEMENT_VERSION;
}

/** Whether a dealer earns under TIERED now: moved to it, and the rule is on. */
export async function isTieredDealer(dealer: Pick<Dealer, "commissionModel">): Promise<boolean> {
  return dealer.commissionModel === "TIERED" && (await tierRule()).enabled;
}

interface Placement {
  direct: DealerSalesperson | null;
  lead: DealerSalesperson | null;
  mainOverride: boolean;
  development: { id: string; member: DealerSalesperson; bp: number } | null;
}

/** Who earns on a shop signed by `signerId` (null: the main dealer), at `at`. */
async function placementFor(tx: DbClient, dealerId: string, signerId: string | null, at: Date): Promise<Placement> {
  if (!signerId) return { direct: null, lead: null, mainOverride: false, development: null };
  const [direct] = await tx.select().from(dealerSalespeople).where(and(eq(dealerSalespeople.id, signerId), eq(dealerSalespeople.dealerId, dealerId)));
  if (!direct) return { direct: null, lead: null, mainOverride: false, development: null };
  // Gap report A9: the signer's place in the team on the shop's registration date, not today's.
  const placed = await mappingAt(tx, direct.id, at);
  const role = placed?.teamRole ?? direct.teamRole;
  const parentId = placed ? placed.parentId : direct.parentId;
  let lead: DealerSalesperson | null = null;
  if (role === "AGENT" && parentId) {
    const [p] = await tx.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, parentId));
    // An inactive lead is a missing level.
    lead = p && p.status === "ACTIVE" ? p : null;
  }
  // The team whose former lead may have a development bonus: the lead's team (or the lead's own shop).
  const teamLeadId = role === "TEAM_LEAD" ? direct.id : lead?.id ?? null;
  let development: Placement["development"] = null;
  if (teamLeadId) {
    const [dev] = await tx
      .select()
      .from(dealerTeamDevelopments)
      .where(and(eq(dealerTeamDevelopments.teamLeadMemberId, teamLeadId), lte(dealerTeamDevelopments.startsAt, at), gte(dealerTeamDevelopments.endsAt, at)))
      .orderBy(desc(dealerTeamDevelopments.startsAt))
      .limit(1);
    if (dev && dev.beneficiaryMemberId !== direct.id && dev.beneficiaryMemberId !== lead?.id) {
      const [member] = await tx.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, dev.beneficiaryMemberId));
      if (member && member.status === "ACTIVE") development = { id: dev.id, member, bp: dev.bp };
    }
  }
  return { direct, lead, mainOverride: true, development };
}

/* ======================================================= mapping history */

/** The place a member held at `at` (gap report A9); null when the history has no row for then. */
export async function mappingAt(client: DbClient, memberId: string, at: Date): Promise<DealerTeamMapping | null> {
  const [row] = await client
    .select()
    .from(dealerTeamMappingHistory)
    .where(and(eq(dealerTeamMappingHistory.memberId, memberId), lte(dealerTeamMappingHistory.validFrom, at), or(isNull(dealerTeamMappingHistory.validTo), gt(dealerTeamMappingHistory.validTo, at))))
    .orderBy(desc(dealerTeamMappingHistory.validFrom))
    .limit(1);
  return row ?? null;
}

/**
 * Closes the member's open place and opens the current one (role, level, lead)
 * from `at`. Called by every change of place, inside its transaction.
 */
export async function recordMapping(tx: DbClient, memberId: string, reason: string, actorId: string | null, at: Date = new Date()): Promise<void> {
  const [m] = await tx.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, memberId));
  if (!m) return;
  const [open] = await tx.select().from(dealerTeamMappingHistory).where(and(eq(dealerTeamMappingHistory.memberId, memberId), isNull(dealerTeamMappingHistory.validTo)));
  if (open && open.teamRole === m.teamRole && open.depth === m.depth && open.parentId === m.parentId) return;
  if (open) await tx.update(dealerTeamMappingHistory).set({ validTo: at }).where(eq(dealerTeamMappingHistory.id, open.id));
  await tx.insert(dealerTeamMappingHistory).values({ dealerId: m.dealerId, memberId, teamRole: m.teamRole, depth: m.depth, parentId: m.parentId, validFrom: at, reason: reason.slice(0, 500), changedBy: actorId });
}

export interface MappingHistoryRow {
  memberId: string;
  memberName: string;
  role: TeamRole;
  level: number;
  leadName: string | null;
  validFrom: Date;
  validTo: Date | null;
  reason: string;
  changedBy: string | null;
}

/** A dealer's mapping history, newest first (admin, and the main dealer for his own network). */
export async function mappingHistory(dealerId: string, memberId?: string): Promise<MappingHistoryRow[]> {
  const rows = await db
    .select({ h: dealerTeamMappingHistory, memberName: dealerSalespeople.name })
    .from(dealerTeamMappingHistory)
    .innerJoin(dealerSalespeople, eq(dealerSalespeople.id, dealerTeamMappingHistory.memberId))
    .where(and(eq(dealerTeamMappingHistory.dealerId, dealerId), memberId ? eq(dealerTeamMappingHistory.memberId, memberId) : sql`true`))
    .orderBy(desc(dealerTeamMappingHistory.validFrom))
    .limit(2000);
  const names = new Map((await db.select({ id: dealerSalespeople.id, name: dealerSalespeople.name }).from(dealerSalespeople).where(eq(dealerSalespeople.dealerId, dealerId))).map((m) => [m.id, m.name]));
  return rows.map(({ h, memberName }) => ({
    memberId: h.memberId,
    memberName,
    role: h.teamRole,
    level: h.depth,
    leadName: h.parentId ? (names.get(h.parentId) ?? null) : null,
    validFrom: h.validFrom,
    validTo: h.validTo,
    reason: h.reason,
    changedBy: h.changedBy,
  }));
}

/* ================================================================ ledger */

interface EntryInput {
  dealer: Dealer;
  payee: DealerSalesperson | null;
  shopId: string | null;
  salespersonId: string | null;
  milestone: LedgerMilestone;
  entryType: CommissionEntryType;
  accrualKey: string;
  feePaise: number;
  basePaise: number;
  bonusBp?: number;
  bonusPaise?: number;
  amountPaise: number;
  /** Counted against the per-shop cap. */
  capped: boolean;
  capPaise: number;
  holdForDocuments?: boolean;
  note?: string | null;
  createdAt?: Date;
  actor: Actor | null;
}

/**
 * Writes one TIERED accrual (and its above-cap part), once per accrual key.
 * Held ON_HOLD while the dealer is not approved, for the shop's documents, or
 * until the payee accepts the agent agreement. Call under the dealer lock.
 */
async function writeEntry(tx: DbClient, input: EntryInput): Promise<DealerCommissionEntry[]> {
  const [already] = await tx
    .select({ id: dealerCommissionLedger.id })
    .from(dealerCommissionLedger)
    .where(and(eq(dealerCommissionLedger.accrualKey, input.accrualKey), eq(dealerCommissionLedger.kind, "ACCRUAL")));
  if (already) return [];
  let within = input.amountPaise;
  if (input.capped && input.shopId) {
    const [{ net }] = await tx
      .select({ net: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}) filter (where ${dealerCommissionLedger.status} <> 'REVERSED' and not ${dealerCommissionLedger.aboveCap}), 0)::int` })
      .from(dealerCommissionLedger)
      .where(and(eq(dealerCommissionLedger.shopId, input.shopId), inArray(dealerCommissionLedger.entryType, CAP_COUNTED_TYPES)));
    within = Math.min(input.amountPaise, Math.max(0, input.capPaise - net));
  }
  const above = input.amountPaise - within;
  const notes: string[] = [];
  if (input.holdForDocuments) notes.push(DOCUMENTS_HOLD_NOTE);
  if (!agreementAccepted(input.payee, input.dealer)) notes.push(AGREEMENT_HOLD_NOTE);
  const held = input.dealer.status !== "APPROVED" || notes.length > 0;
  const common = {
    dealerId: input.dealer.id,
    salespersonId: input.salespersonId,
    shopId: input.shopId,
    milestone: input.milestone,
    kind: "ACCRUAL" as const,
    entryType: input.entryType,
    payeeMemberId: input.payee?.id ?? null,
    level: levelOf(input.payee),
    accrualKey: input.accrualKey,
    feePaise: input.feePaise,
    basePaise: input.basePaise,
    rating: input.dealer.rating,
    bonusBp: input.bonusBp ?? 0,
    bonusPaise: input.bonusPaise ?? 0,
    createdBy: input.actor?.id ?? null,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  };
  const rows = [];
  if (within > 0 || above === 0) {
    rows.push({
      ...common,
      amountPaise: within,
      aboveCap: false,
      status: (held ? "ON_HOLD" : "EARNED") as CommissionStatus,
      heldFromStatus: (held ? "EARNED" : null) as CommissionStatus | null,
      note: [...notes, input.note].filter(Boolean).join("; ") || null,
    });
  }
  if (above > 0) {
    rows.push({
      ...common,
      amountPaise: above,
      aboveCap: true,
      status: (held ? "ON_HOLD" : "PENDING") as CommissionStatus,
      heldFromStatus: (held ? "PENDING" : null) as CommissionStatus | null,
      note: [...notes, input.note, `above the per-shop cap of ${rupees(input.capPaise)} — needs an admin override`].filter(Boolean).join("; "),
    });
  }
  return tx.insert(dealerCommissionLedger).values(rows).returning();
}

/** Tells each payee what they earned, after the commit (push too). */
async function tellPayees(dealer: Dealer, entries: DealerCommissionEntry[], shopName: string | null, client: DbClient = db): Promise<void> {
  const byPayee = new Map<string, DealerCommissionEntry[]>();
  for (const e of entries) {
    if (e.amountPaise <= 0) continue;
    const key = e.payeeMemberId ?? "main";
    byPayee.set(key, [...(byPayee.get(key) ?? []), e]);
  }
  for (const [key, rows] of byPayee) {
    const userId = key === "main" ? dealer.userId : (await client.select({ userId: dealerSalespeople.userId }).from(dealerSalespeople).where(eq(dealerSalespeople.id, key)))[0]?.userId;
    if (!userId) continue;
    const amount = rows.reduce((s, r) => s + r.amountPaise, 0);
    const what = [...new Set(rows.map((r) => ENTRY_WORDS[r.entryType]))].join(", ");
    await notify(
      {
        userId,
        type: NOTIFICATION_TYPES.DEALER_COMMISSION_EARNED,
        vars: { amount: rupees(amount), what: what.charAt(0).toUpperCase() + what.slice(1), shopName: shopName ?? "your team" },
        actionUrl: "/dealer",
        channels: ["PUSH"],
        dedupeKey: `dealer-earned:${rows.map((r) => r.id).sort()[0]}`,
      },
      client,
    );
  }
}

const ENTRY_WORDS: Record<CommissionEntryType, string> = {
  BASE: "commission",
  DIRECT_1: "direct commission (part 1)",
  DIRECT_2: "direct commission (part 2)",
  OVERRIDE_LEAD: "team-lead override",
  OVERRIDE_MAIN: "main-dealer override",
  RENEWAL: "renewal commission",
  DEVELOPMENT: "development bonus",
  BONUS: "target bonus",
};

/* ============================================================= activation */

/**
 * ACTIVATED for a TIERED dealer's shop: freezes the plan (who earns what) and
 * accrues the first part of the direct commission. Idempotent. Called from
 * checkCommissionMilestones in place of the standard accrual.
 */
export async function accrueTieredActivation(
  shop: Shop,
  dealerId: string,
  salespersonId: string | null,
  district: string | null,
  settings: DealerCommissionSettings,
  actor: Actor | null,
  options: { holdForDocuments?: boolean } = {},
): Promise<DealerCommissionEntry[]> {
  const rule = await tierRule();
  const bonusOn = flagCoversDistrict(await getFeatureFlag("dealer_rating_bonus_enabled"), district);
  const result = await db.transaction(async (tx) => {
    // The dealer row is the gate (the cap sums this shop's other entries).
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, dealerId)).for("update");
    await touchSellerRow(tx, dealers, dealerId);
    if (!dealer || dealer.isInternal) return null;
    const [attribution] = await tx.select().from(shopAttributions).where(eq(shopAttributions.shopId, shop.id));
    if (!attribution || attribution.status !== "ACTIVE" || attribution.dealerId !== dealerId) return null;
    if (attribution.matchKind === "DUPLICATE") return null;
    if (attribution.matchKind === "BRANCH" && !settings.branchEligible) return null;

    let [plan] = await tx.select().from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, shop.id));
    const now = new Date();
    // Only a fee actually paid earns (brief A2 / A10): an approved shop whose fee is still due earns nothing yet;
    // the fee payment re-runs the milestone check (recordPayment → approval hooks).
    if (!plan && shop.feePaymentStatus !== "PAID") return null;
    // A shop that already earned on the standard model stays there (checked again under the lock).
    if (!plan && (await hasStandardCommission(tx, shop.id))) return null;
    if (!plan) {
      const fee = feeBasePaise(shop);
      if (fee <= 0) return null;
      // Gap report A9: who earns follows the team on the shop's registration date.
      const place = await placementFor(tx, dealerId, salespersonId, shop.createdAt);
      const rates = tierRatesFor(dealer, rule);
      const adj = bonusOn ? ratingAdjustmentBp(dealer.rating, dealer.ratingStepBp ?? settings.ratingStepBp) : 0;
      [plan] = await tx
        .insert(dealerTierShopPlans)
        .values({
          shopId: shop.id,
          dealerId,
          directMemberId: place.direct?.id ?? null,
          directLevel: levelOf(place.direct),
          leadMemberId: place.lead?.id ?? null,
          mainOverride: place.mainOverride,
          developmentId: place.development?.id ?? null,
          developmentMemberId: place.development?.member.id ?? null,
          feePaise: fee,
          directBp: rates.directBp,
          ratingAdjustmentBp: adj,
          firstPartBp: rates.firstPartBp,
          leadOverrideBp: rates.leadOverrideBp,
          mainOverrideBp: rates.mainOverrideBp,
          developmentBp: place.development?.bp ?? 0,
          tradingOrders: rule.tradingOrders,
          activatedAt: now,
          tradingDeadline: new Date(now.getTime() + rule.tradingDays * DAY),
        })
        .returning();
      await recordAudit(
        {
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          action: AUDIT_ACTIONS.DEALER_TIER_PLAN_CHANGED,
          entityType: "shop",
          entityId: shop.id,
          newValue: { created: true, ...planAudit(plan) },
        },
        tx,
      );
    }
    if (plan.status === "REVERSED") return null;
    const amounts = planAmounts(plan);
    const payee = plan.directMemberId ? ((await tx.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, plan.directMemberId)))[0] ?? null) : null;
    const rows = await writeEntry(tx, {
      dealer,
      payee,
      shopId: shop.id,
      salespersonId,
      milestone: "ACTIVATED",
      entryType: "DIRECT_1",
      accrualKey: `D1:${shop.id}`,
      feePaise: plan.feePaise,
      basePaise: Math.round((plan.feePaise * plan.directBp * plan.firstPartBp) / 100_000_000),
      bonusBp: plan.ratingAdjustmentBp,
      bonusPaise: amounts.direct1Paise - Math.round((plan.feePaise * plan.directBp * plan.firstPartBp) / 100_000_000),
      amountPaise: amounts.direct1Paise,
      capped: true,
      capPaise: settings.capPaise,
      holdForDocuments: options.holdForDocuments,
      actor,
    });
    if (rows.length) {
      await recordAudit(
        {
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          action: AUDIT_ACTIONS.DEALER_COMMISSION_ACCRUED,
          entityType: "shop",
          entityId: shop.id,
          newValue: { dealerId, model: "TIERED", entryType: "DIRECT_1", feePaise: plan.feePaise, amountPaise: amounts.direct1Paise, entries: rows.map((r) => ({ id: r.id, amountPaise: r.amountPaise, status: r.status })) },
        },
        tx,
      );
    }
    return { dealer, rows };
  });
  if (!result) return [];
  await tellPayees(result.dealer, result.rows, shop.name);
  return result.rows;
}

/** The amounts a frozen plan pays. */
export function planAmounts(plan: DealerTierShopPlan): TierAmounts {
  return tierAmounts(
    plan.feePaise,
    { directBp: plan.directBp, leadOverrideBp: plan.leadOverrideBp, mainOverrideBp: plan.mainOverrideBp, firstPartBp: plan.firstPartBp },
    { ratingAdjustmentBp: plan.ratingAdjustmentBp, hasLead: Boolean(plan.leadMemberId), hasMain: plan.mainOverride, developmentBp: plan.developmentMemberId ? plan.developmentBp : 0 },
  );
}

const planAudit = (p: DealerTierShopPlan) => ({
  dealerId: p.dealerId,
  directMemberId: p.directMemberId,
  directLevel: p.directLevel,
  leadMemberId: p.leadMemberId,
  mainOverride: p.mainOverride,
  developmentMemberId: p.developmentMemberId,
  feePaise: p.feePaise,
  directBp: p.directBp,
  ratingAdjustmentBp: p.ratingAdjustmentBp,
  firstPartBp: p.firstPartBp,
  leadOverrideBp: p.leadOverrideBp,
  mainOverrideBp: p.mainOverrideBp,
  developmentBp: p.developmentBp,
  tradingOrders: p.tradingOrders,
  tradingDeadline: p.tradingDeadline.toISOString(),
  status: p.status,
});

/* ================================================================ trading */

/** Orders the shop delivered in [from, to] (paid online or cash on delivery): the DELIVERED step of each order's history. */
async function deliveredSince(client: DbClient, shopId: string, from: Date, to: Date): Promise<number> {
  const [row] = await client
    .select({ n: sql<number>`count(distinct ${orderStatusHistory.orderId})::int` })
    .from(orderStatusHistory)
    .innerJoin(orders, eq(orders.id, orderStatusHistory.orderId))
    .where(and(eq(orders.shopId, shopId), eq(orderStatusHistory.newStatus, "DELIVERED"), gte(orderStatusHistory.createdAt, from), lte(orderStatusHistory.createdAt, to)));
  return row?.n ?? 0;
}

/**
 * TRADING: after a delivered order (and from the daily job). The shop's plan
 * waits for tradingOrders deliveries within the window; reached → part 2 of the
 * direct commission and every override; the deadline passed → they lapse.
 * Idempotent; cheap when the rule is off or the shop has no open plan.
 */
export async function checkTradingMilestone(
  shopId: string,
  now: Date = new Date(),
  actor: Actor | null = null,
  client: DbClient = db,
): Promise<"NONE" | "WAITING" | "TRADING" | "LAPSED"> {
  if (!(await tierRule()).enabled) return "NONE";
  const [plan] = await client.select().from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, shopId));
  if (!plan || plan.status !== "PENDING") return "NONE";
  const delivered = await deliveredSince(client, shopId, plan.activatedAt, new Date(Math.min(now.getTime(), plan.tradingDeadline.getTime())));
  if (delivered >= plan.tradingOrders) {
    await settleTrading(plan, "TRADING", delivered, actor, client);
    return "TRADING";
  }
  if (now.getTime() > plan.tradingDeadline.getTime()) {
    await settleTrading(plan, "LAPSED", delivered, actor, client);
    return "LAPSED";
  }
  if (delivered !== plan.deliveredOrders) {
    await client.update(dealerTierShopPlans).set({ deliveredOrders: delivered, updatedAt: new Date() }).where(and(eq(dealerTierShopPlans.shopId, shopId), eq(dealerTierShopPlans.status, "PENDING")));
  }
  return "WAITING";
}

/**
 * The order-delivered hook (orders.ts), inside the delivery's transaction: the
 * order just delivered counts. The caller runs it under a savepoint, so a
 * problem here never blocks the delivery.
 */
export async function checkTradingOnDelivery(orderId: string, tx: DbClient): Promise<void> {
  if (!(await tierRule()).enabled) return;
  if (!(await getFeatureFlag("dealer_programme_enabled")).enabled) return;
  const [order] = await tx.select({ shopId: orders.shopId, status: orders.status }).from(orders).where(eq(orders.id, orderId));
  if (!order || order.status !== "DELIVERED") return;
  await checkTradingMilestone(order.shopId, new Date(), null, tx);
}

async function settleTrading(plan: DealerTierShopPlan, outcome: "TRADING" | "LAPSED", delivered: number, actor: Actor | null, client: DbClient = db): Promise<void> {
  const settings = await getCommissionSettings(client);
  const amounts = planAmounts(plan);
  const days = Math.round((plan.tradingDeadline.getTime() - plan.activatedAt.getTime()) / DAY);
  const result = await client.transaction(async (tx) => {
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, plan.dealerId)).for("update");
    await touchSellerRow(tx, dealers, plan.dealerId);
    const [locked] = await tx.select().from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, plan.shopId)).for("update");
    if (!dealer || !locked || locked.status !== "PENDING") return null;
    const members = new Map(
      (
        await tx
          .select()
          .from(dealerSalespeople)
          .where(inArray(dealerSalespeople.id, [plan.directMemberId, plan.leadMemberId, plan.developmentMemberId].filter((x): x is string => Boolean(x)).concat(["00000000-0000-0000-0000-000000000000"])))
      ).map((m) => [m.id, m]),
    );
    const member = (id: string | null) => (id ? (members.get(id) ?? null) : null);
    const [attribution] = await tx.select({ salespersonId: shopAttributions.salespersonId }).from(shopAttributions).where(eq(shopAttributions.shopId, plan.shopId));
    const parts: { entryType: CommissionEntryType; payee: DealerSalesperson | null; amount: number; key: string; capped: boolean }[] = [
      { entryType: "DIRECT_2", payee: member(plan.directMemberId), amount: amounts.direct2Paise, key: `D2:${plan.shopId}`, capped: true },
    ];
    if (plan.leadMemberId) parts.push({ entryType: "OVERRIDE_LEAD", payee: member(plan.leadMemberId), amount: amounts.leadPaise, key: `OL:${plan.shopId}`, capped: true });
    if (plan.mainOverride) parts.push({ entryType: "OVERRIDE_MAIN", payee: null, amount: amounts.mainPaise, key: `OM:${plan.shopId}`, capped: true });
    if (plan.developmentMemberId && amounts.developmentPaise > 0) {
      parts.push({ entryType: "DEVELOPMENT", payee: member(plan.developmentMemberId), amount: amounts.developmentPaise, key: `DV:${plan.shopId}`, capped: false });
    }
    const written: DealerCommissionEntry[] = [];
    for (const part of parts) {
      if (outcome === "TRADING") {
        if (part.amount <= 0) continue;
        written.push(
          ...(await writeEntry(tx, {
            dealer,
            payee: part.payee,
            shopId: plan.shopId,
            salespersonId: attribution?.salespersonId ?? null,
            milestone: "TRADING",
            entryType: part.entryType,
            accrualKey: part.key,
            feePaise: plan.feePaise,
            basePaise: part.amount,
            amountPaise: part.amount,
            capped: part.capped,
            capPaise: settings.capPaise,
            actor,
          })),
        );
      } else {
        // The lapse is a ledger note: a zero entry that also stops any later accrual of that part.
        const [already] = await tx.select({ id: dealerCommissionLedger.id }).from(dealerCommissionLedger).where(and(eq(dealerCommissionLedger.accrualKey, part.key), eq(dealerCommissionLedger.kind, "ACCRUAL")));
        if (already) continue;
        const [row] = await tx
          .insert(dealerCommissionLedger)
          .values({
            dealerId: dealer.id,
            salespersonId: attribution?.salespersonId ?? null,
            shopId: plan.shopId,
            milestone: "TRADING",
            kind: "ACCRUAL",
            entryType: part.entryType,
            payeeMemberId: part.payee?.id ?? null,
            level: levelOf(part.payee),
            accrualKey: part.key,
            feePaise: plan.feePaise,
            basePaise: 0,
            amountPaise: 0,
            status: "REVERSED",
            note: `lapsed: ${delivered} of ${plan.tradingOrders} orders delivered within ${days} days of activation — ${rupees(part.amount)} not earned`,
            createdBy: actor?.id ?? null,
          })
          .returning();
        written.push(row);
      }
    }
    const now = new Date();
    await tx
      .update(dealerTierShopPlans)
      .set({ status: outcome, deliveredOrders: delivered, ...(outcome === "TRADING" ? { tradingAt: now } : { lapsedAt: now }), updatedAt: now })
      .where(eq(dealerTierShopPlans.shopId, plan.shopId));
    await recordAudit(
      {
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        action: AUDIT_ACTIONS.DEALER_TIER_PLAN_CHANGED,
        entityType: "shop",
        entityId: plan.shopId,
        previousValue: { status: "PENDING", deliveredOrders: plan.deliveredOrders },
        newValue: { status: outcome, deliveredOrders: delivered, entries: written.map((e) => ({ id: e.id, entryType: e.entryType, amountPaise: e.amountPaise, status: e.status })) },
      },
      tx,
    );
    return { dealer, written };
  });
  if (result && outcome === "TRADING") {
    const [shop] = await client.select({ name: shops.name }).from(shops).where(eq(shops.id, plan.shopId));
    await tellPayees(result.dealer, result.written, shop?.name ?? null, client);
  }
}

/** The daily job: plans past their deadline lapse (and any that reached TRADING meanwhile are paid). */
export async function runTieredDaily(now: Date = new Date()): Promise<{ checked: number; trading: number; lapsed: number } | { skipped: string }> {
  if (!(await tierRule()).enabled) return { skipped: "rule dealerTieredCommission off" };
  if (!(await getFeatureFlag("dealer_programme_enabled")).enabled) return { skipped: "dealer programme off" };
  const due = await db
    .select({ shopId: dealerTierShopPlans.shopId })
    .from(dealerTierShopPlans)
    .where(and(eq(dealerTierShopPlans.status, "PENDING"), lte(dealerTierShopPlans.tradingDeadline, now)))
    .limit(5000);
  let trading = 0;
  let lapsed = 0;
  for (const { shopId } of due) {
    try {
      const outcome = await checkTradingMilestone(shopId, now);
      if (outcome === "TRADING") trading += 1;
      if (outcome === "LAPSED") lapsed += 1;
    } catch (error) {
      console.error("[dealers] daily trading check failed", shopId, error instanceof Error ? error.message : error);
    }
  }
  return { checked: due.length, trading, lapsed };
}

/* ================================================================ renewal */

/**
 * A membership renewal fee was paid for a shop that is still active: the shop's
 * direct earner gets renewalBp of it (before GST). Once per payment. Only for a
 * TIERED shop (one with a plan) that is not reversed.
 */
export async function accrueRenewalCommission(paymentId: string, actor: Actor | null): Promise<DealerCommissionEntry[]> {
  const rule = await tierRule();
  if (!rule.enabled || !rule.renewalEnabled || rule.renewalBp <= 0) return [];
  if (!(await getFeatureFlag("dealer_programme_enabled")).enabled) return [];
  const [payment] = await db.select().from(shopPayments).where(eq(shopPayments.id, paymentId));
  if (!payment || payment.paymentType !== "RENEWAL" || payment.amountPaise <= 0) return [];
  const [plan] = await db.select().from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, payment.shopId));
  if (!plan || plan.status === "REVERSED") return [];
  const [row] = await db.select({ shop: shops, a: shopAttributions }).from(shops).innerJoin(shopAttributions, eq(shopAttributions.shopId, shops.id)).where(eq(shops.id, payment.shopId));
  if (!row || row.shop.status !== "APPROVED" || row.a.status !== "ACTIVE") return [];
  const base = renewalBasePaise(Number(payment.amountPaise), await registrationFeeGstRateBp(payment.paidAt));
  const amount = Math.round((base * rule.renewalBp) / 10_000);
  if (amount <= 0) return [];
  const settings = await getCommissionSettings();
  const result = await db.transaction(async (tx) => {
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, plan.dealerId)).for("update");
    await touchSellerRow(tx, dealers, plan.dealerId);
    if (!dealer || dealer.isInternal || dealer.commissionModel !== "TIERED") return null;
    const payee = plan.directMemberId ? ((await tx.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, plan.directMemberId)))[0] ?? null) : null;
    const rows = await writeEntry(tx, {
      dealer,
      payee,
      shopId: plan.shopId,
      salespersonId: row.a.salespersonId,
      milestone: "RENEWAL",
      entryType: "RENEWAL",
      accrualKey: `RN:${payment.id}`,
      feePaise: base,
      basePaise: amount,
      amountPaise: amount,
      capped: false,
      capPaise: settings.capPaise,
      note: `renewal ${payment.reference}`,
      actor,
    });
    if (rows.length) {
      await recordAudit(
        {
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          action: AUDIT_ACTIONS.DEALER_COMMISSION_ACCRUED,
          entityType: "shop",
          entityId: plan.shopId,
          newValue: { dealerId: dealer.id, model: "TIERED", entryType: "RENEWAL", paymentId, renewalBasePaise: base, renewalBp: rule.renewalBp, amountPaise: amount },
        },
        tx,
      );
    }
    return { dealer, rows };
  });
  if (!result) return [];
  await tellPayees(result.dealer, result.rows, row.shop.name);
  return result.rows;
}

export async function accrueRenewalCommissionSafely(paymentId: string, actor: Actor | null): Promise<void> {
  try {
    await accrueRenewalCommission(paymentId, actor);
  } catch (error) {
    console.error("[dealers] renewal commission failed", paymentId, error instanceof Error ? error.message : error);
  }
}

/* ========================================================= target bonuses */

/**
 * At the month's close (before the payouts are drafted): each payee of a TIERED
 * dealer who reached a target that month gets the highest one reached — an
 * agent for the shops he signed, a lead for his team's, the main dealer for the
 * whole network ("activated" = the plan created that month and not reversed).
 * Dated inside the month so the close picks it up. Once per payee and month.
 */
export async function accrueTargetBonuses(tx: DbClient, month: string, start: Date, end: Date, actor: Actor | null): Promise<DealerCommissionEntry[]> {
  const rule = await tierRule();
  if (!rule.enabled || !rule.targetBonusesEnabled || rule.targets.length === 0) return [];
  const plans = await tx
    .select()
    .from(dealerTierShopPlans)
    .where(and(gte(dealerTierShopPlans.activatedAt, start), lt(dealerTierShopPlans.activatedAt, end), ne(dealerTierShopPlans.status, "REVERSED")));
  if (plans.length === 0) return [];
  const settings = await getCommissionSettings(tx);
  const bestTarget = (role: NetworkRole, n: number) =>
    rule.targets
      .filter((t) => t.role === role && n >= t.minShops)
      .sort((a, b) => b.minShops - a.minShops || b.bonusPaise - a.bonusPaise)[0] ?? null;
  const out: DealerCommissionEntry[] = [];
  for (const dealerId of [...new Set(plans.map((p) => p.dealerId))].sort()) {
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, dealerId)).for("update");
    await touchSellerRow(tx, dealers, dealerId);
    if (!dealer || dealer.isInternal || dealer.commissionModel !== "TIERED") continue;
    const mine = plans.filter((p) => p.dealerId === dealerId);
    const members = await tx.select().from(dealerSalespeople).where(eq(dealerSalespeople.dealerId, dealerId));
    const counts: { payee: DealerSalesperson | null; n: number }[] = [{ payee: null, n: mine.length }];
    for (const m of members) {
      const n = m.teamRole === "TEAM_LEAD" ? mine.filter((p) => p.directMemberId === m.id || p.leadMemberId === m.id).length : mine.filter((p) => p.directMemberId === m.id).length;
      if (n > 0) counts.push({ payee: m, n });
    }
    for (const { payee, n } of counts) {
      const target = bestTarget(roleOf(payee), n);
      if (!target || target.bonusPaise <= 0) continue;
      out.push(
        ...(await writeEntry(tx, {
          dealer,
          payee,
          shopId: null,
          salespersonId: payee?.id ?? null,
          milestone: "MONTHLY",
          entryType: "BONUS",
          accrualKey: `BN:${dealerId}:${payee?.id ?? "main"}:${month}`,
          feePaise: 0,
          basePaise: target.bonusPaise,
          amountPaise: target.bonusPaise,
          capped: false,
          capPaise: settings.capPaise,
          note: `${month}: ${n} shops activated — target ${target.minShops} reached`,
          createdAt: new Date(end.getTime() - 1),
          actor,
        })),
      );
    }
  }
  return out;
}

/* ============================================================ the network */

export interface TeamMemberView {
  id: string;
  employeeId: string;
  name: string;
  role: TeamRole;
  level: number;
  parentId: string | null;
  recruitedById: string | null;
  status: DealerSalesperson["status"];
  userId: string | null;
  agreementAccepted: boolean;
  panOnFile: boolean;
  bankStatus: DealerSalesperson["bankStatus"];
  bankLast4: string | null;
  activatedShops: number;
  promotedAt: Date | null;
  /** "+91••••••1234" (gap report A9: masked, never left out). */
  mobileMasked: string | null;
}

export interface TeamTree {
  dealer: { id: string; name: string; model: Dealer["commissionModel"]; agreementAccepted: boolean; activatedShops: number };
  /** Level-2 members (leads and agents straight under the main dealer), each with their agents. */
  members: (TeamMemberView & { agents: TeamMemberView[] })[];
  pendingRequests: number;
}

async function activatedCounts(dealerId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ member: dealerTierShopPlans.directMemberId, n: sql<number>`count(*)::int` })
    .from(dealerTierShopPlans)
    .where(and(eq(dealerTierShopPlans.dealerId, dealerId), ne(dealerTierShopPlans.status, "REVERSED")))
    .groupBy(dealerTierShopPlans.directMemberId);
  return new Map(rows.map((r) => [r.member ?? "main", r.n]));
}

export async function teamTree(dealerId: string): Promise<TeamTree> {
  const [dealer] = await db.select().from(dealers).where(eq(dealers.id, dealerId));
  if (!dealer) throw notFound("Dealer");
  const [members, counts, [{ pending }]] = await Promise.all([
    db.select().from(dealerSalespeople).where(eq(dealerSalespeople.dealerId, dealerId)).orderBy(asc(dealerSalespeople.createdAt)),
    activatedCounts(dealerId),
    db.select({ pending: sql<number>`count(*)::int` }).from(dealerTeamRequests).where(and(eq(dealerTeamRequests.dealerId, dealerId), eq(dealerTeamRequests.status, "PENDING"))),
  ]);
  const view = (m: DealerSalesperson): TeamMemberView => ({
    id: m.id,
    employeeId: m.employeeId,
    name: m.name,
    role: m.teamRole,
    level: m.depth,
    parentId: m.parentId,
    recruitedById: m.recruitedById,
    status: m.status,
    userId: m.userId,
    agreementAccepted: m.agreementVersion === AGENT_AGREEMENT_VERSION,
    panOnFile: Boolean(m.panHash),
    bankStatus: m.bankStatus,
    bankLast4: m.bankAccountLast4,
    activatedShops: counts.get(m.id) ?? 0,
    promotedAt: m.promotedAt,
    mobileMasked: maskMobile(m.mobileE164),
  });
  return {
    dealer: {
      id: dealer.id,
      name: dealer.legalName,
      model: dealer.commissionModel,
      agreementAccepted: dealer.tierAgreementVersion === AGENT_AGREEMENT_VERSION,
      activatedShops: [...counts.values()].reduce((s, n) => s + n, 0),
    },
    members: members.filter((m) => m.depth === 2).map((m) => ({ ...view(m), agents: members.filter((a) => a.parentId === m.id).map(view) })),
    pendingRequests: pending,
  };
}

const maskMobile = (e164: string | null) => (e164 ? `${e164.slice(0, 3)}••••••${e164.slice(-4)}` : null);

/* ======================================================= team mapping table */

export interface TeamMappingRow {
  /** Null: the main dealer's own row. */
  memberId: string | null;
  employeeId: string;
  name: string;
  mobileMasked: string | null;
  role: NetworkRole;
  level: number;
  leadName: string | null;
  status: string;
  agreementAccepted: boolean;
  code: string | null;
  registered: number;
  activated: number;
  trading: number;
  /** Shops of theirs with a delivered order in the last 30 days. */
  active30: number;
  commissionMonthPaise: number;
  commissionAllPaise: number;
}

/**
 * Gap report A9: the team mapping table — every person in the network with
 * their place, counts and commission; filters by role, lead and status.
 */
export async function teamMapping(dealerId: string, filter: { role?: NetworkRole; leadId?: string; status?: "ACTIVE" | "INACTIVE" } = {}): Promise<TeamMappingRow[]> {
  const [dealer] = await db.select().from(dealers).where(eq(dealers.id, dealerId));
  if (!dealer) throw notFound("Dealer");
  const { listDealerCodes } = await import("./codes");
  const [members, attributions, plans, ledger, codes] = await Promise.all([
    db.select().from(dealerSalespeople).where(eq(dealerSalespeople.dealerId, dealerId)).orderBy(asc(dealerSalespeople.createdAt)),
    db.select({ shopId: shopAttributions.shopId, member: shopAttributions.salespersonId, status: shopAttributions.status, activatedAt: shopAttributions.activatedAt }).from(shopAttributions).where(eq(shopAttributions.dealerId, dealerId)),
    db.select({ shopId: dealerTierShopPlans.shopId, member: dealerTierShopPlans.directMemberId, status: dealerTierShopPlans.status }).from(dealerTierShopPlans).where(eq(dealerTierShopPlans.dealerId, dealerId)),
    db
      .select({ payee: dealerCommissionLedger.payeeMemberId, amount: dealerCommissionLedger.amountPaise, status: dealerCommissionLedger.status, createdAt: dealerCommissionLedger.createdAt })
      .from(dealerCommissionLedger)
      .where(eq(dealerCommissionLedger.dealerId, dealerId)),
    listDealerCodes(dealerId),
  ]);
  const since = new Date(Date.now() - 30 * DAY);
  const shopIds = attributions.filter((a) => a.status === "ACTIVE").map((a) => a.shopId);
  const activeShops = new Set(
    shopIds.length
      ? (
          await db
            .selectDistinct({ shopId: orders.shopId })
            .from(orderStatusHistory)
            .innerJoin(orders, eq(orders.id, orderStatusHistory.orderId))
            .where(and(inArray(orders.shopId, shopIds), eq(orderStatusHistory.newStatus, "DELIVERED"), gte(orderStatusHistory.createdAt, since)))
        ).map((r) => r.shopId)
      : [],
  );
  const monthStart = new Date(`${new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7)}-01T00:00:00+05:30`);
  const names = new Map(members.map((m) => [m.id, m.name]));
  const row = (m: DealerSalesperson | null): TeamMappingRow => {
    const key = m?.id ?? null;
    const mine = attributions.filter((a) => a.status === "ACTIVE" && a.member === key);
    const earned = ledger.filter((e) => e.payee === key && e.status !== "REVERSED");
    const code = codes.filter((c) => c.status === "ACTIVE" && (m ? c.salespersonId === m.id : c.kind !== "SALESPERSON")).at(-1)?.code ?? null;
    return {
      memberId: key,
      employeeId: m?.employeeId ?? "—",
      name: m?.name ?? dealer.legalName,
      mobileMasked: maskMobile(m ? m.mobileE164 : dealer.mobileE164),
      role: roleOf(m),
      level: levelOf(m),
      leadName: m?.parentId ? (names.get(m.parentId) ?? null) : null,
      status: m?.status ?? dealer.status,
      agreementAccepted: agreementAccepted(m, dealer),
      code,
      registered: mine.length,
      activated: mine.filter((a) => a.activatedAt).length,
      trading: plans.filter((p) => p.member === key && p.status === "TRADING").length,
      active30: mine.filter((a) => activeShops.has(a.shopId)).length,
      commissionMonthPaise: earned.filter((e) => e.createdAt >= monthStart).reduce((t, e) => t + e.amount, 0),
      commissionAllPaise: earned.reduce((t, e) => t + e.amount, 0),
    };
  };
  return [row(null), ...members.map(row)].filter(
    (r) =>
      (!filter.role || r.role === filter.role) &&
      (!filter.status || r.status === filter.status) &&
      (!filter.leadId || members.find((m) => m.id === r.memberId)?.parentId === filter.leadId || r.memberId === filter.leadId),
  );
}

/** The team mapping table as CSV (masked mobiles). */
export function teamMappingCsv(rows: TeamMappingRow[]): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Employee ID", "Name", "Mobile", "Role", "Level", "Team lead", "Status", "Agreement", "Code", "Registered", "Activated", "Trading", "Active (30 days)", "Commission this month (Rs)", "Commission all time (Rs)"];
  return [
    head.map(esc).join(","),
    ...rows.map((r) =>
      [r.employeeId, r.name, r.mobileMasked ?? "", r.role, r.level, r.leadName ?? "", r.status, r.agreementAccepted ? "accepted" : "pending", r.code ?? "", r.registered, r.activated, r.trading, r.active30, r.commissionMonthPaise / 100, r.commissionAllPaise / 100]
        .map(esc)
        .join(","),
    ),
  ].join("\n");
}

export interface MemberShopRow {
  shopId: string;
  shopName: string;
  registrationNumber: string | null;
  pincode: string;
  signedBy: string;
  code: string | null;
  registeredOn: string;
  shopStatus: string;
  attribution: "ACTIVE" | "REVERSED";
  plan: DealerTierShopPlan["status"] | null;
}

/** Drill-down from the tree: the shops one person signed (memberId null: the main dealer's own). */
export async function memberShops(dealerId: string, memberId: string | null): Promise<MemberShopRow[]> {
  const rows = await db
    .select({ a: shopAttributions, shop: shops, signer: dealerSalespeople.name, plan: dealerTierShopPlans.status, code: referralCodes.code })
    .from(shopAttributions)
    .innerJoin(shops, eq(shops.id, shopAttributions.shopId))
    .leftJoin(dealerSalespeople, eq(dealerSalespeople.id, shopAttributions.salespersonId))
    .leftJoin(dealerTierShopPlans, eq(dealerTierShopPlans.shopId, shopAttributions.shopId))
    .leftJoin(referralCodes, eq(referralCodes.id, shopAttributions.referralCodeId))
    .where(and(eq(shopAttributions.dealerId, dealerId), memberId ? eq(shopAttributions.salespersonId, memberId) : isNull(shopAttributions.salespersonId)))
    .orderBy(desc(shopAttributions.createdAt))
    .limit(1000);
  return rows.map((r) => ({
    shopId: r.shop.id,
    shopName: r.shop.name,
    registrationNumber: r.shop.registrationNumber,
    pincode: r.shop.pincode,
    signedBy: r.signer ?? "Main dealer",
    code: r.code ?? null,
    registeredOn: new Date(r.shop.createdAt.getTime() + 330 * 60_000).toISOString().slice(0, 10),
    shopStatus: r.shop.status,
    attribution: r.a.status,
    plan: r.plan ?? null,
  }));
}

/** The team member behind a signed-in user (an agent or lead using the dealer portal), with their dealer. */
export async function getMemberForUser(userId: string): Promise<{ member: DealerSalesperson; dealer: Dealer } | null> {
  const [row] = await db
    .select({ member: dealerSalespeople, dealer: dealers })
    .from(dealerSalespeople)
    .innerJoin(dealers, eq(dealers.id, dealerSalespeople.dealerId))
    .where(and(eq(dealerSalespeople.userId, userId), eq(dealerSalespeople.status, "ACTIVE")))
    .limit(1);
  return row ?? null;
}

/** Service check for a new place in the tree: at most 3 levels, a parent is an active lead of the same dealer. */
async function assertPlacement(tx: DbClient, dealerId: string, role: TeamRole, parentId: string | null, selfId: string | null): Promise<{ depth: 2 | 3; parent: DealerSalesperson | null }> {
  if (role === "TEAM_LEAD") {
    if (parentId) throw validationFailed("A team lead reports to the main dealer: a network has at most 3 levels (main dealer → team lead → agent).", { fields: { parentId: "Leave empty." } });
    return { depth: 2, parent: null };
  }
  if (!parentId) return { depth: 2, parent: null };
  if (parentId === selfId) throw validationFailed("A member cannot report to themselves.");
  const [parent] = await tx.select().from(dealerSalespeople).where(and(eq(dealerSalespeople.id, parentId), eq(dealerSalespeople.dealerId, dealerId)));
  if (!parent) throw notFound("Team lead");
  if (parent.teamRole !== "TEAM_LEAD") {
    throw validationFailed("An agent can only report to a team lead or to the main dealer — a 4th level is not allowed.", { fields: { parentId: "Choose a team lead." } });
  }
  if (parent.status !== "ACTIVE") throw conflict("That team lead is not active.");
  return { depth: 3, parent };
}

/**
 * Places a new member (just added by addSalesperson) in the tree. Main dealer
 * (their own network) or admin; agents and leads ask through requestSubAgent.
 */
export async function placeNewMember(tx: DbClient, dealerId: string, memberId: string, role: TeamRole, parentId: string | null, recruitedById: string | null): Promise<void> {
  const { depth, parent } = await assertPlacement(tx, dealerId, role, parentId, memberId);
  await tx
    .update(dealerSalespeople)
    .set({ teamRole: role, depth, parentId: parent?.id ?? null, parentDepth: parent ? 2 : null, parentRole: parent ? "TEAM_LEAD" : null, recruitedById, updatedAt: new Date() })
    .where(eq(dealerSalespeople.id, memberId));
}

/**
 * ADMIN only: moves a member — a new role or a new lead. A lead with agents
 * cannot become an agent (move the agents first); the database refuses a 4th
 * level too. Shops already activated keep their frozen plan.
 */
export async function setMemberPlacement(memberId: string, input: { role: TeamRole; parentId: string | null }, reason: string, actor: Actor): Promise<DealerSalesperson> {
  requireAdmin(actor, "move team members");
  const why = requireReason(reason);
  const result = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, memberId)).for("update");
    if (!before) throw notFound("Team member");
    await tx.select({ id: dealers.id }).from(dealers).where(eq(dealers.id, before.dealerId)).for("update");
    await touchSellerRow(tx, dealers, before.dealerId);
    if (before.teamRole === "TEAM_LEAD" && input.role === "AGENT") {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(dealerSalespeople).where(eq(dealerSalespeople.parentId, memberId));
      if (n > 0) throw conflict(`This team lead still has ${n} agent(s); move them to another lead first.`);
    }
    const { depth, parent } = await assertPlacement(tx, before.dealerId, input.role, input.parentId, memberId);
    const [after] = await tx
      .update(dealerSalespeople)
      .set({ teamRole: input.role, depth, parentId: parent?.id ?? null, parentDepth: parent ? 2 : null, parentRole: parent ? "TEAM_LEAD" : null, updatedAt: new Date() })
      .where(eq(dealerSalespeople.id, memberId))
      .returning();
    await recordMapping(tx, memberId, why, actor.id);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_TEAM_CHANGED,
        entityType: "dealer_salesperson",
        entityId: memberId,
        previousValue: { role: before.teamRole, depth: before.depth, parentId: before.parentId },
        newValue: { role: after.teamRole, depth: after.depth, parentId: after.parentId, reason: why },
      },
      tx,
    );
    return after;
  });
  if (result.userId) {
    await notify({ userId: result.userId, type: NOTIFICATION_TYPES.DEALER_TEAM_CHANGED, vars: { message: `Your place in the team changed: you are now ${result.teamRole === "TEAM_LEAD" ? "a team lead" : "an agent"}. Shops already activated keep their commission as it was.` }, actionUrl: "/dealer" });
  }
  return result;
}

/**
 * ADMIN only: promotes an AGENT to TEAM_LEAD. Eligible with promotionMinShops
 * activated shops; below that only with `override` and a reason. He moves to
 * report to the main dealer and takes the agents he recruited (and theirs)
 * with him; his former lead earns developmentBp on that team for
 * developmentMonths (none when he reported to the main dealer).
 */
export async function promoteToTeamLead(memberId: string, input: { reason: string; override?: boolean }, actor: Actor): Promise<{ member: DealerSalesperson; movedAgents: number; developmentId: string | null }> {
  requireAdmin(actor, "promote team members");
  const why = requireReason(input.reason);
  const rule = await tierRule();
  const result = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, memberId)).for("update");
    if (!before) throw notFound("Team member");
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, before.dealerId)).for("update");
    await touchSellerRow(tx, dealers, before.dealerId);
    if (!dealer || dealer.commissionModel !== "TIERED") throw conflict("Promotion is part of the TIERED model: move the dealer to TIERED first.");
    if (before.teamRole !== "AGENT") throw conflict("Only an agent can be promoted to team lead.");
    if (before.status !== "ACTIVE") throw conflict("Only an active agent can be promoted.");
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(dealerTierShopPlans)
      .where(and(eq(dealerTierShopPlans.directMemberId, memberId), ne(dealerTierShopPlans.status, "REVERSED")));
    if (n < rule.promotionMinShops && !input.override) {
      throw conflict(`Not eligible yet: ${n} of ${rule.promotionMinShops} activated shops. An admin can promote anyway with an override and a reason.`, { reason: "NOT_ELIGIBLE", activatedShops: n });
    }
    const formerLeadId = before.parentId;
    const now = new Date();
    const [member] = await tx
      .update(dealerSalespeople)
      .set({ teamRole: "TEAM_LEAD", depth: 2, parentId: null, parentDepth: null, parentRole: null, promotedAt: now, updatedAt: now })
      .where(eq(dealerSalespeople.id, memberId))
      .returning();
    // The agents he recruited, and the ones they recruited, move under him.
    const all = await tx.select().from(dealerSalespeople).where(eq(dealerSalespeople.dealerId, before.dealerId));
    const moving = new Set<string>();
    const queue = [memberId];
    while (queue.length) {
      const id = queue.shift()!;
      for (const m of all) {
        if (m.recruitedById !== id || m.teamRole !== "AGENT" || moving.has(m.id) || m.id === memberId) continue;
        moving.add(m.id);
        queue.push(m.id);
      }
    }
    if (moving.size) {
      await tx
        .update(dealerSalespeople)
        .set({ depth: 3, parentId: memberId, parentDepth: 2, parentRole: "TEAM_LEAD", updatedAt: now })
        .where(inArray(dealerSalespeople.id, [...moving]));
    }
    await recordMapping(tx, memberId, `promoted to team lead: ${why}`, actor.id, now);
    for (const id of moving) await recordMapping(tx, id, `moved with ${before.name} on his promotion`, actor.id, now);
    let developmentId: string | null = null;
    if (formerLeadId && rule.developmentBp > 0) {
      const [dev] = await tx
        .insert(dealerTeamDevelopments)
        .values({
          dealerId: before.dealerId,
          beneficiaryMemberId: formerLeadId,
          teamLeadMemberId: memberId,
          bp: rule.developmentBp,
          startsAt: now,
          endsAt: addMonths(now, rule.developmentMonths),
          reason: why,
          createdBy: actor.id,
        })
        .returning();
      developmentId = dev.id;
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_TEAM_CHANGED,
        entityType: "dealer_salesperson",
        entityId: memberId,
        previousValue: { role: "AGENT", depth: before.depth, parentId: formerLeadId },
        newValue: {
          role: "TEAM_LEAD",
          depth: 2,
          parentId: null,
          promoted: true,
          activatedShops: n,
          eligible: n >= rule.promotionMinShops,
          override: Boolean(input.override) && n < rule.promotionMinShops,
          movedAgents: [...moving],
          development: developmentId ? { id: developmentId, beneficiaryMemberId: formerLeadId, bp: rule.developmentBp, months: rule.developmentMonths } : null,
          reason: why,
        },
      },
      tx,
    );
    return { member, movedAgents: moving.size, developmentId, formerLeadId };
  });
  if (result.member.userId) {
    await notify({ userId: result.member.userId, type: NOTIFICATION_TYPES.DEALER_TEAM_CHANGED, vars: { message: `Congratulations — you are now a team lead${result.movedAgents ? `, with ${result.movedAgents} agent(s) you brought in` : ""}. You earn the team-lead override on your agents' shops.` }, actionUrl: "/dealer", channels: ["PUSH"] });
  }
  return { member: result.member, movedAgents: result.movedAgents, developmentId: result.developmentId };
}

/* ======================================================= sub-agent requests */

const MOBILE = /^[6-9][0-9]{9}$/;
const clean = (v: string | null | undefined, max: number) => (v ?? "").trim().replace(/\s+/g, " ").slice(0, max);

/** A team member asks for a sub-agent (agents never appoint one themselves); an admin decides. */
export async function requestSubAgent(actor: Actor, input: { employeeId: string; name: string; mobile?: string | null; note?: string | null }): Promise<{ id: string }> {
  const me = await getMemberForUser(actor.id);
  if (!me) throw forbidden("Only a member of a dealer team can ask for a sub-agent.");
  if (me.dealer.commissionModel !== "TIERED") throw conflict("Sub-agent requests are part of the TIERED model.");
  const employeeId = clean(input.employeeId, 48);
  const name = clean(input.name, 120);
  if (!employeeId || !name) throw validationFailed("Give the new agent's ID and name.", { fields: { employeeId: employeeId ? undefined : "Required.", name: name ? undefined : "Required." } });
  let mobileE164: string | null = null;
  if (input.mobile?.trim()) {
    const m = input.mobile.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
    if (!MOBILE.test(m)) throw validationFailed("Enter a 10-digit mobile number, or leave it blank.", { fields: { mobile: "10 digits." } });
    mobileE164 = `+91${m}`;
  }
  const [row] = await db
    .insert(dealerTeamRequests)
    .values({ dealerId: me.dealer.id, requestedByMemberId: me.member.id, employeeId, name, mobileE164, note: clean(input.note, 500) || null })
    .returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_TEAM_REQUEST, entityType: "dealer_team_request", entityId: row.id, newValue: { dealerId: me.dealer.id, requestedBy: me.member.id, employeeId, name, status: "PENDING" } });
  return { id: row.id };
}

export async function listTeamRequests(filter: { status?: "PENDING" | "ALL"; dealerId?: string } = {}) {
  return db
    .select({ r: dealerTeamRequests, dealerName: dealers.legalName, requester: dealerSalespeople.name, requesterRole: dealerSalespeople.teamRole })
    .from(dealerTeamRequests)
    .innerJoin(dealers, eq(dealers.id, dealerTeamRequests.dealerId))
    .innerJoin(dealerSalespeople, eq(dealerSalespeople.id, dealerTeamRequests.requestedByMemberId))
    .where(and(filter.status === "ALL" ? sql`true` : eq(dealerTeamRequests.status, "PENDING"), filter.dealerId ? eq(dealerTeamRequests.dealerId, filter.dealerId) : sql`true`))
    .orderBy(desc(dealerTeamRequests.createdAt))
    .limit(500);
}

/**
 * ADMIN only. Approved: the agent is created — under the requester when he is
 * a lead, otherwise beside him under his lead (or the main dealer), recorded as
 * recruited by him (he takes them along if promoted). Never a 4th level.
 */
export async function decideTeamRequest(requestId: string, approve: boolean, note: string | null, actor: Actor): Promise<{ memberId: string | null }> {
  requireAdmin(actor, "decide sub-agent requests");
  const { addSalesperson } = await import("./service");
  const [req] = await db.select().from(dealerTeamRequests).where(eq(dealerTeamRequests.id, requestId));
  if (!req) throw notFound("Request");
  if (req.status !== "PENDING") throw conflict("This request is already decided.");
  const [requester] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, req.requestedByMemberId));
  let memberId: string | null = null;
  if (approve) {
    const parentId = requester.teamRole === "TEAM_LEAD" ? requester.id : requester.parentId;
    const created = await addSalesperson(req.dealerId, { employeeId: req.employeeId, name: req.name, mobile: req.mobileE164?.slice(3) ?? null, role: "AGENT", parentId, recruitedById: requester.teamRole === "AGENT" ? requester.id : null }, actor);
    memberId = created.id;
  }
  const decided = await db
    .update(dealerTeamRequests)
    .set({ status: approve ? "APPROVED" : "REJECTED", decidedBy: actor.id, decidedAt: new Date(), decisionNote: clean(note, 500) || null, createdMemberId: memberId })
    .where(and(eq(dealerTeamRequests.id, requestId), eq(dealerTeamRequests.status, "PENDING")))
    .returning();
  if (decided.length === 0) throw conflict("This request is already decided.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_TEAM_REQUEST, entityType: "dealer_team_request", entityId: requestId, previousValue: { status: "PENDING" }, newValue: { status: decided[0].status, memberId, note } });
  if (requester.userId) {
    await notify({
      userId: requester.userId,
      type: NOTIFICATION_TYPES.DEALER_TEAM_CHANGED,
      vars: { message: approve ? `${req.name} (${req.employeeId}) has joined your team as an agent.` : `Your request to add ${req.name} was not approved${note ? `: ${note}` : "."}` },
      actionUrl: "/dealer",
    });
  }
  return { memberId };
}

/* ========================================================== payee details */

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/**
 * A member's PAN and bank account (the member, or an admin). The bank goes to
 * PENDING until the bank check (or an admin's verification) passes — no payout
 * is paid before PAN and a verified account are on file.
 */
export async function saveMemberPayee(memberId: string, input: { pan?: string | null; bankHolderName?: string | null; bankAccount?: string | null; ifsc?: string | null }, actor: Actor): Promise<DealerSalesperson> {
  const [member] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, memberId));
  if (!member) throw notFound("Team member");
  if (actor.role !== "ADMIN" && member.userId !== actor.id) throw forbidden("You can change only your own payment details.");
  const patch: Partial<typeof dealerSalespeople.$inferInsert> = { updatedAt: new Date() };
  if (input.pan) {
    const pan = input.pan.trim().toUpperCase();
    if (!PAN.test(pan)) throw validationFailed("A PAN is 10 characters, like ABCDE1234F.", { fields: { pan: "Check the PAN." } });
    const panHash = panBlindIndex(pan);
    // A member cannot take a PAN already on another dealer or member (it would open their payouts and TDS);
    // the same person's two records (one linked account) may share it, and an admin may set it after checking.
    if (actor.role !== "ADMIN") {
      const others = [
        ...(await db.select({ userId: dealerSalespeople.userId }).from(dealerSalespeople).where(and(eq(dealerSalespeople.panHash, panHash), ne(dealerSalespeople.id, memberId)))),
        ...(await db.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.panHash, panHash))),
      ];
      if (others.some((o) => !o.userId || o.userId !== member.userId)) {
        throw conflict("This PAN is already on file for someone else. Ask GoKesari to check it.", { fields: { pan: "Already on file." } });
      }
    }
    Object.assign(patch, { panEnc: encryptSecret(pan), panHash, panLast4: pan.slice(-4) });
  }
  if (input.bankAccount || input.ifsc || input.bankHolderName) {
    const account = checkAccountNumber(input.bankAccount ?? "");
    const ifsc = checkIfsc(input.ifsc ?? "");
    const holder = clean(input.bankHolderName, 120);
    if (!account.ok) throw validationFailed(account.error, { fields: { bankAccount: account.error } });
    if (!ifsc.ok) throw validationFailed(ifsc.error, { fields: { ifsc: ifsc.error } });
    if (!holder) throw validationFailed("Give the account holder's name.", { fields: { bankHolderName: "Required." } });
    Object.assign(patch, {
      bankHolderName: holder,
      bankAccountEnc: encryptSecret(account.value),
      bankAccountLast4: account.value.slice(-4),
      bankIfsc: ifsc.value,
      bankStatus: "PENDING",
      bankStatusReason: "Waiting for the bank check.",
      bankVerifiedAt: null,
    });
  }
  const [after] = await db.update(dealerSalespeople).set(patch).where(eq(dealerSalespeople.id, memberId)).returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DEALER_MEMBER_PAYEE_SAVED,
    entityType: "dealer_salesperson",
    entityId: memberId,
    previousValue: { panLast4: member.panLast4, bankLast4: member.bankAccountLast4, bankStatus: member.bankStatus },
    newValue: { panLast4: after.panLast4, bankLast4: after.bankAccountLast4, bankStatus: after.bankStatus },
  });
  return after;
}

/** ADMIN only: the member's bank account is verified (bank check or the cancelled cheque), with a reason. */
export async function verifyMemberBank(memberId: string, verified: boolean, reason: string, actor: Actor): Promise<DealerSalesperson> {
  requireAdmin(actor, "verify bank accounts");
  const why = requireReason(reason);
  const [member] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, memberId));
  if (!member) throw notFound("Team member");
  if (!member.bankAccountEnc) throw conflict("No bank account on file.");
  const [after] = await db
    .update(dealerSalespeople)
    .set({ bankStatus: verified ? "VERIFIED" : "FAILED", bankStatusReason: why, bankVerifiedAt: verified ? new Date() : null, updatedAt: new Date() })
    .where(eq(dealerSalespeople.id, memberId))
    .returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_MEMBER_PAYEE_SAVED, entityType: "dealer_salesperson", entityId: memberId, previousValue: { bankStatus: member.bankStatus }, newValue: { bankStatus: after.bankStatus, reason: why } });
  return after;
}

/** ADMIN only: links a member to the GoKesari account (by email) they sign in with, for the dealer portal. */
export async function linkMemberAccount(memberId: string, email: string, actor: Actor): Promise<DealerSalesperson> {
  requireAdmin(actor, "link team members to accounts");
  const [user] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${email.trim()})`);
  if (!user) throw notFound("No GoKesari account uses that email");
  const [member] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, memberId));
  if (!member) throw notFound("Team member");
  const [taken] = await db.select({ id: dealerSalespeople.id }).from(dealerSalespeople).where(and(eq(dealerSalespeople.userId, user.id), ne(dealerSalespeople.id, memberId), eq(dealerSalespeople.status, "ACTIVE")));
  if (taken) throw conflict("That account is already linked to another team member.");
  const [owner] = await db.select({ id: dealers.id }).from(dealers).where(eq(dealers.userId, user.id));
  if (owner) throw conflict("That account belongs to a dealer.");
  const [after] = await db.update(dealerSalespeople).set({ userId: user.id, updatedAt: new Date() }).where(eq(dealerSalespeople.id, memberId)).returning();
  await grantRole(user.id, "DEALER", { source: "ADMIN", grantedBy: actor.id, activateIfCustomer: true });
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_TEAM_CHANGED, entityType: "dealer_salesperson", entityId: memberId, previousValue: { userId: member.userId }, newValue: { userId: user.id } });
  return after;
}

/* ============================================================== agreement */

/**
 * The signed-in member (or main dealer) accepts the agent agreement
 * (AGENT_AGREEMENT_VERSION, timestamped). Entries held for it are released.
 */
export async function acceptAgentAgreement(actor: Actor, version: string, device: { ipAddress?: string | null; userAgent?: string | null } = {}): Promise<{ released: number }> {
  if (version !== AGENT_AGREEMENT_VERSION) throw conflict("The agreement has changed; reload the page and read the current version.");
  const now = new Date();
  const me = await getMemberForUser(actor.id);
  const [owned] = me ? [] : await db.select().from(dealers).where(eq(dealers.userId, actor.id));
  if (!me && !owned) throw forbidden("Only a dealer or a member of a dealer team accepts the agent agreement.");
  const released = await db.transaction(async (tx) => {
    let dealer: Dealer;
    if (me) {
      await tx.update(dealerSalespeople).set({ agreementVersion: version, agreementAcceptedAt: now, updatedAt: now }).where(eq(dealerSalespeople.id, me.member.id));
      dealer = me.dealer;
    } else {
      [dealer] = await tx.update(dealers).set({ tierAgreementVersion: version, tierAgreementAcceptedAt: now, updatedAt: now }).where(eq(dealers.id, owned!.id)).returning();
    }
    // Gap report A8: every acceptance is kept (version, text hash, time, device); the row above holds the latest.
    await tx.insert(dealerAgreementAcceptances).values({
      dealerId: dealer.id,
      memberId: me ? me.member.id : null,
      userId: actor.id,
      version,
      textSha256: AGENT_AGREEMENT_SHA256,
      acceptedAt: now,
      ipAddress: device.ipAddress?.slice(0, 64) ?? null,
      userAgent: device.userAgent?.slice(0, 300) ?? null,
    });
    const held = await tx
      .select()
      .from(dealerCommissionLedger)
      .where(
        and(
          eq(dealerCommissionLedger.dealerId, dealer.id),
          me ? eq(dealerCommissionLedger.payeeMemberId, me.member.id) : isNull(dealerCommissionLedger.payeeMemberId),
          eq(dealerCommissionLedger.status, "ON_HOLD"),
          sql`${dealerCommissionLedger.note} like ${"%" + AGREEMENT_HOLD_NOTE + "%"}`,
        ),
      )
      .for("update");
    for (const e of held) {
      const note = (e.note ?? "").split("; ").filter((p) => p !== AGREEMENT_HOLD_NOTE).join("; ") || null;
      const stillHeld = dealer.status !== "APPROVED" || (note ?? "").startsWith(DOCUMENTS_HOLD_NOTE);
      await tx
        .update(dealerCommissionLedger)
        .set({ status: stillHeld ? "ON_HOLD" : (e.heldFromStatus ?? "EARNED"), heldFromStatus: stillHeld ? e.heldFromStatus : null, note, updatedAt: now })
        .where(eq(dealerCommissionLedger.id, e.id));
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_AGREEMENT_ACCEPTED,
        entityType: me ? "dealer_salesperson" : "dealer",
        entityId: me ? me.member.id : dealer.id,
        newValue: { version, acceptedAt: now.toISOString(), releasedEntries: held.map((e) => e.id) },
      },
      tx,
    );
    return held.length;
  });
  return { released };
}

/* ======================================================= model and rates */

/**
 * ADMIN only: moves a dealer between STANDARD and TIERED (the rule must be on to
 * move to TIERED). Commission already accrued is never recalculated; shops
 * activated from now on follow the new model.
 */
export async function setDealerCommissionModel(dealerId: string, model: Dealer["commissionModel"], reason: string, actor: Actor): Promise<Dealer> {
  requireAdmin(actor, "change a dealer's commission model");
  const why = requireReason(reason);
  if (model !== "STANDARD" && model !== "TIERED") throw validationFailed("Model: STANDARD or TIERED.");
  if (model === "TIERED" && !(await tierRule()).enabled) throw conflict("Switch rule dealerTieredCommission on first (Admin → Settings).");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(dealers).where(eq(dealers.id, dealerId)).for("update");
    if (!before) throw notFound("Dealer");
    if (before.isInternal) throw conflict("GoKesari Direct earns no commission.");
    if (before.commissionModel === model) return before;
    const [after] = await tx.update(dealers).set({ commissionModel: model, updatedAt: new Date() }).where(eq(dealers.id, dealerId)).returning();
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_COMMISSION_MODEL_CHANGED, entityType: "dealer", entityId: dealerId, previousValue: { commissionModel: before.commissionModel }, newValue: { commissionModel: model, reason: why } },
      tx,
    );
    return after;
  });
}

/** ADMIN only: one TIERED dealer's own direct / override %s (null: the rule's default). For shops activated from now on. */
export async function setDealerTierRates(dealerId: string, rates: { directBp: number | null; leadOverrideBp: number | null; mainOverrideBp: number | null }, reason: string, actor: Actor): Promise<Dealer> {
  requireAdmin(actor, "change a dealer's commission");
  const why = requireReason(reason);
  for (const [k, v] of Object.entries(rates)) {
    if (v != null && (!Number.isInteger(v) || v < 0 || v > 10_000)) throw validationFailed(`${k}: 0% to 100%, in steps of 0.01%.`);
  }
  const rule = await tierRule();
  const total = (rates.directBp ?? rule.directBp) + (rates.leadOverrideBp ?? rule.leadOverrideBp) + (rates.mainOverrideBp ?? rule.mainOverrideBp);
  if (total > 10_000) throw validationFailed("Direct and overrides together cannot pass 100% of the fee.");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(dealers).where(eq(dealers.id, dealerId)).for("update");
    if (!before) throw notFound("Dealer");
    const [after] = await tx
      .update(dealers)
      .set({ tierDirectBp: rates.directBp, tierLeadOverrideBp: rates.leadOverrideBp, tierMainOverrideBp: rates.mainOverrideBp, updatedAt: new Date() })
      .where(eq(dealers.id, dealerId))
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_COMMISSION_MODEL_CHANGED,
        entityType: "dealer",
        entityId: dealerId,
        previousValue: { tierDirectBp: before.tierDirectBp, tierLeadOverrideBp: before.tierLeadOverrideBp, tierMainOverrideBp: before.tierMainOverrideBp },
        newValue: { tierDirectBp: after.tierDirectBp, tierLeadOverrideBp: after.tierLeadOverrideBp, tierMainOverrideBp: after.tierMainOverrideBp, reason: why },
      },
      tx,
    );
    return after;
  });
}

/* ================================================================= views */

export interface EarningsByType {
  entryType: CommissionEntryType;
  level: number | null;
  earnedPaise: number;
  paidPaise: number;
  heldPaise: number;
  reversedPaise: number;
}

/** A payee's (or the whole network's) earnings split by entry type and level. `payee`: undefined = everyone, null = the main dealer. */
export async function earningsByType(dealerId: string, payee?: string | null): Promise<EarningsByType[]> {
  const rows = await db
    .select({
      entryType: dealerCommissionLedger.entryType,
      level: dealerCommissionLedger.level,
      earned: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}) filter (where ${dealerCommissionLedger.status} in ('EARNED', 'APPROVED', 'PAID', 'PENDING')), 0)::int`,
      paid: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}) filter (where ${dealerCommissionLedger.status} = 'PAID'), 0)::int`,
      held: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}) filter (where ${dealerCommissionLedger.status} = 'ON_HOLD'), 0)::int`,
      reversed: sql<number>`coalesce(sum(case when ${dealerCommissionLedger.kind} = 'REVERSAL' then -${dealerCommissionLedger.amountPaise} when ${dealerCommissionLedger.status} = 'REVERSED' then ${dealerCommissionLedger.amountPaise} else 0 end), 0)::int`,
    })
    .from(dealerCommissionLedger)
    .where(
      and(
        eq(dealerCommissionLedger.dealerId, dealerId),
        payee === undefined ? sql`true` : payee === null ? isNull(dealerCommissionLedger.payeeMemberId) : eq(dealerCommissionLedger.payeeMemberId, payee),
      ),
    )
    .groupBy(dealerCommissionLedger.entryType, dealerCommissionLedger.level)
    .orderBy(dealerCommissionLedger.entryType, dealerCommissionLedger.level);
  return rows.map((r) => ({ entryType: r.entryType, level: r.level, earnedPaise: r.earned, paidPaise: r.paid, heldPaise: r.held, reversedPaise: r.reversed }));
}

export interface TradingProgressRow {
  shopId: string;
  shopName: string;
  directName: string;
  status: DealerTierShopPlan["status"];
  deliveredOrders: number;
  tradingOrders: number;
  activatedAt: Date;
  tradingDeadline: Date;
  daysLeft: number;
  part2Paise: number;
  overridesPaise: number;
}

/** Each shop's TRADING progress (a member sees the shops they signed or lead). */
export async function tradingProgress(dealerId: string, memberId?: string | null): Promise<TradingProgressRow[]> {
  const rows = await db
    .select({ p: dealerTierShopPlans, shopName: shops.name, directName: dealerSalespeople.name })
    .from(dealerTierShopPlans)
    .innerJoin(shops, eq(shops.id, dealerTierShopPlans.shopId))
    .leftJoin(dealerSalespeople, eq(dealerSalespeople.id, dealerTierShopPlans.directMemberId))
    .where(
      and(
        eq(dealerTierShopPlans.dealerId, dealerId),
        memberId ? or(eq(dealerTierShopPlans.directMemberId, memberId), eq(dealerTierShopPlans.leadMemberId, memberId), eq(dealerTierShopPlans.developmentMemberId, memberId)) : sql`true`,
      ),
    )
    .orderBy(desc(dealerTierShopPlans.activatedAt))
    .limit(500);
  const now = Date.now();
  return rows.map(({ p, shopName, directName }) => {
    const a = planAmounts(p);
    return {
      shopId: p.shopId,
      shopName,
      directName: directName ?? "Main dealer",
      status: p.status,
      deliveredOrders: p.deliveredOrders,
      tradingOrders: p.tradingOrders,
      activatedAt: p.activatedAt,
      tradingDeadline: p.tradingDeadline,
      daysLeft: Math.max(0, Math.ceil((p.tradingDeadline.getTime() - now) / DAY)),
      part2Paise: a.direct2Paise,
      overridesPaise: a.leadPaise + a.mainPaise + a.developmentPaise,
    };
  });
}

/** Marks a shop's plan REVERSED (inside the reversal's transaction) so it never reaches TRADING. */
/**
 * Takes the locks the TRADING settlement holds (the dealer row, touched, then the shop's plan), in the
 * same order, so a reversal never reads the shop's entries while the 10th delivery is settling it.
 */
export async function lockShopCommission(tx: DbClient, dealerId: string, shopId: string): Promise<void> {
  await tx.select({ id: dealers.id }).from(dealers).where(eq(dealers.id, dealerId)).for("update");
  await touchSellerRow(tx, dealers, dealerId);
  await tx.select({ shopId: dealerTierShopPlans.shopId }).from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, shopId)).for("update");
}

export async function reversePlan(tx: DbClient, shopId: string): Promise<void> {
  await tx.update(dealerTierShopPlans).set({ status: "REVERSED", updatedAt: new Date() }).where(and(eq(dealerTierShopPlans.shopId, shopId), ne(dealerTierShopPlans.status, "REVERSED")));
}

/** Every payee who had money on a reversed shop is told (push too). After the commit. */
export async function tellReversal(shopId: string, reason: string): Promise<void> {
  const rows = await db
    .select({ dealerId: dealerCommissionLedger.dealerId, payee: dealerCommissionLedger.payeeMemberId })
    .from(dealerCommissionLedger)
    .where(and(eq(dealerCommissionLedger.shopId, shopId), ne(dealerCommissionLedger.entryType, "BASE"), sql`${dealerCommissionLedger.amountPaise} <> 0`));
  if (rows.length === 0) return;
  const [shop] = await db.select({ name: shops.name }).from(shops).where(eq(shops.id, shopId));
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.dealerId}:${r.payee ?? "main"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const userId = r.payee
      ? (await db.select({ u: dealerSalespeople.userId }).from(dealerSalespeople).where(eq(dealerSalespeople.id, r.payee)))[0]?.u
      : (await db.select({ u: dealers.userId }).from(dealers).where(eq(dealers.id, r.dealerId)))[0]?.u;
    if (!userId) continue;
    await notify({ userId, type: NOTIFICATION_TYPES.DEALER_COMMISSION_REVERSED, vars: { shopName: shop?.name ?? "a shop", reason }, actionUrl: "/dealer", channels: ["PUSH"], dedupeKey: `dealer-reversed:${shopId}:${key}` });
  }
}
