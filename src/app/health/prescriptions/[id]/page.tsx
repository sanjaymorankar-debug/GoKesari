import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/ui";
import { BackToHealth } from "@/components/health/page-shell";
import { ShareButton, SuggestionList } from "@/components/health/patient";
import { BTN_PRIMARY, BTN_SECONDARY } from "@/components/health/styles";
import { LiveRefresh } from "@/components/health/live";
import { formatIst } from "@/lib/consult/time";
import { RX_FREQUENCY_LABELS, RX_TIMING_LABELS, type RxTiming } from "@/lib/health/constants";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { prescriptionView } from "@/server/health/prescriptions";
import { vitalsLine } from "@/server/health/rx-pdf";

export const metadata = { title: "Prescription" };
export const dynamic = "force-dynamic";

/** A prescription for the patient: medicines, advice, the doctor's suggestions with Book now, PDF, print, share, get medicines. */
export default async function PrescriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=/health/prescriptions/${id}`);
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const view = await prescriptionView(id, user).catch((e) => {
    if (e instanceof AppError) notFound();
    throw e;
  });
  const c = view.content;
  const rx = view.prescription;
  const latest = view.versions[0];
  return (
    <div className="mx-auto max-w-3xl">
      {view.viewer === "PATIENT" ? <BackToHealth patientId={rx.patientId} /> : null}
      <PageHeader title={`Prescription ${rx.rxNumber}${rx.version > 1 ? ` (v${rx.version})` : ""}`} description={`${c.doctor.name} · ${c.clinic.name} · ${formatIst(rx.issuedAt)}`} action={<LiveRefresh names={["prescription.amended", "suggestion."]} subjectId={undefined} />} />
      {rx.status !== "ISSUED" ? (
        <p className="mb-3 rounded-xl border-2 border-amber-300 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">
          This version was replaced.{" "}
          {latest ? (
            <Link className="underline" href={`/health/prescriptions/${latest.id}`}>
              Open version {latest.version}
            </Link>
          ) : null}
        </p>
      ) : null}
      {rx.amendReason ? <p className="mb-3 text-sm font-bold text-kesari-900">Amended: {rx.amendReason}</p> : null}
      <div className="mb-4 flex flex-wrap gap-2">
        {view.viewer === "PATIENT" && rx.status === "ISSUED" && view.items.length ? (
          <Link className={BTN_PRIMARY} href={`/health/medicines/new?prescription=${rx.id}`} data-testid="health-get-medicines">
            Get medicines
          </Link>
        ) : null}
        <a className={BTN_SECONDARY} href={`/api/health/prescriptions/${rx.id}/pdf`} target="_blank" rel="noreferrer" data-testid="health-rx-pdf">
          Open PDF
        </a>
        <a className={BTN_SECONDARY} href={`/health/prescriptions/${rx.id}/print`} target="_blank" rel="noreferrer">
          Print
        </a>
        {view.viewer === "PATIENT" ? <ShareButton patientId={rx.patientId} objectType="PRESCRIPTION" objectId={rx.id} /> : null}
      </div>
      <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4">
        <p className="text-sm text-ink-800">
          <span className="font-extrabold">{c.patient.name}</span> {[c.patient.age, c.patient.gender].filter(Boolean).join(" / ")}
        </p>
        <p className="text-xs text-ink-600">
          {c.doctor.qualifications} · Reg. {c.doctor.registrationNumber} ({c.doctor.council})
        </p>
        {vitalsLine(c.vitals) ? <p className="mt-2 text-sm text-ink-800">Vitals: {vitalsLine(c.vitals)}</p> : null}
        {c.chiefComplaints ? <p className="mt-1 text-sm text-ink-800">Complaints: {c.chiefComplaints}</p> : null}
        {c.diagnoses.length ? <p className="mt-1 text-sm text-ink-900">Diagnosis: {c.diagnoses.map((d) => d.text).join("; ")}</p> : null}
        <h2 className="mt-3 text-sm font-extrabold uppercase tracking-wide text-kesari-900">Medicines</h2>
        {view.items.length ? (
          <ol className="mt-1 flex flex-col gap-2" data-testid="health-rx-items">
            {view.items.map((i) => (
              <li key={i.id} className="rounded-xl border-2 border-[var(--gk-line)] p-2">
                <p className="font-extrabold text-ink-900">
                  {i.lineNo}. {i.brandName ? `${i.brandName} (${i.genericName})` : i.genericName} {i.strength}
                </p>
                <p className="text-sm text-ink-800">
                  {i.dose} · {RX_FREQUENCY_LABELS[i.frequency]?.en ?? i.frequency} · {RX_TIMING_LABELS[i.timing as RxTiming]?.en ?? i.timing} · {i.durationDays} days · qty {i.quantity}
                  {i.dispensedQty ? ` (${i.dispensedQty} dispensed)` : ""}
                </p>
                {i.instructions ? <p className="text-sm text-ink-700">{i.instructions}</p> : null}
                {i.instructionsLocal ? <p className="text-sm text-ink-700">{i.instructionsLocal}</p> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-ink-600">No medicines.</p>
        )}
        {c.investigations.length ? <p className="mt-2 text-sm text-ink-800">Tests advised: {c.investigations.map((t) => t.name).join(", ")}</p> : null}
        {c.advice ? <p className="mt-1 text-sm text-ink-800">Advice: {c.advice}</p> : null}
        {c.followUpDate ? <p className="mt-1 text-sm font-bold text-ink-900">Follow-up: {c.followUpDate}</p> : null}
      </section>
      {view.suggestions.length ? (
        <section className="mt-4">
          <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">{view.viewer === "DOCTOR" ? "Suggestions (booking status only)" : "Your doctor suggested"}</h2>
          {view.viewer === "PATIENT" ? (
            <SuggestionList followUpMemberId={rx.memberId} items={view.suggestions} />
          ) : (
            <ul className="flex flex-col gap-1">
              {view.suggestions.map((s) => (
                <li key={s.id} className="text-sm">
                  {s.text} — <span className="font-bold">{s.status === "BOOKED" ? "Booked" : s.status === "OPEN" ? "Not booked yet" : s.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {view.versions.length > 1 ? (
        <section className="mt-4">
          <h2 className="mb-1 text-sm font-extrabold uppercase tracking-wide text-ink-600">Versions</h2>
          <ul className="text-sm">
            {view.versions.map((v) => (
              <li key={v.id}>
                <Link className="font-bold text-kesari-800 underline" href={`/health/prescriptions/${v.id}`}>
                  Version {v.version}
                </Link>{" "}
                · {formatIst(v.issuedAt)} {v.amendReason ? `· ${v.amendReason}` : ""} {v.status === "SUPERSEDED" ? "(replaced)" : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
