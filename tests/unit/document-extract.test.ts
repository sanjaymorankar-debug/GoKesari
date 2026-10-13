/**
 * docs/document-upload-2026-10: reading fields out of OCR text and flagging
 * problems. Pure functions — the texts below are what the OCR engine returns
 * for typical Indian certificates, including its usual misreads.
 */
import { describe, expect, it } from "vitest";

import { gstinCheckChar, looksLikeAadhaar } from "@/lib/kyc/doc-formats";
import {
  assessExtraction,
  detectDocType,
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
