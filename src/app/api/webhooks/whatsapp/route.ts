/**
 * Meta WhatsApp Cloud API webhook (docs/smart-shopping-2026-11/FEATURE3_WHATSAPP_ORDERS.md).
 * Register https://<site>/api/webhooks/whatsapp in Meta → WhatsApp → Configuration,
 * with META_WA_VERIFY_TOKEN as the verify token, and subscribe to "messages".
 *
 *   GET   the subscription check: echoes hub.challenge for our verify token, else 403
 *   POST  status updates and button taps; X-Hub-Signature-256 (HMAC-SHA256 of the
 *         raw body with META_WA_APP_SECRET) is required, else 401. Idempotent.
 */
import { NextResponse, type NextRequest } from "next/server";

import { handleWhatsAppWebhook, verifyWhatsAppSubscription } from "@/server/whatsapp/shop-orders/webhook";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const result = verifyWhatsAppSubscription(request.nextUrl.searchParams);
  return new Response(result.body, { status: result.status, headers: { "content-type": "text/plain" } });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // The raw bytes: the signature is over exactly what Meta sent.
  const rawBody = await request.text();
  try {
    const result = await handleWhatsAppWebhook(rawBody, request.headers);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    // Meta retries; items already recorded (whatsapp_webhook_events) are not handled twice.
    console.error("[whatsapp-webhook] processing failed", error);
    return NextResponse.json({ error: "Processing failed." }, { status: 500 });
  }
}
