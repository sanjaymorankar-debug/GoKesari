/** Public API (billing v2, docs/billing §8): OAuth2 token endpoint, client credentials only. */
import { NextResponse, type NextRequest } from "next/server";

import { AppError, toClientError } from "@/lib/errors";
import { enforceRateLimit, clientKey } from "@/server/api/rate-limit";
import { issueToken } from "@/server/public-api/auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    enforceRateLimit(clientKey(request, "public-token"), { limit: 30, windowMs: 60_000 });
    const type = request.headers.get("content-type") ?? "";
    const raw: Record<string, string> = type.includes("application/json") ? await request.json() : Object.fromEntries(new URLSearchParams(await request.text()));
    // HTTP Basic client authentication is allowed too (RFC 6749 §2.3.1).
    const basic = /^Basic\s+(.+)$/.exec(request.headers.get("authorization") ?? "");
    if (basic) {
      const [id, secret] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
      raw.client_id ??= decodeURIComponent(id ?? "");
      raw.client_secret ??= decodeURIComponent(secret ?? "");
    }
    const token = await issueToken({ grantType: raw.grant_type ?? "", clientId: raw.client_id ?? "", clientSecret: raw.client_secret ?? "", scope: raw.scope ?? null });
    return NextResponse.json(token, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
  } catch (error) {
    const oauth = error instanceof AppError ? (error.details as { oauthError?: string } | undefined)?.oauthError : undefined;
    if (oauth) return NextResponse.json({ error: oauth, error_description: (error as Error).message }, { status: oauth === "invalid_client" ? 401 : 400 });
    const { status, body } = toClientError(error);
    return NextResponse.json(body, { status });
  }
}
