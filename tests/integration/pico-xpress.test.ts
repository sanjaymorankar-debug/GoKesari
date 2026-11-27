/* eslint-disable @typescript-eslint/no-explicit-any -- the manifest and webhook bodies are free-form JSON in these tests */
/**
 * Pico Xpress (docs/pico-xpress-2026-11) against real PostgreSQL, with Pico itself replaced by an in-process
 * fake (global fetch): AWB pool, serviceability, booking (PREPAID / COD, multi-box, e-way bill, non-GST shop,
 * every PX error, timeout + retry without a duplicate), webhooks (auth, duplicates, out-of-order, both field
 * names, unknown status, statusHistory replay), order sync to DELIVERED, cancel before / after pickup, the
 * shop's plan (no GoKesari rider search) and the masked API log.
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PICO_BASE_URL = "https://dev-api.picoxpress.com";
  process.env.PICO_CLIENT_KEY = "TEST_CLIENT_KEY_123";
  process.env.PICO_API_KEY = "TEST_API_SECRET_456";
  process.env.PICO_WEBHOOK_TOKEN = "test-webhook-token-789";
});
vi.setConfig({ testTimeout: 120_000, hookTimeout: 90_000 });

import { db } from "@/server/db";
import { deliveryBookings, deliveryEvents, deliveryProviders } from "@/server/db/hdms-schema";
import { deliveryAwbPool, deliveryLocationPings, deliveryPartnerApiLogs, deliveryShipmentEvents, deliveryShipments } from "@/server/db/pico-schema";
import { deliveryOrders, featureFlags, orderFulfilmentArrangements, orderItems, orders, platformSettings, riderSearches, shops } from "@/server/db/schema";
import { allocateAwbs, refillPool } from "@/server/delivery/pico/awb-pool";
import { shipmentCodes } from "@/server/delivery/pico/codes";
import { bookPicoShipment, cancelPicoShipment, picoOptionForOrder, refreshPicoShipment, sweepSilentShipments } from "@/server/delivery/pico/service";
import { buyerPicoViews, shopPicoViews } from "@/server/delivery/pico/views";
import { handleLocationWebhook, handleShipmentStatusWebhook } from "@/server/delivery/pico/webhooks";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { cancelOrder } from "@/server/services/orders";
import { planFulfilment } from "@/server/services/fulfilment-options";
import { clearRuleCache } from "@/server/services/settings";
import { availableSlotDays } from "@/lib/fulfilment-options";
import { createCategory, createOrder, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

const SHOP_AT = { lat: 12.9352, lng: 77.6245 }; // Koramangala, Bangalore (Pico staging pincode 560064 area)
const DROP_AT = { lat: 12.9634, lng: 77.5855 }; // 560002
const TOKEN = "test-webhook-token-789";

/* --------------------------------------------------------------- fake Pico */

type Behaviour = { code: string; message: string; http?: number } | "timeout" | "http500" | null;
interface FakePico {
  nextAwb: number;
  created: Map<string, Record<string, any>>;
  cancelled: string[];
  serviceable: boolean;
  createBehaviour: Behaviour[];
  cancelBehaviour: Behaviour;
  track: Record<string, unknown> | null;
  calls: { path: string; method: string; auth: string | null; clientKey: string | null; body: any }[];
}
let pico: FakePico;

function answer(response: unknown, code = "PX_200", message = "SUCCESS", http = 200) {
  return new Response(JSON.stringify({ response, responseCode: code, responseMessage: message }), { status: http, headers: { "content-type": "application/json" } });
}

function installFakePico() {
  pico = { nextAwb: 100100000467, created: new Map(), cancelled: [], serviceable: true, createBehaviour: [], cancelBehaviour: null, track: null, calls: [] };
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== "dev-api.picoxpress.com") throw new Error(`unexpected host ${url.host}`);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const auth = new Headers(init?.headers).get("authorization");
    pico.calls.push({ path: url.pathname, method: init?.method ?? "GET", auth, clientKey: url.searchParams.get("clientKey"), body });
    if (auth !== "TEST_API_SECRET_456" || url.searchParams.get("clientKey") !== "TEST_CLIENT_KEY_123") return answer(null, "PX_401", "Client not authorized.");
    switch (url.pathname) {
      case "/integ/awb/fetch/bulk/v1": {
        const n = Number(url.searchParams.get("awbCount"));
        if (n > 1000) return answer(null, "PX_403", "too many");
        return answer({ awbList: Array.from({ length: n }, () => String(pico.nextAwb++)) });
      }
      case "/integ/order/serviceability/qc":
        return answer({ orderId: body.orderId, serviceable: pico.serviceable, message: null });
      case "/integ/order/create/qc": {
        const b = pico.createBehaviour.shift() ?? null;
        if (b === "timeout") {
          // Pico did create it, but the answer never arrives.
          pico.created.set(body.orderId, body);
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        if (b === "http500") return new Response("gateway down", { status: 502 });
        if (b) return answer(null, b.code, b.message, b.http ?? 200);
        if (pico.created.has(body.orderId)) return answer(null, "PX_403", `Order already exists for orderId ${body.orderId}`);
        pico.created.set(body.orderId, body);
        return answer({ awbNumber: body.awbNumber, message: "Successfully placed order" });
      }
      case "/integ/awb/cancel/v1": {
        if (pico.cancelBehaviour) return answer(null, (pico.cancelBehaviour as any).code, (pico.cancelBehaviour as any).message);
        pico.cancelled.push(body.awbNumber);
        return answer(null);
      }
      case "/integ/order/track/qc":
        return answer(pico.track ? [pico.track] : []);
      default:
        return new Response("not found", { status: 404 });
    }
  });
}

/* ---------------------------------------------------------------- fixtures */

async function setRule(key: string, value: Record<string, unknown>) {
  await db.insert(platformSettings).values({ key, value }).onConflictDoUpdate({ target: platformSettings.key, set: { value } });
  clearRuleCache();
}

async function flag(key: string, enabled: boolean) {
  await db.insert(featureFlags).values({ key, enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

async function readyOrder(opts: { cod?: boolean; gstin?: string | null; lines?: { taxable: number; tax: number; qtyMilli?: number; rateBp?: number }[] } = {}) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { latitude: SHOP_AT.lat, longitude: SHOP_AT.lng, deliveryAvailable: true });
  await db
    .update(shops)
    .set({ gstin: opts.gstin === undefined ? "29AAECH3221K1ZL" : opts.gstin, addressLine2: "Koramangala 5th Block", state: "Karnataka", pincode: "560064", city: "Bangalore" })
    .where(eq(shops.id, shop.id));
  const customer = await createUser({ name: "Asha Rao" });
  const lines = opts.lines ?? [{ taxable: 95238, tax: 4762, qtyMilli: 2000, rateBp: 500 }];
  const total = lines.reduce((s, l) => s + l.taxable + l.tax, 0);
  const order = await createOrder(customer.id, shop.id, { status: "READY", subtotalPaise: total, totalPaise: total });
  await db
    .update(orders)
    .set({
      paymentMethod: opts.cod ? "COD" : "WALLET",
      deliveryAddressSnapshot: { line1: "44 Residency Road", line2: "Shanthala Nagar", city: "Bangalore", pincode: "560002", latitude: String(DROP_AT.lat), longitude: String(DROP_AT.lng), deliveryInstructions: "Call on arrival" },
    })
    .where(eq(orders.id, order.id));
  const category = await createCategory({ name: "Grocery" });
  const product = await createProduct(category.id, { name: "Basmati Rice" });
  const sp = await createShopProduct(shop.id, product.id);
  for (const l of lines) {
    await db.insert(orderItems).values({
      orderId: order.id,
      shopProductId: sp.id,
      productNameSnapshot: "Basmati Rice 5 kg",
      unitSnapshot: "bag",
      unitPricePaise: Math.round((l.taxable + l.tax) / ((l.qtyMilli ?? 1000) / 1000)),
      quantityMilli: l.qtyMilli ?? 1000,
      lineTotalPaise: l.taxable + l.tax,
      taxablePaise: l.taxable,
      taxPaise: l.tax,
      gstRateBp: l.rateBp ?? 500,
      hsnCode: "1006",
    });
  }
  const [fresh] = await db.select().from(orders).where(eq(orders.id, order.id));
  return { owner, shop, customer, order: fresh };
}

const actor = (id: string) => ({ id, role: "SHOP_OWNER" as const });

async function status(orderId: string) {
  const [o] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  return o.status;
}

function hook(payload: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  // No defer: the processing runs before the answer returns, so the test can look at the result.
  return handleShipmentStatusWebhook(JSON.stringify(payload), new Headers(headers));
}

const T0 = Date.UTC(2026, 10, 27, 10, 0, 0);
const at = (min: number) => T0 + min * 60_000;

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`TRUNCATE delivery_awb_pool, delivery_shipments, delivery_shipment_events, delivery_location_pings, delivery_partner_api_logs, delivery_bookings, delivery_events CASCADE`);
  await db
    .insert(deliveryProviders)
    .values({ code: "PICO", name: "Pico Xpress", enabled: false, environment: "SANDBOX", priority: 20, baseUrl: "https://dev-api.picoxpress.com", capabilities: { integrated: true }, timeoutMs: 10000 })
    .onConflictDoNothing();
  await flag("delivery_partner_picoxpress_enabled", true);
  await flag("pico_live_location_enabled", false);
  await setRule("picoXpress", { awbRefillThreshold: 5, awbFetchBatch: 20 });
  installFakePico();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------- tests */

describe("Pico AWB pool", () => {
  it("refills in batches of at most 1,000, allocates atomically and never twice", async () => {
    expect(await refillPool("STAGING", 5000)).toBe(1000);
    expect(pico.calls[0].path).toBe("/integ/awb/fetch/bulk/v1");
    const orderA = "00000000-0000-0000-0000-00000000000a";
    const orderB = "00000000-0000-0000-0000-00000000000b";
    const [a, b] = await Promise.all([
      db.transaction((tx) => allocateAwbs(tx, "STAGING", 3, orderA, "00000000-0000-0000-0000-0000000000a1")),
      db.transaction((tx) => allocateAwbs(tx, "STAGING", 3, orderB, "00000000-0000-0000-0000-0000000000b1")),
    ]);
    expect(new Set([...a, ...b]).size).toBe(6);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(deliveryAwbPool).where(eq(deliveryAwbPool.status, "ALLOCATED"));
    expect(n).toBe(6);
  });
});

describe("Pico booking", () => {
  it("PREPAID: serviceability first, manifest with codes + bill-to + invoice, shipment CREATED, AWB USED, codes to shop and customer", async () => {
    const { owner, order } = await readyOrder();
    const option = await picoOptionForOrder(order.id);
    expect(option).toMatchObject({ enabled: true, available: true, serviceable: true, paymentType: "PREPAID" });

    const r = await bookPicoShipment(order.id, actor(owner.id));
    expect(r).toMatchObject({ status: "CREATED", picoOrderId: order.orderNumber, alreadyBooked: false });
    const paths = pico.calls.map((c) => c.path);
    expect(paths.indexOf("/integ/order/serviceability/qc")).toBeLessThan(paths.indexOf("/integ/order/create/qc"));
    const sent = pico.created.get(order.orderNumber)!;
    expect(sent).toMatchObject({
      orderId: order.orderNumber,
      awbNumber: r.awbNumber,
      orderType: "FORWARD",
      orderParty: "CONSIGNER",
      pickupType: "RETAIL_STORE",
      orderCollectionDetails: { collectibleAmountPaise: 0, serviceType: "PREPAID" },
      orderNotes: "Call on arrival",
    });
    expect(sent.sourceLocationDetails.gstNumber).toBe("29AAECH3221K1ZL");
    expect(sent.billToLocationDetails.gstNumber).toBe("27ABCCA8318D1ZV"); // AGTCI, from rule picoXpress.billTo
    expect(sent.destinationLocationDetails.address).toMatchObject({ pincode: "560002", latitude: DROP_AT.lat, longitude: DROP_AT.lng });
    expect(sent.consigneeOtp).toMatch(/^\d{6}$/);
    expect(sent.pickupOtp).toMatch(/^\d{6}$/);
    expect(sent.invoiceDetails.invoiceIds).toHaveLength(1);
    expect(sent.goodsDetails.totalGoodsAmountPaise).toBe(100000);

    const [ship] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.orderId, order.id));
    expect(ship).toMatchObject({ status: "CREATED", awbNumber: r.awbNumber, paymentType: "PREPAID", collectiblePaise: 0, env: "STAGING" });
    // The codes are not stored anywhere — derived from the nonce.
    expect(JSON.stringify(ship)).not.toContain(sent.consigneeOtp);
    expect(shipmentCodes(ship.codeNonce).consigneeOtp).toBe(sent.consigneeOtp);
    const [awb] = await db.select().from(deliveryAwbPool).where(eq(deliveryAwbPool.awbNumber, r.awbNumber));
    expect(awb.status).toBe("USED");
    const [booking] = await db.select().from(deliveryBookings).where(eq(deliveryBookings.orderId, order.id));
    expect(booking).toMatchObject({ providerCode: "PICO", channel: "EXTERNAL", status: "CREATED", externalRef: r.awbNumber });
    expect(await status(order.id)).toBe("READY");

    const shopView = (await shopPicoViews([order.id])).get(order.id)!;
    expect(shopView.pickupCode).toBe(sent.pickupOtp);
    expect(shopView.deliveryCode).toBeUndefined();
    const buyerView = (await buyerPicoViews([order.id])).get(order.id)!;
    expect(buyerView.deliveryCode).toBe(sent.consigneeOtp);
    expect(buyerView.pickupCode).toBeUndefined();

    // Booking again returns the same shipment (no duplicate).
    expect(await bookPicoShipment(order.id, actor(owner.id))).toMatchObject({ alreadyBooked: true, awbNumber: r.awbNumber });
    expect(pico.created.size).toBe(1);
  });

  it("COD: collects the order total; multi-box uses child AWBs from the pool", async () => {
    const { owner, order } = await readyOrder({ cod: true });
    const r = await bookPicoShipment(order.id, actor(owner.id), { numBoxes: 3 });
    const sent = pico.created.get(order.orderNumber)!;
    expect(sent.orderCollectionDetails).toEqual({ collectibleAmountPaise: order.totalPaise, serviceType: "COD" });
    expect(sent.boxDetails.numOfBoxes).toBe(3);
    expect(sent.boxDetails.boxList[0].awbNumber).toBe(r.awbNumber);
    expect(new Set(sent.boxDetails.boxList.map((b: { awbNumber: string }) => b.awbNumber)).size).toBe(3);
    const used = await db.select().from(deliveryAwbPool).where(eq(deliveryAwbPool.orderId, order.id));
    expect(used.map((u) => u.status)).toEqual(["USED", "USED", "USED"]);
  });

  it("goods over ₹50,000 need the e-way bill number before booking", async () => {
    const { owner, order } = await readyOrder({ lines: [{ taxable: 4_500_000, tax: 810_000, rateBp: 1800 }] });
    expect((await picoOptionForOrder(order.id)).needsEwayBill).toBe(true);
    await expect(bookPicoShipment(order.id, actor(owner.id))).rejects.toThrow(/e-way bill/);
    expect(pico.calls.some((c) => c.path === "/integ/order/create/qc")).toBe(false);
    expect(await db.select().from(deliveryShipments)).toHaveLength(0);
    await bookPicoShipment(order.id, actor(owner.id), { ewayBillNo: "181000001348" });
    expect(pico.created.get(order.orderNumber)!.invoiceDetails.invoiceIds[0].ewayBillNo).toBe("181000001348");
  });

  it("a PAN-only shop: the option is hidden by default; AGTCI's GSTIN is used only when the setting says so", async () => {
    const { owner, order } = await readyOrder({ gstin: null });
    const option = await picoOptionForOrder(order.id);
    expect(option.available).toBe(false);
    expect(option.reason).toMatch(/GSTIN/);
    await expect(bookPicoShipment(order.id, actor(owner.id))).rejects.toThrow(/GSTIN/);
    await setRule("picoXpress", { awbRefillThreshold: 5, awbFetchBatch: 20, nonGstShops: "USE_AGTCI_GSTIN" });
    await bookPicoShipment(order.id, actor(owner.id));
    expect(pico.created.get(order.orderNumber)!.sourceLocationDetails.gstNumber).toBe("27ABCCA8318D1ZV");
  });

  it("not serviceable: hidden with a clear message and never manifested", async () => {
    pico.serviceable = false;
    const { owner, order } = await readyOrder();
    const option = await picoOptionForOrder(order.id);
    expect(option).toMatchObject({ available: false, serviceable: false });
    expect(option.reason).toMatch(/pickup or your own delivery/);
    await expect(bookPicoShipment(order.id, actor(owner.id))).rejects.toThrow(/does not serve/);
    expect(pico.calls.some((c) => c.path === "/integ/order/create/qc")).toBe(false);
  });

  it.each([
    [{ code: "PX_401", message: "Client not authorized." }, /account check failed/, "AVAILABLE"],
    [{ code: "PX_402", message: "Delivery pincode 560002 is not serviceable" }, /does not serve/, "AVAILABLE"],
    [{ code: "PX_401", message: "Delivery pincode  is not serviceable" }, /does not serve/, "AVAILABLE"],
    [{ code: "PX_403", message: "sourceLocation Primary Contact number cannot be empty" }, /refused the order details/, "AVAILABLE"],
    [{ code: "PX_404", message: "GSTIN Regex mismatch" }, /GSTIN/, "AVAILABLE"],
    [{ code: "PX_406", message: "waybill 1 not a part of allotted waybill for client" }, /tracking number/, "CANCELLED"],
    [{ code: "PX_407", message: "Waybill not found : 1" }, /tracking number/, "CANCELLED"],
  ])("refusal %o → friendly message; AWB %s; booking failed; order stays READY", async (behaviour, message, awbAfter) => {
    pico.createBehaviour.push(behaviour);
    const { owner, order } = await readyOrder();
    await expect(bookPicoShipment(order.id, actor(owner.id))).rejects.toThrow(message);
    const [ship] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.orderId, order.id));
    expect(ship.status).toBe("BOOKING_FAILED");
    const [awb] = await db.select().from(deliveryAwbPool).where(eq(deliveryAwbPool.awbNumber, ship.awbNumber));
    expect(awb.status).toBe(awbAfter);
    const [booking] = await db.select().from(deliveryBookings).where(eq(deliveryBookings.orderId, order.id));
    expect(booking.status).toBe("FAILED");
    expect(await status(order.id)).toBe("READY");
  });

  it("PX_501 unknown error: outcome unknown — AWB kept, retry re-sends the same order id + AWB", async () => {
    pico.createBehaviour.push({ code: "PX_501", message: "Unknown error : db" });
    const { owner, order } = await readyOrder();
    await expect(bookPicoShipment(order.id, actor(owner.id))).rejects.toThrow(/did not confirm/);
    const [before] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.orderId, order.id));
    expect(before.status).toBe("BOOKING_UNCONFIRMED");
    const r = await bookPicoShipment(order.id, actor(owner.id));
    expect(r).toMatchObject({ status: "CREATED", awbNumber: before.awbNumber, picoOrderId: before.picoOrderId });
  });

  it("timeout after Pico created the order: retried with the SAME order id and AWB; 'already exists' = booked; no duplicate", async () => {
    pico.createBehaviour.push("timeout", "timeout", "timeout");
    const { owner, order } = await readyOrder();
    await expect(bookPicoShipment(order.id, actor(owner.id))).rejects.toThrow(/did not confirm/);
    const creates = pico.calls.filter((c) => c.path === "/integ/order/create/qc");
    expect(creates).toHaveLength(3); // network errors are retried (3 attempts), PX_ answers never
    expect(new Set(creates.map((c) => `${c.body.orderId}|${c.body.awbNumber}`)).size).toBe(1);
    const r = await bookPicoShipment(order.id, actor(owner.id)); // Pico now answers "already exists"
    expect(r.status).toBe("CREATED");
    expect(pico.created.size).toBe(1);
    expect(await db.select().from(deliveryShipments)).toHaveLength(1);
  });

  it("HTTP 5xx is retried (3 attempts); a PX_4xx answer is not", async () => {
    pico.createBehaviour.push("http500", "http500");
    const { owner, order } = await readyOrder();
    await bookPicoShipment(order.id, actor(owner.id));
    expect(pico.calls.filter((c) => c.path === "/integ/order/create/qc")).toHaveLength(3);
    const { owner: o2, order: order2 } = await readyOrder();
    pico.createBehaviour.push({ code: "PX_403", message: "orderId cannot be empty" });
    const before = pico.calls.length;
    await expect(bookPicoShipment(order2.id, actor(o2.id))).rejects.toThrow();
    expect(pico.calls.slice(before).filter((c) => c.path === "/integ/order/create/qc")).toHaveLength(1);
  });

  it("the API log masks phones, OTPs, names and street addresses and never holds the keys", async () => {
    const { owner, order } = await readyOrder();
    await bookPicoShipment(order.id, actor(owner.id));
    const logs = await db.select().from(deliveryPartnerApiLogs);
    expect(logs.length).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(logs);
    const sent = pico.created.get(order.orderNumber)!;
    for (const secret of ["TEST_CLIENT_KEY_123", "TEST_API_SECRET_456", sent.consigneeOtp, sent.pickupOtp, sent.destinationLocationDetails.contactNumPrimary, "44 Residency Road", "Asha Rao"]) {
      expect(text).not.toContain(secret);
    }
    expect(logs.every((l) => l.endpoint.includes("clientKey=[redacted]") || !l.endpoint.includes("clientKey"))).toBe(true);
  });
});

describe("Pico tracking webhook", () => {
  async function booked(opts: Parameters<typeof readyOrder>[0] = {}) {
    const f = await readyOrder(opts);
    const r = await bookPicoShipment(f.order.id, actor(f.owner.id));
    return { ...f, awb: r.awbNumber };
  }

  it("refuses a wrong or missing token (401), and answers 404 while the flag is off", async () => {
    const { awb } = await booked();
    expect((await hook({ awbNumber: awb, orderStatus: "DP_ASSIGNED" }, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await hook({ awbNumber: awb, orderStatus: "DP_ASSIGNED" }, {})).status).toBe(401);
    expect((await hook({ awbNumber: awb, orderStatus: "DP_ASSIGNED" }, { "x-gokesari-webhook-token": TOKEN })).status).toBe(200);
    expect((await handleShipmentStatusWebhook("{not json", new Headers({ authorization: `Bearer ${TOKEN}` }))).status).toBe(400);
    await flag("delivery_partner_picoxpress_enabled", false);
    expect((await hook({ awbNumber: awb, orderStatus: "PICKED" })).status).toBe(404);
  });

  it("full journey (doc sample field names): order goes ASSIGNED → PICKED_UP → OUT_FOR_DELIVERY → DELIVERED; rider shown, phone cleared after", async () => {
    const { order, awb } = await booked();
    const hist: { status: string; timeStamp: number; lat?: number; lng?: number }[] = [{ status: "CREATED", timeStamp: at(0) }];
    const send = async (s: string, min: number, extra: Record<string, unknown> = {}) => {
      hist.push({ status: s, timeStamp: at(min), lat: 12.95, lng: 77.6 });
      return hook({ awbNumber: awb, orderStatus: s, createdTimestamp: at(0), trackingUrl: `https://picoxpress.com/track/${awb}`, partnerDetails: { name: "Ravi K", contactNumber: "9876501234" }, statusHistory: hist, fulfillmentEstimates: { pickupEtaInMinutes: 12, deliveryEtaInMinutes: 30 }, ...extra });
    };
    expect((await send("DP_ASSIGNED", 2)).status).toBe(200);
    expect(await status(order.id)).toBe("ASSIGNED");
    const shopView = (await shopPicoViews([order.id])).get(order.id)!;
    expect(shopView.rider).toEqual({ name: "Ravi K", phone: "9876501234" });
    await send("ARRIVED_AT_PICKUP", 10);
    await send("PICKED", 15);
    expect(await status(order.id)).toBe("PICKED_UP");
    expect((await shopPicoViews([order.id])).get(order.id)!.pickupCode).toBeUndefined();
    await send("OUT_FOR_DELIVERY", 16, { eta: at(40) });
    expect(await status(order.id)).toBe("OUT_FOR_DELIVERY");
    const buyer = (await buyerPicoViews([order.id])).get(order.id)!;
    expect(buyer.etaIst).toMatch(/IST$/);
    expect(buyer.trackingUrl).toBe(`https://picoxpress.com/track/${awb}`);
    await send("ARRIVED_AT_LOCATION", 35);
    await send("DELIVERED", 38, { ata: at(38) });
    expect(await status(order.id)).toBe("DELIVERED");
    const [ship] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.awbNumber, awb));
    expect(ship.status).toBe("DELIVERED");
    expect(ship.partnerPhone).toBeNull(); // DPDP: the rider's number is not kept after delivery
    expect((await buyerPicoViews([order.id])).get(order.id)!.deliveryCode).toBeUndefined();
    const tl = (await buyerPicoViews([order.id])).get(order.id)!.timeline.map((t) => t.status);
    expect(tl).toEqual(["CREATED", "DP_ASSIGNED", "ARRIVED_AT_PICKUP", "PICKED", "OUT_FOR_DELIVERY", "ARRIVED_AT_LOCATION", "DELIVERED"]);
  });

  it("table field names (shipmentState, shipmentCreatedTime) work the same", async () => {
    const { order, awb } = await booked();
    await hook({ awbNumber: awb, shipmentState: "DP_ASSIGNED", shipmentCreatedTime: at(0), statusHistory: [{ status: "DP_ASSIGNED", timeStamp: at(1) }], fulfillmentEstimates: {} });
    expect(await status(order.id)).toBe("ASSIGNED");
  });

  it("duplicates change nothing; each status is stored once", async () => {
    const { order, awb } = await booked();
    const payload = { awbNumber: awb, orderStatus: "DP_ASSIGNED", statusHistory: [{ status: "DP_ASSIGNED", timeStamp: at(2) }] };
    await hook(payload);
    const eventsBefore = await db.select().from(deliveryShipmentEvents).where(eq(deliveryShipmentEvents.awbNumber, awb));
    const bookingEventsBefore = (await db.select().from(deliveryEvents)).length;
    await hook(payload);
    await hook(payload);
    expect(await db.select().from(deliveryShipmentEvents).where(eq(deliveryShipmentEvents.awbNumber, awb))).toHaveLength(eventsBefore.length);
    expect(await status(order.id)).toBe("ASSIGNED");
    expect((await db.select().from(deliveryEvents)).length).toBe(bookingEventsBefore);
  });

  it("out of order: a late DP_ASSIGNED after PICKED never moves the order backwards", async () => {
    const { order, awb } = await booked();
    await hook({ awbNumber: awb, orderStatus: "PICKED", statusHistory: [{ status: "PICKED", timeStamp: at(15) }] });
    expect(await status(order.id)).toBe("PICKED_UP");
    await hook({ awbNumber: awb, orderStatus: "DP_ASSIGNED", statusHistory: [{ status: "DP_ASSIGNED", timeStamp: at(2) }] });
    expect(await status(order.id)).toBe("PICKED_UP");
    const [ship] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.awbNumber, awb));
    expect(ship.status).toBe("PICKED");
  });

  it("missed webhooks: statusHistory is replayed so the order passes every step", async () => {
    const { order, awb } = await booked();
    await hook({
      awbNumber: awb,
      orderStatus: "OUT_FOR_DELIVERY",
      statusHistory: [
        { status: "CREATED", timeStamp: at(0) },
        { status: "DP_ASSIGNED", timeStamp: at(2) },
        { status: "PICKED", timeStamp: at(15) },
        { status: "OUT_FOR_DELIVERY", timeStamp: at(16) },
      ],
    });
    expect(await status(order.id)).toBe("OUT_FOR_DELIVERY");
    const events = await db.select().from(deliveryShipmentEvents).where(eq(deliveryShipmentEvents.awbNumber, awb));
    // CREATED twice: ours at booking time and Pico's own (different times); every other status once.
    expect([...new Set(events.map((e) => e.status))].sort()).toEqual(["CREATED", "DP_ASSIGNED", "OUT_FOR_DELIVERY", "PICKED"].sort());
    expect(events.filter((e) => e.status !== "CREATED")).toHaveLength(3);
  });

  it("unknown status: stored, logged, acknowledged (200), nothing moves", async () => {
    const { order, awb } = await booked();
    const res = await hook({ awbNumber: awb, orderStatus: "REACHED_HUB", statusHistory: [{ status: "REACHED_HUB", timeStamp: at(5) }] });
    expect(res.status).toBe(200);
    expect(await status(order.id)).toBe("READY");
    const ev = await db.select().from(deliveryShipmentEvents).where(eq(deliveryShipmentEvents.status, "REACHED_HUB"));
    expect(ev).toHaveLength(1);
    // An AWB we never booked is acknowledged too (Pico must not retry forever).
    expect((await hook({ awbNumber: "999999999999", orderStatus: "CREATED" })).status).toBe(200);
  });

  it("RTO: the order fails and is returned; LOST raises a support case", async () => {
    const { order, awb } = await booked();
    await hook({ awbNumber: awb, orderStatus: "PICKED", statusHistory: [{ status: "PICKED", timeStamp: at(15) }] });
    await hook({ awbNumber: awb, orderStatus: "RTO", statusHistory: [{ status: "RTO", timeStamp: at(50), reason: "Customer unavailable" }] });
    expect(await status(order.id)).toBe("FAILED");
    await hook({ awbNumber: awb, orderStatus: "RTO_DELIVERED", statusHistory: [{ status: "RTO_DELIVERED", timeStamp: at(80) }] });
    expect(await status(order.id)).toBe("RETURNED");

    const second = await booked();
    await hook({ awbNumber: second.awb, orderStatus: "PICKED", statusHistory: [{ status: "PICKED", timeStamp: at(15) }] });
    await hook({ awbNumber: second.awb, orderStatus: "LOST", statusHistory: [{ status: "LOST", timeStamp: at(60), reason: "Not found at hub" }] });
    const [ship] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.awbNumber, second.awb));
    expect(ship.status).toBe("LOST");
    expect(await status(second.order.id)).toBe("FAILED");
  });

  it("live location: dropped while its paid flag is off; stored and shown on the map when on", async () => {
    const { awb } = await booked();
    const body = JSON.stringify({ awbNumber: awb, partnerDetails: { name: "Ravi", contactNumber: "9876501234" }, partnerLocation: { lat: 12.95, lng: 77.61 }, fulfillmentEstimates: { deliveryEtaInMinutes: 20 } });
    const h = new Headers({ authorization: `Bearer ${TOKEN}` });
    expect(await handleLocationWebhook(body, h)).toMatchObject({ status: 200, body: { stored: false } });
    expect(await db.select().from(deliveryLocationPings)).toHaveLength(0);
    expect((await handleLocationWebhook(body, new Headers({ authorization: "Bearer x" }))).status).toBe(401);
    await flag("pico_live_location_enabled", true);
    expect((await handleLocationWebhook(body, h)).status).toBe(200);
    expect(await db.select().from(deliveryLocationPings)).toHaveLength(1);
    const [booking] = await db.select().from(deliveryBookings).where(eq(deliveryBookings.externalRef, awb));
    expect(Number(booking.riderLat)).toBeCloseTo(12.95, 5);
  });

  it("Refresh status (pull API) and the silent-shipment sweep apply the same processing", async () => {
    const { order, awb } = await booked();
    pico.track = { awbNumber: awb, shipmentState: "DP_ASSIGNED", shipmentCreatedTime: at(0), statusHistory: [{ status: "DP_ASSIGNED", timeStamp: at(3) }], partnerDetails: { name: "Ravi", contactNumber: "9876501234" } };
    const r = await refreshPicoShipment(order.id);
    expect(r).toMatchObject({ result: "APPLIED", status: "DP_ASSIGNED" });
    expect(await status(order.id)).toBe("ASSIGNED");
    const track = pico.calls.find((c) => c.path === "/integ/order/track/qc")!;
    expect(track.method).toBe("GET");
    await db.update(deliveryShipments).set({ updatedAt: new Date(Date.now() - 10 * 60_000) });
    pico.track = { ...pico.track, shipmentState: "PICKED", statusHistory: [{ status: "PICKED", timeStamp: at(15) }] };
    expect(await sweepSilentShipments()).toMatchObject({ pulled: 1, changed: 1 });
    expect(await status(order.id)).toBe("PICKED_UP");
  });
});

describe("Pico cancel", () => {
  it("allowed while CREATED: Pico called, booking + shipment CANCELLED, AWB retired (never reused), order stays READY", async () => {
    const { owner, order } = await readyOrder();
    const r = await bookPicoShipment(order.id, actor(owner.id));
    await cancelPicoShipment(order.id, "SHOP", "Shop cannot fulfil the order", actor(owner.id));
    expect(pico.cancelled).toEqual([r.awbNumber]);
    const [ship] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.orderId, order.id));
    expect(ship).toMatchObject({ status: "CANCELLED", cancelledBy: "SHOP" });
    const [awb] = await db.select().from(deliveryAwbPool).where(eq(deliveryAwbPool.awbNumber, r.awbNumber));
    expect(awb.status).toBe("CANCELLED");
    expect(await status(order.id)).toBe("READY");
    // Booking again after a cancel: a new AWB and a suffixed order id (unique per shipment for Pico).
    const again = await bookPicoShipment(order.id, actor(owner.id));
    expect(again.awbNumber).not.toBe(r.awbNumber);
    expect(again.picoOrderId).toBe(`${order.orderNumber}-2`);
  });

  it("blocked after pickup with the return / dispute message; Pico is not called", async () => {
    const { owner, order } = await readyOrder();
    const r = await bookPicoShipment(order.id, actor(owner.id));
    await hook({ awbNumber: r.awbNumber, orderStatus: "PICKED", statusHistory: [{ status: "PICKED", timeStamp: at(15) }] });
    await expect(cancelPicoShipment(order.id, "SHOP", "Changed mind", actor(owner.id))).rejects.toThrow(/Order already picked up — cannot cancel; raise a return or a dispute/);
    expect(pico.cancelled).toEqual([]);
  });

  it("Pico's refusal is final", async () => {
    const { owner, order } = await readyOrder();
    await bookPicoShipment(order.id, actor(owner.id));
    pico.cancelBehaviour = { code: "PX_403", message: "Order cannot be cancelled in current state" } as any;
    pico.track = null;
    await expect(cancelPicoShipment(order.id, "SHOP", "Changed mind", actor(owner.id))).rejects.toThrow(/can no longer cancel/);
    const [ship] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.orderId, order.id));
    expect(ship.status).toBe("CREATED");
  });

  it("a customer cancelling the order cancels the Pico shipment through the existing order-cancel path", async () => {
    const { customer, order } = await readyOrder();
    const owner = (await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, order.shopId)))[0];
    const r = await bookPicoShipment(order.id, actor(owner.ownerId));
    await db.update(orders).set({ status: "CONFIRMED" }).where(eq(orders.id, order.id)); // cancellable stage for this test
    await cancelOrder(order.id, { id: customer.id, role: "CUSTOMER" }, "Ordered by mistake").catch(async () => {
      // Some cancel policies refuse at this stage; the operator path is the same hook.
      await cancelOrder(order.id, { id: owner.ownerId, role: "SHOP_OWNER" }, "Customer asked");
    });
    expect(pico.cancelled).toContain(r.awbNumber);
    const [ship] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.orderId, order.id));
    expect(ship.status).toBe("CANCELLED");
  });
});

describe("Shop's delivery plan with the gokesari.com delivery partner", () => {
  it("planning Pico books it straight away and never starts a GoKesari rider search; switching cancels it", async () => {
    await setRule("fulfilmentOptions", { enabled: true });
    const { owner, order } = await readyOrder();
    const days = availableSlotDays({ slotMinutes: 60, firstSlotHour: 0, lastSlotHour: 24, maxDaysAhead: 1 });
    await setRule("fulfilmentOptions", { enabled: true, firstSlotHour: 0, lastSlotHour: 24 });
    const slotKey = days[0].slots[0].key;
    const res = await planFulfilment(order.id, { option: "GOKESARI_PARTNER", partner: "PICO", slotKey }, actor(owner.id) as never);
    expect(res.pico).toMatchObject({ booked: true });
    const [plan] = await db.select().from(orderFulfilmentArrangements).where(eq(orderFulfilmentArrangements.orderId, order.id));
    expect(plan).toMatchObject({ option: "GOKESARI_PARTNER", externalPartner: "PICO" });
    expect(await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id))).toHaveLength(0);
    const searches = await db.select().from(riderSearches).where(eq(riderSearches.orderId, order.id));
    expect(searches.every((s) => s.status !== "SEARCHING")).toBe(true);

    // The shop switches to pickup: the Pico shipment is cancelled first.
    await planFulfilment(order.id, { option: "PICKUP", slotKey }, actor(owner.id) as never);
    expect(pico.cancelled).toHaveLength(1);
    const [ship] = await db.select().from(deliveryShipments).where(eq(deliveryShipments.orderId, order.id));
    expect(ship.status).toBe("CANCELLED");
  });
});
