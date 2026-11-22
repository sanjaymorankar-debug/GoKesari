/**
 * Meta WhatsApp Business Cloud API (WHATSAPP_PROVIDER=meta) — the sender of
 * the shop-order alerts (server/whatsapp/shop-orders; docs/smart-shopping-2026-11/
 * FEATURE3_WHATSAPP_ORDERS.md).
 *
 *   template   an approved template, with body parameters and quick-reply
 *              buttons (each button carries our own payload back to the webhook)
 *   text       a free-form reply, allowed only inside the 24-hour window that
 *              opens when the person writes or taps a button
 *
 * Keys come from the environment only (src/lib/env.ts, whatsappMetaConfigProblem).
 * On the test site, WHATSAPP_TEST_RECIPIENT readdresses every message to one
 * number (mirrors EMAIL_REDIRECT_TO); gokesari.com refuses to send while it is set.
 * Never called inside a database transaction.
 */
import { getEnv, isProductionSite, whatsappMetaConfigProblem, type ServerEnv } from "@/lib/env";
import type { WhatsAppMessage, WhatsAppProvider } from "./whatsapp";

const GRAPH = "https://graph.facebook.com";

export class MetaWhatsAppError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    /** Worth another try later (network, 5xx, rate limit); false for a refused number or template. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MetaWhatsAppError";
  }
}

/** Null when the provider may send, else why not. */
export function metaWhatsAppProblem(env: ServerEnv = getEnv()): string | null {
  return whatsappMetaConfigProblem(env);
}

/** "+91 98765 43210" / "919876543210" → "+919876543210" (best effort; the caller validated it). */
export function toE164(number: string): string {
  const digits = number.replace(/[^\d]/g, "");
  return `+${digits}`;
}

/** The test number every message goes to on a non-production site, or null. */
export function whatsappTestRecipient(env: ServerEnv = getEnv()): string | null {
  const target = env.WHATSAPP_TEST_RECIPIENT?.trim();
  if (!target || isProductionSite(env)) return null;
  return toE164(target);
}

/** Where a message for `intended` actually goes: the same number, or the test recipient. */
export function whatsappRecipientFor(intended: string, env: ServerEnv = getEnv()): string {
  return whatsappTestRecipient(env) ?? toE164(intended);
}

export interface TemplateSend {
  /** E.164 of the person it is for; readdressed on the test site. */
  to: string;
  name: string;
  language: string;
  bodyParams: string[];
  /** Quick-reply buttons in template order: the payload Meta sends back when tapped. */
  quickReplies?: string[];
}

export interface SendResult {
  messageId: string;
  /** The number it went to (after any test readdressing). */
  sentTo: string;
}

/** Template parameters may not hold new lines, tabs or more than four spaces in a row (Meta rule). */
export function templateParam(value: string, max = 900): string {
  const flat = value.replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
  const text = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return text || "-";
}

export async function sendMetaTemplate(message: TemplateSend, env: ServerEnv = getEnv()): Promise<SendResult> {
  const sentTo = whatsappRecipientFor(message.to, env);
  const components: Record<string, unknown>[] = [];
  if (message.bodyParams.length > 0) {
    components.push({ type: "body", parameters: message.bodyParams.map((text) => ({ type: "text", text: templateParam(text) })) });
  }
  (message.quickReplies ?? []).forEach((payload, index) => {
    components.push({ type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload }] });
  });
  const messageId = await post(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: sentTo.slice(1),
      type: "template",
      template: { name: message.name, language: { code: message.language }, ...(components.length ? { components } : {}) },
    },
    env,
  );
  return { messageId, sentTo };
}

/** A free-form text: only inside the 24-hour window (a reply to a button tap). */
export async function sendMetaText(to: string, text: string, env: ServerEnv = getEnv()): Promise<SendResult> {
  const sentTo = whatsappRecipientFor(to, env);
  const messageId = await post(
    { messaging_product: "whatsapp", recipient_type: "individual", to: sentTo.slice(1), type: "text", text: { preview_url: false, body: text.slice(0, 4000) } },
    env,
  );
  return { messageId, sentTo };
}

async function post(body: Record<string, unknown>, env: ServerEnv): Promise<string> {
  const problem = metaWhatsAppProblem(env);
  if (problem) throw new MetaWhatsAppError(`WhatsApp is not set up: ${problem}`, "NOT_CONFIGURED", false);
  const url = `${GRAPH}/${env.META_WA_API_VERSION.trim()}/${env.META_WA_PHONE_NUMBER_ID!.trim()}/messages`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.META_WA_ACCESS_TOKEN!.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new MetaWhatsAppError(`WhatsApp API not reachable: ${error instanceof Error ? error.message : String(error)}`, "NETWORK", true);
  }
  const json = (await response.json().catch(() => null)) as {
    messages?: { id?: string }[];
    error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
  } | null;
  const id = json?.messages?.[0]?.id;
  if (response.ok && id) return id;
  const err = json?.error;
  const code = err?.code != null ? String(err.code) : `HTTP_${response.status}`;
  const detail = [err?.message, err?.error_data?.details].filter(Boolean).join(" — ") || `HTTP ${response.status}`;
  // 4/80007/130429/131048/131056: rate limits; 5xx: Meta's side. Everything else (bad number, template, token) will not fix itself.
  const retryable = response.status >= 500 || ["4", "80007", "130429", "131048", "131056"].includes(code);
  throw new MetaWhatsAppError(`WhatsApp API error ${code}: ${detail}`.slice(0, 500), code, retryable);
}

/** The WhatsAppProvider contract (providers/whatsapp.ts) on Meta: a template when given, else free-form text. */
export const metaWhatsAppProvider: WhatsAppProvider = {
  name: "meta-cloud-api",
  isAvailable: () => metaWhatsAppProblem() === null,
  async send(message: WhatsAppMessage) {
    const result = message.template
      ? await sendMetaTemplate({ to: message.to, name: message.template.name, language: message.template.language, bodyParams: message.template.parameters })
      : await sendMetaText(message.to, message.text);
    return { providerRef: result.messageId };
  },
};
