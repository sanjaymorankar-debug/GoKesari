/**
 * Helpers for the TERRITORY DEALER checks (docs/dealer-programme/TERRITORY_DEALER.md,
 * DT-24 … DT-27, PR #419) and the month close they share with the team-lead
 * checks (DT-28 / DT-29, PR #420) — the cases added on 20-Nov-2026.
 *
 * Local only. Rule territoryDealer is off by default: every check switches it
 * on (with dealer_programme_enabled and rule dealerTieredCommission) through
 * the admin API and puts it back in a finally block (territorial()).
 *
 * Pincodes are exclusive (a unique index while a pincode is not released), so
 * give() first cancels, through the admin API, any territory a failed earlier
 * check left holding the same pincodes, and every check cancels its own
 * territories in finally (cancelAll()).
 *
 * Order income needs real delivered orders (order_financials): the world's
 * shops A and B are in pincode 411038 (TEST_PIN). The local database has no
 * commission rate, so a check that reads income sets GoKesari's 2% on the shop
 * (withCommission(), restored after).
 *
 * Time-based steps (renewal window, lapse, grace release, month close) move the
 * territory's dates, the pincode's held_from, the fee's period and the order's
 * delivered_at in the local database — as the clock would have moved them — and
 * then run the real jobs: the daily cron (/api/cron/daily, which runs
 * dealer-territory-daily) and the month close (Admin → Dealers → Commission →
 * "Close <month> now", POST /api/admin/dealer-commission closeMonth). A month
 * close is permanent, so each check closes old months of its own (freeMonth()).
 */
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { as } from "./actors";
import { withFlags } from "./billing-v2-helpers";
import { commissionAction } from "./dealer-commission-helpers";
import { db } from "./db";
import { commissionSnapshot, deliveredOrder, restoreCommission, setCommission, withRules } from "./finance-helpers";
import type { Listing } from "./flows";
import { call, expectStatus, RUN, type Answer } from "./http";
import { runCron } from "./money-helpers";
import { ensureWallet, listingOf } from "./orders-helpers";
import { blocked, expect, need } from "./record";
import { assertWritable, IS_LOCAL } from "./target";
import { world } from "./world";

/** The pincode of the local world's shops A and B (scripts/qa/seed-local.ts). */
export const TEST_PIN = "411038";

/** dealer_programme_enabled on, the rating bonus off, rules dealerTieredCommission and territoryDealer on (plus `rule`). */
export function territorial<T>(body: () => Promise<T>, rule: Record<string, unknown> = {}, tier: Record<string, unknown> = {}): Promise<T> {
  if (!IS_LOCAL) blocked("switches rule territoryDealer on (Admin → Settings), local run only");
  return withFlags({ dealer_programme_enabled: true, dealer_rating_bonus_enabled: false }, () =>
    withRules({ dealerTieredCommission: { enabled: true, ...tier }, territoryDealer: { enabled: true, ...rule } }, body),
  );
}

/** Admin action on Admin → Dealers → Territory dealers. */
export async function territoryAction(body: Record<string, unknown>, role: "admin" | "ops" = "admin"): Promise<Answer> {
  return call(await as(role), "POST", "/api/admin/dealer-territories", body);
}

export interface TerritoryRow {
  id: string;
  dealer_id: string;
  name: string;
  status: string;
  fee_paise: number;
  paid_until: Date | null;
  rating: string;
  share_bp: number;
  rated_at: Date | null;
}

export async function territoryRow(id: string): Promise<TerritoryRow> {
  const [row] = await db()<TerritoryRow[]>`select id, dealer_id, name, status, fee_paise, paid_until, rating, share_bp, rated_at from dealer_exclusive_territories where id = ${id}`;
  return need(row, `territory ${id}`);
}

export interface FeeRow {
  id: string;
  amount_paise: number;
  status: string;
  method: string | null;
  reference: string | null;
  payment_intent_id: string | null;
  period_start: Date | null;
  period_end: Date | null;
}

export async function feeRows(territoryId: string): Promise<FeeRow[]> {
  return db()<FeeRow[]>`
    select id, amount_paise, status, method, reference, payment_intent_id, period_start, period_end
    from dealer_territory_fees where territory_id = ${territoryId} order by created_at, id`;
}

/** The pincodes a territory holds now (not released). */
export async function heldPins(territoryId: string): Promise<string[]> {
  const rows = await db()<{ pincode: string }[]>`select pincode from dealer_territory_pincodes where territory_id = ${territoryId} and released_at is null order by pincode`;
  return rows.map((r) => r.pincode);
}

/** Who holds each of `pins` now. */
export async function holders(pins: string[]): Promise<{ pincode: string; territory_id: string }[]> {
  if (pins.length === 0) return [];
  return db()<{ pincode: string; territory_id: string }[]>`select pincode, territory_id from dealer_territory_pincodes where pincode in ${db()(pins)} and released_at is null`;
}

/** Local: cancels (admin API, with a reason) every territory holding one of `pins`, so a check can give them. */
export async function freePincodes(pins: string[]) {
  for (const id of [...new Set((await holders(pins)).map((h) => h.territory_id))]) {
    const res = await territoryAction({ action: "cancel", territoryId: id, reason: "QA: free the test pincodes for the next check" });
    if (res.status !== 200) {
      // A territory from a failed check whose rule was off at the time: release its pincodes directly.
      await db()`update dealer_territory_pincodes set released_at = now() where territory_id = ${id} and released_at is null`;
    }
  }
}

const made = new Set<string>();
let given = 0;

/** Gives `dealerId` a territory through the admin API (pincodes freed first); the check cancels it in finally (cancelAll). */
export async function give(dealerId: string, pins: string[], options: { name?: string; feePaise?: number } = {}): Promise<{ id: string; name: string }> {
  assertWritable("give a dealer a territory");
  await freePincodes(pins);
  const name = options.name ?? `QA Territory ${RUN}-${++given}`;
  const res = await territoryAction({ action: "create", dealerId, name, pincodes: pins, feePaise: options.feePaise ?? 5_000_000 });
  expectStatus(res, 200, "give the dealer a territory");
  const id = res.body.territory.id as string;
  made.add(id);
  return { id, name };
}

/** Records the fee as paid by bank transfer (Admin → Record payment): the territory is Active for 12 months. */
export async function payOffline(territoryId: string, reference = `QA-UTR-${RUN}`): Promise<TerritoryRow> {
  const res = await territoryAction({ action: "recordPayment", territoryId, reference });
  expectStatus(res, 200, "record the territory fee");
  return territoryRow(territoryId);
}

/** Cancels every territory this worker gave (and `extra`) that is not cancelled yet — call in finally. */
export async function cancelAll(extra: string[] = []) {
  for (const id of [...made, ...extra]) {
    const [row] = await db()<{ status: string }[]>`select status from dealer_exclusive_territories where id = ${id}`;
    if (row && row.status !== "CANCELLED") {
      const res = await territoryAction({ action: "cancel", territoryId: id, reason: "QA: the check is over" });
      if (res.status !== 200) await db()`update dealer_territory_pincodes set released_at = now() where territory_id = ${id} and released_at is null`;
    }
    made.delete(id);
  }
}

export interface DealerTerritoryView {
  id: string;
  name: string;
  status: string;
  feePaise: number;
  paidUntil: string | null;
  pincodes: string[];
  rating: number;
  shareBp: number;
  canPay: boolean;
  openFee: { id: string; amountPaise: number } | null;
  latestRating: { day: string; onboardingRating: number; onboardingPoints: number; shopsTotal: number; shopsLive: number; productPoints: number } | null;
  monthSoFar: { orders: number; commissionKeptPaise: number; incomePaise: number };
  fees: { id: string; amountPaise: number; status: string; method: string | null }[];
}

/** GET /api/dealer/territory as the dealer. */
export async function myTerritories(ctx: APIRequestContext): Promise<DealerTerritoryView[]> {
  const res = await call(ctx, "GET", "/api/dealer/territory");
  expectStatus(res, 200, "the dealer's territories");
  return res.body.territories as DealerTerritoryView[];
}

export async function myTerritory(ctx: APIRequestContext, id: string): Promise<DealerTerritoryView> {
  return need((await myTerritories(ctx)).find((t) => t.id === id), `territory ${id} in the dealer's list`);
}

/* --------------------------------------------------------- pincodes */

/** A valid pincode no shop uses and no territory holds (for territories that need no orders). */
export async function emptyPincode(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const pin = `7${String(Math.floor(Math.random() * 100_000)).padStart(5, "0")}`;
    const [used] = await db()`select 1 from shops where pincode = ${pin} union all select 1 from dealer_territory_pincodes where pincode = ${pin} limit 1`;
    if (!used) return pin;
  }
  throw new Error("no free pincode found");
}

/** `n` distinct pincodes no shop uses and no territory holds. */
export async function emptyPincodes(n: number): Promise<string[]> {
  const out = new Set<string>();
  while (out.size < n) {
    const base = 600_000 + Math.floor(Math.random() * 300_000);
    const pins = Array.from({ length: Math.min(n - out.size, 200) }, (_, i) => String(base + i));
    const used = await db()<{ pincode: string }[]>`select pincode from shops where pincode in ${db()(pins)} union select pincode from dealer_territory_pincodes where pincode in ${db()(pins)}`;
    const taken = new Set(used.map((u) => u.pincode));
    for (const p of pins) if (!taken.has(p)) out.add(p);
  }
  return [...out].slice(0, n);
}

/** A Pune pincode (a registration accepts it) with no shop yet and no territory holding it — for shops arranged in a territory. */
export async function puneEmptyPincode(): Promise<string> {
  const candidates = Array.from({ length: 62 }, (_, i) => String(411_001 + i)).filter((p) => p !== TEST_PIN);
  const used = await db()<{ pincode: string }[]>`select pincode from shops where pincode in ${db()(candidates)} union select pincode from dealer_territory_pincodes where pincode in ${db()(candidates)} and released_at is null`;
  const taken = new Set(used.map((u) => u.pincode));
  return need(candidates.find((p) => !taken.has(p)), "a Pune pincode with no shop (411001 … 411062)");
}

/* ------------------------------------------------------------- orders */

/** Local: GoKesari's commission on `shopId` set to `bp` (2% = 200) for `body`, the rates put back after. */
export async function withCommission<T>(shopIds: string[], bp: number, body: () => Promise<T>): Promise<T> {
  const before = await commissionSnapshot();
  try {
    for (const shopId of shopIds) await setCommission("SHOP", bp, { shopId });
    return await body();
  } finally {
    await restoreCommission(before);
  }
}

export interface Financials {
  order_id: string;
  order_number: string;
  shop_id: string;
  goods_paise: number;
  commission_paise: number;
  commission_rate_bp: number;
  delivered_at: Date;
}

export async function financials(orderId: string): Promise<Financials> {
  const [row] = await db()<Financials[]>`
    select f.order_id, o.order_number, f.shop_id, f.goods_paise::int as goods_paise, f.commission_paise::int as commission_paise, f.commission_rate_bp, f.delivered_at
    from order_financials f join orders o on o.id = f.order_id where f.order_id = ${orderId}`;
  return need(row, `the financial snapshot of order ${orderId}`);
}

/**
 * One wallet order of `quantity` × the listing, placed by the customer, packed by the shop and
 * delivered by the rider (lib/finance-helpers deliveredOrder). Default: 25 × shop A's bread at
 * ₹40 — a ₹1,000 order.
 */
export async function delivered(options: { listing?: Listing; quantity?: number } = {}): Promise<Financials> {
  await ensureWallet("customer", 300_000);
  const listing = options.listing ?? (await listingOf("sharedA"));
  const quantity = options.quantity ?? 25;
  await db()`update shop_products set online_stock = greatest(online_stock, ${quantity + 30}), is_available = true where id = ${listing.shopProductId}`;
  const order = await deliveredOrder({ listing, quantity });
  return financials(order.id);
}

export const shopA = () => need(world().shops.A?.id, "shop A");
export const shopB = () => need(world().shops.B?.id, "shop B");

/** Refunds `amountPaise` of a delivered order's goods (Finance → Refund, charged to the shop). */
export async function refundGoods(orderNumber: string, amountPaise: number): Promise<Answer> {
  const res = await call(await as("admin"), "POST", "/api/finance/refunds", { orderNumber, amountPaise, reason: "QA: goods refunded", chargeTo: "SHOP", requestId: `qa-${RUN}-terr-${randomUUID().slice(0, 8)}` });
  expectStatus(res, 201, "refund part of the order");
  return res;
}

/* --------------------------------------------------------------- time */

const DAY = 86_400_000;

/** Moves a territory's paid-up date (and the paid fee's 12 months with it), as the calendar would have. */
export async function movePaidUntil(territoryId: string, paidUntil: Date) {
  await db()`update dealer_exclusive_territories set paid_until = ${paidUntil}, updated_at = now() where id = ${territoryId}`;
  await db()`
    update dealer_territory_fees set period_end = ${paidUntil}, period_start = ${new Date(paidUntil.getTime() - 365 * DAY)}
    where id = (select id from dealer_territory_fees where territory_id = ${territoryId} and status = 'PAID' order by period_end desc limit 1)`;
}

/**
 * Puts orders on `at` (their order_financials.delivered_at) and starts the territory's pincodes
 * and paid fees before it — as if the territory had been held and paid then.
 */
export async function backdate(territoryId: string, orderIds: string[], at: Date) {
  const before = new Date(at.getTime() - 2 * DAY);
  // Earlier checks' territories (cancelled) may have held the same pincodes "since" an old date of their own
  // arrangement: their history ends where it really began, so no instant is held by two territories.
  await db()`
    update dealer_territory_pincodes set held_from = released_at - interval '1 second'
    where pincode in (select pincode from dealer_territory_pincodes where territory_id = ${territoryId})
      and territory_id <> ${territoryId} and released_at is not null and held_from < released_at - interval '1 second'`;
  if (orderIds.length) await db()`update order_financials set delivered_at = ${at} where order_id in ${db()(orderIds)}`;
  await db()`update dealer_territory_pincodes set held_from = least(held_from, ${before}) where territory_id = ${territoryId}`;
  await db()`update dealer_territory_fees set period_start = least(period_start, ${before}) where territory_id = ${territoryId} and status = 'PAID'`;
}

/** Runs the 05:00 IST cron (/api/cron/daily) and returns what dealer-territory-daily reported. */
export async function territoryDaily(): Promise<Record<string, unknown>> {
  const res = await runCron("/api/cron/daily");
  expectStatus(res, 200, "the daily cron");
  if (res.body?.skipped) blocked(`the daily cron is already running (${JSON.stringify(res.body).slice(0, 120)})`);
  const out = res.body?.results?.["dealer-territory-daily"];
  expect(out, `dealer-territory-daily ran: ${JSON.stringify(res.body?.errors ?? []).slice(0, 300)}`).toBeTruthy();
  return out as Record<string, unknown>;
}

/* -------------------------------------------------------- month close */

/** An old calendar month (2001–2019) the local database has not closed: closing it touches nothing of today. */
export async function freeMonth(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const m = `${2001 + Math.floor(Math.random() * 18)}-${String(1 + Math.floor(Math.random() * 11)).padStart(2, "0")}`;
    const next = nextMonth(m);
    const [closed] = await db()`select 1 from dealer_commission_months where period_month in ${db()([m, next])}`;
    if (!closed) return m;
  }
  throw new Error("no unclosed month found");
}

export function nextMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** Noon IST on the 15th of `month`. */
export const midMonth = (month: string) => new Date(`${month}-15T06:30:00Z`);

/** Closes `month` as an admin does ("Close <month> now"): the month's bonuses, territory income, approvals and draft payouts. */
export async function closeMonth(month: string): Promise<Record<string, unknown>> {
  const res = await commissionAction({ action: "closeMonth", month });
  expectStatus(res, 200, `close ${month}`);
  expect(res.body.closed.alreadyClosed, `${month} was not closed before`).toBe(false);
  return res.body.closed as Record<string, unknown>;
}

export interface LedgerEntry {
  id: string;
  entry_type: string;
  kind: string;
  status: string;
  amount_paise: number;
  payee_member_id: string | null;
  payout_batch_id: string | null;
  accrual_key: string | null;
  note: string | null;
  created_at: Date;
}

/** The dealer's TERRITORY ledger entries (accruals and corrections). */
export async function territoryEntries(dealerId: string): Promise<LedgerEntry[]> {
  return db()<LedgerEntry[]>`
    select id, entry_type, kind, status, amount_paise, payee_member_id, payout_batch_id, accrual_key, note, created_at
    from dealer_commission_ledger where dealer_id = ${dealerId} and entry_type = 'TERRITORY' order by created_at, kind`;
}

/** The share of one order as the month close works it out: round(commission kept × share). */
export const shareOf = (commissionKeptPaise: number, shareBp: number) => Math.round((commissionKeptPaise * shareBp) / 10_000);

/**
 * Pays (or fails) a territory fee on the local SANDBOX gateway page, as the dealer: opens `url`
 * (default: the page the browser is on), picks UPI, presses the outcome and waits until the
 * gateway's return brings the dealer back to /dealer (the fee's return page, not the orders' one).
 */
export async function feeOnSandbox(page: Page, outcome: "pay" | "fail", url?: string) {
  if (url) await page.goto(url);
  await page.waitForURL(/\/orders\/pay\/sandbox\//);
  const box = page.getByTestId("sandbox-checkout");
  await expect(box).toBeVisible();
  await box.getByLabel("UPI", { exact: true }).check();
  await box.getByTestId(`sandbox-${outcome}`).click();
  await page.waitForURL((u) => u.pathname === "/dealer", { timeout: 45_000 });
}

/**
 * The "Your territory" card on /dealer. Its test id (dealer-territory) is also used by the older
 * "Your areas" card of the dealer board, so the card is the one with the "Your territory" heading.
 */
export function territoryCard(page: Page): Locator {
  return page.getByTestId("dealer-territory").filter({ has: page.getByRole("heading", { name: "Your territory", exact: true }) });
}

/** "₹4,000" / "₹3.2" as the dealer and admin cards print an amount. */
export const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
