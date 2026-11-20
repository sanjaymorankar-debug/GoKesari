import Link from "next/link";
import { notFound } from "next/navigation";

import { BookDoctor } from "@/components/health/book-doctor";
import { patientPage } from "@/components/health/page-shell";
import { Alert, PageHeader } from "@/components/ui";
import { isDateKey } from "@/lib/consult/time";
import { consultEnabled } from "@/server/consult/access";
import { bookingContext } from "@/server/health/find-doctor-views";

export const metadata = { title: "Book a doctor" };
export const dynamic = "force-dynamic";

type Params = { serviceId: string };
type Search = { member?: string; patient?: string; suggestion?: string; date?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GoKesari Health booking: a verified doctor, for me or a family member — mode, time (or token day),
 * reason, record sharing, payment. From a prescription's "Book now" (?suggestion=…) the patient is chosen
 * already and the suggestion is marked booked; a follow-up opens on its date (?date=YYYY-MM-DD).
 */
export default async function BookDoctorPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<Search> }) {
  const { serviceId } = await params;
  const sp = await searchParams;
  if (!UUID.test(serviceId)) notFound();
  const qs = new URLSearchParams(Object.entries(sp).filter(([, v]) => typeof v === "string") as [string, string][]).toString();
  const page = await patientPage(`/health/book/${serviceId}${qs ? `?${qs}` : ""}`, "Book a doctor", sp.patient);
  if (page.kind === "render") return page.node;
  if (!(await consultEnabled())) notFound();
  const ctx = await bookingContext(serviceId, sp.member && UUID.test(sp.member) ? sp.member : null, page.user, sp.suggestion ?? null).catch(() => null);
  if (!ctx) notFound();
  const fromParam = sp.patient && ctx.family.some((p) => p.id === sp.patient) ? sp.patient : null;
  const preselect = ctx.preselectPatientId ?? fromParam ?? page.current.id;
  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/health/doctors/${ctx.doctor.memberId}`} className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← {ctx.doctor.name}
      </Link>
      <PageHeader title={`Book ${ctx.doctor.name}`} description={`${ctx.clinic.name} · ${ctx.clinic.address}`} />
      {sp.suggestion && !ctx.suggestionId ? (
        <div className="mb-3">
          <Alert tone="info">This suggestion was already booked or is not for someone in your account; you can still book a new appointment.</Alert>
        </div>
      ) : null}
      {!ctx.family.length ? (
        <Alert tone="warning">
          Add yourself or a family member in <Link href="/health/family" className="font-bold underline">Family</Link> first.
        </Alert>
      ) : (
        <BookDoctor ctx={ctx} preselectPatientId={preselect} preselectDate={sp.date && isDateKey(sp.date) ? sp.date : null} />
      )}
    </div>
  );
}
