/** Owner, 28-Nov-2026: on the test site (mock SMS) the mobile code is also e-mailed to the account. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ texts: [] as string[], emails: [] as { to: string; subject: string; keepRecipient?: boolean }[], copy: "true", mode: "mock" }));

vi.mock("@/server/messaging/sms-whatsapp", () => ({
  smsOtpMode: () => sent.mode,
  sendText: async (_c: string, to: string, body: string) => {
    sent.texts.push(`${to}:${body}`);
    return { providerRef: "x" };
  },
}));
vi.mock("@/server/email/transport", () => ({
  sendEmail: async (m: { to: string; subject: string; keepRecipient?: boolean }) => {
    sent.emails.push(m);
  },
}));
vi.mock("@/lib/env", async (orig) => ({ ...(await orig<typeof import("@/lib/env")>()), getEnv: () => ({ SMS_MOCK_EMAIL_COPY: sent.copy }) }));
vi.mock("@/server/services/settings", () => ({ getRule: async () => ({ smsEnabled: true }) }));

import { getProvider } from "@/server/otp/providers";

beforeEach(() => {
  sent.texts = [];
  sent.emails = [];
  sent.copy = "true";
  sent.mode = "mock";
});

describe("test-site mobile code e-mail copy", () => {
  it("TC-OTP-COPY-001: mock SMS writes the outbox and e-mails the same code to the account", async () => {
    await getProvider("SMS")!.send({ to: "+919800000001", code: "482913", expiryMinutes: 10, accountEmail: "owner@example.com" });
    expect(sent.texts[0]).toContain("482913");
    expect(sent.emails).toHaveLength(1);
    expect(sent.emails[0]).toMatchObject({ to: "owner@example.com", keepRecipient: true });
    expect(sent.emails[0].subject).toMatch(/^482913 is your Gokesari mobile code/);
  });

  it("TC-OTP-COPY-002: no copy to a placeholder address, without an e-mail, or with the switch off", async () => {
    const p = getProvider("SMS")!;
    await p.send({ to: "+919800000001", code: "111111", expiryMinutes: 10, accountEmail: "m919800000001@no-email.gokesari.invalid" });
    await p.send({ to: "+919800000001", code: "222222", expiryMinutes: 10 });
    sent.copy = "false";
    await p.send({ to: "+919800000001", code: "333333", expiryMinutes: 10, accountEmail: "owner@example.com" });
    expect(sent.texts).toHaveLength(3);
    expect(sent.emails).toHaveLength(0);
  });
});
