/**
 * Push receipts (F13.1.2). Schedule every 15 minutes:
 *   curl -X POST https://<host>/api/cron/push-receipts -H "Authorization: Bearer $CRON_SECRET"
 *
 * Reads Expo's receipts for push tickets older than rule push.receiptDelayMinutes,
 * records DELIVERED / ERROR per device in push_tickets, and deactivates devices
 * Expo reports as DeviceNotRegistered. Idempotent.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { checkPushReceipts } from "@/server/notifications/push/receipts";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await checkPushReceipts();
  console.info("[cron:push-receipts]", JSON.stringify(result));
  return ok(result);
});

export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
