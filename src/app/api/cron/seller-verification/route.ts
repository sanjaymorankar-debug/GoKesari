/**
 * Seller verification sweep. Schedule daily, e.g. 06:30 IST:
 *   curl -X POST https://<host>/api/cron/seller-verification -H "Authorization: Bearer $CRON_SECRET"
 *
 * Retries documents a vendor outage left PENDING, re-checks GSTINs, warns
 * sellers before FSSAI / Shop Act expiry, marks expired documents and takes a
 * shop offline when a mandatory document has lapsed, and reminds support of
 * documents stuck in manual review (event layer). Checking a submitted
 * document happens in the seller's own request, not here. Idempotent.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { runSellerVerificationSweep } from "@/server/services/seller-verification-jobs";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await runSellerVerificationSweep();
  console.info("[cron:seller-verification]", JSON.stringify(result));
  return ok(result);
});

/** Health probe so a scheduler can verify wiring without running the sweep. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
