/**
 * Pico Xpress webhook (docs/pico-xpress-2026-11): POST /api/webhooks/picoxpress/location.
 * Auth: "Authorization: Bearer <PICO_WEBHOOK_TOKEN>" or "X-GoKesari-Webhook-Token", or ?token= in the URL (Pico's dashboard takes only a URL). Answers within 2 s;
 * the payload is processed straight after the answer (server/delivery/pico/webhooks.ts).
 */
import { after, NextResponse, type NextRequest } from "next/server";

import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { handleLocationWebhook, MAX_WEBHOOK_BYTES } from "@/server/delivery/pico/webhooks";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    enforceRateLimit(clientKey(request, "pico-webhook:location"), { limit: 600, windowMs: 60_000 });
  } catch {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_WEBHOOK_BYTES) return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  const rawBody = await request.text();
  try {
    const result = await handleLocationWebhook(rawBody, request.headers, (task) => after(task), request.url);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[webhook:picoxpress] failed", "location", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not process the event." }, { status: 500 });
  }
}
