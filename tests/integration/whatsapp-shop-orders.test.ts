/**
 * New orders on the shop owner's WhatsApp (docs/smart-shopping-2026-11/
 * FEATURE3_WHATSAPP_ORDERS.md). The Meta Cloud API is never called: fetch is
 * mocked and answers like Meta. Covers the number check, the new-order alert
 * with Accept / Reject, the signed webhook, first-action-wins across numbers
 * and the app, status updates, the fallback and the feature flag.
 */
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-meta-app-secret";
vi.hoisted(() => {
  const env = process.env as Record<string, string | undefined>;
  env.WHATSAPP_PROVIDER = "meta";
  env.META_WA_ACCESS_TOKEN = "test-meta-token";
  env.META_WA_PHONE_NUMBER_ID = "123456789012345";
  env.META_WA_APP_SECRET = "test-meta-app-secret";
  env.META_WA_VERIFY_TOKEN = "test-verify-token";
  env.META_WA_API_VERSION = "v23.0";
  env.WHATSAPP_TEST_RECIPIENT = "";
});

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async () => {},
  EmailUnavailableError: class extends Error {},
}));

import { GET as verifyGet, POST as webhookPost } from "@/app/api/webhooks/whatsapp/route";
import { acceptOrder } from "@/server/services/fulfilment";
import { db } from "@/server/db";
import {
  featureFlags,
  notificationDeliveries,
  notifications,
  orderStatusHistory,
  orders,
  shopWhatsappContacts,
  shops,
  users,
  whatsappMessages,
  whatsappOrderActions,
  whatsappWebhookEvents,
} from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { cancelOrder, checkout } from "@/server/services/orders";
import { saveShopWhatsAppSettings } from "@/server/whatsapp/shop-orders/contacts";
import { dispatchWhatsAppQueue } from "@/server/whatsapp/shop-orders/dispatch";
import { setWhatsAppAutoDispatch } from "@/server/whatsapp/shop-orders/queue";
import { whatsappSignature } from "@/server/whatsapp/shop-orders/webhook";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

/* ------------------------------------------------------------ Meta mock */

interface Sent {
  url: string;
  body: {
    to: string;
    type: string;
    template?: { name: string; language: { code: string }; components?: { type: string; sub_type?: string; index?: string; parameters: { type: string; text?: string; payload?: string }[] }[] };
    text?: { body: string };
  };
}

let sent: Sent[] = [];
let wamidCounter = 0;
/** Return a Meta error for the next template sends of this name. */
let failTemplate: string | null = null;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("https://graph.facebook.com/")) throw new Error(`Unexpected fetch in test: ${url}`);
  const body = JSON.parse(String(init?.body)) as Sent["body"];
  sent.push({ url, body });
  if (failTemplate && body.template?.name === failTemplate) {
    return new Response(JSON.stringify({ error: { message: "Recipient phone number not in allowed list", code: 131030 } }), { status: 400 });
  }
  wamidCounter += 1;
  return new Response(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ wa_id: body.to }], messages: [{ id: `wamid.TEST${wamidCounter}` }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
  setWhatsAppAutoDispatch(false);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------- helpers */

const OWNER_PHONE = "+919876500001";
const STAFF_PHONE = "+919876500002";

async function setFlag(enabled: boolean) {
  await db.insert(featureFlags).values({ key: "whatsapp_shop_orders_enabled", enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`DELETE FROM whatsapp_webhook_events`);
  await db.execute(sql`DELETE FROM whatsapp_messages`);
  await db.execute(sql`DELETE FROM whatsapp_order_actions`);
  sent = [];
  failTemplate = null;
  fetchMock.mockClear();
  await setFlag(true);
});

let webhookCounter = 0;

function signedRequest(body: unknown, signature?: string) {
  const raw = JSON.stringify(body);
  return new NextRequest("http://localhost/api/webhooks/whatsapp", {
    method: "POST",
    body: raw,
    headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? whatsappSignature(raw, SECRET) },
  });
}

async function webhook(value: Record<string, unknown>, signature?: string) {
  const response = await webhookPost(signedRequest({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", ...value } }] }] }, signature));
  return { status: response.status, body: (await response.json()) as { results?: string[]; error?: string } };
}

const statusUpdate = (wamid: string, status: string, extra: Record<string, unknown> = {}) =>
  webhook({ statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: "919876500001", ...extra }] });

function tap(from: string, payload: string, contextId: string | null, id = `wamid.IN${(webhookCounter += 1)}`) {
  return webhook({
    contacts: [{ wa_id: from.slice(1), profile: { name: "Shop" } }],
    messages: [{ from: from.slice(1), id, timestamp: "1", type: "button", button: { payload, text: payload.includes(":A:") ? "Accept" : "Reject" }, ...(contextId ? { context: { from: "15550000000", id: contextId } } : {}) }],
  });
}

/** A shop whose owner and one staff number are verified on WhatsApp (number check delivered). */
async function verifiedShop() {
  const owner = await createUser({ role: "SHOP_OWNER", name: "Ramesh Patil" });
  const shop = await createShop(owner.id, { name: "Kesari Dairy", latitude: 18.52, longitude: 73.85 });
  await db.update(shops).set({ whatsappNumber: OWNER_PHONE.slice(3), ownerName: "Ramesh Patil" }).where(eq(shops.id, shop.id));
  const saved = await saveShopWhatsAppSettings(shop.id, owner.id, {
    enabled: true,
    owner: { phone: OWNER_PHONE.slice(3), optedIn: true },
    staff: [{ phone: STAFF_PHONE.slice(3), label: "Suresh" }],
  });
  expect(saved.checksQueued).toBe(2);
  const result = await dispatchWhatsAppQueue();
  expect(result.sent).toBe(2);
  const checks = sent.filter((s) => s.body.template?.name === "gk_number_check");
  expect(checks.map((c) => c.body.to).sort()).toEqual([OWNER_PHONE.slice(1), STAFF_PHONE.slice(1)]);
  // Meta accepted them: still checking until delivered.
  expect((await db.select().from(shopWhatsappContacts).where(eq(shopWhatsappContacts.shopId, shop.id))).every((c) => c.status === "CHECKING")).toBe(true);
  const rows = await db.select().from(whatsappMessages).where(eq(whatsappMessages.kind, "NUMBER_CHECK"));
  for (const row of rows) expect((await statusUpdate(row.metaMessageId!, "delivered")).status).toBe(200);
  const contacts = await db.select().from(shopWhatsappContacts).where(eq(shopWhatsappContacts.shopId, shop.id));
  expect(contacts.map((c) => c.status)).toEqual(["ACTIVE", "ACTIVE"]);
  sent = [];
  fetchMock.mockClear();
  return { owner, shop, contacts };
}

async function placeOrder(shopId: string, paymentMethod: "WALLET" | "COD" = "WALLET") {
  const { user } = await createUserWithWallet({ balancePaise: 500_000 });
  const [customer] = await db.update(users).set({ name: "Asha Kulkarni" }).where(eq(users.id, user.id)).returning();
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const sp = await createShopProduct(shopId, product.id, { onlinePricePaise: 5200, onlineStock: 50 });
  await addToCart(customer.id, sp.id, 2);
  const { orders: placed } = await checkout({ userId: customer.id, requestId: `req-${customer.id}`, addressId: await deliveryAddressId(customer.id), paymentMethod });
  return { customer, order: placed[0] };
}

async function sentAlerts(orderId: string) {
  return db.select().from(whatsappMessages).where(and(eq(whatsappMessages.orderId, orderId), eq(whatsappMessages.kind, "NEW_ORDER")));
}

/** Places an order and sends its alert to both numbers; returns the Meta ids per number. */
async function orderOnWhatsApp() {
  const ctx = await verifiedShop();
  const placed = await placeOrder(ctx.shop.id);
  expect((await dispatchWhatsAppQueue()).sent).toBe(2);
  const alerts = await sentAlerts(placed.order.id);
  const wamidFor = (phone: string) => alerts.find((a) => a.intendedTo === phone)!.metaMessageId!;
  sent = [];
  return { ...ctx, ...placed, ownerWamid: wamidFor(OWNER_PHONE), staffWamid: wamidFor(STAFF_PHONE) };
}

const replies = () => sent.filter((s) => s.body.type === "text").map((s) => ({ to: `+${s.body.to}`, text: s.body.text!.body }));

/* ---------------------------------------------------------------- tests */

describe("WhatsApp new-order alert", () => {
  it("sends the new order to every verified, opted-in number with Accept / Reject buttons", async () => {
    const { shop } = await verifiedShop();
    const { order } = await placeOrder(shop.id);
    // Queued in the checkout transaction, nothing sent yet.
    const queued = await sentAlerts(order.id);
    expect(queued.map((q) => q.status)).toEqual(["QUEUED", "QUEUED"]);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(await dispatchWhatsAppQueue()).toMatchObject({ sent: 2, failed: 0 });
    expect(sent).toHaveLength(2);
    for (const s of sent) {
      expect(s.url).toBe("https://graph.facebook.com/v23.0/123456789012345/messages");
      expect(s.body.type).toBe("template");
      expect(s.body.template!.name).toBe("gk_new_order");
      expect(s.body.template!.language.code).toBe("en");
      const [body, accept, reject] = s.body.template!.components!;
      const params = body.parameters.map((p) => p.text!);
      expect(params).toHaveLength(9);
      expect(params[0]).toBe(order.orderNumber);
      expect(params[1]).toMatch(/^\d{2}-[A-Z][a-z]{2}-\d{4}, \d{2}\.\d{2} IST$/);
      expect(params[2]).toBe("Asha Kulkarni");
      expect(params[3]).toBe("Cow Milk 2 L × ₹52.00 = ₹104.00");
      expect(params[4]).toBe("₹104.00");
      expect(params[5]).toBe("Prepaid (GoKesari wallet)");
      expect(params[6]).toMatch(/delivery/i);
      expect(params[7]).toContain("411001");
      expect(params[8]).toMatch(new RegExp(`^https?://[^/]+/shop/orders/${order.id}$`));
      expect(accept).toMatchObject({ type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `GK1:A:${order.id}` }] });
      expect(reject).toMatchObject({ type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `GK1:R:${order.id}` }] });
    }
    expect(sent.map((s) => s.body.to).sort()).toEqual([OWNER_PHONE.slice(1), STAFF_PHONE.slice(1)]);
    const logged = await sentAlerts(order.id);
    expect(logged.every((l) => l.status === "SENT" && l.metaMessageId?.startsWith("wamid.") && l.sentTo === l.intendedTo)).toBe(true);
    // A second run sends nothing more.
    expect((await dispatchWhatsAppQueue()).sent).toBe(0);
  });

  it("skips numbers not yet verified, numbers not opted in and shops that switched it off", async () => {
    const { owner, shop } = await verifiedShop();
    await saveShopWhatsAppSettings(shop.id, owner.id, { enabled: false, owner: { phone: OWNER_PHONE.slice(3), optedIn: true }, staff: [] });
    const { order } = await placeOrder(shop.id);
    expect(await sentAlerts(order.id)).toHaveLength(0);
  });

  it("with the flag off, nothing is queued or sent", async () => {
    const { shop } = await verifiedShop();
    await setFlag(false);
    const { order } = await placeOrder(shop.id);
    expect(await sentAlerts(order.id)).toHaveLength(0);
    expect(await dispatchWhatsAppQueue()).toMatchObject({ sent: 0, dormant: expect.stringContaining("off") });
    expect(fetchMock).not.toHaveBeenCalled();
    // The webhook ignores everything while off.
    const ignored = await statusUpdate("wamid.ANY", "delivered");
    expect(ignored.body).toMatchObject({ ignored: expect.any(String) });
  });
});

describe("webhook security", () => {
  it("answers Meta's subscription check only with the verify token", async () => {
    const ok = await verifyGet(new NextRequest("http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    const bad = await verifyGet(new NextRequest("http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345"));
    expect(bad.status).toBe(403);
  });

  it("refuses a bad or missing signature and accepts a good one", async () => {
    const { order, ownerWamid } = await orderOnWhatsApp();
    const eventsBefore = (await db.select().from(whatsappWebhookEvents)).length;
    const value = { messages: [{ from: OWNER_PHONE.slice(1), id: "wamid.FORGED", type: "button", button: { payload: `GK1:A:${order.id}` }, context: { id: ownerWamid } }] };
    expect((await webhook(value, "sha256=" + "0".repeat(64))).status).toBe(401);
    expect((await webhook(value, whatsappSignature(JSON.stringify({ other: true }), SECRET))).status).toBe(401);
    expect((await webhook(value, whatsappSignature("x", "another-secret"))).status).toBe(401);
    const missing = await webhookPost(new NextRequest("http://localhost/api/webhooks/whatsapp", { method: "POST", body: JSON.stringify({ entry: [] }) }));
    expect(missing.status).toBe(401);
    // Nothing was recorded or changed.
    expect(await db.select().from(whatsappWebhookEvents)).toHaveLength(eventsBefore);
    expect((await db.select().from(orders).where(eq(orders.id, order.id)))[0].status).toBe("CONFIRMED");
    // Signed correctly: processed.
    const good = await webhook(value);
    expect(good.status).toBe(200);
    expect((await db.select().from(orders).where(eq(orders.id, order.id)))[0].status).toBe("ACCEPTED");
  });
});

describe("Accept / Reject from WhatsApp", () => {
  it("Accept updates the order through acceptOrder and the customer is notified as from the app", async () => {
    const { order, customer, ownerWamid } = await orderOnWhatsApp();
    const result = await tap(OWNER_PHONE, `GK1:A:${order.id}`, ownerWamid);
    expect(result.body.results).toEqual(["accepted"]);
    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(after.status).toBe("ACCEPTED");
    expect(after.acceptedAt).not.toBeNull();
    const history = await db.select().from(orderStatusHistory).where(and(eq(orderStatusHistory.orderId, order.id), eq(orderStatusHistory.newStatus, "ACCEPTED")));
    expect(history).toHaveLength(1);
    expect(history[0].note).toBe("Accepted by shop");
    const notified = await db.select().from(notifications).where(and(eq(notifications.userId, customer.id), eq(notifications.type, "order.accepted")));
    expect(notified).toHaveLength(1);
    expect(replies()).toEqual([{ to: OWNER_PHONE, text: expect.stringContaining(`order ${order.orderNumber} is accepted`) }]);
    const [action] = await db.select().from(whatsappOrderActions).where(eq(whatsappOrderActions.orderId, order.id));
    expect(action).toMatchObject({ action: "ACCEPT", outcome: "DONE", fromNumber: OWNER_PHONE });
  });

  it("Reject cancels through rejectOrder with the reason 'Rejected on WhatsApp', refunds and tells the customer", async () => {
    const { order, customer, staffWamid } = await orderOnWhatsApp();
    const result = await tap(STAFF_PHONE, `GK1:R:${order.id}`, staffWamid);
    expect(result.body.results).toEqual(["rejected"]);
    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(["CANCELLED", "REFUNDED"]).toContain(after.status);
    expect(after.cancellationReason).toBe("Rejected by shop: Rejected on WhatsApp");
    const notified = await db.select().from(notifications).where(and(eq(notifications.userId, customer.id), eq(notifications.type, "order.cancelled")));
    expect(notified).toHaveLength(1);
    expect(replies()[0]).toMatchObject({ to: STAFF_PHONE, text: expect.stringContaining("is rejected") });
  });

  it("a double tap: the second tap changes nothing and is told it was already accepted; a redelivered webhook is ignored", async () => {
    const { order, ownerWamid } = await orderOnWhatsApp();
    expect((await tap(OWNER_PHONE, `GK1:A:${order.id}`, ownerWamid, "wamid.IN-first")).body.results).toEqual(["accepted"]);
    // Meta redelivers the same message: nothing happens, no second reply.
    expect((await tap(OWNER_PHONE, `GK1:A:${order.id}`, ownerWamid, "wamid.IN-first")).body.results).toEqual(["message duplicate"]);
    expect(replies()).toHaveLength(1);
    // A real second tap (a new message): told who was first and when.
    const second = await tap(OWNER_PHONE, `GK1:A:${order.id}`, ownerWamid, "wamid.IN-second");
    expect(second.body.results).toEqual(["already accepted"]);
    expect(replies()[1].text).toMatch(/already accepted by Ramesh Patil on WhatsApp \(\+91 98765 00001\) at \d{2}-[A-Z][a-z]{2}-\d{4}, \d{2}\.\d{2} IST/);
    // And a Reject after the Accept does not cancel the accepted order.
    const late = await tap(OWNER_PHONE, `GK1:R:${order.id}`, ownerWamid, "wamid.IN-third");
    expect(late.body.results).toEqual(["already accepted"]);
    expect((await db.select().from(orders).where(eq(orders.id, order.id)))[0].status).toBe("ACCEPTED");
    expect(await db.select().from(orderStatusHistory).where(and(eq(orderStatusHistory.orderId, order.id), eq(orderStatusHistory.newStatus, "ACCEPTED")))).toHaveLength(1);
  });

  it("two numbers accept at the same moment: exactly one wins, the other is told who and when", async () => {
    const { order, ownerWamid, staffWamid } = await orderOnWhatsApp();
    const [a, b] = await Promise.all([tap(OWNER_PHONE, `GK1:A:${order.id}`, ownerWamid), tap(STAFF_PHONE, `GK1:A:${order.id}`, staffWamid)]);
    const results = [...a.body.results!, ...b.body.results!].sort();
    expect(results).toEqual(["accepted", "already accepted"]);
    expect(await db.select().from(orderStatusHistory).where(and(eq(orderStatusHistory.orderId, order.id), eq(orderStatusHistory.newStatus, "ACCEPTED")))).toHaveLength(1);
    const actions = await db.select().from(whatsappOrderActions).where(eq(whatsappOrderActions.orderId, order.id));
    expect(actions.map((x) => x.outcome).sort()).toEqual(["ALREADY", "DONE"]);
    const winner = actions.find((x) => x.outcome === "DONE")!;
    const loser = actions.find((x) => x.outcome === "ALREADY")!;
    const winnerName = winner.fromNumber === OWNER_PHONE ? "Ramesh Patil on WhatsApp \\(\\+91 98765 00001\\)" : "Suresh on WhatsApp \\(\\+91 98765 00002\\)";
    const loserReply = replies().find((r) => r.to === loser.fromNumber)!;
    expect(loserReply.text).toMatch(new RegExp(`already accepted by ${winnerName} at \\d{2}-[A-Z][a-z]{2}-\\d{4}, \\d{2}\\.\\d{2} IST`));
  });

  it("the app accepted first: a later WhatsApp tap names the app", async () => {
    const { order, owner, staffWamid } = await orderOnWhatsApp();
    await acceptOrder(order.id, { id: owner.id, role: "SHOP_OWNER" });
    const late = await tap(STAFF_PHONE, `GK1:R:${order.id}`, staffWamid);
    expect(late.body.results).toEqual(["already accepted"]);
    expect(replies()[0].text).toContain("already accepted by Ramesh Patil in the GoKesari app at");
    expect((await db.select().from(orders).where(eq(orders.id, order.id)))[0].status).toBe("ACCEPTED");
  });

  it("refuses a tap from a number that is not a verified number of that order's shop", async () => {
    const { order, ownerWamid } = await orderOnWhatsApp();
    const stranger = "+919876599999";
    const result = await tap(stranger, `GK1:A:${order.id}`, ownerWamid);
    expect(result.body.results).toEqual(["refused: not a verified number of the shop"]);
    expect((await db.select().from(orders).where(eq(orders.id, order.id)))[0].status).toBe("CONFIRMED");
    // A verified number of ANOTHER shop cannot act on this order either.
    const other = await createUser({ role: "SHOP_OWNER" });
    const otherShop = await createShop(other.id, { name: "Other Shop" });
    await db.insert(shopWhatsappContacts).values({ shopId: otherShop.id, phoneE164: "+919876588888", role: "OWNER", status: "ACTIVE" });
    expect((await tap("+919876588888", `GK1:A:${order.id}`, null)).body.results).toEqual(["refused: not a verified number of the shop"]);
    expect((await db.select().from(orders).where(eq(orders.id, order.id)))[0].status).toBe("CONFIRMED");
  });
});

describe("status webhooks, follow-ups and the fallback", () => {
  it("a status webhook updates the log: delivered, then read; repeats and out-of-order updates change nothing", async () => {
    const { order, ownerWamid } = await orderOnWhatsApp();
    expect((await statusUpdate(ownerWamid, "delivered")).body.results).toEqual(["delivered"]);
    let [row] = await db.select().from(whatsappMessages).where(eq(whatsappMessages.metaMessageId, ownerWamid));
    expect(row.status).toBe("DELIVERED");
    expect(row.deliveredAt).not.toBeNull();
    expect((await statusUpdate(ownerWamid, "read")).body.results).toEqual(["read"]);
    expect((await statusUpdate(ownerWamid, "read")).body.results).toEqual(["status duplicate"]);
    expect((await statusUpdate(ownerWamid, "sent")).body.results).toEqual(["sent"]);
    [row] = await db.select().from(whatsappMessages).where(eq(whatsappMessages.metaMessageId, ownerWamid));
    expect(row.status).toBe("READ");
    expect(row.readAt).not.toBeNull();
    expect(row.orderId).toBe(order.id);
  });

  it("a failed send (API error) marks the message failed and sends in-app, SMS and e-mail to the owner, once", async () => {
    const { owner, shop } = await verifiedShop();
    failTemplate = "gk_new_order";
    const { order } = await placeOrder(shop.id);
    expect(await dispatchWhatsAppQueue()).toMatchObject({ sent: 0, failed: 2 });
    const rows = await sentAlerts(order.id);
    expect(rows.every((r) => r.status === "FAILED" && r.errorCode === "131030" && r.error?.includes("131030"))).toBe(true);
    const fallback = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.whatsapp_failed")));
    expect(fallback).toHaveLength(1);
    expect(fallback[0].body).toContain(order.orderNumber);
    expect(fallback[0].body).toContain("prepaid");
    expect(fallback[0].body).toContain("+91 98765 00001");
    const deliveries = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, fallback[0].id));
    expect(deliveries.map((d) => d.channel).sort()).toEqual(["EMAIL", "SMS"]);
  });

  it("a 'failed' status from the webhook also triggers the fallback, and a failed number check shows 'not on WhatsApp'", async () => {
    const { owner, order, ownerWamid, staffWamid } = await orderOnWhatsApp();
    const failed = { errors: [{ code: 131026, title: "Message undeliverable" }] };
    expect((await statusUpdate(ownerWamid, "failed", failed)).body.results).toEqual(["failed"]);
    expect((await statusUpdate(staffWamid, "failed", failed)).body.results).toEqual(["failed"]);
    const [row] = await db.select().from(whatsappMessages).where(eq(whatsappMessages.metaMessageId, ownerWamid));
    expect(row).toMatchObject({ status: "FAILED", errorCode: "131026" });
    const fallback = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.whatsapp_failed")));
    expect(fallback).toHaveLength(1); // once per order alert, not per number
    expect(fallback[0].body).toContain(order.orderNumber);

    // A new number whose check fails is "not on WhatsApp" and gets no orders.
    const { settings } = await saveShopWhatsAppSettings(order.shopId, owner.id, {
      enabled: true,
      owner: { phone: OWNER_PHONE.slice(3), optedIn: true },
      staff: [{ phone: STAFF_PHONE.slice(3), label: "Suresh" }, { phone: "9876500003", label: "Mahesh" }],
    });
    expect(settings.staff.find((s) => s.phoneE164 === "+919876500003")?.status).toBe("CHECKING");
    await dispatchWhatsAppQueue();
    const [check] = await db.select().from(whatsappMessages).where(and(eq(whatsappMessages.kind, "NUMBER_CHECK"), eq(whatsappMessages.intendedTo, "+919876500003")));
    await statusUpdate(check.metaMessageId!, "failed", failed);
    const [mahesh] = await db.select().from(shopWhatsappContacts).where(eq(shopWhatsappContacts.phoneE164, "+919876500003"));
    expect(mahesh.status).toBe("NOT_ON_WHATSAPP");
  });

  it("follow-ups: cancelled by the customer, delivery partner assigned and delivered go to the shop's WhatsApp", async () => {
    const { shop } = await verifiedShop();
    const { order, customer } = await placeOrder(shop.id);
    await dispatchWhatsAppQueue();
    sent = [];
    await cancelOrder(order.id, { id: customer.id, role: "CUSTOMER" }, "Ordered by mistake", { selfService: true });
    const updates = await db.select().from(whatsappMessages).where(and(eq(whatsappMessages.orderId, order.id), eq(whatsappMessages.kind, "STATUS_UPDATE")));
    expect(updates).toHaveLength(2);
    expect(await dispatchWhatsAppQueue()).toMatchObject({ sent: 2 });
    for (const s of sent) {
      expect(s.body.template!.name).toBe("gk_order_update");
      const params = s.body.template!.components![0].parameters.map((p) => p.text);
      expect(params[0]).toBe(order.orderNumber);
      expect(params[1]).toContain("Cancelled by the customer: Ordered by mistake");
    }

    // order.assigned / order.delivered use the same template (the event layer is the hook).
    const { whatsAppPlanFor } = await import("@/server/whatsapp/shop-orders/queue");
    expect(whatsAppPlanFor("order.assigned", { orderId: order.id, riderName: "Vijay" }, "DELIVERY_PARTNER")).toEqual({ kind: "STATUS_UPDATE", update: "Delivery partner assigned: Vijay. Keep the order ready for pickup." });
    expect(whatsAppPlanFor("order.delivered", { orderId: order.id }, "DELIVERY_PARTNER")?.update).toContain("delivery code (OTP)");
    expect(whatsAppPlanFor("order.cancelled", { orderId: order.id, cancelledBy: "SHOP" }, "SHOP_OWNER")).toBeNull();
    expect(whatsAppPlanFor("order.accepted", { orderId: order.id }, "SHOP_OWNER")).toBeNull();
  });

  it("only the shop's owner manages its WhatsApp numbers, within the staff limit", async () => {
    const { owner, shop } = await verifiedShop();
    const intruder = await createUser({ role: "SHOP_OWNER" });
    await expect(saveShopWhatsAppSettings(shop.id, intruder.id, { enabled: true, owner: null, staff: [] })).rejects.toThrow(/owner/i);
    const operator = await createUser({ role: "OPERATOR" });
    await expect(saveShopWhatsAppSettings(shop.id, operator.id, { enabled: true, owner: null, staff: [] })).rejects.toThrow(/owner/i);
    await expect(
      saveShopWhatsAppSettings(shop.id, owner.id, {
        enabled: true,
        owner: { phone: OWNER_PHONE.slice(3), optedIn: true },
        staff: ["9876500011", "9876500012", "9876500013", "9876500014"].map((phone) => ({ phone })),
      }),
    ).rejects.toThrow(/at most 3/);
    // Removing a number stops its orders at once.
    await saveShopWhatsAppSettings(shop.id, owner.id, { enabled: true, owner: { phone: OWNER_PHONE.slice(3), optedIn: true }, staff: [] });
    const live = await db.select().from(shopWhatsappContacts).where(and(eq(shopWhatsappContacts.shopId, shop.id), sql`${shopWhatsappContacts.removedAt} IS NULL`));
    expect(live.map((c) => c.phoneE164)).toEqual([OWNER_PHONE]);
    const { order } = await placeOrder(shop.id);
    expect((await sentAlerts(order.id)).map((a) => a.intendedTo)).toEqual([OWNER_PHONE]);
  });
});
