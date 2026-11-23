/**
 * MOCK — the in-process sandbox delivery partner (docs/hdms-2026-11). Never books a real rider.
 * Used on staging (until a real partner's sandbox is connected) and by the tests. Deterministic:
 *  - fee ₹30 + ₹9/km, ETA 10 min + 4 min/km; not serviceable beyond 20 km or for pincode 000000;
 *  - booking ref derived from the idempotency key, so a retried book returns the same booking;
 *  - polling moves a booking ASSIGNED → AT_PICKUP → PICKED_UP → IN_TRANSIT by elapsed time
 *    (credentials.stageMinutes, default 2). DELIVERED / FAILED / CANCELLED come only from a
 *    signed webhook (Admin → Delivery → Active deliveries → "Simulate"), never by itself;
 *  - webhooks signed HMAC-SHA256 (hex) of the raw body in header x-mock-signature.
 * Test hooks (setMockBehaviour) simulate timeouts, outages and refusals.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { BookingStatus } from "@/server/db/hdms-schema";

import {
  ProviderError,
  type BookRequest,
  type BookResult,
  type DeliveryProviderAdapter,
  type ProviderContext,
  type ProviderEvent,
  type QuoteRequest,
  type QuoteResult,
  type TrackResult,
} from "./types";

interface MockBehaviour {
  /** Operation that hangs past the timeout. */
  timeoutOn?: "quote" | "book" | "track" | "cancel";
  /** Operation that answers 503. */
  unavailableOn?: "quote" | "book" | "track" | "cancel";
  /** Quote says not serviceable. */
  notServiceable?: boolean;
  /** Cancel refused (rider already picked up). */
  refuseCancel?: boolean;
}
let behaviour: MockBehaviour = {};
const bookCalls = new Map<string, number>();

export function setMockBehaviour(next: MockBehaviour): void {
  behaviour = next;
}
export function mockBookCallCount(idempotencyKey: string): number {
  return bookCalls.get(idempotencyKey) ?? 0;
}
export function resetMock(): void {
  behaviour = {};
  bookCalls.clear();
}

async function simulate(op: NonNullable<MockBehaviour["timeoutOn"]>, ctx: ProviderContext): Promise<void> {
  if (behaviour.timeoutOn === op) {
    await new Promise((r) => setTimeout(r, ctx.timeoutMs + 50));
    throw new ProviderError(`Sandbox ${op} timed out.`, "TIMEOUT", true);
  }
  if (behaviour.unavailableOn === op) throw new ProviderError(`Sandbox ${op} unavailable (503).`, "UNAVAILABLE", true, 503);
}

function feeFor(distanceM: number): number {
  return 3000 + Math.round((distanceM / 1000) * 900);
}
function etaFor(distanceM: number): number {
  return 10 + Math.round((distanceM / 1000) * 4);
}

const STAGES: BookingStatus[] = ["ASSIGNED", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT"];

function refFor(idempotencyKey: string, at: number): string {
  const h = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 12).toUpperCase();
  return `MOCK-${at.toString(36).toUpperCase()}-${h}`;
}
const issuedRefs = new Map<string, string>();

export const mockAdapter: DeliveryProviderAdapter = {
  code: "MOCK",
  integrated: true,
  async quote(ctx, req: QuoteRequest): Promise<QuoteResult> {
    await simulate("quote", ctx);
    if (behaviour.notServiceable || req.drop.pincode === "000000") return { serviceable: false, reason: "Area not serviced (sandbox)." };
    if (req.distanceM > 20_000) return { serviceable: false, reason: "Beyond 20 km (sandbox)." };
    return { serviceable: true, feePaise: feeFor(req.distanceM), etaMinutes: etaFor(req.distanceM) };
  },
  async book(ctx, req: BookRequest): Promise<BookResult> {
    bookCalls.set(req.idempotencyKey, (bookCalls.get(req.idempotencyKey) ?? 0) + 1);
    await simulate("book", ctx);
    let ref = issuedRefs.get(req.idempotencyKey);
    if (!ref) {
      ref = refFor(req.idempotencyKey, Date.now());
      issuedRefs.set(req.idempotencyKey, ref);
    }
    return {
      externalRef: ref,
      status: "ASSIGNED",
      feePaise: feeFor(req.distanceM),
      etaMinutes: etaFor(req.distanceM),
      trackingUrl: null,
    };
  },
  async track(ctx, externalRef: string): Promise<TrackResult> {
    await simulate("track", ctx);
    const m = /^MOCK-([0-9A-Z]+)-/.exec(externalRef);
    if (!m) throw new ProviderError("Unknown sandbox booking.", "REJECTED", false, 404);
    const bookedAt = parseInt(m[1], 36);
    const stageMinutes = Number(ctx.credentials.stageMinutes ?? 2) || 2;
    const stage = Math.min(STAGES.length - 1, Math.floor((Date.now() - bookedAt) / (stageMinutes * 60_000)));
    return {
      status: STAGES[Math.max(0, stage)],
      riderName: "Sandbox Rider",
      riderPhone: "+919000000000",
      riderLocation: null,
      etaMinutes: Math.max(2, 20 - stage * 5),
    };
  },
  async cancel(ctx, _externalRef: string): Promise<{ cancelled: boolean; feePaise?: number }> {
    await simulate("cancel", ctx);
    if (behaviour.refuseCancel) return { cancelled: false };
    return { cancelled: true, feePaise: 0 };
  },
  verifyWebhook(rawBody: string, headers: Headers, secret: string | null): boolean {
    const given = headers.get("x-mock-signature") ?? "";
    if (!secret || !/^[0-9a-f]{64}$/i.test(given)) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return timingSafeEqual(Buffer.from(given.toLowerCase(), "hex"), Buffer.from(expected, "hex"));
  },
  parseWebhook(rawBody: string): ProviderEvent[] {
    const body = JSON.parse(rawBody) as { events?: unknown[] } | Record<string, unknown>;
    const list = Array.isArray((body as { events?: unknown[] }).events) ? (body as { events: unknown[] }).events : [body];
    return list.map((raw) => {
      const e = raw as Record<string, unknown>;
      const status = String(e.status ?? "") as BookingStatus;
      if (!e.id || !e.ref || !status) throw new ProviderError("Sandbox webhook missing id/ref/status.", "BAD_RESPONSE", false, 400);
      const loc = e.lat != null && e.lng != null ? { lat: Number(e.lat), lng: Number(e.lng) } : null;
      return {
        eventId: String(e.id),
        externalRef: String(e.ref),
        status,
        occurredAt: e.at ? new Date(String(e.at)) : new Date(),
        riderName: (e.riderName as string) ?? null,
        riderPhone: (e.riderPhone as string) ?? null,
        riderLocation: loc,
        etaMinutes: e.etaMinutes != null ? Number(e.etaMinutes) : null,
        reason: (e.reason as string) ?? null,
        finalFeePaise: e.feePaise != null ? Number(e.feePaise) : null,
      };
    });
  },
};

/** Signs a sandbox webhook body (admin "Simulate" button and tests). */
export function signMockWebhook(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}
