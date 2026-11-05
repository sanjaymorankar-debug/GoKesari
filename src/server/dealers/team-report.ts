/**
 * Team performance and earnings (owner, 5 Nov 2026; docs/dealer-programme/TIERED_COMMISSION.md):
 * one row per person in a dealer network — main dealer, team leads, agents —
 * with the shops they registered and the commission they earned in a period,
 * side by side, plus their progress towards the monthly target.
 *
 * Read straight from the commission ledger and the shop plans, so the month
 * so far is live: every shop that pays and is approved shows at once. Used by
 * the dealer dashboard (month to date, refreshed on the page), the admin's
 * team view, and the daily and weekly reports (sendTeamReports).
 *
 * Who sees what: the main dealer and an admin the whole network; a team lead
 * himself and his agents; an agent only himself.
 */
import { and, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";

import { addDays, isoWeekday, todayIn, type IsoDate } from "@/lib/dates";
import { NETWORK_ROLE_LABELS, type NetworkRole } from "@/lib/dealer-tiers";
import { notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { dealerCommissionLedger, dealerSalespeople, dealerTierShopPlans, dealers, shopAttributions, users, type DealerSalesperson } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { getFeatureFlag } from "@/server/services/feature-flags";
import { notify } from "@/server/services/notifications";

import { TARGET_BASE_TYPES, bestTarget, targetBonusPaise, targetShopCount, tierRule } from "./tiered";

const ZONE = "Asia/Kolkata";
const OFFSET = "+05:30"; // India has no daylight saving

export type ReportPeriodKind = "DAY" | "WEEK" | "MONTH";

export interface ReportPeriod {
  kind: ReportPeriodKind;
  /** First and last day, inclusive (IST). */
  fromDate: IsoDate;
  toDate: IsoDate;
  /** [from, to) as instants. */
  from: Date;
  to: Date;
  label: string;
}

const dayStart = (d: IsoDate) => new Date(`${d}T00:00:00${OFFSET}`);
const nice = (d: IsoDate) => new Date(`${d}T12:00:00${OFFSET}`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: ZONE }).replace(/ /g, "-");

/**
 * The period a report covers. DAY: yesterday. WEEK: last Monday to Sunday.
 * MONTH: this month so far (the 1st up to now) — the dashboard's view.
 */
export function reportPeriod(kind: ReportPeriodKind, now: Date = new Date()): ReportPeriod {
  const today = todayIn(ZONE, now);
  if (kind === "DAY") {
    const d = addDays(today, -1);
    return { kind, fromDate: d, toDate: d, from: dayStart(d), to: dayStart(today), label: nice(d) };
  }
  if (kind === "WEEK") {
    const thisMonday = addDays(today, -(isoWeekday(today) - 1));
    const from = addDays(thisMonday, -7);
    const to = addDays(thisMonday, -1);
    return { kind, fromDate: from, toDate: to, from: dayStart(from), to: dayStart(thisMonday), label: `${nice(from)} to ${nice(to)}` };
  }
  const first = `${today.slice(0, 7)}-01`;
  return { kind, fromDate: first, toDate: today, from: dayStart(first), to: now, label: `${nice(first)} to ${nice(today)} (so far)` };
}

export interface TargetProgress {
  /** The shops that count: an agent's own, a lead's team's, the main dealer's network — this calendar month. */
  shops: number;
  /** The next target not yet reached (null when the highest is reached or there is none). */
  next: { minShops: number; bonusBp: number; bonusPaise: number; toGo: number } | null;
  /** The highest target reached this month, and the bonus it pays on the commission so far. */
  reached: { minShops: number; bonusBp: number; bonusPaise: number; bonusSoFarPaise: number } | null;
}

export interface TeamReportRow {
  memberId: string | null;
  name: string;
  employeeId: string | null;
  role: NetworkRole;
  level: number;
  parentId: string | null;
  parentName: string | null;
  status: string;
  /** Registrations started with this person's code in the period (not yet paid or approved). */
  started: number;
  /** Shops this person signed that paid and were approved in the period. */
  registered: number;
  /** For a lead: his team's (his own and his agents'); for the main dealer: the network's; for an agent: his own. */
  teamRegistered: number;
  /** Everything earned in the period (direct, overrides, renewals, bonuses), less reversals. */
  commissionPaise: number;
  /** All time: shops signed and commission earned (less reversals). */
  totalShops: number;
  totalCommissionPaise: number;
  /** Paid out so far, all time. */
  paidPaise: number;
  /** This calendar month's target (whatever the period). */
  target: TargetProgress;
}

export interface TeamReport {
  dealer: { id: string; name: string; model: string };
  period: ReportPeriod;
  /** Leads first, each followed by his agents; the main dealer on top. */
  rows: TeamReportRow[];
  totals: { started: number; registered: number; commissionPaise: number };
  generatedAt: Date;
}

/**
 * The report for a dealer network. `viewer`: undefined = everyone (admin, main
 * dealer); a member = what that member may see (a lead: himself and his
 * agents; an agent: himself).
 */
export async function teamReport(dealerId: string, period: ReportPeriod, viewer?: Pick<DealerSalesperson, "id" | "teamRole"> | null): Promise<TeamReport> {
  const [dealer] = await db.select().from(dealers).where(eq(dealers.id, dealerId));
  if (!dealer) throw notFound("Dealer");
  const now = new Date();
  const month = reportPeriod("MONTH", now);
  const rule = await tierRule();
  const inPeriod = (d: Date) => d >= period.from && d < period.to;
  const inMonth = (d: Date) => d >= month.from && d < month.to;

  const [members, plans, started, ledger, monthBase] = await Promise.all([
    db.select().from(dealerSalespeople).where(eq(dealerSalespeople.dealerId, dealerId)),
    db
      .select({ directMemberId: dealerTierShopPlans.directMemberId, leadMemberId: dealerTierShopPlans.leadMemberId, activatedAt: dealerTierShopPlans.activatedAt })
      .from(dealerTierShopPlans)
      .where(and(eq(dealerTierShopPlans.dealerId, dealerId), ne(dealerTierShopPlans.status, "REVERSED"))),
    db
      .select({ member: shopAttributions.salespersonId, n: sql<number>`count(*)::int` })
      .from(shopAttributions)
      .where(and(eq(shopAttributions.dealerId, dealerId), gte(shopAttributions.createdAt, period.from), lt(shopAttributions.createdAt, period.to)))
      .groupBy(shopAttributions.salespersonId),
    db
      .select({
        member: dealerCommissionLedger.payeeMemberId,
        period: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}) filter (where ${dealerCommissionLedger.createdAt} >= ${period.from.toISOString()}::timestamptz and ${dealerCommissionLedger.createdAt} < ${period.to.toISOString()}::timestamptz), 0)::int`,
        total: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}), 0)::int`,
        paid: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}) filter (where ${dealerCommissionLedger.status} = 'PAID'), 0)::int`,
      })
      .from(dealerCommissionLedger)
      .where(and(eq(dealerCommissionLedger.dealerId, dealerId), ne(dealerCommissionLedger.status, "REVERSED")))
      .groupBy(dealerCommissionLedger.payeeMemberId),
    // The target bonus's base: this month's direct and override accruals.
    db
      .select({ member: dealerCommissionLedger.payeeMemberId, total: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}), 0)::int` })
      .from(dealerCommissionLedger)
      .where(
        and(
          eq(dealerCommissionLedger.dealerId, dealerId),
          eq(dealerCommissionLedger.kind, "ACCRUAL"),
          inArray(dealerCommissionLedger.entryType, TARGET_BASE_TYPES),
          ne(dealerCommissionLedger.status, "REVERSED"),
          gte(dealerCommissionLedger.createdAt, month.from),
          lt(dealerCommissionLedger.createdAt, month.to),
        ),
      )
      .groupBy(dealerCommissionLedger.payeeMemberId),
  ]);

  const key = (id: string | null) => id ?? "main";
  const startedBy = new Map(started.map((r) => [key(r.member), r.n]));
  const ledgerBy = new Map(ledger.map((r) => [key(r.member), r]));
  const baseBy = new Map(monthBase.map((r) => [key(r.member), r.total]));
  const periodPlans = plans.filter((p) => inPeriod(p.activatedAt));
  const monthPlans = plans.filter((p) => inMonth(p.activatedAt));
  const byId = new Map(members.map((m) => [m.id, m]));

  const targetFor = (payee: DealerSalesperson | null, role: NetworkRole): TargetProgress => {
    const shops = targetShopCount(monthPlans, payee);
    if (!rule.enabled || !rule.targetBonusesEnabled) return { shops, next: null, reached: null };
    const best = bestTarget(rule.targets, role, shops);
    const next = rule.targets.filter((t) => t.role === role && t.minShops > shops).sort((a, b) => a.minShops - b.minShops)[0] ?? null;
    return {
      shops,
      next: next ? { minShops: next.minShops, bonusBp: next.bonusBp, bonusPaise: next.bonusPaise, toGo: next.minShops - shops } : null,
      reached: best ? { minShops: best.minShops, bonusBp: best.bonusBp, bonusPaise: best.bonusPaise, bonusSoFarPaise: targetBonusPaise(best, baseBy.get(key(payee?.id ?? null)) ?? 0) } : null,
    };
  };

  const rowFor = (m: DealerSalesperson | null): TeamReportRow => {
    const id = m?.id ?? null;
    const role: NetworkRole = m ? m.teamRole : "MAIN_DEALER";
    const own = (list: typeof plans) => (m ? list.filter((p) => p.directMemberId === m.id).length : list.filter((p) => p.directMemberId === null).length);
    const l = ledgerBy.get(key(id));
    const parent = m?.parentId ? byId.get(m.parentId) : null;
    return {
      memberId: id,
      name: m ? m.name : dealer.legalName,
      employeeId: m ? m.employeeId : null,
      role,
      level: m ? m.depth : 1,
      parentId: m?.parentId ?? null,
      parentName: m ? (parent?.name ?? dealer.legalName) : null,
      status: m ? m.status : dealer.status,
      started: startedBy.get(key(id)) ?? 0,
      registered: own(periodPlans),
      teamRegistered: targetShopCount(periodPlans, m),
      commissionPaise: l?.period ?? 0,
      totalShops: own(plans),
      totalCommissionPaise: l?.total ?? 0,
      paidPaise: l?.paid ?? 0,
      target: targetFor(m, role),
    };
  };

  // Order: main dealer, then each level-2 member followed by his agents.
  let ordered: (DealerSalesperson | null)[] = [null];
  const top = members.filter((m) => m.depth === 2).sort((a, b) => a.name.localeCompare(b.name));
  for (const t of top) ordered.push(t, ...members.filter((a) => a.parentId === t.id).sort((a, b) => a.name.localeCompare(b.name)));
  if (viewer) {
    ordered = viewer.teamRole === "TEAM_LEAD" ? ordered.filter((m) => m && (m.id === viewer.id || m.parentId === viewer.id)) : ordered.filter((m) => m?.id === viewer.id);
  }
  const rows = ordered.map(rowFor);
  return {
    dealer: { id: dealer.id, name: dealer.legalName, model: dealer.commissionModel },
    period,
    rows,
    totals: rows.reduce((s, r) => ({ started: s.started + r.started, registered: s.registered + r.registered, commissionPaise: s.commissionPaise + r.commissionPaise }), { started: 0, registered: 0, commissionPaise: 0 }),
    generatedAt: now,
  };
}

const rupees = (paise: number) => (paise / 100).toFixed(2);
const csvCell = (v: string | number | null) => {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The report as CSV (opens in Excel): one line per person. */
export function teamReportCsv(report: TeamReport): string {
  const head = [
    "Name",
    "Employee ID",
    "Role",
    "Level",
    "Reports to",
    "Registrations started",
    "Shops registered (own)",
    "Shops registered (team)",
    "Commission earned (Rs)",
    "Shops this month (target count)",
    "Target reached",
    "Target bonus so far (Rs)",
    "Shops to next target",
    "Total shops",
    "Total commission (Rs)",
    "Paid out (Rs)",
  ];
  const lines = report.rows.map((r) =>
    [
      r.name,
      r.employeeId,
      NETWORK_ROLE_LABELS[r.role],
      r.level,
      r.parentName,
      r.started,
      r.registered,
      r.teamRegistered,
      rupees(r.commissionPaise),
      r.target.shops,
      r.target.reached ? `${r.target.reached.minShops} shops` : "",
      r.target.reached ? rupees(r.target.reached.bonusSoFarPaise) : "",
      r.target.next ? r.target.next.toGo : "",
      r.totalShops,
      rupees(r.totalCommissionPaise),
      rupees(r.paidPaise),
    ]
      .map(csvCell)
      .join(","),
  );
  return [`${csvCell(report.dealer.name)} — ${csvCell(report.period.label)}`, head.join(","), ...lines].join("\n") + "\n";
}

/* ======================================================= daily / weekly reports */

const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const PERIOD_WORD: Record<ReportPeriodKind, string> = { DAY: "Daily", WEEK: "Weekly", MONTH: "Monthly" };

/** One e-mail line per person: "Asha (Agent): 3 started, 2 registered, ₹1,999.60 — month 12/50". */
function reportLines(report: TeamReport) {
  return report.rows.map((r) => ({
    label: `${r.name} (${NETWORK_ROLE_LABELS[r.role]}${r.parentName ? `, under ${r.parentName}` : ""})`,
    value:
      `${r.started} started, ${r.registered} registered${r.role !== "AGENT" ? ` (team ${r.teamRegistered})` : ""}, ${inr(r.commissionPaise)}` +
      (r.target.next || r.target.reached ? ` — this month ${r.target.shops}${r.target.next ? `/${r.target.next.minShops}` : " (target reached)"}` : ""),
  }));
}

/**
 * The daily (yesterday) or weekly (last Monday–Sunday) team report: to every
 * approved dealer's main dealer (whole network) and each team lead with an
 * account (his team), and one summary to the admins. Only when something
 * happened in the period. In-app and e-mail; once per person and period.
 * Run by the cron (05:00 IST: DAY every day, WEEK on Mondays).
 */
export async function sendTeamReports(kind: Exclude<ReportPeriodKind, "MONTH">, now: Date = new Date()): Promise<{ dealers: number; sent: number } | { skipped: string }> {
  if (!(await getFeatureFlag("dealer_programme_enabled")).enabled) return { skipped: "dealer programme off" };
  const period = reportPeriod(kind, now);
  const list = await db.select().from(dealers).where(and(eq(dealers.status, "APPROVED"), eq(dealers.isInternal, false)));
  let sent = 0;
  const summary: { label: string; value: string }[] = [];
  const all = { started: 0, registered: 0 };
  const send = async (userId: string, report: TeamReport, scope: string) => {
    await notify({
      userId,
      type: NOTIFICATION_TYPES.DEALER_TEAM_REPORT,
      vars: {
        period: PERIOD_WORD[kind],
        label: `${report.period.label} — ${scope}`,
        started: report.totals.started,
        registered: report.totals.registered,
        commission: inr(report.totals.commissionPaise),
      },
      actionUrl: "/dealer#team-performance",
      channels: ["EMAIL"],
      emailDetail: reportLines(report),
      dedupeKey: `dealer-team-report:${kind}:${period.fromDate}:${scope}:${userId}`,
    });
    sent += 1;
  };
  const active = (r: TeamReport) => r.totals.started + r.totals.registered > 0 || r.totals.commissionPaise !== 0;
  for (const dealer of list) {
    const report = await teamReport(dealer.id, period);
    if (!active(report)) continue;
    all.started += report.totals.started;
    all.registered += report.totals.registered;
    summary.push({ label: dealer.legalName, value: `${report.totals.started} started, ${report.totals.registered} registered, ${inr(report.totals.commissionPaise)}` });
    if (dealer.userId) await send(dealer.userId, report, dealer.legalName);
    const leads = await db.select().from(dealerSalespeople).where(and(eq(dealerSalespeople.dealerId, dealer.id), eq(dealerSalespeople.teamRole, "TEAM_LEAD"), eq(dealerSalespeople.status, "ACTIVE")));
    for (const lead of leads) {
      if (!lead.userId) continue;
      const mine = await teamReport(dealer.id, period, lead);
      if (active(mine)) await send(lead.userId, mine, `${lead.name}'s team`);
    }
  }
  if (summary.length > 0) {
    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "ADMIN"), eq(users.status, "ACTIVE"), isNull(users.deletedAt)));
    for (const admin of admins) {
      await notify({
        userId: admin.id,
        type: NOTIFICATION_TYPES.DEALER_TEAM_REPORT,
        title: `${PERIOD_WORD[kind]} dealer report: ${all.registered} shops registered`,
        body: `${period.label}: ${all.started} registrations started and ${all.registered} shops registered across ${summary.length} dealers. Each team's numbers: Admin → Dealers → Commission → TIERED model → Team performance.`,
        actionUrl: "/admin/dealers/commission/tiered",
        channels: ["EMAIL"],
        emailDetail: summary,
        dedupeKey: `dealer-team-report:${kind}:${period.fromDate}:admin:${admin.id}`,
      });
      sent += 1;
    }
  }
  return { dealers: summary.length, sent };
}
