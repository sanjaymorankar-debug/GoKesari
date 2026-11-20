import { PageHeader } from "@/components/ui";
import { formatIst } from "@/lib/consult/time";
import { getCurrentUser } from "@/server/authz/guards";
import { verifyPrescription } from "@/server/health/prescriptions";

export const metadata = { title: "Verify a prescription", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * Opened by the QR on a GoKesari prescription. Anyone learns whether it is genuine, by which registered
 * doctor and when; the patient, the issuing doctor and a medical store it was sent to (signed in) also
 * see the patient and the medicines with the PDF's fingerprint.
 */
export default async function VerifyPrescriptionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getCurrentUser();
  const r = await verifyPrescription(token, user);
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Prescription check" />
      {r.status === "NOT_FOUND" ? (
        <p className="rounded-2xl border-2 border-red-300 bg-red-50 p-4 text-base font-extrabold text-red-800" data-testid="rx-verify" data-status="NOT_FOUND">
          Not found. This is not a GoKesari prescription, or the code is damaged.
        </p>
      ) : (
        <div className={`rounded-2xl border-2 p-4 ${r.valid ? "border-leaf-400 bg-leaf-50" : "border-amber-400 bg-amber-50"}`} data-testid="rx-verify" data-status={r.status}>
          <p className="text-lg font-extrabold text-ink-900">{r.valid ? "✔ Genuine GoKesari prescription" : `Replaced by version ${r.latestVersion} — ask the patient for the latest one`}</p>
          <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="font-bold">Number</dt>
            <dd>
              {r.rxNumber}
              {r.version && r.version > 1 ? ` (version ${r.version})` : ""}
            </dd>
            <dt className="font-bold">Issued</dt>
            <dd>{r.issuedAt ? formatIst(r.issuedAt) : "—"}</dd>
            <dt className="font-bold">Valid until</dt>
            <dd>{r.validUntil ?? "—"}</dd>
            <dt className="font-bold">Doctor</dt>
            <dd>{r.doctor}</dd>
            <dt className="font-bold">Registration</dt>
            <dd>{r.registration}</dd>
            <dt className="font-bold">Clinic</dt>
            <dd>{r.clinic}</dd>
          </dl>
          {r.details ? (
            <div className="mt-3 border-t border-leaf-200 pt-3 text-sm">
              <p className="font-bold">Patient: {r.details.patient}</p>
              <ul className="list-disc pl-5">
                {r.details.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
              {r.details.pdfHash ? <p className="mt-1 break-all text-xs text-ink-600">PDF fingerprint (SHA-256): {r.details.pdfHash}</p> : null}
            </div>
          ) : (
            <p className="mt-3 text-xs text-ink-600">Patient details are shown only to the patient, the doctor and a medical store the patient sent it to (signed in).</p>
          )}
        </div>
      )}
    </div>
  );
}
