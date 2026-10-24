/**
 * Admin and operations console cases that change rules, age orders, suspend
 * or reject (QA package 2, local tier): business-rule validation and
 * restore, the operations exceptions queue, the order-monitoring day
 * boundary, the risk rules and review queue, vouchers, and the free-text
 * reasons of suspensions, shop rejections and classification changes.
 *
 * Local server only. Every rule changed here is restored in a finally block;
 * suspensions and rejections use fresh accounts and throwaway shop copies.
 */
import type { Browser, Page } from "@playwright/test";
import { z } from "zod";

import { RULES } from "@/server/config/rules";

import { as, me, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { addToCart, defaultAddress, deliver, emptyCart, fulfil, offerFor, onlyRiderOnline, orderAs, packOrder, placeOrder, riderAction, sellable, type Listing } from "../lib/flows";
import { call, expectStatus, RUN, why, type Answer } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { world } from "../lib/world";
import {
  apiFor,
  auditRows,
  browserFor,
  cloneShop,
  dbNow,
  findRiderNow,
  freshCustomer,
  freshOwner,
  grantLocalRole,
  listRules,
  withRulesRestored,
} from "../lib/access-helpers";

const local = { tier: "local" as const, timeout: 300_000 };

const NINE = ["otp", "dispatch", "riderEarnings", "returns", "images", "notifications", "suspension", "mrp", "externalPrices"] as const;

/** The integer fields of a rule group with their bounds, read from the rule's own schema (src/server/config/rules.ts). */
function intFields(key: (typeof NINE)[number]) {
  const shape = (RULES[key].schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
  return Object.entries(shape)
    .filter(([, f]) => f instanceof z.ZodNumber)
    .map(([name, f]) => ({ name, min: (f as z.ZodNumber).minValue ?? 0, max: (f as z.ZodNumber).maxValue ?? Number.MAX_SAFE_INTEGER }));
}

async function putRule(key: string, value: Record<string, unknown>): Promise<Answer> {
  return call(await as("admin"), "PUT", "/api/admin/settings", { key, value });
}

async function ruleValue(key: string) {
  return (await listRules()).find((r) => r.key === key)!;
}

/** Opens one rule's editor on /admin/settings and returns its textarea. */
async function ruleEditor(page: Page, key: string) {
  await page.goto(`/admin/settings?rule=${key}`, { waitUntil: "domcontentloaded" });
  const card = page.getByTestId("setting-card");
  await expect(card).toBeVisible();
  return { card, text: card.getByRole("textbox", { name: `${key} settings (JSON)` }) };
}

/* ======================================================== business rules */

qa("TC-PRE-004", "business rules are at their defaults before testing (any override restored)", async () => {
  const before = (await listRules()).filter((r) => r.overridden);
  for (const r of before) expectStatus(await call(await as("admin"), "DELETE", `/api/admin/settings?key=${encodeURIComponent(r.key)}`), 200, `restore ${r.key}`);
  const after = (await listRules()).filter((r) => r.overridden);
  expect(after.map((r) => r.key), "still overridden").toEqual([]);
  return before.length ? `restored to default: ${before.map((r) => r.key).join(", ")}` : "every rule group already at its default";
}, { ...local, partial: "the listing of the nine groups is the signed-tier TC-PRE-004 check" });

qa("TC-ADM-008", "an out-of-range rule value (OTP length 2) is refused with the field's message and nothing changes", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  try {
    return await withRulesRestored(["otp"], async () => {
      const before = await ruleValue("otp");
      const { card, text } = await ruleEditor(page, "otp");
      const value = JSON.parse(await text.inputValue()) as Record<string, unknown>;
      await text.fill(JSON.stringify({ ...value, length: 2 }, null, 2));
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card, "a message naming the field").toContainText(/length: \S/, { timeout: 15_000 });
      const shown = (await card.getByText(/^length: /).first().textContent().catch(() => "")) ?? "";
      const api = await putRule("otp", { length: 2 });
      expect(api.status, `API — ${why(api)}`).toBe(422);
      expect(JSON.stringify(api.body?.error?.details?.fields ?? {}), "the API names the field").toContain("length");
      const after = await ruleValue("otp");
      expect(after.value, "nothing changed").toEqual(before.value);
      expect(after.overridden).toBe(before.overridden);
      return `UI: "${shown.trim().slice(0, 120)}" (names the field; the allowed range 4–8 is not stated); API 422 on field 'length'; value and override state unchanged`;
    });
  } finally {
    await context.close();
  }
}, local);

qa("TC-ADM-009", "save a valid rule value and restore the default: both apply at once and both are audited with before/after", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  try {
    return await withRulesRestored(["returns"], async () => {
      const since = await dbNow();
      const def = (RULES.returns.defaults as { windowHours: number }).windowHours;
      const next = def === 72 ? 60 : 72;
      const { card, text } = await ruleEditor(page, "returns");
      const value = JSON.parse(await text.inputValue()) as Record<string, unknown>;
      await text.fill(JSON.stringify({ ...value, windowHours: next }, null, 2));
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByText("Saved.")).toBeVisible({ timeout: 15_000 });
      await expect(card).toContainText("customised");
      expect(((await ruleValue("returns")).value as { windowHours: number }).windowHours, "applied").toBe(next);
      await card.getByRole("button", { name: "Restore default" }).click();
      await expect(card.getByText("Saved.")).toBeVisible({ timeout: 15_000 });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("setting-card")).toContainText("default");
      const after = await ruleValue("returns");
      expect(after.overridden, "back to the default").toBe(false);
      expect((after.value as { windowHours: number }).windowHours).toBe(def);
      const audit = await auditRows("returns", since, "setting.changed");
      expect(audit.length, "two audit rows").toBe(2);
      expect((audit[0].previous_value as { windowHours: number }).windowHours).toBe(def);
      expect((audit[0].new_value as { windowHours: number }).windowHours).toBe(next);
      expect((audit[1].previous_value as { windowHours: number }).windowHours).toBe(next);
      expect(audit[1].new_value).toMatchObject({ reset: true });
      return `returns.windowHours ${def}→${next} (Saved, customised, applied) → Restore default (default again); audit: ${def}→${next}, ${next}→reset`;
    });
  } finally {
    await context.close();
  }
}, local);

qa("TC-FLD-110", "every numeric value of the nine rule groups: blank, 0, -1, 1.5, text, 99999999 refused; min and max accepted; one outside refused; current value kept", async ({ browser }) => {
  const report: string[] = [];
  const wrong: string[] = [];
  await withRulesRestored([...NINE], async () => {
    for (const key of NINE) {
      const fields = intFields(key);
      if (!fields.length) {
        report.push(`${key}: no numeric fields`);
        continue;
      }
      // Blank, decimal, text, negative and a huge number on the group's first field.
      const first = fields[0];
      const odd: [string, unknown][] = [["blank", ""], ["-1", -1], ["1.5", 1.5], ["text", "ten"], ["99999999", 99_999_999], ["0", 0], ["null", null]];
      const kept = (await ruleValue(key)).value;
      for (const [label, value] of odd) {
        const res = await putRule(key, { [first.name]: value });
        const shouldPass = typeof value === "number" && Number.isInteger(value) && value >= first.min && value <= first.max;
        if (res.status >= 500) wrong.push(`${key}.${first.name}=${label} → 500`);
        else if (shouldPass ? res.status !== 200 : res.status !== 422) wrong.push(`${key}.${first.name}=${label} → ${res.status} (expected ${shouldPass ? 200 : 422})`);
        else if (!shouldPass && !JSON.stringify(res.body?.error?.details?.fields ?? {}).includes(first.name)) wrong.push(`${key}.${first.name}=${label}: message does not name the field`);
      }
      // Bounds of every field.
      for (const f of fields) {
        for (const [label, value, accepted] of [["min", f.min, true], ["max", f.max, true], ["min-1", f.min - 1, false], ["max+1", f.max + 1, false]] as [string, number, boolean][]) {
          const res = await putRule(key, { [f.name]: value });
          if (res.status !== (accepted ? 200 : 422)) wrong.push(`${key}.${f.name}=${value} (${label}) → ${res.status}`);
          if (accepted && res.status === 200 && (res.body?.value?.[f.name] ?? null) !== value) wrong.push(`${key}.${f.name}=${value} saved as ${res.body?.value?.[f.name]}`);
        }
        const now = (await ruleValue(key)).value as Record<string, unknown>;
        if (now[f.name] !== f.max) wrong.push(`${key}.${f.name}: a refused value replaced the saved one (${now[f.name]})`);
      }
      report.push(`${key}: ${fields.length} fields`);
      void kept;
      expectStatus(await call(await as("admin"), "DELETE", `/api/admin/settings?key=${key}`), 200, `reset ${key}`);
    }
    // The page: a normal whole number saves and shows after a reload.
    const { context, page } = await pageAs(browser as Browser, "admin");
    try {
      const { card, text } = await ruleEditor(page, "otp");
      const value = JSON.parse(await text.inputValue()) as Record<string, unknown>;
      await text.fill(JSON.stringify({ ...value, expiryMinutes: 7 }, null, 2));
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByText("Saved.")).toBeVisible({ timeout: 15_000 });
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(JSON.parse(await page.getByTestId("setting-card").getByRole("textbox").inputValue()).expiryMinutes, "shown after reload").toBe(7);
      await text.fill("{ \"expiryMinutes\": }");
      await page.getByTestId("setting-card").getByRole("button", { name: "Save" }).click();
      await expect(page.getByTestId("setting-card")).toContainText("That is not valid JSON.");
      report.push("page: 7 saved and shown after reload; broken JSON refused on the page");
    } finally {
      await context.close();
    }
  });
  const leftOver = (await listRules()).filter((r) => (NINE as readonly string[]).includes(r.key) && r.overridden).map((r) => r.key);
  expect(leftOver, "restored afterwards").toEqual([]);
  expect(wrong, wrong.join("; ")).toEqual([]);
  return report.join("; ");
}, { ...local, timeout: 600_000, partial: "the editor is one JSON box per rule group, so the page's message is the API's per-field message; the field-level checks run through the API" });

/* ======================================================== operations exceptions */

/** Moves an order's clock back by `minutes`: creation, payment and every status change (as if it had waited that long). */
async function ageOrder(orderId: string, minutes: number) {
  const interval = `${minutes} minutes`;
  await db()`update orders set created_at = created_at - ${interval}::interval, paid_at = paid_at - ${interval}::interval,
    accepted_at = accepted_at - ${interval}::interval, packed_at = packed_at - ${interval}::interval, accept_by_at = accept_by_at - ${interval}::interval
    where id = ${orderId}`;
  await db()`update order_status_history set created_at = created_at - ${interval}::interval where order_id = ${orderId}`;
}

qa("TC-ADM-003", "exceptions queue: categories with thresholds; an unaccepted order and a READY order with no rider appear with working row actions", async ({ browser }) => {
  const riders = await db()<{ user_id: string; is_online: boolean }[]>`select user_id, is_online from delivery_partners where is_online`;
  const unaccepted = await placeOrder({ method: "WALLET" });
  const ready = await placeOrder({ method: "WALLET" });
  const out: string[] = [];
  try {
    await db()`update delivery_partners set is_online = false where is_online`;
    await packOrder(ready.id);
    await ageOrder(unaccepted.id, 15);
    await ageOrder(ready.id, 12);
    const { context, page } = await pageAs(browser, "ops");
    try {
      await page.goto("/admin/exceptions", { waitUntil: "domcontentloaded" });
      const main = page.locator("main");
      for (const label of ["Shop not accepting", "Shop slow to prepare", "No rider", "Rider not picked up", "Failed delivery", "Returned, no decision", "Disputed", "Past promised time"]) {
        await expect(main, `category ${label}`).toContainText(label);
      }
      const rowA = main.locator("div", { hasText: unaccepted.orderNumber }).filter({ has: page.getByRole("button", { name: "Accept for shop" }) }).last();
      await expect(rowA).toContainText(/Shop not accepting/);
      await expect(rowA).toContainText(/1[45] min/);
      const rowR = main.locator("div", { hasText: ready.orderNumber }).filter({ has: page.getByRole("button", { name: /Find rider|Re-send offer/ }) }).last();
      await expect(rowR).toContainText(/No rider/);
      await expect(rowR).toContainText(/Critical/);
      out.push(`${unaccepted.orderNumber}: Shop not accepting (15 min); ${ready.orderNumber}: No rider, critical (12 min)`);
      await rowA.getByRole("button", { name: "Accept for shop" }).click();
      await expect.poll(async () => (await orderAs("customer", unaccepted.id))?.status, { timeout: 20_000 }).toBe("ACCEPTED");
      out.push("'Accept for shop' → ACCEPTED");
      await rowR.getByRole("button", { name: /Cancel & refund|Cancel order/ }).click();
      await rowR.getByLabel(/Reason for cancelling/).fill("QA: no rider could be found for this order");
      await rowR.getByRole("button", { name: "Continue" }).click();
      await rowR.getByRole("button", { name: /Yes|Confirm|Cancel & refund/ }).last().click();
      await expect.poll(async () => (await orderAs("customer", ready.id))?.status, { timeout: 20_000 }).toMatch(/CANCELLED|REFUNDED/);
      out.push("'Cancel & refund' → cancelled and refunded");
    } finally {
      await context.close();
    }
  } finally {
    for (const r of riders) await db()`update delivery_partners set is_online = true where user_id = ${r.user_id}`;
    await call(await as("shop"), "POST", `/api/orders/${unaccepted.id}/fulfilment`, { action: "reject", reason: "QA exceptions check done" });
  }
  return out.join("; ");
}, { ...local, partial: "two of the twelve categories are created (shop not accepting, no rider); the others are listed with their counts" });

qa("TC-ADM-004", "order monitoring's date filter follows the business day (IST): an order at 01:30 IST belongs to that day, not the day before", async () => {
  const order = await placeOrder({ method: "WALLET" });
  // 01:30 IST today = 20:00 UTC yesterday.
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);
  const at = new Date(`${yesterday}T20:00:00Z`);
  await db()`update orders set created_at = ${at} where id = ${order.id}`;
  const onDay = await call(await as("admin"), "GET", `/admin/orders?dateFrom=${today}&dateTo=${today}`);
  const dayBefore = await call(await as("admin"), "GET", `/admin/orders?dateFrom=${yesterday}&dateTo=${yesterday}`);
  await call(await as("customer"), "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA day boundary" });
  const inToday = onDay.text.includes(order.orderNumber);
  const inYesterday = dayBefore.text.includes(order.orderNumber);
  expect({ inToday, inYesterday }, `order created ${today} 01:30 IST: listed under ${today}? ${inToday}; under ${yesterday}? ${inYesterday}`).toEqual({ inToday: true, inYesterday: false });
  return `order at ${today} 01:30 IST listed under ${today} only`;
}, { ...local, partial: "status, shop, combined and invalid-value filters are the signed-tier TC-ADM-004 check" });

qa("TC-ADM-005", "an order one rider declined and another accepted shows once, with the accepting rider", async ({ browser }) => {
  need(world().users.rider2, "a second rider");
  await onlyRiderOnline("rider");
  await db()`update delivery_partners set is_online = true, last_location_at = now() where user_id = ${need(world().users.rider2?.id, "rider 2")}`;
  const order = await placeOrder({ method: "WALLET" });
  await packOrder(order.id);
  // Whoever is offered first declines; the other accepts.
  let first: "rider" | "rider2" = "rider";
  let second: "rider" | "rider2" = "rider2";
  try {
    let offer = await offerFor(order.id, "rider", 15_000).catch(() => null);
    if (!offer) {
      first = "rider2";
      offer = await offerFor(order.id, "rider2");
    }
    second = first === "rider" ? "rider2" : "rider";
    expectStatus(await riderAction(offer.deliveryOrderId, "reject", {}, first), 200, `${first} declines`);
    // The decline re-offers at once when the other rider is free; otherwise ask again.
    const again = await findRiderNow(order.id);
    expect([200, 409], `find a rider again — ${why(again)}`).toContain(again.status);
    const next = await offerFor(order.id, second, 60_000);
    expectStatus(await riderAction(next.deliveryOrderId, "accept", {}, second), 200, `${second} accepts`);
    const secondName = (await db()<{ name: string }[]>`select name from users where id = ${(await me(second)).id}`)[0]?.name ?? "";
    const { context, page } = await pageAs(browser, "ops");
    try {
      await page.goto(`/admin/orders?shopId=${order.listing.shopId}`, { waitUntil: "domcontentloaded" });
      const rows = page.locator("tbody tr", { hasText: `#${order.orderNumber}` });
      expect(await rows.count(), "the order is listed once").toBe(1);
      await expect(rows.first(), "with the rider who accepted").toContainText(secondName);
    } finally {
      await context.close();
    }
    return `${order.orderNumber}: ${first} declined, ${second} (${secondName}) accepted → one row naming ${secondName}`;
  } finally {
    // Finish the job so no rider is left busy for the next checks.
    const done = await deliver(order.id, { rider: second }).then(() => true, () => false);
    if (!done) await deliver(order.id, { rider: first }).catch(() => {});
  }
}, local);

/* ======================================================== risk */

async function runRules() {
  const res = await call(await as("ops"), "POST", "/api/admin/risk", {});
  expectStatus(res, 200, "run the risk rules");
  return res.body as { rules: number; raised: number; refreshed: number };
}

async function flagsFor(subjectId: string, status = "OPEN") {
  return db()<{ id: string; rule_code: string; status: string; occurrences: number; review_note: string | null }[]>`
    select id, rule_code, status::text, occurrences, review_note from risk_flags where subject_id = ${subjectId} and status = ${status}`;
}

qa("TC-ADM-012", "a rule raises one OPEN flag for its subject and a second run refreshes it instead of duplicating", async () => {
  const user = await freshCustomer("adm012");
  const failures = (RULES.riskRules.defaults as { topupFailures: { count: number } }).topupFailures.count;
  for (let i = 0; i < failures; i++) {
    await db()`insert into payments (user_id, gateway_order_id, amount_paise, status, purpose, failure_reason)
      values (${user.id}, ${`qa-adm012-${RUN}-${i}-${user.id.slice(0, 8)}`}, 50000, 'FAILED', 'WALLET_TOPUP', 'QA declined card')`;
  }
  const first = await runRules();
  const afterFirst = await flagsFor(user.id);
  const second = await runRules();
  const afterSecond = await flagsFor(user.id);
  expect(afterFirst.map((f) => f.rule_code), "one OPEN flag after the first run").toEqual(["TOPUP_FAILURES"]);
  expect(afterSecond.length, "still one flag after the second run").toBe(1);
  expect(afterSecond[0].id).toBe(afterFirst[0].id);
  expect(afterSecond[0].occurrences, "refreshed: detected again").toBeGreaterThan(afterFirst[0].occurrences);
  return `${failures} failed top-ups → TOPUP_FAILURES flag (run 1: raised ${first.raised}); run 2 refreshed it (occurrences ${afterFirst[0].occurrences}→${afterSecond[0].occurrences}, refreshed ${second.refreshed})`;
}, { ...local, partial: "the failed top-ups are arranged as payment rows; the rule and the queue are the app's" });

/** A fresh customer with an address, a funded wallet and `orders` placed at shop A whose totals are then set to `totalsPaise`. */
async function customerWithOrders(label: string, totalsPaise: number[], listing: Listing) {
  const user = await freshCustomer(label, { withAddress: true, walletPaise: 500_000 });
  const ctx = await apiFor(user);
  const placed: { id: string; total: number }[] = [];
  try {
    const address = (await call(ctx, "GET", "/api/addresses")).body;
    const addressId = ((address?.addresses ?? address ?? []) as { id: string }[])[0]?.id;
    for (const [i, total] of totalsPaise.entries()) {
      await call(ctx, "DELETE", "/api/cart");
      expectStatus(await call(ctx, "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 1 }), [200, 201], "add to cart");
      const res = await call(ctx, "POST", "/api/checkout", { requestId: `qa-${RUN}-${label}-${i}`, addressId, paymentMethod: "WALLET", acknowledgeClosedShopIds: [listing.shopId] });
      expectStatus(res, 201, `${label} order ${i + 1}`);
      placed.push({ id: res.body.orders[0].id, total: res.body.orders[0].totalPaise });
      // Ordered one after another, a second apart, so each earlier order is part of the later one's baseline.
      await db()`update orders set total_paise = ${total}, created_at = now() - ${`${(totalsPaise.length - i) * 2} minutes`}::interval where id = ${res.body.orders[0].id}`;
    }
  } finally {
    await ctx.dispose();
  }
  return { user, placed };
}

qa("TC-ADM-013", "unusually large order: 5× the average and Rs 10,000 for a new customer are flagged; 4.9× and Rs 9,999 are not", async () => {
  const listing = await sellable("A");
  const x = await customerWithOrders("adm013x", [40_000, 40_000, 40_000, 200_000], listing);
  const y = await customerWithOrders("adm013y", [40_000, 40_000, 40_000, 196_000], listing);
  const z = await customerWithOrders("adm013z", [1_000_000], listing);
  const w = await customerWithOrders("adm013w", [999_900], listing);
  try {
    await runRules();
    const flagged = async (u: { id: string }) => (await flagsFor(u.id)).some((f) => f.rule_code === "HIGH_VALUE_OUTLIER");
    const result = { "5x": await flagged(x.user), "4.9x": await flagged(y.user), "Rs 10,000 new": await flagged(z.user), "Rs 9,999 new": await flagged(w.user) };
    expect(result).toEqual({ "5x": true, "4.9x": false, "Rs 10,000 new": true, "Rs 9,999 new": false });
    return `HIGH_VALUE_OUTLIER: ${Object.entries(result).map(([k, v]) => `${k} ${v ? "flagged" : "not flagged"}`).join(", ")}`;
  } finally {
    // Put the real totals back before cancelling, so each refund is what was paid.
    for (const set of [x, y, z, w]) {
      const ctx = await apiFor(set.user);
      try {
        for (const o of set.placed) {
          await db()`update orders set total_paise = ${o.total} where id = ${o.id}`;
          await call(ctx, "PATCH", `/api/orders/${o.id}/status`, { status: "CANCELLED", note: "QA risk check done" });
        }
      } finally {
        await ctx.dispose();
      }
    }
  }
}, { ...local, partial: "order values are arranged on real orders; B2B, subscription and unpaid orders being ignored is read from the rule's SQL (order_type PERSONAL, source DIRECT, paid statuses) but not exercised" });

/** Arranges one OPEN flag for a subject (the queue's input; the rules themselves are TC-ADM-012/013). */
async function arrangeFlag(subjectType: "USER" | "SHOP" | "DELIVERY_PARTNER", subjectId: string, label: string) {
  const [row] = await db()<{ id: string }[]>`insert into risk_flags (subject_type, subject_id, rule_code, severity, summary)
    values (${subjectType}, ${subjectId}, ${`QA_${label}`}, 'MEDIUM', ${`QA arranged flag ${label} ${RUN}`}) returning id`;
  return row.id;
}

async function flagCard(page: Page, flagId: string, summary: string) {
  await page.goto("/admin/risk", { waitUntil: "domcontentloaded" });
  void flagId;
  return page.getByTestId("risk-flags").locator("div.p-3", { hasText: summary }).first();
}

qa("TC-ADM-014", "dismiss one flag and action another with a note; without a note both are refused", async ({ browser }) => {
  const a = await freshCustomer("adm014a");
  const b = await freshCustomer("adm014b");
  const dismissId = await arrangeFlag("USER", a.id, "DISMISS");
  const actionId = await arrangeFlag("USER", b.id, "ACTION");
  const out: string[] = [];
  for (const note of ["", "abc"]) {
    const res = await call(await as("ops"), "PATCH", `/api/admin/risk/${dismissId}`, { decision: "DISMISSED", note });
    expect(res.status, `note "${note}" — ${why(res)}`).toBe(422);
  }
  out.push("API: no note / a 3-letter note 422");
  const { context, page } = await pageAs(browser, "ops");
  try {
    const card = await flagCard(page, dismissId, `QA arranged flag DISMISS ${RUN}`);
    await expect(card.getByRole("button", { name: "Dismiss" }), "Dismiss without a note").toBeDisabled();
    await card.getByPlaceholder("What you checked / did").fill("QA: checked the top-ups, a card glitch");
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect.poll(async () => (await db()<{ status: string }[]>`select status::text from risk_flags where id = ${dismissId}`)[0].status, { timeout: 15_000 }).toBe("DISMISSED");
    const card2 = await flagCard(page, actionId, `QA arranged flag ACTION ${RUN}`);
    await card2.getByPlaceholder("What you checked / did").fill("QA: called the customer, limit set");
    await card2.getByRole("button", { name: "Actioned" }).click();
    await expect.poll(async () => (await db()<{ status: string }[]>`select status::text from risk_flags where id = ${actionId}`)[0].status, { timeout: 15_000 }).toBe("ACTIONED");
  } finally {
    await context.close();
  }
  const [d] = await db()<{ review_note: string }[]>`select review_note from risk_flags where id = ${dismissId}`;
  expect(d.review_note).toBe("QA: checked the top-ups, a card glitch");
  out.push("page: buttons disabled without a note; DISMISSED and ACTIONED with their notes");
  return out.join("; ");
}, local);

qa("TC-ADM-015", "suspend from a flag: confirm disabled for a short reason; then subject suspended and flag ACTIONED 'Suspended: <reason>'; no button for suspended, admin or own account", async ({ browser }) => {
  const target = await freshCustomer("adm015");
  const suspended = await freshCustomer("adm015s");
  await db()`update users set status = 'SUSPENDED' where id = ${suspended.id}`;
  const adminSubject = await freshCustomer("adm015a");
  await grantLocalRole(adminSubject.id, "ADMIN");
  const self = await me("admin");
  const ids = {
    target: await arrangeFlag("USER", target.id, "SUSPEND"),
    suspended: await arrangeFlag("USER", suspended.id, "ALREADY"),
    admin: await arrangeFlag("USER", adminSubject.id, "ADMINSUBJ"),
    self: await arrangeFlag("USER", self.id, "SELF"),
  };
  const out: string[] = [];
  const { context, page } = await pageAs(browser, "admin");
  try {
    for (const [key, label] of [["suspended", "ALREADY"], ["admin", "ADMINSUBJ"], ["self", "SELF"]] as const) {
      const card = await flagCard(page, ids[key], `QA arranged flag ${label} ${RUN}`);
      await expect(card, `${key}: card shown`).toBeVisible();
      await expect(card.getByTestId("risk-suspend"), `${key}: no suspend button`).toHaveCount(0);
    }
    out.push("no 'Suspend & mark actioned' for an already-suspended, an admin and the own account");
    const card = await flagCard(page, ids.target, `QA arranged flag SUSPEND ${RUN}`);
    await card.getByTestId("risk-suspend").click();
    const reason = card.getByLabel(/Reason for suspending this/);
    await reason.fill("abcd");
    const confirm = card.getByRole("button", { name: "Confirm suspension" });
    await expect(confirm, "confirm with a 4-letter reason").toBeDisabled();
    await reason.fill("QA repeated failed top-ups");
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect.poll(async () => (await db()<{ status: string }[]>`select status::text from users where id = ${target.id}`)[0].status, { timeout: 20_000 }).toBe("SUSPENDED");
    await expect.poll(async () => (await db()<{ status: string; review_note: string }[]>`select status::text, review_note from risk_flags where id = ${ids.target}`)[0], { timeout: 20_000 }).toEqual({ status: "ACTIONED", review_note: "Suspended: QA repeated failed top-ups" });
    out.push("short reason → disabled; valid → user SUSPENDED and flag ACTIONED 'Suspended: QA repeated failed top-ups'");
  } finally {
    await context.close();
    await db()`update risk_flags set status = 'DISMISSED', review_note = 'QA cleanup', reviewed_at = now() where id in (${ids.suspended}, ${ids.admin}, ${ids.self}) and status = 'OPEN'`;
  }
  return out.join("; ");
}, { ...local, partial: "a deleted subject is not arranged (no delete flow for accounts in this build's admin screens)" });

qa("TC-ADM-016", "an operator is offered suspend for shop and rider flags, not for customer flags", async ({ browser }) => {
  const owner = await freshOwner("adm016");
  const shop = await cloneShop(need(world().shops.A?.id, "shop A"), { ownerId: owner.id, status: "APPROVED", label: "Flagged Shop" });
  const customer = await freshCustomer("adm016c");
  const [rider] = await db()<{ id: string }[]>`select id from delivery_partners where user_id = ${need(world().users.rider2?.id ?? world().users.rider?.id, "a rider")}`;
  const ids = {
    shop: await arrangeFlag("SHOP", shop.id, "OPSSHOP"),
    rider: await arrangeFlag("DELIVERY_PARTNER", rider.id, "OPSRIDER"),
    user: await arrangeFlag("USER", customer.id, "OPSUSER"),
  };
  const { context, page } = await pageAs(browser, "ops");
  try {
    const shopCard = await flagCard(page, ids.shop, `QA arranged flag OPSSHOP ${RUN}`);
    await expect(shopCard.getByTestId("risk-suspend"), "shop flag").toHaveCount(1);
    const riderCard = await flagCard(page, ids.rider, `QA arranged flag OPSRIDER ${RUN}`);
    await expect(riderCard.getByTestId("risk-suspend"), "rider flag").toHaveCount(1);
    const userCard = await flagCard(page, ids.user, `QA arranged flag OPSUSER ${RUN}`);
    await expect(userCard, "customer flag shown").toBeVisible();
    await expect(userCard.getByTestId("risk-suspend"), "customer flag: no suspend").toHaveCount(0);
  } finally {
    await context.close();
    await db()`update risk_flags set status = 'DISMISSED', review_note = 'QA cleanup', reviewed_at = now() where id in (${ids.shop}, ${ids.rider}, ${ids.user}) and status = 'OPEN'`;
  }
  return "operator: 'Suspend & mark actioned' on the shop and rider flags, none on the customer flag";
}, local);

/* ======================================================== vouchers */

qa("TC-FLD-114", "voucher fields: blanks named, duplicate and malformed codes, non-positive numbers, a past expiry and an impossible budget refused", async ({ browser }) => {
  const admin = await as("admin");
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const base = { name: `QA Voucher ${RUN}`, code: `QA${RUN}`.toUpperCase().slice(0, 16), bonusPercent: 10, minimumTopupPaise: 50_000, maximumBonusPaise: 5_000, startDate: today, endDate: later, perCustomerLimit: 1, totalBudgetPaise: 100_000 };
  const created: string[] = [];
  const results: string[] = [];
  const wrong: string[] = [];
  const attempt = async (label: string, body: Record<string, unknown>, expectRefused: boolean, field?: string) => {
    const res = await call(admin, "POST", "/api/vouchers", body);
    if (res.status === 201 && res.body?.id) created.push(res.body.id);
    const refused = res.status === 409 || res.status === 422;
    results.push(`${label} ${res.status}`);
    if (res.status >= 500) wrong.push(`${label} → 500`);
    else if (refused !== expectRefused) wrong.push(`${label} → ${res.status} ${expectRefused ? "accepted" : `refused: ${why(res).slice(0, 60)}`}`);
    else if (expectRefused && field && !JSON.stringify(res.body).toLowerCase().includes(field.toLowerCase())) wrong.push(`${label}: the message does not name ${field} (${why(res).slice(0, 80)})`);
  };
  for (const [field, key] of [["name", "name"], ["code", "code"], ["bonus", "bonusPercent"], ["start", "startDate"], ["end", "endDate"]] as const) {
    await attempt(`blank ${field}`, { ...base, code: `${base.code}B${field.length}`, [key]: key === "bonusPercent" ? null : "" }, true, field);
  }
  await attempt("valid", { ...base }, false);
  await attempt("duplicate code", { ...base, name: `${base.name} again` }, true, "code");
  await attempt("code with spaces", { ...base, code: "QA CODE 1" }, true, "code");
  await attempt("code with symbols", { ...base, code: "QA<>!@#" }, true, "code");
  for (const [label, key] of [["bonus", "bonusPercent"], ["minimum", "minimumTopupPaise"], ["budget", "totalBudgetPaise"], ["per-user limit", "perCustomerLimit"]] as const) {
    await attempt(`${label} 0`, { ...base, code: `${base.code}Z${label.length}`, [key]: 0 }, key !== "minimumTopupPaise", key);
    await attempt(`${label} negative`, { ...base, code: `${base.code}N${label.length}`, [key]: -5 }, true, key);
    await attempt(`${label} text`, { ...base, code: `${base.code}T${label.length}`, [key]: "ten" }, true, key);
  }
  const pastStart = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
  const pastEnd = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  await attempt("expiry in the past", { ...base, code: `${base.code}P`, startDate: pastStart, endDate: pastEnd }, true, "endDate");
  await attempt("budget smaller than one bonus", { ...base, code: `${base.code}S`, maximumBonusPaise: 5_000, totalBudgetPaise: 1_000 }, true, "budget");
  // The page names the missing field.
  const { context, page } = await pageAs(browser, "admin");
  let pageMessage = "";
  try {
    await page.goto("/admin/console/vouchers", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Create Voucher", exact: true }).click();
    await page.getByRole("button", { name: "Create voucher", exact: true }).click();
    const message = page.getByText(/Voucher name must be at least 3 characters/);
    await expect(message, "the page names the missing field").toBeVisible();
    pageMessage = (await message.textContent()) ?? "";
  } finally {
    await context.close();
    for (const id of created) await call(admin, "POST", `/api/vouchers/${id}/status`, { status: "PAUSED" });
  }
  expect(wrong, wrong.join("; ")).toEqual([]);
  return `${results.join(", ")}; page: "${pageMessage.trim().slice(0, 80)}"`;
}, { ...local, partial: "a minimum top-up of 0 means 'no minimum' (src/app/api/vouchers/route.ts allows min 0) and is not counted as a refusal case" });

/* ======================================================== free-text reasons */

const REASONS = {
  spaces: "     ",
  one: "x",
  long300: "Reason ".repeat(43).slice(0, 301),
  long501: "y".repeat(501),
  script: "<script>alert(1)</script> & <b>bold</b> % _ ' \"",
  hindi: "दुकान बंद — कृपया दस्तावेज़ जमा करें (मराठी: कागदपत्रे)",
  padded: "   QA padded reason   ",
};

qa("TC-FLD-119", "suspension reason and expected action: blank/spaces/1 char refused, limit recorded, script stored as text, Hindi kept, spaces trimmed; the owner sees it", async ({ browser }) => {
  const results: string[] = [];
  const wrong: string[] = [];
  const A = need(world().shops.A?.id, "shop A");
  const owner = await freshOwner("fld119");
  const probe = await cloneShop(A, { ownerId: owner.id, status: "APPROVED", label: "Suspend Probe" });
  for (const [label, body] of [
    ["blank reason", { reason: "" }],
    ["spaces only", { reason: REASONS.spaces }],
    ["1 character", { reason: REASONS.one }],
    ["501 characters", { reason: REASONS.long501 }],
    ["blank expected action", { reason: "QA valid reason", expectedAction: "  " }],
    ["301-char expected action", { reason: "QA valid reason", expectedAction: "z".repeat(301) }],
  ] as [string, Record<string, unknown>][]) {
    const res = await call(await as("ops"), "POST", `/api/shops/${probe.id}/suspend`, body);
    results.push(`${label} ${res.status}`);
    if (label === "blank expected action") {
      // A blank optional field falls back to the rule's default expected action (accepted) or is refused: both are not a 500.
      if (res.status >= 500) wrong.push(`${label} → 500`);
      if (res.status === 200) {
        await call(await as("ops"), "POST", `/api/shops/${probe.id}/reactivate`, { note: "QA reinstated" });
        await db()`update shops set status = 'APPROVED' where id = ${probe.id}`;
      }
      continue;
    }
    if (res.status !== 422) wrong.push(`${label} → ${res.status} (expected 422)`);
  }
  // One real suspension with a script, Hindi and outer spaces.
  const reason = `  ${REASONS.script} ${REASONS.hindi}  `;
  const res = await call(await as("ops"), "POST", `/api/shops/${probe.id}/suspend`, { reason, expectedAction: `  ${REASONS.hindi}  ` });
  expectStatus(res, 200, "suspend with script, Hindi and outer spaces");
  const [stored] = await db()<{ reason: string; expected_action: string }[]>`select reason, expected_action from shop_suspensions where shop_id = ${probe.id} order by created_at desc limit 1`;
  if (stored.reason !== reason.trim()) wrong.push(`stored reason not trimmed/kept: ${JSON.stringify(stored.reason).slice(0, 80)}`);
  if (stored.expected_action !== REASONS.hindi) wrong.push(`stored expected action: ${JSON.stringify(stored.expected_action).slice(0, 80)}`);
  let alerted = false;
  const { context, page } = await browserFor(browser, owner);
  try {
    page.on("dialog", async (d) => {
      alerted = true;
      await d.dismiss();
    });
    await page.goto("/shop", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main"), "the owner sees the reason as plain text").toContainText("<script>alert(1)</script>");
    await expect(page.locator("main")).toContainText("दुकान बंद");
  } finally {
    await context.close();
  }
  expect(alerted, "no script ran").toBe(false);
  expect(wrong, wrong.join("; ")).toEqual([]);
  return `${results.join(", ")}; limits: reason 3–500, expected action 3–300; script/Hindi stored trimmed and shown as text on the owner's /shop`;
}, local);

qa("TC-FLD-121", "operator's shop-reject reason and classification-change reason: refusals, limit, script as text, Hindi, outer spaces trimmed; the owner sees the reason and can resubmit", async ({ browser }) => {
  const pendingSrc = need(world().shops.pending?.id, "the pending shop");
  const owner = await freshOwner("fld121");
  const shop = await cloneShop(pendingSrc, { ownerId: owner.id, status: "PENDING_APPROVAL", label: "Reject Probe" });
  const ops = await as("ops");
  const results: string[] = [];
  const wrong: string[] = [];
  for (const [label, reason] of [["blank", ""], ["spaces only", REASONS.spaces], ["1 character", REASONS.one], ["501 characters", REASONS.long501]] as [string, string][]) {
    const res = await call(ops, "POST", `/api/shops/${shop.id}/reject`, { reason });
    results.push(`reject ${label} ${res.status}`);
    if (res.status !== 422) wrong.push(`reject ${label} → ${res.status} (expected 422)`);
  }
  const reason = `${REASONS.padded} ${REASONS.script} ${REASONS.hindi}   `;
  const rejected = await call(ops, "POST", `/api/shops/${shop.id}/reject`, { reason });
  expectStatus(rejected, 200, "reject with a script, Hindi and outer spaces");
  const [row] = await db()<{ rejection_reason: string }[]>`select rejection_reason from shops where id = ${shop.id}`;
  results.push(`stored reject reason ${JSON.stringify(row.rejection_reason.slice(0, 12))}…`);
  if (row.rejection_reason !== reason.trim()) wrong.push(`reject reason stored with its outer spaces (${JSON.stringify(row.rejection_reason.slice(0, 6))}…${JSON.stringify(row.rejection_reason.slice(-6))}), not trimmed`);
  let alerted = false;
  const { context, page } = await browserFor(browser, owner);
  try {
    page.on("dialog", async (d) => {
      alerted = true;
      await d.dismiss();
    });
    await page.goto("/shop", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main"), "the owner sees the reason as text").toContainText("<script>alert(1)</script>");
    await expect(page.locator("main")).toContainText("दुकान बंद");
    await expect(page.locator("main"), "the owner can correct and resubmit").toContainText(/resubmit|correct|update/i);
  } finally {
    await context.close();
  }
  expect(alerted, "no script ran").toBe(false);
  // Classification change reason (approved shop copy).
  const owner2 = await freshOwner("fld121c");
  const approved = await cloneShop(need(world().shops.A?.id, "shop A"), { ownerId: owner2.id, status: "APPROVED", label: "Classify Probe" });
  const [{ classification }] = await db()<{ classification: string }[]>`select classification from shops where id = ${approved.id}`;
  const other = classification === "KESARI" ? "GREEN" : "KESARI";
  for (const [label, r] of [["blank", ""], ["spaces only", REASONS.spaces], ["1 character", REASONS.one], ["501 characters", REASONS.long501]] as [string, string][]) {
    const res = await call(ops, "POST", `/api/shops/${approved.id}/classification`, { classification: other, reason: r });
    results.push(`classification ${label} ${res.status}`);
    if (res.status !== 422) wrong.push(`classification ${label} → ${res.status} (expected 422)`);
  }
  const changed = await call(ops, "POST", `/api/shops/${approved.id}/classification`, { classification: other, reason });
  expectStatus(changed, 200, "classification change with script/Hindi/spaces");
  const [hist] = await db()<{ reason: string }[]>`select reason from shop_classification_history where shop_id = ${approved.id} order by created_at desc limit 1`;
  if (hist.reason !== reason.trim()) wrong.push(`classification reason stored with its outer spaces, not trimmed`);
  expect(wrong, wrong.join("; ")).toEqual([]);
  return `${results.join(", ")}; limit 3–500 (501 refused, never a 500); script and Hindi shown as text to the owner`;
}, local);

qa("TC-FLD-121", "a reject meant for a pending registration is refused for a shop that is already approved and trading", async () => {
  const owner = await freshOwner("fld121r");
  const live = await cloneShop(need(world().shops.A?.id, "shop A"), { ownerId: owner.id, status: "APPROVED", label: "Live Shop" });
  const res = await call(await as("ops"), "POST", `/api/shops/${live.id}/reject`, { reason: "QA reject an approved shop" });
  const [row] = await db()<{ status: string }[]>`select status::text from shops where id = ${live.id}`;
  expect({ status: res.status, stored: row.status }, `POST /reject on an APPROVED shop — ${why(res)}`).toEqual({ status: 409, stored: "APPROVED" });
  return `reject on an approved shop → ${res.status}, status ${row.status}`;
}, { ...local, partial: "an approved shop is suspended (with the suspension policy and notices), never 'rejected'; approveShop refuses a non-pending shop, rejectShop has no such check" });

/* ======================================================== cart left clean */

qa("TC-ADM-003", "customer 1's cart is left empty after the exception checks", async () => {
  await emptyCart();
  const address = await defaultAddress();
  expect(address, "customer 1 still has an address").not.toBeNull();
  const listing = await sellable("A");
  expectStatus(await addToCart("customer", listing.shopProductId, 1), [200, 201], "cart works");
  await emptyCart();
  void fulfil;
  return "cart empty";
}, local);
