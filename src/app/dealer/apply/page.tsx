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
  const [zone] = zoneId ? await db.select({ id: franchiseZones.zoneId, name: franchiseZones.name }).from(franchiseZones).where(and(eq(franchiseZones.zoneId, zoneId), eq(franchiseZones.isTest, false))) : [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <PageHeader
        title="Become a GoKesari dealer"
        description="Authorised dealers bring shops onto GoKesari with their own team and earn a commission for every shop that goes live. Fill in your details, verify your mobile, upload your documents and submit; our team reviews every application."
      />
      <DealerApplication
        dealer={view as ApplicationDealer | null}
        requirements={requirements as never}
        areas={areas}
        agreementVersion={DEALER_AGREEMENT_VERSION}
        smsAvailable={smsAvailable()}
        workZone={zone ?? null}
      />
      {view?.status === "TERMINATED" ? (
        <p className="mt-4 text-sm text-ink-700">
          Your dealer authorisation has ended. <Link className="underline" href="/support">Contact support</Link> with any questions.
        </p>
      ) : null}
    </div>
  );
}
