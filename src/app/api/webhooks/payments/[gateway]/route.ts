/**
 * Payment-gateway webhooks for online order payments (batch-2026-10 WS-A):
 *   POST /api/webhooks/payments/sandbox | cashfree | razorpay | phonepe | hdfc
 *
 * 401 on a bad signature (recorded), 200 for a repeated event (ignored),
 * 500 when processing failed (the gateway retries). The state is taken from
 * the gateway's own API, not from this body — see server/payments/processing.ts.
 * The older Cashfree wallet top-up webhook (/api/webhooks/cashfree) is separate
 * and unchanged.
 */
import { NextResponse, type NextRequest } from "next/server";

import { handlePaymentWebhook } from "@/server/payments/processing";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ gateway: string }> }): Promise<NextResponse> {
  const { gateway } = await context.params;
  // The raw bytes: signatures are over exactly what the gateway sent.
  const rawBody = await request.text();
  const result = await handlePaymentWebhook(gateway, rawBody, request.headers);
  return NextResponse.json(result.body, { status: result.status });
}
