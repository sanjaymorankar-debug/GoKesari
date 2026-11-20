/**
 * Helpers for the team-lead and promotion checks (DT-28 / DT-29, PR #420;
 * docs/dealer-programme/TIERED_COMMISSION.md) — the cases added on 20-Nov-2026.
 *
 * Local only, on top of lib/dealer-commission-helpers.ts (tieredNetwork,
 * addMember, activatedShop). The promotion rule counts an agent's activated
 * shops (dealer_tier_shop_plans) and the ready agents he brought in. Shops are
 * arranged in the database for the count (arrangeActivatedShops: closed shops
 * outside every test pincode, each with an activated TIERED plan signed by the
 * agent, as 50 approvals would leave them); the agents he brought in come the
 * real way — his sub-agent requests, approved by an admin — and their agent
 * agreement is arranged.
 */
import type { APIRequestContext } from "@playwright/test";

import { as } from "./actors";
import { arrangeMember, tierAction, type Member } from "./dealer-commission-helpers";
import { db } from "./db";
import { call, expectStatus, RUN, type Answer } from "./http";
import { need } from "./record";
import { ctxFor } from "./sellers-helpers";

let seq = 0;

/** POST /api/dealer/team as a member's (or the main dealer's) own account. */
export async function teamPost(ctx: APIRequestContext, body: Record<string, unknown>): Promise<Answer> {
  return call(ctx, "POST", "/api/dealer/team", body);
}

export async function memberCtx(m: Pick<Member, "account" | "name">): Promise<APIRequestContext> {
  return ctxFor(need(m.account, `${m.name}'s account`));
}

export interface MemberRow {
  id: string;
  name: string;
  employee_id: string;
  team_role: string;
  depth: number;
  parent_id: string | null;
  recruited_by_id: string | null;
  status: string;
  source: string;
}

export async function memberRow(id: string): Promise<MemberRow> {
  const [row] = await db()<MemberRow[]>`
    select id, name, employee_id, team_role, depth, parent_id, recruited_by_id, status, source from dealer_salespeople where id = ${id}`;
  return need(row, `team member ${id}`);
}

export async function memberByEmployeeId(dealerId: string, employeeId: string): Promise<MemberRow | null> {
  const [row] = await db()<MemberRow[]>`
    select id, name, employee_id, team_role, depth, parent_id, recruited_by_id, status, source from dealer_salespeople
    where dealer_id = ${dealerId} and lower(employee_id) = lower(${employeeId})`;
  return row ?? null;
}

/** The member's active referral code (issued when he was added). */
export async function codeOf(memberId: string): Promise<string | null> {
  const [row] = await db()<{ code: string }[]>`
    select rc.code from dealer_codes dc join referral_codes rc on rc.id = dc.referral_code_id
    where dc.salesperson_id = ${memberId} and dc.status = 'ACTIVE' order by dc.created_at desc limit 1`;
  return row?.code ?? null;
}

/**
 * `n` activated shops signed by `memberId` (as `n` approvals would leave them): closed shops in a
 * pincode no check uses, each with a TIERED plan activated a month ago (status TRADING). Only the
 * promotion count reads them.
 */
export async function arrangeActivatedShops(dealerId: string, memberId: string, leadId: string | null, ownerId: string, n: number): Promise<string[]> {
  const tag = `${RUN}-${++seq}`;
  const shops = await db()<{ id: string }[]>`
    insert into shops (owner_id, name, slug, owner_name, phone, address_line1, city, pincode, shop_type, status)
    select ${ownerId}, ${`QA arranged shop ${tag} #`} || g, ${`qa-arranged-${tag}-`} || g, 'QA Arranged Owner',
           '98' || lpad((floor(random() * 100000000))::bigint::text, 8, '0'), 'QA Lane', 'Pune', '799999', 'STATIONERY_STORE', 'INACTIVE'
    from generate_series(1, ${n}) g
    returning id`;
  const ids = shops.map((s) => s.id);
  await db()`
    insert into dealer_tier_shop_plans (shop_id, dealer_id, direct_member_id, direct_level, lead_member_id, main_override, fee_paise, direct_bp, first_part_bp,
                                        lead_override_bp, main_override_bp, trading_orders, activated_at, trading_deadline, status, trading_at)
    select s, ${dealerId}, ${memberId}, ${leadId ? 3 : 2}, ${leadId}, true, 499900, 2000, 10000, 400, 300, 0,
           now() - interval '40 days', now() - interval '40 days', 'TRADING', now() - interval '40 days'
    from unnest(${ids}::uuid[]) s`;
  return ids;
}

/** An agent's sub-agent request approved by an admin (he "brought them in"), each with the agreement accepted: ready agents. */
export async function recruit(agent: Pick<Member, "account" | "name">, dealerId: string, n: number): Promise<string[]> {
  const ctx = await memberCtx(agent);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = `${RUN}-${++seq}`;
    const asked = await teamPost(ctx, { action: "requestSubAgent", employeeId: `QA-R-${t}`, name: `QA Recruit ${t}` });
    expectStatus(asked, 200, "the agent asks for a sub-agent");
    const decided = await tierAction({ action: "decideRequest", requestId: asked.body.id, approve: true, note: null });
    expectStatus(decided, 200, "the admin approves the request");
    const id = need(decided.body.memberId as string | null, "the new agent");
    await arrangeMember(id);
    out.push(id);
  }
  void dealerId;
  return out;
}

/** The main dealer's team history (GET /api/dealer/team?view=history). */
export async function historyOf(ownerCtx: APIRequestContext): Promise<{ memberId: string; memberName: string; role: string; level: number; leadName: string | null; reason: string }[]> {
  const res = await call(ownerCtx, "GET", "/api/dealer/team?view=history");
  expectStatus(res, 200, "the team history");
  return res.body.history;
}

/** Notifications of a fresh account (GET /api/notifications). */
export async function notesOf(ctx: APIRequestContext): Promise<{ title: string; body: string; createdAt: string }[]> {
  const res = await call(ctx, "GET", "/api/notifications");
  expectStatus(res, 200, "notifications");
  return res.body.notifications;
}

/** The dealer's commission ledger rows (every entry). */
export async function ledgerCount(dealerId: string): Promise<number> {
  const [r] = await db()<{ n: number }[]>`select count(*)::int as n from dealer_commission_ledger where dealer_id = ${dealerId}`;
  return r.n;
}

export { as };
