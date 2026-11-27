/* eslint-disable @typescript-eslint/no-explicit-any -- the manifest and webhook bodies are free-form JSON in these tests */
/**
 * Pico Xpress (docs/pico-xpress-2026-11): the pure parts — manifest builder and its checks, every PX error
 * code, tracking payload parsing (both field-name variants, unknown statuses), lifecycle ordering, masking,
 * webhook auth and the environment guard.
 */
import { describe, expect, it } from "vitest";

import { checkPicoConfig } from "@/server/delivery/pico/config";
import { deriveCode } from "@/server/delivery/pico/codes";
import { classifyPicoError, friendlyPicoMessage, PicoError } from "@/server/delivery/pico/errors";
import { maskEndpoint, maskForLog } from "@/server/delivery/pico/mask";
import { buildManifest, goodsTotals, tenDigitPhone, unitsFor, validateManifest, type ManifestInput } from "@/server/delivery/pico/payload";
import {
  bookingStatusFor,
  bookingSteps,
  parseLocationPayload,
  parseTrackingPayload,
  picoCancellable,
  shouldAdvance,
} from "@/server/delivery/pico/status";
import { checkWebhookAuth, ipAllowed, presentedToken, tokenMatches } from "@/server/delivery/pico/webhook-auth";

const party = (over: Partial<ManifestInput["source"]> = {}): ManifestInput["source"] => ({
  personName: "Ramesh Patil",
  unitName: "Patil Kirana",
  phone: "+91 98765 43210",
  gstin: "27ABCCA8318D1ZV",
  addressLine1: "12 MG Road",
  addressLine2: "Koramangala",
  city: "Bangalore",
  state: "Karnataka",
  pincode: "560064",
  lat: 12.9716,
  lng: 77.5946,
  ...over,
});

function input(over: Partial<ManifestInput> = {}): ManifestInput {
  return {
    picoOrderId: "GK1001",
    awbNumber: "100100000467",
    childAwbs: [],
    pickupType: "RETAIL_STORE",
    pickupOtp: "123456",
    consigneeOtp: "654321",
    source: party(),
    destination: party({ gstin: null, pincode: "560002", personName: "Asha", unitName: "Asha" }),
    billTo: party({ lat: null, lng: null, pincode: "411014", city: "Pune", state: "Maharashtra" }),
    numBoxes: 1,
    deadWeightGrams: 1200,
    items: [{ title: "Basmati Rice 5 kg", hsnCode: "1006", quantityMilli: 2000, taxablePaise: 95238, taxPaise: 4762, gstRateBp: 500 }],
    invoiceIds: ["INV-1"],
    ewayBillNo: null,
    ewayBillThresholdPaise: 5_000_000,
    collectiblePaise: 0,
    notes: "Ring the bell",
    ...over,
  };
}

describe("Pico manifest builder", () => {
  it("builds the documented body for a PREPAID single-box order", () => {
    const body = buildManifest(input()) as Record<string, any>;
    expect(validateManifest(input())).toEqual([]);
    expect(body).toMatchObject({
      orderId: "GK1001",
      awbNumber: "100100000467",
      orderType: "FORWARD",
      orderParty: "CONSIGNER",
      pickupType: "RETAIL_STORE",
      pickupOtp: "123456",
      consigneeOtp: "654321",
      returnLocationDetails: null,
      orderCollectionDetails: { collectibleAmountPaise: 0, serviceType: "PREPAID" },
      invoiceDetails: { invoiceIds: [{ invoiceId: "INV-1" }] },
      orderNotes: "Ring the bell",
    });
    expect(body.sourceLocationDetails.contactNumPrimary).toBe("9876543210");
    expect(body.sourceLocationDetails.gstNumber).toBe("27ABCCA8318D1ZV");
    expect(body.sourceLocationDetails.address).toMatchObject({ addressLine1: "12 MG Road", addressLine2: "Koramangala", pincode: "560064", latitude: 12.9716, longitude: 77.5946 });
    expect(body.goodsDetails).toEqual({
      goodsAmountPaise: 95238,
      goodsTaxAmountPaise: 4762,
      totalGoodsAmountPaise: 100000,
      goodsDetailsList: [{ itemTitle: "Basmati Rice 5 kg", hsnCode: "1006", unitPricePaise: 50000, unitQty: 2, taxPercentage: 5 }],
    });
    expect(body.boxDetails).toMatchObject({ numOfBoxes: 1, deadWeightGrams: 1200 });
    expect(body.boxDetails.boxList).toEqual([expect.objectContaining({ awbNumber: "100100000467", weight: 1200, weightUnit: "GRAM", dimensionUnit: "CM" })]);
    expect(Number.isInteger(body.goodsDetails.goodsAmountPaise)).toBe(true);
  });

  it("COD: collectible > 0 is COD; 0 is PREPAID (Pico's strict rule)", () => {
    const cod = buildManifest(input({ collectiblePaise: 100000 })) as Record<string, any>;
    expect(cod.orderCollectionDetails).toEqual({ collectibleAmountPaise: 100000, serviceType: "COD" });
    const prepaid = buildManifest(input({ collectiblePaise: 0 })) as Record<string, any>;
    expect(prepaid.orderCollectionDetails).toEqual({ collectibleAmountPaise: 0, serviceType: "PREPAID" });
  });

  it("multi-box: parent AWB on box 1, child AWBs on the others, weights add up", () => {
    const i = input({ numBoxes: 3, childAwbs: ["100100000468", "100100000469"], deadWeightGrams: 3001 });
    expect(validateManifest(i)).toEqual([]);
    const body = buildManifest(i) as Record<string, any>;
    expect(body.boxDetails.numOfBoxes).toBe(3);
    expect(body.boxDetails.boxList.map((b: { awbNumber: string }) => b.awbNumber)).toEqual(["100100000467", "100100000468", "100100000469"]);
    expect(body.boxDetails.boxList.reduce((s: number, b: { weight: number }) => s + b.weight, 0)).toBe(3001);
    expect(validateManifest(input({ numBoxes: 3, childAwbs: ["x1234"] }))).toEqual(expect.arrayContaining([expect.objectContaining({ field: "boxList" })]));
  });

  it("e-way bill: required above ₹50,000 (5,000,000 paise), 12 digits", () => {
    const big = input({ items: [{ title: "TV", hsnCode: "8528", quantityMilli: 1000, taxablePaise: 4_500_000, taxPaise: 810_000, gstRateBp: 1800 }] });
    expect(goodsTotals(big.items).totalGoodsAmountPaise).toBe(5_310_000);
    expect(validateManifest(big).map((p) => p.field)).toContain("ewayBillNo");
    expect(validateManifest({ ...big, ewayBillNo: "12345" }).map((p) => p.field)).toContain("ewayBillNo");
    const ok = { ...big, ewayBillNo: "181000001348" };
    expect(validateManifest(ok)).toEqual([]);
    expect((buildManifest(ok) as Record<string, any>).invoiceDetails.invoiceIds[0]).toEqual({ invoiceId: "INV-1", ewayBillNo: "181000001348" });
    // Exactly ₹50,000 does not need it.
    const edge = input({ items: [{ title: "X", hsnCode: null, quantityMilli: 1000, taxablePaise: 4_000_000, taxPaise: 1_000_000, gstRateBp: 2500 }] });
    expect(validateManifest(edge)).toEqual([]);
  });

  it("refuses a missing GSTIN for the shop (non-GST shop) and a bad one for the customer", () => {
    expect(validateManifest(input({ source: party({ gstin: null }) })).map((p) => p.field)).toContain("shop.gstin");
    expect(validateManifest(input({ source: party({ gstin: "ABCDE1234F" }) })).map((p) => p.field)).toContain("shop.gstin");
    expect(validateManifest(input({ destination: party({ gstin: "BAD" }) })).map((p) => p.field)).toContain("customer.gstin");
  });

  it("refuses missing map pins, address line 2, phones and PIN codes with plain messages", () => {
    const problems = validateManifest(input({ source: party({ lat: null, addressLine2: "", phone: "12345", pincode: "56" }) }));
    expect(problems.map((p) => p.field)).toEqual(expect.arrayContaining(["shop.location", "shop.addressLine2", "shop.phone", "shop.pincode"]));
    expect(problems.every((p) => p.message.length > 5)).toBe(true);
  });

  it("goods amounts and unit prices must be > 0; loose goods need a final price", () => {
    expect(validateManifest(input({ items: [{ title: "Free sample", hsnCode: null, quantityMilli: 1000, taxablePaise: 0, taxPaise: 0, gstRateBp: 0 }] })).map((p) => p.field)).toEqual(
      expect.arrayContaining(["goodsAmountPaise", "goodsTaxAmountPaise"]),
    );
    expect(validateManifest(input({ items: [] })).map((p) => p.field)).toContain("goodsDetailsList");
    // 1.25 kg of loose dal: one unit at the line price, quantity in the title.
    const loose = unitsFor({ title: "Toor Dal (loose)", hsnCode: "0713", quantityMilli: 1250, taxablePaise: 16000, taxPaise: 0, gstRateBp: 0 });
    expect(loose).toEqual({ unitQty: 1, unitPricePaise: 16000, title: "Toor Dal (loose) (1.25)" });
  });

  it("normalises phone numbers to exactly 10 digits", () => {
    expect(tenDigitPhone("+919876543210")).toBe("9876543210");
    expect(tenDigitPhone("09876543210")).toBe("9876543210");
    expect(tenDigitPhone("98765 43210")).toBe("9876543210");
    expect(tenDigitPhone("12345")).toBeNull();
    expect(tenDigitPhone(null)).toBeNull();
  });
});

describe("Pico response codes", () => {
  it.each([
    ["PX_401", "Client not authorized.", "AUTH"],
    ["PX_401", "Not a registered client key : X", "AUTH"],
    ["PX_402", "Delivery pincode 560064 is not serviceable", "NOT_SERVICEABLE"],
    // The doc's own sample: PX_401 for "not serviceable".
    ["PX_401", "Delivery pincode  is not serviceable", "NOT_SERVICEABLE"],
    ["PX_403", "orderId cannot be empty", "INVALID_INPUT"],
    // The doc's own sample: PX_402 for an input error.
    ["PX_402", "orderId field cannot be empty", "INVALID_INPUT"],
    ["PX_404", "Invalid GSTIN Length", "INVALID_GSTIN"],
    ["PX_404", "GSTIN Regex mismatch", "INVALID_GSTIN"],
    ["PX_406", "waybill 1001 not a part of allotted waybill for client", "AWB_NOT_ALLOTTED"],
    ["PX_407", "Waybill not found : 1001", "AWB_NOT_FOUND"],
    ["PX_501", "Unknown error : boom", "UNKNOWN"],
    ["PX_501", "Order already exists for orderId GK1", "ALREADY_EXISTS"],
    ["PX_403", "Awb count should be less than max  request-able limit : 10000", "INVALID_INPUT"],
  ])("%s %s → %s", (code, message, kind) => {
    expect(classifyPicoError(code, message)).toBe(kind);
  });

  it("only network errors are retried; refusals release AWBs; auth / AWB errors alert admin", () => {
    const auth = new PicoError("AUTH", "x", "PX_401", 200, false);
    expect(auth.orderNotCreated).toBe(true);
    expect(auth.alertsAdmin).toBe(true);
    const unknown = new PicoError("UNKNOWN", "x", "PX_501", 200, false);
    expect(unknown.orderNotCreated).toBe(false);
    expect(new PicoError("NOT_SERVICEABLE", "x", "PX_402", 200, false).alertsAdmin).toBe(false);
  });

  it("gives every kind a friendly message", () => {
    for (const k of ["AUTH", "NOT_SERVICEABLE", "INVALID_INPUT", "INVALID_GSTIN", "AWB_NOT_ALLOTTED", "AWB_NOT_FOUND", "ALREADY_EXISTS", "NOT_CANCELLABLE", "UNKNOWN", "NETWORK", "BAD_RESPONSE"] as const) {
      expect(friendlyPicoMessage(k).length).toBeGreaterThan(20);
    }
  });
});

describe("Pico tracking payloads", () => {
  const history = [
    { status: "CREATED", timeStamp: 1714482138000, lat: null, lng: null, reason: null },
    { status: "DP_ASSIGNED", timeStamp: 1714482238000, lat: 12.34, lng: 77.24, reason: null },
  ];

  it("reads the doc's sample field names (orderStatus, createdTimestamp)", () => {
    const [t] = parseTrackingPayload({ awbNumber: "100100004359", orderStatus: "DP_ASSIGNED", createdTimestamp: 1714482138000, trackingUrl: "https://picoxpress.com/track/1", partnerDetails: { name: "Ravi", contactNumber: "9876543210" }, statusHistory: history, fulfillmentEstimates: { pickupEtaInMinutes: 14 } });
    expect(t).toMatchObject({ awbNumber: "100100004359", status: "DP_ASSIGNED", partnerName: "Ravi", partnerPhone: "9876543210", pickupEtaMin: 14, trackingUrl: "https://picoxpress.com/track/1" });
    expect(t.createdAt?.getTime()).toBe(1714482138000);
    expect(t.history.map((h) => h.status)).toEqual(["CREATED", "DP_ASSIGNED"]);
  });

  it("reads the doc's table field names (shipmentState, shipmentCreatedTime) and the pull list", () => {
    const list = parseTrackingPayload([{ awbNumber: "1001", shipmentState: "PICKED", shipmentCreatedTime: 1714482138000, statusHistory: [] }]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "PICKED" });
    expect(list[0].createdAt?.getTime()).toBe(1714482138000);
    expect(parseTrackingPayload({ trackingDetails: [{ awbNumber: "1002", orderStatus: "CREATED" }] })[0].awbNumber).toBe("1002");
  });

  it("keeps unknown statuses (logged, never rejected) and drops payloads without an AWB", () => {
    const [t] = parseTrackingPayload({ awbNumber: "1003", orderStatus: "Reached Hub", statusHistory: [] });
    expect(t.status).toBe("REACHED_HUB");
    expect(bookingStatusFor(t.status)).toBeNull();
    expect(parseTrackingPayload({ orderStatus: "CREATED" })).toEqual([]);
    expect(parseTrackingPayload("nonsense")).toEqual([]);
  });

  it("ignores an http (not https) tracking URL", () => {
    expect(parseTrackingPayload({ awbNumber: "1004", orderStatus: "CREATED", trackingUrl: "http://evil.example/x" })[0].trackingUrl).toBeNull();
  });

  it("parses the live-location payload", () => {
    expect(parseLocationPayload({ awbNumber: "100100002452", partnerDetails: { name: "P", contactNumber: "9876543210" }, partnerLocation: { lat: 13.2425355, lng: 77.24 }, fulfillmentEstimates: { pickupEtaInMinutes: 14, deliveryEtaInMinutes: 70 } })).toMatchObject({
      awbNumber: "100100002452",
      lat: 13.2425355,
      lng: 77.24,
      pickupEtaMin: 14,
      deliveryEtaMin: 70,
    });
    expect(parseLocationPayload({ awbNumber: "1", partnerLocation: { lat: 999, lng: 1 } })).toBeNull();
  });

  it("never moves backwards; equal ranks follow the newer event; terminal states stay", () => {
    const t0 = new Date(1000);
    const t1 = new Date(2000);
    expect(shouldAdvance("PICKED", "DP_ASSIGNED", t1, t0)).toBe(false);
    expect(shouldAdvance("DP_ASSIGNED", "PICKED", t1, t0)).toBe(true);
    expect(shouldAdvance("OUT_FOR_DELIVERY", "ATTEMPTED_UNDELIVERED", t1, t0)).toBe(true);
    expect(shouldAdvance("ATTEMPTED_UNDELIVERED", "OUT_FOR_DELIVERY", t0, t1)).toBe(false);
    expect(shouldAdvance("DELIVERED", "RTO", t1, t0)).toBe(false);
    expect(shouldAdvance("CREATED", "SOMETHING_NEW", t1, t0)).toBe(false);
  });

  it("fills skipped booking steps (a missed webhook)", () => {
    expect(bookingSteps("CREATED", "PICKED_UP")).toEqual(["ASSIGNED", "AT_PICKUP", "PICKED_UP"]);
    expect(bookingSteps("ASSIGNED", "DELIVERED")).toEqual(["AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "DELIVERED"]);
    expect(bookingSteps("AT_PICKUP", "RETURNED")).toEqual(["PICKED_UP", "RETURNING", "RETURNED"]);
    expect(bookingSteps("IN_TRANSIT", "FAILED")).toEqual(["FAILED"]);
    expect(bookingSteps("IN_TRANSIT", "IN_TRANSIT")).toEqual([]);
  });

  it("cancel only while DRAFT or CREATED", () => {
    expect(picoCancellable("DRAFT")).toBe(true);
    expect(picoCancellable("CREATED")).toBe(true);
    for (const s of ["DP_ASSIGNED", "ARRIVED_AT_PICKUP", "PICKED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"]) expect(picoCancellable(s)).toBe(false);
  });
});

describe("Pico security helpers", () => {
  it("masks phones, OTPs, keys, names and street lines; keeps city / PIN; rounds coordinates", () => {
    const m = maskForLog({
      clientKey: "CK",
      Authorization: "secret",
      pickupOtp: "123456",
      consigneeOtp: "654321",
      sourceLocationDetails: { representativePersonName: "Ramesh", contactNumPrimary: "9876543210", gstNumber: "27ABCCA8318D1ZV", address: { addressLine1: "12 MG Road", city: "Pune", pincode: "411001", latitude: 18.5591234 } },
      partnerDetails: { name: "Ravi", contactNumber: "9876501234" },
    }) as Record<string, any>;
    const text = JSON.stringify(m);
    for (const secret of ["CK", "secret", "123456", "654321", "Ramesh", "9876543210", "12 MG Road", "Ravi", "9876501234"]) expect(text).not.toContain(secret);
    expect(m.sourceLocationDetails.contactNumPrimary).toBe("********10");
    expect(m.sourceLocationDetails.address.city).toBe("Pune");
    expect(m.sourceLocationDetails.address.latitude).toBe(18.559);
    expect(maskEndpoint("/integ/awb/fetch/bulk/v1?clientKey=ABC&awbCount=5")).toBe("/integ/awb/fetch/bulk/v1?clientKey=[redacted]&awbCount=5");
  });

  it("webhook token: Bearer or X-GoKesari-Webhook-Token, constant-time, wrong / missing refused", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abd", "abc")).toBe(false);
    expect(tokenMatches("", "abc")).toBe(false);
    expect(presentedToken(new Headers({ authorization: "Bearer tok-1" }))).toBe("tok-1");
    expect(presentedToken(new Headers({ "x-gokesari-webhook-token": "tok-2" }))).toBe("tok-2");
    expect(checkWebhookAuth(new Headers({ authorization: "Bearer good" }), "good", [])).toEqual({ ok: true });
    expect(checkWebhookAuth(new Headers({ authorization: "Bearer bad" }), "good", [])).toMatchObject({ ok: false, status: 401 });
    expect(checkWebhookAuth(new Headers({}), "good", [])).toMatchObject({ ok: false, status: 401 });
    expect(checkWebhookAuth(new Headers({ authorization: "Bearer good" }), null, [])).toMatchObject({ ok: false, status: 503 });
    expect(checkWebhookAuth(new Headers({ authorization: "Bearer good", "x-forwarded-for": "5.6.7.8" }), "good", ["1.2.3.4"])).toMatchObject({ ok: false, status: 403 });
    expect(ipAllowed("10.1.2.3", ["10.1."])).toBe(true);
    // Pico's dashboard takes only a URL: the token may come as ?token= (headers still win).
    expect(presentedToken(new Headers({}), "https://test.gokesari.com/api/webhooks/picoxpress/shipment-status?token=tok-3")).toBe("tok-3");
    expect(checkWebhookAuth(new Headers({}), "good", [], "/api/webhooks/picoxpress/location?token=good")).toEqual({ ok: true });
    expect(checkWebhookAuth(new Headers({}), "good", [], "/api/webhooks/picoxpress/location?token=bad")).toMatchObject({ ok: false, status: 401 });
    expect(checkWebhookAuth(new Headers({ "x-forwarded-for": "4.187.148.44" }), "good", ["4.187.148.44"], "/x?token=good")).toEqual({ ok: true });
    expect(checkWebhookAuth(new Headers({ "x-forwarded-for": "9.9.9.9" }), "good", ["4.187.148.44"], "/x?token=good")).toMatchObject({ ok: false, status: 403 });
  });

  it("environment guard: gokesari.com uses Pico production only; other sites never do", () => {
    const keys = { clientKey: "CK", apiKey: "AK", webhookToken: "WT" };
    expect(checkPicoConfig({ ...keys, baseUrl: "https://api.picoxpress.com" }, "production")).toMatchObject({ ok: true, config: { env: "PRODUCTION" } });
    expect(checkPicoConfig({ ...keys, baseUrl: "https://dev-api.picoxpress.com" }, "production")).toMatchObject({ ok: false });
    expect(checkPicoConfig({ ...keys, baseUrl: "https://dev-api.picoxpress.com" }, "test")).toMatchObject({ ok: true, config: { env: "STAGING" } });
    expect(checkPicoConfig({ ...keys, baseUrl: "https://api.picoxpress.com" }, "test")).toMatchObject({ ok: false });
    expect(checkPicoConfig({ ...keys, baseUrl: "http://dev-api.picoxpress.com" }, "local")).toMatchObject({ ok: false });
    expect(checkPicoConfig({ ...keys, baseUrl: "https://evil.example.com" }, "local")).toMatchObject({ ok: false });
    expect(checkPicoConfig({ baseUrl: "https://dev-api.picoxpress.com" }, "test")).toMatchObject({ ok: false });
  });

  it("codes: 6 digits, stable per nonce, different for pickup and delivery", () => {
    const a = deriveCode("s", "n1", "pickup");
    expect(a).toMatch(/^\d{6}$/);
    expect(deriveCode("s", "n1", "pickup")).toBe(a);
    expect(deriveCode("s", "n1", "delivery")).not.toBe(a);
    expect(deriveCode("s2", "n1", "pickup")).not.toBe(a);
  });
});
