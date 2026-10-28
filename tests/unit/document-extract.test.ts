/**
 * docs/document-upload-2026-10: reading fields out of OCR text and flagging
 * problems. Pure functions — the texts below are what the OCR engine returns
 * for typical Indian certificates, including its usual misreads.
 */
import { describe, expect, it } from "vitest";

import { gstinCheckChar, looksLikeAadhaar } from "@/lib/kyc/doc-formats";
import { checkLicenceName } from "@/lib/legal-documents";
import {
  assessExtraction,
  detectDocType,
  detectUploadType,
  extractDocumentFields,
  normaliseOcrText,
  parseDates,
  validateConfirmedFields,
  type AssessInput,
} from "@/lib/kyc/document-extract";

const TODAY = "2026-10-13";

const FSSAI_TEXT = `Government of India
Food Safety and Standards Authority of India
FORM C
License under Food Safety & Standards Act, 2006
License Number : 11521998000123
Name of Licensee : RAMESH KUMAR SHARMA
Address of Premises : Shop 4, Gokul Dairy, MG Road
Kothrud, Pune, Maharashtra 411038
Kind of Business : Retailer
Valid Upto : 31/03/2027
Date of Issue: 01-04-2022`;

const base = (overrides: Partial<AssessInput> = {}): AssessInput => ({
  expectedType: "FSSAI",
  fields: { detectedType: "FSSAI", number: "11521998000123", name: "RAMESH KUMAR SHARMA", address: null, validFrom: null, validUntil: "2027-03-31" },
  ocrConfidence: 90,
  textLength: 300,
  aadhaarRemoved: false,
  shopNames: ["Ramesh Kumar Sharma", "Gokul Dairy"],
  today: TODAY,
  expiryWarningDays: 30,
  nameMatchMin: 70,
  imageMinSide: 1500,
  ...overrides,
});

describe("extractDocumentFields", () => {
  it("reads an FSSAI licence: type, number, name, address, validity", () => {
    const { fields } = extractDocumentFields(FSSAI_TEXT, "FSSAI");
    expect(fields).toEqual({
      detectedType: "FSSAI",
      number: "11521998000123",
      name: "RAMESH KUMAR SHARMA",
      address: "Shop 4, Gokul Dairy, MG Road, Kothrud, Pune, Maharashtra 411038",
      validFrom: "2022-04-01",
      validUntil: "2027-03-31",
    });
  });

  it("reads a 14-digit number printed in groups", () => {
    const { fields } = extractDocumentFields("FSSAI Registration No. 2152 1998 0001 23\nValid till 15 Aug 2028", "FSSAI");
    expect(fields.number).toBe("21521998000123");
    expect(fields.validUntil).toBe("2028-08-15");
  });

  it("reads a PAN card, fixing letter/digit OCR confusions", () => {
    const text = "INCOME TAX DEPARTMENT GOVT. OF INDIA\nRAMESH KUMAR SHARMA\nKISHAN LAL SHARMA\n12/05/1980\nPermanent Account Number\nABCPE l234F";
    const { fields } = extractDocumentFields(text.replace("l234F", "1234F"), "PAN"); // printed with a space: "ABCPE 1234F"
    expect(fields.detectedType).toBe("PAN");
    expect(fields.number).toBe("ABCPE1234F");
    expect(fields.name).toBe("RAMESH KUMAR SHARMA");
    // O read for 0 in a digit position is corrected.
    expect(extractDocumentFields("Permanent Account Number ABCPE12O4F", "PAN").fields.number).toBe("ABCPE1204F");
  });

  it("reads a GST registration certificate and checks the GSTIN checksum", () => {
    const first14 = "27AAPFU0939F1Z";
    const gstin = first14 + gstinCheckChar(first14);
    const text = `Government of India\nForm GST REG-06\nRegistration Certificate\nRegistration Number : ${gstin}\nLegal Name : GOKUL DAIRY PRIVATE LIMITED\nTrade Name, if any : GOKUL DAIRY\nDate of Validity From 01/07/2017 To NA`;
    const { fields } = extractDocumentFields(text, "GSTIN");
    expect(fields.detectedType).toBe("GSTIN");
    expect(fields.number).toBe(gstin);
    expect(fields.name).toBe("GOKUL DAIRY PRIVATE LIMITED");
    // A GSTIN with a wrong check character is not taken.
    const bad = first14 + (gstin.endsWith("A") ? "B" : "A");
    expect(extractDocumentFields(`Form GST REG-06 ${bad}`, "GSTIN").fields.number).toBeNull();
  });

  it("reads a Udyam number however it is spaced", () => {
    const { fields } = extractDocumentFields("UDYAM REGISTRATION CERTIFICATE\nUDYAM REGISTRATION NUMBER UDYAM - MH - 26 - 0012345\nNAME OF ENTERPRISE : GOKUL DAIRY", "UDYAM");
    expect(fields.number).toBe("UDYAM-MH-26-0012345");
    expect(fields.detectedType).toBe("UDYAM");
    expect(fields.name).toBe("GOKUL DAIRY");
  });

  it("reads a Shop Act (Form G) intimation receipt number", () => {
    const { fields } = extractDocumentFields(
      "Maharashtra Shops and Establishments Act 2017\nFORM 'G' Intimation Receipt\nRegistration No : 2731000317654321\nName of the Establishment: GOKUL DAIRY",
      "SHOP_ACT",
    );
    expect(fields.detectedType).toBe("SHOP_ACT");
    expect(fields.number).toBe("2731000317654321");
    expect(fields.name).toBe("GOKUL DAIRY");
  });

  it("never extracts an Aadhaar number", () => {
    let aadhaar = "";
    for (let d = 0; d < 10 && !aadhaar; d++) if (looksLikeAadhaar(`23456789012${d}`)) aadhaar = `23456789012${d}`;
    expect(aadhaar).not.toBe("");
    const spaced = `${aadhaar.slice(0, 4)} ${aadhaar.slice(4, 8)} ${aadhaar.slice(8)}`;
    const result = extractDocumentFields(`Food Safety and Standards Authority\nAadhaar: ${spaced}\nLicense Number: 11521998000123`, "FSSAI");
    expect(result.aadhaarRemoved).toBe(true);
    expect(JSON.stringify(result.fields)).not.toContain(aadhaar.slice(4, 8));
    expect(normaliseOcrText(`x ${spaced}`).lines.join(" ")).not.toContain(spaced);
  });
});

describe("parseDates and detectDocType", () => {
  it("understands the usual Indian date formats", () => {
    expect(parseDates("31/03/2027")).toEqual(["2027-03-31"]);
    expect(parseDates("31-03-27")).toEqual(["2027-03-31"]);
    expect(parseDates("31.03.2027")).toEqual(["2027-03-31"]);
    expect(parseDates("31st March 2027")).toEqual(["2027-03-31"]);
    expect(parseDates("2027-03-31")).toEqual(["2027-03-31"]);
    expect(parseDates("31/02/2027")).toEqual([]);
  });

  it("takes the end of a validity range as the expiry", () => {
    const { fields } = extractDocumentFields("Food Safety and Standards\nValidity: 01/04/2022 to 31/03/2027\nLicense Number 11521998000123", "FSSAI");
    expect(fields.validUntil).toBe("2027-03-31");
  });

  // TC-FLD-047: a GST REG-06 certificate has no end date; its "From" date is not an expiry.
  it("reads 'To : Not Applicable' as no expiry, and never takes a From date as the expiry", () => {
    const first14 = "27AAPFU0939F1Z";
    const gstin = first14 + gstinCheckChar(first14);
    const reg06 = `Form GST REG-06\nRegistration Certificate\nRegistration Number : ${gstin}\nLegal Name : GOKUL DAIRY\nPeriod of Validity From : 01/04/2020 To : Not Applicable\nType of Registration : Regular`;
    expect(extractDocumentFields(reg06, "GSTIN").fields).toMatchObject({ validFrom: "2020-04-01", validUntil: null });
    // The same, with "To" on its own line, or written NA.
    const split = extractDocumentFields(`Form GST REG-06\nPeriod of Validity From : 01/04/2020\nTo : Not Applicable`, "GSTIN").fields;
    expect(split).toMatchObject({ validFrom: "2020-04-01", validUntil: null });
    expect(extractDocumentFields("Form GST REG-06\nDate of Validity From 01/07/2017 To NA", "GSTIN").fields.validUntil).toBeNull();
    // A start date alone is not an expiry; a real end date still is.
    expect(extractDocumentFields("Food Safety and Standards\nValidity From : 01/04/2020", "FSSAI").fields.validUntil).toBeNull();
    expect(extractDocumentFields("Food Safety and Standards\nValidity From : 01/04/2022\nTo : 31/03/2027", "FSSAI").fields.validUntil).toBe("2027-03-31");
    expect(extractDocumentFields("Food Safety and Standards\nDate of Expiry: 31/03/2027 (renew from 01/02/2027)", "FSSAI").fields.validUntil).toBe("2027-03-31");
  });

  it("recognises documents by their wording", () => {
    expect(detectDocType(["DRUGS AND COSMETICS ACT FORM 20"])).toBe("DRUG_LICENCE");
    expect(detectDocType(["MAHARASHTRA MEDICAL COUNCIL"])).toBe("MEDICAL_REGISTRATION");
    expect(detectDocType(["a blank page"])).toBeNull();
  });
});

describe("assessExtraction", () => {
  it("passes a clear, valid, matching licence", () => {
    expect(assessExtraction(base())).toEqual([]);
  });

  it("blocks an expired licence and asks for the renewed one", () => {
    const flags = assessExtraction(base({ fields: { ...base().fields, validUntil: "2026-03-31" } }));
    expect(flags).toContainEqual(expect.objectContaining({ code: "EXPIRED", severity: "block" }));
  });

  it("warns when the licence expires soon", () => {
    const flags = assessExtraction(base({ fields: { ...base().fields, validUntil: "2026-10-30" } }));
    expect(flags.map((f) => f.code)).toEqual(["EXPIRING_SOON"]);
  });

  it("flags a name that differs from the registration", () => {
    const flags = assessExtraction(base({ fields: { ...base().fields, name: "SURESH PATIL TRADERS" } }));
    expect(flags).toContainEqual(expect.objectContaining({ code: "NAME_MISMATCH", severity: "warn" }));
  });

  it("blocks an unreadable photo and asks for a re-upload", () => {
    const flags = assessExtraction(base({ textLength: 8, ocrConfidence: 12, fields: { detectedType: null, number: null, name: null, address: null, validFrom: null, validUntil: null } }));
    expect(flags).toContainEqual(expect.objectContaining({ code: "UNREADABLE", severity: "block" }));
  });

  it("blocks the wrong document when the expected number isn't on it", () => {
    const flags = assessExtraction(base({ fields: { detectedType: "PAN", number: null, name: null, address: null, validFrom: null, validUntil: null } }));
    expect(flags).toContainEqual(expect.objectContaining({ code: "WRONG_DOCUMENT", severity: "block" }));
  });

  it("asks for the expiry date of an FSSAI licence when it wasn't found", () => {
    const flags = assessExtraction(base({ fields: { ...base().fields, validUntil: null } }));
    expect(flags.map((f) => f.code)).toContain("NO_EXPIRY");
  });

  it("warns about a small picture", () => {
    expect(assessExtraction(base({ imageMinSide: 400 })).map((f) => f.code)).toContain("LOW_QUALITY");
  });
});

describe("validateConfirmedFields", () => {
  it("accepts a valid FSSAI with a future expiry", () => {
    expect(validateConfirmedFields("FSSAI", { number: "11521998000123", validUntil: "2027-03-31" }, TODAY)).toEqual({});
  });

  it("refuses an FSSAI without an expiry, or an expired one", () => {
    expect(validateConfirmedFields("FSSAI", { number: "11521998000123" }, TODAY)).toHaveProperty("validUntil");
    expect(validateConfirmedFields("FSSAI", { number: "11521998000123", validUntil: "2026-01-01" }, TODAY).validUntil).toMatch(/expired/);
  });

  it("refuses a malformed number using the document's own rules", () => {
    expect(validateConfirmedFields("FSSAI", { number: "1234", validUntil: "2027-01-01" }, TODAY)).toHaveProperty("number");
    expect(validateConfirmedFields("PAN", { number: "ABCDE12345" }, TODAY)).toHaveProperty("number");
    expect(validateConfirmedFields("PAN", { number: "ABCPE1234F" }, TODAY)).toEqual({});
  });
});

describe("Scan a document: which document is it, and the optional licences", () => {
  const lines = (text: string) => normaliseOcrText(text).lines;

  it.each([
    ["PUNE MUNICIPAL CORPORATION\nTRADE LICENCE\nLicence No : PMC/TL/2026/012345\nName of Trader : RAMESH KUMAR SHARMA", "TRADE_LICENCE"],
    ["Health Licence\nEating House Licence No. 4567/2026", "TRADE_LICENCE"],
    ["Government of Maharashtra\nLegal Metrology Organisation\nCertificate of Verification\nCertificate No : LM/PUN/12345", "LEGAL_METROLOGY"],
    ["Department of Weights & Measures\nLicence No. 123/2025", "LEGAL_METROLOGY"],
    ["Maharashtra Fire and Emergency Services\nFire NOC No : MFS/2026/889", "FIRE_NOC"],
    ["Licence to sell, stock or exhibit for sale Insecticides\nInsecticides Rules, 1971\nLicence No: AG/INS/778", "AGRI_INPUT_LICENCE"],
    ["Fertiliser (Control) Order, 1985\nAuthorisation letter No. 991/2026", "AGRI_INPUT_LICENCE"],
    ["Seeds Licence\nUnder Seeds (Control) Order 1983\nLicence No: SD/445", "AGRI_INPUT_LICENCE"],
  ])("recognises %j as %s", (text, type) => {
    expect(detectDocType(lines(text))).toBe(type);
  });

  it("takes the document's own heading over another document it mentions further down", () => {
    const text = "PUNE MUNICIPAL CORPORATION\nTRADE LICENCE\nLicence No : PMC/TL/2026/012345\nFSSAI Licence No : 11521998000123";
    expect(detectDocType(lines(text))).toBe("TRADE_LICENCE");
    const fssai = "Food Safety and Standards Authority of India\nLicense Number : 11521998000123\nMunicipal Trade Licence No: 7781";
    expect(detectDocType(lines(fssai))).toBe("FSSAI");
  });

  it("still detects the existing documents", () => {
    expect(detectUploadType("INCOME TAX DEPARTMENT\nGOVT. OF INDIA\nABCPE1234F")).toBe("PAN");
    expect(detectUploadType("Food Safety and Standards Authority of India\nLicense Number : 11521998000123")).toBe("FSSAI");
    expect(detectUploadType("Government of Maharashtra\nShops and Establishments\nIntimation receipt")).toBe("SHOP_ACT");
  });

  it("falls back to a number only one document carries when the wording is unreadable", () => {
    const first14 = "27ABCPE1234F1Z";
    const gstin = first14 + gstinCheckChar(first14);
    expect(detectUploadType(`blurred heading\n${gstin}`)).toBe("GSTIN");
    expect(detectUploadType("UDYAM-MH-26-0012345")).toBe("UDYAM");
    expect(detectUploadType("RAMESH KUMAR\nABCPE1234F")).toBe("PAN");
    expect(detectUploadType("A blurred page with no heading and 12345")).toBeNull();
  });

  it("reads the number, name and expiry off a trade licence and a fire NOC", () => {
    const trade = extractDocumentFields(
      `PUNE MUNICIPAL CORPORATION\nTRADE LICENCE\nLicence No : PMC/TL/2026/012345\nName of Trader : RAMESH KUMAR SHARMA\nValid Upto : 31/03/2027`,
      "TRADE_LICENCE",
    ).fields;
    expect(trade).toMatchObject({ detectedType: "TRADE_LICENCE", number: "PMC/TL/2026/012345", name: "RAMESH KUMAR SHARMA", validUntil: "2027-03-31" });
    const noc = extractDocumentFields("Maharashtra Fire and Emergency Services\nNOC No : MFS/2026/889\nValid till 30-06-2027", "FIRE_NOC").fields;
    expect(noc).toMatchObject({ detectedType: "FIRE_NOC", number: "MFS/2026/889", validUntil: "2027-06-30" });
  });

  it("does not require an expiry date for the optional licences", () => {
    expect(validateConfirmedFields("TRADE_LICENCE", { number: "PMC/TL/2026/012345" }, TODAY)).toEqual({});
    expect(validateConfirmedFields("OTHER_LICENCE", { number: "EXP/123", validUntil: "2020-01-01" }, TODAY).validUntil).toMatch(/expired/);
  });

  it("checks the name of an Other licence and keys it by name", () => {
    expect(checkLicenceName("  Explosives   licence ")).toEqual({ ok: true, name: "Explosives licence", key: "EXPLOSIVES-LICENCE" });
    expect(checkLicenceName("ab").ok).toBe(false);
    expect(checkLicenceName("<script>").ok).toBe(false);
    expect(checkLicenceName(null).ok).toBe(false);
  });
});
