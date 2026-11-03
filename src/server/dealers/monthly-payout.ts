/**
 * Dealer commission, paid monthly (owner, 28 Oct 2026; docs/dealer-programme).
 *
 * On the payout day (dealer_commission_settings.payout_day_of_month, default the
 * 5th, in the app's time zone) the previous calendar month is closed — once:
 *
 *   1. with auto_approve_at_month_end on (the default, owner 29 Oct 2026), the
 *      month's EARNED accruals (not above the cap, not held) are approved first;
 *      switched off, only what an admin approved goes in;
 *   2. per dealer, a DRAFT payout of every APPROVED entry up to the month's end
 *      (earlier months' leftovers included), netted with reversals not yet
 *      settled — as createPayoutBatch() does by hand. A net of zero or less is
 *      carried to the next month;
 *   3. each dealer with anything that month is sent their statement: the shops
 *      they registered, the milestones earned, held / above-cap / reversed
 *      entries, the payout and what is carried forward (in the app and by email,
 *      after the commit).
 *
 * The bank transfer stays an admin's step: they pay the draft and record the
 * UTR (markPayoutPaid), which tells the dealer as today. A cancelled draft's
 * entries go into the next month's payout. dealer_commission_months has one
 * row per closed month; inserting it is the guard that makes the close run once,
 * whoever starts it (the daily job, or an admin's "close now").
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { addDays, todayIn, type IsoDate } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { conflict, forbidden, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  dealerCommissionLedger,
  dealerCommissionMonths,
  dealerPayoutBatches,
  dealerSalespeople,
  dealers,
  shopAttributions,
  shops,
  type CommissionStatus,
  type LedgerMilestone,
  type DealerCommissionMonth,
  type DealerPayoutBatch,
  type UserRole,
} from "@/server/db/schema";
import { touchSellerRow } from "@/server/db/split/gate";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { notify } from "@/server/services/notifications";
import { queueDocumentEmail } from "@/server/documents/email";
import { getRule } from "@/server/services/settings";
import { COMMISSION_ENTRY_TYPE_LABELS, STATEMENT_LINES, type CommissionEntryType } from "@/lib/dealer-tiers";
import { getCommissionSettings, payeeStatus, payoutTds, tdsColumns } from "./commission";
import { financialYear } from "@/server/tax/commission-tds";
import { accrueTargetBonuses } from "./tiered";

interface Actor {
  id: string;
  role: UserRole;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/* ---------------------------------------------------------------- months */

/** "2026-10" → "October 2026". */
export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** The calendar month before the one `today` is in. */
export function previousMonth(today: IsoDate): string {
  const first = `${today.slice(0, 7)}-01` as IsoDate;
  return addDays(first, -1).slice(0, 7);
}

function nextMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** The month's start and end as instants in the app's time zone (IST): [start, end). */
export function monthBounds(month: string): { start: Date; end: Date } {
  const offset = "+05:30"; // APP_TIMEZONE is Asia/Kolkata; India has no daylight saving
  return { start: new Date(`${month}-01T00:00:00${offset}`), end: new Date(`${nextMonth(month)}-01T00:00:00${offset}`) };
}

function assertMonth(month: string): void {
  if (!MONTH.test(month)) throw validationFailed("Give the month as YYYY-MM.", { fields: { month: "YYYY-MM" } });
}

/* ----------------------------------------------------------------- close */

export interface MonthCloseResult {
  month: string;
  alreadyClosed: boolean;
  autoApproved: number;
  /** memberId: the team member paid (TIERED); null = the dealer. totalPaise is the gross; the transfer is gross − TDS. */
  payouts: { dealerId: string; memberId: string | null; batchId: string; totalPaise: number; tdsPaise: number; entries: number }[];
  /** Not drafted this month: owed back, below the minimum, or held (no PAN / bank / agreement — `missing`). */
  carried: { dealerId: string; memberId: string | null; netPaise: number; reason?: string; missing?: string[] }[];
  notified: number;
}

/**
 * Closes `month` (YYYY-MM): drafts each dealer's payout and sends the statements.
 * `actor` null = the scheduled job; otherwise ADMIN only. A month not yet over is
 * refused; a month already closed is reported, not closed again.
 */
export async function closeCommissionMonth(month: string, actor: Actor | null, now: Date = new Date()): Promise<MonthCloseResult> {
  if (actor && actor.role !== "ADMIN") throw forbidden("Only an admin can close a commission month.");
  assertMonth(month);
  const { start, end } = monthBounds(month);
  if (end.getTime() > now.getTime()) throw conflict(`${monthLabel(month)} is not over yet.`);
  const settings = await getCommissionSettings();

  const result = await db.transaction(async (tx) => {
    const [claimed] = await tx.insert(dealerCommissionMonths).values({ periodMonth: month, closedBy: actor?.id ?? null }).onConflictDoNothing().returning();
    if (!claimed) return null;

    // 0. TIERED (0136): the month's target bonuses, dated inside the month, before anything is approved.
    const bonuses = await accrueTargetBonuses(tx, month, start, end, actor);

    // 1. The month's earned accruals, approved first when the setting says so.
    let autoApproved: string[] = [];
    if (settings.autoApproveAtMonthEnd) {
      const approved = await tx
        .update(dealerCommissionLedger)
        .set({ status: "APPROVED", approvedAt: new Date(), approvedBy: null, updatedAt: new Date() })
        .where(
          and(
            eq(dealerCommissionLedger.status, "EARNED"),
            eq(dealerCommissionLedger.kind, "ACCRUAL"),
            eq(dealerCommissionLedger.aboveCap, false),
            isNull(dealerCommissionLedger.payoutBatchId),
            lt(dealerCommissionLedger.createdAt, end),
          ),
        )
        .returning({ id: dealerCommissionLedger.id });
      autoApproved = approved.map((r) => r.id);
    }

    // 2. One draft payout per dealer, as createPayoutBatch() makes one by hand — up to the month's end.
    const payable = or(
      eq(dealerCommissionLedger.status, "APPROVED"),
      and(eq(dealerCommissionLedger.kind, "REVERSAL"), inArray(dealerCommissionLedger.status, ["EARNED", "APPROVED"])),
    );
    // One payout per payee: the dealer itself, or (TIERED) each team member, paid directly.
    const payees = (
      await tx
        .selectDistinct({ dealerId: dealerCommissionLedger.dealerId, memberId: dealerCommissionLedger.payeeMemberId })
        .from(dealerCommissionLedger)
        .where(and(isNull(dealerCommissionLedger.payoutBatchId), lt(dealerCommissionLedger.createdAt, end), payable))
    ).sort((a, b) => a.dealerId.localeCompare(b.dealerId) || (a.memberId ?? "").localeCompare(b.memberId ?? ""));

    const payoutRule = await getRule("dealerPayouts");
    const payouts: MonthCloseResult["payouts"] = [];
    const carried: MonthCloseResult["carried"] = [];
    const locked = new Set<string>();
    // Gap report C1 / C2: each payee's payable rows and whether they can be paid (PAN, verified bank, agreement).
    const ready: { dealerId: string; memberId: string | null; panHash: string | null; bankKey: string | null; key: string; rows: { id: string; amountPaise: number }[]; total: number }[] = [];
    for (const { dealerId, memberId } of payees) {
      if (!locked.has(dealerId)) {
        await tx.select({ id: dealers.id }).from(dealers).where(eq(dealers.id, dealerId)).for("update");
        await touchSellerRow(tx, dealers, dealerId);
        locked.add(dealerId);
      }
      const rows = await tx
        .select({ id: dealerCommissionLedger.id, amountPaise: dealerCommissionLedger.amountPaise })
        .from(dealerCommissionLedger)
        .where(
          and(
            eq(dealerCommissionLedger.dealerId, dealerId),
            memberId ? eq(dealerCommissionLedger.payeeMemberId, memberId) : isNull(dealerCommissionLedger.payeeMemberId),
            isNull(dealerCommissionLedger.payoutBatchId),
            lt(dealerCommissionLedger.createdAt, end),
            payable,
          ),
        );
      const total = rows.reduce((s, r) => s + r.amountPaise, 0);
      if (rows.length === 0) continue;
      const payee = await payeeStatus(tx, dealerId, memberId);
      // Team members always; dealers when rule dealerPayouts.enforcePayeeChecks is on (off: as before).
      if (payee.missing.length && (memberId || payoutRule.enforcePayeeChecks)) {
        carried.push({ dealerId, memberId, netPaise: total, reason: `held: ${payee.missing.join(", ")}`, missing: payee.missing });
        continue;
      }
      ready.push({ dealerId, memberId, panHash: payee.panHash, bankKey: payee.bankKey, key: payee.panHash ?? `dealer:${dealerId}`, rows, total });
    }
    // One payout per PAN: a person paid in two roles (or two networks) gets one transfer.
    for (const key of [...new Set(ready.map((r) => r.key))].sort()) {
      const group = ready.filter((r) => r.key === key);
      const panHash = group[0].panHash;
      const total = group.reduce((t, g) => t + g.total, 0);
      const first = group[0];
      // Payees sharing a PAN are paid together only to one bank account; otherwise an admin checks who owns the PAN.
      if (group.length > 1 && (group.some((g) => !g.bankKey) || new Set(group.map((g) => g.bankKey)).size > 1)) {
        for (const g of group) carried.push({ dealerId: g.dealerId, memberId: g.memberId, netPaise: g.total, reason: "held: this PAN is on payees with different bank accounts — an admin must check it", missing: ["PAN check by an admin"] });
        continue;
      }
      if (total <= 0 || total < payoutRule.minPayoutPaise) {
        for (const g of group) carried.push({ dealerId: g.dealerId, memberId: g.memberId, netPaise: g.total, reason: total <= 0 ? "owed back" : `below the ₹${(payoutRule.minPayoutPaise / 100).toLocaleString("en-IN")} minimum` });
        continue;
      }
      const tds = await payoutTds(tx, first.dealerId, first.memberId, total, new Date(end.getTime() - 1), panHash);
      const tdsPaise = tds.tdsPaise;
      const ids = group.flatMap((g) => g.rows.map((r) => r.id));
      const [batch] = await tx
        .insert(dealerPayoutBatches)
        .values({
          dealerId: first.dealerId,
          memberId: first.memberId,
          payeePanHash: panHash,
          totalPaise: total,
          ...tdsColumns(tds),
          // Gap report D3: a reversal of money paid in an earlier financial year goes to the CA.
          ...((await crossesFinancialYear(tx, ids, end)) && !tds.flag ? { tdsFlag: "REVERSAL_PRIOR_FY" } : {}),
          periodMonth: month,
          note: `Commission for ${monthLabel(month)}${group.length > 1 ? ` (${group.length} roles, one PAN)` : ""}`,
          createdBy: actor?.id ?? null,
        })
        .returning();
      await tx.update(dealerCommissionLedger).set({ payoutBatchId: batch.id, updatedAt: new Date() }).where(inArray(dealerCommissionLedger.id, ids));
      payouts.push({ dealerId: first.dealerId, memberId: first.memberId, batchId: batch.id, totalPaise: total, tdsPaise, entries: ids.length });
    }

    const totalPaise = payouts.reduce((s, p) => s + p.totalPaise, 0);
    await tx
      .update(dealerCommissionMonths)
      .set({ autoApproved: autoApproved.length, payouts: payouts.length, totalPaise, summary: { payouts, carried, autoApproved, bonuses: bonuses.map((b) => b.id) } })
      .where(eq(dealerCommissionMonths.periodMonth, month));
    await recordAudit(
      {
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        action: AUDIT_ACTIONS.DEALER_COMMISSION_MONTH_CLOSED,
        entityType: "dealer_commission_month",
        entityId: month,
        newValue: { month, payouts: payouts.length, totalPaise, carried, autoApproved: autoApproved.length, targetBonuses: bonuses.length },
      },
      tx,
    );
    return { autoApproved: autoApproved.length, payouts, carried };
  });

  if (!result) {
    const [existing] = await db.select().from(dealerCommissionMonths).where(eq(dealerCommissionMonths.periodMonth, month));
    return { month, alreadyClosed: true, autoApproved: existing?.autoApproved ?? 0, payouts: [], carried: [], notified: 0 };
  }

  // 3. The statements, after the commit (the notification outbox retries a failed email).
  const notified = await sendMonthStatements(month, start, end, result.payouts);
  // Gap report C2: payees held for a missing PAN, bank account or agreement are told what to add.
  await remindHeldPayees(month, result.carried);
  return { month, alreadyClosed: false, ...result, notified };
}

/** Gap report C2: the monthly reminder to a payee whose commission is held — what is missing, and the amount waiting. */
async function remindHeldPayees(month: string, carried: MonthCloseResult["carried"]): Promise<number> {
  if (!(await getRule("dealerPayouts")).reminderEnabled) return 0;
  let sent = 0;
  for (const c of carried.filter((x) => x.missing?.length && x.netPaise > 0)) {
    const [payee] = c.memberId
      ? await db.select({ userId: dealerSalespeople.userId }).from(dealerSalespeople).where(eq(dealerSalespeople.id, c.memberId))
      : await db.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, c.dealerId));
    if (!payee?.userId) continue;
    await notify({
      userId: payee.userId,
      type: NOTIFICATION_TYPES.DEALER_PAYOUT_HELD,
      vars: { month: monthLabel(month), amount: rupees(c.netPaise), missing: c.missing!.join(", ") },
      actionUrl: "/dealer",
      channels: ["PUSH"],
      dedupeKey: `dealer-payout-held:${month}:${c.memberId ?? c.dealerId}`,
    });
    sent += 1;
  }
  return sent;
}

/** Every approved dealer with something in the month (a registration, an entry, a payout) is told. */
async function sendMonthStatements(month: string, start: Date, end: Date, payouts: MonthCloseResult["payouts"]): Promise<number> {
  const active = new Set<string>(payouts.map((p) => p.dealerId));
  const fromEntries = await db
    .selectDistinct({ dealerId: dealerCommissionLedger.dealerId })
    .from(dealerCommissionLedger)
    .where(and(gte(dealerCommissionLedger.createdAt, start), lt(dealerCommissionLedger.createdAt, end)));
  const fromShops = await db
    .selectDistinct({ dealerId: shopAttributions.dealerId })
    .from(shopAttributions)
    .where(and(gte(shopAttributions.createdAt, start), lt(shopAttributions.createdAt, end)));
  for (const r of [...fromEntries, ...fromShops]) active.add(r.dealerId);
  if (active.size === 0) return 0;

  const recipients = await db
    .select({ id: dealers.id, userId: dealers.userId })
    .from(dealers)
    .where(and(inArray(dealers.id, [...active]), eq(dealers.status, "APPROVED")));
  // TIERED: team members with entries in the month (or a payout) get their own statement.
  const memberIds = new Set<string>(payouts.map((p) => p.memberId).filter((m): m is string => Boolean(m)));
  for (const r of await db
    .selectDistinct({ memberId: dealerCommissionLedger.payeeMemberId })
    .from(dealerCommissionLedger)
    .where(and(gte(dealerCommissionLedger.createdAt, start), lt(dealerCommissionLedger.createdAt, end), sql`${dealerCommissionLedger.payeeMemberId} IS NOT NULL`))) {
    memberIds.add(r.memberId!);
  }
  const members = memberIds.size
    ? await db
        .select({ id: dealerSalespeople.id, dealerId: dealerSalespeople.dealerId, userId: dealerSalespeople.userId })
        .from(dealerSalespeople)
        .innerJoin(dealers, eq(dealers.id, dealerSalespeople.dealerId))
        .where(and(inArray(dealerSalespeople.id, [...memberIds]), eq(dealers.status, "APPROVED")))
    : [];
  const targets = [
    ...recipients.map((d) => ({ dealerId: d.id, memberId: null as string | null, userId: d.userId })),
    ...members.map((m) => ({ dealerId: m.dealerId, memberId: m.id as string | null, userId: m.userId })),
  ];
  let sent = 0;
  for (const target of targets) {
    if (!target.userId) continue;
    try {
      const s = await dealerMonthStatement(target.dealerId, month, target.memberId);
      // Gap report C5: a payout's statement is also emailed with the CSV attached.
      if (s.payout) {
        await queueDocumentEmail({
          docType: "DEALER_STATEMENT",
          docId: s.payout.id,
          userId: target.userId,
          recipientRole: "DEALER",
          title: `Your commission statement for ${s.label}`,
          body: `Gross ${rupees(s.payout.totalPaise)}, TDS ${rupees(s.payout.tdsPaise)}, net ${rupees(s.payout.netPaise)}. The statement is attached (CSV) and on your dealer page.`,
          actionUrl: `/dealer?statement=${month}`,
          category: "GENERAL",
        }).catch((error) => console.error("[dealer-monthly-payout] statement email failed", error));
      }
      await notify({
        userId: target.userId,
        type: NOTIFICATION_TYPES.DEALER_COMMISSION_STATEMENT,
        vars: {
          month: s.label,
          registrations: String(s.totals.registrations),
          earned: rupees(s.totals.earnedPaise),
          payout: s.payout ? rupees(s.payout.netPaise) : "₹0",
        },
        actionUrl: `/dealer?statement=${month}`,
        dedupeKey: `dealer-statement:${month}:${target.memberId ?? target.dealerId}`,
        metadata: { month, dealerId: target.dealerId, memberId: target.memberId },
      });
      sent += 1;
    } catch (error) {
      // The month is closed whatever happens here; one payee's notice never stops the others.
      console.error("[dealer-monthly-payout] statement notice failed", month, target.memberId ?? target.dealerId, error instanceof Error ? error.message : error);
    }
  }
  return sent;
}

/**
 * The daily job: on or after the payout day, closes the month before (once).
 * Nothing while the dealer programme is off or before the payout day.
 */
export async function runMonthlyDealerPayout(now: Date = new Date()): Promise<{ skipped: string } | MonthCloseResult> {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) return { skipped: "dealer programme off" };
  const today = todayIn(getEnv().APP_TIMEZONE, now);
  const { payoutDayOfMonth } = await getCommissionSettings();
  if (Number(today.slice(8, 10)) < payoutDayOfMonth) return { skipped: `before day ${payoutDayOfMonth}` };
  const month = previousMonth(today);
  const [done] = await db.select({ m: dealerCommissionMonths.periodMonth }).from(dealerCommissionMonths).where(eq(dealerCommissionMonths.periodMonth, month));
  if (done) return { skipped: `${month} already closed` };
  return closeCommissionMonth(month, null, now);
}

/* ------------------------------------------------------------- statement */

export interface StatementRegistration {
  shopId: string;
  shopName: string;
  registrationNumber: string | null;
  registeredOn: string;
  pincode: string | null;
  employee: string | null;
  attribution: "ACTIVE" | "REVERSED";
  shopStatus: string;
}

export interface StatementEntry {
  id: string;
  date: string;
  shopName: string;
  milestone: LedgerMilestone;
  entryType: CommissionEntryType;
  level: number | null;
  kind: string;
  status: CommissionStatus;
  amountPaise: number;
  note: string | null;
}

export interface DealerMonthStatement {
  month: string;
  label: string;
  /** False for the month in progress (figures so far). */
  closed: boolean;
  registrations: StatementRegistration[];
  /** Commission entries created in the month, whatever their status now. */
  entries: StatementEntry[];
  /** totalPaise is the gross; netPaise = gross − TDS, the bank transfer. */
  payout: (Pick<DealerPayoutBatch, "id" | "status" | "totalPaise" | "tdsPaise" | "tdsRateBp" | "paymentReference"> & { netPaise: number; paidAt: string | null; entries: StatementEntry[] }) | null;
  /** One line per entry type (direct-1, direct-2, override, renewal, development, bonus): earned in the month. */
  lines: { key: string; label: string; amountPaise: number }[];
  /** Whose statement: the dealer (null) or a team member. */
  payee: { memberId: string | null; name: string };
  totals: {
    registrations: number;
    activated: number;
    earnedPaise: number;
    heldPaise: number;
    aboveCapPaise: number;
    reversedPaise: number;
    /** Not yet approved by an admin (goes into a later month once approved). */
    awaitingApprovalPaise: number;
    /** Reversals larger than the approved amount: owed back, taken from the next payout. */
    carriedForwardPaise: number;
  };
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const day = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

async function entryRows(where: ReturnType<typeof and>): Promise<(StatementEntry & { aboveCap: boolean })[]> {
  const rows = await db
    .select({ e: dealerCommissionLedger, shopName: shops.name })
    .from(dealerCommissionLedger)
    .leftJoin(shops, eq(shops.id, dealerCommissionLedger.shopId))
    .where(where)
    .orderBy(asc(dealerCommissionLedger.createdAt));
  return rows.map((r) => ({
    id: r.e.id,
    date: day(r.e.createdAt),
    shopName: r.shopName ?? "Monthly target bonus",
    milestone: r.e.milestone,
    entryType: r.e.entryType,
    level: r.e.level,
    kind: r.e.kind,
    status: r.e.status,
    amountPaise: r.e.amountPaise,
    note: r.e.note,
    aboveCap: r.e.aboveCap,
  }));
}

/**
 * One payee's statement for one month — their own rows only. `memberId` null
 * (the default): the dealer itself; a team member's id: that member's (TIERED).
 */
export async function dealerMonthStatement(dealerId: string, month: string, memberId: string | null = null): Promise<DealerMonthStatement> {
  assertMonth(month);
  const { start, end } = monthBounds(month);
  const inMonth = (col: typeof shopAttributions.createdAt | typeof dealerCommissionLedger.createdAt) => and(gte(col, start), lt(col, end));
  const payeeIs = memberId ? eq(dealerCommissionLedger.payeeMemberId, memberId) : isNull(dealerCommissionLedger.payeeMemberId);
  const [member] = memberId ? await db.select().from(dealerSalespeople).where(and(eq(dealerSalespeople.id, memberId), eq(dealerSalespeople.dealerId, dealerId))) : [];
  if (memberId && !member) throw validationFailed("Not a member of this dealer's team.");
  const [dealerRow] = await db.select({ name: dealers.legalName }).from(dealers).where(eq(dealers.id, dealerId));

  const shopsRows = await db
    .select({ a: shopAttributions, shop: shops, employee: dealerSalespeople.name })
    .from(shopAttributions)
    .innerJoin(shops, eq(shops.id, shopAttributions.shopId))
    .leftJoin(dealerSalespeople, eq(dealerSalespeople.id, shopAttributions.salespersonId))
    .where(and(eq(shopAttributions.dealerId, dealerId), memberId ? eq(shopAttributions.salespersonId, memberId) : sql`true`, inMonth(shopAttributions.createdAt)))
    .orderBy(asc(shopAttributions.createdAt));
  const registrations: StatementRegistration[] = shopsRows.map((r) => ({
    shopId: r.shop.id,
    shopName: r.shop.name,
    registrationNumber: r.shop.registrationNumber,
    registeredOn: day(r.a.createdAt),
    pincode: r.shop.pincode,
    employee: r.employee ?? r.a.employeeText ?? null,
    attribution: r.a.status,
    shopStatus: r.shop.status,
  }));

  const entries = await entryRows(and(eq(dealerCommissionLedger.dealerId, dealerId), payeeIs, inMonth(dealerCommissionLedger.createdAt))!);
  // The month's payout holding this payee's entries (one per PAN: it may carry another role's too).
  const [batch] = await db
    .select()
    .from(dealerPayoutBatches)
    .where(
      and(
        eq(dealerPayoutBatches.periodMonth, month),
        sql`${dealerPayoutBatches.status} <> 'CANCELLED'`,
        sql`${dealerPayoutBatches.id} in (select ${dealerCommissionLedger.payoutBatchId} from ${dealerCommissionLedger} where ${dealerCommissionLedger.dealerId} = ${dealerId} and ${memberId ? sql`${dealerCommissionLedger.payeeMemberId} = ${memberId}` : sql`${dealerCommissionLedger.payeeMemberId} is null`})`,
      ),
    )
    .orderBy(desc(dealerPayoutBatches.createdAt))
    .limit(1);
  const payoutEntries = batch ? await entryRows(eq(dealerCommissionLedger.payoutBatchId, batch.id) as ReturnType<typeof and>) : [];
  const [closedRow] = await db.select().from(dealerCommissionMonths).where(eq(dealerCommissionMonths.periodMonth, month));
  const carried = ((closedRow?.summary as { carried?: { dealerId: string; memberId?: string | null; netPaise: number }[] } | undefined)?.carried ?? []).find(
    (c) => c.dealerId === dealerId && (c.memberId ?? null) === memberId,
  );

  const sum = (pick: (e: StatementEntry & { aboveCap: boolean }) => boolean) => entries.filter(pick).reduce((s, e) => s + e.amountPaise, 0);
  const strip = (e: StatementEntry & { aboveCap: boolean }): StatementEntry => ({
    id: e.id,
    date: e.date,
    shopName: e.shopName,
    milestone: e.milestone,
    entryType: e.entryType,
    level: e.level,
    kind: e.kind,
    status: e.status,
    amountPaise: e.amountPaise,
    note: e.note,
  });
  const earning = (e: StatementEntry & { aboveCap: boolean }) => e.kind === "ACCRUAL" && !e.aboveCap && e.status !== "REVERSED";
  const lines = STATEMENT_LINES.map((l) => ({ key: l.key, label: l.label, amountPaise: sum((e) => earning(e) && l.types.includes(e.entryType)) })).filter(
    (l) => l.amountPaise !== 0 || l.key !== "standard" || entries.length === 0,
  );
  return {
    month,
    label: monthLabel(month),
    closed: Boolean(closedRow),
    registrations,
    entries: entries.map(strip),
    payout: batch
      ? {
          id: batch.id,
          status: batch.status,
          totalPaise: batch.totalPaise,
          tdsPaise: batch.tdsPaise,
          tdsRateBp: batch.tdsRateBp,
          netPaise: batch.totalPaise - batch.tdsPaise,
          paymentReference: batch.paymentReference,
          paidAt: batch.paidAt?.toISOString() ?? null,
          entries: payoutEntries.map(strip),
        }
      : null,
    lines,
    payee: { memberId, name: member?.name ?? dealerRow?.name ?? "" },
    totals: {
      registrations: registrations.filter((r) => r.attribution === "ACTIVE").length,
      activated: entries.filter((e) => e.kind === "ACCRUAL" && e.milestone === "ACTIVATED").length,
      earnedPaise: sum(earning),
      heldPaise: sum((e) => e.status === "ON_HOLD"),
      aboveCapPaise: sum((e) => e.aboveCap && e.status === "PENDING"),
      reversedPaise: -sum((e) => e.kind === "REVERSAL") + sum((e) => e.kind === "ACCRUAL" && e.status === "REVERSED"),
      awaitingApprovalPaise: sum((e) => e.kind === "ACCRUAL" && e.status === "EARNED" && !e.aboveCap),
      carriedForwardPaise: carried ? -carried.netPaise : 0,
    },
  };
}

/** Whether any of these entries reverses money paid in an earlier financial year than `periodEnd`'s. */
async function crossesFinancialYear(tx: DbClient, entryIds: string[], periodEnd: Date): Promise<boolean> {
  if (entryIds.length === 0) return false;
  const reversals = await tx
    .select({ reversesId: dealerCommissionLedger.reversesId })
    .from(dealerCommissionLedger)
    .where(and(inArray(dealerCommissionLedger.id, entryIds), eq(dealerCommissionLedger.kind, "REVERSAL")));
  const ids = reversals.map((r) => r.reversesId).filter((x): x is string => Boolean(x));
  if (ids.length === 0) return false;
  const paid = await tx
    .select({ paidAt: dealerPayoutBatches.paidAt })
    .from(dealerCommissionLedger)
    .innerJoin(dealerPayoutBatches, eq(dealerPayoutBatches.id, dealerCommissionLedger.payoutBatchId))
    .where(inArray(dealerCommissionLedger.id, ids));
  const fy = financialYear(new Date(periodEnd.getTime() - 1)).label;
  return paid.some((p) => p.paidAt && financialYear(p.paidAt).label !== fy);
}

/** Gap report C5: the statement a payout's email carries (the payee it was drafted for, its month). */
export async function dealerStatementForBatch(batchId: string): Promise<{ basename: string; csv: string } | null> {
  const [b] = await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.id, batchId));
  if (!b?.periodMonth) return null;
  const statement = await dealerMonthStatement(b.dealerId, b.periodMonth, b.memberId);
  return { basename: `gokesari-commission-${b.periodMonth}`, csv: monthStatementCsv(statement) };
}

/** The months a dealer's page lists: this month so far, then the closed months, newest first. */
export async function statementMonths(now: Date = new Date(), limit = 6): Promise<string[]> {
  const current = todayIn(getEnv().APP_TIMEZONE, now).slice(0, 7);
  const closed = await db.select({ m: dealerCommissionMonths.periodMonth }).from(dealerCommissionMonths).orderBy(desc(dealerCommissionMonths.periodMonth)).limit(limit);
  return [current, ...closed.map((r) => r.m).filter((m) => m !== current)].slice(0, limit);
}

export async function listClosedMonths(limit = 24): Promise<DealerCommissionMonth[]> {
  return db.select().from(dealerCommissionMonths).orderBy(desc(dealerCommissionMonths.periodMonth)).limit(limit);
}

/** A month's statement as CSV: the registrations, the month's entries, the payout. */
export function monthStatementCsv(s: DealerMonthStatement): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const line = (cells: unknown[]) => cells.map(esc).join(",");
  const r = (paise: number) => (paise / 100).toFixed(2);
  const out: string[] = [
    line([`GoKesari dealer commission statement — ${s.label}${s.closed ? "" : " (month in progress)"}`]),
    line(["Payee", s.payee.name]),
    "",
    line(["Summary"]),
    line(["Shops registered", s.totals.registrations]),
    line(["Shops activated (approved)", s.totals.activated]),
    line(["Commission earned (Rs)", r(s.totals.earnedPaise)]),
    line(["Awaiting admin approval (Rs)", r(s.totals.awaitingApprovalPaise)]),
    line(["On hold (Rs)", r(s.totals.heldPaise)]),
    line(["Above the per-shop cap, pending (Rs)", r(s.totals.aboveCapPaise)]),
    line(["Reversed (Rs)", r(s.totals.reversedPaise)]),
    ...s.lines.map((l) => line([`  ${l.label} (Rs)`, r(l.amountPaise)])),
    line(["Payout for the month, gross (Rs)", s.payout ? r(s.payout.totalPaise) : "0.00"]),
    line(["TDS deducted (Rs)", s.payout ? r(s.payout.tdsPaise) : "0.00"]),
    line(["Net paid to your bank (Rs)", s.payout ? r(s.payout.netPaise) : "0.00"]),
    line(["Payout status", s.payout ? `${s.payout.status}${s.payout.paymentReference ? ` (UTR ${s.payout.paymentReference})` : ""}` : "—"]),
    line(["Carried forward, owed back (Rs)", r(s.totals.carriedForwardPaise)]),
    "",
    line(["Shops registered"]),
    line(["Date", "Shop", "Shop ID", "PIN", "Employee", "Counted for you", "Shop status"]),
    ...s.registrations.map((x) => line([x.registeredOn, x.shopName, x.registrationNumber ?? "", x.pincode ?? "", x.employee ?? "", x.attribution === "ACTIVE" ? "Yes" : "Reversed", x.shopStatus])),
    "",
    line(["Commission entries this month"]),
    line(["Date", "Shop", "Milestone", "Type", "Level", "Kind", "Status", "Amount (Rs)", "Note"]),
    ...s.entries.map((e) => line([e.date, e.shopName, e.milestone, COMMISSION_ENTRY_TYPE_LABELS[e.entryType], e.level ?? "", e.kind, e.status, r(e.amountPaise), e.note ?? ""])),
  ];
  if (s.payout) {
    out.push("", line(["Entries in this payout (earlier months' approved entries included)"]), line(["Date", "Shop", "Milestone", "Kind", "Amount (Rs)"]));
    out.push(...s.payout.entries.map((e) => line([e.date, e.shopName, e.milestone, e.kind, r(e.amountPaise)])));
  }
  return out.join("\n");
}
