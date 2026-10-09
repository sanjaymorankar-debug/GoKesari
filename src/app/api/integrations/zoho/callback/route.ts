/**
 * Zoho's redirect after consent: checks the signed state, the browser's
 * nonce and the signed-in user, exchanges the code, lists the Zoho Books
 * organisations, saves the refresh token encrypted, and returns to the
 * shop's Integrations page.
 */
import { NextResponse, type NextRequest } from "next/server";

import { ZOHO_ACCOUNTS, ZOHO_API, zohoToken } from "@/server/integrations/adapters/zoho";
import { assertIntegrationAccess, saveZohoConnection, verifyOAuthState } from "@/server/integrations/connections";
import { asIntegrationError, describeError } from "@/server/integrations/errors";
import { getCurrentUser } from "@/server/authz/guards";

export const dynamic = "force-dynamic";

const COOKIE = "gk_zoho_oauth";

export async function GET(request: NextRequest) {
  const origin = (process.env.AUTH_URL ?? request.nextUrl.origin).replace(/\/$/, "");
  const back = (shopId: string | null, outcome: string, reason?: string) => {
    const url = new URL(`${origin}/shop/settings/integrations`);
    if (shopId) url.searchParams.set("shop", shopId);
    url.searchParams.set("zoho", outcome);
    if (reason) url.searchParams.set("reason", reason.slice(0, 200));
    const response = NextResponse.redirect(url.toString(), 302);
    response.cookies.set(COOKIE, "", { path: "/api/integrations/zoho", maxAge: 0 });
    return response;
  };
  const params = request.nextUrl.searchParams;
  const state = verifyOAuthState(params.get("state") ?? "");
  if (!state) return back(null, "error", "The sign-in link expired. Press Connect Zoho Books again.");
  const nonce = request.cookies.get(COOKIE)?.value;
  const user = await getCurrentUser();
  if (!nonce || nonce !== state.nonce || !user || user.id !== state.userId) {
    return back(state.shopId, "error", "Finish the Zoho sign-in in the same browser you started it from.");
  }
  if (params.get("error")) return back(state.shopId, "error", "Zoho sign-in was cancelled.");
  const accountsServer = params.get("accounts-server");
  if (accountsServer && new URL(accountsServer).host !== new URL(ZOHO_ACCOUNTS).host) {
    return back(state.shopId, "error", "This Zoho account is not in Zoho's India data centre (zoho.in). GoKesari connects Zoho Books India only.");
  }
  const code = params.get("code");
  if (!code) return back(state.shopId, "error", "Zoho did not return a sign-in code.");
  try {
    const actor = await assertIntegrationAccess(state.shopId, user, "manage");
    const tokens = await zohoToken(fetch, { code, redirectUri: `${origin}/api/integrations/zoho/callback` });
    if (!tokens.refreshToken) return back(state.shopId, "error", "Zoho did not grant offline access. Press Connect again and allow access.");
    const res = await fetch(`${ZOHO_API}/organizations`, {
      headers: { Authorization: `Zoho-oauthtoken ${tokens.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { organizations?: { organization_id: string; name: string }[] };
    const organizations = (body.organizations ?? []).map((o) => ({ id: String(o.organization_id), name: o.name }));
    if (organizations.length === 0) return back(state.shopId, "error", "No Zoho Books organisation was found in this Zoho account.");
    await saveZohoConnection(state.shopId, { refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresIn: tokens.expiresIn }, organizations, actor);
    return back(state.shopId, "connected");
  } catch (error) {
    const reason = error instanceof Error && "status" in error ? error.message : describeError(asIntegrationError(error).code).message;
    return back(state.shopId, "error", reason);
  }
}
