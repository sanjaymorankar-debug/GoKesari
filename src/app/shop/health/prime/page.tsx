import Link from "next/link";
import { redirect } from "next/navigation";

import { ComingSoon } from "@/components/health/page-shell";
import { PrimeShop } from "@/components/health/prime-shop";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { firmForPage } from "@/server/consult/pages";
import { healthEnabled } from "@/server/health/access";
import { primeShopView } from "@/server/health/prime";

export const metadata = { title: "GoKesari Health Prime" };
export const dynamic = "force-dynamic";

/**
 * GoKesari Health Prime for a clinic, home-care provider or medical equipment store (owner; Health staff
 * with ?shopId=): tier, plans, buy / renew, invoices, virtual number, calls and analytics.
 */
export default async function ShopPrimePage({ searchParams }: { searchParams: Promise<{ shopId?: string; paid?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/health/prime");
  if (!(await healthEnabled())) return <ComingSoon title="GoKesari Health Prime" />;
  const sp = await searchParams;
  const firm = await firmForPage(user, sp.shopId);
  const view = firm ? await primeShopView(firm.shopId, user).catch(() => null) : null;
  if (!firm || !view) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="GoKesari Health Prime" />
        <Alert tone="info">
          Prime is for the owners of doctors&apos; clinics, home-care practices and medical equipment stores on GoKesari. <Link href="/shop/register" className="font-bold underline">Register your practice</Link> first.
        </Alert>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="GoKesari Health Prime" description={`${view.shop.name} · ${view.shop.city}`} />
      {!view.audiences.length ? (
        <div className="mb-3">
          <Alert tone="warning">Prime plans are for doctors&apos; clinics, home-care providers and medical equipment stores. Finish your Health profile first.</Alert>
        </div>
      ) : null}
      {sp.paid ? (
        <div className="mb-3">
          <Alert tone={view.subscriptions.some((s) => s.id === sp.paid && s.invoiceNumber) ? "success" : "info"}>
            {view.subscriptions.some((s) => s.id === sp.paid && s.invoiceNumber) ? "Payment received — your plan is active and the tax invoice is below." : "We are confirming your payment; this page updates when it arrives."}
          </Alert>
        </div>
      ) : null}
      <PrimeShop view={view} />
    </div>
  );
}
