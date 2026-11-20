import Link from "next/link";
import { redirect } from "next/navigation";

import { CareInbox } from "@/components/health/care";
import { ComingSoon } from "@/components/health/page-shell";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { firmForPage } from "@/server/consult/pages";
import { healthEnabled } from "@/server/health/access";

export const metadata = { title: "Home-care visits" };
export const dynamic = "force-dynamic";

/** The home-care provider's / agency's visit inbox and schedule (live), staff assignment and earnings. */
export default async function ShopCarePage({ searchParams }: { searchParams: Promise<{ shopId?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/health/care");
  if (!(await healthEnabled())) return <ComingSoon title="Home-care visits" />;
  const sp = await searchParams;
  const firm = await firmForPage(user, sp.shopId);
  if (!firm) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Home-care visits" />
        <Alert tone="info">
          Home-care providers and agencies take bookings through Appointments. <Link href="/shop/consult/setup" className="font-bold underline">Set up your practice</Link> with a home-care category, then come back here.
        </Alert>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Home-care visits"
        description={`${firm.shopName} · times in IST`}
        action={
          <Link href={`/shop/health/care/profile?shopId=${firm.shopId}`} className="inline-flex min-h-11 items-center rounded-lg bg-kesari-600 px-4 text-sm font-bold text-white" data-testid="care-profile-link">
            Provider profile and ID cards
          </Link>
        }
      />
      <CareInbox shopId={firm.shopId} />
    </div>
  );
}
