import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { DealerAdminDetail } from "@/components/dealer/dealer-admin-detail";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { dealerAccountEmail, dealerView, getDealer, listSalespeople } from "@/server/dealers/service";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Dealer" };
export const dynamic = "force-dynamic";

/**
 * One dealer for staff (docs/dealer-programme, GKS-DR-002/003/004): details
 * masked, documents, codes, employees. Admin: review documents, reveal PAN /
 * account (audited), approve / reject / suspend / reactivate / terminate,
 * replace a code. Operator: reads only.
 */
export default async function AdminDealerPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const dealer = await getDealer(id.data).catch(() => null);
  if (!dealer) notFound();
  const [view, email, employees] = await Promise.all([dealerView(dealer), dealerAccountEmail(dealer), listSalespeople(dealer.id)]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <Link href="/admin/dealers" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealers
      </Link>
      <PageHeader title={dealer.legalName} description={`${dealer.contactName}${email ? ` · ${email}` : ""}`} />
      <DealerAdminDetail
        isAdmin={user.role === "ADMIN"}
        dealer={JSON.parse(JSON.stringify(view))}
        employees={JSON.parse(JSON.stringify(employees))}
        today={new Date().toISOString().slice(0, 10)}
      />
    </div>
  );
}
