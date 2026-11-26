/**
 * Public verification of a signed agreement (docs/seller-agreements-2026-11).
 *   GET                       → what was signed under the code (document, version, shop, IST time, file hashes)
 *   POST { sha256 }           → { match } — the page hashes a PDF in the browser; the file itself is never uploaded
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { verifyCodeSummary, verifyHash } from "@/server/legal-agreements/admin";
import { clientIp } from "@/server/legal-agreements/http";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ code: string }>) => {
  const { code } = await context.params;
  enforceRateLimit(`agreement-verify:${clientIp(request) ?? "?"}`, RATE_LIMITS.SEARCH_SUGGEST);
  return ok(await verifyCodeSummary(code));
});

const body = z.object({ sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, "Not a SHA-256 hash.") });

export const POST = route(async (request: NextRequest, context: RouteContext<{ code: string }>) => {
  const { code } = await context.params;
  enforceRateLimit(`agreement-verify:${clientIp(request) ?? "?"}`, RATE_LIMITS.SEARCH_SUGGEST);
  const { sha256 } = await parseBody(request, body);
  return ok(await verifyHash(code, sha256));
});
