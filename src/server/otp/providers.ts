/**
 * OTP delivery abstraction.
 *
 *   OTP service → getOtpProvider("EMAIL") → EmailOtpProvider   (live — the channel today)
 *   OTP service → getOtpProvider("SMS")   → SMS through server/messaging (mock outbox on the
 *                                           test site), only when SMS_PROVIDER is set AND
 *                                           rule otp.smsEnabled is on
 *                                         → SmsOtpProvider (Phase 2 stub: no vendor chosen)
 *
 * A vendor (MSG91, Twilio, ...) is added by implementing `OtpProvider` (see
 * SmsOtpProvider below) and registering it in `smsProvider()`; nothing else
 * changes. Until then SMS reports itself unavailable and the sign-in screen
 * offers email only.
 */
import { sendEmail } from "@/server/email/transport";
import { isTextChannelAvailable, sendText } from "@/server/messaging/sms-whatsapp";
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
}

export interface OtpProvider {
  readonly channel: OtpChannel;
  isAvailable(): boolean;
  send(message: OtpMessage): Promise<void>;
}

export const emailOtpProvider: OtpProvider = {
  channel: "EMAIL",
  isAvailable: () => true,
  async send({ to, code, expiryMinutes, purpose }) {
    // Sent directly, never queued: a code must not sit in the notification tables.
    const message = purpose === "EMAIL_CHANGE" ? renderEmailChangeOtpEmail(code, expiryMinutes) : renderOtpEmail(code, expiryMinutes);
    await sendEmail({ to, ...message });
  },
};

/**
 * SMS through server/messaging (Module 3): available when SMS_PROVIDER is set
 * (mock on the test site until a vendor is chosen — decision D2 still open).
 */
const textOtpProvider: OtpProvider = {
  channel: "SMS",
  isAvailable: () => isTextChannelAvailable("SMS"),
  async send({ to, code, expiryMinutes }) {
    await sendText("SMS", to, `${code} is your GoKesari code. It expires in ${expiryMinutes} minutes. Do not share it with anyone.`, "otp");
  },
};

/**
 * PHASE 2 — the real SMS vendor adapter (F1.1.2 / GS-001). No vendor is
 * chosen yet (decision D2), so it is never available and never sends. When
 * one is chosen: implement `send` with the vendor's API (DLT-registered
 * template, sender id), read its keys from the environment, make
 * `isAvailable` check them, and return it from `smsProvider()`.
 */
export class SmsOtpProvider implements OtpProvider {
  readonly channel = "SMS" as const;

  isAvailable(): boolean {
    return false;
  }

  async send(): Promise<void> {
    throw new Error("SMS one-time codes are a Phase 2 feature: no SMS vendor is configured.");
  }
}

export const phase2SmsOtpProvider: OtpProvider = new SmsOtpProvider();

export function smsProvider(): OtpProvider | null {
  if (phase2SmsOtpProvider.isAvailable()) return phase2SmsOtpProvider;
  return textOtpProvider.isAvailable() ? textOtpProvider : null;
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
