import Link from "next/link";

import { StatusPill } from "@/components/consult/common";
import { PageHeader } from "@/components/ui";
import { BackToHealth, patientPage } from "@/components/health/page-shell";
import { PersonSwitcher } from "@/components/health/patient";
import { LiveRefresh } from "@/components/health/live";
import { CONSULT_MODE_LABELS, type ConsultMode } from "@/lib/consult/constants";
import { formatSlot } from "@/lib/consult/time";
import { patientAppointments } from "@/server/health/booking";

export const metadata = { title: "Health appointments" };

type Rows = Awaited<ReturnType<typeof patientAppointments>>;

/** Still to come (or running now) and not finished — oldest first. */
function upcomingOf(rows: Rows): Rows {
  const now = Date.now();
  return rows.filter((r) => r.b.endsAt.getTime() >= now && ["CONFIRMED", "PENDING_APPROVAL", "PENDING_PAYMENT"].includes(r.b.status)).reverse();
}
export const dynamic = "force-dynamic";

/** Appointments of one person (doctors, home care): upcoming first; each opens its check-in QR, queue and details. */
export default async function HealthAppointmentsPage({ searchParams }: { searchParams: Promise<{ patient?: string }> }) {
  const sp = await searchParams;
  const page = await patientPage("/health/appointments", "Appointments", sp.patient);
  if (page.kind === "render") return page.node;
  const rows = await patientAppointments(page.current.id, page.user);
  const upcoming = upcomingOf(rows);
  const past = rows.filter((r) => !upcoming.includes(r));
  const Row = ({ r }: { r: (typeof rows)[number] }) => (
    <li>
      <Link href={`/health/appointments/${r.b.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 hover:border-kesari-300" data-testid="health-appointment">
        <span className="min-w-0">
          <span className="block font-extrabold text-ink-900">{formatSlot(r.b.startsAt)}</span>
          <span className="block text-sm text-ink-700">
            {r.b.serviceName} · {CONSULT_MODE_LABELS[r.b.mode as ConsultMode]?.en}
            {r.link.tokenNumber ? ` · token ${r.link.tokenNumber}` : ""}
          </span>
          <span className="block text-xs text-ink-500">{r.b.bookingNumber}</span>
        </span>
        <StatusPill status={r.b.status} rescheduled={r.b.rescheduleCount > 0} />
      </Link>
    </li>
  );
  return (
    <div className="mx-auto max-w-3xl">
      <BackToHealth patientId={page.current.id} />
      <PageHeader title={`Appointments — ${page.current.fullName}`} description="Times in IST." action={<LiveRefresh names={["appointment.", "queue.updated"]} />} />
      <PersonSwitcher people={page.lite} current={page.current.id} basePath="/health/appointments" />
      <div className="mb-4">
        <Link href={`/health/doctors?patient=${page.current.id}`} className="inline-flex min-h-11 items-center rounded-xl bg-kesari-700 px-4 text-sm font-extrabold text-white">
          Book a doctor
        </Link>
      </div>
      <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">Upcoming</h2>
      {upcoming.length ? <ul className="mb-6 flex flex-col gap-2">{upcoming.map((r) => <Row key={r.b.id} r={r} />)}</ul> : <p className="mb-6 text-sm text-ink-600">Nothing booked.</p>}
      <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">History</h2>
      {past.length ? <ul className="flex flex-col gap-2">{past.map((r) => <Row key={r.b.id} r={r} />)}</ul> : <p className="text-sm text-ink-600">No past appointments.</p>}
    </div>
  );
}
