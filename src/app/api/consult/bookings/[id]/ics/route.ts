/** GET — the booking as an .ics calendar file (Google Calendar, Outlook, Apple Calendar). */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { CONSULT_MODE_LABELS } from "@/lib/consult/constants";
import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { bookingDetail } from "@/server/consult/views";

export const dynamic = "force-dynamic";

const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const d = await bookingDetail(z.string().uuid().parse((await context.params).id), user);
  const c = d.card;
  const where = c.mode === "VIDEO" ? d.booking.meetingUrl ?? "Video call" : c.mode === "PHONE" ? "Phone call" : c.mode === "HOME_VISIT" ? d.booking.visitAddress ?? "Home visit" : d.firm.address;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GoKesari//Appointments//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${c.id}@gokesari.com`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(c.startsAt)}`,
    `DTEND:${stamp(c.endsAt)}`,
    `SUMMARY:${esc(`${c.serviceName} — ${d.viewer === "CUSTOMER" ? d.firm.name : c.visitorName}`)}`,
    `LOCATION:${esc(where)}`,
    `DESCRIPTION:${esc(`Booking ${c.bookingNumber} (${CONSULT_MODE_LABELS[c.mode as keyof typeof CONSULT_MODE_LABELS]?.en ?? c.mode}). ${new URL(`/consult/bookings/${c.id}`, request.nextUrl.origin).toString()}`)}`,
    c.status === "CANCELLED" || c.status === "REJECTED" ? "STATUS:CANCELLED" : "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT1H",
    "ACTION:DISPLAY",
    `DESCRIPTION:${esc(c.serviceName)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return new NextResponse(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${c.bookingNumber}.ics"`,
      "Cache-Control": "private, no-store",
    },
  });
});
