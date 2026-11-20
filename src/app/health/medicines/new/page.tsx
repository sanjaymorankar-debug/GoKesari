import Link from "next/link";

import { PageHeader } from "@/components/ui";
import { BackToHealth, patientPage } from "@/components/health/page-shell";
import { PersonSwitcher } from "@/components/health/patient";
import { NewMedicineOrder } from "@/components/health/rx-patient";
import { formatIst } from "@/lib/consult/time";
import { patientPrescriptions } from "@/server/health/prescriptions";

export const metadata = { title: "Get medicines" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Get medicines: pick medicines and quantities from a prescription → a nearby GoKesari medical store →
 * pickup or delivery → send. Without ?prescription= the patient first picks one of their prescriptions.
 * ?from=<order> ("Send to another store") keeps the earlier choice of medicines.
 */
export default async function NewMedicineOrderPage({ searchParams }: { searchParams: Promise<{ prescription?: string; from?: string; patient?: string }> }) {
  const sp = await searchParams;
  const q = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string")).toString();
  const page = await patientPage(`/health/medicines/new${q ? `?${q}` : ""}`, "Get medicines", sp.patient);
  if (page.kind === "render") return page.node;
  const prescriptionId = sp.prescription && UUID.test(sp.prescription) ? sp.prescription : null;
  const fromOrderId = sp.from && UUID.test(sp.from) ? sp.from : null;
  if (prescriptionId) {
    return (
      <div className="mx-auto max-w-3xl">
        <Link href="/health/medicines" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
          ← Medicine orders
        </Link>
        <PageHeader title={fromOrderId ? "Send to another store" : "Get medicines"} description="Pickup from a nearby medical store or home delivery. You approve the price before you pay." />
        <NewMedicineOrder prescriptionId={prescriptionId} fromOrderId={fromOrderId} />
      </div>
    );
  }
  const list = await patientPrescriptions(page.current.id, page.user);
  return (
    <div className="mx-auto max-w-3xl">
      <BackToHealth patientId={page.current.id} />
      <PageHeader title="Get medicines" description="Choose the prescription to send to a medical store." />
      <PersonSwitcher people={page.lite} current={page.current.id} basePath="/health/medicines/new" />
      {list.length ? (
        <ul className="flex flex-col gap-2" data-testid="rx-choose-prescription">
          {list
            .filter((r) => r.items > 0)
            .map((r) => (
              <li key={r.id}>
                <Link href={`/health/medicines/new?prescription=${r.id}`} className="block rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 hover:border-kesari-300">
                  <span className="block font-extrabold text-ink-900">
                    {r.rxNumber}
                    {r.version > 1 ? ` (version ${r.version})` : ""} · {r.doctor}
                  </span>
                  <span className="block text-sm text-ink-700">
                    {r.clinic} · {r.items} {r.items === 1 ? "medicine" : "medicines"} · {formatIst(r.issuedAt)}
                  </span>
                </Link>
              </li>
            ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-600">
          No prescriptions yet. Prescriptions from GoKesari doctors appear here. <Link href="/health" className="font-bold text-kesari-800 underline">My Health</Link>
        </p>
      )}
    </div>
  );
}
