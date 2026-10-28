import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { DealerClaimsAdmin } from "@/components/dealer/dealer-claims-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listDisputes } from "@/server/dealers/disputes";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Dealer claims" };
export const dynamic = "force-dynamic";

/** Dealers' attribution claims for staff (docs/dealer-programme). Not there while the programme is off. */
export default async function DealerClaimsPage() {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  const claims = await listDisputes();
  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <Link href="/admin/dealers" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealers
      </Link>
      <PageHeader title="Dealer claims" description="A dealer believes a shop is theirs. Uphold moves the shop to them (logged); reject keeps it where it is. The reason is sent to the dealer." />
      <DealerClaimsAdmin claims={JSON.parse(JSON.stringify(claims))} />
    </div>
  );
}
