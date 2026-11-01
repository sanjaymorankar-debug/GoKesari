import { describe, expect, it } from "vitest";

import {
  computeBill,
  deliveryFeeGst,
  documentKind,
  effectiveRegistrationType,
  isB2b,
  lineTaxFor,
  moneyCollector,
  moneyFlowMode,
  registrationTypeFromLegacy,
  supplyBlock,
  supplyTypeOf,
  tcsFor,
  tdsApplies,
  type MoneyCollector,
  type MoneyFlowMode,
} from "@/server/tax/engine";

const COLLECTOR: Record<MoneyFlowMode, MoneyCollector> = {
  ONLINE_PREPAID: "PLATFORM",
  WALLET_PREPAID: "PLATFORM",
  COD_PLATFORM_RIDER: "PLATFORM",
  COD_SHOP: "SHOP",
  PICKUP_PAID_AT_SHOP: "SHOP",
};
const GUARD = { enrolmentInterStateAllowed: false, compositionInterStateAllowed: false };
const TCS = { rateBp: 50, applyWhenShopCollects: true, tcsOnUnregistered: false };

describe("money flow (§5.1)", () => {
  it("names the mode from payment method and fulfilment", () => {
    expect(moneyFlowMode("ONLINE", "GOKESARI_PARTNER")).toBe("ONLINE_PREPAID");
    expect(moneyFlowMode("WALLET", "PICKUP")).toBe("WALLET_PREPAID");
    expect(moneyFlowMode("COD", "GOKESARI_PARTNER")).toBe("COD_PLATFORM_RIDER");
    expect(moneyFlowMode("COD", "SHOP_DELIVERY")).toBe("COD_SHOP");
    expect(moneyFlowMode("COD", "PICKUP")).toBe("PICKUP_PAID_AT_SHOP");
  });
  it("maps each mode to who received the money by the admin's map", () => {
    expect(moneyCollector("COD_PLATFORM_RIDER", COLLECTOR)).toBe("PLATFORM");
    expect(moneyCollector("COD_SHOP", COLLECTOR)).toBe("SHOP");
    expect(moneyCollector("COD_SHOP", { ...COLLECTOR, COD_SHOP: "PLATFORM" })).toBe("PLATFORM");
  });
});

describe("document and supply type", () => {
  it("only a regular registration issues a tax invoice", () => {
    expect(documentKind("REGULAR")).toBe("TAX_INVOICE");
    for (const t of ["COMPOSITION", "ENROLMENT_ID", "PAN_ONLY_SERVICE", "UNREGISTERED"] as const) expect(documentKind(t)).toBe("BILL_OF_SUPPLY");
  });
  it("inter-state only when both states are known and differ", () => {
    expect(supplyTypeOf("MH", "MH")).toBe("INTRA");
    expect(supplyTypeOf("MH", "KA")).toBe("INTER");
    expect(supplyTypeOf("MH", null)).toBe("INTRA");
    expect(supplyTypeOf(null, "KA")).toBe("INTRA");
  });
  it("B2B needs a well-formed GSTIN", () => {
    expect(isB2b({ gstin: "27AAAPL1234C1ZV" })).toBe(true);
    expect(isB2b({ gstin: "27AAAPL" })).toBe(false);
    expect(isB2b({})).toBe(false);
  });
});

describe("order guard (§3.3)", () => {
  const sup = (registrationType: Parameters<typeof documentKind>[0], portalStatus: "ACTIVE" | "CANCELLED" | "SUSPENDED" | null = "ACTIVE") => ({
    registrationType,
    stateCode: "MH",
    portalStatus,
  });
  it("blocks a cancelled or suspended GSTIN even intra-state", () => {
    expect(supplyBlock(sup("REGULAR", "CANCELLED"), "MH", GUARD)?.code).toBe("GSTIN_NOT_ACTIVE");
    expect(supplyBlock(sup("REGULAR", "SUSPENDED"), "MH", GUARD)?.code).toBe("GSTIN_NOT_ACTIVE");
  });
  it("lets every type supply within the state, and an unknown place of supply", () => {
    for (const t of ["REGULAR", "COMPOSITION", "ENROLMENT_ID", "UNREGISTERED", "PAN_ONLY_SERVICE"] as const) {
      expect(supplyBlock(sup(t), "MH", GUARD)).toBeNull();
      expect(supplyBlock(sup(t), null, GUARD)).toBeNull();
    }
  });
  it("blocks Enrolment-ID and composition suppliers inter-state", () => {
    expect(supplyBlock(sup("ENROLMENT_ID"), "KA", GUARD)?.code).toBe("INTER_STATE_NOT_ALLOWED");
    expect(supplyBlock(sup("UNREGISTERED"), "KA", GUARD)?.code).toBe("INTER_STATE_NOT_ALLOWED");
    expect(supplyBlock(sup("COMPOSITION"), "KA", GUARD)?.code).toBe("INTER_STATE_NOT_ALLOWED");
    expect(supplyBlock(sup("REGULAR"), "KA", GUARD)).toBeNull();
  });
  it("follows the switches when they allow inter-state", () => {
    const open = { enrolmentInterStateAllowed: true, compositionInterStateAllowed: true };
    expect(supplyBlock(sup("ENROLMENT_ID"), "KA", open)).toBeNull();
    expect(supplyBlock(sup("COMPOSITION"), "KA", open)).toBeNull();
  });
  it("PAN-only service providers are not blocked by the goods rule", () => {
    expect(supplyBlock(sup("PAN_ONLY_SERVICE"), "KA", GUARD)).toBeNull();
  });
});

describe("line tax", () => {
  it("intra-state 5%: CGST + SGST out of the inclusive price", () => {
    const l = lineTaxFor({ grossPaise: 10_500, rateBp: 500 }, "TAX_INVOICE", "INTRA");
    expect(l).toMatchObject({ taxablePaise: 10_000, cgstPaise: 250, sgstPaise: 250, igstPaise: 0, cessPaise: 0 });
  });
  it("inter-state 18%: IGST", () => {
    const l = lineTaxFor({ grossPaise: 11_800, rateBp: 1800 }, "TAX_INVOICE", "INTER");
    expect(l).toMatchObject({ taxablePaise: 10_000, cgstPaise: 0, sgstPaise: 0, igstPaise: 1_800 });
  });
  it("odd tax splits CGST down, SGST up", () => {
    const l = lineTaxFor({ grossPaise: 10_501, rateBp: 500 }, "TAX_INVOICE", "INTRA");
    expect(l.cgstPaise + l.sgstPaise + l.taxablePaise).toBe(10_501);
    expect(l.sgstPaise - l.cgstPaise).toBeGreaterThanOrEqual(0);
  });
  it("cess comes out of the price too", () => {
    const l = lineTaxFor({ grossPaise: 15_000, rateBp: 2800, cessBp: 2200 }, "TAX_INVOICE", "INTRA");
    expect(l.taxablePaise).toBe(10_000);
    expect(l.cessPaise).toBe(2_200);
    expect(l.cgstPaise + l.sgstPaise).toBe(2_800);
  });
  it("a bill of supply carries no tax", () => {
    expect(lineTaxFor({ grossPaise: 10_500, rateBp: 500, cessBp: 100 }, "BILL_OF_SUPPLY", "INTER")).toMatchObject({
      taxablePaise: 10_500,
      rateBp: 0,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      cessPaise: 0,
    });
  });
});

describe("whole bill (test scenarios 1–3)", () => {
  it("1a. intra-state B2C invoice: CGST + SGST", () => {
    const b = computeBill({ supplier: { registrationType: "REGULAR", stateCode: "MH" }, buyer: {}, placeOfSupply: "MH", lines: [{ grossPaise: 10_500, rateBp: 500 }, { grossPaise: 11_800, rateBp: 1800 }], guard: GUARD });
    expect(b).toMatchObject({ kind: "TAX_INVOICE", supply: "INTRA", b2b: false, block: null });
    expect(b.totals).toEqual({ grossPaise: 22_300, taxablePaise: 20_000, cgstPaise: 1_150, sgstPaise: 1_150, igstPaise: 0, cessPaise: 0 });
  });
  it("1b. inter-state B2B invoice: IGST with the buyer's GSTIN", () => {
    const b = computeBill({ supplier: { registrationType: "REGULAR", stateCode: "MH" }, buyer: { gstin: "29AAAPL1234C1ZV" }, placeOfSupply: "KA", lines: [{ grossPaise: 11_800, rateBp: 1800 }], guard: GUARD });
    expect(b).toMatchObject({ kind: "TAX_INVOICE", supply: "INTER", b2b: true, block: null });
    expect(b.totals.igstPaise).toBe(1_800);
  });
  it("2. composition shop: bill of supply, inter-state blocked", () => {
    const b = computeBill({ supplier: { registrationType: "COMPOSITION", stateCode: "MH" }, buyer: { gstin: "29AAAPL1234C1ZV" }, placeOfSupply: "KA", lines: [{ grossPaise: 10_500, rateBp: 500 }], guard: GUARD });
    expect(b.kind).toBe("BILL_OF_SUPPLY");
    expect(b.b2b).toBe(false);
    expect(b.block?.code).toBe("INTER_STATE_NOT_ALLOWED");
    expect(b.totals.taxablePaise).toBe(10_500);
  });
  it("3. Enrolment-ID shop: bill of supply, intra-state fine", () => {
    const b = computeBill({ supplier: { registrationType: "ENROLMENT_ID", stateCode: "MH" }, buyer: {}, placeOfSupply: "MH", lines: [{ grossPaise: 10_000, rateBp: 500 }], guard: GUARD });
    expect(b).toMatchObject({ kind: "BILL_OF_SUPPLY", block: null });
  });
});

describe("TCS s.52 (scenarios 3 and 6)", () => {
  it("0.5% of net taxable value, split 0.25 + 0.25 intra-state", () => {
    const d = tcsFor({ supplier: "REGULAR", collector: "PLATFORM", netTaxablePaise: 100_000, supply: "INTRA", rules: TCS });
    expect(d).toEqual({ applies: true, rateBp: 50, basePaise: 100_000, amountPaise: 500, cgstPaise: 250, sgstPaise: 250, igstPaise: 0 });
  });
  it("0.5% IGST inter-state", () => {
    const d = tcsFor({ supplier: "REGULAR", collector: "PLATFORM", netTaxablePaise: 100_000, supply: "INTER", rules: TCS });
    expect(d).toMatchObject({ applies: true, amountPaise: 500, igstPaise: 500, cgstPaise: 0 });
  });
  it("on the net after returns; never negative", () => {
    expect(tcsFor({ supplier: "REGULAR", collector: "PLATFORM", netTaxablePaise: 100_000 - 40_000, supply: "INTRA", rules: TCS })).toMatchObject({ amountPaise: 300 });
    expect(tcsFor({ supplier: "REGULAR", collector: "PLATFORM", netTaxablePaise: -5_000, supply: "INTRA", rules: TCS })).toMatchObject({ applies: true, amountPaise: 0 });
  });
  it("composition shops: TCS applies", () => {
    expect(tcsFor({ supplier: "COMPOSITION", collector: "PLATFORM", netTaxablePaise: 100_000, supply: "INTRA", rules: TCS }).applies).toBe(true);
  });
  it("Enrolment-ID / unregistered: none unless the switch says so", () => {
    expect(tcsFor({ supplier: "ENROLMENT_ID", collector: "PLATFORM", netTaxablePaise: 100_000, supply: "INTRA", rules: TCS })).toEqual({ applies: false, reason: "SUPPLIER_NOT_LIABLE" });
    expect(tcsFor({ supplier: "ENROLMENT_ID", collector: "PLATFORM", netTaxablePaise: 100_000, supply: "INTRA", rules: { ...TCS, tcsOnUnregistered: true } }).applies).toBe(true);
  });
  it("shop-collected cash: stricter default collects, the switch can stop it", () => {
    expect(tcsFor({ supplier: "REGULAR", collector: "SHOP", netTaxablePaise: 100_000, supply: "INTRA", rules: TCS }).applies).toBe(true);
    expect(tcsFor({ supplier: "REGULAR", collector: "SHOP", netTaxablePaise: 100_000, supply: "INTRA", rules: { ...TCS, applyWhenShopCollects: false } })).toEqual({ applies: false, reason: "SHOP_COLLECTED" });
  });
  it("no TCS when off, or when GoKesari is the deemed supplier", () => {
    expect(tcsFor({ supplier: "REGULAR", collector: "PLATFORM", netTaxablePaise: 100_000, supply: "INTRA", rules: { ...TCS, rateBp: null } })).toEqual({ applies: false, reason: "TCS_OFF" });
    expect(tcsFor({ supplier: "REGULAR", collector: "PLATFORM", netTaxablePaise: 100_000, supply: "INTRA", deemedSupplier: true, rules: TCS })).toEqual({ applies: false, reason: "DEEMED_SUPPLIER" });
  });
});

describe("TDS s.393 scope (scenario 7)", () => {
  const rules = { inForce: true, whenShopCollects: true, onUnregistered: true };
  it("in scope for registered and (by default) PAN-only suppliers", () => {
    expect(tdsApplies({ supplier: "REGULAR", collector: "PLATFORM", rules })).toBe(true);
    expect(tdsApplies({ supplier: "ENROLMENT_ID", collector: "PLATFORM", rules })).toBe(true);
    expect(tdsApplies({ supplier: "ENROLMENT_ID", collector: "PLATFORM", rules: { ...rules, onUnregistered: false } })).toBe(false);
    expect(tdsApplies({ supplier: "COMPOSITION", collector: "PLATFORM", rules: { ...rules, onUnregistered: false } })).toBe(true);
  });
  it("shop-collected and switched-off cases", () => {
    expect(tdsApplies({ supplier: "REGULAR", collector: "SHOP", rules })).toBe(true);
    expect(tdsApplies({ supplier: "REGULAR", collector: "SHOP", rules: { ...rules, whenShopCollects: false } })).toBe(false);
    expect(tdsApplies({ supplier: "REGULAR", collector: "PLATFORM", rules: { ...rules, inForce: false } })).toBe(false);
  });
});

describe("delivery fee s.9(5) (scenario 4)", () => {
  const rules = (rateBp: number | null) => ({ rateBp, shopDeliveryIsShopSupply: true });
  it("31 Oct 2026 rate 18%: GoKesari pays, inclusive split", () => {
    const d = deliveryFeeGst({ fulfilment: "GOKESARI_PARTNER", feePaise: 2_360, riderGstRegistered: false, supply: "INTRA", rules: rules(1800) });
    expect(d).toEqual({ liable: "GOKESARI_S95", rateBp: 1800, feePaise: 2_360, taxablePaise: 2_000, cgstPaise: 180, sgstPaise: 180, igstPaise: 0 });
  });
  it("1 Nov 2026 rate 5% without ITC", () => {
    const d = deliveryFeeGst({ fulfilment: "GOKESARI_PARTNER", feePaise: 2_100, riderGstRegistered: false, supply: "INTRA", rules: rules(500) });
    expect(d).toMatchObject({ liable: "GOKESARI_S95", rateBp: 500, taxablePaise: 2_000, cgstPaise: 50, sgstPaise: 50 });
  });
  it("a registered rider owes it, not GoKesari", () => {
    expect(deliveryFeeGst({ fulfilment: "GOKESARI_PARTNER", feePaise: 2_100, riderGstRegistered: true, supply: "INTRA", rules: rules(500) }).liable).toBe("RIDER");
  });
  it("shop's own delivery: the shop's supply (switch), pickup: no fee", () => {
    expect(deliveryFeeGst({ fulfilment: "SHOP_DELIVERY", feePaise: 2_100, riderGstRegistered: false, supply: "INTRA", rules: rules(500) }).liable).toBe("SHOP");
    expect(deliveryFeeGst({ fulfilment: "SHOP_DELIVERY", feePaise: 2_100, riderGstRegistered: false, supply: "INTRA", rules: { rateBp: 500, shopDeliveryIsShopSupply: false } }).liable).toBe("NONE");
    expect(deliveryFeeGst({ fulfilment: "PICKUP", feePaise: 2_100, riderGstRegistered: false, supply: "INTRA", rules: rules(500) }).liable).toBe("NONE");
    expect(deliveryFeeGst({ fulfilment: "GOKESARI_PARTNER", feePaise: 0, riderGstRegistered: false, supply: "INTRA", rules: rules(500) }).liable).toBe("NONE");
  });
  it("not enabled for the date: nothing", () => {
    expect(deliveryFeeGst({ fulfilment: "GOKESARI_PARTNER", feePaise: 2_100, riderGstRegistered: false, supply: "INTRA", rules: rules(null) }).liable).toBe("NONE");
  });
});

describe("registration type from existing shop records", () => {
  it("never treats an unverified GSTIN as registered", () => {
    expect(registrationTypeFromLegacy("REGISTERED", "27AAAPL1234C1ZV")).toBe("REGULAR");
    expect(registrationTypeFromLegacy("COMPOSITION", "27AAAPL1234C1ZV")).toBe("COMPOSITION");
    expect(registrationTypeFromLegacy("PENDING_VERIFICATION", "27AAAPL1234C1ZV")).toBe("UNREGISTERED");
    expect(registrationTypeFromLegacy("REGISTERED", null)).toBe("UNREGISTERED");
    expect(registrationTypeFromLegacy(null, null)).toBe("UNREGISTERED");
  });
  it("a recorded type wins; the default falls back to gst_status", () => {
    expect(effectiveRegistrationType({ gstRegistrationType: "ENROLMENT_ID", gstStatus: "REGISTERED", gstin: "27AAAPL1234C1ZV" })).toBe("ENROLMENT_ID");
    expect(effectiveRegistrationType({ gstRegistrationType: "UNREGISTERED", gstStatus: "REGISTERED", gstin: "27AAAPL1234C1ZV" })).toBe("REGULAR");
    expect(effectiveRegistrationType({ gstRegistrationType: "UNREGISTERED", gstStatus: "NOT_REGISTERED", gstin: null })).toBe("UNREGISTERED");
  });
});
