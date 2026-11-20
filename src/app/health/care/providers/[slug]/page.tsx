import Link from "next/link";
import { notFound } from "next/navigation";

import { CareProviderBooking } from "@/components/health/care";
import { ComingSoon } from "@/components/health/page-shell";
import { Alert } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { careBookingContext, careProviderPage } from "@/server/health/care";

export const metadata = { title: "Home-care provider" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * A home-care practice for patients: verified providers with qualifications, registration and badges,
 * services and rates, reviews — and booking (a visit or a package of sessions; ?package= books the next
 * session prefilled; ?suggestion= carries a doctor's suggestion; ?patient= preselects the family member).
 */
export default async function CareProviderPageRoute({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ patient?: string; suggestion?: string; package?: string }> }) {
  if (!(await healthEnabled())) return <ComingSoon title="Home care" />;
  const { slug } = await params;
  const sp = await searchParams;
  const page = await careProviderPage(decodeURIComponent(slug)).catch(() => null);
  if (!page) notFound();
  const user = await getCurrentUser();
  const context = user
    ? await careBookingContext(user, { packageId: sp.package && UUID.test(sp.package) ? sp.package : null, suggestionId: sp.suggestion && UUID.test(sp.suggestion) ? sp.suggestion : null })
    : null;
  const patientId = sp.patient && context?.patients.some((p) => p.id === sp.patient) ? sp.patient : null;
  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/health/care" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Home care
      </Link>
      {user && context && !context.patients.length ? (
        <div className="mb-3">
          <Alert tone="info">
            Open <Link href="/health" className="font-bold underline">My Health</Link> once and accept the notice to start your health record, then book here.
          </Alert>
        </div>
      ) : null}
      <CareProviderBooking page={page} context={context} preselect={{ patientId, suggestionId: context?.suggestion?.id ?? null, packageId: context?.package?.id ?? null }} signedIn={Boolean(user)} />
    </div>
  );
}
