/**
 * Helpers for the TIERED dealer commission checks (docs/dealer-programme/
 * TIERED_COMMISSION.md, owner's structure 20 / 4 / 3 %, DT-13 … DT-23) and
 * the shop-referral request checks — group E of the cases added on 20-Nov-2026.
 *
 * Local only. A TIERED network is built the way an admin builds one:
 *   - the dealer itself is an approved dealer row (its application and KYC
 *     are arranged in the database: PAN, verified bank, agreement accepted);
 *   - the dealer is moved to TIERED and its team lead and agent are added
 *     through the admin API (/api/admin/dealer-tiers), which also issues
 *     their referral codes; their PAN / bank / agreement are arranged;
 *   - a shop "registered with a code" is a new owner's shop whose attribution
 *     to the signer is arranged (shop_attributions, CODE_AT_REGISTRATION) and
 *     whose fee is recorded as paid; operations then approve it through the
 *     API — the approval is what accrues the commission under test.
 */
import type { APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { AGENT_AGREEMENT_VERSION } from "@/lib/dealer-tiers";

import { as } from "./actors";
import { db } from "./db";
import { call, expectStatus, RUN, type Answer } from "./http";
import { blocked, expect } from "./record";
import { ctxFor, freshAccount, markDocumentsVerified, registerShop, type Account } from "./sellers-helpers";
import { assertWritable, IS_LOCAL } from "./target";

export { AGENT_AGREEMENT_VERSION };

let seq = 0;
const tag = () => `${RUN}-${++seq}`;

export interface Member {
  id: string;
  name: string;
  code: string | null;
  account: Account | null;
}

export interface Network {
  dealerId: string;
  name: string;
  owner: Account;
  lead: Member;
  agent: Member;
}

export interface Ready {
  pan?: boolean;
  bank?: boolean;
  agreement?: boolean;
}

/** Admin action on the TIERED screen's API. */
export async function tierAction(body: Record<string, unknown>): Promise<Answer> {
  return call(await as("admin"), "POST", "/api/admin/dealer-tiers", body);
}

/** Admin action on Dealers → Commission (ledger, approvals, payouts). */
export async function commissionAction(body: Record<string, unknown>): Promise<Answer> {
  return call(await as("admin"), "POST", "/api/admin/dealer-commission", body);
}

/** Sets a member's payee details as the screens would leave them (PAN, verified bank, agreement). */
export async function arrangeMember(memberId: string, ready: Ready = { pan: true, bank: true, agreement: true }) {
  await db()`
    update dealer_salespeople set
      pan_hash = ${ready.pan ? `qa-pan-${memberId}` : null}, pan_last4 = ${ready.pan ? "234F" : null},
      bank_status = ${ready.bank ? "VERIFIED" : "NOT_PROVIDED"}, bank_account_last4 = ${ready.bank ? "4321" : null},
      bank_verified_at = ${ready.bank ? new Date() : null},
      agreement_version = ${ready.agreement ? AGENT_AGREEMENT_VERSION : null}, agreement_accepted_at = ${ready.agreement ? new Date() : null}
    where id = ${memberId}`;
}

/**
 * An approved dealer (main dealer) with PAN, a verified bank and the agent
 * agreement, its own GoKesari account, moved to TIERED (unless `standard`),
 * with a team lead and an agent under him — each with a code and payee
 * details. Needs dealer_programme_enabled and rule dealerTieredCommission on.
 */
export async function tieredNetwork(label: string, options: { standard?: boolean; members?: Ready; linkAccounts?: boolean } = {}): Promise<Network> {
  const net = await dealerOnly(label, options);
  const lead = await addMember(net, "TEAM_LEAD", null, options.members, options.linkAccounts);
  const agent = await addMember(net, "AGENT", lead.id, options.members, options.linkAccounts);
  return { ...net, lead, agent };
}

/** An approved main dealer (no team yet), moved to TIERED unless `standard`. */
export async function dealerOnly(label: string, options: { standard?: boolean } = {}): Promise<Omit<Network, "lead" | "agent">> {
  if (!IS_LOCAL) blocked("builds a dealer network in the database (local run only)");
  assertWritable("build a dealer network");
  const t = tag();
  const owner = await freshAccount(`dlr-${label}`);
  const name = `QA ${label} Network ${t}`;
  const [dealer] = await db()<{ id: string }[]>`
    insert into dealers (user_id, legal_name, contact_name, dealer_type, status, source, pan_hash, pan_last4, bank_status, bank_account_last4, bank_verified_at,
                         tier_agreement_version, tier_agreement_accepted_at, decided_at)
    values (${owner.id}, ${name}, ${`QA ${label} Main`}, 'PROPRIETORSHIP', 'APPROVED', 'ADMIN', ${`qa-pan-${randomUUID()}`}, '123F', 'VERIFIED', '9876', now(),
            ${AGENT_AGREEMENT_VERSION}, now(), now())
    returning id`;
  if (!options.standard) {
    const moved = await tierAction({ action: "setModel", dealerId: dealer.id, model: "TIERED", reason: "QA: pilot TIERED network" });
    expectStatus(moved, 200, "move the dealer to TIERED");
  }
  return { dealerId: dealer.id, name, owner };
}

/** One more member of a network (a second lead, an agent under someone). */
export async function addMember(net: Pick<Network, "dealerId">, role: "TEAM_LEAD" | "AGENT", parentId: string | null, ready?: Ready, link = false): Promise<Member> {
  const t = tag();
  const res = await tierAction({ action: "addMember", dealerId: net.dealerId, employeeId: `QA-${role === "AGENT" ? "A" : "L"}-${t}`, name: `QA ${role === "AGENT" ? "Agent" : "Lead"} ${t}`, role, parentId });
  expectStatus(res, 200, `add a ${role}`);
  const m = res.body.member as { id: string; name: string; code: string | null };
  await arrangeMember(m.id, ready);
  let account: Account | null = null;
  if (link) {
    account = await freshAccount(`dlr-${role.toLowerCase()}`);
    expectStatus(await tierAction({ action: "linkAccount", memberId: m.id, email: account.email }), 200, "link the member's account");
  }
  return { id: m.id, name: m.name, code: m.code, account };
}

/** The ₹ amounts of the fee slabs, before GST (DEFAULT_TURNOVER_SLABS). */
export const SLAB_4999 = 499_900;
export const SLAB_9999 = 999_900;

export interface Activated {
  shopId: string;
  owner: Account;
  ctx: APIRequestContext;
}

/**
 * A new shop signed by `signerId` (null = the main dealer himself): registered
 * by a new owner, attributed to the signer's code, its fee of `basePaise`
 * (before GST, less `discountPaise` of a coupon) paid, its documents verified —
 * then approved by operations through the API, which accrues the commission.
 */
export async function activatedShop(dealerId: string, signerId: string | null, basePaise = SLAB_4999, options: { discountPaise?: number; approve?: boolean } = {}): Promise<Activated> {
  assertWritable("register and approve a shop");
  const owner = await freshAccount("dlr-shop");
  const ctx = await ctxFor(owner);
  const { shop } = await registerShop(ctx);
  // registerShop() sends the run's plain referral code (the code is mandatory), which may already have
  // attributed the shop to nobody: the signer's attribution replaces it.
  await db()`insert into shop_attributions (shop_id, dealer_id, salesperson_id, source, match_kind) values (${shop.id}, ${dealerId}, ${signerId}, 'CODE_AT_REGISTRATION', 'NONE')
    on conflict (shop_id) do update set dealer_id = excluded.dealer_id, salesperson_id = excluded.salesperson_id, source = excluded.source, match_kind = excluded.match_kind`;
  const discount = options.discountPaise ?? 0;
  const gst = Math.round(((basePaise - discount) * 1800) / 10_000);
  await db()`
    update shops set registration_fee_base_paise = ${basePaise}, registration_fee_discount_paise = ${discount}, registration_fee_gst_paise = ${gst},
      registration_fee_paise = ${basePaise - discount + gst}
    where id = ${shop.id}`;
  // The fee is recorded as paid the way Finance records it, so a later refund has a payment to take back.
  const paid = await call(await as("admin"), "POST", "/api/shop-payments", { shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: basePaise - discount + gst, method: "CASH", note: "QA: registration fee" });
  expectStatus(paid, 201, "record the registration fee");
  const [fee] = await db()<{ status: string }[]>`select fee_payment_status as status from shops where id = ${shop.id}`;
  expect(fee.status, "the fee is paid").toBe("PAID");
  await markDocumentsVerified(shop.id);
  if (options.approve !== false) {
    const approved = await call(await as("ops"), "POST", `/api/shops/${shop.id}/approve`, { classification: "GREEN" });
    expectStatus(approved, 200, "operations approve the shop");
    await activationRecorded(shop.id);
  }
  return { shopId: shop.id, owner, ctx };
}

/**
 * The commission check runs just after the approval answers: wait until it has recorded the
 * activation (shop_attributions.activated_at, set once the accruals are written), so a check reads
 * the ledger — and a rule changed around activatedShop() is still in force — when it has run.
 */
export async function activationRecorded(shopId: string, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db()<{ done: boolean }[]>`select activated_at is not null as done from shop_attributions where shop_id = ${shopId}`;
    if (row?.done) return;
    if (Date.now() > until) throw new Error(`the commission check did not record shop ${shopId}'s activation within ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export interface LedgerRow {
  id: string;
  entry_type: string;
  payee_member_id: string | null;
  amount_paise: number;
  status: string;
  kind: string;
  note: string | null;
}

/** The shop's commission entries, by entry type then payee. */
export async function ledgerOf(shopId: string): Promise<LedgerRow[]> {
  return db()<LedgerRow[]>`
    select id, entry_type, payee_member_id, amount_paise, status, kind, note from dealer_commission_ledger
    where shop_id = ${shopId} order by entry_type, kind, payee_member_id nulls first`;
}

/** [entry type, payee (null = main dealer), amount] of the shop's accruals. */
export async function accruals(shopId: string): Promise<[string, string | null, number][]> {
  return (await ledgerOf(shopId)).filter((r) => r.kind === "ACCRUAL").map((r) => [r.entry_type, r.payee_member_id, r.amount_paise]);
}

/** A ₹ amount as the ledger stores it, for messages. */
export const inr = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

/**
 * Local only: a visitor of its own for the referral-request form, which allows 5 requests per 10
 * minutes per client address (x-forwarded-for, RATE_LIMITS.GRIEVANCE) — every check of a local run
 * comes from 127.0.0.1, so each presents a documentation address (198.51.100.0/24) of its own.
 */
export function visitorHeaders(): { headers: Record<string, string> } {
  return { headers: { "x-forwarded-for": `198.51.100.${1 + Math.floor(Math.random() * 254)}` } };
}
