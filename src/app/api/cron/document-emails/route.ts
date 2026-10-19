/**
 * Document emails retry (batch-2026-10 WS-E): invoices, statements and fee
 * invoices are emailed the moment they are issued; this only resends what
 * failed, on its backoff. Schedule every few minutes:
 *   curl -X POST https://<host>/api/cron/document-emails -H "Authorization: Bearer $CRON_SECRET"
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { deliverDocumentEmails } from "@/server/documents/email";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await deliverDocumentEmails();
  console.info("[cron:document-emails]", JSON.stringify(result));
  return ok(result);
});
