/**
 * Super franchisee (owner, 27-Nov-2026; docs/super-franchisee/README.md; migration 0226).
 *
 * Only an ADMIN makes a dealer a super franchisee and assigns, moves or removes other dealers (free or paid
 * franchisees) in his team. A dealer is in at most one team at a time; the history is kept.
 *
 * GoKesari pays the super franchisee EXTRA (rule superFranchisee; nothing is taken from the franchisee's share), on
 * his own team only:
 *   SUPER_FEE    feeShareBp (default 3%) of each fee paid in the team: a team dealer's shop registration fee (before
 *                GST, after coupons; a waived fee earns nothing), and a team dealer's own joining or franchise fee
 *                (before GST). Earned when paid (the team at that moment); reversed when the fee is refunded.
 *   SUPER_ORDER  orderShareBp (default 2%) of GoKesari's order commission on the team's activated shops, net of
 *                refunds, at the month close; the team at the end of the month earns it.
 * A super franchisee may have his own rates (null = the rule's). Each fee and each shop-month earns at most once,
 * whatever team the dealer is in (the accrual key has no super id), so nothing is ever paid twice.
 * Setting up teams works with the rule off; nothing is earned until an admin switches it on.
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, lt, ne, or, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  dealerCommissionLedger,
  dealerJoiningPayments,
  dealers,
  shopAttributions,
  shops,
  superFranchiseeMembers,
  superFranchisees,
  type Dealer,
  type DealerCommissionEntry,
  type SuperFranchisee,
  type SuperFranchiseeMember,
  type UserRole,
} from "@/server/db/schema";
import { franchiseBookings } from "@/server/db/franchise-schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { feeBasePaise, feeWaived } from "./commission";

export interface SuperActor {
  id: string;
  role: UserRole;
}

export const MAX_BACKDATE_DAYS = 365;

function requireAdmin(actor: SuperActor): void {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can manage super franchisees.");
}

function cleanReason(reason: string | null | undefined): string {
  const why = (reason ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  if (why.length < 5) throw validationFailed("Say why (at least 5 characters). It is kept in the audit log.", { fields: { reason: "Required." } });
  return why;
}

function bpOrNull(v: unknown, field: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10_000) throw validationFailed("A rate is 0–10,000 basis points (0–100%).", { fields: { [field]: "0–10,000." } });
  return n;
}

/** The rates this super franchisee earns now: his own, else the rule's. */
export async function ratesFor(sf: Pick<SuperFranchisee, "feeShareBp" | "orderShareBp">): Promise<{ feeShareBp: number; orderShareBp: number; enabled: boolean }> {
  const rule = await getRule("superFranchisee");
  return { enabled: rule.enabled, feeShareBp: sf.feeShareBp ?? rule.feeShareBp, orderShareBp: sf.orderShareBp ?? rule.orderShareBp };
}

export function shareOf(basePaise: number, bp: number): number {
  if (basePaise <= 0 || bp <= 0) return 0;
  return Math.round((basePaise * bp) / 10_000);
}

/** The super franchisee whose team `memberDealerId` was in at `at` (and who was a super franchisee then), or null. */
export async function teamAt(client: DbClient, memberDealerId: string, at: Date): Promise<{ sf: SuperFranchisee; superDealer: Dealer; link: SuperFranchiseeMember } | null> {
  const iso = at.toISOString();
  const [row] = await client
    .select({ link: superFranchiseeMembers, sf: superFranchisees, superDealer: dealers })
    .from(superFranchiseeMembers)
    .innerJoin(superFranchisees, eq(superFranchisees.dealerId, superFranchiseeMembers.superDealerId))
    .innerJoin(dealers, eq(dealers.id, superFranchiseeMembers.superDealerId))
    .where(
      and(
        eq(superFranchiseeMembers.memberDealerId, memberDealerId),
        sql`${superFranchiseeMembers.startsAt} <= ${iso}::timestamptz`,
        or(isNull(superFranchiseeMembers.endsAt), sql`${superFranchiseeMembers.endsAt} > ${iso}::timestamptz`),
        or(isNull(superFranchisees.removedAt), sql`${superFranchisees.removedAt} > ${iso}::timestamptz`),
      ),
    )
    .orderBy(desc(superFranchiseeMembers.startsAt))
    .limit(1);
  return row ?? null;
}

interface SuperEntry {
  superDealer: Dealer;
  shopId: string | null;
  entryType: "SUPER_FEE" | "SUPER_ORDER";
  milestone: "REGISTERED" | "MONTHLY";
  accrualKey: string;
  feePaise: number;
  basePaise: number;
  amountPaise: number;
  note: string;
  createdAt?: Date;
  actor: SuperActor | null;
}

/** One ledger line for the super franchisee, once per accrual key. Held while his own dealer account is not approved. */
async function writeSuperEntry(tx: DbClient, e: SuperEntry): Promise<DealerCommissionEntry[]> {
  if (e.amountPaise <= 0 || e.superDealer.isInternal) return [];
  const [already] = await tx.select({ id: dealerCommissionLedger.id }).from(dealerCommissionLedger).where(and(eq(dealerCommissionLedger.accrualKey, e.accrualKey), eq(dealerCommissionLedger.kind, "ACCRUAL")));
  if (already) return [];
  const held = e.superDealer.status !== "APPROVED";
  return tx
    .insert(dealerCommissionLedger)
    .values({
      dealerId: e.superDealer.id,
      shopId: e.shopId,
      milestone: e.milestone,
      kind: "ACCRUAL",
      entryType: e.entryType,
      accrualKey: e.accrualKey,
      feePaise: e.feePaise,
      basePaise: e.basePaise,
      rating: e.superDealer.rating,
      amountPaise: e.amountPaise,
      aboveCap: false,
      status: held ? "ON_HOLD" : "EARNED",
      heldFromStatus: held ? "EARNED" : null,
      note: held ? `held: super franchisee's dealer account is not approved; ${e.note}` : e.note,
      createdBy: e.actor?.id ?? null,
      ...(e.createdAt ? { createdAt: e.createdAt } : {}),
    })
    .onConflictDoNothing()
    .returning();
}

/* ================================================================== fees */

/** Shop registration fee: SUPER_FEE for the super franchisee of the shop's dealer at `at` (default now). Idempotent. */
export async function accrueSuperShopFee(client: DbClient, shopId: string, actor: SuperActor | null, at: Date = new Date()): Promise<DealerCommissionEntry[]> {
  const rule = await getRule("superFranchisee");
  if (!rule.enabled) return [];
  const [row] = await client.select({ a: shopAttributions, shop: shops }).from(shopAttributions).innerJoin(shops, eq(shops.id, shopAttributions.shopId)).where(eq(shopAttributions.shopId, shopId));
  if (!row || row.a.status !== "ACTIVE" || row.shop.feePaymentStatus !== "PAID" || feeWaived(row.shop)) return [];
  const team = await teamAt(client, row.a.dealerId, at);
  if (!team || team.sf.status !== "ACTIVE") return [];
  const base = feeBasePaise(row.shop);
  const rates = await ratesFor(team.sf);
  return writeSuperEntry(client, {
    superDealer: team.superDealer,
    shopId,
    entryType: "SUPER_FEE",
    milestone: "REGISTERED",
    accrualKey: `SFS:${shopId}`,
    feePaise: Number(row.shop.registrationFeePaise ?? 0),
    basePaise: base,
    amountPaise: shareOf(base, rates.feeShareBp),
    note: `super franchisee ${rates.feeShareBp / 100}% of ${row.shop.name}'s registration fee`,
    actor,
  });
}

/** Never lets the super franchisee share break a payment or an approval. */
export async function accrueSuperShopFeeSafely(shopId: string, actor: SuperActor | null): Promise<void> {
  try {
    await accrueSuperShopFee(db, shopId, actor);
  } catch (error) {
    console.error("[super-franchisee] shop fee accrual failed", shopId, error instanceof Error ? error.message : error);
  }
}

/**
 * Catches up every fee paid by or under the team's dealers since each joined (or since `backdateFrom` for one
 * dealer, when an admin assigns him and credits fees paid shortly before): shop registration fees, joining fees and
 * franchise fees. Then reverses the SUPER_FEE of a joining or franchise fee that is no longer paid (refunded).
 * Idempotent; run at the month close and on assignment.
 */
export async function syncSuperFees(client: DbClient, actor: SuperActor | null, opts: { memberDealerId?: string; backdateFrom?: Date } = {}): Promise<{ accrued: number; reversed: number }> {
  const rule = await getRule("superFranchisee");
  let accrued = 0;
  if (rule.enabled) {
    const links = await client
      .select()
      .from(superFranchiseeMembers)
      .where(and(isNull(superFranchiseeMembers.endsAt), opts.memberDealerId ? eq(superFranchiseeMembers.memberDealerId, opts.memberDealerId) : undefined));
    for (const link of links) {
      const from = opts.memberDealerId && opts.backdateFrom && opts.backdateFrom < link.startsAt ? opts.backdateFrom : link.startsAt;
      const team = await teamAt(client, link.memberDealerId, new Date());
      if (!team || team.sf.status !== "ACTIVE" || team.link.id !== link.id) continue;
      const rates = await ratesFor(team.sf);
      if (rates.feeShareBp <= 0) continue;
      // Shop registration fees (the shop's creation date stands in for its payment date).
      const shopRows = await client
        .select({ id: shops.id })
        .from(shopAttributions)
        .innerJoin(shops, eq(shops.id, shopAttributions.shopId))
        .where(and(eq(shopAttributions.dealerId, link.memberDealerId), eq(shopAttributions.status, "ACTIVE"), eq(shops.feePaymentStatus, "PAID"), gte(shops.createdAt, from)));
      for (const s of shopRows) {
        const [already] = await client.select({ id: dealerCommissionLedger.id }).from(dealerCommissionLedger).where(and(eq(dealerCommissionLedger.accrualKey, `SFS:${s.id}`), eq(dealerCommissionLedger.kind, "ACCRUAL")));
        if (already) continue;
        accrued += (await accrueSuperShopFee(client, s.id, actor, new Date())).length;
      }
      // The team dealer's own joining fees.
      const joining = await client
        .select()
        .from(dealerJoiningPayments)
        .where(and(eq(dealerJoiningPayments.dealerId, link.memberDealerId), eq(dealerJoiningPayments.status, "PAID"), isNotNull(dealerJoiningPayments.paidAt), gte(dealerJoiningPayments.paidAt, from)));
      for (const p of joining) {
        const base = Number(p.basePaise);
        accrued += (
          await writeSuperEntry(client, {
            superDealer: team.superDealer,
            shopId: null,
            entryType: "SUPER_FEE",
            milestone: "REGISTERED",
            accrualKey: `SFJ:${p.id}`,
            feePaise: Number(p.totalPaise),
            basePaise: base,
            amountPaise: shareOf(base, rates.feeShareBp),
            note: `super franchisee ${rates.feeShareBp / 100}% of a team dealer's joining fee`,
            createdAt: p.paidAt ?? undefined,
            actor,
          })
        ).length;
      }
      // The team dealer's own franchise (zone) fees, new and renewals; test bookings never count.
      const bookings = await client
        .select()
        .from(franchiseBookings)
        .where(and(eq(franchiseBookings.ownerDealerId, link.memberDealerId), eq(franchiseBookings.status, "PAID"), eq(franchiseBookings.isTest, false), isNotNull(franchiseBookings.paidAt), gte(franchiseBookings.paidAt, from)));
      for (const b of bookings) {
        const base = Number(b.basePaise);
        accrued += (
          await writeSuperEntry(client, {
            superDealer: team.superDealer,
            shopId: null,
            entryType: "SUPER_FEE",
            milestone: "REGISTERED",
            accrualKey: `SFB:${b.id}`,
            feePaise: Number(b.totalPaise),
            basePaise: base,
            amountPaise: shareOf(base, rates.feeShareBp),
            note: `super franchisee ${rates.feeShareBp / 100}% of a team dealer's franchise fee`,
            createdAt: b.paidAt ?? undefined,
            actor,
          })
        ).length;
      }
    }
  }
  const reversed = await reverseRefundedSuperFees(client, actor);
  return { accrued, reversed };
}

/** SUPER_FEE lines of joining or franchise fees that were refunded since: unpaid → REVERSED; paid → a negative line. */
async function reverseRefundedSuperFees(client: DbClient, actor: SuperActor | null): Promise<number> {
  const lines = await client
    .select()
    .from(dealerCommissionLedger)
    .where(
      and(
        eq(dealerCommissionLedger.entryType, "SUPER_FEE"),
        eq(dealerCommissionLedger.kind, "ACCRUAL"),
        ne(dealerCommissionLedger.status, "REVERSED"),
        or(like(dealerCommissionLedger.accrualKey, "SFJ:%"), like(dealerCommissionLedger.accrualKey, "SFB:%")),
      ),
    );
  if (!lines.length) return 0;
  const joiningIds = lines.filter((l) => l.accrualKey!.startsWith("SFJ:")).map((l) => l.accrualKey!.slice(4));
  const bookingIds = lines.filter((l) => l.accrualKey!.startsWith("SFB:")).map((l) => l.accrualKey!.slice(4));
  const paid = new Set<string>();
  if (joiningIds.length) for (const r of await client.select({ id: dealerJoiningPayments.id }).from(dealerJoiningPayments).where(and(inArray(dealerJoiningPayments.id, joiningIds), eq(dealerJoiningPayments.status, "PAID")))) paid.add(`SFJ:${r.id}`);
  if (bookingIds.length) for (const r of await client.select({ id: franchiseBookings.id }).from(franchiseBookings).where(and(inArray(franchiseBookings.id, bookingIds), eq(franchiseBookings.status, "PAID")))) paid.add(`SFB:${r.id}`);
  let n = 0;
  for (const e of lines) {
    if (paid.has(e.accrualKey!)) continue;
    const [already] = await client.select({ id: dealerCommissionLedger.id }).from(dealerCommissionLedger).where(eq(dealerCommissionLedger.reversesId, e.id));
    if (already) continue;
    if (e.status === "PAID") {
      await client.insert(dealerCommissionLedger).values({
        dealerId: e.dealerId,
        shopId: null,
        milestone: e.milestone,
        entryType: e.entryType,
        kind: "REVERSAL",
        amountPaise: -e.amountPaise,
        status: "EARNED",
        reversesId: e.id,
        note: "reversal after payment: the fee was refunded",
        createdBy: actor?.id ?? null,
      });
    } else {
      await client.update(dealerCommissionLedger).set({ status: "REVERSED", payoutBatchId: null, note: "reversed: the fee was refunded", updatedAt: new Date() }).where(eq(dealerCommissionLedger.id, e.id));
    }
    n += 1;
  }
  return n;
}

/* ======================================================== monthly orders */

interface ShopMonth {
  shop_id: string;
  commission: number;
  refund_commission: number;
}

/**
 * The month close (closeCommissionMonth, inside its transaction): SUPER_ORDER for each super franchisee on the
 * order commission of the shops of the dealers in his team at the end of the month. Dated the last moment of the
 * month. Idempotent per shop and month. Also catches up the month's fees (syncSuperFees).
 */
export async function accrueSuperFranchiseeMonth(tx: DbClient, month: string, start: Date, end: Date, actor: SuperActor | null): Promise<DealerCommissionEntry[]> {
  const rule = await getRule("superFranchisee");
  if (!rule.enabled) return [];
  await syncSuperFees(tx, actor);
  const endIso = end.toISOString();
  const links = await tx
    .select({ link: superFranchiseeMembers, sf: superFranchisees, superDealer: dealers })
    .from(superFranchiseeMembers)
    .innerJoin(superFranchisees, eq(superFranchisees.dealerId, superFranchiseeMembers.superDealerId))
    .innerJoin(dealers, eq(dealers.id, superFranchiseeMembers.superDealerId))
    .where(
      and(
        lt(superFranchiseeMembers.startsAt, end),
        or(isNull(superFranchiseeMembers.endsAt), sql`${superFranchiseeMembers.endsAt} >= ${endIso}::timestamptz`),
        or(isNull(superFranchisees.removedAt), sql`${superFranchisees.removedAt} >= ${endIso}::timestamptz`),
      ),
    );
  const out: DealerCommissionEntry[] = [];
  const stamp = new Date(end.getTime() - 1);
  for (const { link, sf, superDealer } of links) {
    if (superDealer.isInternal) continue;
    const rates = await ratesFor(sf);
    if (rates.orderShareBp <= 0) continue;
    const shopRows = await tx
      .select({ shopId: shopAttributions.shopId })
      .from(shopAttributions)
      .where(and(eq(shopAttributions.dealerId, link.memberDealerId), eq(shopAttributions.status, "ACTIVE"), isNotNull(shopAttributions.activatedAt), lt(shopAttributions.activatedAt, end)));
    if (!shopRows.length) continue;
    const ids = shopRows.map((s) => s.shopId);
    const figures = (await tx.execute(sql`
      select s.shop_id,
        coalesce((select sum(o.commission_paise) from order_financials o where o.shop_id = s.shop_id and o.delivered_at >= ${start.toISOString()}::timestamptz and o.delivered_at < ${endIso}::timestamptz), 0) as commission,
        coalesce((select sum(case when o.goods_paise > 0 then least(adj.customer_refund_paise, o.goods_paise)::numeric * o.commission_paise / o.goods_paise else 0 end)
          from financial_adjustments adj join order_financials o on o.order_id = adj.order_id
          where o.shop_id = s.shop_id and adj.type in ('REFUND_SHOP', 'REFUND_PLATFORM') and o.delivered_at is not null
            and adj.created_at >= ${start.toISOString()}::timestamptz and adj.created_at < ${endIso}::timestamptz), 0) as refund_commission
      from unnest(array[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]) as s(shop_id)`)) as unknown as ShopMonth[];
    for (const f of figures) {
      const commission = Math.max(0, Math.round(Number(f.commission) - Number(f.refund_commission)));
      const amount = shareOf(commission, rates.orderShareBp);
      if (amount <= 0) continue;
      out.push(
        ...(await writeSuperEntry(tx, {
          superDealer,
          shopId: f.shop_id,
          entryType: "SUPER_ORDER",
          milestone: "MONTHLY",
          accrualKey: `SFO:${f.shop_id}:${month}`,
          feePaise: 0,
          basePaise: commission,
          amountPaise: amount,
          note: `${month}: super franchisee ${rates.orderShareBp / 100}% of GoKesari's order commission`,
          createdAt: stamp,
          actor,
        })),
      );
    }
  }
  if (out.length) {
    await recordAudit(
      { actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.DEALER_COMMISSION_ACCRUED, entityType: "commission_month", entityId: month, newValue: { superFranchisee: true, lines: out.length, totalPaise: out.reduce((n, e) => n + Number(e.amountPaise), 0) } },
      tx,
    );
  }
  return out;
}

/* ================================================================= admin */

const pctText = (bp: number) => `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;

/**
 * Owner, 27-Nov-2026: the people concerned hear of every super franchisee change (e-mail + in-app), after the commit.
 * Never throws: a failed notice is logged, the change stands.
 */
async function tellDealer(dealerId: string, title: string, message: string, key: string): Promise<void> {
  try {
    const [d] = await db.select({ userId: dealers.userId, isInternal: dealers.isInternal }).from(dealers).where(eq(dealers.id, dealerId));
    if (!d?.userId || d.isInternal) return;
    await notify({ userId: d.userId, type: NOTIFICATION_TYPES.DEALER_TEAM_CHANGED, title, vars: { message }, actionUrl: "/dealer", dedupeKey: key });
  } catch (error) {
    console.error("[super-franchisee] notice failed", dealerId, error instanceof Error ? error.message : error);
  }
}

const nameOf = async (dealerId: string) => (await db.select({ n: dealers.legalName }).from(dealers).where(eq(dealers.id, dealerId)))[0]?.n ?? "a dealer";

async function lockDealer(tx: DbClient, dealerId: string): Promise<Dealer> {
  const [d] = await tx.select().from(dealers).where(eq(dealers.id, dealerId)).for("update");
  if (!d) throw notFound("Dealer");
  return d;
}

/** Makes a dealer a super franchisee (or brings a removed one back). Optional own rates; null = the rule's. */
export async function promoteSuperFranchisee(dealerId: string, input: { reason: string; feeShareBp?: number | string | null; orderShareBp?: number | string | null }, actor: SuperActor): Promise<SuperFranchisee> {
  requireAdmin(actor);
  const reason = cleanReason(input.reason);
  const feeShareBp = bpOrNull(input.feeShareBp, "feeShareBp");
  const orderShareBp = bpOrNull(input.orderShareBp, "orderShareBp");
  return db.transaction(async (tx) => {
    const dealer = await lockDealer(tx, dealerId);
    if (dealer.isInternal) throw conflict("GoKesari's own dealer account cannot be a super franchisee.");
    if (dealer.status !== "APPROVED") throw conflict("Only an approved dealer can be made a super franchisee.");
    const [inTeam] = await tx.select({ id: superFranchiseeMembers.id }).from(superFranchiseeMembers).where(and(eq(superFranchiseeMembers.memberDealerId, dealerId), isNull(superFranchiseeMembers.endsAt)));
    if (inTeam) throw conflict("This dealer is in a super franchisee's team. Remove him from that team first.");
    const [before] = await tx.select().from(superFranchisees).where(eq(superFranchisees.dealerId, dealerId)).for("update");
    if (before?.status === "ACTIVE") throw conflict("This dealer is already a super franchisee.");
    const now = new Date();
    const [row] = before
      ? await tx.update(superFranchisees).set({ status: "ACTIVE", feeShareBp, orderShareBp, reason, createdBy: actor.id, removedAt: null, removedBy: null, updatedAt: now }).where(eq(superFranchisees.dealerId, dealerId)).returning()
      : await tx.insert(superFranchisees).values({ dealerId, status: "ACTIVE", feeShareBp, orderShareBp, reason, createdBy: actor.id }).returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPER_FRANCHISEE_CHANGED, entityType: "dealer", entityId: dealerId, previousValue: before ? { status: before.status } : null, newValue: { status: "ACTIVE", feeShareBp, orderShareBp, reason } }, tx);
    return row;
  }).then(async (row) => {
    const rates = await ratesFor(row);
    await tellDealer(
      dealerId,
      "You are now a GoKesari super franchisee",
      `GoKesari has made you a super franchisee. GoKesari will put franchisees in your team; you earn ${pctText(rates.feeShareBp)} of every fee paid in your team and ${pctText(rates.orderShareBp)} of GoKesari's order commission on your team's shops every month — paid by GoKesari on top, nothing is taken from your franchisees. You get an e-mail when a franchisee joins or leaves your team and when a shop registers in it; your team's numbers come in your Monday and monthly reports.`,
      `super-promoted:${dealerId}:${row.updatedAt.getTime()}`,
    );
    return row;
  });
}

/** Removes a super franchisee: his team is released (every dealer's link ends now). What he earned stays. */
export async function removeSuperFranchisee(dealerId: string, reasonInput: string, actor: SuperActor): Promise<void> {
  requireAdmin(actor);
  const reason = cleanReason(reasonInput);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(superFranchisees).where(eq(superFranchisees.dealerId, dealerId)).for("update");
    if (!before || before.status !== "ACTIVE") throw conflict("This dealer is not a super franchisee.");
    const now = new Date();
    const released = await tx
      .update(superFranchiseeMembers)
      .set({ endsAt: now, endReason: `super franchisee removed: ${reason}`, endedBy: actor.id })
      .where(and(eq(superFranchiseeMembers.superDealerId, dealerId), isNull(superFranchiseeMembers.endsAt)))
      .returning({ member: superFranchiseeMembers.memberDealerId });
    await tx.update(superFranchisees).set({ status: "REMOVED", removedAt: now, removedBy: actor.id, updatedAt: now }).where(eq(superFranchisees.dealerId, dealerId));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPER_FRANCHISEE_CHANGED, entityType: "dealer", entityId: dealerId, previousValue: { status: "ACTIVE" }, newValue: { status: "REMOVED", reason, teamReleased: released.map((r) => r.member) } }, tx);
    return released.map((r) => r.member);
  }).then(async (released) => {
    const stamp = Date.now();
    const superName = await nameOf(dealerId);
    await tellDealer(dealerId, "You are no longer a GoKesari super franchisee", `GoKesari has ended your super franchisee role (${reason}). What you have earned so far stays and is paid as usual; nothing new is earned on the team from now.`, `super-removed:${dealerId}:${stamp}`);
    for (const member of released) {
      await tellDealer(member, "Your super franchisee team changed", `${superName} is no longer a super franchisee, so you are not in a super franchisee's team for now. Your own commission is not affected.`, `super-released:${member}:${stamp}`);
    }
  });
}

/** A super franchisee's own rates (null = the rule's). Applies to what is earned from now on. */
export async function setSuperFranchiseeRates(dealerId: string, input: { reason: string; feeShareBp?: number | string | null; orderShareBp?: number | string | null }, actor: SuperActor): Promise<SuperFranchisee> {
  requireAdmin(actor);
  const reason = cleanReason(input.reason);
  const feeShareBp = bpOrNull(input.feeShareBp, "feeShareBp");
  const orderShareBp = bpOrNull(input.orderShareBp, "orderShareBp");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(superFranchisees).where(eq(superFranchisees.dealerId, dealerId)).for("update");
    if (!before || before.status !== "ACTIVE") throw conflict("This dealer is not a super franchisee.");
    const [row] = await tx.update(superFranchisees).set({ feeShareBp, orderShareBp, updatedAt: new Date() }).where(eq(superFranchisees.dealerId, dealerId)).returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPER_FRANCHISEE_CHANGED, entityType: "dealer", entityId: dealerId, previousValue: { feeShareBp: before.feeShareBp, orderShareBp: before.orderShareBp }, newValue: { feeShareBp, orderShareBp, reason } }, tx);
    return row;
  });
}

/**
 * Puts a dealer (free or paid franchisee, existing or new) in a super franchisee's team, or moves him from another
 * team (that link ends now). `backdateDays` > 0 also credits fees paid in his team in the days before (each fee
 * once, ever). Order commission follows the team at each month's end.
 */
export async function assignToSuperFranchisee(superDealerId: string, memberDealerId: string, input: { reason: string; backdateDays?: number | string | null }, actor: SuperActor): Promise<SuperFranchiseeMember> {
  requireAdmin(actor);
  const reason = cleanReason(input.reason);
  const backdateDays = input.backdateDays === null || input.backdateDays === undefined || input.backdateDays === "" ? 0 : Number(input.backdateDays);
  if (!Number.isInteger(backdateDays) || backdateDays < 0 || backdateDays > MAX_BACKDATE_DAYS) throw validationFailed(`Days to credit back: 0–${MAX_BACKDATE_DAYS}.`, { fields: { backdateDays: `0–${MAX_BACKDATE_DAYS}.` } });
  if (superDealerId === memberDealerId) throw validationFailed("A super franchisee cannot be in his own team.", { fields: { memberDealerId: "Choose another dealer." } });
  const link = await db.transaction(async (tx) => {
    // Lock both dealers in a fixed order so two admins moving the same people cannot deadlock.
    const [a, b] = [superDealerId, memberDealerId].sort();
    await lockDealer(tx, a);
    await lockDealer(tx, b);
    const [sf] = await tx.select().from(superFranchisees).where(eq(superFranchisees.dealerId, superDealerId));
    if (!sf || sf.status !== "ACTIVE") throw conflict("That dealer is not a super franchisee.");
    const [member] = await tx.select().from(dealers).where(eq(dealers.id, memberDealerId));
    if (!member) throw notFound("Dealer");
    if (member.isInternal) throw conflict("GoKesari's own dealer account cannot be in a team.");
    if (["REJECTED", "TERMINATED"].includes(member.status)) throw conflict("A rejected or terminated dealer cannot be put in a team.");
    const [memberIsSuper] = await tx.select({ s: superFranchisees.status }).from(superFranchisees).where(and(eq(superFranchisees.dealerId, memberDealerId), eq(superFranchisees.status, "ACTIVE")));
    if (memberIsSuper) throw conflict("A super franchisee cannot be in another super franchisee's team.");
    const now = new Date();
    const [open] = await tx.select().from(superFranchiseeMembers).where(and(eq(superFranchiseeMembers.memberDealerId, memberDealerId), isNull(superFranchiseeMembers.endsAt))).for("update");
    if (open?.superDealerId === superDealerId) throw conflict("This dealer is already in that team.");
    if (open) await tx.update(superFranchiseeMembers).set({ endsAt: now, endReason: `moved: ${reason}`, endedBy: actor.id }).where(eq(superFranchiseeMembers.id, open.id));
    const [row] = await tx.insert(superFranchiseeMembers).values({ superDealerId, memberDealerId, startsAt: now, reason, assignedBy: actor.id }).returning();
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPER_FRANCHISEE_TEAM_CHANGED, entityType: "dealer", entityId: memberDealerId, previousValue: open ? { superDealerId: open.superDealerId } : null, newValue: { superDealerId, moved: !!open, backdateDays, reason } },
      tx,
    );
    return row;
  });
  const [superName, memberName] = [await nameOf(superDealerId), await nameOf(memberDealerId)];
  await tellDealer(superDealerId, `${memberName} joined your team`, `GoKesari has put ${memberName} in your super franchisee team. From now you earn your share of the fees paid in ${memberName}'s business and of GoKesari's order commission on ${memberName}'s shops.`, `super-joined:${link.id}`);
  await tellDealer(memberDealerId, `You are now in ${superName}'s team`, `GoKesari has put you in the team of super franchisee ${superName}. Your own commission does not change — ${superName}'s share is paid by GoKesari on top.`, `super-member-joined:${link.id}`);
  const [previous] = await db
    .select({ superDealerId: superFranchiseeMembers.superDealerId, id: superFranchiseeMembers.id })
    .from(superFranchiseeMembers)
    .where(and(eq(superFranchiseeMembers.memberDealerId, memberDealerId), isNotNull(superFranchiseeMembers.endsAt), eq(superFranchiseeMembers.endsAt, link.startsAt)));
  if (previous && previous.superDealerId !== superDealerId) {
    await tellDealer(previous.superDealerId, `${memberName} left your team`, `GoKesari has moved ${memberName} to another super franchisee's team. What you earned on ${memberName}'s business so far stays; nothing new is earned on it from now.`, `super-left:${previous.id}`);
  }
  // Fees: the ones paid from now (and, if asked, in the days before) are credited at once when the rule is on.
  await syncSuperFees(db, actor, { memberDealerId, backdateFrom: backdateDays > 0 ? new Date(link.startsAt.getTime() - backdateDays * 86_400_000) : undefined }).catch((e: unknown) =>
    console.error("[super-franchisee] fee catch-up after assignment failed", memberDealerId, e instanceof Error ? e.message : e),
  );
  return link;
}

/** Takes a dealer out of his super franchisee's team (from now). What was earned stays. */
export async function removeFromTeam(memberDealerId: string, reasonInput: string, actor: SuperActor): Promise<void> {
  requireAdmin(actor);
  const reason = cleanReason(reasonInput);
  await db.transaction(async (tx) => {
    const [open] = await tx.select().from(superFranchiseeMembers).where(and(eq(superFranchiseeMembers.memberDealerId, memberDealerId), isNull(superFranchiseeMembers.endsAt))).for("update");
    if (!open) throw conflict("This dealer is not in a super franchisee's team.");
    await tx.update(superFranchiseeMembers).set({ endsAt: new Date(), endReason: reason, endedBy: actor.id }).where(eq(superFranchiseeMembers.id, open.id));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPER_FRANCHISEE_TEAM_CHANGED, entityType: "dealer", entityId: memberDealerId, previousValue: { superDealerId: open.superDealerId }, newValue: { superDealerId: null, reason } }, tx);
    return open;
  }).then(async (open) => {
    const [superName, memberName] = [await nameOf(open.superDealerId), await nameOf(memberDealerId)];
    await tellDealer(open.superDealerId, `${memberName} left your team`, `GoKesari has taken ${memberName} out of your super franchisee team. What you earned on ${memberName}'s business so far stays; nothing new is earned on it from now.`, `super-left:${open.id}`);
    await tellDealer(memberDealerId, "Your super franchisee team changed", `GoKesari has taken you out of ${superName}'s team. Your own commission is not affected.`, `super-member-left:${open.id}`);
  });
}

/* ================================================================= views */

export interface SuperFranchiseeView {
  enabled: boolean;
  ruleFeeShareBp: number;
  ruleOrderShareBp: number;
  /** This dealer as a super franchisee (null = he is not, and never was). */
  self: { status: SuperFranchisee["status"]; feeShareBp: number | null; orderShareBp: number | null; effectiveFeeShareBp: number; effectiveOrderShareBp: number; since: string; reason: string } | null;
  team: { dealerId: string; name: string; status: Dealer["status"]; since: string; reason: string }[];
  /** The team this dealer is in now, if any. */
  memberOf: { dealerId: string; name: string; since: string } | null;
  history: { superDealerId: string; superName: string; startsAt: string; endsAt: string | null; reason: string; endReason: string | null }[];
  earnedPaise: { fees: number; orders: number };
  /** For the admin's pickers. */
  supers: { dealerId: string; name: string }[];
  assignable: { dealerId: string; name: string; status: Dealer["status"]; currentSuper: string | null }[];
}

export async function superFranchiseeView(dealerId: string): Promise<SuperFranchiseeView> {
  const rule = await getRule("superFranchisee");
  const [self] = await db.select().from(superFranchisees).where(eq(superFranchisees.dealerId, dealerId));
  const team = self
    ? await db
        .select({ dealerId: dealers.id, name: dealers.legalName, status: dealers.status, since: superFranchiseeMembers.startsAt, reason: superFranchiseeMembers.reason })
        .from(superFranchiseeMembers)
        .innerJoin(dealers, eq(dealers.id, superFranchiseeMembers.memberDealerId))
        .where(and(eq(superFranchiseeMembers.superDealerId, dealerId), isNull(superFranchiseeMembers.endsAt)))
        .orderBy(dealers.legalName)
    : [];
  const superDealers = db.$with("sd").as(db.select({ id: dealers.id, name: dealers.legalName }).from(dealers));
  const history = await db
    .with(superDealers)
    .select({ link: superFranchiseeMembers, superName: superDealers.name })
    .from(superFranchiseeMembers)
    .innerJoin(superDealers, eq(superDealers.id, superFranchiseeMembers.superDealerId))
    .where(eq(superFranchiseeMembers.memberDealerId, dealerId))
    .orderBy(desc(superFranchiseeMembers.startsAt));
  const open = history.find((h) => h.link.endsAt === null);
  const [earned] = (await db.execute(sql`
    select coalesce(sum(amount_paise) filter (where entry_type = 'SUPER_FEE'), 0)::bigint as fees,
           coalesce(sum(amount_paise) filter (where entry_type = 'SUPER_ORDER'), 0)::bigint as orders
    from dealer_commission_ledger where dealer_id = ${dealerId} and status <> 'REVERSED' and entry_type in ('SUPER_FEE', 'SUPER_ORDER')`)) as unknown as { fees: number; orders: number }[];
  const supers = await db
    .select({ dealerId: dealers.id, name: dealers.legalName })
    .from(superFranchisees)
    .innerJoin(dealers, eq(dealers.id, superFranchisees.dealerId))
    .where(eq(superFranchisees.status, "ACTIVE"))
    .orderBy(dealers.legalName);
  const activeSuperIds = new Set(supers.map((s) => s.dealerId));
  const openLinks = await db.select({ member: superFranchiseeMembers.memberDealerId, sup: superFranchiseeMembers.superDealerId }).from(superFranchiseeMembers).where(isNull(superFranchiseeMembers.endsAt));
  const superName = new Map(supers.map((s) => [s.dealerId, s.name]));
  const linkOf = new Map(openLinks.map((l) => [l.member, l.sup]));
  const candidates = await db
    .select({ dealerId: dealers.id, name: dealers.legalName, status: dealers.status })
    .from(dealers)
    .where(and(eq(dealers.isInternal, false), inArray(dealers.status, ["APPROVED", "PENDING", "SUSPENDED"])))
    .orderBy(dealers.legalName);
  return {
    enabled: rule.enabled,
    ruleFeeShareBp: rule.feeShareBp,
    ruleOrderShareBp: rule.orderShareBp,
    self: self
      ? {
          status: self.status,
          feeShareBp: self.feeShareBp,
          orderShareBp: self.orderShareBp,
          effectiveFeeShareBp: self.feeShareBp ?? rule.feeShareBp,
          effectiveOrderShareBp: self.orderShareBp ?? rule.orderShareBp,
          since: self.createdAt.toISOString(),
          reason: self.reason,
        }
      : null,
    team: team.map((t) => ({ ...t, since: t.since.toISOString() })),
    memberOf: open ? { dealerId: open.link.superDealerId, name: open.superName, since: open.link.startsAt.toISOString() } : null,
    history: history.map((h) => ({ superDealerId: h.link.superDealerId, superName: h.superName, startsAt: h.link.startsAt.toISOString(), endsAt: h.link.endsAt?.toISOString() ?? null, reason: h.link.reason, endReason: h.link.endReason })),
    earnedPaise: { fees: Number(earned?.fees ?? 0), orders: Number(earned?.orders ?? 0) },
    supers: supers.filter((s) => s.dealerId !== dealerId),
    assignable: candidates
      .filter((c) => c.dealerId !== dealerId && !activeSuperIds.has(c.dealerId))
      .map((c) => ({ ...c, currentSuper: linkOf.has(c.dealerId) ? (superName.get(linkOf.get(c.dealerId)!) ?? null) : null })),
  };
}
