/**
 * Delivery partner webhooks (docs/hdms-2026-11): POST /api/webhooks/delivery/[provider].
 * The signature is checked over the exact raw body first (401 if wrong, logged). Each event id is applied
 * once: delivery_webhook_logs has a unique (provider, event id), so a redelivery answers 200 and changes
 * nothing. An unknown booking reference is logged and acknowledged (the partner must not retry forever).
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { deliveryBookings, deliveryWebhookLogs } from "@/server/db/hdms-schema";

import { applyBookingUpdate } from "./bookings";
import { adapterFor, getProvider, webhookSecretFor } from "./providers/registry";

const SENSITIVE = /phone|mobile|otp|email|address|name/i;

/** Drops personal fields before a payload is stored in the log. */
export function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > 5 || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactPayload(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? "[redacted]" : redactPayload(v, depth + 1);
  }
  return out;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

export async function handleDeliveryWebhook(providerCode: string, rawBody: string, headers: Headers): Promise<WebhookResponse> {
  const code = providerCode.toUpperCase();
  const adapter = adapterFor(code);
  const provider = adapter ? await getProvider(code) : null;
  if (!adapter || !provider) return { status: 404, body: { error: "Unknown delivery partner." } };

  const valid = adapter.integrated && adapter.verifyWebhook(rawBody, headers, webhookSecretFor(provider));
  let parsedForLog: unknown = null;
  try {
    parsedForLog = redactPayload(JSON.parse(rawBody));
  } catch {
    parsedForLog = { unparsable: true, length: rawBody.length };
  }
  if (!valid) {
    await db
      .insert(deliveryWebhookLogs)
      .values({ providerCode: code, eventId: `invalid:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, signatureValid: false, result: "REJECTED_SIGNATURE", payload: parsedForLog })
      .catch(() => undefined);
    return { status: 401, body: { error: "Invalid signature." } };
  }

  const events = adapter.parseWebhook(rawBody);
  const { reallocateAfterBookingEnded } = await import("./allocation");
  const results: { eventId: string; result: string }[] = [];
  for (const ev of events) {
    const [claimed] = await db
      .insert(deliveryWebhookLogs)
      .values({ providerCode: code, eventId: ev.eventId, signatureValid: true, result: "RECEIVED", payload: parsedForLog })
      .onConflictDoNothing()
      .returning({ id: deliveryWebhookLogs.id });
    if (!claimed) {
      results.push({ eventId: ev.eventId, result: "DUPLICATE" });
      continue;
    }
    const [booking] = await db
      .select()
      .from(deliveryBookings)
      .where(and(eq(deliveryBookings.providerCode, provider.code), eq(deliveryBookings.externalRef, ev.externalRef)));
    if (!booking) {
      await db.update(deliveryWebhookLogs).set({ result: "UNKNOWN_BOOKING" }).where(eq(deliveryWebhookLogs.id, claimed.id));
      results.push({ eventId: ev.eventId, result: "UNKNOWN_BOOKING" });
      continue;
    }
    try {
      const applied = await applyBookingUpdate(booking.id, {
        status: ev.status,
        source: "WEBHOOK",
        note: ev.reason ?? null,
        occurredAt: ev.occurredAt,
        riderName: ev.riderName,
        riderPhone: ev.riderPhone,
        riderLocation: ev.riderLocation,
        etaMinutes: ev.etaMinutes,
        failureReason: ev.status === "FAILED" ? (ev.reason ?? "Delivery failed") : null,
        finalFeePaise: ev.finalFeePaise,
        cancelledBy: ev.status === "CANCELLED" ? "PROVIDER" : undefined,
      });
      const result = applied.changed ? `APPLIED:${ev.status}` : `IGNORED:${ev.status}`;
      await db.update(deliveryWebhookLogs).set({ result, bookingId: booking.id }).where(eq(deliveryWebhookLogs.id, claimed.id));
      results.push({ eventId: ev.eventId, result });
      if (applied.needsReallocation) await reallocateAfterBookingEnded(applied.booking);
    } catch (error) {
      // Let the partner retry: free the event id so the retry is processed.
      await db.delete(deliveryWebhookLogs).where(eq(deliveryWebhookLogs.id, claimed.id));
      throw error;
    }
  }
  return { status: 200, body: { ok: true, results } };
}
