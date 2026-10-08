/**
 * Operations: run the legal-document check now (it also runs with the daily
 * seller-verification job) — starts the grace period for live shops whose
 * requirement was never seen, and sends due expiry reminders. Idempotent.
 */
import { ok, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { runLegalDocumentSweep } from "@/server/services/legal-documents";

export const POST = route(async () => {
  const user = await requirePermission(PERMISSIONS.SHOP_GST_PAN_VERIFY);
  enforceRateLimit(`legal-document-sweep:${user.id}`, RATE_LIMITS.VOUCHER_PREVIEW);
  return ok(await runLegalDocumentSweep());
});
