import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PatientVisit } from "@/components/health/care";
import { ComingSoon } from "@/components/health/page-shell";
import { Alert } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { careVisitForPatient } from "@/server/health/care";

export const metadata = { title: "Home-care visit" };
export const dynamic = "force-dynamic";

/** One home-care visit for the patient's family: provider card and ID card, OTP codes, live "on the way", SOS, notes, rating. */
export default async function CareVisitPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ new?: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=/health/care/visits/${id}`);
  if (!(await healthEnabled())) return <ComingSoon title="Home-care visit" />;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  await careVisitForPatient(id, user).catch(() => notFound());
  const sp = await searchParams;
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/health/care/visits" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← My home-care visits
      </Link>
      {sp.new ? (
        <div className="mb-3">
          <Alert tone="success" title="Booked">You will see the provider&apos;s photo and ID card here. Give the check-in code only when they arrive.</Alert>
        </div>
      ) : null}
      <PatientVisit visitId={id} />
    </div>
  );
}
