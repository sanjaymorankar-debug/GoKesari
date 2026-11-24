/**
 * Delivery partner webhooks (docs/hdms-2026-11): /api/webhooks/delivery/mock (sandbox simulator) and, once
 * integrated, /shadowfax, /pidge, /porter, /borzo. Signature checked over the exact raw body first; each
 * event id applied once (a redelivery gets 200 and changes nothing); a 500 makes the partner retry.
 */
import { NextResponse, type NextRequest } from "next/server";

import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { handleDeliveryWebhook } from "@/server/delivery/webhooks";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ provider: string }> }): Promise<NextResponse> {
  const { provider } = await context.params;
  try {
    enforceRateLimit(clientKey(request, `delivery-webhook:${provider}`), { limit: 600, windowMs: 60_000 });
  } catch {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  const rawBody = await request.text();
  if (rawBody.length > 256_000) return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  try {
    const result = await handleDeliveryWebhook(provider, rawBody, request.headers);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[webhook:delivery] failed", provider, error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not process the event." }, { status: 500 });
  }
}
