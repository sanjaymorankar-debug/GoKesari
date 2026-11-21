/**
 * Cashfree FSSAI adapter: the reader for Cashfree's own documented answers,
 * the request it sends, and how an active licence without an expiry date is judged.
 */
import { describe, expect, it } from "vitest";

import { cashfreeVerificationId, createCashfreeAdapter, parseCashfreeFssai } from "@/server/kyc/adapters/cashfree";
import { statusFromOutcome } from "@/server/kyc";
import type { KycHttpOptions } from "@/server/kyc/http";
import { KycConfigError, KycUnavailableError, type VerifyRequest } from "@/server/kyc/types";
import { applyDocumentChecks } from "@/server/services/seller-verification-checks";

const config = { clientId: "id", clientSecret: "secret", publicKey: null, env: "sandbox" as const, foundAs: { clientId: "a", clientSecret: "b" } };
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const req = (docType: VerifyRequest["docType"] = "FSSAI"): VerifyRequest => ({ docType, number: "10121002000677", extra: {}, idempotencyKey: "k1" });

const VALID = {
  verification_id: "x",
  reference_id: 123,
  status: "VALID",
  business_name: "Kesari Sweets",
  license_type: "State License",
  license_active_flag: true,
  address: "12 Main Road",
  district: "Pune",
  state: "Maharashtra",
  pincode: "411001",
  products: [],
};

function adapterWith(fetchImpl: typeof fetch) {
  const http: KycHttpOptions = { timeoutMs: 50, retries: 0, backoffMs: 1, sleep: async () => {}, fetchImpl };
  return createCashfreeAdapter(config, http);
}

describe("parseCashfreeFssai", () => {
  it("reads an active licence", () => {
    const out = parseCashfreeFssai(VALID);
    expect(out).toMatchObject({ kind: "found", providerRef: "123" });
    if (out.kind !== "found") throw new Error();
    expect(out.record).toMatchObject({ docStatus: "active", name: "Kesari Sweets", pincode: "411001", category: "STATE", validUntil: null, activeConfirmed: true });
  });

  it("maps INVALID to not_found", () => {
    expect(parseCashfreeFssai({ status: "INVALID", reference_id: 9, business_name: null })).toEqual({ kind: "not_found", providerRef: "9" });
  });

  it("reads an inactive licence as inactive, a missing flag as unknown", () => {
    const off = parseCashfreeFssai({ ...VALID, license_active_flag: false });
    const none = parseCashfreeFssai({ ...VALID, license_active_flag: undefined });
    expect(off.kind === "found" && off.record.docStatus).toBe("inactive");
    expect(none.kind === "found" && none.record.docStatus).toBe("unknown");
  });

  it("refuses an answer it cannot read", () => {
    expect(() => parseCashfreeFssai("nope")).toThrow(KycConfigError);
    expect(() => parseCashfreeFssai({ status: "PENDING" })).toThrow(KycConfigError);
  });
});

describe("verification id", () => {
  it("fits Cashfree's rules and is stable per attempt", () => {
    const id = cashfreeVerificationId("shop:1:3");
    expect(id).toMatch(/^[A-Za-z0-9._-]{1,50}$/);
    expect(cashfreeVerificationId("shop:1:3")).toBe(id);
    expect(cashfreeVerificationId("shop:1:4")).not.toBe(id);
  });
});

describe("Cashfree adapter", () => {
  it("posts the number and keys, and reads the answer", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const adapter = adapterWith((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return respond(200, VALID);
    }) as unknown as typeof fetch);
    const out = await adapter.verify(req());
    expect(out.kind).toBe("found");
    expect(seen!.url).toBe("https://sandbox.cashfree.com/verification/fssai");
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers["x-client-id"]).toBe("id");
    expect(headers["x-client-secret"]).toBe("secret");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ verification_id: cashfreeVerificationId("k1"), fssai_number: "10121002000677" });
  });

  it("does not check other documents", async () => {
    const adapter = adapterWith((async () => respond(200, VALID)) as unknown as typeof fetch);
    expect((await adapter.verify(req("PAN"))).kind).toBe("unsupported");
  });

  it("sends a refused key or IP to an admin", async () => {
    const adapter = adapterWith((async () => respond(403, { code: "ip_validation_failed" })) as unknown as typeof fetch);
    await expect(adapter.verify(req())).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("explains an empty balance and a repeated id", async () => {
    const empty = adapterWith((async () => respond(422, { code: "insufficient_balance", message: "no" })) as unknown as typeof fetch);
    await expect(empty.verify(req())).rejects.toThrow(/balance/);
    const dup = adapterWith((async () => respond(409, { code: "verification_id_already_exists" })) as unknown as typeof fetch);
    await expect(dup.verify(req())).rejects.toBeInstanceOf(KycUnavailableError);
  });
});

describe("an FSSAI licence with no expiry date", () => {
  const shop = { ownerName: "Asha Kesari", legalBusinessName: "Kesari Sweets", shopName: "Kesari Sweets", pincode: "411001", stateCode: "MH", isFoodBusiness: true };
  const judge = (record: Parameters<typeof applyDocumentChecks>[0]["record"], vendorStatus: "VERIFIED" | "FAILED" = "VERIFIED") =>
    applyDocumentChecks({ docType: "FSSAI", vendorStatus, record, shop, nameMatchAutoApprove: 85 });

  const outcome = parseCashfreeFssai(VALID);
  const record = outcome.kind === "found" ? outcome.record : null;

  it("is verified when Cashfree says it is active and the pincode matches", () => {
    expect(statusFromOutcome(outcome)).toEqual({ status: "VERIFIED", errorCode: null });
    expect(judge(record).status).toBe("VERIFIED");
  });

  it("goes to review on a different pincode", () => {
    expect(judge({ ...record!, pincode: "400001" })).toMatchObject({ status: "MANUAL_REVIEW", errorCode: "address_mismatch" });
  });

  it("goes to review with neither a date nor an active flag", () => {
    expect(judge({ ...record!, activeConfirmed: null })).toMatchObject({ status: "MANUAL_REVIEW", errorCode: "expiry_not_returned" });
  });

  it("fails an inactive licence", () => {
    const off = parseCashfreeFssai({ ...VALID, license_active_flag: false });
    expect(statusFromOutcome(off)).toEqual({ status: "FAILED", errorCode: "document_inactive" });
  });
});
