import { redirect } from "next/navigation";

import { LiveClock } from "@/components/live-clock";
import { SafeImage } from "@/components/safe-image";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { vehicleTypeLabel } from "@/lib/vehicle-types";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getMyRiderIdCard } from "@/server/services/rider-files";

export const metadata = { title: "Rider ID card" };
export const dynamic = "force-dynamic";

/**
 * C5: the rider's digital ID card to show at a society gate — photo, name,
 * rider ID and the verified societies that list the rider, built fresh from
 * the server on every visit (the live clock shows it is not a screenshot).
 */
export default async function RiderIdCardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN)) redirect("/delivery-partner");

  const card = await getMyRiderIdCard(user.id);
  if (!card) {
    return (
      <div className="mx-auto max-w-md">
        <PageHeader title="Rider ID card" />
        <EmptyState
          title="Your ID card is not available"
          description="The ID card is issued to approved delivery partners."
          action={<LinkButton href="/gig/profile">My delivery profile</LinkButton>}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md pb-10">
      <PageHeader title="Rider ID card" description="Show this at the society gate." />
      <Card className="overflow-hidden" data-testid="rider-id-card">
        <div className="bg-kesari-600 px-5 py-3 text-white">
          <p className="text-xs uppercase tracking-wide">GoKesari delivery partner</p>
          <p className="text-lg font-semibold">Verified rider</p>
        </div>
        <div className="flex gap-4 p-5">
          <SafeImage
            src={card.photoUrl}
            alt={`Photo of ${card.fullName}`}
            className="h-28 w-24 flex-none rounded-lg border border-cream-200 object-cover"
          />
          <dl className="space-y-1 text-sm">
            <div>
              <dt className="text-xs text-ink-500">Name</dt>
              <dd className="font-semibold text-ink-900" data-testid="rider-id-name">{card.fullName}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">Rider ID</dt>
              <dd className="font-mono font-semibold text-ink-900" data-testid="rider-id-code">{card.riderId}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">Vehicle</dt>
              <dd className="text-ink-700">
                {vehicleTypeLabel(card.vehicleType)}
                {card.vehicleRegistrationNumber ? ` · ${card.vehicleRegistrationNumber}` : ""}
              </dd>
            </div>
          </dl>
        </div>
        {!card.photoUrl ? (
          <p className="px-5 pb-3 text-xs text-amber-700">Add your photo on your delivery profile so the gate can check it.</p>
        ) : null}
        <div className="border-t border-cream-100 px-5 py-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">Approved for societies</p>
          {card.societies.length === 0 ? (
            <p className="text-sm text-ink-500" data-testid="rider-id-no-societies">No society has added you to its rider list yet.</p>
          ) : (
            <ul className="space-y-1 text-sm" data-testid="rider-id-societies">
              {card.societies.map((s) => (
                <li key={`${s.name}-${s.city}`}>
                  <span className="font-medium text-ink-900">{s.name}</span>
                  <span className="text-ink-500">{` — ${[s.area, s.city].filter(Boolean).join(", ")}`}</span>
                  {s.preferred ? <span className="ml-1 text-xs text-leaf-700">(preferred)</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-cream-100 bg-cream-50 px-5 py-3 text-xs text-ink-500">
          Status checked {card.issuedAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}.
          Now: <LiveClock />
        </div>
      </Card>
    </div>
  );
}
