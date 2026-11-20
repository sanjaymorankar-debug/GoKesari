import Link from "next/link";
import { redirect } from "next/navigation";

import { CareProfileManager } from "@/components/health/care";
import { ComingSoon } from "@/components/health/page-shell";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { firmForPage } from "@/server/consult/pages";
import { healthEnabled } from "@/server/health/access";

export const metadata = { title: "Home-care provider profile" };
export const dynamic = "force-dynamic";

/** Home-care provider profiles of the practice (kind, gender, care, registration, service area) and their ID cards. */
export default async function ShopCareProfilePage({ searchParams }: { searchParams: Promise<{ shopId?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/health/care/profile");
  if (!(await healthEnabled())) return <ComingSoon title="Home-care provider profile" />;
  const sp = await searchParams;
  const firm = await firmForPage(user, sp.shopId);
  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/shop/health/care" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Home-care visits
      </Link>
      <PageHeader title="Provider profile and ID cards" description={firm ? firm.shopName : undefined} />
      {firm ? (
        <CareProfileManager shopId={firm.shopId} />
      ) : (
        <Alert tone="info">
          Set up your practice in <Link href="/shop/consult/setup" className="font-bold underline">Appointments → Setup</Link> first.
        </Alert>
      )}
    </div>
  );
}
