import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { DealerApplication, type ApplicationDealer } from "@/components/dealer/dealer-application";
import { PageHeader } from "@/components/ui";
import { DEALER_AGREEMENT_VERSION, DEALER_TYPES } from "@/lib/dealers";
import { and, eq } from "drizzle-orm";

import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { franchiseZones } from "@/server/db/schema";
import { smsAvailable } from "@/server/dealers/http";
import { bankCheckAvailable } from "@/server/dealers/online-verify";
import { applicationCustomFields } from "@/server/dealers/custom-fields";
import { shopDetailsForUser } from "@/server/dealers/promotion";
import { chosenScheme, joiningChargeView, offeredSchemes } from "@/server/dealers/scheme-registration";
import { dealerView, documentRequirements, getDealerForUser } from "@/server/dealers/service";
import { getFeatureFlag } from "@/server/services/feature-flags";
import { openAreasFor } from "@/server/services/geo-areas";

export const metadata = { title: "Become a GoKesari dealer" };
export const dynamic = "force-dynamic";

/**
 * Dealer application (docs/dealer-programme, GKS-DR-001/002). Any signed-in
 * user applies for themselves. Not there at all while the programme is off.
 */
export default async function DealerApplyPage({ searchParams }: { searchParams: Promise<{ zone?: string | string[] }> }) {
  const flag = await getFeatureFlag("dealer_programme_enabled");
  if (!flag.enabled) notFound();
  const sp = await searchParams;
  const zoneParam = (Array.isArray(sp.zone) ? sp.zone[0] : sp.zone)?.trim().toUpperCase().slice(0, 30) || null;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=${encodeURIComponent(zoneParam ? `/dealer/apply?zone=${zoneParam}` : "/dealer/apply")}`);
  // Approved or suspended dealers see their details read-only (the form is editable only as a draft).
  const dealer = await getDealerForUser(user.id);

  // States (all of India, or where the programme is open) with their districts, cities and localities.
  const areas = await openAreasFor(flag.districtCodes);
  const requirements = Object.fromEntries(await Promise.all(DEALER_TYPES.map(async (t) => [t, await documentRequirements(t)] as const)));
  const view = dealer ? await dealerView(dealer) : null;
  // Free dealership chosen on Book a franchise zone (22-Nov-2026): the zone he will work in, saved with the application.
  const zoneId = zoneParam ?? dealer?.preferredZoneId ?? null;
  // docs/dealer-platform phase 2: schemes to choose (not for a paid franchise owner, whose zone is his scheme).
  const scheme =
    view?.franchiseZones.length
      ? null
      : {
          schemes: await offeredSchemes(),
          chosenVersionId: dealer ? ((await chosenScheme(dealer))?.versionId ?? null) : null,
          charge: dealer ? await joiningChargeView(dealer) : null,
          questions: dealer ? await applicationCustomFields(dealer) : null,
        };
  // Owner, 28-Nov-2026: a shop owner's details come from his live shop (read-only, "from your shop"), never typed again.
  const fromShop = !dealer || ["DRAFT", "REJECTED"].includes(dealer.status) ? await shopDetailsForUser(user.id) : null;
  const [zone] = zoneId ? await db.select({ id: franchiseZones.zoneId, name: franchiseZones.name }).from(franchiseZones).where(and(eq(franchiseZones.zoneId, zoneId), eq(franchiseZones.isTest, false))) : [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <PageHeader
        title="Become a GoKesari dealer"
        description="Authorised dealers bring shops onto GoKesari and earn commission on every shop that goes live. Choose your scheme, fill in your details, verify your mobile, verify your documents online or upload them, and submit; our team reviews every application."
      />
      <DealerApplication
        dealer={view as ApplicationDealer | null}
        requirements={requirements as never}
        areas={areas}
        agreementVersion={DEALER_AGREEMENT_VERSION}
        smsAvailable={smsAvailable()}
        workZone={view?.franchiseZones.length ? null : (zone ?? null)}
        bankCheckAvailable={bankCheckAvailable()}
        scheme={scheme ? JSON.parse(JSON.stringify(scheme)) : null}
        fromShop={fromShop}
      />
      {view?.status === "TERMINATED" ? (
        <p className="mt-4 text-sm text-ink-700">
          Your dealer authorisation has ended. <Link className="underline" href="/support">Contact support</Link> with any questions.
        </p>
      ) : null}
    </div>
  );
}
