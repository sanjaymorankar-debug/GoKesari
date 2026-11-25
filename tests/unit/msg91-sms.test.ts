/**
 * docs/sms-2fa-2026-11: the MSG91 SMS provider (request shape, refusals,
 * timeouts, no code or full number in logs) and rule checkoutOtp parsing.
 * fetch is mocked: nothing reaches MSG91.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getEnv, msg91ConfigProblem, type ServerEnv } from "@/lib/env";
import { RULES } from "@/server/config/rules";
import { buildMsg91OtpRequest, isMsg91Available, Msg91Error, sendMsg91Otp } from "@/server/messaging/msg91";

const base = getEnv();
const msg91 = (extra: Partial<ServerEnv> = {}) =>
  ({
    ...base,
    SMS_PROVIDER: "msg91",
    MSG91_AUTH_KEY: "test-auth-key",
    MSG91_SENDER_ID: "goksri",
    MSG91_OTP_TEMPLATE_ID: "tmpl-123",
    MSG91_DLT_TE_ID: undefined,
    MSG91_API_URL: "https://control.msg91.com/api/v5/flow",
    ...extra,
  }) as ServerEnv;

const input = { toE164: "+919876543210", code: "482913", expiryMinutes: 5 };

afterEach(() => vi.restoreAllMocks());

describe("MSG91 configuration", () => {
  it("is refused unless SMS_PROVIDER=msg91 and every key is set", () => {
    expect(msg91ConfigProblem(msg91())).toBeNull();
    expect(isMsg91Available(msg91())).toBe(true);
    expect(msg91ConfigProblem(msg91({ SMS_PROVIDER: "mock" }))).toMatch(/not "msg91"/);
    expect(msg91ConfigProblem(msg91({ MSG91_AUTH_KEY: "" }))).toMatch(/MSG91_AUTH_KEY/);
    expect(msg91ConfigProblem(msg91({ MSG91_OTP_TEMPLATE_ID: undefined, MSG91_SENDER_ID: undefined }))).toMatch(/MSG91_SENDER_ID, MSG91_OTP_TEMPLATE_ID/);
    expect(msg91ConfigProblem(msg91({ MSG91_SENDER_ID: "GOK1" }))).toMatch(/6-letter/);
    expect(isMsg91Available(msg91({ MSG91_AUTH_KEY: undefined }))).toBe(false);
  });
});

describe("MSG91 request shaping", () => {
  it("fills the DLT template's ##otp## and ##minutes##, with the sender header and auth key in the header", () => {
    const request = buildMsg91OtpRequest(input, msg91());
    expect(request.url).toBe("https://control.msg91.com/api/v5/flow");
    expect(request.headers).toMatchObject({ authkey: "test-auth-key", "content-type": "application/json" });
    expect(request.body).toEqual({
      template_id: "tmpl-123",
      sender: "GOKSRI",
      short_url: "0",
      recipients: [{ mobiles: "919876543210", otp: "482913", minutes: "5" }],
    });
  });

  it("adds DLT_TE_ID only when it is configured", () => {
    expect(buildMsg91OtpRequest(input, msg91({ MSG91_DLT_TE_ID: "1107170000000000001" })).body.DLT_TE_ID).toBe("1107170000000000001");
  });

  it("refuses a non-Indian number, a malformed code, or a missing key", () => {
    expect(() => buildMsg91OtpRequest({ ...input, toE164: "+14155550100" }, msg91())).toThrow(Msg91Error);
    expect(() => buildMsg91OtpRequest({ ...input, code: "12ab" }, msg91())).toThrow(/4 to 8 digits/);
    expect(() => buildMsg91OtpRequest(input, msg91({ MSG91_AUTH_KEY: undefined }))).toThrow(/not set up/);
  });
});

describe("MSG91 sending", () => {
  it("posts the request and returns MSG91's request id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ type: "success", message: "3567696c6f4b393739333432" }), { status: 200 }));
    const result = await sendMsg91Otp(input, { env: msg91(), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.providerRef).toBe("msg91:3567696c6f4b393739333432");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://control.msg91.com/api/v5/flow");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toMatchObject({ template_id: "tmpl-123", recipients: [{ otp: "482913" }] });
  });

  it("treats an error reply as a failure and never logs the code or the full number", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ type: "error", message: "Template not approved" }), { status: 200 }));
    await expect(sendMsg91Otp(input, { env: msg91(), fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(Msg91Error);
    const text = logged.mock.calls.flat().join(" ");
    expect(text).toContain("3210");
    expect(text).not.toContain("9876543210");
    expect(text).not.toContain("482913");
  });

  it("fails on an HTTP error and on a timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const http500 = vi.fn(async () => new Response("oops", { status: 500 }));
    await expect(sendMsg91Otp(input, { env: msg91(), fetchImpl: http500 as unknown as typeof fetch })).rejects.toThrow(/HTTP 500/);
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    await expect(sendMsg91Otp(input, { env: msg91(), fetchImpl: hang as unknown as typeof fetch, timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});

describe("rule checkoutOtp", () => {
  it("is off by default, every checkout, 12 hours", () => {
    expect(RULES.checkoutOtp.defaults).toEqual({ enabled: false, mode: "every_checkout", hours: 12 });
    expect(RULES.checkoutOtp.schema.parse(RULES.checkoutOtp.defaults)).toEqual(RULES.checkoutOtp.defaults);
  });

  it("accepts once_per_hours with 1–720 hours and refuses anything else", () => {
    expect(RULES.checkoutOtp.schema.safeParse({ enabled: true, mode: "once_per_hours", hours: 24 }).success).toBe(true);
    expect(RULES.checkoutOtp.schema.safeParse({ enabled: true, mode: "once_per_hours", hours: 0 }).success).toBe(false);
    expect(RULES.checkoutOtp.schema.safeParse({ enabled: true, mode: "daily", hours: 12 }).success).toBe(false);
    expect(RULES.checkoutOtp.schema.safeParse({ enabled: true, mode: "every_checkout", hours: 721 }).success).toBe(false);
  });
});
