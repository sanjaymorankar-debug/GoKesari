/**
 * Mock GSP (Module 2): sandbox-shaped answers, no network. Used by tests,
 * local development and test.gokesari.com until a licensed GSP is chosen.
 *
 *   GSTIN  valid check digit → found, "Active"; PAN digits 9999 → "Cancelled";
 *          an invalid check digit → not found.
 *   IRN    sha256(seller GSTIN + FY + doc type + doc number), as the IRP
 *          computes it — the same document always gets the same IRN; asking
 *          twice answers DUPLICATE, as the IRP does.
 *   EWB    12 digits from the request; valid one day per 200 km (min 1).
 */
import { createHash } from "node:crypto";

import { gstState, isValidGstin } from "@/lib/gst-states";
import { GspError, type EwayBillRequest, type GspProvider, type IrnRequest, type IrnResult } from "./types";

const issued = new Map<string, IrnResult>();
const cancelledIrns = new Set<string>();

function fyOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function irnFor(sellerGstin: string, docType: string, number: string, date: string): string {
  return createHash("sha256").update(`${sellerGstin}${fyOf(date)}${docType}${number}`).digest("hex");
}

export function createMockGsp(): GspProvider {
  return {
    name: "mock",

    async validateGstin(raw) {
      const gstin = raw.trim().toUpperCase();
      if (!isValidGstin(gstin)) {
        return { gstin, found: false, legalName: null, tradeName: null, status: null, stateCode: null, taxpayerType: null, registrationDate: null, address: null };
      }
      const state = gstState(gstin);
      const cancelled = gstin.slice(7, 11) === "9999";
      return {
        gstin,
        found: true,
        legalName: `MOCK TRADERS ${gstin.slice(2, 7)}`,
        tradeName: `Mock Store ${gstin.slice(7, 11)}`,
        status: cancelled ? "Cancelled" : "Active",
        stateCode: state?.code ?? gstin.slice(0, 2),
        taxpayerType: gstin[12] === "2" ? "Composition" : "Regular",
        registrationDate: "2019-07-01",
        address: `1 Mock Road, ${state?.name ?? "India"}`,
        raw: { source: "mock" },
      };
    },

    async generateIrn({ invoice }: IrnRequest) {
      if (!invoice.seller.gstin || !isValidGstin(invoice.seller.gstin)) throw new GspError("INVALID", "Seller GSTIN is invalid.", "2150");
      if (!invoice.buyer.gstin) throw new GspError("INVALID", "E-invoice needs the buyer's GSTIN (B2B).", "2163");
      if (invoice.number.length > 16) throw new GspError("INVALID", "Document number longer than 16 characters.", "2211");
      const irn = irnFor(invoice.seller.gstin, "INV", invoice.number, invoice.date);
      if (issued.has(irn)) throw new GspError("DUPLICATE", "Duplicate IRN.", "2150");
      const result: IrnResult = {
        irn,
        ackNo: String(BigInt(`0x${irn.slice(0, 12)}`) % BigInt("1000000000000000")).padStart(15, "1"),
        ackDate: new Date().toISOString(),
        signedInvoice: Buffer.from(JSON.stringify({ mock: true, irn, docNo: invoice.number })).toString("base64"),
        signedQr: Buffer.from(JSON.stringify({ SellerGstin: invoice.seller.gstin, BuyerGstin: invoice.buyer.gstin, DocNo: invoice.number, DocDt: invoice.date, TotInvVal: invoice.totals.totalPaise / 100, Irn: irn, mock: true })).toString("base64"),
      };
      issued.set(irn, result);
      return result;
    },

    async irnByDocument(sellerGstin, docType, docNumber, docDate) {
      return issued.get(irnFor(sellerGstin, docType, docNumber, docDate)) ?? null;
    },

    async cancelIrn(irn) {
      if (!issued.has(irn)) throw new GspError("INVALID", "IRN not found.", "2270");
      if (cancelledIrns.has(irn)) throw new GspError("INVALID", "IRN already cancelled.", "9999");
      cancelledIrns.add(irn);
      return { cancelledAt: new Date().toISOString() };
    },

    async generateEwayBill({ requestId, distanceKm }: EwayBillRequest) {
      if (!(distanceKm > 0 && distanceKm <= 4000)) throw new GspError("INVALID", "Distance must be between 1 and 4000 km.", "702");
      const digits = (BigInt(`0x${createHash("sha256").update(requestId).digest("hex").slice(0, 14)}`) % BigInt("1000000000000")).toString().padStart(12, "1");
      const days = Math.max(1, Math.ceil(distanceKm / 200));
      const validUpto = new Date();
      validUpto.setUTCDate(validUpto.getUTCDate() + days);
      validUpto.setUTCHours(18, 29, 0, 0); // 23:59 IST
      return { ewbNo: digits, validUpto: validUpto.toISOString() };
    },

    async cancelEwayBill() {
      return { cancelledAt: new Date().toISOString() };
    },
  };
}

/** Tests: forget IRNs issued by the mock. */
export function resetMockGsp(): void {
  issued.clear();
  cancelledIrns.clear();
}
