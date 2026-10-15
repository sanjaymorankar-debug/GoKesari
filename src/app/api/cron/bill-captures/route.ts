/**
 * Safety net for the supplier-bill reading queue (docs/inventory-accounting-2026-10):
 * bills are read right after upload; this picks up any left waiting (a server
 * restart mid-read). Safe to run every few minutes and repeatedly.
 *   curl -X POST https://<host>/api/cron/bill-captures -H "Authorization: Bearer $CRON_SECRET"
 */
import type { NextRequest } from "next/server";

import { assertCronAuthorized } from "@/server/api/cron-auth";
import { ok, route } from "@/server/api/handler";
import { dispatchCaptures } from "@/server/accounts/capture/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok(await dispatchCaptures(10));
});
