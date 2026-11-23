/**
 * Dealership & Franchise Platform phase 3 (owner brief 23-Nov-2026; docs/dealer-platform/PHASE_3_CALCULATOR.md):
 * the one calculator for every scheme whose terms say `calculation: "SCHEME"`.
 *
 * One-time (at the shop's activation, from checkCommissionMilestones):
 *   - ONE_TIME components: on the shop's registration fee actually paid (before GST, after coupon), a fixed amount
 *     per shop, or a formula. Paid to whoever signed the shop when the scheme allows team building, else to the
 *     dealer.
 *   - TEAM_OVERRIDE level 1 / 2: to the first / second person above the signer in the team (team lead, then the
 *     dealer), placement on the shop's registration date (as the 3-level model does).
 *   - The scheme's commission budget caps the shop's one-time total: when exceeded every line is scaled down.
 * Monthly (in the month close, before approval):
 *   - RECURRING / PERFORMANCE_BONUS components: a share of GoKesari's actual commission (order_financials), or of
 *     sales, on the dealer's activated shops' orders delivered that month, net of refunds recorded that month; for
 *     `durationMonths` from the shop's activation; only while the dealer's scheme is valid (validityMonths).
 *
 * Every line goes to dealer_commission_ledger with an accrual key, so a line is written once whatever retries
 * happen, and the existing approval, holds, reversals, payouts, TDS and statements apply unchanged.
 * Pure functions (componentAmount, oneTimeLines, recurringAmount) are shared with the simulator.
 */
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";

import { monthsBetween, oneTimeLines, recurringAmount, ZERO_BASIS, BUDGET_NOTE, type BasisValues, type Payee } from "@/lib/dealer-scheme-math";
import { schemeTermsSchema, type SchemeTerms } from "@/lib/dealer-schemes";
import { db, type DbClient } from "@/server/db";
import {
  dealerCommissionLedger,
  dealers,
  dealerSchemeAssignments,
  shopAttributions,
  type Dealer,
  type DealerCommissionEntry,
  type DealerSalesperson,
  type Shop,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

import { dealerFormulaVariables } from "./custom-fields";
import { AGREEMENT_HOLD_NOTE, agreementAccepted, levelOf, placementFor } from "./tiered";

interface Actor {
  id: string;
  role: UserRole;
}

export { BUDGET_NOTE, componentAmount, monthsBetween, oneTimeLines, recurringAmount, ZERO_BASIS } from "@/lib/dealer-scheme-math";
export type { BasisValues, OneTimeLine, Payee } from "@/lib/dealer-scheme-math";

/* ================================================================= database */

interface ActiveScheme {
  assignmentId: string;
  terms: SchemeTerms;
  startsAt: Date;
}

/** The dealer's active scheme when it is calculated by this engine; null for legacy calculation or none. */
export async function schemeCalculated(dealerId: string, client: DbClient = db): Promise<ActiveScheme | null> {
  // A dealer an admin moved to the 3-level team model (0136) keeps it: that explicit choice wins over the scheme.
  const [d] = await client.select({ model: dealers.commissionModel }).from(dealers).where(eq(dealers.id, dealerId));
  if (!d || d.model === "TIERED") return null;
  const [a] = await client.select().from(dealerSchemeAssignments).where(and(eq(dealerSchemeAssignments.dealerId, dealerId), eq(dealerSchemeAssignments.status, "ACTIVE")));
  if (!a) return null;
  const terms = schemeTermsSchema.parse(a.acceptedTerms);
  return terms.calculation === "SCHEME" ? { assignmentId: a.id, terms, startsAt: a.startsAt } : null;
}

/** True when the scheme's validity has run out at `at`. */
export function schemeExpired(scheme: Pick<ActiveScheme, "terms" | "startsAt">, at: Date): boolean {
  if (!scheme.terms.validityMonths) return false;
  const end = new Date(scheme.startsAt);
  end.setUTCMonth(end.getUTCMonth() + scheme.terms.validityMonths);
  return at.getTime() >= end.getTime();
}

/**
 * The one-time commission of a shop that reached activation, for a dealer on a SCHEME-calculated scheme. Returns
 * null when the dealer is not on one (the caller then uses the existing models). Idempotent per accrual key.
 */
export async function accrueSchemeActivation(
  shop: Shop,
  dealerId: string,
  salespersonId: string | null,
  feePaise: number,
  actor: Actor | null,
  options: { holdForDocuments?: boolean; documentsHoldNote?: string } = {},
): Promise<DealerCommissionEntry[] | null> {
  const scheme = await schemeCalculated(dealerId);
  if (!scheme) return null;
  return db.transaction(async (tx) => {
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, dealerId)).for("update");
    if (!dealer || dealer.isInternal) return [];
    const [attribution] = await tx.select().from(shopAttributions).where(eq(shopAttributions.shopId, shop.id));
    if (!attribution || attribution.status !== "ACTIVE" || attribution.dealerId !== dealerId || attribution.matchKind === "DUPLICATE") return [];
    if (schemeExpired(scheme, new Date())) return [];
    const placement = await placementFor(tx, dealerId, salespersonId, shop.createdAt);
    const signer = placement.direct;
    // Above the signer: an agent under a lead → lead, then the dealer; a lead or a lone agent → the dealer.
    const levelsAbove: 0 | 1 | 2 = !signer ? 0 : placement.lead ? 2 : 1;
    const extra = dealerFormulaVariables(scheme.terms, dealer);
    const lines = oneTimeLines(scheme.terms, { ...ZERO_BASIS, shopRegistrationFeePaise: feePaise, shopActivationFeePaise: feePaise, dealerRating: Number(dealer.rating) }, { signedByMember: !!signer, levelsAbove }, extra);
    const payeeOf = (p: Payee): DealerSalesperson | null => (p === "SIGNER" ? signer : p === "LEVEL_1" ? (placement.lead ?? null) : null);
    const out: DealerCommissionEntry[] = [];
    for (const l of lines) {
      const payee = payeeOf(l.payee);
      const entry = await writeSchemeEntry(tx, {
        dealer,
        payee,
        shopId: shop.id,
        salespersonId,
        milestone: "ACTIVATED",
        entryType: l.entryType,
        accrualKey: `SO:${scheme.assignmentId}:${l.componentId}:${shop.id}`,
        feePaise,
        basePaise: feePaise,
        amountPaise: l.amountPaise,
        schemeAssignmentId: scheme.assignmentId,
        componentId: l.componentId,
        holdNote: options.holdForDocuments ? (options.documentsHoldNote ?? "held: documents") : null,
        note: l.scaled ? BUDGET_NOTE : null,
        actor,
      });
      out.push(...entry);
    }
    if (out.length) {
      await recordAudit(
        { actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.DEALER_COMMISSION_ACCRUED, entityType: "shop", entityId: shop.id, newValue: { dealerId, scheme: true, assignmentId: scheme.assignmentId, feePaise, lines: lines.map((l) => ({ component: l.componentId, payee: l.payee, amountPaise: l.amountPaise, scaled: l.scaled })) } },
        tx,
      );
    }
    return out;
  });
}

interface SchemeEntry {
  dealer: Dealer;
  payee: DealerSalesperson | null;
  shopId: string;
  salespersonId: string | null;
  milestone: "ACTIVATED" | "MONTHLY";
  entryType: "SCHEME_ONE_TIME" | "SCHEME_TEAM" | "SCHEME_RECURRING" | "SCHEME_BONUS";
  accrualKey: string;
  feePaise: number;
  basePaise: number;
  amountPaise: number;
  schemeAssignmentId: string;
  componentId: string;
  holdNote: string | null;
  note: string | null;
  createdAt?: Date;
  actor: Actor | null;
}

/** One scheme ledger line, once per accrual key. Held while the dealer is not approved, for documents, or (a team
 * member) until the agent agreement is accepted. Call under the dealer lock. */
async function writeSchemeEntry(tx: DbClient, e: SchemeEntry): Promise<DealerCommissionEntry[]> {
  const [already] = await tx.select({ id: dealerCommissionLedger.id }).from(dealerCommissionLedger).where(and(eq(dealerCommissionLedger.accrualKey, e.accrualKey), eq(dealerCommissionLedger.kind, "ACCRUAL")));
  if (already) return [];
  const notes = [e.holdNote, e.payee && !agreementAccepted(e.payee, e.dealer) ? AGREEMENT_HOLD_NOTE : null].filter((n): n is string => !!n);
  const held = e.dealer.status !== "APPROVED" || notes.length > 0;
  return tx
    .insert(dealerCommissionLedger)
    .values({
      dealerId: e.dealer.id,
      salespersonId: e.salespersonId,
      shopId: e.shopId,
      milestone: e.milestone,
      kind: "ACCRUAL",
      entryType: e.entryType,
      payeeMemberId: e.payee?.id ?? null,
      level: levelOf(e.payee),
      accrualKey: e.accrualKey,
      feePaise: e.feePaise,
      basePaise: e.basePaise,
      rating: e.dealer.rating,
      amountPaise: e.amountPaise,
      aboveCap: false,
      status: held ? "ON_HOLD" : "EARNED",
      heldFromStatus: held ? "EARNED" : null,
      note: [...notes, e.note].filter(Boolean).join("; ") || null,
      schemeAssignmentId: e.schemeAssignmentId,
      schemeComponentId: e.componentId,
      createdBy: e.actor?.id ?? null,
      ...(e.createdAt ? { createdAt: e.createdAt } : {}),
    })
    .returning();
}

interface ShopMonth {
  shop_id: string;
  commission: number;
  goods: number;
  refund_commission: number;
  refund_goods: number;
}

/**
 * The month close (closeCommissionMonth, inside its transaction): every SCHEME-calculated dealer's monthly
 * components on his activated shops. Lines are dated the last moment of the month so that month's approval and
 * payout take them. Idempotent per dealer, component, shop and month.
 */
export async function accrueSchemeRecurring(tx: DbClient, month: string, start: Date, end: Date, actor: Actor | null): Promise<DealerCommissionEntry[]> {
  const assignments = await tx
    .select({ a: dealerSchemeAssignments })
    .from(dealerSchemeAssignments)
    .where(and(eq(dealerSchemeAssignments.status, "ACTIVE"), lt(dealerSchemeAssignments.startsAt, end)));
  const out: DealerCommissionEntry[] = [];
  const stamp = new Date(end.getTime() - 1);
  for (const { a } of assignments) {
    const terms = schemeTermsSchema.parse(a.acceptedTerms);
    if (terms.calculation !== "SCHEME") continue;
    const monthly = terms.components.filter((c) => c.frequency === "MONTHLY");
    if (!monthly.length) continue;
    if (schemeExpired({ terms, startsAt: a.startsAt }, start)) continue;
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, a.dealerId)).for("update");
    if (!dealer || dealer.isInternal) continue;
    const shops = await tx
      .select({ shopId: shopAttributions.shopId, activatedAt: shopAttributions.activatedAt })
      .from(shopAttributions)
      .where(and(eq(shopAttributions.dealerId, dealer.id), eq(shopAttributions.status, "ACTIVE"), isNotNull(shopAttributions.activatedAt), lt(shopAttributions.activatedAt, end)));
    if (!shops.length) continue;
    const ids = shops.map((s) => s.shopId);
    const figures = (await tx.execute(sql`
      select s.shop_id,
        coalesce((select sum(o.commission_paise) from order_financials o where o.shop_id = s.shop_id and o.delivered_at >= ${start.toISOString()}::timestamptz and o.delivered_at < ${end.toISOString()}::timestamptz), 0) as commission,
        coalesce((select sum(o.goods_paise) from order_financials o where o.shop_id = s.shop_id and o.delivered_at >= ${start.toISOString()}::timestamptz and o.delivered_at < ${end.toISOString()}::timestamptz), 0) as goods,
        coalesce((select sum(case when o.goods_paise > 0 then least(adj.customer_refund_paise, o.goods_paise)::numeric * o.commission_paise / o.goods_paise else 0 end)
          from financial_adjustments adj join order_financials o on o.order_id = adj.order_id
          where o.shop_id = s.shop_id and adj.type in ('REFUND_SHOP', 'REFUND_PLATFORM') and o.delivered_at is not null
            and adj.created_at >= ${start.toISOString()}::timestamptz and adj.created_at < ${end.toISOString()}::timestamptz), 0) as refund_commission,
        coalesce((select sum(least(adj.customer_refund_paise, o.goods_paise))
          from financial_adjustments adj join order_financials o on o.order_id = adj.order_id
          where o.shop_id = s.shop_id and adj.type in ('REFUND_SHOP', 'REFUND_PLATFORM') and o.delivered_at is not null
            and adj.created_at >= ${start.toISOString()}::timestamptz and adj.created_at < ${end.toISOString()}::timestamptz), 0) as refund_goods
      from unnest(array[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]) as s(shop_id)`)) as unknown as ShopMonth[];
    const [{ n: shopsThisMonth }] = (await tx.execute(sql`select count(*)::int as n from shop_attributions where dealer_id = ${dealer.id} and status = 'ACTIVE' and activated_at >= ${start.toISOString()}::timestamptz and activated_at < ${end.toISOString()}::timestamptz`)) as unknown as { n: number }[];
    const activatedAt = new Map(shops.map((s) => [s.shopId, s.activatedAt!]));
    const extra = dealerFormulaVariables(terms, dealer);
    for (const f of figures) {
      const commission = Math.max(0, Number(f.commission) - Number(f.refund_commission));
      const goods = Number(f.goods);
      const values: BasisValues = {
        ...ZERO_BASIS,
        platformCommissionPaise: Math.round(commission),
        transactionValuePaise: goods,
        netTransactionValuePaise: Math.max(0, goods - Number(f.refund_goods)),
        shopsThisMonth: Number(shopsThisMonth),
        activeShops: shops.length,
        monthsSinceActivation: monthsBetween(activatedAt.get(f.shop_id)!, month),
        dealerRating: Number(dealer.rating),
      };
      if (values.monthsSinceActivation < 0) continue;
      for (const c of monthly) {
        const amount = recurringAmount(c, values, extra);
        if (amount <= 0) continue;
        out.push(
          ...(await writeSchemeEntry(tx, {
            dealer,
            payee: null,
            shopId: f.shop_id,
            salespersonId: null,
            milestone: "MONTHLY",
            entryType: c.kind === "RECURRING" ? "SCHEME_RECURRING" : "SCHEME_BONUS",
            accrualKey: `SR:${a.id}:${c.id}:${f.shop_id}:${month}`,
            feePaise: 0,
            basePaise: c.basis === "PLATFORM_COMMISSION" ? values.platformCommissionPaise : c.basis === "NET_TRANSACTION_VALUE" ? values.netTransactionValuePaise : values.transactionValuePaise,
            amountPaise: amount,
            schemeAssignmentId: a.id,
            componentId: c.id,
            holdNote: null,
            note: `${month}: ${c.label}`,
            createdAt: stamp,
            actor,
          })),
        );
      }
    }
  }
  if (out.length) {
    await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.DEALER_COMMISSION_ACCRUED, entityType: "commission_month", entityId: month, newValue: { scheme: true, monthly: true, lines: out.length, totalPaise: out.reduce((n, e) => n + Number(e.amountPaise), 0) } }, tx);
  }
  return out;
}
