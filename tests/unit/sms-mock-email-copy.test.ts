/** Test site (owner, 28-Nov-2026): mock SMS are also e-mailed to SMS_MOCK_EMAIL_TO; never on gokesari.com. */
import { describe, expect, it } from "vitest";

import type { ServerEnv } from "@/lib/env";
import { mockSmsEmailSubject, mockSmsEmailTarget } from "@/server/messaging/sms-whatsapp";
import { smsOtpText } from "@/server/otp/providers";

const env = (over: Partial<ServerEnv> = {}) =>
  ({ NODE_ENV: "production", AUTH_URL: "https://test.gokesari.com", KYC_PRODUCTION_HOST: "gokesari.com", SMS_MOCK_EMAIL_TO: "testing@gokesari.com", ...over }) as ServerEnv;

describe("mock SMS e-mail copy", () => {
  it("goes to the test inbox on the test site", () => {
    expect(mockSmsEmailTarget(env())).toBe("testing@gokesari.com");
  });

  it("is off when unset or empty, and never on gokesari.com", () => {
    expect(mockSmsEmailTarget(env({ SMS_MOCK_EMAIL_TO: undefined }))).toBeNull();
    expect(mockSmsEmailTarget(env({ SMS_MOCK_EMAIL_TO: "" }))).toBeNull();
    expect(mockSmsEmailTarget(env({ AUTH_URL: "https://gokesari.com" }))).toBeNull();
    expect(mockSmsEmailTarget(env({ AUTH_URL: "https://www.gokesari.com" }))).toBeNull();
  });

  it("puts the one-time code in the subject", () => {
    expect(mockSmsEmailSubject("+919000012701", smsOtpText("962221", 5))).toBe("[test SMS to +919000012701] Code 962221");
    expect(mockSmsEmailSubject("+919000012701", "GoKesari: your shop is live.")).toBe("[test SMS to +919000012701] GoKesari: your shop is live.");
  });
});
