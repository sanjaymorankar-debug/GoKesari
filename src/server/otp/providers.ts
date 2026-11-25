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
import { renderEmailChangeOtpEmail, renderOtpEmail } from "@/server/notifications/templates";
import { getRule } from "@/server/services/settings";

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

/** The SMS text of every one-time code; the same wording as the DLT template (docs/sms-2fa-2026-11/DLT_SETUP.md). */
export function smsOtpText(code: string, expiryMinutes: number): string {
  return `${code} is your GoKesari code. It expires in ${expiryMinutes} minutes. Do not share it with anyone. -GoKesari`;
}

/**
 * The mock outbox (SMS_PROVIDER=mock, test site only): testers read the code
 * at /admin/test-messages (or GET /api/admin/test-messages).
 */
const mockSmsOtpProvider: OtpProvider = {
  channel: "SMS",
  isAvailable: () => smsOtpMode() === "mock",
  async send({ to, code, expiryMinutes }) {
    await sendText("SMS", to, smsOtpText(code, expiryMinutes), "otp");
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

export function smsProvider(): OtpProvider | null {
  if (msg91OtpProvider.isAvailable()) return msg91OtpProvider;
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
