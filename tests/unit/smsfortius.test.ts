/** SMSFortius (owner's DLT SMS vendor, 26-Nov-2026): URL, config checks, acceptance and safe logging. */
import { describe, expect, it, vi } from "vitest";

import type { ServerEnv } from "@/lib/env";
import { smsFortiusConfigProblem } from "@/lib/env";
import { buildSmsFortiusUrl, sendSmsFortiusText, SmsFortiusError, smsFortiusAccepted } from "@/server/messaging/smsfortius";
import { smsOtpText } from "@/server/otp/providers";

const KEY = "test-key-not-real";
const env = (over: Partial<ServerEnv> = {}) =>
  ({
    SMS_PROVIDER: "smsfortius",
    SMSFORTIUS_API_KEY: KEY,
    SMSFORTIUS_SENDER_ID: "goksri",
    SMSFORTIUS_OTP_TEMPLATE_ID: "1207176000000000001",
    SMSFORTIUS_API_URL: "https://smsfortius.org/V2/apikey.php",
    ...over,
  }) as ServerEnv;

describe("SMSFortius config", () => {
  it("needs the provider, the key, a 6-letter sender and a numeric DLT template id", () => {
    expect(smsFortiusConfigProblem(env())).toBeNull();
    expect(smsFortiusConfigProblem(env({ SMS_PROVIDER: "none" }))).toMatch(/not "smsfortius"/);
    expect(smsFortiusConfigProblem(env({ SMSFORTIUS_API_KEY: " " }))).toMatch(/SMSFORTIUS_API_KEY/);
    expect(smsFortiusConfigProblem(env({ SMSFORTIUS_SENDER_ID: "GOKESARI" }))).toMatch(/6-letter/);
    expect(smsFortiusConfigProblem(env({ SMSFORTIUS_OTP_TEMPLATE_ID: "abc" }))).toMatch(/template id/);
  });
});

describe("SMSFortius request", () => {
  it("sends the DLT template text to the 10-digit number with the sender and template ids", () => {
    const text = smsOtpText("482913", 5);
    const url = new URL(buildSmsFortiusUrl({ toE164: "+919876543210", text }, env()));
    expect(url.origin + url.pathname).toBe("https://smsfortius.org/V2/apikey.php");
    expect(url.searchParams.get("apikey")).toBe(KEY);
    expect(url.searchParams.get("senderid")).toBe("GOKSRI");
    expect(url.searchParams.get("templateid")).toBe("1207176000000000001");
    expect(url.searchParams.get("number")).toBe("9876543210");
    expect(url.searchParams.get("message")).toBe("Dear Customer, your GoKesari account verification OTP is 482913. This OTP is valid for 5 minutes. Please do not share it with anyone. - Team GoKesari");
    // Spaces travel as %20 (never a raw space, which cut the text to "Dear" in a hand-made test on 27-Nov-2026).
    expect(buildSmsFortiusUrl({ toE164: "+919876543210", text }, env())).toContain("message=Dear%20Customer%2C%20your%20GoKesari");
  });

  it("refuses a non-Indian number and an unset provider", () => {
    expect(() => buildSmsFortiusUrl({ toE164: "+447700900123", text: "x" }, env())).toThrow(SmsFortiusError);
    expect(() => buildSmsFortiusUrl({ toE164: "+919876543210", text: "x" }, env({ SMSFORTIUS_API_KEY: "" }))).toThrow(/not set up/);
  });

  it("reads the answer: 2xx without an error word is accepted", () => {
    expect(smsFortiusAccepted(200, '{"status":"OK","message":"Message Submitted","data":[{"id":"abc"}]}')).toBe(true);
    expect(smsFortiusAccepted(200, "Message Submitted Successfully")).toBe(true);
    expect(smsFortiusAccepted(200, '{"status":"ERROR","message":"Invalid Template ID"}')).toBe(false);
    expect(smsFortiusAccepted(200, "Insufficient balance")).toBe(false);
    expect(smsFortiusAccepted(500, "OK")).toBe(false);
  });
});

describe("SMSFortius send", () => {
  it("returns a reference on success and never logs the key, the code or the full number", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("Message Submitted", { status: 200 }));
    const out = await sendSmsFortiusText({ toE164: "+919876543210", text: smsOtpText("482913", 5) }, { env: env(), fetchImpl: fetchImpl as never });
    expect(out.providerRef).toMatch(/^smsfortius:/);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const logged = info.mock.calls.flat().join(" ");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("482913");
    expect(logged).not.toContain("9876543210");
    info.mockRestore();
  });

  it("throws on a refusal and on a network failure, without the key in the log", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      sendSmsFortiusText({ toE164: "+919876543210", text: "x" }, { env: env(), fetchImpl: (async () => new Response("Invalid API key", { status: 200 })) as never }),
    ).rejects.toThrow(/refused/);
    await expect(
      sendSmsFortiusText({ toE164: "+919876543210", text: "x" }, { env: env(), fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as never }),
    ).rejects.toThrow(/network error/);
    expect(err.mock.calls.flat().join(" ")).not.toContain(KEY);
    err.mockRestore();
  });
});
