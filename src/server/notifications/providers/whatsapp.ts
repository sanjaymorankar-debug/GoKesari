/**
 * Phase 2 stub (F13.1.2, GS-074): the WhatsApp provider contract.
 *
 * WhatsApp already goes through the one notification service today: notify()
 * queues a WHATSAPP delivery and channels.ts sends it with
 * server/messaging/sms-whatsapp.ts (WHATSAPP_PROVIDER = none | mock). No
 * vendor is connected — Phase 2, deliberately not built here.
 *
 * When one is chosen (Meta WhatsApp Cloud API, or a BSP such as Gupshup /
 * Interakt), implement `WhatsAppProvider` in a new file next to this one with
 * Meta-approved message templates, add its mode to WHATSAPP_PROVIDER in
 * src/lib/env.ts and route sendText() to it. Nothing else changes.
 */
import { MessagingUnavailableError, sendText, textChannelMode } from "@/server/messaging/sms-whatsapp";

export interface WhatsAppMessage {
  /** E.164, e.g. +919876543210. */
  to: string;
  text: string;
  /** Meta-approved template name and its parameters (required outside the 24-hour customer-service window). */
  template?: { name: string; language: string; parameters: string[] };
}

export interface WhatsAppProvider {
  readonly name: string;
  isAvailable(): boolean;
  send(message: WhatsAppMessage): Promise<{ providerRef: string }>;
}

/** Today's WhatsApp: the existing none / mock modes, unchanged. */
export const currentWhatsAppProvider: WhatsAppProvider = {
  name: "sms-whatsapp.ts",
  isAvailable: () => textChannelMode("WHATSAPP") !== "none",
  send: (message) => sendText("WHATSAPP", message.to, message.text, "notification"),
};

/** Placeholder for the Phase 2 vendor: always unavailable, so a delivery through it is SKIPPED, never failed. */
export const phase2WhatsAppProvider: WhatsAppProvider = {
  name: "phase2-whatsapp (not connected)",
  isAvailable: () => false,
  async send() {
    throw new MessagingUnavailableError("No WhatsApp vendor is connected yet (Phase 2).");
  },
};
