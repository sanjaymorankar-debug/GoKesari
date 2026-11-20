/**
 * One consultant booking (docs/consult-booking-2026-11). The customer, the firm (owner / assigned member)
 * and consult staff only; anyone else gets 404.
 * GET → the booking as the viewer may see it (with what they may do)
 * POST { action, … }:
 *   customer: cancel {reason?} · reschedule {start, note?} · pay {part: ADVANCE|BALANCE} · rate {rating, review?} · dispute {reason}
 *   firm:     cancel {reason} · reschedule {start, memberId?, note?} · accept · reject {reason} · arrive · complete {code?}
 *             · no-show · note {text} · paid {method, amountRupees?} · meeting {url} · reassign {memberId}
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import {
  cancelBooking,
  completeBooking,
  decideBooking,
  markArrived,
  markNoShow,
  markOfflinePaid,
  payBalanceOnline,
  raiseDispute,
  rateBooking,
  reassignBooking,
  rescheduleBooking,
  retryBookingPayment,
  setMeetingUrl,
  setPrivateNote,
} from "@/server/consult/bookings";
import { bookingViewer } from "@/server/consult/access";
import { requireBooking } from "@/server/consult/payments";
import { bookingDetail } from "@/server/consult/views";

export const dynamic = "force-dynamic";

const idOf = async (context: RouteContext<{ id: string }>) => z.string().uuid().parse((await context.params).id);
const ipOf = (request: NextRequest) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  return ok(await bookingDetail(await idOf(context), user, ipOf(request)));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = await idOf(context);
  // Only the customer, the firm and staff get past this line (anyone else: 404).
  await bookingViewer(await requireBooking(id), user);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const text = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : null);
  enforceRateLimit(`consult-action:${user.id}`, action === "pay" ? RATE_LIMITS.PAYMENT : RATE_LIMITS.MUTATION);
  switch (action) {
    case "cancel":
      return ok({ booking: await cancelBooking(id, user, text("reason")) });
    case "reschedule":
      return ok({ booking: await rescheduleBooking(id, body, user) });
    case "pay": {
      const started = body.part === "BALANCE" ? await payBalanceOnline(id, user) : await retryBookingPayment(id, user);
      return ok({ checkoutUrl: started.checkoutUrl, intentId: started.intentId });
    }
    case "rate":
      return ok({ booking: await rateBooking(id, body, user) });
    case "dispute":
      return ok(await raiseDispute(id, body, user));
    case "accept":
      return ok({ booking: await decideBooking(id, true, user, null) });
    case "reject":
      return ok({ booking: await decideBooking(id, false, user, text("reason")) });
    case "arrive":
      return ok({ booking: await markArrived(id, user) });
    case "complete":
      return ok({ booking: await completeBooking(id, user, text("code")) });
    case "no-show":
      return ok({ booking: await markNoShow(id, user) });
    case "note":
      return ok({ booking: await setPrivateNote(id, text("text") ?? "", user) });
    case "paid":
      return ok({ booking: await markOfflinePaid(id, body, user) });
    case "meeting":
      return ok({ booking: await setMeetingUrl(id, text("url") ?? "", user) });
    case "reassign":
      return ok({ booking: await reassignBooking(id, z.string().uuid().parse(body.memberId), user) });
    default:
      throw validationFailed("Unknown action.");
  }
});
