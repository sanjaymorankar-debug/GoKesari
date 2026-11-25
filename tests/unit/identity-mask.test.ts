/**
 * docs/identity-verification-2026-11: identity numbers never reach a log or an
 * error in full, and the identityVerification rule's defaults and limits.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { toClientError } from "@/lib/errors";
import { containsUnmaskedNumber, maskAadhaarLast4, maskPanLast4, redactForLog, redactIdentityNumbers } from "@/lib/kyc/identity-mask";
import { IDENTITY_CONSENT_TEXT, IDENTITY_NOT_STORED_ITEMS, IDENTITY_RETENTION_TEXT, identityReason } from "@/lib/kyc/identity";
import { RULES } from "@/server/config/rules";

const TWELVE = /\d{12}|\d{4}[\s-]\d{4}[\s-]\d{4}/;

afterEach(() => vi.restoreAllMocks());

describe("masking", () => {
  it("masks to the last four only", () => {
    expect(maskAadhaarLast4("234567890123")).toBe("XXXX XXXX 0123");
    expect(maskAadhaarLast4("0123")).toBe("XXXX XXXX 0123");
    expect(maskPanLast4("abcpe1234f")).toBe("XXXXXX234F");
    expect(containsUnmaskedNumber("XXXX XXXX 0123")).toBe(false);
    expect(containsUnmaskedNumber("2345 6789 0123")).toBe(true);
  });

  it("never leaves a 12-digit number in text, in any common spacing", () => {
    for (const raw of ["234567890123", "2345 6789 0123", "2345-6789-0123", "id=234567890123;", "VID 9123456789012345"]) {
      const out = redactIdentityNumbers(`Aadhaar ${raw} was sent`);
      expect(out).not.toMatch(TWELVE);
      expect(out).not.toMatch(/\d{5,}/);
    }
    expect(redactIdentityNumbers("Aadhaar 2345 6789 0123 ok")).toBe("Aadhaar XXXX XXXX 0123 ok");
    expect(redactIdentityNumbers("PAN ABCPE1234F given")).toBe("PAN XXXXXX234F given");
    // Short numbers (amounts, order numbers, PIN codes) are left alone.
    expect(redactIdentityNumbers("₹1500 order 4110 PIN 411001")).toBe("₹1500 order 4110 PIN 411001");
  });

  it("masks errors written to the log, stack included", () => {
    const error = new Error("vendor said: aadhaar 234567890123 invalid");
    const line = redactForLog(error);
    expect(line).toContain("XXXX XXXX 0123");
    expect(line).not.toMatch(TWELVE);
  });

  it("the server's unhandled-error log masks Aadhaar numbers and the client gets a generic message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = toClientError(new Error("bad input 2345 6789 0123 from form"));
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toMatch(TWELVE);
    const logged = spy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain("[unhandled]");
    expect(logged).not.toMatch(TWELVE);
  });
});

describe("consent wording and reasons", () => {
  it("states retention, what is not stored and the voluntary nature", () => {
    expect(IDENTITY_RETENTION_TEXT).toMatch(/account is open/);
    expect(IDENTITY_NOT_STORED_ITEMS.join(" ")).toMatch(/full Aadhaar number/);
    expect(IDENTITY_CONSENT_TEXT).toMatch(/voluntary/);
    expect(identityReason("vendor_timeout")).toMatch(/not answering/);
    expect(identityReason(null)).toBeNull();
  });
});

describe("rule identityVerification", () => {
  const rule = RULES.identityVerification;
  it("defaults: Aadhaar or an alternative, 30 days grace, the real provider, legal advice noted", () => {
    expect(rule.defaults).toEqual({ allowedMethods: "aadhaar_or_alternative", sellerGraceDays: 30, nameMatchThreshold: 80, provider: "kyc_provider" });
    expect(rule.schema.safeParse(rule.defaults).success).toBe(true);
    expect(rule.description).toMatch(/LEGAL ADVICE IS PENDING/);
    expect(rule.description).toMatch(/mock is always used/);
  });

  it("refuses values out of range", () => {
    expect(rule.schema.safeParse({ ...rule.defaults, allowedMethods: "pan_only" }).success).toBe(false);
    expect(rule.schema.safeParse({ ...rule.defaults, sellerGraceDays: -1 }).success).toBe(false);
    expect(rule.schema.safeParse({ ...rule.defaults, nameMatchThreshold: 20 }).success).toBe(false);
    expect(rule.schema.safeParse({ ...rule.defaults, provider: "gridlines" }).success).toBe(false);
  });
});
