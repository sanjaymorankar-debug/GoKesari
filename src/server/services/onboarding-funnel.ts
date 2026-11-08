/**
 * The shop onboarding funnel (onboarding Phase B, B3 — docs/onboarding-benchmark): of the
 * registrations started in a window, how many were verified, paid, went live, listed a product
 * and received an order; by source (self, dealer, operator); the median minutes from the first
 * step to going live; and where open registrations stopped. Read-only, for admins.
 */
import { sql } from "drizzle-orm";

import { db } from "@/server/db";

export const FUNNEL_STAGES = ["started", "verified", "paid", "live", "firstProduct", "firstOrder"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export interface FunnelRow {
  source: "ALL" | "SELF" | "DEALER" | "OPERATOR";
  counts: Record<FunnelStage, number>;
}

export interface OnboardingFunnel {
  days: number;
  rows: FunnelRow[];
  /** Median minutes from the registration's first step to going live (null: none went live). */
  medianMinutesToLive: number | null;
  /** Median minutes from going live to the first product (null: none listed). */
  medianMinutesToFirstProduct: number | null;
  /** OPEN registrations idle for a day or more, by the step they stopped on. */
  abandonedAt: { step: string; count: number }[];
}

type Raw = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

export async function getOnboardingFunnel(days = 30): Promise<OnboardingFunnel> {
  const window = Math.min(365, Math.max(1, Math.round(days)));
  // One row per registration started in the window, with how far it got.
  const base = sql`
    with d as (
      select dr.id, dr.status, dr.shop_id, dr.created_at,
             (dr.gst_status = 'VERIFIED' or dr.pan_status = 'VERIFIED' or dr.documents_later is true
              or dr.gst_status in ('PENDING','MANUAL_REVIEW') or dr.pan_status in ('PENDING','MANUAL_REVIEW')) as verified,
             s.fee_payment_status = 'PAID' or (s.id is not null and coalesce(s.registration_fee_paise, 0) = 0) as paid,
             s.status = 'APPROVED' as live,
             exists (select 1 from shop_products sp where sp.shop_id = s.id) as first_product,
             exists (select 1 from orders o where o.shop_id = s.id) as first_order,
             case
               when exists (select 1 from shop_onboarding_sessions os where os.shop_id = s.id) then 'OPERATOR'
               when exists (select 1 from shop_attributions sa where sa.shop_id = s.id) then 'DEALER'
               when dr.referral_code is not null then 'DEALER'
               else 'SELF'
             end as source
      from shop_registration_drafts dr
      left join shops s on s.id = dr.shop_id
      where dr.created_at >= now() - make_interval(days => ${window})
    )`;
  const grouped = (await db.execute(sql`${base}
    select source,
           count(*)::int as started,
           count(*) filter (where verified)::int as verified,
           count(*) filter (where paid)::int as paid,
           count(*) filter (where live)::int as live,
           count(*) filter (where first_product)::int as first_product,
           count(*) filter (where first_order)::int as first_order
    from d group by rollup(source)`)) as unknown as Raw[];
  const rows: FunnelRow[] = grouped.map((r) => ({
    source: (r.source ?? "ALL") as FunnelRow["source"],
    counts: {
      started: n(r.started),
      verified: n(r.verified),
      paid: n(r.paid),
      live: n(r.live),
      firstProduct: n(r.first_product),
      firstOrder: n(r.first_order),
    },
  }));
  rows.sort((a, b) => (a.source === "ALL" ? -1 : b.source === "ALL" ? 1 : a.source.localeCompare(b.source)));

  const timing = (await db.execute(sql`
    with t as (
      select st.draft_id,
             min(st.reached_at) as first_at,
             min(st.reached_at) filter (where st.step in ('LIVE','LOCATION','CATEGORY','PRODUCTS','DONE')) as live_at,
             min(sp.created_at) as product_at
      from shop_onboarding_steps st
      join shop_registration_drafts dr on dr.id = st.draft_id
      left join shop_products sp on sp.shop_id = dr.shop_id
      where dr.created_at >= now() - make_interval(days => ${window})
      group by st.draft_id
    )
    select percentile_cont(0.5) within group (order by extract(epoch from live_at - first_at) / 60) filter (where live_at is not null) as to_live,
           percentile_cont(0.5) within group (order by extract(epoch from product_at - live_at) / 60) filter (where live_at is not null and product_at >= live_at) as to_product
    from t`)) as unknown as Raw[];
  const tm = timing[0] ?? {};

  const stopped = (await db.execute(sql`
    select last.step, count(*)::int as count
    from shop_registration_drafts dr
    join lateral (
      select st.step, st.reached_at from shop_onboarding_steps st where st.draft_id = dr.id order by st.reached_at desc limit 1
    ) last on true
    where dr.status = 'OPEN' and dr.updated_at < now() - interval '1 day'
      and dr.created_at >= now() - make_interval(days => ${window})
    group by last.step order by count desc`)) as unknown as Raw[];

  const round = (v: unknown) => (v == null ? null : Math.round(Number(v) * 10) / 10);
  return {
    days: window,
    rows,
    medianMinutesToLive: round(tm.to_live),
    medianMinutesToFirstProduct: round(tm.to_product),
    abandonedAt: stopped.map((r) => ({ step: String(r.step), count: n(r.count) })),
  };
}

export interface IdleRegistration {
  draftId: string;
  ownerName: string | null;
  ownerEmail: string;
  ownerPhone: string | null;
  /** The step the registration is waiting on (its latest step reached). */
  step: string | null;
  referralCode: string | null;
  idleHours: number;
  /** Reminders already sent (onboarding Phase 2, WP4): 0, 1 or 2. */
  remindersSent: number;
}

/**
 * Onboarding Phase 2 (WP4): registrations not finished and untouched for `minIdleHours` or more,
 * longest idle first — the list an operator calls from. OPEN drafts and submitted ones with the
 * fee still due; the owner's contact, step, code and how many reminders went out.
 */
export async function listIdleRegistrations(minIdleHours = 24, limit = 200): Promise<IdleRegistration[]> {
  const rows = (await db.execute(sql`
    select d.id as draft_id, u.name as owner_name, u.email as owner_email, u.phone_e164 as owner_phone,
           d.referral_code,
           (select s.step from shop_onboarding_steps s where s.draft_id = d.id order by s.reached_at desc limit 1) as step,
           floor(extract(epoch from (now() - d.updated_at)) / 3600)::int as idle_hours,
           coalesce((select case when n.sent_at is not null then n.stage else n.stage - 1 end
                     from scheduled_notices n where n.key = 'registration-idle:' || d.id::text and n.cancelled_at is null), 0) as reminders_sent
    from shop_registration_drafts d
    join users u on u.id = d.owner_id
    left join shops sh on sh.id = d.shop_id
    where d.updated_at < now() - make_interval(hours => ${minIdleHours})
      and (d.status = 'OPEN'
           or (d.status = 'SUBMITTED' and sh.id is not null and sh.fee_payment_status in ('PENDING', 'PARTIALLY_PAID') and coalesce(sh.registration_fee_paise, 0) > coalesce(sh.amount_paid_paise, 0)))
    order by d.updated_at asc
    limit ${limit}
  `)) as unknown as Raw[];
  return rows.map((r) => ({
    draftId: String(r.draft_id),
    ownerName: (r.owner_name as string | null) ?? null,
    ownerEmail: String(r.owner_email),
    ownerPhone: (r.owner_phone as string | null) ?? null,
    step: (r.step as string | null) ?? null,
    referralCode: (r.referral_code as string | null) ?? null,
    idleHours: n(r.idle_hours),
    remindersSent: n(r.reminders_sent),
  }));
}
