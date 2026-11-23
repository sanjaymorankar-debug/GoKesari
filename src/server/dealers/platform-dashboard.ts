/**
 * Dealership & Franchise Platform phase 6 (owner brief 23-Nov-2026 §12; docs/dealer-platform/): the admin dashboard
 * over the shared dealer, scheme, shop, ledger and payout records.
 *
 * Filters: date range (registrations, sales, commission), scheme, dealer, state / district / city, dealer status,
 * shop status. A Regional Admin sees only his regions. Money in paise. GMV is sales through GoKesari, not revenue;
 * platform revenue here = GoKesari's commission on those sales + shop registration fees + dealers' joining charges
 * (before GST); commission liability = earned or approved and not yet paid.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { stateCodeFromName } from "@/lib/indian-states";
import { db } from "@/server/db";
import type { DealerStatus } from "@/lib/dealers";
import { dealers, dealerSchemeAssignments, dealerSchemes, dealerTerritories } from "@/server/db/schema";

import { regionScope, type StaffActor } from "./staff-access";

export interface DashboardFilters {
  from: string; // YYYY-MM-DD (IST)
  to: string; // YYYY-MM-DD inclusive (IST)
  scheme?: string | null; // scheme code
  dealerId?: string | null;
  state?: string | null; // state code, e.g. MH
  district?: string | null; // district code, e.g. MH-PUN
  city?: string | null;
  dealerStatus?: DealerStatus | null;
  shopStatus?: "ACTIVATED" | "NOT_ACTIVATED" | null;
}

export interface DashboardData {
  filters: DashboardFilters;
  dealers: { total: number; byStatus: Record<string, number>; free: number; paid: number; franchise: number; byScheme: { code: string; name: string; category: string; dealers: number }[]; registrationsByMonth: { month: string; count: number }[]; activeEarning: number };
  shops: { onboarded: number; activated: number; topDealers: { dealerId: string; name: string; scheme: string | null; shops: number; activated: number }[] };
  money: { gmvPaise: number; platformCommissionPaise: number; registrationFeesPaise: number; joiningChargesPaise: number; platformRevenuePaise: number; commissionAccruedPaise: number; recurringPaise: number; paidPaise: number; liabilityPaise: number; pendingSettlementPaise: number; netRevenuePaise: number };
  territory: { zones: number; capacity: number; occupied: number; utilisationBp: number };
  schemes: { code: string; name: string; dealers: number; shops: number; activated: number; commissionPaise: number }[];
}

const n = (v: unknown) => Number(v ?? 0);

/** The dealers the filters (and the actor's regions) select, with their current scheme. */
async function selectedDealers(actor: StaffActor, f: DashboardFilters) {
  const rows = await db
    .select({ d: dealers, scheme: dealerSchemes.code, schemeName: dealerSchemes.name, category: dealerSchemes.category })
    .from(dealers)
    .leftJoin(dealerSchemeAssignments, and(eq(dealerSchemeAssignments.dealerId, dealers.id), eq(dealerSchemeAssignments.status, "ACTIVE")))
    .leftJoin(dealerSchemes, eq(dealerSchemes.id, dealerSchemeAssignments.schemeId))
    .where(and(eq(dealers.isInternal, false), f.dealerStatus ? eq(dealers.status, f.dealerStatus) : undefined, f.dealerId ? eq(dealers.id, f.dealerId) : undefined, f.scheme ? eq(dealerSchemes.code, f.scheme) : undefined));
  const ids = rows.map((r) => r.d.id);
  const areas = ids.length ? await db.select().from(dealerTerritories).where(inArray(dealerTerritories.dealerId, ids)) : [];
  const areasOf = new Map<string, string[]>();
  for (const a of areas) areasOf.set(a.dealerId, [...(areasOf.get(a.dealerId) ?? []), a.areaCode]);
  const scope = await regionScope(actor);
  const inCodes = (r: (typeof rows)[number], codes: readonly string[]) => {
    const st = stateCodeFromName(r.d.state);
    return (st != null && codes.includes(st)) || (areasOf.get(r.d.id) ?? []).some((a) => codes.some((c) => a === c || a.startsWith(`${c}-`)));
  };
  return rows.filter((r) => {
    if (scope && !inCodes(r, scope)) return false;
    if (f.state && stateCodeFromName(r.d.state) !== f.state.toUpperCase() && !(areasOf.get(r.d.id) ?? []).some((a) => a.startsWith(`${f.state!.toUpperCase()}-`))) return false;
    if (f.district && !(areasOf.get(r.d.id) ?? []).some((a) => a === f.district || a.startsWith(`${f.district}-`))) return false;
    if (f.city && (r.d.city ?? "").trim().toLowerCase() !== f.city.trim().toLowerCase()) return false;
    return true;
  });
}

export async function platformDashboard(actor: StaffActor, f: DashboardFilters): Promise<DashboardData> {
  const from = `${f.from}T00:00:00+05:30`;
  const toExclusive = new Date(new Date(`${f.to}T00:00:00+05:30`).getTime() + 86_400_000).toISOString();
  const rows = await selectedDealers(actor, f);
  const ids = rows.map((r) => r.d.id);
  const idList = ids.length ? sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `) : sql`NULL::uuid`;
  const shopFilter = f.shopStatus === "ACTIVATED" ? sql`and a.activated_at is not null` : f.shopStatus === "NOT_ACTIVATED" ? sql`and a.activated_at is null` : sql``;

  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.d.status] = (byStatus[r.d.status] ?? 0) + 1;
  const schemeMap = new Map<string, { code: string; name: string; category: string; dealers: number }>();
  let free = 0;
  let paid = 0;
  let franchise = 0;
  for (const r of rows) {
    const code = r.scheme ?? "NONE";
    const e = schemeMap.get(code) ?? { code, name: r.schemeName ?? "No scheme", category: r.category ?? "—", dealers: 0 };
    e.dealers += 1;
    schemeMap.set(code, e);
    if (r.category === "FRANCHISE") franchise += 1;
    else if (r.scheme === "FREE" || !r.scheme) free += 1;
    else paid += 1;
  }

  const [shops] = (await db.execute(sql`
    select count(*)::int as onboarded, count(a.activated_at)::int as activated
    from shop_attributions a where a.status = 'ACTIVE' and a.dealer_id in (${idList}) ${shopFilter}`)) as unknown as { onboarded: number; activated: number }[];
  const top = (await db.execute(sql`
    select a.dealer_id, count(*)::int as shops, count(a.activated_at)::int as activated
    from shop_attributions a where a.status = 'ACTIVE' and a.dealer_id in (${idList}) ${shopFilter}
    group by a.dealer_id order by count(*) desc limit 20`)) as unknown as { dealer_id: string; shops: number; activated: number }[];
  const nameOf = new Map(rows.map((r) => [r.d.id, { name: r.d.legalName, scheme: r.schemeName ?? null }]));

  const [money] = (await db.execute(sql`
    select
      coalesce((select sum(o.gmv_paise) from order_financials o join shop_attributions a on a.shop_id = o.shop_id and a.status = 'ACTIVE'
        where a.dealer_id in (${idList}) ${shopFilter} and o.delivered_at >= ${from}::timestamptz and o.delivered_at < ${toExclusive}::timestamptz), 0) as gmv,
      coalesce((select sum(o.commission_paise) from order_financials o join shop_attributions a on a.shop_id = o.shop_id and a.status = 'ACTIVE'
        where a.dealer_id in (${idList}) ${shopFilter} and o.delivered_at >= ${from}::timestamptz and o.delivered_at < ${toExclusive}::timestamptz), 0) as commission,
      coalesce((select sum(coalesce(s.registration_fee_base_paise, 0) - coalesce(s.registration_fee_discount_paise, 0)) from shops s join shop_attributions a on a.shop_id = s.id and a.status = 'ACTIVE'
        where a.dealer_id in (${idList}) ${shopFilter} and s.fee_payment_status = 'PAID' and a.created_at >= ${from}::timestamptz and a.created_at < ${toExclusive}::timestamptz), 0) as fees,
      coalesce((select sum(j.base_paise) from dealer_joining_payments j where j.dealer_id in (${idList}) and j.status = 'PAID' and j.paid_at >= ${from}::timestamptz and j.paid_at < ${toExclusive}::timestamptz), 0) as joining,
      coalesce((select sum(l.amount_paise) from dealer_commission_ledger l where l.dealer_id in (${idList}) and l.status <> 'REVERSED' and l.created_at >= ${from}::timestamptz and l.created_at < ${toExclusive}::timestamptz), 0) as accrued,
      coalesce((select sum(l.amount_paise) from dealer_commission_ledger l where l.dealer_id in (${idList}) and l.status <> 'REVERSED' and l.entry_type in ('SCHEME_RECURRING', 'RECURRING_BASE', 'RECURRING_BONUS', 'SCHEME_BONUS') and l.created_at >= ${from}::timestamptz and l.created_at < ${toExclusive}::timestamptz), 0) as recurring,
      coalesce((select sum(l.amount_paise) from dealer_commission_ledger l where l.dealer_id in (${idList}) and l.status = 'PAID' and l.created_at >= ${from}::timestamptz and l.created_at < ${toExclusive}::timestamptz), 0) as paid,
      coalesce((select sum(l.amount_paise) from dealer_commission_ledger l where l.dealer_id in (${idList}) and l.status in ('EARNED', 'APPROVED', 'ON_HOLD', 'PENDING')), 0) as liability,
      coalesce((select sum(b.total_paise) from dealer_payout_batches b where b.dealer_id in (${idList}) and b.status in ('DRAFT', 'APPROVED', 'PROCESSING')), 0) as pending
  `)) as unknown as Record<string, unknown>[];

  const regs = (await db.execute(sql`
    select to_char(d.created_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month, count(*)::int as count
    from dealers d where d.id in (${idList}) and d.created_at >= ${from}::timestamptz and d.created_at < ${toExclusive}::timestamptz
    group by 1 order by 1`)) as unknown as { month: string; count: number }[];
  const [earning] = (await db.execute(sql`
    select count(distinct l.dealer_id)::int as n from dealer_commission_ledger l
    where l.dealer_id in (${idList}) and l.kind = 'ACCRUAL' and l.status <> 'REVERSED' and l.created_at >= now() - interval '90 days'`)) as unknown as { n: number }[];
  const [territory] = (await db.execute(sql`
    select count(*)::int as zones, coalesce(sum(z.max_owners), 0)::int as capacity,
      (select count(*)::int from franchise_allocations fa where not fa.is_test and fa.status in ('RESERVED', 'PAYMENT_PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED')) as occupied
    from franchise_zones z where not z.is_test and z.status <> 'INACTIVE'`)) as unknown as { zones: number; capacity: number; occupied: number }[];
  const perScheme = (await db.execute(sql`
    select s.code, s.name,
      count(distinct asg.dealer_id)::int as dealers,
      count(distinct a.shop_id)::int as shops,
      count(distinct a.shop_id) filter (where a.activated_at is not null)::int as activated,
      coalesce((select sum(l.amount_paise) from dealer_commission_ledger l join dealer_scheme_assignments x on x.dealer_id = l.dealer_id and x.status = 'ACTIVE'
        where x.scheme_id = s.id and l.dealer_id in (${idList}) and l.status <> 'REVERSED' and l.created_at >= ${from}::timestamptz and l.created_at < ${toExclusive}::timestamptz), 0) as commission
    from dealer_schemes s
    left join dealer_scheme_assignments asg on asg.scheme_id = s.id and asg.status = 'ACTIVE' and asg.dealer_id in (${idList})
    left join shop_attributions a on a.dealer_id = asg.dealer_id and a.status = 'ACTIVE'
    group by s.id, s.code, s.name, s.sort_order order by s.sort_order`)) as unknown as { code: string; name: string; dealers: number; shops: number; activated: number; commission: string | number }[];

  const gmv = n(money.gmv);
  const commission = n(money.commission);
  const revenue = commission + n(money.fees) + n(money.joining);
  const accrued = n(money.accrued);
  return {
    filters: f,
    dealers: { total: rows.length, byStatus, free, paid, franchise, byScheme: [...schemeMap.values()], registrationsByMonth: regs.map((r) => ({ month: r.month, count: n(r.count) })), activeEarning: n(earning?.n) },
    shops: { onboarded: n(shops?.onboarded), activated: n(shops?.activated), topDealers: top.map((t) => ({ dealerId: t.dealer_id, name: nameOf.get(t.dealer_id)?.name ?? "—", scheme: nameOf.get(t.dealer_id)?.scheme ?? null, shops: n(t.shops), activated: n(t.activated) })) },
    money: { gmvPaise: gmv, platformCommissionPaise: commission, registrationFeesPaise: n(money.fees), joiningChargesPaise: n(money.joining), platformRevenuePaise: revenue, commissionAccruedPaise: accrued, recurringPaise: n(money.recurring), paidPaise: n(money.paid), liabilityPaise: n(money.liability), pendingSettlementPaise: n(money.pending), netRevenuePaise: revenue - accrued },
    territory: { zones: n(territory?.zones), capacity: n(territory?.capacity), occupied: n(territory?.occupied), utilisationBp: n(territory?.capacity) ? Math.round((n(territory?.occupied) * 10_000) / n(territory?.capacity)) : 0 },
    schemes: perScheme.map((s) => ({ code: s.code, name: s.name, dealers: n(s.dealers), shops: n(s.shops), activated: n(s.activated), commissionPaise: n(s.commission) })),
  };
}

/** The dashboard's dealer rows as CSV (same filters). */
export async function platformDashboardCsv(actor: StaffActor, f: DashboardFilters): Promise<string> {
  const d = await platformDashboard(actor, f);
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [["Section", "Item", "Value"].join(",")];
  const add = (section: string, item: string, value: unknown) => lines.push([section, item, value].map(esc).join(","));
  add("Filters", "From", f.from);
  add("Filters", "To", f.to);
  for (const [k, v] of Object.entries(d.dealers.byStatus)) add("Dealers by status", k, v);
  for (const s of d.dealers.byScheme) add("Dealers by scheme", s.name, s.dealers);
  for (const r of d.dealers.registrationsByMonth) add("Registrations by month", r.month, r.count);
  add("Shops", "Onboarded", d.shops.onboarded);
  add("Shops", "Activated", d.shops.activated);
  for (const [k, v] of Object.entries(d.money)) add("Money (₹)", k.replace(/Paise$/, ""), (v / 100).toFixed(2));
  add("Territory", "Zones", d.territory.zones);
  add("Territory", "Occupied / capacity", `${d.territory.occupied} / ${d.territory.capacity}`);
  for (const s of d.schemes) add("Scheme performance", s.name, `${s.dealers} dealers, ${s.shops} shops, ${s.activated} activated, ₹${(s.commissionPaise / 100).toFixed(2)} commission`);
  for (const t of d.shops.topDealers) add("Dealer-wise shops", t.name, `${t.shops} shops, ${t.activated} activated`);
  return lines.join("\n") + "\n";
}
