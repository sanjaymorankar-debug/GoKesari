import Link from "next/link";
import { redirect } from "next/navigation";

import { ComingSoon } from "@/components/health/page-shell";
import { LiveRefresh } from "@/components/health/live";
import { Alert, PageHeader } from "@/components/ui";
import { formatSlot } from "@/lib/consult/time";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { patientCareVisits } from "@/server/health/care";

export const metadata = { title: "My home-care visits" };
export const dynamic = "force-dynamic";

/** Every home-care visit of the family, newest first (live). */
export default async function CareVisitsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/health/care/visits");
  if (!(await healthEnabled())) return <ComingSoon title="My home-care visits" />;
  const visits = await patientCareVisits(user);
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/health/care" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Home care
      </Link>
      <PageHeader title="My home-care visits" description="Times in IST." action={<LiveRefresh names={["care_booking.", "appointment.changed"]} />} />
      {!visits.length ? <Alert tone="info">No home-care visits yet. <Link href="/health/care" className="font-bold underline">Find a provider</Link>.</Alert> : null}
      <ul className="flex flex-col gap-2" data-testid="care-visit-list">
        {visits.map((v) => (
          <li key={v.visitId}>
            <Link href={`/health/care/visits/${v.visitId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 hover:border-kesari-400">
              <span>
                <span className="block font-extrabold text-ink-900">{v.serviceName}</span>
                <span className="block text-sm text-ink-700">
                  {formatSlot(v.startsAt)} · {v.patientName} · {v.providerName ?? v.shopName}
                  {v.sessionNo ? ` · session ${v.sessionNo}` : ""}
                </span>
              </span>
              <span className="rounded-full border px-2 py-0.5 text-xs font-bold">{v.statusLabel}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
