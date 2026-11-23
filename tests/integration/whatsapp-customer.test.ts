/**
 * Customer WhatsApp (docs/customer-whatsapp-2026-11/README.md) against a real
 * database, in mock mode (WHATSAPP_PROVIDER=mock: every message lands in
 * outbound_test_messages, as on the test site). Covers flag OFF, consent gating
 * (profile and STOP / START), the order update through the shared outbox, the
 * chat from search to a used checkout link, webhook idempotency and the admin retry.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-meta-app-secret";
vi.hoisted(() => {
  const env = process.env as Record<string, string | undefined>;
  env.WHATSAPP_PROVIDER = "mock";
  // The webhook checks Meta's signature even in mock mode.
  env.META_WA_APP_SECRET = "test-meta-app-secret";
});

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async () => {},
  EmailUnavailableError: class extends Error {},
}));

import { POST as webhookPost } from "@/app/api/webhooks/whatsapp/route";
import { RULES } from "@/server/config/rules";
import { db } from "@/server/db";
import {
  auditLogs,
  cartItems,
  carts,
  featureFlags,
  notifications,
  outboundTestMessages,
  platformSettings,
  userConsents,
  users,
  whatsappMessages,
} from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { checkout } from "@/server/services/orders";
import { clearRuleCache } from "@/server/services/settings";
import { retryWhatsAppMessage, simulateCustomerInbound } from "@/server/whatsapp/customer/admin";
import { claimCartLink, loadCartLink } from "@/server/whatsapp/customer/cart-link";
import { hasWhatsAppConsent, setWhatsAppConsent } from "@/server/whatsapp/customer/consent";
import { handleCustomerInbound } from "@/server/whatsapp/customer/sessions";
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

async function setFlag(enabled: boolean) {
  await db.insert(featureFlags).values({ key: "whatsapp_customer_enabled", enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

async function setRuleEnabled(enabled: boolean) {
  const value = { ...RULES.whatsappCustomer.defaults, enabled };
  await db.insert(platformSettings).values({ key: "whatsappCustomer", value }).onConflictDoUpdate({ target: platformSettings.key, set: { value } });
  clearRuleCache();
}

beforeAll(() => setWhatsAppAutoDispatch(false));

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`DELETE FROM whatsapp_webhook_events`);
  await db.execute(sql`DELETE FROM whatsapp_messages`);
  await db.execute(sql`DELETE FROM whatsapp_customer_sessions`);
  await db.execute(sql`DELETE FROM whatsapp_cart_links`);
  await db.execute(sql`DELETE FROM outbound_test_messages`);
  await db.insert(featureFlags).values({ key: "whatsapp_shop_orders_enabled", enabled: false }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: false } });
  await setFlag(true);
  await setRuleEnabled(true);
});

/** A customer with a verified mobile and money in the wallet. */
async function customer() {
  const { user } = await createUserWithWallet({ balancePaise: 500_000 });
  const [verified] = await db.update(users).set({ phoneVerifiedAt: new Date() }).where(eq(users.id, user.id)).returning();
  return verified;
}

async function shopWithMilk() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: "Kesari Dairy" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const sp = await createShopProduct(shop.id, product.id, { onlinePricePaise: 5200, onlineStock: 50 });
  return { shop, sp };
}

async function placeOrder(userId: string, shopProductId: string) {
  await addToCart(userId, shopProductId, 1);
  const { orders } = await checkout({ userId, requestId: `req-${userId}-${Date.now()}`, addressId: await deliveryAddressId(userId), paymentMethod: "WALLET" });
  return orders[0];
}

const customerRows = (userId: string) =>
  db.select().from(whatsappMessages).where(and(eq(whatsappMessages.userId, userId), eq(whatsappMessages.kind, "CUSTOMER_NOTIFICATION")));

const mockOutbox = (phone: string) =>
  db.select().from(outboundTestMessages).where(eq(outboundTestMessages.toAddress, phone)).orderBy(desc(outboundTestMessages.createdAt));

let webhookCounter = 0;
async function textWebhook(from: string, body: string, id = `wamid.CUST${(webhookCounter += 1)}`) {
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [{ from: from.slice(1), id, timestamp: "1", type: "text", text: { body } }] } }] }],
  });
  const response = await webhookPost(
    new NextRequest("http://localhost/api/webhooks/whatsapp", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-hub-signature-256": whatsappSignature(raw, SECRET) } }),
  );
  return { status: response.status, body: (await response.json()) as { results?: string[]; ignored?: string } };
}

describe("flag OFF", () => {
  it("queues nothing, keeps the normal notification, and the webhook ignores customer text", async () => {
    await setFlag(false);
    const user = await customer();
    await setWhatsAppConsent(user.id, true, { source: "PROFILE" });
    const { sp } = await shopWithMilk();
    await placeOrder(user.id, sp.id);
    expect(await customerRows(user.id)).toHaveLength(0);
    expect((await db.select().from(notifications).where(eq(notifications.userId, user.id))).length).toBeGreaterThan(0);
    const result = await textWebhook(user.phoneE164!, "milk");
    expect(result.body.ignored).toBeTruthy();
    expect(await mockOutbox(user.phoneE164!)).toHaveLength(0);
  });
});

describe("customer updates", () => {
  it("are sent only with consent, through the shared outbox, as the rule's template", async () => {
    const user = await customer();
    const { sp } = await shopWithMilk();

    await placeOrder(user.id, sp.id);
    expect(await customerRows(user.id)).toHaveLength(0); // no consent yet

    await setWhatsAppConsent(user.id, true, { source: "PROFILE" });
    const [consent] = await db.select().from(userConsents).where(eq(userConsents.userId, user.id));
    expect(consent).toMatchObject({ consentType: "WHATSAPP_NOTIFICATIONS", granted: true, source: "PROFILE" });

    const order = await placeOrder(user.id, sp.id);
    const queued = await customerRows(user.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "QUEUED", template: "gk_cust_order_placed", intendedTo: user.phoneE164 });
    expect(String(queued[0].params?.text)).toContain(order.orderNumber);

    expect(await dispatchWhatsAppQueue()).toMatchObject({ sent: 1, failed: 0 });
    const [sent] = await customerRows(user.id);
    expect(sent.status).toBe("SENT");
    expect(sent.metaMessageId).toMatch(/^mock:/);
    const [outbox] = await mockOutbox(user.phoneE164!);
    expect(outbox.body).toContain("[template gk_cust_order_placed]");
    expect(outbox.body).toContain(order.orderNumber);
  });

  it("are not sent while the rule is off, and a STOP after queueing wins at send time", async () => {
    const user = await customer();
    await setWhatsAppConsent(user.id, true, { source: "PROFILE" });
    const { sp } = await shopWithMilk();

    await setRuleEnabled(false);
    await placeOrder(user.id, sp.id);
    expect(await customerRows(user.id)).toHaveLength(0);

    await setRuleEnabled(true);
    await placeOrder(user.id, sp.id);
    expect(await customerRows(user.id)).toHaveLength(1);

    expect(await handleCustomerInbound({ from: user.phoneE164!, text: "STOP", inboundId: "in-stop" })).toContain("STOP");
    expect(await hasWhatsAppConsent(user.id)).toBe(false);
    const [withdrawal] = await db.select().from(userConsents).where(eq(userConsents.userId, user.id)).orderBy(desc(userConsents.createdAt)).limit(1);
    expect(withdrawal).toMatchObject({ granted: false, source: "WHATSAPP_KEYWORD" });

    expect(await dispatchWhatsAppQueue()).toMatchObject({ sent: 0, skipped: 1 });
    expect((await customerRows(user.id))[0].status).toBe("SKIPPED");

    // Nothing more is answered until START.
    expect(await handleCustomerInbound({ from: user.phoneE164!, text: "milk", inboundId: "in-x" })).toBe("ignored: opted out");
    expect(await handleCustomerInbound({ from: user.phoneE164!, text: "START", inboundId: "in-start" })).toContain("START");
    expect(await hasWhatsAppConsent(user.id)).toBe(true);
  });
});

describe("shopping by chat", () => {
  it("search → PIN → pick → quantity → checkout link → the customer's cart, once", async () => {
    const { sp } = await shopWithMilk();
    const user = await customer();
    const from = user.phoneE164!;
    const say = (text: string) => handleCustomerInbound({ from, text, inboundId: `in-${text}` });

    await db.execute(sql`DELETE FROM addresses WHERE user_id = ${user.id}`);
    expect(await say("milk")).toBe("chat: IDLE → AWAIT_PIN");
    expect(await say("411001")).toBe("chat: AWAIT_PIN → PICK");
    const [results] = await mockOutbox(from);
    expect(results.body).toContain("1. Cow Milk — ₹52.00 — In stock — Kesari Dairy");
    expect(await say("1")).toBe("chat: PICK → QTY");
    expect(await say("2")).toBe("chat: QTY → IDLE");
    expect(await say("checkout")).toBe("chat: IDLE → IDLE");
    const [linkMessage] = await mockOutbox(from);
    const token = /\/wa\/cart\?t=([^\s]+)/.exec(linkMessage.body)?.[1];
    expect(token).toBeTruthy();
    const decoded = decodeURIComponent(token!);

    // Another account cannot use a link made from this customer's number.
    const stranger = await customer();
    await expect(claimCartLink(decoded, stranger)).rejects.toThrow(/another GoKesari account/);

    expect(await claimCartLink(decoded, user)).toEqual({ added: [{ name: "Cow Milk", quantity: 2 }], skipped: [] });
    const [cart] = await db.select().from(carts).where(eq(carts.userId, user.id));
    const lines = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
    expect(lines).toMatchObject([{ shopProductId: sp.id, quantity: 2 }]);

    expect((await loadCartLink(decoded)).problem).toBe("USED");
    await expect(claimCartLink(decoded, user)).rejects.toThrow(/already used/);
    // Every reply is in the WhatsApp log as CUSTOMER_REPLY.
    const replies = await db.select().from(whatsappMessages).where(eq(whatsappMessages.kind, "CUSTOMER_REPLY"));
    expect(replies.length).toBe(5);
    expect(replies.every((r) => r.status === "SENT")).toBe(true);
  });

  it("handles a webhook message once (Meta retries change nothing)", async () => {
    await shopWithMilk();
    const from = "+919812300001";
    const first = await textWebhook(from, "pin 411001", "wamid.SAME");
    expect(first.status).toBe(200);
    expect(first.body.results).toEqual(["chat: IDLE → IDLE"]);
    const again = await textWebhook(from, "pin 411001", "wamid.SAME");
    expect(again.body.results).toEqual(["message duplicate"]);
    expect(await mockOutbox(from)).toHaveLength(1);
  });

  it("answers once over the rate limit, then stays quiet", async () => {
    const value = { ...RULES.whatsappCustomer.defaults, enabled: true, rateLimitPerMinute: 2 };
    await db.update(platformSettings).set({ value }).where(eq(platformSettings.key, "whatsappCustomer"));
    clearRuleCache();
    const from = "+919812300002";
    for (let i = 0; i < 4; i += 1) await handleCustomerInbound({ from, text: "hi", inboundId: `rl-${i}` });
    const outbox = await mockOutbox(from);
    expect(outbox).toHaveLength(3);
    expect(outbox[0].body).toContain("very fast");
  });
});

describe("admin", () => {
  it("retries a failed template message (audited); operators may, customers may not; replies cannot", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const user = await customer();
    const [failed] = await db
      .insert(whatsappMessages)
      .values({ userId: user.id, kind: "CUSTOMER_NOTIFICATION", template: "gk_cust_delivered", intendedTo: user.phoneE164!, status: "FAILED", attempts: 3, error: "boom" })
      .returning();
    const [reply] = await db.insert(whatsappMessages).values({ kind: "CUSTOMER_REPLY", intendedTo: user.phoneE164!, status: "FAILED" }).returning();

    await expect(retryWhatsAppMessage(failed.id, { id: user.id, role: "CUSTOMER" })).rejects.toThrow();
    await expect(retryWhatsAppMessage(reply.id, { id: admin.id, role: "ADMIN" })).rejects.toThrow(/Only a failed template/);

    await retryWhatsAppMessage(failed.id, { id: admin.id, role: "ADMIN" });
    const [row] = await db.select().from(whatsappMessages).where(eq(whatsappMessages.id, failed.id));
    expect(row).toMatchObject({ status: "QUEUED", attempts: 0, error: null });
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "whatsapp_message.retried"));
    expect(audits).toHaveLength(1);
    await expect(retryWhatsAppMessage(failed.id, { id: admin.id, role: "ADMIN" })).rejects.toThrow(); // no longer FAILED
  });

  it("simulates an inbound message on the test site (admin only)", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await shopWithMilk();
    await expect(simulateCustomerInbound({ from: "+919812300003", text: "hi" }, { id: admin.id, role: "CUSTOMER" })).rejects.toThrow();
    expect(await simulateCustomerInbound({ from: "+91 98123 00003", text: "pin 411001" }, { id: admin.id, role: "ADMIN" })).toBe("chat: IDLE → IDLE");
    expect(await mockOutbox("+919812300003")).toHaveLength(1);
  });
});
