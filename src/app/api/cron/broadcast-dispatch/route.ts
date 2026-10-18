/**
 * Broadcast dispatcher (F3.3.2). Schedule every minute:
 *   curl -X POST https://<host>/api/cron/broadcast-dispatch -H "Authorization: Bearer $CRON_SECRET"
 *
 * Starts scheduled broadcasts whose time has come, writes the remaining
 * chunks of broadcasts that are sending (big audiences), and marks broadcasts
 * past their expiry EXPIRED (they leave the notification centre at that time
 * regardless). Safe to overlap: each broadcast is leased while it is worked,
 * and recipients are unique per broadcast.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { dispatchBroadcasts } from "@/server/services/broadcasts";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await dispatchBroadcasts();
  console.info("[cron:broadcast-dispatch]", JSON.stringify(result));
  return ok(result);
});

/** Health probe so a scheduler can verify wiring without sending anything. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
