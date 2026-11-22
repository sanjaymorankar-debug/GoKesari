/**
 * WhatsApp on the test site (docs/smart-shopping-2026-11/FEATURE3_WHATSAPP_ORDERS.md):
 * with WHATSAPP_TEST_RECIPIENT set, every message goes to +919175193009 and the
 * log keeps the number it was meant for; a button tap from the test phone acts
 * as the number whose message was tapped. gokesari.com refuses to send while a
 * test recipient is set, and missing keys keep the feature dormant.
 */
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const env = process.env as Record<string, string | undefined>;
  env.WHATSAPP_PROVIDER = "meta";
  env.META_WA_ACCESS_TOKEN = "test-meta-token";
  env.META_WA_PHONE_NUMBER_ID = "123456789012345";
  env.META_WA_APP_SECRET = "test-meta-app-secret";
  env.META_WA_VERIFY_TOKEN = "test-verify-token";
  env.WHATSAPP_TEST_RECIPIENT = "+91 91751 93009";
});

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async () => {},
  EmailUnavailableError: class extends Error {},
}));

import { POST as webhookPost } from "@/app/api/webhooks/whatsapp/route";
import { getEnv, whatsappMetaConfigProblem, type ServerEnv } from "@/lib/env";
import { db } from "@/server/db";
import { featureFlags, orders, shops, whatsappMessages, whatsappOrderActions } from "@/server/db/schema";
import { textChannelMode } from "@/server/messaging/sms-whatsapp";
import { whatsappRecipientFor, whatsappTestRecipient } from "@/server/notifications/providers/whatsapp-meta";
import { addToCart } from "@/server/services/cart";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { checkout } from "@/server/services/orders";
import { saveShopWhatsAppSettings } from "@/server/whatsapp/shop-orders/contacts";
import { dispatchWhatsAppQueue } from "@/server/whatsapp/shop-orders/dispatch";
import { setWhatsAppAutoDispatch } from "@/server/whatsapp/shop-orders/queue";
import { whatsappSignature } from "@/server/whatsapp/shop-orders/webhook";
import { createCategory, createProduct, createShop, createShopProduct, createUser, createUserWithWallet, deliveryAddressId, resetDatabase } from "../helpers/fixtures";

const TEST_PHONE = "+919175193009";
const sentTo: string[] = [];
let counter = 0;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  if (!String(input).startsWith("https://graph.facebook.com/")) throw new Error(`Unexpected fetch: ${String(input)}`);
  sentTo.push(`+${(JSON.parse(String(init?.body)) as { to: string }).to}`);
  counter += 1;
  return new Response(JSON.stringify({ messages: [{ id: `wamid.R${counter}` }] }), { status: 200 });
});

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
  setWhatsAppAutoDispatch(false);
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`DELETE FROM whatsapp_webhook_events`);
  await db.execute(sql`DELETE FROM whatsapp_messages`);
  await db.insert(featureFlags).values({ key: "whatsapp_shop_orders_enabled", enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
  clearFeatureFlagCache();
  sentTo.length = 0;
});

async function signed(value: Record<string, unknown>) {
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value }] }] });
  const response = await webhookPost(
    new NextRequest("http://localhost/api/webhooks/whatsapp", { method: "POST", body: raw, headers: { "x-hub-signature-256": whatsappSignature(raw, "test-meta-app-secret") } }),
  );
  return (await response.json()) as { results?: string[] };
}

async function shopWithNumbers() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: "Test Site Dairy" });
  await db.update(shops).set({ ownerName: "Ramesh Patil" }).where(eq(shops.id, shop.id));
  await saveShopWhatsAppSettings(shop.id, owner.id, { enabled: true, owner: { phone: "9876500001", optedIn: true }, staff: [{ phone: "9876500002", label: "Suresh" }] });
  await dispatchWhatsAppQueue();
  for (const check of await db.select().from(whatsappMessages).where(eq(whatsappMessages.kind, "NUMBER_CHECK"))) {
    await signed({ statuses: [{ id: check.metaMessageId, status: "delivered", timestamp: "1700000000", recipient_id: "919175193009" }] });
  }
  return { owner, shop };
}

describe("test site: every WhatsApp message goes to +919175193009", () => {
  it("readdresses number checks and order alerts, logging the intended number", async () => {
    expect(whatsappTestRecipient()).toBe(TEST_PHONE);
    const { shop } = await shopWithNumbers();
    const { user: customer } = await createUserWithWallet({ balancePaise: 100_000 });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
    const sp = await createShopProduct(shop.id, product.id, { onlinePricePaise: 5000, onlineStock: 10 });
    await addToCart(customer.id, sp.id, 1);
    const { orders: placed } = await checkout({ userId: customer.id, requestId: `r-${customer.id}`, addressId: await deliveryAddressId(customer.id) });
    expect((await dispatchWhatsAppQueue()).sent).toBe(2);

    expect(sentTo).toEqual([TEST_PHONE, TEST_PHONE, TEST_PHONE, TEST_PHONE]); // 2 number checks + 2 order alerts
    const logged = await db.select().from(whatsappMessages).where(eq(whatsappMessages.orderId, placed[0].id));
    expect(logged.map((m) => m.intendedTo).sort()).toEqual(["+919876500001", "+919876500002"]);
    expect(logged.every((m) => m.sentTo === TEST_PHONE)).toBe(true);

    // The tester taps Accept on the copy meant for the staff number: it counts as Suresh.
    const staffCopy = logged.find((m) => m.intendedTo === "+919876500002")!;
    const result = await signed({
      messages: [{ from: "919175193009", id: "wamid.TAP1", type: "button", button: { payload: `GK1:A:${placed[0].id}` }, context: { id: staffCopy.metaMessageId } }],
    });
    expect(result.results).toEqual(["accepted"]);
    expect((await db.select().from(orders).where(eq(orders.id, placed[0].id)))[0].status).toBe("ACCEPTED");
    const [action] = await db.select().from(whatsappOrderActions).where(and(eq(whatsappOrderActions.orderId, placed[0].id), eq(whatsappOrderActions.outcome, "DONE")));
    expect(action.contactId).toBe(staffCopy.contactId);
    expect(sentTo.at(-1)).toBe(TEST_PHONE); // the reply too
  });

  it("gokesari.com never readdresses, and refuses to send at all while a test recipient is set", () => {
    const production = { ...getEnv(), NODE_ENV: "production", AUTH_URL: "https://gokesari.com", KYC_PRODUCTION_HOST: "gokesari.com" } as ServerEnv;
    expect(whatsappRecipientFor("+919876500001", production)).toBe("+919876500001");
    expect(whatsappMetaConfigProblem(production)).toMatch(/WHATSAPP_TEST_RECIPIENT is set on the production site/);
    expect(whatsappMetaConfigProblem({ ...production, WHATSAPP_TEST_RECIPIENT: "" })).toBeNull();
    // test.gokesari.com (a production build on another host) does readdress.
    const staging = { ...production, AUTH_URL: "https://test.gokesari.com" } as ServerEnv;
    expect(whatsappMetaConfigProblem(staging)).toBeNull();
    expect(whatsappRecipientFor("+919876500001", staging)).toBe(TEST_PHONE);
  });

  it("missing or malformed keys keep WhatsApp dormant, with the reason; general notifications never use Meta", async () => {
    const env = getEnv();
    expect(whatsappMetaConfigProblem({ ...env, META_WA_ACCESS_TOKEN: undefined })).toBe("Missing META_WA_ACCESS_TOKEN.");
    expect(whatsappMetaConfigProblem({ ...env, META_WA_APP_SECRET: "", META_WA_PHONE_NUMBER_ID: undefined })).toBe("Missing META_WA_PHONE_NUMBER_ID, META_WA_APP_SECRET.");
    expect(whatsappMetaConfigProblem({ ...env, META_WA_PHONE_NUMBER_ID: "+91 98765" })).toMatch(/numeric Phone number ID/);
    expect(whatsappMetaConfigProblem({ ...env, WHATSAPP_PROVIDER: "none" })).toMatch(/not "meta"/);
    expect(textChannelMode("WHATSAPP")).toBe("none");

    // The running server with its token removed: the flag is on, nothing is queued or sent, and the reason is logged.
    const { shop } = await shopWithNumbers();
    sentTo.length = 0;
    const saved = env.META_WA_ACCESS_TOKEN;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (env as { META_WA_ACCESS_TOKEN?: string }).META_WA_ACCESS_TOKEN = undefined;
    try {
      const { user: customer } = await createUserWithWallet({ balancePaise: 100_000 });
      const category = await createCategory({ department: "DAIRY", name: "Milk" });
      const product = await createProduct(category.id, { name: "Curd", unit: "kg" });
      const sp = await createShopProduct(shop.id, product.id, { onlinePricePaise: 5000, onlineStock: 10 });
      await addToCart(customer.id, sp.id, 1);
      const { orders: placed } = await checkout({ userId: customer.id, requestId: `r2-${customer.id}`, addressId: await deliveryAddressId(customer.id) });
      expect(placed[0].status).toBe("CONFIRMED"); // the order itself is unaffected
      expect(await db.select().from(whatsappMessages).where(eq(whatsappMessages.orderId, placed[0].id))).toHaveLength(0);
      expect(await dispatchWhatsAppQueue()).toMatchObject({ sent: 0, dormant: expect.stringContaining("Missing META_WA_ACCESS_TOKEN") });
      expect(sentTo).toHaveLength(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("stays dormant: Missing META_WA_ACCESS_TOKEN"))).toBe(true);
    } finally {
      (env as { META_WA_ACCESS_TOKEN?: string }).META_WA_ACCESS_TOKEN = saved;
      warn.mockRestore();
    }
  });
});
