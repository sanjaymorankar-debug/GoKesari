/**
 * RBAC v2 hourly sweep (docs/rbac): the deadlines no event can start. Each part is a no-op while its
 * flag is off. Idempotent: a late or repeated run is harmless.
 *   - rate proposals whose effective time has come (Phase 3)
 *   - change-request reminders and expiry (Phase 5), ticket SLA (Phase 4), handover confirmations (Phase 7)
 */
import { isFeatureEnabled } from "@/server/services/feature-flags";

export async function runRbacV2Sweep(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (await isFeatureEnabled("rbac_v2_accounting")) {
    out.rates = await (await import("@/server/rbac-accounting/rates")).activateDueRateProposals();
  }
  if (await isFeatureEnabled("rbac_v2_shop_change_requests")) {
    out.changeRequests = await (await import("@/server/rbac-support/change-requests")).sweepShopChangeRequests();
  }
  if (await isFeatureEnabled("rbac_v2_support")) {
    out.supportDesk = await (await import("@/server/rbac-support/desk")).sweepSupportDesk();
  }
  return out;
}
