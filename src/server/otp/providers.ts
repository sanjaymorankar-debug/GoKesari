/**
 * OTP delivery abstraction.
 *
 *   OTP service → getOtpProvider("EMAIL") → EmailOtpProvider   (live — the main channel)
 *   OTP service → getOtpProvider("SMS")   → only when rule otp.smsEnabled is on, and
 *                                           SMS_PROVIDER=msg91 (with its keys) → Msg91 (SmsOtpProvider)
 *                                           SMS_PROVIDER=mock                   → mock outbox (test site)
 *                                           otherwise                           → none: email only
 *
 * docs/sms-2fa-2026-11: MSG91 is the real SMS vendor (DLT template, sender
 * header; keys from the environment). Another vendor is added by implementing
 * `OtpProvider` and registering it in `smsProvider()`; nothing else changes.
 */
import { sendEmail } from "@/server/email/transport";
import { sendText, smsOtpMode } from "@/server/messaging/sms-whatsapp";
import { Msg91Error, sendMsg91Otp } from "@/server/messaging/msg91";
import { SmsFortiusError, sendSmsFortiusText } from "@/server/messaging/smsfortius";
import { renderEmailChangeOtpEmail, renderMobileCodeCopyEmail, renderOtpEmail } from "@/server/notifications/templates";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { getRule } from "@/server/services/settings";
import { getEnv } from "@/lib/env";

export type OtpChannel = "EMAIL" | "SMS";

export interface OtpMessage {
  /** Email address (EMAIL) or E.164 number (SMS). */
  to: string;
  code: string;
  expiryMinutes: number;
  /** batch-2026-10 WS-A: which email wording to use (sign-in by default). */
  purpose?: "LOGIN" | "EMAIL_CHANGE";
  /** batch-2026-10 WS-D: a ready-made email for a purpose with its own wording (overrides `purpose`). */
  rendered?: { subject: string; text: string; html: string };
  /** SMS only: the account's e-mail. The test site's mock SMS also e-mails the mobile code there (owner, 28-Nov-2026). */
  accountEmail?: string;
}

export interface OtpProvider {
  readonly channel: OtpChannel;
  isAvailable(): boolean;
  send(message: OtpMessage): Promise<void>;
}

export const emailOtpProvider: OtpProvider = {
  channel: "EMAIL",
  isAvailable: () => true,
  async send({ to, code, expiryMinutes, purpose, rendered }) {
    // Sent directly, never queued: a code must not sit in the notification tables.
    const message =
      rendered ?? (purpose === "EMAIL_CHANGE" ? renderEmailChangeOtpEmail(code, expiryMinutes) : renderOtpEmail(code, expiryMinutes));
    // A sign-in code stays with its account even where the test site sends other mail to one inbox.
    await sendEmail({ to, ...message, keepRecipient: !rendered && purpose !== "EMAIL_CHANGE" });
  },
};

/**
 * The SMS text of every one-time code. It must be the DLT content template registered for sender GOKSRI, word for
 * word, with only its two {#var#} filled in — any other wording is rejected by the operator (SMSFortius error 633).
 * Registered template (owner, 27-Nov-2026; docs/sms-2fa-2026-11/DLT_SETUP.md):
 *   Dear Customer, your GoKesari account verification OTP is {#var#}. This OTP is valid for {#var#} minutes. Please do not share it with anyone. - Team GoKesari
 */
export function smsOtpText(code: string, expiryMinutes: number): string {
  return `Dear Customer, your GoKesari account verification OTP is ${code}. This OTP is valid for ${expiryMinutes} minutes. Please do not share it with anyone. - Team GoKesari`;
}

/** The code inside an SMS written by smsOtpText (test outbox readers); also reads the former wording. */
export function codeFromSmsOtpText(body: string): string | null {
  return body.match(/verification OTP is (\d{4,8})\./)?.[1] ?? body.match(/^(\d{4,8}) is your GoKesari code/)?.[1] ?? null;
}

/**
 * The mock outbox (SMS_PROVIDER=mock, test site only): testers read the code
 * at /admin/test-messages (or GET /api/admin/test-messages).
 *
 * Owner, 28-Nov-2026 ("switch test.gokesari.com to OTP on email … receive mobile and email authentication OTP on
 * email"): the mobile code is also e-mailed to the account's own address, so both codes of a sign-in or a mobile
 * check arrive in the inbox. The mock is refused on the production site (env check), so gokesari.com never does this.
 */
const mockSmsOtpProvider: OtpProvider = {
  channel: "SMS",
  isAvailable: () => smsOtpMode() === "mock",
  async send({ to, code, expiryMinutes, accountEmail }) {
    await sendText("SMS", to, smsOtpText(code, expiryMinutes), "otp");
    if (!accountEmail || isPlaceholderEmail(accountEmail) || getEnv().SMS_MOCK_EMAIL_COPY === "false") return;
    // A copy only: the outbox above already holds the code, so a mail failure does not fail the request.
    await sendEmail({ to: accountEmail, ...renderMobileCodeCopyEmail(code, expiryMinutes, to), keepRecipient: true }).catch((error: unknown) =>
      console.error("[otp] test-site mobile code e-mail failed", error),
    );
  },
};

/**
 * docs/sms-2fa-2026-11: the real SMS vendor, MSG91, with the DLT-approved OTP
 * template. Available only with SMS_PROVIDER=msg91 and all its keys.
 */
export class SmsOtpProvider implements OtpProvider {
  readonly channel = "SMS" as const;

  isAvailable(): boolean {
    return smsOtpMode() === "msg91";
  }

  async send({ to, code, expiryMinutes }: OtpMessage): Promise<void> {
    if (!this.isAvailable()) throw new Msg91Error("MSG91 is not set up on this server (SMS_PROVIDER and the MSG91_* keys).");
    await sendMsg91Otp({ toE164: to, code, expiryMinutes });
  }
}

export const msg91OtpProvider: OtpProvider = new SmsOtpProvider();
/** @deprecated the former Phase 2 stub's name; now the MSG91 provider. */
export const phase2SmsOtpProvider = msg91OtpProvider;

/**
 * SMSFortius (owner's DLT vendor, 26-Nov-2026): the same DLT-approved OTP text, sent through its V2 API.
 * Available only with SMS_PROVIDER=smsfortius and all its keys.
 */
export const smsFortiusOtpProvider: OtpProvider = {
  channel: "SMS",
  isAvailable: () => smsOtpMode() === "smsfortius",
  async send({ to, code, expiryMinutes }) {
    if (smsOtpMode() !== "smsfortius") throw new SmsFortiusError("SMSFortius is not set up on this server (SMS_PROVIDER and the SMSFORTIUS_* keys).");
    await sendSmsFortiusText({ toE164: to, text: smsOtpText(code, expiryMinutes) });
  },
};

export function smsProvider(): OtpProvider | null {
  if (msg91OtpProvider.isAvailable()) return msg91OtpProvider;
  if (smsFortiusOtpProvider.isAvailable()) return smsFortiusOtpProvider;
  return mockSmsOtpProvider.isAvailable() ? mockSmsOtpProvider : null;
}

export function getProvider(channel: OtpChannel): OtpProvider | null {
  return channel === "EMAIL" ? emailOtpProvider : smsProvider();
}

/**
 * batch-2026-10 WS-A: the provider the OTP service sends through. SMS needs
 * the environment (SMS_PROVIDER) AND rule otp.smsEnabled; email is always on.
 */
export async function getOtpProvider(channel: OtpChannel): Promise<OtpProvider | null> {
  if (channel === "SMS" && !(await getRule("otp")).smsEnabled) return null;
  return getProvider(channel);
}
