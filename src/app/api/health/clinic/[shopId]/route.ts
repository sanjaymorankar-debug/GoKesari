/**
 * A clinic's day. GET ?date=YYYY-MM-DD&member= → Today rows (who is coming, when, check-in, payment) and settings.
 * POST { action: call {bookingId} | reorder {bookingIds} | walkin {...} | checkin {bookingId, code?} | find-qr {payload}
 *        | settings {...} | request-access {patientId, memberId, bookingId?} }
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isDateKey } from "@/lib/consult/time";
import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireFirmAccess } from "@/server/consult/access";
import { requireHealthEnabled } from "@/server/health/access";
import { addWalkIn, callPatient, clinicDay, reorderQueue } from "@/server/health/booking";
import { requestRecordAccess } from "@/server/health/consent";
import { checkInBooking, findBookingByQr } from "@/server/health/consultations";
import { clinicSettings, saveClinicSettings } from "@/server/health/doctors";
import { bodyOf, str, uuidParam } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ shopId: string }>) => {
  const user = await requireUser();
  const shopId = await uuidParam(context, "shopId");
  const date = request.nextUrl.searchParams.get("date");
  const member = request.nextUrl.searchParams.get("member");
  const rows = await clinicDay(shopId, user, isDateKey(date) ? date : undefined, member && /^[0-9a-f-]{36}$/.test(member) ? member : null);
  return ok({ rows, settings: await clinicSettings(shopId) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ shopId: string }>) => {
  const user = await requireUser();
  await requireHealthEnabled();
  const shopId = await uuidParam(context, "shopId");
  enforceRateLimit(`health-clinic:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await bodyOf(request);
  const uuid = (k: string) => z.string().uuid().parse(body[k]);
  switch (body.action) {
    case "call":
      await callPatient(shopId, uuid("bookingId"), user);
      return ok({ called: true });
    case "reorder":
      await reorderQueue(shopId, z.array(z.string().uuid()).max(500).parse(body.bookingIds), user);
      return ok({ reordered: true });
    case "walkin":
      return ok(await addWalkIn(shopId, body, user), 201);
    case "checkin": {
      await requireFirmAccess(shopId, user, "bookings");
      return ok(await checkInBooking(uuid("bookingId"), str(body, "code"), user));
    }
    case "find-qr": {
      await requireFirmAccess(shopId, user, "bookings");
      return ok({ bookingId: await findBookingByQr(shopId, str(body, "payload") ?? "") });
    }
    case "settings":
      return ok({ settings: await saveClinicSettings(shopId, body, user) });
    case "request-access":
      await requireFirmAccess(shopId, user, "bookings");
      await requestRecordAccess(uuid("patientId"), uuid("memberId"), body.bookingId ? uuid("bookingId") : null, user);
      return ok({ requested: true });
    default:
      throw validationFailed("Unknown action.");
  }
});
