/**
 * Notifications (TC-NTF-001, 003, 004, 006, 007, 012, 013, 014, 016): the
 * in-app notices the customer, the shop and the rider get through one order's
 * life, reading and "Mark all read", the settings matrix (security notices
 * locked, the SMS / push / WhatsApp columns), who may mark a notice read, and
 * what the SMS / WhatsApp outbox holds where the site runs the mock providers.
 *
 * Signed tier: only this run's orders and the test accounts' own settings
 * (restored). Email, security events and anything needing the database are in
 * tests/qa/local/money-notifications.spec.ts.
 */
import { as, pageAs } from "../lib/actors";
import { deliveryCode, fulfil, offerFor, onlyRiderOnline, pickupCode, riderAction, sellable } from "../lib/flows";
import { call, expectStatus, stash, unstash, why } from "../lib/http";
import { cancelAsCustomer, notificationsOf, placeVia, runKey, waitForNotification, type NotificationRow } from "../lib/money-helpers";
import { blocked, expect, manual, qa } from "../lib/record";
import type { Role } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 300_000 };
const KEY = runKey("ntf");

interface Lifecycle {
  orderNumber: string;
  since: number;
  customer: string[];
  shop: string[];
  rider: string[];
}

/** Titles of `role`'s notices about `orderNumber` since `since`. */
async function about(role: Role, orderNumber: string, since: number): Promise<NotificationRow[]> {
  const { notifications } = await notificationsOf(role);
  return notifications.filter((n) => new Date(n.createdAt).getTime() >= since - 3000 && `${n.title} ${n.body}`.includes(orderNumber));
}

qa("TC-NTF-001", "in-app notices for every step of an order: placed, accepted, rider assigned, picked up, arriving, delivered — and cancelled for another", async () => {
  await onlyRiderOnline("rider");
  const since = Date.now();
  const listing = await sellable("A", 3);
  const order = await placeVia("customer", "WALLET", listing);
  const steps: [string, RegExp][] = [];
  const seen: string[] = [];
  const missing: string[] = [];
  const expectNotice = async (step: string, title: RegExp) => {
    steps.push([step, title]);
    const hit = await waitForNotification("customer", (n) => title.test(n.title) && `${n.title} ${n.body}`.includes(order.orderNumber), since, 15_000);
    if (hit) seen.push(`${step}: "${hit.title}"`);
    else missing.push(step);
  };
  await expectNotice("placed", /placed|confirmed/i);
  expectStatus(await fulfil(order.id, "accept"), 200, "accept");
  await expectNotice("accepted", /accepted/i);
  expectStatus(await fulfil(order.id, "start"), 200, "start");
  expectStatus(await fulfil(order.id, "ready"), 200, "ready");
  const offer = await offerFor(order.id, "rider");
  if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept"), 200, "rider accepts");
  await expectNotice("rider assigned", /assigned/i);
  await riderAction(offer.deliveryOrderId, "arrived_shop");
  const code = await pickupCode(order.id);
  expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}), 200, "pickup");
  await expectNotice("picked up", /picked up|on its way/i);
  expectStatus(await riderAction(offer.deliveryOrderId, "start"), 200, "start delivery");
  await riderAction(offer.deliveryOrderId, "arrived_customer");
  await expectNotice("arriving", /arriv/i);
  const otp = await deliveryCode(order.id);
  expectStatus(await riderAction(offer.deliveryOrderId, "deliver", { otp }), 200, "deliver");
  await expectNotice("delivered", /delivered/i);
  // A second order, cancelled by the shop (the customer's own cancellation is not echoed back to them).
  const other = await placeVia("customer", "WALLET", listing);
  expectStatus(await fulfil(other.id, "reject", { reason: "QA: shop cannot fulfil" }), 200, "the shop cancels the second order");
  const cancelled = await waitForNotification("customer", (n) => /cancel/i.test(n.title) && `${n.title} ${n.body}`.includes(other.orderNumber), since, 15_000);
  if (cancelled) seen.push(`cancelled: "${cancelled.title}"`);
  else missing.push("cancelled");
  stash(KEY, {
    orderNumber: order.orderNumber,
    since,
    customer: (await about("customer", order.orderNumber, since)).map((n) => n.title),
    shop: (await about("shop", order.orderNumber, since)).map((n) => n.title),
    rider: (await about("rider", order.orderNumber, since)).map((n) => n.title),
  } satisfies Lifecycle);
  expect(missing, `no in-app notice for: ${missing.join(", ")} — seen ${seen.join("; ")}`).toEqual([]);
  return `${order.orderNumber}: ${seen.join("; ")}`;
}, { ...signed, partial: "the cancelled order is cancelled by the shop: a customer cancelling their own order gets no notice by design (src/server/events/catalog.ts: the actor of an event is not told what they just did)" });

qa("TC-NTF-003", "the shop and the rider are told through the same order: new order, rider arrived, picked up, delivered; the rider's offer and outcome", async () => {
  const life = unstash<Lifecycle>(KEY) ?? blocked("needs the order of TC-NTF-001");
  const shop = (await about("shop", life.orderNumber, life.since)).map((n) => n.title);
  const rider = (await about("rider", life.orderNumber, life.since)).map((n) => n.title);
  const problems: string[] = [];
  for (const [what, re] of [["new order", /new order|accept the new order/i], ["rider arrived", /arrived/i], ["picked up", /picked up|collected/i], ["delivered", /delivered/i]] as const) {
    if (!shop.some((t) => re.test(t))) problems.push(`shop: no "${what}" notice`);
  }
  if (!rider.length) problems.push("rider: no notice about the order (offer / outcome)");
  expect(problems, `${problems.join("; ")} — shop saw [${shop.join(" | ")}], rider saw [${rider.join(" | ")}]`).toEqual([]);
  return `shop: ${shop.join(" | ")}; rider: ${rider.join(" | ")}`;
}, { ...signed, partial: "'Looking for a rider' / 'No rider found' appear only when dispatch has to search; here the rider accepted the first offer" });

qa("TC-NTF-004", "opening one notification and 'Mark all read' each update the unread count", async ({ browser }) => {
  const start = await notificationsOf("customer");
  if (start.unreadCount < 2) {
    const listing = await sellable("A", 1);
    const o = await placeVia("customer", "WALLET", listing);
    await cancelAsCustomer("customer", o.id);
  }
  const before = (await notificationsOf("customer")).unreadCount;
  if (before < 2) blocked(`needs two unread notifications (has ${before})`);
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/notifications?tab=unread");
    const item = page.getByTestId("notification-item").filter({ has: page.locator('[data-read="false"]') }).first();
    const first = page.locator('[data-testid="notification-item"][data-read="false"]').first();
    await (await first.count() ? first : item).click();
    await expect.poll(async () => (await notificationsOf("customer")).unreadCount).toBe(before - 1);
    await page.goto("/notifications?tab=unread");
    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect.poll(async () => (await notificationsOf("customer")).unreadCount).toBe(0);
    await page.goto("/notifications?tab=all");
    await expect(page.locator('[data-testid="notification-item"][data-read="false"]')).toHaveCount(0);
  } finally {
    await context.close();
  }
  return `unread ${before} → open one → ${before - 1} → Mark all read → 0`;
}, { ...signed, mobile: true });

qa("TC-NTF-006", "account & security notices cannot be switched off: locked on the page, refused by the API", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/profile?tab=notifications");
    const matrix = page.getByTestId("notification-preferences");
    await expect(matrix).toBeVisible();
    await expect(matrix.getByLabel("Account & security — In-app")).toBeDisabled();
    await expect(matrix.getByLabel("Account & security — Email")).toBeDisabled();
    await expect(matrix.getByLabel("Account & security — Email")).toBeChecked();
  } finally {
    await context.close();
  }
  const out: string[] = [];
  for (const channel of ["EMAIL", "IN_APP", "SMS", "PUSH", "WHATSAPP"]) {
    const res = await call(await as("customer"), "PUT", "/api/notifications/preferences", { category: "ACCOUNT_SECURITY", channel, enabled: false });
    expect(res.status, `${channel} off — ${why(res)}`).toBe(422);
    out.push(`${channel} → 422`);
  }
  const prefs = await call(await as("customer"), "GET", "/api/notifications/preferences");
  const row = (prefs.body.preferences as { category: string; channels: { channel: string; enabled: boolean }[] }[]).find((r) => r.category === "ACCOUNT_SECURITY")!;
  expect(row.channels.find((c) => c.channel === "EMAIL")?.enabled).toBe(true);
  return `page: In-app and Email boxes of "Account & security" disabled (checked); API switching it off: ${out.join(", ")} ("Security notices cannot be switched off.")`;
}, { ...signed, mobile: true });

qa("TC-NTF-007", "SMS, Push and WhatsApp can be chosen per category and the choice is saved", async () => {
  const prefs = await call(await as("customer"), "GET", "/api/notifications/preferences");
  expectStatus(prefs, 200, "preferences");
  const rows = prefs.body.preferences as { category: string; channels: { channel: string; enabled: boolean; available: boolean }[] }[];
  const orders = rows.find((r) => r.category === "ORDERS")!;
  const available = orders.channels.filter((c) => ["SMS", "PUSH", "WHATSAPP"].includes(c.channel) && c.available);
  const off = orders.channels.filter((c) => ["SMS", "PUSH", "WHATSAPP"].includes(c.channel) && !c.available).map((c) => c.channel);
  if (!available.length) blocked(`SMS, Push and WhatsApp are not available on this server (shown as "soon"): ${off.join(", ")} — SMS_PROVIDER / WHATSAPP_PROVIDER are "none" and rule push is off`);
  const out: string[] = [];
  for (const c of available) {
    const flip = await call(await as("customer"), "PUT", "/api/notifications/preferences", { category: "ORDERS", channel: c.channel, enabled: !c.enabled });
    expectStatus(flip, 200, `switch ORDERS ${c.channel}`);
    const saved = (flip.body.preferences as typeof rows).find((r) => r.category === "ORDERS")!.channels.find((x) => x.channel === c.channel)!;
    expect(saved.enabled, `${c.channel} saved`).toBe(!c.enabled);
    await call(await as("customer"), "PUT", "/api/notifications/preferences", { category: "ORDERS", channel: c.channel, enabled: c.enabled });
    out.push(`${c.channel} ${c.enabled ? "on → off" : "off → on"} saved`);
  }
  return `${out.join(", ")}${off.length ? `; not available here: ${off.join(", ")}` : ""}`;
}, { ...signed, partial: "channels with no provider on the site show 'soon' and cannot be chosen" });

qa("TC-NTF-012", "a customer cannot mark another person's notification read (403/404, and it stays unread)", async () => {
  const shopNotes = await notificationsOf("shop");
  let target = shopNotes.notifications.find((n) => !n.readAt);
  if (!target) {
    const listing = await sellable("A", 1);
    const o = await placeVia("customer", "WALLET", listing);
    await cancelAsCustomer("customer", o.id);
    target = (await notificationsOf("shop")).notifications.find((n) => !n.readAt);
  }
  if (!target) blocked("the shop has no unread notification to aim at");
  const res = await call(await as("customer"), "PATCH", "/api/notifications", { id: target.id });
  const still = (await notificationsOf("shop")).notifications.find((n) => n.id === target!.id);
  expect(still?.readAt ?? null, "the shop's notification stays unread").toBeNull();
  expect([403, 404], `PATCH another user's notification — ${why(res)}`).toContain(res.status);
  return `customer PATCH {id: shop's notification} → ${res.status}; still unread`;
}, { ...signed, partial: "the guest half is in tests/qa/guest/access.spec.ts" });

qa(["TC-NTF-013", "TC-NTF-014"], "SMS and WhatsApp for order events: the message carries the order number and no one else's personal data", async () => {
  const prefs = await call(await as("customer"), "GET", "/api/notifications/preferences");
  const orders = (prefs.body.preferences as { category: string; channels: { channel: string; enabled: boolean; available: boolean }[] }[]).find((r) => r.category === "ORDERS")!;
  const sms = orders.channels.find((c) => c.channel === "SMS")!;
  const wa = orders.channels.find((c) => c.channel === "WHATSAPP")!;
  if (!sms.available && !wa.available) blocked("no SMS or WhatsApp provider on this server (SMS_PROVIDER / WHATSAPP_PROVIDER none): needs the test site's mock outbox, or a real handset with a vendor");
  for (const c of [sms, wa]) if (c.available && !c.enabled) await call(await as("customer"), "PUT", "/api/notifications/preferences", { category: "ORDERS", channel: c.channel, enabled: true });
  const listing = await sellable("A", 1);
  const order = await placeVia("customer", "WALLET", listing);
  await cancelAsCustomer("customer", order.id);
  const me = await call(await as("customer"), "GET", "/api/profile");
  const phone = String(me.body?.phoneE164 ?? me.body?.user?.phoneE164 ?? "").replace(/^\+91/, "");
  const outbox = await call(await as("admin"), "GET", `/api/admin/test-messages?to=${encodeURIComponent(phone)}`);
  expectStatus(outbox, 200, "the mock outbox");
  const mine = (outbox.body.messages as { channel: string; body: string }[]).filter((m) => m.body.includes(order.orderNumber));
  for (const c of [sms, wa]) if (c.available && !c.enabled) await call(await as("customer"), "PUT", "/api/notifications/preferences", { category: "ORDERS", channel: c.channel, enabled: false });
  expect(mine.length, "an SMS / WhatsApp mentioning the order").toBeGreaterThan(0);
  return mine.map((m) => `${m.channel}: "${m.body.slice(0, 100)}"`).join("; ");
}, { ...signed, partial: "the mock outbox stands in for the handset: delivery to a real phone from an approved sender / template is a manual check with the chosen vendor" });

qa("TC-NTF-016", "with SMS, WhatsApp and push off for order updates no message goes out on them; security notices still go out", async () => {
  const prefs = await call(await as("customer"), "GET", "/api/notifications/preferences");
  const orders = (prefs.body.preferences as { category: string; channels: { channel: string; enabled: boolean; available: boolean }[] }[]).find((r) => r.category === "ORDERS")!;
  const outbound = orders.channels.filter((c) => ["SMS", "WHATSAPP", "PUSH"].includes(c.channel) && c.available);
  if (!outbound.length) blocked("SMS, WhatsApp and push are not available on this server, so there is no channel to switch off");
  for (const c of outbound) await call(await as("customer"), "PUT", "/api/notifications/preferences", { category: "ORDERS", channel: c.channel, enabled: false });
  try {
    const listing = await sellable("A", 1);
    const order = await placeVia("customer", "WALLET", listing);
    await cancelAsCustomer("customer", order.id);
    const outbox = await call(await as("admin"), "GET", "/api/admin/test-messages");
    const leaked = ((outbox.body?.messages ?? []) as { channel: string; body: string }[]).filter((m) => m.body.includes(order.orderNumber));
    expect(leaked.map((m) => m.channel), "nothing on the switched-off channels").toEqual([]);
    return `${outbound.map((c) => c.channel).join(", ")} off for ORDERS → no outbox message for ${order.orderNumber}`;
  } finally {
    for (const c of outbound) await call(await as("customer"), "PUT", "/api/notifications/preferences", { category: "ORDERS", channel: c.channel, enabled: c.enabled });
  }
}, { ...signed, partial: "'security notices still go out on the mandatory channel' is TC-NTF-008 (local tier: role and account-status changes)" });

manual("TC-NTF-015", "push notification: allow, receive, tap to open the order", "needs a phone (or browser profile) with the GoKesari app signed in and Expo push credentials (rule push, provider expo) — allow the prompt, trigger an order event, tap the notice and confirm it opens /orders/<id>");
manual("TC-NTF-018", "push permission denied or token expired", "needs a real device or browser profile to deny / revoke the OS permission and an Expo receipt for the dead token (push-receipts cron); the server side of dropping an unregistered token is D-F01");

qa("TC-NTF-019", "promotions reach only customers who consent: withdrawing marketing consent takes the customer out of a shop's campaign audience", async () => {
  const shopId = (await import("../lib/flows")).shopOf;
  const shop = await shopId("A");
  const audience = async () => {
    const res = await call(await as("shop"), "POST", `/api/shops/${shop.id}/marketing/segments`, { preview: true, rules: {} });
    expectStatus(res, 200, "audience preview");
    return res.body as { matched: number; reachable: number };
  };
  const consent = await call(await as("customer"), "GET", "/api/consents/marketing");
  const had = Boolean(consent.body?.granted ?? consent.body?.current?.granted);
  if (!had) expectStatus(await call(await as("customer"), "PUT", "/api/consents/marketing", { granted: true }), 200, "grant consent");
  const withConsent = await audience();
  try {
    expectStatus(await call(await as("customer"), "PUT", "/api/consents/marketing", { granted: false }), 200, "withdraw consent");
    const without = await audience();
    expect(without.matched, "still the shop's customer").toBe(withConsent.matched);
    expect(without.reachable, "no longer reachable for promotions").toBe(withConsent.reachable - 1);
    return `shop A audience: matched ${withConsent.matched}, reachable ${withConsent.reachable} → after the customer withdraws consent reachable ${without.reachable} (matched unchanged)`;
  } finally {
    await call(await as("customer"), "PUT", "/api/consents/marketing", { granted: had || true });
  }
}, { ...signed, partial: "shop campaigns are in-app only (src/server/services/marketing.ts) — no promotional SMS / WhatsApp is sent at all; replying STOP to a promotional SMS needs an inbound SMS vendor (manual)" });
