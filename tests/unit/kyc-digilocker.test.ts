/**
 * Rider Aadhaar by DigiLocker (Sandbox.co.in DigiLocker API): the response
 * readers, the adapter's calls (request shapes, Sandbox's 400 / 404 / 521 /
 * 523 answers), the Aadhaar XML reader, the webhook signature and the mock.
 * Response bodies are Sandbox's own examples from its KYC OpenAPI spec
 * (developer.sandbox.co.in/api-reference/kyc/openapi.json, Oct 2026).
 */
import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearMockDigilocker,
  createMockAdapter,
  decideMockDigilocker,
  MOCK_DIGILOCKER_LAST4,
  MOCK_DIGILOCKER_OTHER_NAME,
} from "@/server/kyc/adapters/mock";
import {
  clearSandboxCoTokens,
  createSandboxCoAdapter,
  parseDigilockerInit,
  parseDigilockerProfile,
  parseDigilockerSession,
  parseDigilockerStatus,
  pickAadhaarXmlUrl,
  readAadhaarXml,
} from "@/server/kyc/adapters/sandbox-co";
import type { KycHttpOptions } from "@/server/kyc/http";
import { digilockerWebhookSessionId, verifySandboxSignature } from "@/server/kyc/sandbox-webhook";
import { KycConfigError, KycUnavailableError } from "@/server/kyc/types";

const fast: KycHttpOptions = { timeoutMs: 200, retries: 0, backoffMs: 1, sleep: async () => {} };
const creds = { apiKey: "key_test_abc", apiSecret: "secret_test_xyz", baseUrl: "https://sbx.test" };

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const INIT_OK = {
  code: 200,
  timestamp: 1751975600361,
  data: {
    "@entity": "in.co.sandbox.kyc.digilocker.session.response",
    authorization_url: "https://digilocker.meripehchaan.gov.in/public/oauth2/1/authorize?response_type=code&client_id=IW55C7A3B0&req_doctype=ADHAR",
    session_id: "f1bd0342-cc1d-4051-8301-e8ee17e3a3c3",
  },
  transaction_id: "a11c4e00-fae1-4092-a55f-b4f0be92ffeb",
};

const session = (status: string, extra: object = {}) => ({
  code: 200,
  timestamp: 1752580258171,
  data: { id: "839fd8a0-d645-42e1-a904-bb43353b0139", created_at: 1752579445983, "@entity": "in.co.sandbox.kyc.digilocker.session", status, ...extra },
  transaction_id: "800ff751-2191-4b7d-b20a-8301790a3e19",
});

const DOC_OK = {
  code: 200,
  timestamp: 1751975529441,
  data: {
    files: [
      {
        "@entity": "org.quicko.drive.file",
        url: "https://in-co-sandbox-kyc-digilocker-dev.s3.ap-south-1.amazonaws.com/non-persistent/x/in.gov.uidai-ADHAR-0d5f.xml?X-Amz-Signature=abc",
        size: 16598,
        metadata: { ContentType: "application/xml", issuer_id: "in.gov.uidai", issuer: "Unique Identification Authority of India (UIDAI)", LastModified: "09/05/2025", description: "Aadhaar Card" },
      },
    ],
  },
  transaction_id: "a4d43b74-0f9c-480c-9300-f011100b674b",
};

const PROFILE_OK = {
  code: 200,
  timestamp: 1744874068219,
  data: {
    id: "b5522c8f-2321-577b-8e73-ae1366d9c591",
    "@entity": "in.co.sandbox.kyc.digilocker.user.profile",
    date_of_birth: 1071145000000,
    mobile: "9825013730",
    name: "Kaival Mehta",
    gender: "male",
    eaadhaar: true,
  },
  transaction_id: "0793c784-fcaa-44d9-b8fc-f6a382a67f70",
};

/** The shape of UIDAI's Aadhaar as DigiLocker issues it (values made up). */
const AADHAAR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Certificate language="99" name="Aadhaar Card" type="ADHAR" number="" issueDate="01012025">
  <IssuedBy><Organization name="UIDAI" code="UIDAI" tin="" uid="" type="CG"/></IssuedBy>
  <IssuedTo><Person name="Ravi Kumar" dob="01-01-1990" gender="M" uid="xxxxxxxx1234"><Photo format="jpeg">/9j/4AAQ</Photo></Person></IssuedTo>
  <CertificateData><KycRes ret="Y"><UidData uid="xxxxxxxx1234"><Poi dob="01-01-1990" gender="M" name="Ravi Kumar"/><Poa co="S/O Ram" pc="411001" vtc="Pune"/></UidData></KycRes></CertificateData>
</Certificate>`;

afterEach(() => {
  clearSandboxCoTokens();
  clearMockDigilocker();
});

describe("DigiLocker response readers", () => {
  it("session init: session id and the DigiLocker link", () => {
    expect(parseDigilockerInit(INIT_OK)).toEqual({
      sessionId: "f1bd0342-cc1d-4051-8301-e8ee17e3a3c3",
      authorizationUrl: INIT_OK.data.authorization_url,
      providerRef: "a11c4e00-fae1-4092-a55f-b4f0be92ffeb",
    });
    expect(() => parseDigilockerInit({ code: 200, data: { session_id: "x" } })).toThrow(KycConfigError);
    expect(() => parseDigilockerInit({ code: 200, data: { session_id: "x", authorization_url: "http://plain" } })).toThrow(KycConfigError);
  });

  it("session status: the four documented states; documents only on succeeded", () => {
    expect(parseDigilockerStatus(session("created"))).toMatchObject({ status: "created", documentsConsented: [] });
    expect(parseDigilockerStatus(session("succeeded", { documents_consented: ["aadhaar", "pan"] }))).toMatchObject({
      status: "succeeded",
      documentsConsented: ["aadhaar", "pan"],
    });
    expect(parseDigilockerStatus(session("failed"))).toMatchObject({ status: "failed" });
    expect(parseDigilockerStatus(session("expired"))).toMatchObject({ status: "expired" });
    expect(() => parseDigilockerStatus(session("weird"))).toThrow(KycConfigError);
  });

  it("the webhook's data is the same session object", () => {
    const hook = { data: { id: "839fd8a0-d645-42e1-a904-bb43353b0139", created_at: 1, updated_at: 2, "@entity": "in.co.sandbox.kyc.digilocker.session", status: "succeeded", documents_consented: ["aadhaar"] } };
    expect(parseDigilockerSession(hook.data)).toMatchObject({ sessionId: hook.data.id, status: "succeeded", documentsConsented: ["aadhaar"] });
    expect(digilockerWebhookSessionId(hook)).toBe(hook.data.id);
    expect(digilockerWebhookSessionId({ data: { id: "<script>" } })).toBeNull();
    expect(digilockerWebhookSessionId("nope")).toBeNull();
  });

  it("document: the UIDAI XML link, preferred over other files; none when only a PDF", () => {
    expect(pickAadhaarXmlUrl(DOC_OK)).toBe(DOC_OK.data.files[0].url);
    const pdfOnly = { data: { files: [{ url: "https://s3/x.pdf", metadata: { ContentType: "application/pdf", issuer_id: "in.gov.uidai" } }] } };
    expect(pickAadhaarXmlUrl(pdfOnly)).toBeNull();
    const two = { data: { files: [{ url: "https://s3/other.xml", metadata: { ContentType: "text/xml", issuer_id: "x" } }, DOC_OK.data.files[0]] } };
    expect(pickAadhaarXmlUrl(two)).toBe(DOC_OK.data.files[0].url);
    expect(() => pickAadhaarXmlUrl({ data: {} })).toThrow(KycConfigError);
  });

  it("profile: only the DigiLocker id and the name come out", () => {
    expect(parseDigilockerProfile(PROFILE_OK)).toEqual({ holderId: "b5522c8f-2321-577b-8e73-ae1366d9c591", name: "Kaival Mehta" });
  });

  it("Aadhaar XML: the name and the last four digits only", () => {
    expect(readAadhaarXml(AADHAAR_XML)).toEqual({ name: "Ravi Kumar", last4: "1234" });
    expect(readAadhaarXml(`<Person name="A &amp; B" uid="xxxx xxxx 9876"/>`)).toEqual({ name: "A & B", last4: "9876" });
    expect(readAadhaarXml("<nothing/>")).toEqual({ name: null, last4: null });
  });
});

describe("Sandbox DigiLocker adapter calls", () => {
  type Seen = { method: string; url: string; body: unknown; headers: Record<string, string> };
  function adapterWith(routes: (url: string, method: string) => Response) {
    const seen: Seen[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seen.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.endsWith("/authenticate")) return respond(200, { data: { access_token: "tok" } });
      return routes(url, method);
    }) as typeof fetch;
    return { adapter: createSandboxCoAdapter(creds, { ...fast, fetchImpl }).digilocker!, seen };
  }

  it("starts a session with the documented body: Aadhaar only, our return link, consent expiry", async () => {
    const { adapter, seen } = adapterWith(() => respond(200, INIT_OK));
    const out = await adapter.startSession({ redirectUrl: "https://test.gokesari.com/mobile-auth/digilocker-return?k=abc", consentExpiryMs: 1_800_000_000_000 }, "idem-1");
    expect(out.sessionId).toBe(INIT_OK.data.session_id);
    const call = seen.find((s) => s.url.endsWith("/kyc/digilocker/sessions/init"))!;
    expect(call.method).toBe("POST");
    expect(call.headers).toMatchObject({ authorization: "tok", "x-api-key": "key_test_abc" });
    expect(call.body).toEqual({
      "@entity": "in.co.sandbox.kyc.digilocker.session.request",
      flow: "signin",
      redirect_url: "https://test.gokesari.com/mobile-auth/digilocker-return?k=abc",
      doc_types: ["aadhaar"],
      purpose: "Delivery partner KYC",
      requestor_name: "GoKesari",
      consent_expiry: 1_800_000_000_000,
    });
    // DigiLocker accepts letters, digits, spaces and underscores only.
    expect(call.body).toMatchObject({ purpose: expect.stringMatching(/^[A-Za-z0-9_ ]+$/), requestor_name: expect.stringMatching(/^[A-Za-z0-9_ ]+$/) });
  });

  it("status is a GET; 521 (no such session) is null; 503 is the vendor being down", async () => {
    const ok = adapterWith(() => respond(200, session("succeeded", { documents_consented: ["aadhaar"] })));
    expect(await ok.adapter.sessionStatus("s-1")).toMatchObject({ status: "succeeded" });
    expect(ok.seen.at(-1)).toMatchObject({ method: "GET", url: "https://sbx.test/kyc/digilocker/sessions/s-1/status" });
    expect(await adapterWith(() => respond(521, { code: 521, message: "Data not found for: s-1" })).adapter.sessionStatus("s-1")).toBeNull();
    await expect(adapterWith(() => respond(503, { code: 503, message: "Source Unavailable" })).adapter.sessionStatus("s-1")).rejects.toBeInstanceOf(KycUnavailableError);
  });

  it("fetches the Aadhaar: XML read in memory, profile id kept, nothing else", async () => {
    const { adapter, seen } = adapterWith((url) => {
      if (url.includes("/documents/aadhaar")) return respond(200, DOC_OK);
      if (url.includes("/user/profile")) return respond(200, PROFILE_OK);
      if (url.includes("amazonaws.com")) return new Response(AADHAAR_XML, { status: 200, headers: { "Content-Type": "application/xml" } });
      return respond(500);
    });
    expect(await adapter.fetchAadhaar("s-1")).toEqual({
      kind: "found",
      name: "Ravi Kumar",
      last4: "1234",
      holderId: "b5522c8f-2321-577b-8e73-ae1366d9c591",
      providerRef: DOC_OK.transaction_id,
    });
    // The pre-signed file link gets no Sandbox credentials.
    const file = seen.find((s) => s.url.includes("amazonaws.com"))!;
    expect(file.headers).not.toHaveProperty("authorization");
  });

  it("no consent (400), not in DigiLocker (404), session unusable (523)", async () => {
    const no = adapterWith(() => respond(400, { code: 400, message: "Consent for aadhaar not provided" }));
    expect(await no.adapter.fetchAadhaar("s")).toMatchObject({ kind: "not_shared", reason: "no_consent" });
    const missing = adapterWith(() => respond(404, { code: 404, message: "Doctype not found", transaction_id: "t" }));
    expect(await missing.adapter.fetchAadhaar("s")).toMatchObject({ kind: "not_shared", reason: "not_in_digilocker" });
    const gone = adapterWith(() => respond(523, { code: 523, message: "Session expired", transaction_id: "t" }));
    expect(await gone.adapter.fetchAadhaar("s")).toMatchObject({ kind: "session_unusable" });
  });
});

describe("Sandbox webhook signature", () => {
  const secret = "whsec_test_0123456789abcdef";
  const payload = { data: { id: "839fd8a0-d645-42e1-a904-bb43353b0139", status: "failed" } };
  const sig = (text: string, key = secret) => createHmac("sha256", key).update(text).digest("base64");

  it("accepts Sandbox's documented signature (base64 HMAC-SHA256 of JSON.stringify(payload))", () => {
    const pretty = JSON.stringify(payload, null, 2); // bytes on the wire may be formatted differently
    expect(verifySandboxSignature(pretty, sig(JSON.stringify(payload)), secret)).toBe(true);
    expect(verifySandboxSignature(JSON.stringify(payload), sig(JSON.stringify(payload)), secret)).toBe(true);
  });

  it("refuses a wrong, missing or other-key signature", () => {
    expect(verifySandboxSignature(JSON.stringify(payload), null, secret)).toBe(false);
    expect(verifySandboxSignature(JSON.stringify(payload), "", secret)).toBe(false);
    expect(verifySandboxSignature(JSON.stringify(payload), sig(JSON.stringify(payload), "another_secret_value"), secret)).toBe(false);
    expect(verifySandboxSignature(JSON.stringify({ ...payload, x: 1 }), sig(JSON.stringify(payload)), secret)).toBe(false);
  });
});

describe("mock DigiLocker", () => {
  const dl = createMockAdapter().digilocker!;
  const start = () => dl.startSession({ redirectUrl: "http://localhost:3000/mobile-auth/digilocker-return?k=x", consentExpiryMs: Date.now() + 7_200_000 }, "k");

  it("links to the local consent page on the same site; waits until a button is pressed", async () => {
    const s = await start();
    expect(s.authorizationUrl).toMatch(/^http:\/\/localhost:3000\/mobile-auth\/digilocker-mock\?session=mock-dl-/);
    expect(await dl.sessionStatus(s.sessionId)).toMatchObject({ status: "created" });
    expect(await dl.sessionStatus("unknown")).toBeNull();
  });

  it("approve / mismatch / deny / expire / down", async () => {
    const a = await start();
    expect(decideMockDigilocker(a.sessionId, "approve")).toContain("/mobile-auth/digilocker-return?k=x");
    expect(await dl.sessionStatus(a.sessionId)).toMatchObject({ status: "succeeded", documentsConsented: ["aadhaar"] });
    expect(await dl.fetchAadhaar(a.sessionId)).toMatchObject({ kind: "found", name: null, last4: MOCK_DIGILOCKER_LAST4 });

    const m = await start();
    decideMockDigilocker(m.sessionId, "mismatch");
    expect(await dl.fetchAadhaar(m.sessionId)).toMatchObject({ kind: "found", name: MOCK_DIGILOCKER_OTHER_NAME });

    const d = await start();
    decideMockDigilocker(d.sessionId, "deny");
    expect(await dl.sessionStatus(d.sessionId)).toMatchObject({ status: "failed" });
    expect(await dl.fetchAadhaar(d.sessionId)).toMatchObject({ kind: "session_unusable" });

    const e = await start();
    decideMockDigilocker(e.sessionId, "expire");
    expect(await dl.sessionStatus(e.sessionId)).toMatchObject({ status: "expired" });

    const down = await start();
    decideMockDigilocker(down.sessionId, "down");
    await expect(dl.sessionStatus(down.sessionId)).rejects.toBeInstanceOf(KycUnavailableError);
    expect(decideMockDigilocker("nope", "approve")).toBeNull();
  });
});
