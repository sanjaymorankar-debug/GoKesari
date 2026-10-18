/**
 * Payout provider webhooks (batch-2026-10 WS-E): /api/webhooks/payouts/sandbox,
 * /razorpayx, /cashfree. The signature is checked over the exact raw body
 * before anything else; each provider event id is applied once (a redelivery
 * gets 200 and changes nothing); a success records the transfer's UTR.
 */
import { NextResponse, type NextRequest } from "next/server";

import { handlePayoutWebhook } from "@/server/payouts/batches";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ provider: string }> }): Promise<NextResponse> {
  const { provider } = await context.params;
  const rawBody = await request.text();
  try {
    const result = await handlePayoutWebhook(provider, rawBody, request.headers);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[webhook:payouts] failed", provider, error);
    // 500 → the provider retries; the event id makes the retry safe.
    return NextResponse.json({ error: "Could not process the event." }, { status: 500 });
  }
}
