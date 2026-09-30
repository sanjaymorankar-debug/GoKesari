/**
 * OTP delivery abstraction.
 *
 *   OTP service → EmailOtpProvider   (live)
 *   OTP service → SmsOtpProvider     (interface ready; no vendor chosen)
 *
 * A vendor (MSG91, Twilio, ...) is added by implementing `OtpProvider` and
 * registering it in `smsProvider()`; nothing else changes. Until then SMS
 * reports itself unavailable and the sign-in screen offers email only.
 */
import { sendEmail } from "@/server/email/transport";
import { renderOtpEmail } from "@/server/notifications/templates";

export type OtpChannel = "EMAIL" | "SMS";

export interface OtpMessage {
  /** Email address (EMAIL) or E.164 number (SMS). */
  to: string;
  code: string;
  expiryMinutes: number;
}

export interface OtpProvider {
  readonly channel: OtpChannel;
  isAvailable(): boolean;
  send(message: OtpMessage): Promise<void>;
}

export const emailOtpProvider: OtpProvider = {
  channel: "EMAIL",
  isAvailable: () => true,
  async send({ to, code, expiryMinutes }) {
    // Sent directly, never queued: a code must not sit in the notification tables.
    await sendEmail({ to, ...renderOtpEmail(code, expiryMinutes) });
  },
};

/** No SMS vendor is wired up yet (decision D2). Replace the body when one is chosen. */
export function smsProvider(): OtpProvider | null {
  return null;
}

export function getProvider(channel: OtpChannel): OtpProvider | null {
  return channel === "EMAIL" ? emailOtpProvider : smsProvider();
}
