/**
 * Billing v2 (docs/billing): the daily billing work by hand (it also runs in
 * the 05:00 IST daily cron — tax/daily.ts). On production, single cron routes
 * answer only when CRON_ROUTES_ENABLED=true (proxy.ts).
 *   curl -X POST https://<host>/api/cron/compliance-reminders -H "Authorization: Bearer $CRON_SECRET"
 */
import type { NextRequest } from "next/server";

import { assertCronAuthorized } from "@/server/api/cron-auth";
import { ok, route } from "@/server/api/handler";
import { runBillingDaily } from "@/server/tax/daily";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok(await runBillingDaily());
});
