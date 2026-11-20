import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PinMap, StatusPill } from "@/components/consult/common";
import { JoinVideoButton } from "@/components/health/appointment-live";
import { LiveRefresh } from "@/components/health/live";
import { ComingSoon } from "@/components/health/page-shell";
import { Alert, PageHeader } from "@/components/ui";
import { CONSULT_BOOKING_PATH, CONSULT_MODE_LABELS, type ConsultMode } from "@/lib/consult/constants";
import { formatSlot } from "@/lib/consult/time";
import { formatPaiseCompact } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { appointmentView } from "@/server/health/find-doctor-views";

export const metadata = { title: "Appointment" };
export const dynamic = "force-dynamic";

type Params = { bookingId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GoKesari Health appointment (confirmation) page: booking ID, date and time in IST, clinic address and
 * directions, the check-in QR, add to calendar, the live queue for token clinics, the video Join button at
 * the slot time; reschedule / cancel / pay on the appointment's booking page.
 */
export default async function AppointmentPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<{ new?: string }> }) {
  const { bookingId } = await params;
  const sp = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=${encodeURIComponent(`/health/appointments/${bookingId}`)}`);
  if (!(await healthEnabled())) return <ComingSoon title="Appointment" />;
  if (!UUID.test(bookingId)) notFound();
  const a = await appointmentView(bookingId, user).catch(() => null);
  if (!a) notFound();
  const live = a.status === "CONFIRMED" || a.status === "PENDING_APPROVAL";
  const due = a.feePaise > 0 && a.paymentStatus !== "PAID" && a.paymentMode === "ONLINE";
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link href="/health/appointments" className="inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← My appointments
      </Link>
      <PageHeader title={a.serviceName} description={`Booking ${a.bookingNumber}`} action={<LiveRefresh names={["queue.updated", "appointment.", "consultation.started"]} />} />
      {sp.new === "1" ? (
        <Alert tone="success" title={a.status === "PENDING_APPROVAL" ? "Request sent" : "Booked"}>
          {a.status === "PENDING_APPROVAL" ? "The clinic confirms your request soon; you will get a notification." : "Your appointment is booked. Show the QR code at the clinic reception."}
        </Alert>
      ) : null}
      <section className="flex flex-col gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4" data-testid="health-appointment">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={a.status} />
          <span className="text-sm font-bold text-ink-700">ID {a.bookingNumber}</span>
        </div>
        <p className="text-lg font-extrabold text-ink-900" data-testid="health-appointment-time">
          {formatSlot(a.startsAt)} IST
        </p>
        <p className="text-sm text-ink-800">
          {a.patientName} with {a.doctorNames.join(", ")} · {CONSULT_MODE_LABELS[a.mode as ConsultMode]?.en ?? a.mode}
        </p>
        <p className="text-sm text-ink-700">
          Fee {a.feePaise === 0 ? "Free" : formatPaiseCompact(a.feePaise)} · {a.paymentStatus === "PAID" ? "paid" : a.paymentMode === "PAY_AT_VISIT" ? "pay at the clinic" : a.paymentStatus.toLowerCase().replace(/_/g, " ")}
        </p>
        {a.tokenNumber != null ? (
          <div className="mt-1 rounded-xl border-2 border-teal-300 bg-teal-50 p-3" data-testid="health-appointment-queue">
            <p className="text-2xl font-extrabold text-teal-900">Token {a.tokenNumber}</p>
            {a.queue ? (
              <p className="text-sm text-teal-900">
                {a.queue.nowServing != null ? `Now serving token ${a.queue.nowServing}. ` : "The clinic has not started calling yet. "}
                {a.queue.ahead > 0 ? `${a.queue.ahead} ${a.queue.ahead === 1 ? "patient" : "patients"} ahead of you.` : live ? "You are next or being seen." : ""}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2">
          <a href={`/api/consult/bookings/${a.bookingId}/ics`} className="inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] bg-white px-4 text-sm font-bold text-ink-800" data-testid="health-appointment-ics">
            📅 Add to calendar
          </a>
          <Link href={`${CONSULT_BOOKING_PATH}/${a.bookingId}`} className="inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] bg-white px-4 text-sm font-bold text-ink-800" data-testid="health-appointment-manage">
            {due ? "Pay, reschedule or cancel" : "Reschedule or cancel"}
          </Link>
        </div>
      </section>
      {a.meetingUrl ? <JoinVideoButton url={a.meetingUrl} startsAt={a.startsAt} endsAt={a.endsAt} /> : null}
      {a.checkInQrSvg ? (
        <section className="flex flex-col items-center gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4" data-testid="health-appointment-qr">
          <h2 className="text-base font-extrabold">Check-in QR</h2>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:image/svg+xml;utf8,${encodeURIComponent(a.checkInQrSvg)}`} alt={`Check-in code for booking ${a.bookingNumber}`} width={220} height={220} />
          <p className="text-center text-xs text-ink-600">Show this at the reception to check in.</p>
        </section>
      ) : null}
      {a.mode !== "VIDEO" ? (
        <section className="flex flex-col gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4 text-sm">
          <h2 className="text-base font-extrabold">{a.clinic.name}</h2>
          <p className="text-ink-700">{a.clinic.address}</p>
          {a.clinic.phone ? (
            <a href={`tel:${a.clinic.phone.replace(/[^\d+]/g, "")}`} className="font-bold text-kesari-800 underline">
              📞 {a.clinic.phone}
            </a>
          ) : null}
          {a.clinic.latitude != null && a.clinic.longitude != null ? <PinMap latitude={a.clinic.latitude} longitude={a.clinic.longitude} label={a.clinic.name} /> : null}
          {a.clinic.directionsUrl ? (
            <a href={a.clinic.directionsUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center font-bold text-kesari-800 underline" data-testid="health-appointment-directions">
              Directions
            </a>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
