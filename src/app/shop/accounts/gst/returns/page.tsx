import { redirect } from "next/navigation";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { GstReturnsPanel } from "@/components/billing/gst-returns-panel";
import { loadAccountsPage } from "@/server/accounts/page";
import { getPortalLink } from "@/server/accounts/gst";
import { listFilings } from "@/server/gsp/returns";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { todayIst } from "@/server/accounts/books";

export const metadata = { title: "GST returns on the portal" };
export const dynamic = "force-dynamic";

/**
 * Billing v2 (docs/billing §9): the shop's returns on the GST portal through
 * the GSP — prepare from the books, save, compare totals, file with EVC — the
 * portal ledgers (with GoKesari's TCS credit) and IMS. Downloads stay as the
 * fallback when the portal connection is off.
 */
export default async function GstReturnsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  if (!(await isFeatureEnabled("billing_v2"))) redirect(`/shop/accounts/gst${shopQuery}`);
  const [filings, link] = await Promise.all([listFilings(shop.id), getPortalLink(shop.id)]);
  const today = todayIst();
  const lastMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="gst" shopQuery={shopQuery} />
      <AccountsHeader title="GST returns on the portal" subtitle={`${shop.name}${shop.gstin ? ` · ${shop.gstin}` : ""} — GoKesari prepares, you check and file with the OTP from the portal.`} />
      <GstReturnsPanel
        shopId={shop.id}
        defaultPeriod={lastMonth}
        composition={shop.gstStatus === "COMPOSITION" || shop.gstRegistrationType === "COMPOSITION"}
        linked={link?.status === "LINKED" && !(link.tokenExpiresAt && link.tokenExpiresAt < new Date())}
        linkExpires={link?.tokenExpiresAt ? link.tokenExpiresAt.toISOString() : null}
        filings={filings.map((f) => ({ id: f.id, returnType: f.returnType, period: f.period, status: f.status, arn: f.arn, error: f.error, ours: f.ourSummary as Record<string, number> | null, portal: f.portalSummary as Record<string, number> | null }))}
      />
    </div>
  );
}
