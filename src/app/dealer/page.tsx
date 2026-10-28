import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { DealerPortal } from "@/components/dealer/dealer-portal";
import { DealerWork } from "@/components/dealer/dealer-work";
import { Alert, Badge, LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { activeCodeFor, codeQrSvg, shareLinkFor, whatsappShareFor } from "@/server/dealers/codes";
import { originFromHeaders } from "@/server/dealers/http";
import { listDealerShops, listDisputes } from "@/server/dealers/disputes";
import { listLeads } from "@/server/dealers/leads";
import { dealerView, getDealerForUser, listSalespeople } from "@/server/dealers/service";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { listShopCategories } from "@/server/services/shop-categories";
import { listShopTypes } from "@/server/services/shop-types";

export const metadata = { title: "Dealer" };
export const dynamic = "force-dynamic";

/**
 * The dealer's page (docs/dealer-programme): an applicant sees where their
 * application stands; an approved dealer gets their code, QR, share links and
 * employees. Not there at all while the programme is off.
 */
export default async function DealerPage() {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/dealer");
  const dealer = await getDealerForUser(user.id);
  if (!dealer || dealer.status === "DRAFT" || dealer.status === "REJECTED") redirect("/dealer/apply");
  const view = await dealerView(dealer);

  if (dealer.status !== "APPROVED") {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <PageHeader title={dealer.legalName} description="GoKesari dealer" />
        <Alert tone={dealer.status === "PENDING" ? "info" : "warning"} title={view.statusLabel}>
          {dealer.status === "PENDING"
            ? "Your application is with our team. We will tell you when it is decided."
            : dealer.statusReason
              ? `Reason: ${dealer.statusReason}`
              : "Your dealer account is not active."}
        </Alert>
        {dealer.status === "PENDING" ? <LinkButton href="/dealer/apply" variant="secondary">See your application</LinkButton> : null}
      </div>
    );
  }

  const origin = originFromHeaders(await headers());
  const code = await activeCodeFor(dealer.id, null);
  const [employees, shops, leads, claims, shopTypes, categories, feeRule] = await Promise.all([
    listSalespeople(dealer.id),
    listDealerShops(dealer.id),
    listLeads(dealer.id),
    listDisputes({ dealerId: dealer.id }),
    listShopTypes(),
    listShopCategories({ activeOnly: true, withShopCounts: false }).catch(() => []),
    getRule("registrationFeeByTurnover"),
  ]);
  // Dates become ISO strings for the client component.
  const iso = (rows: object[]) => JSON.parse(JSON.stringify(rows));
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <PageHeader title={dealer.legalName} description="Authorised GoKesari dealer" />
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-700">
        <Badge tone="success">Approved</Badge>
        {dealer.agreementStart && dealer.agreementEnd ? <span>Agreement {dealer.agreementStart} to {dealer.agreementEnd}</span> : null}
        <Link className="underline" href="/dealer/apply">Your details</Link>
      </p>
      <DealerPortal
        legalName={dealer.legalName}
        code={code ? { code, shareLink: shareLinkFor(origin, code), whatsapp: whatsappShareFor(origin, code, dealer.legalName), qrSvg: await codeQrSvg(origin, code) } : null}
        employees={employees}
      />
      <DealerWork
        employees={employees}
        shops={iso(shops)}
        leads={iso(leads)}
        claims={iso(claims)}
        shopTypes={shopTypes.filter((t) => t.status === "ACTIVE").map((t) => ({ key: t.key, label: t.label }))}
        categories={categories.map((c) => ({ id: c.id, name: c.name, status: c.status, groupName: c.groupName ?? null }))}
        askTurnover={feeRule.enabled}
      />
    </div>
  );
}
