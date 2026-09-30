/**
 * Fraud / risk rules and review queue (GS-068).
 *
 * `runRiskRules()` evaluates every rule against recent activity and raises
 * (or refreshes) one OPEN flag per subject and rule. Operations reviews the
 * queue and DISMISSES a false positive or records the ACTION taken (a
 * suspension, a call, a refund refused...). Flags never act on their own,
 * with one exception: an OPEN HIGH flag on a customer pauses cash on
 * delivery (cod.ts). Thresholds are defaults pending business confirmation.
 *
 * Rules
 *  USER              COD_REFUSALS          HIGH    2+ COD orders failed / returned in 90 days
 *  USER              HIGH_REFUND_RATE      MEDIUM  3+ refunded orders and ≥ 50% of orders in 30 days
 *  USER              REPEATED_DISPUTES     MEDIUM  2+ disputed orders in 30 days
 *  USER              TOPUP_FAILURES        MEDIUM  5+ failed wallet top-ups in 24 hours
 *  USER              SHARED_PHONE          LOW     the same mobile number on 2+ active accounts
 *  USER              HIGH_VALUE_OUTLIER    MEDIUM  an order in 7 days ≥ ₹2,000 and ≥ 5× the customer's average over the 90 days
 *                                                  before it (3+ orders then), or ≥ ₹10,000 with fewer than 3 orders then.
 *                                                  PERSONAL + DIRECT orders only (B2B stock buying and subscription runs
 *                                                  excluded, also from the average); PENDING / PAYMENT_FAILED /
 *                                                  WALLET_INSUFFICIENT ignored; value = total + already refunded; an order
 *                                                  already listed on a reviewed flag is not raised again
 *  DELIVERY_PARTNER  OTP_OVERRIDES         MEDIUM  3+ deliveries confirmed by operations override in 30 days
 *  DELIVERY_PARTNER  OTP_LOCKOUTS          MEDIUM  2+ deliveries with the OTP attempts used up in 30 days
 *  DELIVERY_PARTNER  FAILED_DELIVERIES     MEDIUM  3+ failed deliveries in 7 days
 *  DELIVERY_PARTNER  COD_CASH_OVERDUE      HIGH    COD cash held for more than 7 days
 *  SHOP              HIGH_REJECTION        MEDIUM  shop cancelled ≥ 30% of 10+ orders in 30 days
 *  SHOP              COD_CASH_OVERDUE      HIGH    COD cash held for more than 7 days
 */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  deliveryPartners,
  riskFlags,
  shops,
  users,
  type RiskFlag,
  type RiskFlagStatus,
  type RiskSeverity,
  type RiskSubject,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { findAdminUserIds } from "./users";

interface Actor {
  id: string;
  role: UserRole;
}

interface Hit {
  subjectId: string;
  detail: Record<string, unknown>;
  summary: string;
}

interface Rule {
  code: string;
  subject: RiskSubject;
  severity: RiskSeverity;
  label: string;
  query: SQL;
  describe: (row: Record<string, unknown>) => string;
}

const RULES: Rule[] = [
  {
    code: "COD_REFUSALS",
    subject: "USER",
    severity: "HIGH",
    label: "Refused / failed cash-on-delivery orders",
    query: sql`select o.user_id as subject_id, count(distinct o.id)::int as count
      from orders o join order_status_history h on h.order_id = o.id
      where o.payment_method = 'COD' and h.new_status in ('FAILED', 'RETURNED') and h.created_at > now() - interval '90 days'
      group by o.user_id having count(distinct o.id) >= 2`,
    describe: (r) => `${r.count} cash-on-delivery orders failed or returned in 90 days`,
  },
  {
    code: "HIGH_REFUND_RATE",
    subject: "USER",
    severity: "MEDIUM",
    label: "High refund rate",
    query: sql`select o.user_id as subject_id, count(*) filter (where o.refunded_paise > 0 or o.status = 'REFUNDED')::int as count,
        count(*)::int as orders
      from orders o
      where o.created_at > now() - interval '30 days'
        and exists (select 1 from order_status_history h where h.order_id = o.id and h.new_status = 'CONFIRMED')
      group by o.user_id
      having count(*) filter (where o.refunded_paise > 0 or o.status = 'REFUNDED') >= 3
        and count(*) filter (where o.refunded_paise > 0 or o.status = 'REFUNDED') * 2 >= count(*)`,
    describe: (r) => `${r.count} of ${r.orders} orders refunded in 30 days`,
  },
  {
    code: "REPEATED_DISPUTES",
    subject: "USER",
    severity: "MEDIUM",
    label: "Repeated disputes",
    query: sql`select o.user_id as subject_id, count(distinct o.id)::int as count
      from orders o join order_status_history h on h.order_id = o.id
      where h.new_status = 'DISPUTED' and h.created_at > now() - interval '30 days'
      group by o.user_id having count(distinct o.id) >= 2`,
    describe: (r) => `${r.count} orders disputed in 30 days`,
  },
  {
    code: "TOPUP_FAILURES",
    subject: "USER",
    severity: "MEDIUM",
    label: "Repeated failed wallet top-ups",
    query: sql`select p.user_id as subject_id, count(*)::int as count from payments p
      where p.status = 'FAILED' and p.created_at > now() - interval '24 hours'
      group by p.user_id having count(*) >= 5`,
    describe: (r) => `${r.count} failed wallet top-ups in 24 hours`,
  },
  {
    code: "SHARED_PHONE",
    subject: "USER",
    severity: "LOW",
    label: "Mobile number shared by several accounts",
    query: sql`select u.id as subject_id, x.accounts::int as count from users u
      join (select phone, count(*) as accounts from users
            where phone is not null and status = 'ACTIVE' and deleted_at is null
            group by phone having count(*) >= 2) x on x.phone = u.phone
      where u.status = 'ACTIVE' and u.deleted_at is null`,
    describe: (r) => `Mobile number used by ${r.count} active accounts`,
  },
  {
    code: "HIGH_VALUE_OUTLIER",
    subject: "USER",
    severity: "MEDIUM",
    label: "Unusually large order",
    query: sql`with candidate as (
        select o.id, o.user_id, o.order_number, o.created_at, o.total_paise + o.refunded_paise as value_paise
        from orders o
        where o.created_at > now() - interval '7 days'
          and o.order_type = 'PERSONAL' and o.source = 'DIRECT'
          and o.status not in ('PENDING', 'PAYMENT_FAILED', 'WALLET_INSUFFICIENT')
          and o.total_paise + o.refunded_paise >= 200000
          and not exists (
            select 1 from risk_flags f
            where f.subject_type = 'USER' and f.subject_id = o.user_id and f.rule_code = 'HIGH_VALUE_OUTLIER'
              and f.status <> 'OPEN'
              and strpos('; ' || coalesce(f.details->>'orders', ''), '; ' || o.order_number || ' for ') > 0
          )
      ), scored as (
        select c.*, b.prior_orders, b.avg_paise
        from candidate c
        cross join lateral (
          select count(*)::int as prior_orders, avg(p.total_paise + p.refunded_paise) as avg_paise
          from orders p
          where p.user_id = c.user_id and p.id <> c.id
            and p.created_at < c.created_at and p.created_at >= c.created_at - interval '90 days'
            and p.order_type = 'PERSONAL' and p.source = 'DIRECT'
            and p.status not in ('PENDING', 'PAYMENT_FAILED', 'WALLET_INSUFFICIENT')
        ) b
      )
      select s.user_id as subject_id, count(*)::int as count, max(s.value_paise)::bigint as largest_paise,
        string_agg(
          s.order_number || ' for ₹' || to_char(s.value_paise / 100.0, 'FM999999999990.00') || ' (' ||
            case
              when s.prior_orders >= 3 then
                coalesce(to_char(s.value_paise / nullif(s.avg_paise, 0), 'FM999999999990.0') || '× ', 'far above ') ||
                'their 90-day average of ₹' || to_char(s.avg_paise / 100.0, 'FM999999999990.00')
              when s.prior_orders = 0 then 'no earlier orders in 90 days'
              when s.prior_orders = 1 then 'only 1 earlier order in 90 days'
              else 'only ' || s.prior_orders::text || ' earlier orders in 90 days'
            end || ')',
          '; ' order by s.created_at desc) as orders
      from scored s
      where (s.prior_orders >= 3 and s.value_paise >= 5 * s.avg_paise)
         or (s.prior_orders < 3 and s.value_paise >= 1000000)
      group by s.user_id`,
    describe: (r) =>
      `${Number(r.count) === 1 ? "An order" : `${r.count} orders`} in the last 7 days unusually large for this customer: ${r.orders}`,
  },
  {
    code: "OTP_OVERRIDES",
    subject: "DELIVERY_PARTNER",
    severity: "MEDIUM",
    label: "Many deliveries confirmed without the customer's code",
    query: sql`select d.delivery_partner_id as subject_id, count(*)::int as count from delivery_orders d
      where d.delivery_confirmation = 'OPERATOR_OVERRIDE' and d.delivered_at > now() - interval '30 days'
      group by d.delivery_partner_id having count(*) >= 3`,
    describe: (r) => `${r.count} deliveries confirmed by operations override in 30 days`,
  },
  {
    code: "OTP_LOCKOUTS",
    subject: "DELIVERY_PARTNER",
    severity: "MEDIUM",
    label: "Delivery codes repeatedly entered wrong",
    query: sql`select d.delivery_partner_id as subject_id, count(*)::int as count from delivery_orders d
      where d.delivery_otp_attempts >= 5 and d.updated_at > now() - interval '30 days'
      group by d.delivery_partner_id having count(*) >= 2`,
    describe: (r) => `${r.count} deliveries with all delivery-code attempts used in 30 days`,
  },
  {
    code: "FAILED_DELIVERIES",
    subject: "DELIVERY_PARTNER",
    severity: "MEDIUM",
    label: "Many failed deliveries",
    query: sql`select d.delivery_partner_id as subject_id, count(*)::int as count from delivery_orders d
      where d.status = 'FAILED' and d.failed_at > now() - interval '7 days'
      group by d.delivery_partner_id having count(*) >= 3`,
    describe: (r) => `${r.count} failed deliveries in 7 days`,
  },
  {
    code: "COD_CASH_OVERDUE",
    subject: "DELIVERY_PARTNER",
    severity: "HIGH",
    label: "Cash-on-delivery cash not handed over",
    query: sql`select a.delivery_partner_id as subject_id, (-sum(a.amount_paise))::bigint as held,
        min(a.created_at) filter (where a.type = 'COD_CASH_COLLECTED') as oldest
      from financial_adjustments a
      where a.party = 'RIDER' and a.status = 'PENDING' and a.type in ('COD_CASH_COLLECTED', 'COD_CASH_DEPOSITED')
      group by a.delivery_partner_id
      having -sum(a.amount_paise) > 0
        and min(a.created_at) filter (where a.type = 'COD_CASH_COLLECTED') < now() - interval '7 days'`,
    describe: (r) => `Holds ₹${(Number(r.held) / 100).toFixed(2)} of cash collected more than 7 days ago`,
  },
  {
    code: "HIGH_REJECTION",
    subject: "SHOP",
    severity: "MEDIUM",
    label: "Shop cancels many orders",
    query: sql`select o.shop_id as subject_id, count(*)::int as orders,
        count(*) filter (where exists (select 1 from order_status_history h
          where h.order_id = o.id and h.new_status = 'CANCELLED' and h.changed_by = s.owner_id))::int as count
      from orders o join shops s on s.id = o.shop_id
      where o.created_at > now() - interval '30 days'
        and exists (select 1 from order_status_history h where h.order_id = o.id and h.new_status = 'CONFIRMED')
      group by o.shop_id
      having count(*) >= 10 and count(*) filter (where exists (select 1 from order_status_history h
          where h.order_id = o.id and h.new_status = 'CANCELLED' and h.changed_by = s.owner_id)) * 10 >= count(*) * 3`,
    describe: (r) => `Cancelled ${r.count} of ${r.orders} orders in 30 days`,
  },
  {
    code: "COD_CASH_OVERDUE",
    subject: "SHOP",
    severity: "HIGH",
    label: "Cash-on-delivery cash not handed over",
    query: sql`select a.shop_id as subject_id, (-sum(a.amount_paise))::bigint as held
      from financial_adjustments a
      where a.party = 'SHOP' and a.status = 'PENDING' and a.type in ('COD_CASH_COLLECTED', 'COD_CASH_DEPOSITED')
      group by a.shop_id
      having -sum(a.amount_paise) > 0
        and min(a.created_at) filter (where a.type = 'COD_CASH_COLLECTED') < now() - interval '7 days'`,
    describe: (r) => `Holds ₹${(Number(r.held) / 100).toFixed(2)} of cash collected more than 7 days ago`,
  },
];

export const RISK_RULE_LABELS: Record<string, string> = Object.fromEntries(RULES.map((r) => [r.code, r.label]));

/** Evaluates every rule; raises new flags and refreshes open ones. Safe to re-run. */
export async function runRiskRules(actor: { id: string | null; role: UserRole | null }) {
  let raised = 0;
  let refreshed = 0;
  for (const rule of RULES) {
    const rows = (await db.execute(rule.query)) as unknown as Record<string, unknown>[];
    const hits: Hit[] = rows
      .filter((r) => r.subject_id)
      .map((r) => ({
        subjectId: String(r.subject_id),
        detail: Object.fromEntries(Object.entries(r).filter(([k]) => k !== "subject_id").map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v == null ? null : String(v)])),
        summary: rule.describe(r),
      }));
    for (const hit of hits) {
      const [row] = await db
        .insert(riskFlags)
        .values({
          subjectType: rule.subject,
          subjectId: hit.subjectId,
          ruleCode: rule.code,
          severity: rule.severity,
          summary: hit.summary,
          details: hit.detail,
        })
        .onConflictDoUpdate({
          target: [riskFlags.subjectType, riskFlags.subjectId, riskFlags.ruleCode],
          targetWhere: sql`${riskFlags.status} = 'OPEN'`,
          set: {
            summary: hit.summary,
            details: hit.detail,
            lastDetectedAt: new Date(),
            occurrences: sql`${riskFlags.occurrences} + 1`,
          },
        })
        .returning({ occurrences: riskFlags.occurrences });
      if (row?.occurrences === 1) raised += 1;
      else refreshed += 1;
    }
  }
  const result = { rules: RULES.length, raised, refreshed };
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RISK_RULES_RUN,
    entityType: "risk",
    newValue: result,
  });
  return result;
}

export interface RiskFlagView extends RiskFlag {
  subjectName: string;
  subjectStatus: string | null;
  /** A USER flag whose account is an admin (any ADMIN grant, not just the active role): it cannot be suspended. */
  subjectIsAdmin: boolean;
  ruleLabel: string;
}

export interface ListRiskFlagsOptions {
  status?: RiskFlagStatus;
  severity?: RiskSeverity;
  subjectType?: RiskSubject;
  limit?: number;
}

/** Review queue with a readable subject name and its current account status (never contact details). */
export async function listRiskFlags(options: ListRiskFlagsOptions = {}): Promise<RiskFlagView[]> {
  const rows = await db
    .select({
      flag: riskFlags,
      userName: users.name,
      userStatus: users.status,
      userDeletedAt: users.deletedAt,
      shopName: shops.name,
      shopStatus: shops.status,
      shopDeletedAt: shops.deletedAt,
      riderName: deliveryPartners.fullName,
      riderStatus: deliveryPartners.status,
      riderDeletedAt: deliveryPartners.deletedAt,
    })
    .from(riskFlags)
    .leftJoin(users, and(eq(riskFlags.subjectType, "USER"), eq(riskFlags.subjectId, users.id)))
    .leftJoin(shops, and(eq(riskFlags.subjectType, "SHOP"), eq(riskFlags.subjectId, shops.id)))
    .leftJoin(deliveryPartners, and(eq(riskFlags.subjectType, "DELIVERY_PARTNER"), eq(riskFlags.subjectId, deliveryPartners.id)))
    .where(
      and(
        eq(riskFlags.status, options.status ?? "OPEN"),
        options.severity ? eq(riskFlags.severity, options.severity) : undefined,
        options.subjectType ? eq(riskFlags.subjectType, options.subjectType) : undefined,
      ),
    )
    .orderBy(sql`case ${riskFlags.severity} when 'HIGH' then 0 when 'MEDIUM' then 1 else 2 end`, desc(riskFlags.lastDetectedAt))
    .limit(Math.min(options.limit ?? 200, 500));
  const adminIds = await findAdminUserIds(rows.filter((r) => r.flag.subjectType === "USER").map((r) => r.flag.subjectId));
  return rows.map((r) => {
    const subject =
      r.flag.subjectType === "USER"
        ? { name: r.userName, status: r.userStatus, deletedAt: r.userDeletedAt }
        : r.flag.subjectType === "SHOP"
          ? { name: r.shopName, status: r.shopStatus, deletedAt: r.shopDeletedAt }
          : { name: r.riderName, status: r.riderStatus, deletedAt: r.riderDeletedAt };
    return {
      ...r.flag,
      subjectName: subject.name ?? `${r.flag.subjectType.toLowerCase()} ${r.flag.subjectId.slice(0, 8)}`,
      subjectStatus: subject.deletedAt ? "DELETED" : subject.status,
      subjectIsAdmin: r.flag.subjectType === "USER" && adminIds.has(r.flag.subjectId),
      ruleLabel: RISK_RULE_LABELS[r.flag.ruleCode] ?? r.flag.ruleCode,
    };
  });
}

export async function countOpenRiskFlags(): Promise<Record<RiskSeverity, number>> {
  const rows = await db
    .select({ severity: riskFlags.severity, n: sql<number>`count(*)::int` })
    .from(riskFlags)
    .where(eq(riskFlags.status, "OPEN"))
    .groupBy(riskFlags.severity);
  const out: Record<RiskSeverity, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  for (const r of rows) out[r.severity] = r.n;
  return out;
}

/** Operations closes a flag: DISMISSED (false positive) or ACTIONED (what was done). */
export async function reviewRiskFlag(
  flagId: string,
  decision: "DISMISSED" | "ACTIONED",
  note: string,
  actor: Actor,
): Promise<RiskFlag> {
  const trimmed = note.trim();
  if (trimmed.length < 5) throw validationFailed("Record what you checked or did (at least 5 characters).");
  const current = await db.query.riskFlags.findFirst({ where: eq(riskFlags.id, flagId) });
  if (!current) throw notFound("Risk flag");
  if (current.status !== "OPEN") throw conflict("This flag has already been reviewed.");

  const [flag] = await db
    .update(riskFlags)
    .set({ status: decision, reviewedBy: actor.id, reviewedAt: new Date(), reviewNote: trimmed })
    .where(and(eq(riskFlags.id, flagId), eq(riskFlags.status, "OPEN")))
    .returning();
  if (!flag) throw conflict("This flag has already been reviewed.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RISK_FLAG_REVIEWED,
    entityType: "risk_flag",
    entityId: flagId,
    previousValue: { status: "OPEN" },
    newValue: { status: decision, note: trimmed, subjectType: flag.subjectType, subjectId: flag.subjectId, ruleCode: flag.ruleCode },
  });
  return flag;
}
