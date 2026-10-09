/**
 * The private delivery link a shop shares with its own delivery person
 * (docs/four-features-2026-10, feature 1). No sign-in: the link itself is the
 * permission, for one order, while it is with that person. Anything else — a
 * wrong, old or reassigned link — is a 404.
 *
 *   GET   → what the delivery person needs (address, phone, items, cash to collect)
 *   POST  { action: "start" }                              order leaves the shop
 *         { action: "complete", code, cashCollected? }     customer's delivery code
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { actOnStaffLink, getStaffLinkView } from "@/server/services/fulfilment-options";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("complete"), code: z.string().trim().max(12), cashCollected: z.boolean().optional() }),
]);

const clientIp = (request: NextRequest) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

export const GET = route(async (request: NextRequest, context: RouteContext<{ token: string }>) => {
  const { token } = await context.params;
  enforceRateLimit(`delivery-link-view:${clientIp(request)}`, RATE_LIMITS.MUTATION);
  return ok(await getStaffLinkView(token));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ token: string }>) => {
  const { token } = await context.params;
  enforceRateLimit(`delivery-link:${clientIp(request)}`, RATE_LIMITS.PAYMENT);
  const body = await parseBody(request, schema);
  return ok(await actOnStaffLink(token, body));
});
