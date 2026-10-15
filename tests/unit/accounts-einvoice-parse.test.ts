/**
 * E-invoice reading (Module 2, purchase entry): the NIC IRP JSON (schema
 * v1.1) in each wrapper a supplier may share, and the signed QR code — its
 * decoding (base64url without padding) and its RS256 signature check.
 */
import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decodeSignedQr, parseEinvoiceJson, verifySignedQr } from "@/lib/einvoice/parse";

const SELLER = "27AABCA1111B1Z1";
const BUYER = "27AAACK1234F1Z5";
const IRN = "8b7c1f0e5a9d3c2b4a6e8f0d1c3b5a7e9f1d3c5b7a9e1f3d5c7b9a1e3f5d7c9b";

const invoice = {
  Version: "1.1",
  TranDtls: { TaxSch: "GST", SupTyp: "B2B", RegRev: "N", EcmGstin: null, IgstOnIntra: "N" },
  DocDtls: { Typ: "INV", No: "AD/2026/0451", Dt: "05/09/2026" },
  SellerDtls: { Gstin: SELLER, LglNm: "Amul Distributors Pvt Ltd", TrdNm: "Amul Distributors", Addr1: "Plot 4, MIDC", Addr2: "Bhosari", Loc: "Pune", Pin: 411026, Stcd: "27", Ph: "9000000000", Em: "a@example.com" },
  BuyerDtls: { Gstin: BUYER, LglNm: "Kesari Dairy", TrdNm: "Kesari Dairy", Pos: "27", Addr1: "Shop 2, FC Road", Loc: "Pune", Pin: 411004, Stcd: "27" },
  ItemList: [
    {
      SlNo: "1",
      PrdDesc: "Amul Butter 500g",
      IsServc: "N",
      HsnCd: "04051000",
      Barcde: "8901262010023",
      Qty: 10,
      FreeQty: 0,
      Unit: "PCS",
      UnitPrice: 250.5,
      TotAmt: 2505,
      Discount: 5,
      PreTaxVal: 0,
      AssAmt: 2500,
      GstRt: 12,
      IgstAmt: 0,
      CgstAmt: 150,
      SgstAmt: 150,
      CesRt: 0,
      CesAmt: 0,
      CesNonAdvlAmt: 0,
      StateCesRt: 0,
      StateCesAmt: 0,
      StateCesNonAdvlAmt: 0,
      OthChrg: 0,
      TotItemVal: 2800,
    },
    {
      SlNo: "2",
      PrdDesc: "Amul Kool 200ml",
      IsServc: "N",
      HsnCd: "04029990",
      Qty: 24,
      Unit: "BTL",
      UnitPrice: 20.83,
      TotAmt: 499.92,
      Discount: 0,
      AssAmt: 499.92,
      GstRt: 12,
      IgstAmt: 0,
      CgstAmt: 30,
      SgstAmt: 30,
      CesAmt: 0,
      TotItemVal: 559.92,
    },
  ],
  ValDtls: { AssVal: 2999.92, CgstVal: 180, SgstVal: 180, IgstVal: 0, CesVal: 0, StCesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: 0.08, TotInvVal: 3360 },
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function jwt(payload: object, alg = "RS256"): string {
  const input = `${b64url(JSON.stringify({ alg, kid: "IRP-TEST", typ: "JWT", x5t: "abc" }))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(input).sign(privateKey);
  return `${input}.${b64url(signature)}`;
}

const qrData = {
  SellerGstin: SELLER,
  BuyerGstin: BUYER,
  DocNo: "AD/2026/0451",
  DocTyp: "INV",
  DocDt: "05/09/2026",
  TotInvVal: 3360,
  ItemCnt: 2,
  MainHsnCode: "04051000",
  Irn: IRN,
  IrnDt: "2026-09-05 11:20:00",
};
const signedQr = jwt({ data: JSON.stringify(qrData), iss: "NIC" });

describe("parseEinvoiceJson", () => {
  it("reads a v1.1 invoice into paise, basis points and ISO dates", () => {
    const e = parseEinvoiceJson(JSON.stringify(invoice));
    expect(e).toMatchObject({ irn: null, ackNo: null, docType: "INV", invoiceNo: "AD/2026/0451", invoiceDate: "2026-09-05" });
    expect(e.supplier).toEqual({ gstin: SELLER, legalName: "Amul Distributors Pvt Ltd", tradeName: "Amul Distributors", stateCode: "27", address: "Plot 4, MIDC, Bhosari, Pune, 411026" });
    expect(e.buyer).toEqual({ gstin: BUYER, legalName: "Kesari Dairy", stateCode: "27", placeOfSupply: "27" });
    expect(e.lines).toHaveLength(2);
    expect(e.lines[0]).toEqual({
      slNo: 1,
      description: "Amul Butter 500g",
      hsn: "04051000",
      barcode: "8901262010023",
      qty: 10,
      unit: "PCS",
      unitPricePaise: 25050,
      discountPaise: 500,
      taxablePaise: 250000,
      gstRateBp: 1200,
      igstPaise: 0,
      cgstPaise: 15000,
      sgstPaise: 15000,
      cessPaise: 0,
      totalPaise: 280000,
    });
    expect(e.lines[1]).toMatchObject({ barcode: null, unitPricePaise: 2083, taxablePaise: 49992, totalPaise: 55992 });
    expect(e.totals).toEqual({ taxablePaise: 299992, igstPaise: 0, cgstPaise: 18000, sgstPaise: 18000, cessPaise: 0, discountPaise: 0, otherChargesPaise: 0, roundOffPaise: 8, totalPaise: 336000 });
  });

  it("reads the IRP response by decoding SignedInvoice", () => {
    const response = {
      AckNo: 112610012345678,
      AckDt: "2026-09-05 11:20:00",
      Irn: IRN,
      SignedInvoice: jwt({ data: JSON.stringify({ ...invoice, AckNo: 112610012345678, Irn: IRN }), iss: "NIC" }),
      SignedQRCode: signedQr,
      Status: "ACT",
      EwbNo: null,
    };
    const e = parseEinvoiceJson(JSON.stringify(response));
    expect(e.irn).toBe(IRN);
    expect(e.ackNo).toBe("112610012345678");
    expect(e.ackDate).toBe("2026-09-05 11:20:00");
    expect(e.totals.totalPaise).toBe(336000);
    // Wrapped again in {"data": …} and in an array of one.
    expect(parseEinvoiceJson(JSON.stringify({ data: response })).irn).toBe(IRN);
    expect(parseEinvoiceJson(JSON.stringify([{ data: invoice }])).invoiceNo).toBe("AD/2026/0451");
    expect(parseEinvoiceJson(JSON.stringify({ Status: 1, Data: JSON.stringify(response) })).ackNo).toBe("112610012345678");
  });

  it("reads credit notes, unregistered buyers and missing ValDtls", () => {
    const note = {
      ...invoice,
      DocDtls: { Typ: "CRN", No: "CN-12", Dt: "20/09/2026" },
      BuyerDtls: { ...invoice.BuyerDtls, Gstin: "URP", Pos: "96", Stcd: "96" },
      ValDtls: undefined,
    };
    const e = parseEinvoiceJson(JSON.stringify(note));
    expect(e.docType).toBe("CRN");
    expect(e.buyer.gstin).toBeNull();
    expect(e.buyer.placeOfSupply).toBe("96");
    expect(e.totals).toMatchObject({ taxablePaise: 299992, cgstPaise: 18000, totalPaise: 335992 });
  });

  it("refuses what is not an e-invoice", () => {
    expect(() => parseEinvoiceJson("{")).toThrow(/not valid JSON/);
    expect(() => parseEinvoiceJson(JSON.stringify({ gstin: BUYER, fp: "092026", b2b: [] }))).toThrow(/not an e-invoice/);
    expect(() => parseEinvoiceJson(JSON.stringify({ SignedInvoice: "garbage" }))).toThrow(/not an e-invoice/);
    expect(() => parseEinvoiceJson(JSON.stringify({ ...invoice, DocDtls: { Typ: "INV", No: "", Dt: "05/09/2026" } }))).toThrow(/missing/);
  });
});

describe("decodeSignedQr", () => {
  it("decodes the signed QR payload", () => {
    const decoded = decodeSignedQr(signedQr)!;
    expect(decoded.payload).toEqual({
      sellerGstin: SELLER,
      buyerGstin: BUYER,
      docNo: "AD/2026/0451",
      docType: "INV",
      docDate: "2026-09-05",
      totalPaise: 336000,
      itemCount: 2,
      mainHsn: "04051000",
      irn: IRN,
      irnDate: "2026-09-05 11:20:00",
    });
    expect(decoded.header.alg).toBe("RS256");
    expect(decoded.signingInput).toBe(signedQr.split(".").slice(0, 2).join("."));
    expect(decoded.signature).toBe(signedQr.split(".")[2]);
  });

  it("handles base64url without padding and surrounding whitespace", () => {
    // Lengths chosen so the segments need 1 and 2 padding characters.
    for (const extra of ["", "x", "xy", "xyz"]) {
      const token = jwt({ data: JSON.stringify({ ...qrData, DocNo: `D${extra}` }), pad: extra });
      expect(token).not.toContain("=");
      expect(decodeSignedQr(`  ${token}\n`)?.payload.docNo).toBe(`D${extra}`);
    }
  });

  it("returns null for anything else", () => {
    expect(decodeSignedQr("upi://pay?pa=shop@upi&pn=Shop")).toBeNull();
    expect(decodeSignedQr("a.b.c")).toBeNull();
    expect(decodeSignedQr(jwt({ data: "not json" }))).toBeNull();
    expect(decodeSignedQr(jwt({ data: JSON.stringify({ SellerGstin: SELLER }) }))).toBeNull();
  });
});

describe("verifySignedQr", () => {
  it("accepts the signer's key and rejects tampering, other keys and garbage", () => {
    expect(verifySignedQr(signedQr, publicPem)).toBe(true);

    const [h, p, s] = signedQr.split(".");
    const forged = b64url(JSON.stringify({ data: JSON.stringify({ ...qrData, TotInvVal: 1 }), iss: "NIC" }));
    expect(verifySignedQr(`${h}.${forged}.${s}`, publicPem)).toBe(false);
    expect(verifySignedQr(`${h}.${p}.`, publicPem)).toBe(false);

    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifySignedQr(signedQr, other)).toBe(false);
    expect(verifySignedQr(signedQr, "not a key")).toBe(false);
    expect(verifySignedQr("garbage", publicPem)).toBe(false);
    expect(verifySignedQr(jwt({ data: "{}" }, "HS256"), publicPem)).toBe(false);
  });
});
