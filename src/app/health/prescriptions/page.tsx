import Link from "next/link";

import { PageHeader } from "@/components/ui";
import { BackToHealth, patientPage } from "@/components/health/page-shell";
import { PersonSwitcher } from "@/components/health/patient";
import { formatIst } from "@/lib/consult/time";
import { patientPrescriptions } from "@/server/health/prescriptions";

export const metadata = { title: "Prescriptions" };
export const dynamic = "force-dynamic";

export default async function PrescriptionsPage({ searchParams }: { searchParams: Promise<{ patient?: string }> }) {
  const sp = await searchParams;
  const page = await patientPage("/health/prescriptions", "Prescriptions", sp.patient);
  if (page.kind === "render") return page.node;
  const list = await patientPrescriptions(page.current.id, page.user);
  return (
    <div className="mx-auto max-w-3xl">
      <BackToHealth patientId={page.current.id} />
      <PageHeader title={`Prescriptions — ${page.current.fullName}`} description="Every prescription from a GoKesari doctor. Open one to print, share or get the medicines." />
      <PersonSwitcher people={page.lite} current={page.current.id} basePath="/health/prescriptions" />
      {list.length ? (
        <ul className="flex flex-col gap-2" data-testid="health-prescriptions">
          {list.map((r) => (
            <li key={r.id}>
              <Link href={`/health/prescriptions/${r.id}`} className="block rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 hover:border-kesari-300">
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
        <p className="text-sm text-ink-600">No prescriptions yet.</p>
      )}
    </div>
  );
}
