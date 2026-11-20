import { PageHeader } from "@/components/ui";
import { ZoneBooking } from "@/components/franchise/zone-booking";
import { FRANCHISE_AGREEMENT_TEXT, FRANCHISE_AGREEMENT_VERSION } from "@/lib/franchise";
import { getCurrentUser } from "@/server/authz/guards";
import { offerView, ownerStatusForUser } from "@/server/franchise/booking";
import { clusterSummary, listClusters, zoneViews } from "@/server/franchise/zones";

export const metadata = { title: "Book franchise areas — Pune" };
export const dynamic = "force-dynamic";

/** Area booking (brief §4.2): anyone may browse; booking needs a signed-in, verified dealer account. */
export default async function FranchiseBookPage() {
  const user = await getCurrentUser();
  const [zones, clusters, offer, status] = await Promise.all([zoneViews(), listClusters(), offerView(), user ? ownerStatusForUser(user.id) : Promise.resolve(null)]);
  const summary = clusterSummary(zones, clusters);
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <PageHeader title="Choose your Pune areas" description="Maharashtra → Pune Metropolitan Region → 7 clusters → 91 areas. At most 2 franchise owners an area." />
      <ZoneBooking
        zones={zones}
        clusters={summary.clusters}
        offer={offer}
        signedIn={!!user}
        owner={status ? { missing: status.missing, agreementAccepted: status.agreementAccepted, hasDealer: !!status.dealer } : null}
        agreement={{ version: FRANCHISE_AGREEMENT_VERSION, text: FRANCHISE_AGREEMENT_TEXT }}
      />
    </div>
  );
}
