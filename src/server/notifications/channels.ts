/**
 * Outbound channel providers.
 *
 *   notification → EmailChannel      (live: SMTP, see email/transport.ts)
 *   notification → SMS / PUSH / WHATSAPP  (seams — no vendor chosen yet)
 *
 * To add a vendor, implement `ChannelProvider` and return it from
 * `getChannelProvider`. Nothing else changes: preferences, retries, the
 * delivery log and templates already handle every channel.
 */
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { EmailUnavailableError, emailMode, sendEmail } from "@/server/email/transport";
import { isTextChannelAvailable, MessagingUnavailableError, sendText, textFromNotification, type TextChannel } from "@/server/messaging/sms-whatsapp";
import type { OutboundChannel } from "./templates";

export interface ChannelRecipient {
  email: string | null;
  phoneE164: string | null;
}

export interface ChannelMessage {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  actionUrl?: string | null;
}

export interface ChannelProvider {
  readonly channel: OutboundChannel;
  isAvailable(): boolean;
  /** Where this channel would send for a user, or null when the user has no address for it. */
  addressFor(recipient: ChannelRecipient): string | null;
  send(message: ChannelMessage): Promise<{ providerRef?: string }>;
}

/** Thrown by a provider for "cannot send, and retrying will not help" (mark the delivery skipped). */
export class ChannelUnavailableError extends Error {}

export const emailChannel: ChannelProvider = {
  channel: "EMAIL",
  isAvailable: () => emailMode() !== "disabled",
  // Module 3: an account made from a mobile number alone has no real email.
  addressFor: (r) => (r.email && !isPlaceholderEmail(r.email) ? r.email : null),
  async send(message) {
    try {
      await sendEmail({ to: message.to, subject: message.subject, text: message.text, html: message.html ?? undefined });
    } catch (error) {
      if (error instanceof EmailUnavailableError) throw new ChannelUnavailableError(error.message);
      throw error;
    }
    return {};
  },
};

/** Module 3: SMS and WhatsApp through server/messaging (mock on the test site until a vendor is chosen). */
function textChannel(channel: TextChannel): ChannelProvider {
  return {
    channel,
    isAvailable: () => isTextChannelAvailable(channel),
    addressFor: (r) => r.phoneE164,
    async send(message) {
      try {
        return await sendText(channel, message.to, textFromNotification(message.subject, message.text, message.actionUrl), "notification");
      } catch (error) {
        if (error instanceof MessagingUnavailableError) throw new ChannelUnavailableError(error.message);
        throw error;
      }
    },
  };
}

export const smsChannel = textChannel("SMS");
export const whatsappChannel = textChannel("WHATSAPP");

export function getChannelProvider(channel: OutboundChannel): ChannelProvider | null {
  switch (channel) {
    case "EMAIL":
      return emailChannel;
    case "SMS":
      return smsChannel;
    case "WHATSAPP":
      return whatsappChannel;
    // A PUSH provider plugs in here once chosen.
    default:
      return null;
  }
}
