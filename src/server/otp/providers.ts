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
    await sendEmail({
      to,
      subject: `${code} is your Gokesari sign-in code`,
      text:
        `Your Gokesari sign-in code is ${code}.\n\n` +
        `It works once and expires in ${expiryMinutes} minutes. ` +
        `If you did not ask for it, ignore this email — nobody can sign in without the code.\n`,
      html:
        `<p>Your Gokesari sign-in code is</p>` +
        `<p style="font-size:28px;letter-spacing:6px;font-weight:600">${code}</p>` +
        `<p style="color:#666;font-size:12px">It works once and expires in ${expiryMinutes} minutes. ` +
        `If you did not ask for it, ignore this email.</p>`,
    });
  },
};

/** No SMS vendor is wired up yet (decision D2). Replace the body when one is chosen. */
export function smsProvider(): OtpProvider | null {
  return null;
}

export function getProvider(channel: OtpChannel): OtpProvider | null {
  return channel === "EMAIL" ? emailOtpProvider : smsProvider();
}
