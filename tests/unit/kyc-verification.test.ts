/**
 * Seller verification, Part 2: local format checks, the vendor HTTP layer
 * (timeouts, retries, error classes), the Gridlines response reader, status
 * mapping, and the sandbox/production pairing guard. No network, no database.
 */
import { describe, expect, it } from "vitest";

import { getEnv, kycConfigProblem } from "@/lib/env";
import { gstinCheckChar, parseSellerDocNumber } from "@/lib/kyc/doc-formats";
import { parseGridlinesResponse, toIsoDate } from "@/server/kyc/adapters/gridlines";
import { createMockAdapter } from "@/server/kyc/adapters/mock";
import { kycPostJson, type KycHttpOptions } from "@/server/kyc/http";
import { statusFromOutcome } from "@/server/kyc";
import { KycConfigError, KycUnavailableError, type VerifyRequest } from "@/server/kyc/types";

describe("PAN format", () => {
  it("accepts a valid PAN and reports its holder type", () => {
    const r = parseSellerDocNumber("PAN", "abcpe 1234 f");
    expect(r).toEqual({
      ok: true,
      value: { docType: "PAN", normalized: "ABCPE1234F", masked: "XXXXXX234F", panHolderType: "P" },
    });
  });

  it("refuses a 4th character that is not a holder type", () => {
    const r = parseSellerDocNumber("PAN", "ABCZE1234F");
    expect(r.ok).toBe(false);
  });

  it("refuses the wrong shape", () => {
    expect(parseSellerDocNumber("PAN", "ABCP1234F").ok).toBe(false);
    expect(parseSellerDocNumber("PAN", "").ok).toBe(false);
  });
});

describe("GSTIN format", () => {
  // Real GSTINs published as examples by GSTN and vendors' documentation.
  it.each(["27AAPFU0939F1ZV", "29AAGCB7383J1Z4", "07AAGFF2194N1Z1", "33AAACH7409R1Z8"])(
    "accepts %s and its checksum",
    (gstin) => {
      expect(gstinCheckChar(gstin.slice(0, 14))).toBe(gstin[14]);
      const r = parseSellerDocNumber("GSTIN", gstin);
      expect(r.ok).toBe(true);
    },
  );

  it("extracts the state code and embedded PAN", () => {
    const r = parseSellerDocNumber("GSTIN", "27AAPFU0939F1ZV");
    expect(r.ok && r.value).toMatchObject({
      gstStateCode: "27",
      gstEmbeddedPan: "AAPFU0939F",
      panHolderType: "F",
      masked: "27XXXXXXXXXX1ZV",
    });
  });

  it("refuses a wrong check character", () => {
    const r = parseSellerDocNumber("GSTIN", "27AAPFU0939F1ZA");
    expect(r).toMatchObject({ ok: false });
  });

  it("refuses an unknown state code", () => {
    // 45 is not a state; checksum recomputed so only the state code is wrong.
    const first14 = "45AAPFU0939F1Z";
    const r = parseSellerDocNumber("GSTIN", first14 + gstinCheckChar(first14));
    expect(r).toMatchObject({ ok: false });
  });
});

describe("Udyam, FSSAI and Shop Act formats", () => {
  it("normalises a Udyam number", () => {
    const r = parseSellerDocNumber("UDYAM", "udyam mh 26 0012345");
    expect(r.ok && r.value.normalized).toBe("UDYAM-MH-26-0012345");
  });

  it("refuses an old Udyog Aadhaar number and a bare Aadhaar-like number", () => {
    expect(parseSellerDocNumber("UDYAM", "MH26A0012345").ok).toBe(false);
    expect(parseSellerDocNumber("UDYAM", "123456789012").ok).toBe(false);
  });

  it("needs exactly 14 FSSAI digits", () => {
    expect(parseSellerDocNumber("FSSAI", "1152 1001 0001 23").ok).toBe(true);
    expect(parseSellerDocNumber("FSSAI", "1152100100012").ok).toBe(false);
    expect(parseSellerDocNumber("FSSAI", "11521001000123A").ok).toBe(false);
  });

  it("keys a Shop Act number on letters and digits", () => {
    const r = parseSellerDocNumber("SHOP_ACT", "2710 000 3/ Shop / 12345");
    expect(r.ok && r.value.normalized).toBe("27100003SHOP12345");
    expect(parseSellerDocNumber("SHOP_ACT", "N/A").ok).toBe(false);
  });
});

describe("kycPostJson", () => {
  const fast: KycHttpOptions = { timeoutMs: 50, retries: 2, backoffMs: 1, sleep: async () => {} };

  function respond(status: number, body: unknown = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  it("retries a 503 and returns the later success", async () => {
    const statuses = [503, 503, 200];
    let calls = 0;
    const res = await kycPostJson("https://v.test/x", {}, {}, "k1", {
      ...fast,
      fetchImpl: async () => respond(statuses[calls++], { ok: true }),
    });
    expect(calls).toBe(3);
    expect(res).toEqual({ status: 200, body: { ok: true } });
  });

  it("gives up after the retries as unavailable", async () => {
    let calls = 0;
    await expect(
      kycPostJson("https://v.test/x", {}, {}, "k1", { ...fast, fetchImpl: async () => (calls++, respond(429)) }),
    ).rejects.toMatchObject({ name: "KycUnavailableError", code: "rate_limited" });
    expect(calls).toBe(3);
  });

  it("times out a hanging vendor", async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    await expect(
      kycPostJson("https://v.test/x", {}, {}, "k1", { ...fast, retries: 0, fetchImpl: hang }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("does not retry a rejected key or non-whitelisted IP", async () => {
    let calls = 0;
    await expect(
      kycPostJson("https://v.test/x", {}, {}, "k1", { ...fast, fetchImpl: async () => (calls++, respond(406)) }),
    ).rejects.toBeInstanceOf(KycConfigError);
    expect(calls).toBe(1);
  });

  it("sends the idempotency key on every attempt", async () => {
    const keys: string[] = [];
    let n = 0;
    await kycPostJson("https://v.test/x", {}, {}, "abc:1", {
      ...fast,
      fetchImpl: async (_u, init) => {
        keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        return respond(n++ === 0 ? 502 : 200);
      },
    });
    expect(keys).toEqual(["abc:1", "abc:1"]);
  });
});

describe("Gridlines response reader", () => {
  const req: VerifyRequest = { docType: "FSSAI", number: "11521001000123", extra: {}, idempotencyKey: "k" };

  it("reads a found licence", () => {
    const outcome = parseGridlinesResponse(req, 200, {
      request_id: "req-1",
      status: 200,
      data: {
        code: "1000",
        message: "License found",
        fssai_data: {
          company_name: "Shree Dairy",
          license_type: "STATE",
          status: "Active",
          valid_upto: "31/03/2028",
          premises_address: "Plot 4, Kothrud, Pune 411038",
        },
      },
    });
    expect(outcome).toMatchObject({
      kind: "found",
      providerRef: "req-1",
      record: { docStatus: "active", name: "Shree Dairy", category: "STATE", validUntil: "2028-03-31", pincode: "411038" },
    });
  });

  it("treats a not-found message as not_found", () => {
    expect(parseGridlinesResponse(req, 200, { data: { code: "1001", message: "No record found" } }).kind).toBe(
      "not_found",
    );
  });

  it("refuses to guess at a response it cannot read", () => {
    expect(() => parseGridlinesResponse(req, 200, { data: { code: "1000", foo: { bar: 1 } } })).toThrow(KycConfigError);
  });

  it("parses the date formats vendors use", () => {
    expect(toIsoDate("2027-01-05")).toBe("2027-01-05");
    expect(toIsoDate("05-01-2027")).toBe("2027-01-05");
    expect(toIsoDate("Jan 5")).toBeNull();
  });
});

describe("status mapping", () => {
  const found = (docStatus: "active" | "cancelled" | "unknown", validUntil: string | null = null) => ({
    kind: "found" as const,
    providerRef: "r",
    record: { docStatus, name: "X", validUntil },
  });

  it("maps vendor answers to document statuses", () => {
    expect(statusFromOutcome(found("active")).status).toBe("VERIFIED");
    expect(statusFromOutcome(found("active", "2020-01-01"), "2026-10-05").status).toBe("EXPIRED");
    expect(statusFromOutcome(found("cancelled")).status).toBe("FAILED");
    expect(statusFromOutcome(found("unknown")).status).toBe("MANUAL_REVIEW");
    expect(statusFromOutcome({ kind: "not_found", providerRef: null }).status).toBe("FAILED");
    expect(statusFromOutcome({ kind: "unsupported", reason: "x" }).status).toBe("MANUAL_REVIEW");
  });
});

describe("mock adapter", () => {
  const mock = createMockAdapter(() => Date.parse("2026-10-05T00:00:00Z"));
  const ask = (docType: VerifyRequest["docType"], number: string, stateCode?: string) =>
    mock.verify({ docType, number, extra: { nameToMatch: "Shree Dairy", stateCode }, idempotencyKey: "k" });

  it("follows the scenario digits", async () => {
    await expect(ask("PAN", "ABCPE1234F")).resolves.toMatchObject({ kind: "found", record: { name: "SHREE DAIRY" } });
    await expect(ask("PAN", "ABCPE0000F")).resolves.toMatchObject({ kind: "not_found" });
    await expect(ask("PAN", "ABCPE9999F")).rejects.toBeInstanceOf(KycUnavailableError);
    await expect(ask("FSSAI", "11521001008888")).resolves.toMatchObject({ record: { docStatus: "expired" } });
    await expect(ask("SHOP_ACT", "MUM12345", "MH")).resolves.toMatchObject({ kind: "unsupported" });
    await expect(ask("SHOP_ACT", "MUM12222", "MH")).resolves.toMatchObject({ kind: "found" });
  });
});

describe("sandbox / production pairing guard", () => {
  const base = getEnv();
  const env = (over: Partial<typeof base>) => ({ ...base, ...over });

  it("allows mock and sandbox off the production host", () => {
    expect(kycConfigProblem(env({ AUTH_URL: "https://test.gokesari.com", KYC_PROVIDER: "mock" }))).toBeNull();
    expect(
      kycConfigProblem(
        env({ AUTH_URL: "https://test.gokesari.com", KYC_PROVIDER: "gridlines", GRIDLINES_API_KEY: "k", KYC_ENV: "sandbox" }),
      ),
    ).toBeNull();
  });

  it("refuses live keys on the test site", () => {
    expect(
      kycConfigProblem(env({ AUTH_URL: "https://test.gokesari.com", KYC_PROVIDER: "gridlines", GRIDLINES_API_KEY: "k", KYC_ENV: "production" })),
    ).toMatch(/only allowed on gokesari.com/);
  });

  it("refuses mock or sandbox on the production site", () => {
    expect(kycConfigProblem(env({ AUTH_URL: "https://gokesari.com", KYC_PROVIDER: "mock" }))).toMatch(/not allowed/);
    expect(
      kycConfigProblem(env({ AUTH_URL: "https://www.gokesari.com", KYC_PROVIDER: "gridlines", GRIDLINES_API_KEY: "k", KYC_ENV: "sandbox" })),
    ).toMatch(/must use KYC_ENV=production/);
    expect(
      kycConfigProblem(env({ AUTH_URL: "https://gokesari.com", KYC_PROVIDER: "gridlines", GRIDLINES_API_KEY: "k", KYC_ENV: "production" })),
    ).toBeNull();
  });

  it("requires the vendor key", () => {
    expect(kycConfigProblem(env({ KYC_PROVIDER: "gridlines", GRIDLINES_API_KEY: undefined }))).toMatch(/GRIDLINES_API_KEY/);
  });
});
