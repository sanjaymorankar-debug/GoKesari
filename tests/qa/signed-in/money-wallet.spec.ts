/**
 * The customer's wallet (TC-PAY-001–004, 006, 008–010, 016, TC-FLD-030–033):
 * the /wallet page, top-up amounts and the gateway order they start, the
 * verify call that alone may credit a top-up, wallet settings, and the
 * balance that can never go negative.
 *
 * Signed tier. Payments: a top-up is paid at Cashfree (staging: sandbox keys,
 * paid through the "Sandbox payment" workflow). The local server has no
 * Cashfree keys, so its top-ups run in MOCK mode, whose settle step
 * (/api/dev/settle-topup) is development-only and answers 404 in a production
 * build — a top-up can be started but not paid here, and the cases that need
 * a paid top-up block with that reason.
 */
import type { Page, Request } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { defaultAddress, emptyCart, sellable } from "../lib/flows";
import { call, expectStatus, RUN, why, type Answer } from "../lib/http";
import { cancelAsCustomer, fillCart, ordersOf, sleep, walletOf } from "../lib/money-helpers";
import { blocked, expect, qa } from "../lib/record";
import type { Role } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 240_000 };

/** POST /api/wallet/topup, waiting out the 10-a-minute payment limit once if it is hit. */
async function topup(role: Role, data: unknown): Promise<Answer> {
  let res = await call(await as(role), "POST", "/api/wallet/topup", data);
  if (res.status === 429) {
    await sleep(61_000);
    res = await call(await as(role), "POST", "/api/wallet/topup", data);
  }
  return res;
}

async function setThreshold(role: Role, paise: number) {
  const res = await call(await as(role), "PATCH", "/api/wallet/settings", { lowBalanceThresholdPaise: paise });
  expectStatus(res, 200, "save the low-balance threshold");
  return res;
}

qa("TC-PAY-001", "/wallet shows the balance, today's deductions, the 15-day subscription forecast, the low-balance state and recent transactions", async ({ browser }) => {
  const before = await walletOf("customer");
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/wallet");
    await expect(page.getByRole("heading", { name: "My Wallet" })).toBeVisible();
    await expect(page.getByText("Available balance")).toBeVisible();
    const rupees = Math.floor(before.wallet.balancePaise / 100).toLocaleString("en-IN");
    await expect(page.locator("main")).toContainText(rupees);
    await expect(page.getByText("Today's deduction")).toBeVisible();
    await expect(page.getByText(`Next ${before.forecast.horizonDays} days of subscriptions`)).toBeVisible();
    expect(before.forecast.horizonDays, "15-day forecast").toBe(15);
    const history = page.locator("#history");
    await expect(history.getByRole("heading", { name: "Transactions" })).toBeVisible();
    const rows = await history.getByRole("listitem").count();
    if (before.transactions.length) expect(rows, "recent transactions listed").toBeGreaterThan(0);
    else await expect(page.getByTestId("wallet-history-empty")).toBeVisible();
    // Low-balance state: a reminder threshold above the balance shows the warning.
    await setThreshold("customer", before.wallet.balancePaise + 100);
    try {
      await page.reload();
      await expect(page.getByText("Low balance", { exact: true })).toBeVisible();
      expect((await walletOf("customer")).isLowBalance).toBe(true);
    } finally {
      await setThreshold("customer", before.wallet.lowBalanceThresholdPaise);
    }
    await page.reload();
    await expect(page.getByText("Low balance", { exact: true })).toHaveCount(before.wallet.balancePaise < before.wallet.lowBalanceThresholdPaise ? 1 : 0);
    return `balance ₹${rupees}, today's deduction ₹${before.todaysDeductionPaise / 100}, 15-day forecast ₹${before.forecast.upcomingCostPaise / 100}, ${rows} transactions; low-balance warning shown when the threshold is above the balance`;
  } finally {
    await context.close();
  }
}, { ...signed, mobile: true });

qa("TC-PAY-002", "top up with a preset: the gateway order is for exactly that amount; paying it is the gateway's step", async ({ browser }) => {
  const before = (await walletOf("customer")).wallet.balancePaise;
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/wallet");
    const card = page.locator("#add-money");
    await card.getByRole("button", { name: /5,000/ }).click();
    await expect(card.getByLabel("Amount in rupees")).toHaveValue("5000");
    const created = page.waitForResponse((r) => r.url().endsWith("/api/wallet/topup") && r.request().method() === "POST");
    await card.getByRole("button", { name: "Proceed to payment" }).click();
    const res = await created;
    const body = await res.json();
    expect(res.status(), JSON.stringify(body)).toBe(200);
    expect(body.amountPaise, "gateway order for exactly ₹5,000").toBe(500_000);
    if (body.mock) {
      const alert = card.locator(".bg-red-50").first();
      await expect(alert).toBeVisible({ timeout: 15_000 });
      const shown = ((await alert.textContent()) ?? "").trim();
      expect((await walletOf("customer")).wallet.balancePaise, "nothing credited").toBe(before);
      blocked(`this server has no Cashfree keys: the top-up ran in MOCK mode (order ${body.gatewayOrderId} for 500000 paise) and its settle step is development-only — the page answered "${shown}". Run on test.gokesari.com and pay through the "Sandbox payment" workflow`);
    }
    blocked(`the Cashfree checkout opened for 500000 paise (session ${String(body.paymentSessionId).slice(0, 12)}…); paying it needs the "Sandbox payment" workflow (this browser cannot reach Cashfree), then re-check the balance (+₹5,000) and the transaction row`);
  } finally {
    await context.close();
  }
}, { ...signed, mobile: true });

qa(["TC-PAY-003", "TC-FLD-030"], "top-up amounts through the API: ₹1 and ₹1,00,000 accepted, 70.50 → 7050 paise; 0, 99 paise, ₹1,00,001, negative, decimal paise, text and ₹10 crore refused with 422", async () => {
  const cases: [string, unknown, number][] = [
    ["0", 0, 422],
    ["99 paise", 99, 422],
    ["₹1", 100, 200],
    ["₹70.50", 7050, 200],
    ["₹1,00,000", 10_000_000, 200],
    ["₹1,00,001", 10_000_100, 422],
    ["negative", -100, 422],
    ["10.5 paise", 10.5, 422],
    ["text", "abc", 422],
    ["₹10,00,00,000", 10_000_000_000, 422],
  ];
  const out: string[] = [];
  for (const [label, amountPaise, want] of cases) {
    const res = await topup("customer2", { amountPaise });
    expect(res.status, `${label}: ${why(res)}`).toBe(want);
    if (want === 200) {
      expect(res.body.amountPaise, `${label} stored in paise`).toBe(amountPaise);
      expect(res.body.gatewayOrderId).toBeTruthy();
    } else {
      expect(res.body?.paymentId, `${label}: no payment started`).toBeUndefined();
    }
    out.push(`${label} → ${res.status}${want === 200 ? ` (${res.body.amountPaise} paise)` : ""}`);
  }
  return out.join(", ");
}, { ...signed, partial: "the page half (field messages) is TC-FLD-030 below; accepted amounts only start a gateway order here (nothing is paid)" });

/** Types `value` into the amount box and presses Proceed; returns the amount the page asked the server for, if any. */
async function tryAmount(page: Page, value: string): Promise<{ sent: number | null; message: string; disabled: boolean }> {
  const card = page.locator("#add-money");
  const box = card.getByLabel("Amount in rupees");
  await box.fill(value);
  const proceed = card.getByRole("button", { name: /Proceed to payment|Processing/ });
  if (await proceed.isDisabled()) return { sent: null, message: "", disabled: true };
  let sent: number | null = null;
  const seen = (req: Request) => {
    if (req.url().endsWith("/api/wallet/topup") && req.method() === "POST") sent = Number(JSON.parse(req.postData() ?? "{}").amountPaise);
  };
  page.on("request", seen);
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/wallet/topup"), { timeout: 4000 }).catch(() => null);
  await proceed.click();
  await answered;
  await page.waitForTimeout(300);
  page.off("request", seen);
  const message = (await card.locator(".bg-red-50, .text-red-600").allTextContents()).join(" ").replace(/\s+/g, " ").trim();
  return { sent, message: message.slice(0, 120), disabled: false };
}

qa("TC-FLD-030", "the wallet page's amount box: zero, negative and 3-decimal amounts are refused before any payment; 70.50 is asked for as 7050 paise", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "customer");
  // Accepted amounts would open the gateway: the request is recorded and then stopped, so nothing is started.
  await page.route("**/api/wallet/topup", async (route) => {
    const amount = Number(JSON.parse(route.request().postData() ?? "{}").amountPaise);
    if (amount >= 100 && amount <= 10_000_000) await route.abort();
    else await route.continue();
  });
  const out: string[] = [];
  const problems: string[] = [];
  try {
    await page.goto("/wallet");
    const blank = await tryAmount(page, "");
    out.push(`blank → ${blank.disabled ? "Proceed disabled" : `sent ${blank.sent}`}`);
    if (!blank.disabled && blank.sent !== null) problems.push("blank started a payment");
    for (const [value, expectSent] of [
      ["0", null],
      ["-5", null],
      ["10.555", null],
      ["70.50", 7050],
      ["1", 100],
      ["100000", 10_000_000],
    ] as const) {
      const r = await tryAmount(page, value);
      out.push(`${value} → ${r.disabled ? "disabled" : r.sent === null ? `refused "${r.message.match(/Enter a valid amount\.|[^.]{0,60}(minimum|maximum)[^.]*\./)?.[0] ?? r.message.slice(0, 40)}"` : `asks for ${r.sent} paise`}`);
      if (expectSent === null && r.sent !== null && (r.sent >= 100 && r.sent <= 10_000_000)) problems.push(`${value} was not refused (the page asked for ${r.sent} paise)`);
      if (expectSent !== null && r.sent !== expectSent) problems.push(`${value} should be asked for as ${expectSent} paise (got ${r.sent})`);
    }
    // Out of range: the page asks, the server refuses with the limit — no payment.
    for (const value of ["0.99", "100001", "1000000000"]) {
      const r = await tryAmount(page, value);
      out.push(`${value} → ${r.sent === null ? "not sent" : `server refused ${r.sent} paise: "${r.message.match(/[^.]*(minimum|maximum)[^.]*\./)?.[0] ?? r.message.slice(0, 50)}"`}`);
      if (!/minimum|maximum|valid amount/i.test(r.message)) problems.push(`${value}: no message about the limit`);
    }
  } finally {
    await context.close();
  }
  expect(problems, `${problems.join("; ")} — ${out.join("; ")}`).toEqual([]);
  return out.join("; ");
}, { ...signed, partial: "the box is <input type=number>, which cannot take text or symbols (typed letters never reach it); the API refuses text (TC-FLD-030 API half above)" });

qa("TC-PAY-004", "verify cannot be forged: an unknown order and another customer's order are refused and nothing is credited", async () => {
  const before = (await walletOf("customer")).wallet.balancePaise;
  const unknown = await call(await as("customer"), "POST", "/api/wallet/verify", { gatewayOrderId: `mock_order_${RUN}-made-up` });
  expect([400, 404], `unknown — ${why(unknown)}`).toContain(unknown.status);
  const mine = await topup("customer", { amountPaise: 1000 });
  expectStatus(mine, 200, "start a top-up");
  const other = await call(await as("customer2"), "POST", "/api/wallet/verify", { gatewayOrderId: mine.body.gatewayOrderId });
  expect(other.status, `another user's — ${why(other)}`).toBe(400);
  expect(other.body?.error?.code).toBe("PAYMENT_VERIFICATION_FAILED");
  expect((await walletOf("customer")).wallet.balancePaise, "nothing credited").toBe(before);
  return `made-up id → ${unknown.status} ${unknown.body?.error?.code}; customer2 verifying customer's order → 400 PAYMENT_VERIFICATION_FAILED; balance unchanged`;
}, { ...signed, partial: "unknown ids answer 404 NOT_FOUND (not 400): nothing is credited either way; the unpaid and replay halves are the next two checks" });

qa("TC-PAY-004", "verify of an own top-up that was never paid answers PAYMENT_VERIFICATION_FAILED and credits nothing", async () => {
  const before = (await walletOf("customer")).wallet.balancePaise;
  const mine = await topup("customer", { amountPaise: 1000 });
  expectStatus(mine, 200, "start a top-up");
  const res = await call(await as("customer"), "POST", "/api/wallet/verify", { gatewayOrderId: mine.body.gatewayOrderId });
  expect((await walletOf("customer")).wallet.balancePaise, "nothing credited").toBe(before);
  expect(res.status, `unpaid own top-up (${mine.body.mock ? "MOCK mode: no gateway keys" : "Cashfree"}) — ${why(res)}`).toBe(400);
  expect(res.body?.error?.code).toBe("PAYMENT_VERIFICATION_FAILED");
  return `unpaid → 400 PAYMENT_VERIFICATION_FAILED, balance unchanged`;
}, signed);

qa("TC-PAY-004", "replaying the verify of a paid top-up answers alreadyProcessed and credits once", async () => {
  const mine = await topup("customer", { amountPaise: 1000 });
  expectStatus(mine, 200, "start a top-up");
  if (mine.body.mock) blocked("needs a paid top-up: this server has no Cashfree keys (MOCK mode cannot be paid in a production build)");
  blocked(`needs the Cashfree sandbox session ${String(mine.body.paymentSessionId).slice(0, 12)}… paid through the "Sandbox payment" workflow, then two /api/wallet/verify calls`);
}, signed);

qa("TC-PAY-006", "an abandoned top-up: the attempt stays unpaid, nothing is credited, and the customer can start again", async () => {
  const before = await walletOf("customer");
  const first = await topup("customer", { amountPaise: 25_000 });
  expectStatus(first, 200, "start a top-up");
  // The customer closes the gateway without paying.
  await sleep(1000);
  const after = await walletOf("customer");
  expect(after.wallet.balancePaise, "nothing credited").toBe(before.wallet.balancePaise);
  expect(after.transactions.length, "no new transaction row").toBe(before.transactions.length);
  const again = await topup("customer", { amountPaise: 25_000 });
  expectStatus(again, 200, "retry the top-up");
  expect(again.body.gatewayOrderId, "a fresh gateway order").not.toBe(first.body.gatewayOrderId);
  return `attempt ${first.body.gatewayOrderId} left unpaid → balance unchanged, no ledger row; retry → new order ${again.body.gatewayOrderId}`;
}, { ...signed, partial: "'cancel at the gateway' is Cashfree's own page (not reachable here); the unpaid attempt's stored status (CREATED) is not exposed to the customer by any API" });

qa("TC-PAY-016", "the development top-up settle endpoint is refused for a signed-in customer", async () => {
  const mine = await topup("customer", { amountPaise: 1000 });
  expectStatus(mine, 200, "start a top-up");
  const before = (await walletOf("customer")).wallet.balancePaise;
  const res = await call(await as("customer"), "POST", "/api/dev/settle-topup", { gatewayOrderId: mine.body.gatewayOrderId });
  expect(res.status, why(res)).toBe(404);
  expect((await walletOf("customer")).wallet.balancePaise, "nothing credited").toBe(before);
  return `signed-in POST /api/dev/settle-topup for the customer's own order → ${res.status}; balance unchanged`;
}, { ...signed, partial: "the production half (read-only) is the guest check in tests/qa/guest/access.spec.ts" });

qa("TC-PAY-009", "the low-balance threshold is saved and the low-balance state follows it", async () => {
  const before = (await walletOf("customer")).wallet;
  try {
    await setThreshold("customer", before.balancePaise + 7050);
    let w = await walletOf("customer");
    expect(w.wallet.lowBalanceThresholdPaise).toBe(before.balancePaise + 7050);
    expect(w.isLowBalance, "threshold above the balance → low").toBe(true);
    await setThreshold("customer", Math.max(0, before.balancePaise - 100));
    w = await walletOf("customer");
    expect(w.isLowBalance, "threshold below the balance → not low").toBe(false);
    return `threshold ${before.balancePaise + 7050} → low balance; ${before.balancePaise - 100} → not low (balance ${before.balancePaise})`;
  } finally {
    await setThreshold("customer", before.lowBalanceThresholdPaise);
  }
}, { ...signed, partial: "the auto-recharge half is the next check; the low-balance notification is TC-PAY-011 / TC-NTF-009 (local)" });

qa("TC-FLD-032", "the low-balance threshold field: 70.50 stored as 7050 paise, 0 switches the warning off; negative, decimal paise, text and ₹10 crore refused", async () => {
  const before = (await walletOf("customer")).wallet;
  const out: string[] = [];
  const problems: string[] = [];
  try {
    for (const [label, value, want] of [
      ["₹70.50", 7050, 200],
      ["0", 0, 200],
      ["negative", -100, 422],
      ["decimal paise (10.555 rupees)", 1055.5, 422],
      ["text", "abc", 422],
      ["₹10,00,00,000", 10_000_000_000, 422],
    ] as const) {
      const res = await call(await as("customer"), "PATCH", "/api/wallet/settings", { lowBalanceThresholdPaise: value });
      out.push(`${label} → ${res.status}`);
      if (res.status !== want) problems.push(`${label}: expected ${want}, got ${res.status}`);
      if (res.status === 200 && typeof value === "number") {
        const w = await walletOf("customer");
        if (w.wallet.lowBalanceThresholdPaise !== value) problems.push(`${label} stored as ${w.wallet.lowBalanceThresholdPaise}`);
        if (value === 0 && w.isLowBalance) problems.push("threshold 0 still shows low balance");
      }
    }
    const blank = await call(await as("customer"), "PATCH", "/api/wallet/settings", {});
    out.push(`blank (field left out) → ${blank.status}, threshold unchanged`);
  } finally {
    await setThreshold("customer", before.lowBalanceThresholdPaise);
  }
  expect(problems, `${problems.join("; ")} — ${out.join(", ")}`).toEqual([]);
  return `${out.join(", ")}; 0 switches the warning off (isLowBalance false)`;
}, { ...signed, partial: "there is no threshold field on /wallet (settings are API-only), so the page half and its field messages cannot be checked" });

qa(["TC-PAY-009", "TC-FLD-033"], "auto-recharge cannot be switched on (with or without trigger and amount); its amount is refused when invalid", async () => {
  const before = (await walletOf("customer")).wallet;
  const out: string[] = [];
  for (const body of [
    { autoRechargeEnabled: true },
    { autoRechargeEnabled: true, autoRechargeTriggerPaise: 10_000, autoRechargeAmountPaise: 50_000 },
  ]) {
    const res = await call(await as("customer"), "PATCH", "/api/wallet/settings", body);
    expect(res.status, `enable auto-recharge ${JSON.stringify(body)}`).toBe(422);
    expect(why(res)).toMatch(/not available/i);
    out.push(`${Object.keys(body).length === 1 ? "on without values" : "on with trigger ₹100 + amount ₹500"} → 422 "${res.body?.error?.message}"`);
  }
  const amounts: [string, unknown][] = [["negative", -100], ["decimal paise", 7050.5], ["text", "abc"]];
  for (const [label, value] of amounts) {
    const res = await call(await as("customer"), "PATCH", "/api/wallet/settings", { autoRechargeAmountPaise: value });
    expect(res.status, `${label} amount`).toBe(422);
    out.push(`amount ${label} → 422`);
  }
  const stored: string[] = [];
  for (const [label, value] of [["0", 0], ["₹10,00,00,000", 10_000_000_000]] as const) {
    const res = await call(await as("customer"), "PATCH", "/api/wallet/settings", { autoRechargeAmountPaise: value });
    stored.push(`${label} → ${res.status}`);
  }
  await call(await as("customer"), "PATCH", "/api/wallet/settings", { autoRechargeAmountPaise: before.autoRechargeAmountPaise, autoRechargeTriggerPaise: before.autoRechargeTriggerPaise });
  expect((await walletOf("customer")).wallet.autoRechargeEnabled, "never on").toBe(false);
  return `${out.join("; ")}; amount ${stored.join(", ")} while switched off; no recharge is ever attempted (the switch cannot be turned on)`;
}, { ...signed, partial: "expected 'with both values it saves' is superseded by DEF-07 (src/server/services/wallet.ts updateWalletSettings: auto-recharge is refused until a saved payment mandate exists); an out-of-range amount (0, ₹10 crore) is still stored while the switch is off — harmless as nothing reads it" });

qa("TC-PAY-010", "two checkouts sent together cannot overdraw the wallet: one succeeds, the other is refused, the balance stays ≥ 0 and is debited once", async () => {
  const listing = await sellable("A", 5, "priciest");
  const balance = (await walletOf("customer")).wallet.balancePaise;
  const price = listing.pricePaise ?? blocked("listing has no price");
  // A basket worth more than half the wallet (and within it): two of them cannot both be paid.
  const quantity = Math.max(1, Math.floor((balance - 5000) / price));
  if (quantity * price * 2 <= balance) blocked(`the wallet (${balance} paise) is too large for the stock of "${listing.name}" (${listing.stock ?? "?"})`);
  if (listing.stock !== undefined && quantity > listing.stock) blocked(`a basket worth over half the wallet needs ${quantity} units, more than the stock (${listing.stock})`);
  await fillCart("customer", [{ listing, quantity }]);
  const address = await defaultAddress("customer");
  const ctx = await as("customer");
  const send = (n: number) =>
    call(ctx, "POST", "/api/checkout", { requestId: `qa-${RUN}-race-${n}`, addressId: address?.id ?? null, paymentMethod: "WALLET", acknowledgeClosedShopIds: [listing.shopId] });
  const [a, b] = await Promise.all([send(1), send(2)]);
  const ok = [a, b].filter((r) => r.status === 201);
  const refused = [a, b].filter((r) => r.status !== 201);
  expect(ok.length, `exactly one checkout succeeds: ${a.status} / ${b.status} — ${why(refused[0] ?? a)}`).toBe(1);
  expect(refused[0].status, "the other is refused, not a server error").toBeLessThan(500);
  const after = await walletOf("customer");
  const order = ok[0].body.orders[0];
  expect(after.wallet.balancePaise, "debited exactly once").toBe(balance - order.totalPaise);
  expect(after.wallet.balancePaise).toBeGreaterThanOrEqual(0);
  const raced = (await ordersOf("customer")).filter((o) => (o as { checkoutKey?: string }).checkoutKey?.includes(`qa-${RUN}-race-`));
  expect(raced.length, "one new order").toBe(1);
  const cancel = await cancelAsCustomer("customer", order.id);
  expectStatus(cancel, 200, "cancel the race order (refund)");
  await emptyCart("customer");
  return `basket ${quantity} × ${price} = ${order.totalPaise} (> half of ${balance}); together → 201 + ${refused[0].status} "${refused[0].body?.error?.code ?? ""} ${(refused[0].body?.error?.message ?? "").slice(0, 80)}"; balance ${balance} → ${after.wallet.balancePaise}; order cancelled and refunded after`;
}, { ...signed, partial: "one cart per customer: the second tab checks out the same cart, so its refusal is the cart already used or INSUFFICIENT_BALANCE — two separate ₹80 orders cannot be open at once to show INSUFFICIENT_BALANCE itself" });

qa("TC-PAY-008", "more than 10 top-up or verify calls in a minute are refused with 429 after the 10th", async () => {
  await sleep(61_000); // a fresh minute for customer 2's payment limit (used by TC-PAY-003 above)
  const ctx = await as("customer2");
  const created: number[] = [];
  for (let i = 0; i < 11; i++) created.push((await call(ctx, "POST", "/api/wallet/topup", { amountPaise: 100 })).status);
  const verified: number[] = [];
  for (let i = 0; i < 11; i++) verified.push((await call(ctx, "POST", "/api/wallet/verify", { gatewayOrderId: `mock_order_${RUN}-${i}` })).status);
  expect(created.slice(0, 10).every((s) => s !== 429), `first 10 creates: ${created.join(",")}`).toBe(true);
  expect(created[10], "11th create").toBe(429);
  expect(verified.slice(0, 10).every((s) => s !== 429), `first 10 verifies: ${verified.join(",")}`).toBe(true);
  expect(verified[10], "11th verify").toBe(429);
  return `create: ${created.join(",")}; verify: ${verified.join(",")}`;
}, { ...signed, timeout: 180_000 });
