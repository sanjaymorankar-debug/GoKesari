/**
 * Shadowfax, Pidge, Porter and Borzo adapters (docs/hdms-2026-11/PROVIDERS.md).
 *
 * None of these partners publishes its on-demand API openly: the endpoints, payloads, status codes and
 * webhook signature scheme come with the partner agreement and sandbox access. Until they are in hand,
 * each adapter is registered but NOT integrated — every call refuses with NOT_INTEGRATED (never a
 * guessed endpoint), the provider cannot be enabled in Admin, and its webhooks answer 401.
 * Implementing one = replacing its `pending(...)` entry with real calls through ./http.ts.
 */
import type { DeliveryProviderCode } from "@/server/db/hdms-schema";

import { ProviderError, type DeliveryProviderAdapter } from "./types";

export const PARTNER_NOTES: Record<Exclude<DeliveryProviderCode, "MOCK">, string> = {
  SHADOWFAX:
    "Shadowfax hyperlocal / marketplace API: request the API document, sandbox base URL, API token and webhook signing details from the Shadowfax integration team.",
  PIDGE: "Pidge (v2) API: request the partner API document, sandbox credentials and webhook details from Pidge.",
  PORTER: "Porter for Business API: request the API key, sandbox access and webhook details from Porter.",
  BORZO: "Borzo (WeFast) business API: request the API token, test-server URL and callback signature key from Borzo.",
  PICO: "Pico Xpress: integrated (docs/pico-xpress-2026-11). Booked from the shop's delivery choice; keys PICO_BASE_URL / PICO_CLIENT_KEY / PICO_API_KEY / PICO_WEBHOOK_TOKEN in the site's environment.",
};

function pending(code: Exclude<DeliveryProviderCode, "MOCK">): DeliveryProviderAdapter {
  const refuse = async (): Promise<never> => {
    throw new ProviderError(`${code} is not integrated yet. ${PARTNER_NOTES[code]}`, "NOT_INTEGRATED", false);
  };
  return {
    code,
    integrated: false,
    quote: refuse,
    book: refuse,
    track: refuse,
    cancel: refuse,
    verifyWebhook: () => false,
    parseWebhook: () => {
      throw new ProviderError(`${code} webhooks are not integrated yet.`, "NOT_INTEGRATED", false, 401);
    },
  };
}

export const shadowfaxAdapter = pending("SHADOWFAX");
export const pidgeAdapter = pending("PIDGE");
export const porterAdapter = pending("PORTER");
export const borzoAdapter = pending("BORZO");
