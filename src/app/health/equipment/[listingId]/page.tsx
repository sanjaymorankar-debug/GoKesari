import Link from "next/link";
import { notFound } from "next/navigation";

import { RentForm } from "@/components/health/equipment";
import { ComingSoon } from "@/components/health/page-shell";
import { Alert } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { listingDetail, rentalContext } from "@/server/health/rentals";

export const metadata = { title: "Rent equipment" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

/** Rent one item: period, start, quantity, family member, prescription (where needed), address; totals before paying. */
export default async function RentPage({ params, searchParams }: { params: Promise<{ listingId: string }>; searchParams: Promise<{ patient?: string; suggestion?: string }> }) {
  if (!(await healthEnabled())) return <ComingSoon title="Rent equipment" />;
  const { listingId } = await params;
  if (!UUID.test(listingId)) notFound();
  const listing = await listingDetail(listingId).catch(() => null);
  if (!listing) notFound();
  const sp = await searchParams;
  const user = await getCurrentUser();
  const context = user ? await rentalContext(user, sp.suggestion && UUID.test(sp.suggestion) ? sp.suggestion : null) : null;
  const patientId = sp.patient && context?.patients.some((p) => p.id === sp.patient) ? sp.patient : null;
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/health/equipment" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Medical equipment
      </Link>
      {user && context && !context.patients.length ? (
        <div className="mb-3">
          <Alert tone="info">
            Tip: open <Link href="/health" className="font-bold underline">My Health</Link> once to start your health record, so rentals show in your history and prescriptions can be attached.
          </Alert>
        </div>
      ) : null}
      <RentForm listing={listing} context={context} preselectPatientId={patientId} signedIn={Boolean(user)} />
    </div>
  );
}
