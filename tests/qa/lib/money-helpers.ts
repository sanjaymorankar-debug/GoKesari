/**
 * Helpers for QA package 4 — wallet, vouchers, the payment gateway, cash on
 * delivery, subscriptions and notifications (tests/qa/{signed-in,local}/money-*.spec.ts).
 *
 * Payments on a local server: a production build with no Cashfree keys.
 *   - Orders paid online go through the SANDBOX gateway (PAYMENT_GATEWAY unset =
 *     SANDBOX): checkout returns /orders/pay/sandbox/<ref>, whose Pay / Fail /
 *     Let it expire buttons post a signed webhook through the real handler.
 *     Rule onlinePayments is OFF by default; the online specs switch it on
 *     locally (file-level hooks) and restore it afterwards.
 *   - Wallet top-ups do NOT use the gateway layer: with no Cashfree keys they
 *     run in MOCK mode, whose only settle path (/api/dev/settle-topup) is 404 in
 *     a production build, so a top-up can be started but never paid locally.
 *
 * Every writing helper calls assertWritable(); local-only helpers (rules,
 * database, signed webhooks, crons) block or throw anywhere but a local run.
 */
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, request as playwrightRequest, type APIRequestContext, type Page } from "@playwright/test";

import { as, me } from "./actors";
import { db } from "./db";
import { addToCart, defaultAddress, emptyCart, shopListings, type Listing } from "./flows";
import { call, expectStatus, RUN, SLOW_MS, why, type Answer } from "./http";
import { blocked, need } from "./record";
import { assertWritable, BASE_URL, IS_LOCAL } from "./target";
import { world, type Role } from "./world";

/* ---------------------------------------------------------------- dates */

/** A calendar date in the app's time zone (IST), `offsetDays` from today. */
export function istDate(offsetDays = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a YYYY-MM-DD date. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A stash key that survives a worker restart within one `playwright test`
 * run: workers are children of the runner, so their parent pid is shared,
 * while lib/http's RUN is per worker (a failed check restarts the worker and
 * a RUN-based key would no longer find what earlier checks stashed).
 */
export function runKey(name: string): string {
  return `${name}-${process.ppid}`;
}

/* ----------------------------------------------------- business rules (local) */

export interface RuleRow {
  key: string;
  value: Record<string, unknown>;
  overridden: boolean;
}

export async function ruleOf(key: string): Promise<RuleRow> {
  const res = await call(await as("admin"), "GET", "/api/admin/settings");
  expectStatus(res, 200, "GET /api/admin/settings");
  const row = (res.body?.rules as RuleRow[] | undefined)?.find((r) => r.key === key);
  if (!row) throw new Error(`rule ${key} not found`);
  return row;
}

export async function putRule(key: string, value: Record<string, unknown>) {
  const res = await call(await as("admin"), "PUT", "/api/admin/settings", { key, value });
  expectStatus(res, 200, `PUT rule ${key}`);
  return res.body?.value as Record<string, unknown>;
}

/** Puts a rule back as it was (its default when it was not overridden). */
export async function restoreRule(before: RuleRow) {
  const admin = await as("admin");
  const res = before.overridden
    ? await call(admin, "PUT", "/api/admin/settings", { key: before.key, value: before.value })
    : await call(admin, "DELETE", `/api/admin/settings?key=${encodeURIComponent(before.key)}`);
  expectStatus(res, 200, `restore rule ${before.key}`);
}

/** Runs `fn` with a rule changed (local runs only) and restores it in a finally block. */
export async function withRule<T>(key: string, patch: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  if (!IS_LOCAL) blocked(`changing rule ${key} is for local runs only`);
  assertWritable(`change rule ${key}`);
  const before = await ruleOf(key);
  await putRule(key, { ...before.value, ...patch });
  try {
    return await fn();
  } finally {
    await restoreRule(before);
  }
}

/* -------------------------------------------------- online order payments */

export const ONLINE_OFF = /Online payment is not available/i;

export interface OnlinePayment {
  intentId: string;
  status: string;
  amountPaise: number;
  redirectUrl: string | null;
  alreadyPaid: boolean;
}

export interface CheckoutOrder {
  id: string;
  orderNumber: string;
  shopId: string;
  totalPaise: number;
  status: string;
  paymentMethod: string;
}

export interface OnlineCheckout {
  requestId: string;
  orders: CheckoutOrder[];
  payment: OnlinePayment;
  res: Answer;
}

/** Fills the cart with `lines` (emptied first). Refusals the site may make block the case. */
export async function fillCart(role: Role, lines: { listing: Listing; quantity?: number }[]) {
  assertWritable("fill a cart");
  await emptyCart(role);
  for (const line of lines) {
    const added = await addToCart(role, line.listing.shopProductId, line.quantity ?? 1);
    if (added.status === 409 || added.status === 422) blocked(`"${line.listing.name}" cannot be added to the cart — ${why(added)}`);
    expectStatus(added, [200, 201], `add ${line.listing.name}`);
  }
}

/** POST /api/checkout with the cart as it is. */
export async function checkoutNow(role: Role, method: "WALLET" | "COD" | "ONLINE", shopIds: string[], extra: Record<string, unknown> = {}, requestId = `qa-${RUN}-${randomUUID().slice(0, 8)}`) {
  assertWritable("check out");
  const address = await defaultAddress(role);
  const body = { requestId, addressId: address?.id ?? null, paymentMethod: method, acknowledgeClosedShopIds: shopIds, ...extra };
  let res = await call(await as(role), "POST", "/api/checkout", body);
  // 15 checkouts a minute per customer: wait the minute out rather than mistake the limit for a refusal.
  if (res.status === 429) {
    await sleep(61_000);
    res = await call(await as(role), "POST", "/api/checkout", body);
  }
  return { res, requestId };
}

/** Cart → checkout → the created order (any method), waiting out the checkout limit. */
export async function placeVia(role: Role, method: "WALLET" | "COD", listing: Listing, quantity = 1) {
  await fillCart(role, [{ listing, quantity }]);
  const { res, requestId } = await checkoutNow(role, method, [listing.shopId]);
  if (res.status === 409 || res.status === 422) blocked(`checkout (${method}) refused — ${why(res)}`);
  expectStatus(res, 201, `${method} checkout`);
  const order = res.body.orders[0] as CheckoutOrder;
  return { ...order, requestId, listing };
}

/** Cart → checkout with "Pay online". Blocks when online payment is off on this site. */
export async function onlineCheckout(role: Role, lines: { listing: Listing; quantity?: number }[], extra: Record<string, unknown> = {}): Promise<OnlineCheckout> {
  await fillCart(role, lines);
  const { res, requestId } = await checkoutNow(role, "ONLINE", [...new Set(lines.map((l) => l.listing.shopId))], extra);
  if (res.status === 409 && ONLINE_OFF.test(why(res))) blocked("online payment is off on this site (rule onlinePayments) — " + why(res));
  expectStatus(res, 201, "online checkout");
  const payment = res.body?.payment as OnlinePayment | undefined;
  expect(payment?.intentId, `a payment intent in ${JSON.stringify(res.body).slice(0, 300)}`).toBeTruthy();
  return { requestId, orders: res.body.orders as CheckoutOrder[], payment: payment!, res };
}

/** The sandbox page of a payment, or blocks when this site's gateway is not the sandbox. */
export function sandboxPath(payment: Pick<OnlinePayment, "redirectUrl">): string {
  const url = payment.redirectUrl ?? "";
  const path = url.startsWith("http") ? new URL(url).pathname : url;
  if (!/^\/orders\/pay\/sandbox\//.test(path)) {
    blocked(`online payments on this site open ${url || "no page"} (not the sandbox gateway); pay through the "Sandbox payment" workflow with Cashfree sandbox test data`);
  }
  return path;
}

export type SandboxOutcome = "pay" | "fail" | "expire";

/** Opens the sandbox hosted page as the customer, picks a method and presses the outcome; waits for the return page. */
export async function paySandbox(page: Page, payment: Pick<OnlinePayment, "redirectUrl">, outcome: SandboxOutcome, method: "UPI" | "Card" | "Netbanking" = "UPI") {
  const path = sandboxPath(payment);
  await page.goto(path);
  const box = page.getByTestId("sandbox-checkout");
  await expect(box).toBeVisible();
  await box.getByLabel(method, { exact: true }).check();
  await box.getByTestId(`sandbox-${outcome}`).click();
  await page.waitForURL(/\/orders\/payment-return\?intent=/, { timeout: 45_000 });
  const ret = page.getByTestId("payment-return");
  await expect(ret).toBeVisible();
  return ret;
}

export async function intentView(role: Role, intentId: string) {
  const res = await call(await as(role), "GET", `/api/payments/intents/${intentId}`);
  expectStatus(res, 200, "GET /api/payments/intents/<id>");
  return res.body as { intentId: string; status: string; amountPaise: number; refundedPaise: number; failureReason: string | null; canRetry: boolean; redirectUrl: string | null; orders: { id: string; orderNumber: string; status: string }[] };
}

/* ------------------------------------------- sandbox webhooks (local only) */

/** The sandbox webhook secret of a local production build (src/server/payments/gateway/sandbox.ts). */
function sandboxSecret(): string {
  if (!IS_LOCAL) blocked("signing gateway webhooks needs the local server's secret (local runs only)");
  const own = process.env.PAYMENT_WEBHOOK_SECRET_SANDBOX;
  if (own) return own;
  const secret = need(process.env.AUTH_SECRET, "AUTH_SECRET of the local server");
  return createHmac("sha256", secret).update("gokesari-test-secret:sandbox-payment-webhook").digest("hex");
}

export interface SandboxWebhookBody {
  eventId?: string;
  type: string;
  merchantOrderId: string | null;
  gatewayOrderId: string | null;
  paymentId: string | null;
  merchantRefundId?: string | null;
  refundId?: string | null;
  amountPaise: number | null;
}

/** POSTs a webhook to /api/webhooks/payments/sandbox signed as the sandbox gateway signs it (or with `signature`). */
export async function postSandboxWebhook(body: SandboxWebhookBody, options: { signature?: string; timestamp?: string } = {}) {
  assertWritable("post a gateway webhook");
  const raw = JSON.stringify({ ...body, eventId: body.eventId ?? `sbxevt_qa_${randomUUID()}`, occurredAt: new Date().toISOString() });
  const timestamp = options.timestamp ?? String(Date.now());
  const signature = options.signature ?? createHmac("sha256", sandboxSecret()).update(`${timestamp}.${raw}`).digest("hex");
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const res = await ctx.fetch(new URL("/api/webhooks/payments/sandbox", BASE_URL).toString(), {
      method: "POST",
      data: raw,
      headers: { "content-type": "application/json", "x-sandbox-timestamp": timestamp, "x-sandbox-signature": signature },
      failOnStatusCode: false,
      timeout: SLOW_MS,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status(), body: parsed, text, raw };
  } finally {
    await ctx.dispose();
  }
}

/** The sandbox ledger row and intent row of a payment (local database). */
export async function intentRows(intentId: string) {
  const [intent] = await db()`select * from payment_intents where id = ${intentId}`;
  const [sandbox] = intent?.gateway_order_id ? await db()`select * from payment_sandbox_orders where gateway_order_id = ${intent.gateway_order_id}` : [];
  return { intent, sandbox };
}

/* ----------------------------------------------------------- crons (local) */

export async function runCron(path: string, body: Record<string, unknown> = {}): Promise<Answer> {
  if (!IS_LOCAL) blocked("running a cron job needs the local server's CRON_SECRET (local runs only)");
  assertWritable(`run ${path}`);
  const secret = need(process.env.CRON_SECRET, "CRON_SECRET of the local server");
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    let res = await call(ctx, "POST", path, body, { headers: { authorization: `Bearer ${secret}` } });
    for (let i = 0; i < 3 && res.status === 429; i++) {
      await sleep(20_000);
      res = await call(ctx, "POST", path, body, { headers: { authorization: `Bearer ${secret}` } });
    }
    return res;
  } finally {
    await ctx.dispose();
  }
}

/* ------------------------------------------------------- wallet (helpers) */

export async function walletOf(role: Role) {
  const res = await call(await as(role), "GET", "/api/wallet");
  expectStatus(res, 200, "GET /api/wallet");
  return res.body as {
    wallet: { id: string; balancePaise: number; promotionalBalancePaise: number; lowBalanceThresholdPaise: number; autoRechargeEnabled: boolean; autoRechargeTriggerPaise: number | null; autoRechargeAmountPaise: number | null };
    todaysDeductionPaise: number;
    isLowBalance: boolean;
    forecast: { horizonDays: number; upcomingCostPaise: number; sufficient: boolean; recommendedTopUpPaise: number };
    transactions: { id: string; type: string; amountPaise: number; promotionalAmountPaise?: number; description: string; orderId: string | null }[];
  };
}

/**
 * Local only: moves a wallet to exactly `targetPaise` with one ledger row
 * (MANUAL_CREDIT / MANUAL_DEBIT), as an operator's adjustment would — the
 * arrangement a top-up would make, which cannot be paid on a local server.
 * `promotionalPaise` sets the promotional slice (PROMOTIONAL_CREDIT row).
 */
export async function arrangeWallet(role: Role, targetPaise: number, promotionalPaise?: number) {
  if (!IS_LOCAL) blocked("setting a wallet balance directly is for local runs only");
  const userId = need(world().users[role]?.id, `${role} account`);
  const sql = db();
  await sql.begin(async (tx) => {
    const [w] = await tx`select id, balance_paise, promotional_balance_paise from wallets where user_id = ${userId} for update`;
    if (!w) throw new Error(`no wallet for ${role}`);
    const balance = Number(w.balance_paise);
    const promo = Number(w.promotional_balance_paise);
    // First drop the promotional slice when it must change (a debit that takes promotional money).
    let current = balance;
    let currentPromo = promo;
    const write = async (type: string, amount: number, promoAmount: number) => {
      if (amount === 0) return;
      const next = current + amount;
      await tx`insert into wallet_transactions (wallet_id, user_id, type, amount_paise, promotional_amount_paise, previous_balance_paise, new_balance_paise, idempotency_key, description)
               values (${w.id}, ${userId}, ${type}, ${amount}, ${promoAmount}, ${current}, ${next}, ${`qa-arrange-${RUN}-${randomUUID()}`}, ${"QA arrangement (local test server)"})`;
      current = next;
      currentPromo += promoAmount;
      await tx`update wallets set balance_paise = ${current}, promotional_balance_paise = ${currentPromo}, updated_at = now() where id = ${w.id}`;
    };
    const wantPromo = promotionalPaise ?? Math.min(currentPromo, targetPaise);
    if (currentPromo > wantPromo) await write("MANUAL_DEBIT", -(currentPromo - wantPromo), -(currentPromo - wantPromo));
    const funded = targetPaise - wantPromo;
    const fundedNow = current - currentPromo;
    if (funded !== fundedNow) await write(funded > fundedNow ? "MANUAL_CREDIT" : "MANUAL_DEBIT", funded - fundedNow, 0);
    if (currentPromo < wantPromo) await write("PROMOTIONAL_CREDIT", wantPromo - currentPromo, wantPromo - currentPromo);
  });
  return walletOf(role);
}

/* ------------------------------------------------------------ orders, stock */

export interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  paymentMethod: string;
  totalPaise: number;
  paidAt: string | null;
  shopId: string;
  source: string;
  orderGroupId: string | null;
  codCollectedAt: string | null;
  refundedPaise: number;
  addressId: string | null;
  deliveryAddressSnapshot: Record<string, unknown> | null;
  societyId: string | null;
}

export async function ordersOf(role: Role): Promise<OrderRow[]> {
  const res = await call(await as(role), "GET", "/api/orders");
  expectStatus(res, 200, "GET /api/orders");
  return (Array.isArray(res.body) ? res.body : (res.body?.orders ?? [])) as OrderRow[];
}

export async function orderOf(role: Role, id: string): Promise<OrderRow | null> {
  return (await ordersOf(role)).find((o) => o.id === id) ?? null;
}

/** Online stock of a listing (undefined when not tracked), as operations see it. */
export async function onlineStock(listing: Pick<Listing, "shopId" | "shopProductId">): Promise<number | undefined> {
  const row = (await shopListings(listing.shopId)).find((r) => r.shopProductId === listing.shopProductId);
  return row?.trackInventory ? row.onlineStock : undefined;
}

export async function cancelAsCustomer(role: Role, orderId: string, note = "QA cancel") {
  return call(await as(role), "PATCH", `/api/orders/${orderId}/status`, { status: "CANCELLED", note });
}

/** A listing of the world (local) — blocks when this site's test data does not have it. */
export async function worldListing(key: "packaged" | "milk" | "premium" | "sharedA" | "sharedB" | "lowStock" | "loose", shop: "A" | "B" = key === "sharedB" ? "B" : "A"): Promise<Listing> {
  const preset = need(world().listings[key], `the "${key}" listing in this site's test data`);
  const s = need(world().shops[shop], `shop ${shop}`);
  const { shopOf } = await import("./flows");
  const resolved = await shopOf(shop);
  return { ...preset, shopId: s.id ?? resolved.id, shopName: s.name };
}

/* ------------------------------------------------------------ notifications */

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
  actionUrl?: string | null;
}

export async function notificationsOf(role: Role) {
  const res = await call(await as(role), "GET", "/api/notifications");
  expectStatus(res, 200, "GET /api/notifications");
  return res.body as { notifications: NotificationRow[]; unreadCount: number };
}

/** Waits until `role` has a notification matching `match` created after `since` (ms epoch). */
export async function waitForNotification(role: Role, match: (n: NotificationRow) => boolean, since: number, timeoutMs = 20_000): Promise<NotificationRow | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { notifications } = await notificationsOf(role);
    const hit = notifications.find((n) => new Date(n.createdAt).getTime() >= since - 2000 && match(n));
    if (hit) return hit;
    await sleep(1000);
  }
  return null;
}

/* ------------------------------------------------------------ subscriptions */

export interface CalendarDay {
  date: string;
  delivers: boolean;
  quantityMilli: number;
  reason: string;
  isOverridden: boolean;
  estimatedCostPaise: number;
  generatedStatus: string | null;
}

export async function createSubscription(role: Role, input: Record<string, unknown>) {
  assertWritable("create a subscription");
  return call(await as(role), "POST", "/api/subscriptions", input);
}

export async function subscription(role: Role, id: string) {
  const res = await call(await as(role), "GET", `/api/subscriptions/${id}`);
  expectStatus(res, 200, "GET /api/subscriptions/<id>");
  return res.body as { id: string; status: string; quantityMilli: number; addressId: string | null; startDate: string; endDate: string | null; pauseFrom: string | null; pauseUntil: string | null; nextDeliveryDate: string | null };
}

export async function calendar(role: Role, id: string, days = 14): Promise<CalendarDay[]> {
  const res = await call(await as(role), "GET", `/api/subscriptions/${id}/calendar?days=${days}`);
  expectStatus(res, 200, "subscription calendar");
  return res.body as CalendarDay[];
}

export async function history(role: Role, id: string): Promise<{ action: string; fromStatus: string | null; toStatus: string | null; note: string | null }[]> {
  const res = await call(await as(role), "GET", `/api/subscriptions/${id}/history`);
  expectStatus(res, 200, "subscription history");
  return res.body;
}

/** A fresh ACTIVE daily subscription to the world's milk (default 2 L, from tomorrow). */
export async function newMilkSubscription(role: Role = "customer", input: Record<string, unknown> = {}) {
  const milk = await worldListing("milk");
  const address = await defaultAddress(role);
  const res = await createSubscription(role, {
    shopProductId: milk.shopProductId,
    quantityMilli: 2000,
    frequency: "DAILY",
    weekdays: [],
    startDate: istDate(1),
    addressId: address?.id ?? null,
    ...input,
  });
  if (res.status === 409) blocked(`the milk listing cannot be subscribed to — ${why(res)}`);
  expectStatus(res, 201, "create subscription");
  return { id: String(res.body.id), body: res.body, milk };
}

/** Cancels test subscriptions so the cron and forecasts of later checks see only their own. */
export async function cancelSubscriptionQuietly(role: Role, id: string) {
  await call(await as(role), "DELETE", `/api/subscriptions/${id}`, { reason: "QA clean-up" }).catch(() => undefined);
}

/* ----------------------------------------------------------------- misc */

export async function userIdOf(role: Role) {
  return world().users[role]?.id ?? (await me(role)).id;
}

export type { APIRequestContext };

/* ------------------------------------------------- mail (local catcher) */

/** Quoted-printable → bytes → UTF-8 (lib/mail decodes byte by byte, which garbles Hindi and "—"). */
export function decodeQuotedPrintable(raw: string): string {
  const soft = raw.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const hex = soft.slice(i + 1, i + 3);
    if (soft[i] === "=" && /^[0-9A-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(...Buffer.from(soft[i], "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** RFC 2047 encoded words (=?UTF-8?Q?…?= / =?UTF-8?B?…?=) in a header. */
export function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?utf-8\?([qb])\?([^?]*)\?=/gi, (_, enc: string, text: string) =>
      enc.toLowerCase() === "b" ? Buffer.from(text, "base64").toString("utf8") : decodeQuotedPrintable(text.replace(/_/g, " ")),
    );
}

export interface Mail {
  at: number;
  subject: string;
  text: string;
}

/** Mails the local mail catcher received for `to` since `since` (ms epoch), newest first, decoded. */
export function mailsTo(to: string, since: number): Mail[] {
  if (!IS_LOCAL) blocked("reading e-mail is for local runs (the local mail catcher)");
  const dir = process.env.QA_MAIL_DIR ?? join("test-results", "qa", "mail");
  if (!existsSync(dir)) return [];
  const needle = to.toLowerCase().replace(/[^a-z0-9@.+-]/gi, "_");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".eml") && f.toLowerCase().includes(needle))
    .map((f) => ({ f, at: Number(f.split("-")[0]) || 0 }))
    .filter((m) => m.at >= since)
    .sort((a, b) => b.at - a.at)
    .map(({ f, at }) => {
      const raw = readFileSync(join(dir, f), "utf8");
      const header = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
      const subject = decodeHeader(header.match(/^Subject:\s*(.*)$/im)?.[1]?.trim() ?? "");
      return { at, subject, text: decodeQuotedPrintable(raw) };
    });
}

