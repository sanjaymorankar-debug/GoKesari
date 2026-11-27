/**
 * Pico Xpress order manifestation body (doc page 4) — built and checked locally first, so the shop owner gets a
 * clear message instead of a partner error (docs/pico-xpress-2026-11). Pure: no database, no network.
 *
 * Amounts are integer paise. orderCollectionDetails follows Pico's strict rule: 0 collectible = PREPAID,
 * more than 0 = COD. Above the e-way bill threshold (₹50,000) the Part-A e-way bill number is required.
 */

export const PICKUP_TYPES = ["RETAIL_STORE", "DARK_STORE", "WAREHOUSE", "MALL_STORE"] as const;
export type PickupType = (typeof PICKUP_TYPES)[number];

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const EWAY_BILL_RE = /^\d{12}$/;

export interface ManifestParty {
  personName: string;
  unitName: string;
  phone: string | null;
  gstin: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3?: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  lat: number | null;
  lng: number | null;
}

export interface ManifestItem {
  title: string;
  hsnCode: string | null;
  /** Quantity in thousandths (order_items.quantity_milli). */
  quantityMilli: number;
  /** The line's value before tax and its tax, in paise. */
  taxablePaise: number;
  taxPaise: number;
  /** GST rate in basis points (1800 = 18 %). */
  gstRateBp: number | null;
}

export interface ManifestInput {
  picoOrderId: string;
  awbNumber: string;
  childAwbs: string[];
  pickupType: PickupType;
  pickupOtp: string;
  consigneeOtp: string;
  returnOtp?: string | null;
  pickupSlaMs?: number | null;
  source: ManifestParty;
  destination: ManifestParty;
  billTo: ManifestParty;
  numBoxes: number;
  deadWeightGrams: number;
  items: ManifestItem[];
  invoiceIds: string[];
  ewayBillNo: string | null;
  ewayBillThresholdPaise: number;
  /** Cash to collect from the customer; 0 when paid online / wallet. */
  collectiblePaise: number;
  notes: string | null;
}

export interface ManifestProblem {
  field: string;
  message: string;
}

/** "+91 98765-43210", "098765 43210" → "9876543210"; null when it is not a 10-digit Indian number. */
export function tenDigitPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^\d{10}$/.test(d) ? d : null;
}

const clean = (s: string | null | undefined, max: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Pico's integer unit quantity and unit price for a line (loose goods: one unit at the line price). */
export function unitsFor(item: ManifestItem): { unitQty: number; unitPricePaise: number; title: string } {
  const lineTotal = item.taxablePaise + item.taxPaise;
  const whole = item.quantityMilli > 0 && item.quantityMilli % 1000 === 0;
  if (whole) {
    const qty = item.quantityMilli / 1000;
    return { unitQty: qty, unitPricePaise: Math.round(lineTotal / qty), title: clean(item.title, 120) };
  }
  const qtyText = (item.quantityMilli / 1000).toLocaleString("en-IN", { maximumFractionDigits: 3 });
  return { unitQty: 1, unitPricePaise: lineTotal, title: clean(`${item.title} (${qtyText})`, 120) };
}

export function goodsTotals(items: ManifestItem[]): { goodsAmountPaise: number; goodsTaxAmountPaise: number; totalGoodsAmountPaise: number } {
  const goodsAmountPaise = items.reduce((s, i) => s + Math.max(0, Math.round(i.taxablePaise)), 0);
  const goodsTaxAmountPaise = items.reduce((s, i) => s + Math.max(0, Math.round(i.taxPaise)), 0);
  return { goodsAmountPaise, goodsTaxAmountPaise, totalGoodsAmountPaise: goodsAmountPaise + goodsTaxAmountPaise };
}

/** Whether the e-way bill number must be given for this value. */
export function needsEwayBill(totalGoodsAmountPaise: number, thresholdPaise: number): boolean {
  return totalGoodsAmountPaise > thresholdPaise;
}

function checkParty(prefix: string, p: ManifestParty, opts: { gstinRequired: boolean; coordsRequired: boolean }, out: ManifestProblem[]) {
  if (clean(p.personName, 80).length < 2) out.push({ field: `${prefix}.name`, message: "a contact name is needed" });
  if (clean(p.unitName, 120).length < 2) out.push({ field: `${prefix}.unitName`, message: "a name is needed" });
  if (!tenDigitPhone(p.phone)) out.push({ field: `${prefix}.phone`, message: "a 10-digit mobile number is needed" });
  if (opts.gstinRequired && !(p.gstin && GSTIN_RE.test(p.gstin))) out.push({ field: `${prefix}.gstin`, message: "a valid 15-character GSTIN is needed" });
  if (!opts.gstinRequired && p.gstin && !GSTIN_RE.test(p.gstin)) out.push({ field: `${prefix}.gstin`, message: "the GSTIN is not valid" });
  if (clean(p.addressLine1, 120).length < 3) out.push({ field: `${prefix}.addressLine1`, message: "the address is missing" });
  if (clean(p.addressLine2, 120).length < 2) out.push({ field: `${prefix}.addressLine2`, message: "the second address line (area) is missing" });
  if (clean(p.city, 60).length < 2) out.push({ field: `${prefix}.city`, message: "the city is missing" });
  if (clean(p.state, 60).length < 2) out.push({ field: `${prefix}.state`, message: "the state is missing" });
  if (!p.pincode || !/^\d{6}$/.test(p.pincode)) out.push({ field: `${prefix}.pincode`, message: "a 6-digit PIN code is needed" });
  if (opts.coordsRequired && (p.lat == null || p.lng == null || !Number.isFinite(p.lat) || !Number.isFinite(p.lng))) {
    out.push({ field: `${prefix}.location`, message: "the map location (pin) is missing" });
  }
}

/** Every reason the manifest cannot be sent, in plain words; empty when it is fine. */
export function validateManifest(input: ManifestInput): ManifestProblem[] {
  const out: ManifestProblem[] = [];
  if (!/^[A-Za-z0-9_-]{3,60}$/.test(input.picoOrderId)) out.push({ field: "orderId", message: "the order number is not valid" });
  if (!/^[A-Za-z0-9-]{4,40}$/.test(input.awbNumber)) out.push({ field: "awbNumber", message: "no tracking number (AWB) was allocated" });
  if (!/^\d{6}$/.test(input.pickupOtp) || !/^\d{6}$/.test(input.consigneeOtp)) out.push({ field: "otp", message: "the pickup and delivery codes must be 6 digits" });
  if (input.returnOtp != null && !/^\d{6}$/.test(input.returnOtp)) out.push({ field: "returnOtp", message: "the return code must be 6 digits" });
  checkParty("shop", input.source, { gstinRequired: true, coordsRequired: true }, out);
  checkParty("customer", input.destination, { gstinRequired: false, coordsRequired: true }, out);
  checkParty("billTo", input.billTo, { gstinRequired: true, coordsRequired: false }, out);
  if (!Number.isInteger(input.numBoxes) || input.numBoxes < 1) out.push({ field: "numBoxes", message: "at least one box is needed" });
  if (input.childAwbs.length !== Math.max(0, input.numBoxes - 1)) out.push({ field: "boxList", message: "each extra box needs its own tracking number" });
  if (!Number.isInteger(input.deadWeightGrams) || input.deadWeightGrams <= 0) out.push({ field: "deadWeightGrams", message: "the parcel weight is missing" });
  if (input.items.length === 0) out.push({ field: "goodsDetailsList", message: "the order has no items" });
  input.items.forEach((item, i) => {
    const u = unitsFor(item);
    if (!u.title) out.push({ field: `goodsDetailsList[${i}].itemTitle`, message: "an item has no name" });
    if (!(u.unitQty > 0)) out.push({ field: `goodsDetailsList[${i}].unitQty`, message: `"${u.title}" has no quantity` });
    if (!(u.unitPricePaise > 0)) out.push({ field: `goodsDetailsList[${i}].unitPricePaise`, message: `"${u.title}" has no final price — weigh loose goods and set the price before booking` });
  });
  const totals = goodsTotals(input.items);
  if (!(totals.goodsAmountPaise > 0)) out.push({ field: "goodsAmountPaise", message: "the goods value must be more than zero" });
  if (!(totals.goodsTaxAmountPaise > 0)) out.push({ field: "goodsTaxAmountPaise", message: "the goods tax must be more than zero (the delivery partner requires it)" });
  if (input.invoiceIds.length === 0) out.push({ field: "invoiceIds", message: "the order has no invoice number" });
  if (needsEwayBill(totals.totalGoodsAmountPaise, input.ewayBillThresholdPaise) && !(input.ewayBillNo && EWAY_BILL_RE.test(input.ewayBillNo))) {
    out.push({ field: "ewayBillNo", message: "goods worth more than ₹50,000 need the 12-digit Part-A e-way bill number" });
  }
  if (input.ewayBillNo && !EWAY_BILL_RE.test(input.ewayBillNo)) out.push({ field: "ewayBillNo", message: "the e-way bill number must be 12 digits" });
  if (!Number.isInteger(input.collectiblePaise) || input.collectiblePaise < 0) out.push({ field: "collectibleAmountPaise", message: "the amount to collect is not valid" });
  return out;
}

function party(p: ManifestParty, withCoords: boolean) {
  return {
    representativePersonName: clean(p.personName, 80),
    unitName: clean(p.unitName, 120),
    contactNumPrimary: tenDigitPhone(p.phone) ?? "",
    contactNumSecondary: "",
    gstNumber: p.gstin ?? "",
    address: {
      addressLine1: clean(p.addressLine1, 120),
      addressLine2: clean(p.addressLine2, 120),
      addressLine3: clean(p.addressLine3, 120),
      city: clean(p.city, 60),
      state: clean(p.state, 60),
      pincode: p.pincode ?? "",
      latitude: withCoords ? p.lat : (p.lat ?? null),
      longitude: withCoords ? p.lng : (p.lng ?? null),
    },
  };
}

/** The JSON body for POST /integ/order/create/qc. Call validateManifest first. */
export function buildManifest(input: ManifestInput): Record<string, unknown> {
  const totals = goodsTotals(input.items);
  const boxes = input.numBoxes;
  const perBox = Math.max(1, Math.round(input.deadWeightGrams / boxes));
  const awbs = [input.awbNumber, ...input.childAwbs];
  const prepaid = input.collectiblePaise === 0;
  return {
    orderId: input.picoOrderId,
    awbNumber: input.awbNumber,
    orderType: "FORWARD",
    orderParty: "CONSIGNER",
    pickupType: input.pickupType,
    ...(input.pickupSlaMs ? { pickupSla: input.pickupSlaMs } : {}),
    pickupOtp: input.pickupOtp,
    consigneeOtp: input.consigneeOtp,
    ...(input.returnOtp ? { returnOtp: input.returnOtp } : {}),
    sourceLocationDetails: party(input.source, true),
    destinationLocationDetails: party(input.destination, true),
    billToLocationDetails: party(input.billTo, false),
    returnLocationDetails: null,
    boxDetails: {
      numOfBoxes: boxes,
      deadWeightGrams: input.deadWeightGrams,
      boxList: awbs.slice(0, boxes).map((awb, i) => ({
        packageId: `${input.picoOrderId}-B${i + 1}`,
        awbNumber: awb,
        weight: i === 0 ? input.deadWeightGrams - perBox * (boxes - 1) : perBox,
        packageData: `Box ${i + 1} of ${boxes}`,
        weightUnit: "GRAM",
        dimensionUnit: "CM",
      })),
    },
    goodsDetails: {
      ...totals,
      goodsDetailsList: input.items.map((item) => {
        const u = unitsFor(item);
        return {
          itemTitle: u.title,
          ...(item.hsnCode ? { hsnCode: item.hsnCode.replace(/\D/g, "").slice(0, 8) } : {}),
          unitPricePaise: u.unitPricePaise,
          unitQty: u.unitQty,
          ...(item.gstRateBp != null ? { taxPercentage: item.gstRateBp / 100 } : {}),
        };
      }),
    },
    invoiceDetails: {
      invoiceIds: input.invoiceIds.map((invoiceId) => ({ invoiceId, ...(input.ewayBillNo ? { ewayBillNo: input.ewayBillNo } : {}) })),
    },
    orderCollectionDetails: {
      collectibleAmountPaise: prepaid ? 0 : input.collectiblePaise,
      serviceType: prepaid ? "PREPAID" : "COD",
    },
    orderNotes: clean(input.notes, 250),
  };
}
