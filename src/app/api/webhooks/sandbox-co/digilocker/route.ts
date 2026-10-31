/**
 * Sandbox.co.in DigiLocker session webhook (gig worker flow, rider Aadhaar):
 * events in.co.sandbox.kyc.digilocker.session.succeeded / .failed, URL
 * <AUTH_URL>/api/webhooks/sandbox-co/digilocker, secret SANDBOX_CO_WEBHOOK_SECRET.
 *
 *  1. No secret configured → 503: an unauthenticated payload is never acted on
 *     (polling settles the check instead).
 *  2. `x-sandbox-signature` checked over the raw body before anything else.
 *  3. The payload is only a nudge: the session's status is read from Sandbox
 *     again (syncDigilockerCheck), so a replayed or reordered event can't
 *     change a result. A duplicate finds the check settled and does nothing.
 * Always 200 once authenticated, so Sandbox does not retry what we can't use.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getEnv } from "@/lib/env";
import { digilockerWebhookSessionId, verifySandboxSignature } from "@/server/kyc/sandbox-webhook";
import { handleDigilockerWebhook } from "@/server/services/rider-kyc";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = getEnv().SANDBOX_CO_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });

  const rawBody = await request.text();
  if (!verifySandboxSignature(rawBody, request.headers.get("x-sandbox-signature"), secret)) {
    console.error("[webhook] Sandbox DigiLocker signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true, ignored: "not json" });
  }
  const sessionId = digilockerWebhookSessionId(payload);
  if (!sessionId) return NextResponse.json({ ok: true, ignored: "not a DigiLocker session" });
  const result = await handleDigilockerWebhook(sessionId);
  return NextResponse.json({ ok: true, result });
}
