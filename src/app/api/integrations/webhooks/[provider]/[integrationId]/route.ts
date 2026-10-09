/**
 * POST → "items changed" from Odoo (automated action → webhook) or Zoho
 * Books (webhook). The secret comes as ?key= or the X-GoKesari-Key header.
 * Starts a pull (one at a time per shop); the body is not trusted or used.
 */
import { NextResponse, type NextRequest } from "next/server";

import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { toClientError } from "@/lib/errors";
import { handleChangeWebhook } from "@/server/integrations/connections";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ provider: string; integrationId: string }> }) {
  try {
    enforceRateLimit(clientKey(request, "integration-webhook"), { limit: 120, windowMs: 60_000 });
    const { provider, integrationId } = await context.params;
    const key = request.headers.get("x-gokesari-key") ?? request.nextUrl.searchParams.get("key");
    const accepted = await handleChangeWebhook(provider, integrationId, key);
    if (!accepted) return NextResponse.json({ error: "Not accepted." }, { status: 401 });
    return new NextResponse(null, { status: 202 });
  } catch (error) {
    const { status, body } = toClientError(error);
    // A paused or broken connection is not the caller's problem: accept quietly.
    return status >= 500 ? NextResponse.json(body, { status }) : new NextResponse(null, { status: 202 });
  }
}
