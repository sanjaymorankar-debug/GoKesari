import Link from "next/link";
import { redirect } from "next/navigation";

import { StatusPill } from "@/components/consult/common";
import { PageHeader } from "@/components/ui";
import { CONSULT_MODE_LABELS, type ConsultMode } from "@/lib/consult/constants";
import { formatSlot } from "@/lib/consult/time";
import { formatPaiseCompact } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { customerBookings, type BookingCard } from "@/server/consult/views";

export const metadata = { title: "My appointments" };
export const dynamic = "force-dynamic";

function Row({ b }: { b: BookingCard }) {
  return (
    <li>
      <Link href={`/consult/bookings/${b.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 hover:border-kesari-300" data-testid="consult-my-booking">
        <span className="min-w-0">
          <span className="block font-extrabold text-ink-900">{formatSlot(b.startsAt)}</span>
          <span className="block text-sm text-ink-700">
            {b.serviceName} · {CONSULT_MODE_LABELS[b.mode as ConsultMode]?.en} · {b.members.map((m) => m.name).join(", ") || b.firmName}
          </span>
          <span className="block text-xs text-ink-500">
            {b.bookingNumber} · {b.firmName} · {b.feePaise ? formatPaiseCompact(b.feePaise) : "Free"}
          </span>
        </span>
        <StatusPill status={b.status} rescheduled={b.rescheduleCount > 0} />
      </Link>
    </li>
  );
}

/** The customer's consultant appointments: upcoming first, then history. */
export default async function MyAppointmentsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/consult/bookings");
  const { upcoming, past } = await customerBookings(user.id);
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/consult" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Find a Consultant
      </Link>
      <PageHeader title="My appointments" description="Upcoming bookings, reminders, payments, refunds and history. Times in IST." />
      <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">Upcoming</h2>
      {upcoming.length ? <ul className="mb-6 flex flex-col gap-2">{upcoming.map((b) => <Row key={b.id} b={b} />)}</ul> : <p className="mb-6 text-sm text-ink-600">Nothing booked. <Link href="/consult" className="font-bold text-kesari-800 underline">Find a consultant</Link></p>}
      <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">History</h2>
      {past.length ? <ul className="flex flex-col gap-2">{past.map((b) => <Row key={b.id} b={b} />)}</ul> : <p className="text-sm text-ink-600">No past appointments.</p>}
    </div>
  );
}
