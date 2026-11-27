/**
 * Pico Xpress webhooks (docs/pico-xpress-2026-11; doc pages 6 and 7):
 *   POST /api/webhooks/picoxpress/shipment-status   tracking payload (orderStatus | shipmentState …)
 *   POST /api/webhooks/picoxpress/location          live rider position (paid add-on; flag pico_live_location_enabled)
 * Order of checks: flag (404 when off) → token in constant time + optional IP allowlist (401 / 403) → body size
 * and JSON → 200 at once; the payload is processed straight after the answer (Next `after`), not by a cron.
 * Processing is idempotent and out-of-order safe (service.ts processTracking).
 */
import type { Defer } from "@/server/api/defer";
import { runOrDefer } from "@/server/api/defer";
import { getRule } from "@/server/services/settings";

import { picoConfig } from "./config";
import { maskForLog } from "./mask";
import { parseLocationPayload, parseTrackingPayload } from "./status";
import { checkWebhookAuth } from "./webhook-auth";

export const MAX_WEBHOOK_BYTES = 64 * 1024;

export interface WebhookAnswer {
  status: number;
  body: Record<string, unknown>;
}

async function guard(rawBody: string, headers: Headers, flagOn: boolean): Promise<WebhookAnswer | { json: unknown }> {
  if (!flagOn) return { status: 404, body: { error: "Not found." } };
  const cfg = picoConfig();
  const rules = await getRule("picoXpress");
  const auth = checkWebhookAuth(headers, cfg.ok ? cfg.config.webhookToken : null, rules.webhookIpAllowlist);
  if (!auth.ok) return { status: auth.status, body: { error: auth.reason } };
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) return { status: 413, body: { error: "Payload too large." } };
  try {
    return { json: JSON.parse(rawBody) as unknown };
  } catch {
    return { status: 400, body: { error: "Invalid JSON." } };
  }
}

export async function handleShipmentStatusWebhook(rawBody: string, headers: Headers, defer?: Defer): Promise<WebhookAnswer> {
  const { picoEnabled, processTracking } = await import("./service");
  const g = await guard(rawBody, headers, await picoEnabled());
  if (!("json" in g)) return g;
  const trackings = parseTrackingPayload(g.json);
  if (trackings.length === 0) return { status: 400, body: { error: "No AWB number or status in the payload." } };
  const masked = maskForLog(g.json);
  await runOrDefer(async () => {
    for (const t of trackings) {
      try {
        await processTracking(t, "WEBHOOK", masked);
      } catch (error) {
        // The Refresh button and the missed-webhook sweep recover it (service.ts sweepSilentShipments).
        console.error("[pico:webhook] processing failed", t.awbNumber, error instanceof Error ? error.message : error);
      }
    }
  }, defer);
  return { status: 200, body: { ok: true, received: trackings.length } };
}

export async function handleLocationWebhook(rawBody: string, headers: Headers, defer?: Defer): Promise<WebhookAnswer> {
  const { picoEnabled, processLocationPing } = await import("./service");
  const g = await guard(rawBody, headers, await picoEnabled());
  if (!("json" in g)) return g;
  const { isFeatureEnabled } = await import("@/server/services/feature-flags");
  // The add-on is paid per push: while its flag is off, pushes are acknowledged and dropped.
  if (!(await isFeatureEnabled("pico_live_location_enabled", { districtCode: null }))) return { status: 200, body: { ok: true, stored: false } };
  const ping = parseLocationPayload(g.json);
  if (!ping) return { status: 400, body: { error: "No AWB number or location in the payload." } };
  await runOrDefer(async () => {
    try {
      await processLocationPing(ping);
    } catch (error) {
      console.error("[pico:location] processing failed", ping.awbNumber, error instanceof Error ? error.message : error);
    }
  }, defer);
  return { status: 200, body: { ok: true } };
}
