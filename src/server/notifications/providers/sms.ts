/**
 * Phase 2 stub (F13.1.2, GS-074): the SMS provider contract.
 *
 * SMS already goes through the one notification service today: notify() queues
 * an SMS delivery in notification_deliveries and channels.ts sends it with
 * server/messaging/sms-whatsapp.ts, whose mode is SMS_PROVIDER = none | mock
 * (mock writes to /admin/test-messages; refused on gokesari.com). No vendor is
 * connected — that is Phase 2 and is deliberately not built here.
 *
 * When a vendor is chosen (e.g. MSG91 with DLT-registered templates, which
 * Indian SMS needs), implement `SmsProvider` in a new file next to this one,
 * add its mode to SMS_PROVIDER in src/lib/env.ts and route sendText() to it.
 * Preferences, retries, the delivery log and templates need no change.
 */
import { MessagingUnavailableError, sendText, textChannelMode } from "@/server/messaging/sms-whatsapp";

export interface SmsMessage {
  /** E.164, e.g. +919876543210. */
  to: string;
  text: string;
  /** DLT template id — mandatory for a real Indian SMS vendor. */
  dltTemplateId?: string;
}

export interface SmsProvider {
  readonly name: string;
  isAvailable(): boolean;
  send(message: SmsMessage): Promise<{ providerRef: string }>;
}

/** Today's SMS: the existing none / mock modes, unchanged. */
export const currentSmsProvider: SmsProvider = {
  name: "sms-whatsapp.ts",
  isAvailable: () => textChannelMode("SMS") !== "none",
  send: (message) => sendText("SMS", message.to, message.text, "notification"),
};

/** Placeholder for the Phase 2 vendor: always unavailable, so a delivery through it is SKIPPED, never failed. */
export const phase2SmsProvider: SmsProvider = {
  name: "phase2-sms (not connected)",
  isAvailable: () => false,
  async send() {
    throw new MessagingUnavailableError("No SMS vendor is connected yet (Phase 2).");
  },
};
