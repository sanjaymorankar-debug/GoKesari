/**
 * Customer WhatsApp (docs/customer-whatsapp-2026-11/README.md) — the logic with
 * no database: consent gating, the template map, the chat state machine
 * (search → pick → quantity → cart → checkout link), checkout-link signing and
 * expiry, the rate-limit window and the Meta interactive payload.
 */
import { describe, expect, it } from "vitest";

import { getEnv } from "@/lib/env";
import { RULES } from "@/server/config/rules";
import type { WhatsAppPickOption } from "@/server/db/schema";
import { NOTIFICATION_TYPES as N } from "@/server/notifications/types";
import { interactivePayload } from "@/server/notifications/providers/whatsapp-meta";
import { signCartToken, verifyCartToken } from "@/server/whatsapp/customer/cart-link";
import {
  CUSTOMER_UPDATE_TYPES,
  customerUpdateFor,
  customerWhatsAppMode,
  isStaffSideLink,
  NOTIFICATION_TO_UPDATE,
  templateFor,
} from "@/server/whatsapp/customer/config";
import { customerSendBlock, parseConsentKeyword, type SendCheck } from "@/server/whatsapp/customer/consent";
import {
  addToChatCart,
  converse,
  HELP_TEXT,
  inboundTextFromReplyId,
  searchQueryOf,
  type ConversationDeps,
  type SessionSnapshot,
} from "@/server/whatsapp/customer/conversation";
import { customerTemplateParams } from "@/server/whatsapp/customer/notify-hook";
import { nextRateWindow } from "@/server/whatsapp/customer/sessions";
import { customerTextOf } from "@/server/whatsapp/shop-orders/webhook";

/* ------------------------------------------------------------- consent */

const OK: SendCheck = {
  flagOn: true,
  ruleEnabled: true,
  template: "gk_cust_delivered",
  providerReady: true,
  staffCopy: false,
  verifiedPhone: "+919876500010",
  consented: true,
  channelPreference: undefined,
};

describe("consent gating", () => {
  it("sends only when every switch allows it", () => {
    expect(customerSendBlock(OK)).toBeNull();
    expect(customerSendBlock({ ...OK, channelPreference: true })).toBeNull();
  });

  it("names the first thing that blocks a send", () => {
    expect(customerSendBlock({ ...OK, flagOn: false })).toBe("FLAG_OFF");
    expect(customerSendBlock({ ...OK, ruleEnabled: false })).toBe("RULE_OFF");
    expect(customerSendBlock({ ...OK, template: null })).toBe("NO_TEMPLATE");
    expect(customerSendBlock({ ...OK, providerReady: false })).toBe("NO_PROVIDER");
    expect(customerSendBlock({ ...OK, staffCopy: true })).toBe("STAFF_COPY");
    expect(customerSendBlock({ ...OK, verifiedPhone: null })).toBe("NO_VERIFIED_PHONE");
    expect(customerSendBlock({ ...OK, consented: false })).toBe("NO_CONSENT");
    expect(customerSendBlock({ ...OK, channelPreference: false })).toBe("CHANNEL_SWITCHED_OFF");
    // The flag wins over everything else.
    expect(customerSendBlock({ ...OK, flagOn: false, consented: false })).toBe("FLAG_OFF");
  });

  it("reads STOP / START in English, Hindi and Marathi, and nothing else", () => {
    expect(parseConsentKeyword("STOP")).toBe("STOP");
    expect(parseConsentKeyword(" stop! ")).toBe("STOP");
    expect(parseConsentKeyword("Unsubscribe")).toBe("STOP");
    expect(parseConsentKeyword("बंद")).toBe("STOP");
    expect(parseConsentKeyword("START")).toBe("START");
    expect(parseConsentKeyword("सुरू")).toBe("START");
    expect(parseConsentKeyword("stop milk")).toBeNull();
    expect(parseConsentKeyword("milk")).toBeNull();
  });
});

/* -------------------------------------------------------- template map */

describe("template mapping per event", () => {
  const rule = RULES.whatsappCustomer.defaults;

  it("ships OFF, with a template for every update type", () => {
    expect(rule.enabled).toBe(false);
    for (const update of CUSTOMER_UPDATE_TYPES) expect(templateFor(rule, update)).toMatch(/^gk_cust_/);
    expect(RULES.whatsappCustomer.schema.safeParse(rule).success).toBe(true);
  });

  it("maps each customer notification to its update", () => {
    expect(customerUpdateFor(N.ORDER_CONFIRMED)).toBe("ORDER_PLACED");
    expect(customerUpdateFor(N.ORDER_QUEUED_SHOP_CLOSED)).toBe("ORDER_PLACED");
    expect(customerUpdateFor(N.ORDER_ACCEPTED)).toBe("ORDER_CONFIRMED");
    expect(customerUpdateFor(N.ORDER_PAYMENT_CAPTURED)).toBe("PAYMENT_RECEIVED");
    expect(customerUpdateFor(N.ORDER_READY)).toBe("ORDER_STATUS");
    expect(customerUpdateFor(N.ORDER_PICKED_UP)).toBe("ORDER_STATUS");
    expect(customerUpdateFor(N.ORDER_OUT_FOR_DELIVERY)).toBe("OUT_FOR_DELIVERY");
    expect(customerUpdateFor(N.ORDER_DELIVERED)).toBe("DELIVERED");
    expect(customerUpdateFor(N.ORDER_CANCELLED)).toBe("CANCELLED");
    expect(customerUpdateFor(N.ORDER_PAYMENT_REFUNDED)).toBe("REFUND_ISSUED");
    expect(customerUpdateFor(N.ORDER_REFUND_UPDATED)).toBe("REFUND_ISSUED");
    expect(customerUpdateFor(N.SUBSCRIPTION_RENEWAL_DUE)).toBe("SUBSCRIPTION_RENEWAL");
  });

  it("covers every update type and leaves everything else out", () => {
    expect(new Set(Object.values(NOTIFICATION_TO_UPDATE))).toEqual(new Set(CUSTOMER_UPDATE_TYPES));
    expect(customerUpdateFor(N.SHOP_ORDER_DELIVERED)).toBeNull();
    expect(customerUpdateFor("toString")).toBeNull();
    expect(customerUpdateFor("unknown.type")).toBeNull();
  });

  it("an empty template switches that one update off", () => {
    expect(templateFor({ templates: { ...rule.templates, DELIVERED: "  " } }, "DELIVERED")).toBeNull();
    expect(templateFor({ templates: { ...rule.templates, DELIVERED: " my_tpl " } }, "DELIVERED")).toBe("my_tpl");
  });

  it("never sends the shop's or rider's copy of a shared notification", () => {
    expect(isStaffSideLink("/shop/orders")).toBe(true);
    expect(isStaffSideLink("/delivery-partner")).toBe(true);
    expect(isStaffSideLink("/admin")).toBe(true);
    expect(isStaffSideLink("/orders")).toBe(false);
    expect(isStaffSideLink("/orders/abc")).toBe(false);
    expect(isStaffSideLink("/shops/abc")).toBe(false);
    expect(isStaffSideLink(null)).toBe(false);
  });

  it("builds the three template parameters with an absolute link", () => {
    const [title, body, link] = customerTemplateParams("Order delivered", "Your order GK-1 was delivered.", "/orders/1");
    expect(title).toBe("Order delivered");
    expect(body).toBe("Your order GK-1 was delivered.");
    expect(link).toMatch(/^https?:\/\/.+\/orders\/1$/);
  });

  it("chooses the provider mode: meta needs keys, mock is refused on production", () => {
    const env = getEnv();
    expect(customerWhatsAppMode({ ...env, WHATSAPP_PROVIDER: "none" }).mode).toBeNull();
    expect(customerWhatsAppMode({ ...env, WHATSAPP_PROVIDER: "mock", AUTH_URL: "https://test.gokesari.com" }).mode).toBe("mock");
    expect(customerWhatsAppMode({ ...env, WHATSAPP_PROVIDER: "mock", AUTH_URL: "https://gokesari.com", KYC_PRODUCTION_HOST: "gokesari.com" }).mode).toBeNull();
    expect(customerWhatsAppMode({ ...env, WHATSAPP_PROVIDER: "meta", META_WA_ACCESS_TOKEN: undefined }).problem).toMatch(/Missing/);
  });
});

/* ------------------------------------------------------ state machine */

const MILK: WhatsAppPickOption = { shopProductId: "sp-milk", name: "Amul Milk 500 ml", shopName: "Kesari Dairy", unitPricePaise: 3000, availability: "In stock", buyable: true };
const CURD: WhatsAppPickOption = { shopProductId: "sp-curd", name: "Curd 400 g", shopName: "Kesari Dairy", unitPricePaise: 4500, availability: "Out of stock", buyable: false };

function deps(overrides: Partial<ConversationDeps> = {}) {
  const calls = { searches: [] as [string, string][], links: [] as unknown[] };
  const d: ConversationDeps = {
    search: async (query, pin) => {
      calls.searches.push([query, pin]);
      return query === "nothing" ? [] : [MILK, CURD];
    },
    checkoutLink: async (cart) => {
      calls.links.push(cart);
      return { url: "https://test.gokesari.com/wa/cart?t=signed", expiresInMinutes: 30 };
    },
    maxResults: 5,
    maxQuantity: 20,
    ...overrides,
  };
  return { d, calls };
}

const fresh = (pincode: string | null = null): SessionSnapshot => ({ state: "IDLE", context: {}, cart: [], pincode });

describe("chat state machine", () => {
  it("search → pick → quantity → cart → checkout link", async () => {
    const { d, calls } = deps();
    let s = fresh("411001");

    let r = await converse(s, "search milk", d);
    expect(calls.searches).toEqual([["milk", "411001"]]);
    expect(r.session.state).toBe("PICK");
    expect(r.replies[0].text).toContain("1. Amul Milk 500 ml — ₹30.00 — In stock — Kesari Dairy");
    expect(r.replies[0].list?.rows[0].id).toBe("wa:pick:1");
    s = r.session;

    r = await converse(s, "1", d);
    expect(r.session.state).toBe("QTY");
    expect(r.replies[0].buttons?.map((b) => b.id)).toEqual(["wa:qty:1", "wa:qty:2", "wa:qty:3"]);
    s = r.session;

    r = await converse(s, "3", d);
    expect(r.session.state).toBe("IDLE");
    expect(r.session.cart).toEqual([{ shopProductId: "sp-milk", name: "Amul Milk 500 ml", shopName: "Kesari Dairy", unitPricePaise: 3000, quantity: 3 }]);
    expect(r.replies[0].text).toContain("Added 3 × Amul Milk 500 ml");
    s = r.session;

    r = await converse(s, "cart", d);
    expect(r.replies[0].text).toContain("Total ₹90.00");
    expect(r.session).toEqual(s);

    r = await converse(s, "checkout", d);
    expect(calls.links).toHaveLength(1);
    expect(r.replies[0].text).toContain("https://test.gokesari.com/wa/cart?t=signed");
    expect(r.replies[0].text).toContain("30 minutes");
    // The cart moved to the link: a second checkout cannot double it.
    expect(r.session.cart).toEqual([]);
    expect((await converse(r.session, "checkout", d)).replies[0].text).toContain("empty");
  });

  it("asks for the PIN code when none is known, then runs the waiting search", async () => {
    const { d, calls } = deps();
    let r = await converse(fresh(null), "milk", d);
    expect(r.session.state).toBe("AWAIT_PIN");
    expect(r.session.context.pendingQuery).toBe("milk");
    expect(calls.searches).toHaveLength(0);

    r = await converse(r.session, "4110", d);
    expect(r.session.state).toBe("AWAIT_PIN");
    expect(r.replies[0].text).toContain("6 digits");

    r = await converse(r.session, "411038", d);
    expect(r.session.pincode).toBe("411038");
    expect(r.session.state).toBe("PICK");
    expect(calls.searches).toEqual([["milk", "411038"]]);
  });

  it("refuses an out-of-stock pick and a number that is not on the list", async () => {
    const { d } = deps();
    const picking = (await converse(fresh("411001"), "milk", d)).session;
    let r = await converse(picking, "2", d);
    expect(r.session.state).toBe("PICK");
    expect(r.replies[0].text).toContain("out of stock");
    r = await converse(picking, "9", d);
    expect(r.session.state).toBe("PICK");
    expect(r.replies[0].text).toContain("from 1 to 2");
  });

  it("keeps quantities within 1..max and merges the same product", async () => {
    const { d } = deps({ maxQuantity: 5 });
    const asking = (await converse((await converse(fresh("411001"), "milk", d)).session, "1", d)).session;
    expect((await converse(asking, "0", d)).session.state).toBe("QTY");
    expect((await converse(asking, "6", d)).replies[0].text).toContain("1 to 5");
    expect(addToChatCart([{ ...MILK, quantity: 4 }], MILK, 3, 5)[0].quantity).toBe(5);
    expect(addToChatCart([], MILK, 2, 5)).toHaveLength(1);
  });

  it("other text while picking starts a new search; no results say so", async () => {
    const { d, calls } = deps();
    const picking = (await converse(fresh("411001"), "milk", d)).session;
    let r = await converse(picking, "atta", d);
    expect(calls.searches.at(-1)).toEqual(["atta", "411001"]);
    expect(r.session.state).toBe("PICK");
    r = await converse(fresh("411001"), "nothing", d);
    expect(r.session.state).toBe("IDLE");
    expect(r.replies[0].text).toContain("No shop near 411001");
  });

  it("help, PIN change and clear", async () => {
    const { d } = deps();
    expect((await converse(fresh(), "hi", d)).replies[0].text).toBe(HELP_TEXT);
    const r = await converse(fresh("411001"), "pin 411038", d);
    expect(r.session.pincode).toBe("411038");
    const withCart = { ...fresh("411001"), cart: [{ ...MILK, quantity: 1 }] };
    expect((await converse(withCart, "clear", d)).session.cart).toEqual([]);
  });

  it("turns list rows / buttons and typed text into the chat's input", () => {
    expect(inboundTextFromReplyId("wa:pick:2")).toBe("2");
    expect(inboundTextFromReplyId("wa:qty:3")).toBe("3");
    expect(inboundTextFromReplyId("GK1:A:123")).toBeNull();
    expect(customerTextOf({ text: { body: " milk " } })).toBe("milk");
    expect(customerTextOf({ interactive: { list_reply: { id: "wa:pick:4", title: "4. Bread" } } })).toBe("4");
    expect(customerTextOf({ interactive: { button_reply: { id: "wa:qty:2", title: "2" } } })).toBe("2");
    expect(customerTextOf({})).toBeNull();
    expect(searchQueryOf('search: "Amul  milk"')).toBe("Amul milk");
  });
});

/* -------------------------------------------------------- link signing */

describe("checkout link signing and expiry", () => {
  const id = "3f2b8c1e-1d2a-4c55-9a77-0a1b2c3d4e5f";
  const secret = "unit-test-secret";
  const now = new Date("2026-11-23T10:00:00Z");
  const expires = new Date("2026-11-23T10:30:00Z");

  it("accepts its own token until it expires", () => {
    const token = signCartToken(id, expires, secret);
    expect(verifyCartToken(token, now, secret)).toEqual({ ok: true, id, expiresAt: expires });
    expect(verifyCartToken(token, new Date("2026-11-23T10:30:00Z"), secret)).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("refuses an edited id or expiry, another secret and junk", () => {
    const token = signCartToken(id, expires, secret);
    const [, exp, sig] = token.split(".");
    const otherId = "00000000-1d2a-4c55-9a77-0a1b2c3d4e5f";
    expect(verifyCartToken(`${otherId}.${exp}.${sig}`, now, secret)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyCartToken(`${id}.${Number(exp) + 3600}.${sig}`, now, secret)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyCartToken(token, now, "another-secret")).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyCartToken("nonsense", now, secret)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(verifyCartToken(null, now, secret)).toEqual({ ok: false, reason: "MALFORMED" });
  });
});

/* ---------------------------------------------------------- rate limit */

describe("rate limit per phone", () => {
  const start = new Date("2026-11-23T10:00:00Z");

  it("allows the limit per minute, tells once, then resets", () => {
    let w = { windowStartedAt: start, windowCount: 0 };
    const seen: { allowed: boolean; notify: boolean }[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = nextRateWindow(w, new Date(start.getTime() + i * 1000), 2);
      seen.push({ allowed: next.allowed, notify: next.notify });
      w = next;
    }
    expect(seen).toEqual([
      { allowed: true, notify: false },
      { allowed: true, notify: false },
      { allowed: false, notify: true },
      { allowed: false, notify: false },
    ]);
    const later = nextRateWindow(w, new Date(start.getTime() + 61_000), 2);
    expect(later).toMatchObject({ allowed: true, windowCount: 1 });
  });
});

/* ------------------------------------------------- interactive payload */

describe("Meta interactive payload", () => {
  it("builds a list within Meta's limits, else reply buttons", () => {
    const list = interactivePayload({
      body: "Pick one",
      list: { button: "Choose a product please now", rows: [{ id: "wa:pick:1", title: "1. A very long product name indeed", description: "x".repeat(100) }] },
    }) as { type: string; action: { button: string; sections: { rows: { title: string; description: string }[] }[] } };
    expect(list.type).toBe("list");
    expect(list.action.button.length).toBeLessThanOrEqual(20);
    expect(list.action.sections[0].rows[0].title.length).toBeLessThanOrEqual(24);
    expect(list.action.sections[0].rows[0].description.length).toBeLessThanOrEqual(72);
    const buttons = interactivePayload({ body: "How many?", buttons: [1, 2, 3, 4].map((n) => ({ id: `wa:qty:${n}`, title: String(n) })) }) as {
      type: string;
      action: { buttons: unknown[] };
    };
    expect(buttons.type).toBe("button");
    expect(buttons.action.buttons).toHaveLength(3);
  });
});
