import { PageHeader } from "@/components/ui";
import { ZoneBooking } from "@/components/franchise/zone-booking";
import { FRANCHISE_AGREEMENT_TEXT, FRANCHISE_AGREEMENT_VERSION } from "@/lib/franchise";
import { getCurrentUser } from "@/server/authz/guards";
import { offerView, ownerStatusForUser } from "@/server/franchise/booking";
import { zoneFacets, zoneViews } from "@/server/franchise/zones";

export const metadata = { title: "Book a franchise zone — Pune" };
export const dynamic = "force-dynamic";

/** Zone booking (final brief 21-Nov-2026 §5.5): anyone may browse; booking needs a signed-in, verified dealer account. */
export default async function FranchiseBookPage() {
  const user = await getCurrentUser();
  const [zones, offer, status] = await Promise.all([zoneViews(), offerView(), user ? ownerStatusForUser(user.id) : Promise.resolve(null)]);
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <PageHeader title="Choose your Pune zones" description={`${zones.length} zones in Premier, Standard and Emerging tiers, each with its own annual fee. At most ${offer.maxOwnersPerZone} franchises a zone.`} />
      <ZoneBooking
        zones={zones}
        facets={zoneFacets(zones)}
        offer={offer}
        signedIn={!!user}
        dealerId={status?.dealer?.id ?? null}
        owner={status ? { missing: status.missing, agreementAccepted: status.agreementAccepted, hasDealer: !!status.dealer } : null}
        agreement={{ version: FRANCHISE_AGREEMENT_VERSION, text: FRANCHISE_AGREEMENT_TEXT }}
      />
    </div>
  );
}
