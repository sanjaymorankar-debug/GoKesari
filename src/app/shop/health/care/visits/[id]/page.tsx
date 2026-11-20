import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ProviderVisit } from "@/components/health/care";
import { ComingSoon } from "@/components/health/page-shell";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";

export const metadata = { title: "Home-care visit" };
export const dynamic = "force-dynamic";

/** The provider's visit screen: accept, on my way (live location), OTP check-in / check-out, notes and vitals. */
export default async function ShopCareVisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=/shop/health/care/visits/${id}`);
  if (!(await healthEnabled())) return <ComingSoon title="Home-care visit" />;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/shop/health/care" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Home-care visits
      </Link>
      <ProviderVisit visitId={id} />
    </div>
  );
}
