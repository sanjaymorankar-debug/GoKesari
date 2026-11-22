/**
 * RBAC v2 Phase 6 — Operations Manager monitoring and reports (docs/rbac/06-operations.md).
 *
 *   getShopOnboardingMonitor      shops by status, by franchise zone / dealer / team lead / agent,
 *                                 daily (14 days) and weekly (8 weeks) trends
 *   getCustomerOnboardingMonitor  customers: total, new today / this week, active / inactive,
 *                                 by source (referral, dealer code, Operations-assisted, direct), by zone
 *   getOpsActivityReport          a day or a week (IST) per Operations User and per zone
 *   buildOpsReportWorkbook        all three as one Excel file
 *
 * Read-only and computed from live data when asked (no snapshot table, no cron). All dates are IST.
 * Shop statuses as reported:
 *   pending              PENDING_APPROVAL, documents or fee still outstanding (KYC_PENDING / PAYMENT_PENDING)
 *   underVerification    PENDING_APPROVAL with documents and fee done (VERIFIED), waiting for a decision
 *   autoApproved         approved by the existing auto-approval rule (auto_approved_at set)
 *   manuallyApproved     approved by a person (approved_at set, auto_approved_at not)
 *   active / inactive    APPROVED now / SUSPENDED or INACTIVE now
 */
import ExcelJS from "exceljs";
import { sql, type SQL } from "drizzle-orm";

import { formatIst } from "@/lib/franchise";
import { db } from "@/server/db";
import { requireOps, type OpsActor } from "./access";
import { syncAssistRegistrations } from "./assists";

type Raw = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

export const SHOP_COUNT_KEYS = [
  "total",
  "new",
  "pending",
  "underVerification",
  "autoApproved",
  "manuallyApproved",
  "rejected",
  "active",
  "inactive",
] as const;
export type ShopCountKey = (typeof SHOP_COUNT_KEYS)[number];
export type ShopCounts = Record<ShopCountKey, number>;

export interface ShopBreakdownRow {
  key: string | null;
  label: string;
  counts: ShopCounts;
}

export interface ShopOnboardingMonitor {
  days: number;
  totals: ShopCounts;
  byZone: ShopBreakdownRow[];
  byDealer: ShopBreakdownRow[];
  byTeamLead: ShopBreakdownRow[];
  byAgent: ShopBreakdownRow[];
  daily: { day: string; registered: number; activated: number }[];
  weekly: { weekStarting: string; registered: number; activated: number }[];
  generatedAt: string;
}

const clampDays = (days: number | undefined, def = 30) => Math.min(365, Math.max(1, Math.round(days ?? def)));

/** One row per live (not deleted) shop with its zone, dealer, team lead and agent. */
const SHOP_BASE = sql`
  with s as (
    select s.id, s.status::text as status, s.lifecycle_status::text as lifecycle, s.created_at, s.approved_at, s.auto_approved_at,
           z.zone_id, sa.dealer_id, sp.id as agent_id,
           case when sp.team_role = 'TEAM_LEAD' then sp.id else sp.parent_id end as lead_id
    from shops s
    left join lateral (
      select p.zone_id from franchise_shop_area_periods p
      where p.shop_id = s.id and p.valid_to is null order by p.valid_from desc limit 1
    ) z on true
    left join shop_attributions sa on sa.shop_id = s.id and sa.status = 'ACTIVE'
    left join dealer_salespeople sp on sp.id = sa.salesperson_id
    where s.deleted_at is null
  )`;

function countCols(days: number): SQL {
  return sql`
    count(*)::int as total,
    count(*) filter (where created_at >= now() - make_interval(days => ${days}))::int as new,
    count(*) filter (where status = 'PENDING_APPROVAL' and lifecycle in ('KYC_PENDING','PAYMENT_PENDING'))::int as pending,
    count(*) filter (where status = 'PENDING_APPROVAL' and lifecycle = 'VERIFIED')::int as under_verification,
    count(*) filter (where auto_approved_at is not null)::int as auto_approved,
    count(*) filter (where approved_at is not null and auto_approved_at is null)::int as manually_approved,
    count(*) filter (where status = 'REJECTED')::int as rejected,
    count(*) filter (where status = 'APPROVED')::int as active,
    count(*) filter (where status in ('SUSPENDED','INACTIVE'))::int as inactive`;
}

function toCounts(r: Raw): ShopCounts {
  return {
    total: n(r.total),
    new: n(r.new),
    pending: n(r.pending),
    underVerification: n(r.under_verification),
    autoApproved: n(r.auto_approved),
    manuallyApproved: n(r.manually_approved),
    rejected: n(r.rejected),
    active: n(r.active),
    inactive: n(r.inactive),
  };
}

async function breakdown(days: number, keyCol: SQL, labelJoin: SQL, labelCol: SQL, none: string): Promise<ShopBreakdownRow[]> {
  const rows = (await db.execute(sql`${SHOP_BASE}
    , g as (select ${keyCol} as k, ${countCols(days)} from s group by 1)
    select g.*, ${labelCol} as label from g ${labelJoin}
    order by g.total desc, label nulls last limit 200`)) as unknown as Raw[];
  return rows.map((r) => ({ key: (r.k as string | null) ?? null, label: (r.label as string | null) ?? none, counts: toCounts(r) }));
}

export async function getShopOnboardingMonitor(actor: OpsActor, options: { days?: number } = {}): Promise<ShopOnboardingMonitor> {
  await requireOps(actor, "report");
  const days = clampDays(options.days);
  const [totalsRows, byZone, byDealer, byTeamLead, byAgent, daily, weekly] = await Promise.all([
    db.execute(sql`${SHOP_BASE} select ${countCols(days)} from s`) as unknown as Promise<Raw[]>,
    breakdown(days, sql`zone_id`, sql`left join franchise_zones fz on fz.zone_id = g.k`, sql`fz.name`, "No zone"),
    breakdown(days, sql`dealer_id::text`, sql`left join dealers d on d.id::text = g.k`, sql`d.legal_name`, "No dealer (direct / Operations)"),
    breakdown(days, sql`lead_id::text`, sql`left join dealer_salespeople l on l.id::text = g.k`, sql`l.name`, "No team lead"),
    breakdown(days, sql`agent_id::text`, sql`left join dealer_salespeople a on a.id::text = g.k`, sql`a.name`, "No agent"),
    db.execute(sql`
      with d as (select generate_series((now() at time zone 'Asia/Kolkata')::date - 13, (now() at time zone 'Asia/Kolkata')::date, interval '1 day')::date as day)
      select to_char(d.day, 'YYYY-MM-DD') as day,
        (select count(*) from shops s where s.deleted_at is null and (s.created_at at time zone 'Asia/Kolkata')::date = d.day)::int as registered,
        (select count(*) from shops s where s.deleted_at is null and (s.approved_at at time zone 'Asia/Kolkata')::date = d.day)::int as activated
      from d order by d.day`) as unknown as Promise<Raw[]>,
    db.execute(sql`
      with w as (select generate_series(date_trunc('week', now() at time zone 'Asia/Kolkata')::date - 49, date_trunc('week', now() at time zone 'Asia/Kolkata')::date, interval '7 days')::date as wk)
      select to_char(w.wk, 'YYYY-MM-DD') as wk,
        (select count(*) from shops s where s.deleted_at is null and date_trunc('week', s.created_at at time zone 'Asia/Kolkata')::date = w.wk)::int as registered,
        (select count(*) from shops s where s.deleted_at is null and date_trunc('week', s.approved_at at time zone 'Asia/Kolkata')::date = w.wk)::int as activated
      from w order by w.wk`) as unknown as Promise<Raw[]>,
  ]);
  return {
    days,
    totals: toCounts(totalsRows[0] ?? {}),
    byZone,
    byDealer,
    byTeamLead,
    byAgent,
    daily: daily.map((r) => ({ day: String(r.day), registered: n(r.registered), activated: n(r.activated) })),
    weekly: weekly.map((r) => ({ weekStarting: String(r.wk), registered: n(r.registered), activated: n(r.activated) })),
    generatedAt: formatIst(new Date()),
  };
}

/* ------------------------------------------------------------- customers */

export const CUSTOMER_SOURCES = ["OPERATIONS", "DEALER_CODE", "REFERRAL", "DIRECT"] as const;
export type CustomerSource = (typeof CUSTOMER_SOURCES)[number];

export interface CustomerOnboardingMonitor {
  total: number;
  newToday: number;
  newThisWeek: number;
  active: number;
  inactive: number;
  bySource: { source: CustomerSource; total: number; newThisWeek: number }[];
  byZone: { zoneId: string | null; label: string; total: number; newThisWeek: number }[];
  generatedAt: string;
}

/** Active: an order in the last 90 days. A customer's zone: the franchise zone of their default (else latest) address pincode. */
const CUSTOMER_BASE = sql`
  with c as (
    select u.id, u.created_at,
      exists (select 1 from orders o where o.user_id = u.id and o.created_at >= now() - interval '90 days') as active,
      case
        when exists (select 1 from ops_customer_assists a where a.customer_user_id = u.id) then 'OPERATIONS'
        when exists (select 1 from customer_signup_referrals r where r.user_id = u.id and r.kind = 'GOKESARI') then 'DEALER_CODE'
        when exists (select 1 from customer_signup_referrals r where r.user_id = u.id and r.kind = 'FRIEND') then 'REFERRAL'
        else 'DIRECT'
      end as source,
      (select fa.zone_id from addresses ad
         join franchise_areas fa on ad.pincode = any(fa.pincodes) and fa.zone_id is not null and fa.is_test = false
       where ad.user_id = u.id and ad.deleted_at is null
       order by ad.is_default desc, ad.created_at desc limit 1) as zone_id,
      (u.created_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date as is_today,
      (u.created_at at time zone 'Asia/Kolkata') >= date_trunc('week', now() at time zone 'Asia/Kolkata') as is_week
    from users u
    where u.role = 'CUSTOMER' and u.deleted_at is null
  )`;

export async function getCustomerOnboardingMonitor(actor: OpsActor): Promise<CustomerOnboardingMonitor> {
  await requireOps(actor, "report");
  await syncAssistRegistrations();
  const [[t], src, zones] = await Promise.all([
    db.execute(sql`${CUSTOMER_BASE}
      select count(*)::int as total, count(*) filter (where is_today)::int as today, count(*) filter (where is_week)::int as week,
             count(*) filter (where active)::int as active from c`) as unknown as Promise<Raw[]>,
    db.execute(sql`${CUSTOMER_BASE} select source, count(*)::int as total, count(*) filter (where is_week)::int as week from c group by 1`) as unknown as Promise<Raw[]>,
    db.execute(sql`${CUSTOMER_BASE}
      select c.zone_id, fz.name as label, count(*)::int as total, count(*) filter (where is_week)::int as week
      from c left join franchise_zones fz on fz.zone_id = c.zone_id group by 1, 2 order by 3 desc limit 200`) as unknown as Promise<Raw[]>,
  ]);
  const bySrc = new Map(src.map((r) => [String(r.source), r]));
  return {
    total: n(t?.total),
    newToday: n(t?.today),
    newThisWeek: n(t?.week),
    active: n(t?.active),
    inactive: n(t?.total) - n(t?.active),
    bySource: CUSTOMER_SOURCES.map((s) => ({ source: s, total: n(bySrc.get(s)?.total), newThisWeek: n(bySrc.get(s)?.week) })),
    byZone: zones.map((r) => ({ zoneId: (r.zone_id as string | null) ?? null, label: (r.label as string | null) ?? "No zone", total: n(r.total), newThisWeek: n(r.week) })),
    generatedAt: formatIst(new Date()),
  };
}

/* ------------------------------------------------------ activity (day / week) */

export interface OpsActivityRow {
  key: string | null;
  label: string;
  shopsContacted: number;
  shopsRegistered: number;
  shopsVerified: number;
  shopsActivated: number;
  customersOnboarded: number;
  followUps: number;
  tasksDone: number;
  pendingRegistrations: number;
  unresolved: number;
}

export interface OpsActivityReport {
  period: "day" | "week";
  from: string; // IST date, inclusive
  to: string; // IST date, inclusive
  byUser: OpsActivityRow[];
  byZone: OpsActivityRow[];
  totals: Omit<OpsActivityRow, "key" | "label">;
  generatedAt: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The IST bounds of a day, or of the Monday-to-Sunday week holding `date` (default today). */
export function istPeriod(period: "day" | "week", date?: string): { from: string; to: string } {
  const base = date && ISO_DATE.test(date) ? new Date(`${date}T00:00:00Z`) : new Date(Date.now() + 5.5 * 3600_000);
  const day = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  if (period === "day") {
    const d = day.toISOString().slice(0, 10);
    return { from: d, to: d };
  }
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(day.getTime() - dow * 86400_000);
  const end = new Date(start.getTime() + 6 * 86400_000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

const ACTIVITY_KEYS = [
  "shopsContacted",
  "shopsRegistered",
  "shopsVerified",
  "shopsActivated",
  "customersOnboarded",
  "followUps",
  "tasksDone",
  "pendingRegistrations",
  "unresolved",
] as const;

export async function getOpsActivityReport(actor: OpsActor, options: { period?: "day" | "week"; date?: string } = {}): Promise<OpsActivityReport> {
  await requireOps(actor, "report");
  await syncAssistRegistrations();
  const period = options.period ?? "day";
  const { from, to } = istPeriod(period, options.date);
  // [from, to] as IST calendar dates; compared on the IST date of each timestamp.
  const inRange = (col: SQL) => sql`(${col} at time zone 'Asia/Kolkata')::date between ${from}::date and ${to}::date`;
  const rows = (await db.execute(sql`
    with people as (
      select u.id, u.name from users u where u.role = 'OPERATIONS_USER' and u.deleted_at is null
    ),
    per_user as (
      select p.id::text as k, coalesce(p.name, '—') as label,
        (select count(distinct t.shop_id) from ops_task_events e join ops_tasks t on t.id = e.task_id
           where e.actor_id = p.id and t.shop_id is not null and ${inRange(sql`e.created_at`)})::int as shops_contacted,
        (select count(*) from shops s where s.onboarded_by_user_id = p.id and s.deleted_at is null and ${inRange(sql`s.created_at`)})::int as shops_registered,
        (select count(*) from shops s where s.onboarded_by_user_id = p.id and s.deleted_at is null and s.lifecycle_status::text = 'VERIFIED' and ${inRange(sql`s.updated_at`)})::int as shops_verified,
        (select count(*) from shops s where s.onboarded_by_user_id = p.id and s.deleted_at is null and ${inRange(sql`s.approved_at`)})::int as shops_activated,
        (select count(*) from ops_customer_assists a where a.ops_user_id = p.id and ${inRange(sql`a.registered_at`)})::int as customers_onboarded,
        (select count(*) from ops_task_events e where e.actor_id = p.id and e.action = 'FOLLOW_UP' and ${inRange(sql`e.created_at`)})::int as follow_ups,
        (select count(*) from ops_tasks t where t.assignee_user_id = p.id and t.status = 'DONE' and ${inRange(sql`t.completed_at`)})::int as tasks_done,
        (select count(*) from shops s where s.onboarded_by_user_id = p.id and s.deleted_at is null and s.status = 'PENDING_APPROVAL')::int as pending_registrations,
        (select count(*) from ops_tasks t where t.assignee_user_id = p.id and t.status in ('OPEN','IN_PROGRESS') and t.due_at < now())::int as unresolved
      from people p
    )
    select * from per_user order by shops_registered desc, label`)) as unknown as Raw[];
  const byUser: OpsActivityRow[] = rows.map((r) => ({
    key: String(r.k),
    label: String(r.label),
    shopsContacted: n(r.shops_contacted),
    shopsRegistered: n(r.shops_registered),
    shopsVerified: n(r.shops_verified),
    shopsActivated: n(r.shops_activated),
    customersOnboarded: n(r.customers_onboarded),
    followUps: n(r.follow_ups),
    tasksDone: n(r.tasks_done),
    pendingRegistrations: n(r.pending_registrations),
    unresolved: n(r.unresolved),
  }));
  // Per zone: each user's numbers counted once in every zone they are assigned to.
  const zoneRows = (await db.execute(sql`
    select za.user_id::text as user_id, za.zone_id, fz.name as label
    from ops_zone_assignments za left join franchise_zones fz on fz.zone_id = za.zone_id
    where za.active`)) as unknown as Raw[];
  const byZoneMap = new Map<string, OpsActivityRow>();
  for (const z of zoneRows) {
    const u = byUser.find((x) => x.key === z.user_id);
    if (!u) continue;
    const key = String(z.zone_id);
    const row = byZoneMap.get(key) ?? { key, label: (z.label as string | null) ?? key, ...Object.fromEntries(ACTIVITY_KEYS.map((k) => [k, 0])) } as OpsActivityRow;
    for (const k of ACTIVITY_KEYS) row[k] += u[k];
    byZoneMap.set(key, row);
  }
  const totals = Object.fromEntries(ACTIVITY_KEYS.map((k) => [k, byUser.reduce((sum, r) => sum + r[k], 0)])) as OpsActivityReport["totals"];
  return {
    period,
    from,
    to,
    byUser,
    byZone: [...byZoneMap.values()].sort((a, b) => b.shopsRegistered - a.shopsRegistered),
    totals,
    generatedAt: formatIst(new Date()),
  };
}

/* ---------------------------------------------------------------- Excel */

const SHOP_HEADERS: [ShopCountKey, string][] = [
  ["total", "Total"],
  ["new", "New (window)"],
  ["pending", "Pending"],
  ["underVerification", "Under verification"],
  ["autoApproved", "Auto-approved"],
  ["manuallyApproved", "Manually approved"],
  ["rejected", "Rejected"],
  ["active", "Active"],
  ["inactive", "Inactive"],
];

const ACTIVITY_HEADERS: [(typeof ACTIVITY_KEYS)[number], string][] = [
  ["shopsContacted", "Shops contacted"],
  ["shopsRegistered", "Shops registered"],
  ["shopsVerified", "Shops verified"],
  ["shopsActivated", "Shops activated"],
  ["customersOnboarded", "Customers onboarded"],
  ["followUps", "Follow-ups"],
  ["tasksDone", "Tasks done"],
  ["pendingRegistrations", "Pending registrations (now)"],
  ["unresolved", "Overdue tasks (now)"],
];

function sheet(wb: ExcelJS.Workbook, name: string, header: string[], rows: (string | number)[][]): void {
  const ws = wb.addWorksheet(name);
  ws.addRow(header).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.columns.forEach((c, i) => (c.width = i === 0 ? 34 : 16));
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

/** One Excel file: Activity (by user and zone), Shops (totals, four breakdowns, trends), Customers. */
export async function buildOpsReportWorkbook(
  actor: OpsActor,
  options: { period?: "day" | "week"; date?: string; days?: number } = {},
): Promise<{ filename: string; buffer: Buffer }> {
  await requireOps(actor, "report");
  const [activity, shops, customers] = await Promise.all([
    getOpsActivityReport(actor, options),
    getShopOnboardingMonitor(actor, { days: options.days }),
    getCustomerOnboardingMonitor(actor),
  ]);
  const wb = new ExcelJS.Workbook();
  wb.creator = "GoKesari";
  const act = (rows: OpsActivityRow[]) => rows.map((r) => [r.label, ...ACTIVITY_HEADERS.map(([k]) => r[k])]);
  sheet(wb, "Activity by user", ["Operations User", ...ACTIVITY_HEADERS.map(([, h]) => h)], [
    ...act(activity.byUser),
    ["TOTAL", ...ACTIVITY_HEADERS.map(([k]) => activity.totals[k])],
  ]);
  sheet(wb, "Activity by zone", ["Zone", ...ACTIVITY_HEADERS.map(([, h]) => h)], act(activity.byZone));
  const shopRows = (rows: ShopBreakdownRow[]) => rows.map((r) => [r.label, ...SHOP_HEADERS.map(([k]) => r.counts[k])]);
  sheet(wb, "Shops", ["", ...SHOP_HEADERS.map(([, h]) => h)], [["All shops", ...SHOP_HEADERS.map(([k]) => shops.totals[k])]]);
  sheet(wb, "Shops by zone", ["Zone", ...SHOP_HEADERS.map(([, h]) => h)], shopRows(shops.byZone));
  sheet(wb, "Shops by dealer", ["Dealer", ...SHOP_HEADERS.map(([, h]) => h)], shopRows(shops.byDealer));
  sheet(wb, "Shops by team lead", ["Team lead", ...SHOP_HEADERS.map(([, h]) => h)], shopRows(shops.byTeamLead));
  sheet(wb, "Shops by agent", ["Agent", ...SHOP_HEADERS.map(([, h]) => h)], shopRows(shops.byAgent));
  sheet(wb, "Daily trend", ["Day (IST)", "Registered", "Activated"], shops.daily.map((d) => [d.day, d.registered, d.activated]));
  sheet(wb, "Weekly trend", ["Week starting (IST)", "Registered", "Activated"], shops.weekly.map((d) => [d.weekStarting, d.registered, d.activated]));
  sheet(wb, "Customers", ["Measure", "Count"], [
    ["Total", customers.total],
    ["New today", customers.newToday],
    ["New this week", customers.newThisWeek],
    ["Active (order in 90 days)", customers.active],
    ["Inactive", customers.inactive],
    ...customers.bySource.map((s) => [`Source: ${s.source}`, s.total]),
  ]);
  sheet(wb, "Customers by zone", ["Zone", "Total", "New this week"], customers.byZone.map((z) => [z.label, z.total, z.newThisWeek]));
  const info = wb.addWorksheet("About");
  info.addRow(["GoKesari Operations report"]).font = { bold: true };
  info.addRow([`Period: ${activity.period} ${activity.from} to ${activity.to} (IST)`]);
  info.addRow([`Shop "New" window: last ${shops.days} days`]);
  info.addRow([`Generated: ${activity.generatedAt}`]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { filename: `gokesari-operations-${activity.period}-${activity.from}.xlsx`, buffer };
}
