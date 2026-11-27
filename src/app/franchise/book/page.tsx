import { rupees } from "@/lib/franchise";
import { PageHeader } from "@/components/ui";
import { ZoneBooking } from "@/components/franchise/zone-booking";
import { FRANCHISE_AGREEMENT_TEXT, FRANCHISE_AGREEMENT_VERSION } from "@/lib/franchise";
import { getCurrentUser } from "@/server/authz/guards";
import { KYC_DAYS_AFTER_PAYMENT, offerView, ownerStatusForUser } from "@/server/franchise/booking";
import { franchiseConfig, oneTimeRates } from "@/server/franchise/config";
import { flow4On } from "@/server/flows/wave4";
import { onboardingV2Enabled } from "@/server/onboarding-v2/roles";
import { redirect } from "next/navigation";
import { zoneFacets, zoneViews } from "@/server/franchise/zones";

export const metadata = { title: "Book a franchise zone — Pune, Mumbai (Konkan), Nashik" };
export const dynamic = "force-dynamic";

/**
 * Zone booking (final brief 21-Nov-2026 §5.5; owner 22-Nov-2026): anyone may browse. Selected zones → choose a free
 * dealership (work in the zone, one-time commission) or a paid franchise (own the zone: pay first, KYC within 30
 * days). `?zones=A,B&join=paid` brings the choice back after signing in.
 */
export default async function FranchiseBookPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const user = await getCurrentUser();
  // Onboarding v2: a signed-in visitor books through Become a franchisee (live shop check, plan, no 30-day KYC rule).
  if (user && (await onboardingV2Enabled())) {
    const zonesParam = (Array.isArray(sp.zones) ? sp.zones[0] : sp.zones) ?? "";
    redirect(`/franchise/start${zonesParam ? `?model=paid&zones=${encodeURIComponent(zonesParam)}` : ""}`);
  }
  const [zones, offer, status, { config }] = await Promise.all([zoneViews(), offerView(), user ? ownerStatusForUser(user.id) : Promise.resolve(null), franchiseConfig()]);
  const r = await oneTimeRates(config);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const known = new Set(zones.map((z) => z.zoneId));
  const initialZones = one(sp.zones)
    .split(",")
    .map((z) => z.trim().toUpperCase())
    .filter((z) => known.has(z))
    .slice(0, 20);
  const join = one(sp.join);
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <PageHeader title="Choose your franchise zones" description={`${zones.length} zones in ${[...new Set(zones.map((z) => z.setName))].join(", ")} — work in a zone free as a dealer, or own it as a franchise: launch offer ${offer.promoFeePaise != null ? rupees(offer.promoFeePaise) : ""} + GST a year for the first 25 franchise dealers; each zone also shows its regular rate. At most ${offer.maxOwnersPerZone} franchises a zone.`} />
      <ZoneBooking
        zones={zones}
        facets={zoneFacets(zones)}
        offer={offer}
        signedIn={!!user}
        dealerId={status?.dealer?.id ?? null}
        owner={status ? { missing: status.missing, kycMissing: status.kycMissing, agreementAccepted: status.agreementAccepted, hasDealer: !!status.dealer, hasPan: !!status.dealer?.panHash } : null}
        agreement={{ version: FRANCHISE_AGREEMENT_VERSION, text: FRANCHISE_AGREEMENT_TEXT }}
        rates={{ freeSelfBp: r.dealerSelfBp, freeOverrideBp: r.dealerOverrideBp, freeSecondBp: r.dealerSecondOverrideBp, ownerSelfBp: r.ownerSelfBp, ownerOverrideBp: r.ownerOverrideBp, ownerSecondBp: r.ownerSecondOverrideBp, recurringBp: config.recurringBaseBp }}
        kycDays={KYC_DAYS_AFTER_PAYMENT}
        initialZones={initialZones}
        initialJoin={join === "paid" || join === "free" ? join : null}
        v2Start={!user && (await onboardingV2Enabled())}
        holdLabels={await flow4On("flow_f21")}
      />
    </div>
  );
}
