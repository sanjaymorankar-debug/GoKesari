/**
 * Tax engine (billing v2, docs/billing — build prompt §2.4, gaps G1/G2/G3/G5/G7).
 *
 * One pure module that answers, for a supply on GoKesari:
 *   - who received the customer's money (money-flow model, §5.1);
 *   - tax invoice or bill of supply, intra- or inter-state, B2B or B2C;
 *   - CGST / SGST / IGST / cess per line (tax-inclusive prices, as today);
 *   - whether the supplier may make this supply at all (Enrolment-ID and
 *     composition suppliers: intra-state only — §3.3);
 *   - whether GoKesari collects TCS (s.52) on it and how it splits;
 *   - who owes the GST on the delivery fee (s.9(5), §5.2).
 *
 * Nothing here reads the database or holds a rate: every rate and switch comes
 * in as input, looked up by the caller from the dated tables (statutory_rates,
 * hsn_tax_rates, gst_rules) and rules for the supply's own date. The line maths
 * is the invoice module's (splitInclusiveWithCess), so an invoice issued
 * through the engine is identical to one issued before it.
 */
import { splitInclusiveWithCess } from "@/server/services/invoices";

/* ------------------------------------------------------------- vocabulary */

/** How a shop is registered under GST (shops.gst_registration_type). */
export const GST_REGISTRATION_TYPES = ["REGULAR", "COMPOSITION", "ENROLMENT_ID", "PAN_ONLY_SERVICE", "UNREGISTERED"] as const;
export type GstRegistrationType = (typeof GST_REGISTRATION_TYPES)[number];

/** The GSTIN's state on the GST portal. Anything but ACTIVE pauses new orders. */
export type GstPortalStatus = "ACTIVE" | "CANCELLED" | "SUSPENDED";

/** How the customer paid, as the money-flow model names it (§5.1). */
export const MONEY_FLOW_MODES = ["ONLINE_PREPAID", "WALLET_PREPAID", "COD_PLATFORM_RIDER", "COD_SHOP", "PICKUP_PAID_AT_SHOP"] as const;
export type MoneyFlowMode = (typeof MONEY_FLOW_MODES)[number];

export type MoneyCollector = "PLATFORM" | "SHOP";

export type Fulfilment = "PICKUP" | "SHOP_DELIVERY" | "GOKESARI_PARTNER";

export type SupplyType = "INTRA" | "INTER";

/* --------------------------------------------------------- money flow §5.1 */

/**
 * The payment mode of an order from what it records: the payment method and
 * how it reached the customer (order_fulfilment_arrangements; no row = the
 * GoKesari partner dispatch, the default).
 */
export function moneyFlowMode(paymentMethod: "WALLET" | "ONLINE" | "COD", fulfilment: Fulfilment): MoneyFlowMode {
  if (paymentMethod === "ONLINE") return "ONLINE_PREPAID";
  if (paymentMethod === "WALLET") return "WALLET_PREPAID";
  if (fulfilment === "PICKUP") return "PICKUP_PAID_AT_SHOP";
  return fulfilment === "SHOP_DELIVERY" ? "COD_SHOP" : "COD_PLATFORM_RIDER";
}

/** Who received the money, by the admin's per-mode map (rule moneyFlow.collectorByMode). */
export function moneyCollector(mode: MoneyFlowMode, collectorByMode: Record<MoneyFlowMode, MoneyCollector>): MoneyCollector {
  return collectorByMode[mode];
}

/* ------------------------------------------------- document and supply type */

export interface Supplier {
  registrationType: GstRegistrationType;
  /** Two-letter state code (MH, KA, …) of the place the supplier is registered / located. */
  stateCode: string | null;
  portalStatus?: GstPortalStatus | null;
}

export interface Buyer {
  /** A verified GSTIN makes the supply B2B. */
  gstin?: string | null;
}

export type DocumentKind = "TAX_INVOICE" | "BILL_OF_SUPPLY";

/** Only a regular GST registration charges tax; everyone else issues a bill of supply. */
export function documentKind(registrationType: GstRegistrationType): DocumentKind {
  return registrationType === "REGULAR" ? "TAX_INVOICE" : "BILL_OF_SUPPLY";
}

/**
 * Intra-state when the supplier's state and the place of supply agree — or
 * when either is unknown (the invoice says it was assumed: place-of-supply.ts).
 */
export function supplyTypeOf(supplierState: string | null, placeOfSupply: string | null): SupplyType {
  return supplierState && placeOfSupply && supplierState !== placeOfSupply ? "INTER" : "INTRA";
}

const GSTIN_RE = /^\d{2}[A-Z0-9]{13}$/;

export function isB2b(buyer: Buyer): boolean {
  return Boolean(buyer.gstin && GSTIN_RE.test(buyer.gstin));
}

/* ---------------------------------------------------------- order guard §3 */

export type SupplyBlock =
  | { code: "GSTIN_NOT_ACTIVE"; message: string }
  | { code: "INTER_STATE_NOT_ALLOWED"; message: string };

export interface SupplyGuardRules {
  /** Statutory UNREGISTERED_SELLER_RULES.interStateAllowed (Notification 34/2023: no). */
  enrolmentInterStateAllowed: boolean;
  /** Composition suppliers of goods may not make inter-state supplies (s.10(2)(c)). */
  compositionInterStateAllowed: boolean;
}

/**
 * Can this supplier take an order delivered to `placeOfSupply`? Null when it
 * can; otherwise the reason, worded for the customer at checkout. An unknown
 * place of supply is never blocked (it is treated as intra-state).
 */
export function supplyBlock(supplier: Supplier, placeOfSupply: string | null, rules: SupplyGuardRules): SupplyBlock | null {
  if (supplier.portalStatus && supplier.portalStatus !== "ACTIVE") {
    return { code: "GSTIN_NOT_ACTIVE", message: "This shop cannot take new orders right now. Please try another shop." };
  }
  if (supplyTypeOf(supplier.stateCode, placeOfSupply) === "INTRA") return null;
  const t = supplier.registrationType;
  const blocked =
    ((t === "ENROLMENT_ID" || t === "UNREGISTERED") && !rules.enrolmentInterStateAllowed) ||
    (t === "COMPOSITION" && !rules.compositionInterStateAllowed);
  return blocked
    ? { code: "INTER_STATE_NOT_ALLOWED", message: "This shop can deliver only within its own state. Choose a delivery address in the same state, or another shop." }
    : null;
}

/* --------------------------------------------------------------- lines §2.4 */

export interface LineInput {
  /** Tax-inclusive line amount the customer pays. */
  grossPaise: number;
  /** GST rate in basis points (1800 = 18%), for the supply's date. */
  rateBp: number;
  cessBp?: number;
}

export interface LineTax {
  grossPaise: number;
  rateBp: number;
  cessBp: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
}

/** A line's tax: none on a bill of supply (the whole amount is the value). */
export function lineTaxFor(line: LineInput, kind: DocumentKind, supply: SupplyType): LineTax {
  if (kind === "BILL_OF_SUPPLY") {
    return { grossPaise: line.grossPaise, rateBp: 0, cessBp: 0, taxablePaise: line.grossPaise, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0 };
  }
  const cessBp = line.cessBp ?? 0;
  const split = splitInclusiveWithCess(line.grossPaise, line.rateBp, cessBp, supply);
  return { grossPaise: line.grossPaise, rateBp: line.rateBp, cessBp, ...split };
}

/* ------------------------------------------------------------------ TCS §5.4 */

export interface TcsRules {
  /** statutory GST_TCS_SEC52 rate in force on the supply's date; null = TCS off. */
  rateBp: number | null;
  /** CA question 1: does GoKesari "collect consideration" when the shop took the cash? Stricter default: true. */
  applyWhenShopCollects: boolean;
  /** statutory UNREGISTERED_SELLER_RULES.tcsOnUnregistered (Enrolment-ID suppliers: no). */
  tcsOnUnregistered: boolean;
}

export type TcsDecision =
  | { applies: true; rateBp: number; basePaise: number; amountPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }
  | { applies: false; reason: "TCS_OFF" | "SUPPLIER_NOT_LIABLE" | "SHOP_COLLECTED" | "DEEMED_SUPPLIER" };

/**
 * TCS under s.52 on one supply's net taxable value (taxable value less
 * returns, computed by the caller). Regular and composition suppliers: yes.
 * Enrolment-ID / unregistered / PAN-only: by the statutory switch (default
 * no). Where GoKesari itself is the deemed supplier (s.9(5) restaurant
 * service) there is nothing to collect from the restaurant.
 */
export function tcsFor(input: {
  supplier: GstRegistrationType;
  collector: MoneyCollector;
  netTaxablePaise: number;
  supply: SupplyType;
  deemedSupplier?: boolean;
  rules: TcsRules;
}): TcsDecision {
  if (input.deemedSupplier) return { applies: false, reason: "DEEMED_SUPPLIER" };
  if (input.rules.rateBp == null || input.rules.rateBp <= 0) return { applies: false, reason: "TCS_OFF" };
  const registered = input.supplier === "REGULAR" || input.supplier === "COMPOSITION";
  if (!registered && !input.rules.tcsOnUnregistered) return { applies: false, reason: "SUPPLIER_NOT_LIABLE" };
  if (input.collector === "SHOP" && !input.rules.applyWhenShopCollects) return { applies: false, reason: "SHOP_COLLECTED" };
  const base = Math.max(0, input.netTaxablePaise);
  const amount = Math.round((base * input.rules.rateBp) / 10_000);
  if (input.supply === "INTER") return { applies: true, rateBp: input.rules.rateBp, basePaise: base, amountPaise: amount, cgstPaise: 0, sgstPaise: 0, igstPaise: amount };
  const cgst = Math.floor(amount / 2);
  return { applies: true, rateBp: input.rules.rateBp, basePaise: base, amountPaise: amount, cgstPaise: cgst, sgstPaise: amount - cgst, igstPaise: 0 };
}

/* ------------------------------------------------------------------ TDS §5.5 */

/**
 * Does GoKesari deduct income-tax TDS (s.393(1), ex-194O) on this supply? The
 * rate, the no-PAN rate and the individual/HUF ₹5 lakh exemption are applied
 * where the deduction is made (payouts/cycle.ts); this only decides whether
 * the supply is in scope.
 */
export function tdsApplies(input: {
  supplier: GstRegistrationType;
  collector: MoneyCollector;
  rules: { inForce: boolean; whenShopCollects: boolean; onUnregistered: boolean };
}): boolean {
  if (!input.rules.inForce) return false;
  if (input.collector === "SHOP" && !input.rules.whenShopCollects) return false;
  const registered = input.supplier === "REGULAR" || input.supplier === "COMPOSITION";
  return registered || input.rules.onUnregistered;
}

/* --------------------------------------------------- delivery fee s.9(5) §5.2 */

export interface DeliveryGstRules {
  /** statutory GST_S95_LOCAL_DELIVERY rate in force at the time of supply; null = not enabled. */
  rateBp: number | null;
  /** CA question 3: a shop's own delivery person booked through GoKesari — whose supply? Default: the shop's. */
  shopDeliveryIsShopSupply: boolean;
}

export type DeliveryGstDecision =
  | { liable: "GOKESARI_S95"; rateBp: number; feePaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }
  | { liable: "RIDER" | "SHOP" | "NONE"; reason: string };

/**
 * GST on the customer's delivery fee. A GoKesari delivery partner who is not
 * GST-registered supplies through the ECO, so GoKesari pays under s.9(5) at
 * the rate for the time of supply (18% to 31 Oct 2026, 5% without ITC from
 * 1 Nov 2026 — dated rows, never code) and invoices the customer in its own
 * GSTIN. A registered partner is liable themselves; the shop's own delivery
 * is on the shop's invoice; a pickup has no fee.
 */
export function deliveryFeeGst(input: {
  fulfilment: Fulfilment;
  feePaise: number;
  riderGstRegistered: boolean;
  supply: SupplyType;
  rules: DeliveryGstRules;
}): DeliveryGstDecision {
  if (input.fulfilment === "PICKUP" || input.feePaise <= 0) return { liable: "NONE", reason: "No delivery fee." };
  if (input.fulfilment === "SHOP_DELIVERY") {
    return input.rules.shopDeliveryIsShopSupply
      ? { liable: "SHOP", reason: "The shop's own delivery: part of the shop's supply, on its invoice." }
      : { liable: "NONE", reason: "Shop delivery treated as outside s.9(5) and not billed by GoKesari (switch off)." };
  }
  if (input.riderGstRegistered) return { liable: "RIDER", reason: "The delivery partner is GST-registered and pays the GST." };
  if (input.rules.rateBp == null) return { liable: "NONE", reason: "s.9(5) delivery GST is not enabled for this date." };
  const split = splitInclusiveWithCess(input.feePaise, input.rules.rateBp, 0, input.supply);
  return {
    liable: "GOKESARI_S95",
    rateBp: input.rules.rateBp,
    feePaise: input.feePaise,
    taxablePaise: split.taxablePaise,
    cgstPaise: split.cgstPaise,
    sgstPaise: split.sgstPaise,
    igstPaise: split.igstPaise,
  };
}

/* -------------------------------------------------------------- whole bill */

export interface BillInput {
  supplier: Supplier;
  buyer: Buyer;
  placeOfSupply: string | null;
  lines: LineInput[];
  guard: SupplyGuardRules;
}

export interface Bill {
  kind: DocumentKind;
  supply: SupplyType;
  b2b: boolean;
  block: SupplyBlock | null;
  lines: LineTax[];
  totals: { grossPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number };
}

/** The supplier's document for a set of lines. */
export function computeBill(input: BillInput): Bill {
  const kind = documentKind(input.supplier.registrationType);
  const supply = supplyTypeOf(input.supplier.stateCode, input.placeOfSupply);
  const lines = input.lines.map((l) => lineTaxFor(l, kind, supply));
  const sum = (k: keyof Bill["totals"]) => lines.reduce((s, l) => s + l[k], 0);
  return {
    kind,
    supply,
    b2b: kind === "TAX_INVOICE" && isB2b(input.buyer),
    block: supplyBlock(input.supplier, input.placeOfSupply, input.guard),
    lines,
    totals: {
      grossPaise: sum("grossPaise"),
      taxablePaise: sum("taxablePaise"),
      cgstPaise: sum("cgstPaise"),
      sgstPaise: sum("sgstPaise"),
      igstPaise: sum("igstPaise"),
      cessPaise: sum("cessPaise"),
    },
  };
}

/* ------------------------------------------ registration type from old data */

/**
 * The registration type of a shop that has not been through the new GST
 * status step, from what the shop record already says (migration 0125 does
 * the same in SQL). A GSTIN without a verified status stays UNREGISTERED: it
 * is never silently treated as registered (schema.ts gstStatusEnum).
 */
export function registrationTypeFromLegacy(gstStatus: string | null | undefined, gstin: string | null | undefined): GstRegistrationType {
  if (gstStatus === "COMPOSITION") return "COMPOSITION";
  if (gstStatus === "REGISTERED" && gstin && GSTIN_RE.test(gstin)) return "REGULAR";
  return "UNREGISTERED";
}

/**
 * The type the engine uses: what the GST status step recorded, or — while the
 * column still holds its default — what gst_status says today, so a GSTIN
 * verified after migration 0125 (gst-pan-verification.ts sets gst_status)
 * counts at once.
 */
export function effectiveRegistrationType(shop: {
  gstRegistrationType: GstRegistrationType;
  gstStatus: string | null | undefined;
  gstin: string | null | undefined;
}): GstRegistrationType {
  return shop.gstRegistrationType !== "UNREGISTERED" ? shop.gstRegistrationType : registrationTypeFromLegacy(shop.gstStatus, shop.gstin);
}
