/**
 * Sandbox.co.in adapter: the token cycle, the PAN and GSTIN readers, and the
 * key / environment pairing guard. Response bodies are Sandbox's own examples
 * from its OpenAPI specs.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getEnv, kycConfigProblem } from "@/lib/env";
import {
  clearSandboxCoTokens,
  createSandboxCoAdapter,
  describeSandboxBody,
  parseAuthenticateResponse,
  parseSandboxGstin,
  parseSandboxPan,
  tokenExpiry,
} from "@/server/kyc/adapters/sandbox-co";
import type { KycHttpOptions } from "@/server/kyc/http";
import { KycConfigError, type VerifyRequest } from "@/server/kyc/types";

const fast: KycHttpOptions = { timeoutMs: 50, retries: 0, backoffMs: 1, sleep: async () => {} };
const creds = { apiKey: "key_test_abc", apiSecret: "secret_test_xyz", baseUrl: "https://sbx.test" };

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function jwt(expSeconds: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part({ exp: expSeconds })}.sig`;
}

const panReq = (number = "XXXPX1234A"): VerifyRequest => ({ docType: "PAN", number, extra: {}, idempotencyKey: "d1:pan:1" });

const PAN_VALID = {
  code: 200,
  transaction_id: "ec2c8ac5",
  data: { "@entity": "in.co.sandbox.kyc.pan_search_lite.response", pan: "XXXPX1234A", full_name: "JOHN RONALD DOE", status: "valid", category: "Individual" },
};

const GST_ACTIVE = {
  code: 200,
  transaction_id: "5248feb5",
  data: {
    status_cd: "1",
    data: {
      ctb: "Proprietorship",
      gstin: "29AFSPB9500E1ZY",
      lgnm: "Vicky Pvt Ltd",
      tradeNam: "Vicky Traders",
      sts: "Active",
      pradr: { addr: { bno: "26666, Block 77", st: "Whitefield Main Road", loc: "Bangalore", dst: "Bengaluru Urban", stcd: "Karnataka", pncd: "560048" } },
    },
  },
};

afterEach(() => clearSandboxCoTokens());

describe("Sandbox.co.in authenticate", () => {
  it("reads the token from data.access_token", () => {
    expect(parseAuthenticateResponse({ code: 200, data: { access_token: "t1" } })).toBe("t1");
    expect(() => parseAuthenticateResponse({ code: 200, data: {} })).toThrow(KycConfigError);
  });

  it("uses the JWT's exp, else 24 hours", () => {
    const now = 1_000_000_000_000;
    expect(tokenExpiry(jwt(now / 1000 + 3600), now)).toBe(now + 3_600_000);
    expect(tokenExpiry("not-a-jwt", now)).toBe(now + 24 * 3_600_000);
  });

  it("authenticates once, then reuses the token; sends it without Bearer", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      return String(url).endsWith("/authenticate") ? respond(200, { code: 200, data: { access_token: "tok-1" } }) : respond(200, PAN_VALID);
    };
    const adapter = createSandboxCoAdapter(creds, { ...fast, fetchImpl });
    await adapter.verify(panReq());
    await adapter.verify(panReq());

    expect(seen.map((s) => s.url)).toEqual(["https://sbx.test/authenticate", "https://sbx.test/kyc/pan/search/lite", "https://sbx.test/kyc/pan/search/lite"]);
    expect(seen[0].headers.get("x-api-secret")).toBe("secret_test_xyz");
    expect(seen[1].headers.get("authorization")).toBe("tok-1");
    expect(seen[1].headers.get("x-api-key")).toBe("key_test_abc");
    // The secret goes only to /authenticate.
    expect(seen[1].headers.get("x-api-secret")).toBeNull();
  });

  it("shares one /authenticate call between concurrent checks", async () => {
    let auths = 0;
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).endsWith("/authenticate")) {
        auths += 1;
        return respond(200, { data: { access_token: "tok" } });
      }
      return respond(200, PAN_VALID);
    };
    const adapter = createSandboxCoAdapter(creds, { ...fast, fetchImpl });
    await Promise.all([adapter.verify(panReq()), adapter.verify(panReq()), adapter.verify(panReq())]);
    expect(auths).toBe(1);
  });

  it("re-authenticates once when a lookup's token is refused", async () => {
    const calls: string[] = [];
    let lookups = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push(`${path} ${new Headers(init?.headers).get("authorization") ?? ""}`.trim());
      if (path === "/authenticate") return respond(200, { data: { access_token: `tok-${calls.length}` } });
      return lookups++ === 0 ? respond(401, { message: "expired" }) : respond(200, PAN_VALID);
    };
    const outcome = await createSandboxCoAdapter(creds, { ...fast, fetchImpl }).verify(panReq());
    expect(outcome.kind).toBe("found");
    expect(calls).toEqual(["/authenticate", "/kyc/pan/search/lite tok-1", "/authenticate", "/kyc/pan/search/lite tok-3"]);
  });

  it("a key Sandbox refuses is a config problem, not a retry loop", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => (calls++, respond(403, { message: "Invalid API key" }));
    await expect(createSandboxCoAdapter(creds, { ...fast, fetchImpl }).verify(panReq())).rejects.toMatchObject({ code: "auth_failed" });
    expect(calls).toBe(2);
  });
});

describe("Sandbox.co.in PAN reader", () => {
  it("valid → found, with the holder's name and category", () => {
    expect(parseSandboxPan(PAN_VALID)).toEqual({
      kind: "found",
      providerRef: "ec2c8ac5",
      record: { docStatus: "active", name: "JOHN RONALD DOE", entityType: "Individual" },
    });
  });

  it("invalid → not found", () => {
    expect(parseSandboxPan({ transaction_id: "t", data: { pan: "IHPPM6269F", status: "invalid", category: "individual" } })).toEqual({
      kind: "not_found",
      providerRef: "t",
    });
  });

  it("an unknown shape goes to a person", () => {
    expect(() => parseSandboxPan({ data: { status: "maybe" } })).toThrow(KycConfigError);
    expect(() => parseSandboxPan({ code: 200 })).toThrow(KycConfigError);
  });

  it("sends Sandbox's example body word for word (the test environment matches it exactly)", async () => {
    let body: unknown = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/authenticate")) return respond(200, { data: { access_token: "t" } });
      body = JSON.parse(String(init?.body));
      return respond(200, PAN_VALID);
    };
    await createSandboxCoAdapter(creds, { ...fast, fetchImpl }).verify(panReq());
    expect(body).toEqual({ "@entity": "in.co.sandbox.kyc.pan_search_lite.request", pan: "XXXPX1234A", consent: "y", reason: "for KYC" });
  });
});

describe("Sandbox.co.in GSTIN reader", () => {
  it("active record → names, constitution, state, pincode and address", () => {
    const outcome = parseSandboxGstin(GST_ACTIVE);
    expect(outcome).toMatchObject({
      kind: "found",
      providerRef: "5248feb5",
      record: {
        docStatus: "active",
        name: "Vicky Pvt Ltd",
        tradeName: "Vicky Traders",
        entityType: "Proprietorship",
        stateCode: "Karnataka",
        pincode: "560048",
      },
    });
    expect(outcome.kind === "found" && outcome.record.address).toContain("Whitefield Main Road");
  });

  it("cancelled and provisional are not active", () => {
    const withSts = (sts: string) => ({ ...GST_ACTIVE, data: { status_cd: "1", data: { ...GST_ACTIVE.data.data, sts } } });
    expect(parseSandboxGstin(withSts("Cancelled"))).toMatchObject({ record: { docStatus: "cancelled" } });
    expect(parseSandboxGstin(withSts("Suspended"))).toMatchObject({ record: { docStatus: "suspended" } });
    expect(parseSandboxGstin(withSts("Provisional"))).toMatchObject({ record: { docStatus: "unknown" } });
  });

  it("FO8000 → not found; another GSTN error → a person looks", () => {
    expect(parseSandboxGstin({ transaction_id: "x", data: { status_cd: "0", error: { error_cd: "FO8000", message: "No records found" } } })).toEqual({
      kind: "not_found",
      providerRef: "x",
    });
    expect(() => parseSandboxGstin({ data: { status_cd: "0", error: { error_cd: "SWEB_9035" } } })).toThrow(KycConfigError);
  });

  it("Udyam, FSSAI and Shop Act are unsupported (manual review), with no call made", async () => {
    let calls = 0;
    const adapter = createSandboxCoAdapter(creds, { ...fast, fetchImpl: async () => (calls++, respond(200)) });
    for (const docType of ["UDYAM", "FSSAI", "SHOP_ACT"] as const) {
      expect(await adapter.verify({ docType, number: "x", extra: {}, idempotencyKey: "k" })).toMatchObject({ kind: "unsupported" });
    }
    expect(calls).toBe(0);
  });
});

describe("Sandbox.co.in answers we cannot read", () => {
  it("the error says what came back — status, Sandbox's code and message, field names — with every number masked", async () => {
    const fetchImpl = async (url: string | URL | Request) =>
      String(url).endsWith("/authenticate")
        ? respond(200, { data: { access_token: jwt(Math.floor(Date.now() / 1000) + 3600) } })
        : respond(404, { code: 404, message: "No example matches PAN XXXPX1234A", timestamp: 1 });
    const adapter = createSandboxCoAdapter(creds, { ...fast, fetchImpl: fetchImpl as typeof fetch });
    const error = await adapter.verify(panReq()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KycConfigError);
    expect((error as KycConfigError).code).toBe("unexpected_response");
    const message = (error as KycConfigError).message;
    expect(message).toContain("HTTP 404");
    expect(message).toContain('message "No example matches PAN [number]"');
    expect(message).toContain("fields [code, message, timestamp]");
    expect(message).not.toContain("1234");
  });

  it("names the data fields when data is there but not in the shape we read", () => {
    expect(describeSandboxBody(200, { code: 200, data: { status_cd: "1", other: { gstin: "33ABKCS2033B1ZW" } } })).toBe(
      "HTTP 200, code 200, fields [code, data], data fields [status_cd, other]",
    );
  });
});

describe("Sandbox.co.in key / environment guard", () => {
  const base = getEnv();
  const env = (over: Partial<typeof base>) => ({ ...base, KYC_PROVIDER: "sandboxco" as const, ...over });

  it("needs both the key and the secret", () => {
    expect(kycConfigProblem(env({ SANDBOX_CO_API_KEY: "key_test_a", SANDBOX_CO_API_SECRET: undefined }))).toMatch(/SANDBOX_CO_API_SECRET/);
  });

  it("test keys on the test site, live keys only on gokesari.com", () => {
    const test = { AUTH_URL: "https://test.gokesari.com", KYC_ENV: "sandbox" as const, SANDBOX_CO_API_SECRET: "s" };
    expect(kycConfigProblem(env({ ...test, SANDBOX_CO_API_KEY: "key_test_a" }))).toBeNull();
    expect(kycConfigProblem(env({ ...test, SANDBOX_CO_API_KEY: "key_live_a" }))).toMatch(/key_test_/);

    const prod = { AUTH_URL: "https://gokesari.com", KYC_ENV: "production" as const, SANDBOX_CO_API_SECRET: "s" };
    expect(kycConfigProblem(env({ ...prod, SANDBOX_CO_API_KEY: "key_live_a" }))).toBeNull();
    expect(kycConfigProblem(env({ ...prod, SANDBOX_CO_API_KEY: "key_test_a" }))).toMatch(/key_live_/);
  });
});
