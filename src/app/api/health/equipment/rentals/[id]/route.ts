/**
 * One equipment rental — the customer (or the patient's linked account) and the store; anyone else 404.
 * GET → the rental as the viewer may see it (delivery code for the customer before delivery).
 * POST { action }:
 *   customer: pay · extend {periodCount} · schedule-return {pickupAt} · cancel {reason?} · dispute {reason}
 *   store:    dispatch · deliver {code} · schedule-return {pickupAt} · returned · close {conditionNote, damageRupees} · cancel {reason}
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { bodyOf, str, uuidParam } from "@/server/health/http";
import { cancelRental, closeRental, deliverRental, dispatchRental, extendRental, markReturned, payRental, rentalDispute, rentalView, scheduleReturn } from "@/server/health/rentals";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  return ok(await rentalView(await uuidParam(context, "id"), user));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = await uuidParam(context, "id");
  // Only the customer, the patient's people and the store get past this line (anyone else: 404).
  await rentalView(id, user);
  const body = await bodyOf(request);
  const action = str(body, "action");
  enforceRateLimit(`health-rental:${user.id}`, action === "pay" || action === "extend" ? RATE_LIMITS.PAYMENT : RATE_LIMITS.MUTATION);
  switch (action) {
    case "pay":
      return ok(await payRental(id, user));
    case "extend":
      return ok(await extendRental(id, body, user));
    case "schedule-return":
      return ok({ status: (await scheduleReturn(id, body, user)).status });
    case "cancel":
      return ok({ status: (await cancelRental(id, str(body, "reason"), user)).status });
    case "dispute":
      return ok(await rentalDispute(id, body, user));
    case "dispatch":
      return ok({ status: (await dispatchRental(id, user)).status });
    case "deliver":
      return ok({ status: (await deliverRental(id, str(body, "code"), user)).status });
    case "returned":
      return ok({ status: (await markReturned(id, user)).status });
    case "close":
      return ok({ status: (await closeRental(id, body, user)).status });
    default:
      throw validationFailed("Unknown action.");
  }
});
