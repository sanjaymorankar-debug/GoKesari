/**
 * GST due-date reminders to shop owners (docs/inventory-accounting-2026-10). Daily;
 * one reminder per return and period, ever.
 *   curl -X POST https://<host>/api/cron/gst-reminders -H "Authorization: Bearer $CRON_SECRET"
 */
import type { NextRequest } from "next/server";

import { assertCronAuthorized } from "@/server/api/cron-auth";
import { ok, route } from "@/server/api/handler";
import { sendGstReminders } from "@/server/accounts/gst";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok(await sendGstReminders());
});
