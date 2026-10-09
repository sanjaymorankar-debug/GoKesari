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
import { isTextChannelAvailable, sendText } from "@/server/messaging/sms-whatsapp";
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

export function smsProvider(): OtpProvider | null {
  return textOtpProvider.isAvailable() ? textOtpProvider : null;
}

export function getProvider(channel: OtpChannel): OtpProvider | null {
  return channel === "EMAIL" ? emailOtpProvider : smsProvider();
}
