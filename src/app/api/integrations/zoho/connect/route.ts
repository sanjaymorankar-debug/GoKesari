/**
 * GET ?shopId= → Zoho's consent screen (India data centre). The state is
 * signed and bound to this shop, this user and this browser (cookie nonce).
 */
import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { parseQuery, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { ZOHO_ACCOUNTS, ZOHO_SCOPE, zohoClient } from "@/server/integrations/adapters/zoho";
import { requireIntegrationAccess, signOAuthState } from "@/server/integrations/connections";
import { asIntegrationError, describeError } from "@/server/integrations/errors";
import { validationFailed } from "@/lib/errors";

export const dynamic = "force-dynamic";

const ZOHO_STATE_COOKIE = "gk_zoho_oauth";

export const GET = route(async (request: NextRequest) => {
  const { shopId } = parseQuery(request, z.object({ shopId: z.string().uuid() }));
  const actor = await requireIntegrationAccess(shopId, "manage");
  enforceRateLimit(`zoho-connect:${actor.id}`, { limit: 10, windowMs: 10 * 60_000 });
  let clientId: string;
  try {
    clientId = zohoClient().clientId;
  } catch (error) {
    throw validationFailed(`${describeError(asIntegrationError(error).code).message} Zoho Books is not set up on GoKesari yet — contact support.`);
  }
  const origin = (process.env.AUTH_URL ?? request.nextUrl.origin).replace(/\/$/, "");
  const nonce = randomBytes(16).toString("base64url");
  const state = signOAuthState({ shopId, userId: actor.id, nonce, exp: Date.now() + 10 * 60_000 });
  const url = new URL(`${ZOHO_ACCOUNTS}/oauth/v2/auth`);
  url.searchParams.set("scope", ZOHO_SCOPE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("redirect_uri", `${origin}/api/integrations/zoho/callback`);
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url.toString(), 302);
  response.cookies.set(ZOHO_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/integrations/zoho",
    maxAge: 600,
  });
  return response;
});
