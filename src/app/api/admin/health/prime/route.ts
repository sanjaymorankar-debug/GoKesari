/**
 * GoKesari Health Prime, admin (health:manage).
 * GET ?view=plans | coupons | subscriptions (&status&shopId) | revenue (&from&to YYYY-MM-DD)
 * POST { action: "plan", plan: {…} } · { action: "plan-status", planId, status } · { action: "coupon", coupon: {…} }
 *      · { action: "sync-instant-booking" } (after rule health.freeListingManualApproval changes)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { forbidden, validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { isHealthStaff } from "@/server/health/access";
import { bodyOf } from "@/server/health/http";
import { listCoupons, listPlans, listSubscriptionsAdmin, primeRevenueReport, saveCoupon, savePlan, savePlanStatus, syncInstantBookingForAllClinics } from "@/server/health/prime";

export const dynamic = "force-dynamic";

async function staff() {
  const user = await requireUser();
  if (!isHealthStaff(user)) throw forbidden("GoKesari Health staff only.");
  return user;
}

export const GET = route(async (request: NextRequest) => {
  const user = await staff();
  const q = request.nextUrl.searchParams;
  switch (q.get("view") ?? "plans") {
    case "plans":
      return ok({ plans: await listPlans(null, { includeInactive: true }) });
    case "coupons":
      return ok({ coupons: await listCoupons(user) });
    case "subscriptions":
      return ok({ subscriptions: await listSubscriptionsAdmin(user, { status: q.get("status"), shopId: q.get("shopId") }) });
    case "revenue":
      return ok(await primeRevenueReport(user, { from: q.get("from"), to: q.get("to") }));
    default:
      throw validationFailed("Unknown view.");
  }
});

export const POST = route(async (request: NextRequest) => {
  const user = await staff();
  enforceRateLimit(`health-prime-admin:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await bodyOf(request);
  switch (body.action) {
    case "plan":
      return ok({ plan: await savePlan(body.plan ?? {}, user) });
    case "plan-status":
      return ok({ plan: await savePlanStatus(z.string().uuid().parse(body.planId), z.enum(["ACTIVE", "INACTIVE"]).parse(body.status), user) });
    case "coupon":
      return ok({ coupon: await saveCoupon(body.coupon ?? {}, user) });
    case "sync-instant-booking":
      return ok(await syncInstantBookingForAllClinics(user));
    default:
      throw validationFailed("Unknown action.");
  }
});
