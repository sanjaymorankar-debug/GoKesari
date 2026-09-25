import { notFound, redirect } from "next/navigation";

import { RatingBadge } from "@/components/rating-actions";
import {
  AddRiderForm,
  MemberActions,
  RiderLinkActions,
  SocietySettingsForm,
  SocietyShopToggle,
} from "@/components/society-actions";
import { Alert, Card, EmptyState, PageHeader, Section, StatusBadge } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { shopTypeLabel } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { getSocietyDashboard } from "@/server/services/societies";
import { searchShops } from "@/server/services/shops";

export const metadata = { title: "Society dashboard" };
export const dynamic = "force-dynamic";

/**
 * Society dashboard (NAV Society): profile & rules, residents, authorised
 * riders, recommended shops, and the last 7 days of deliveries to the
 * society. Society ADMIN manages everything; OPERATOR handles residents and
 * sees deliveries. Platform operators/admins can open any society.
 */
export default async function SocietyDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;

  const data = await getSocietyDashboard(id, user).catch((error: unknown) => {
    if (error instanceof AppError) return null;
    throw error;
  });
  if (!data) notFound();
  const { society, myRole, members, riders, partnerShops, recentOrders } = data;
  const isAdmin = myRole === "ADMIN" || myRole === "PLATFORM";
  const nearbyShops = isAdmin ? await searchShops({ pincode: society.pincode, deliveryOnly: true, limit: 30 }) : [];
  const partnerIds = new Set(partnerShops.map((s) => s.shopId));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={society.name}
        description={`${[society.addressLine1, society.area, society.city].filter(Boolean).join(", ")} ${society.pincode} · you are ${myRole.toLowerCase()}`}
      />
      <div className="-mt-4 mb-6">
        <StatusBadge status={society.status} />
        {society.status === "APPLIED" ? (
          <p className="mt-2 text-sm text-ink-500">Waiting for Gokesari to verify the society. Residents can join once it is verified.</p>
        ) : null}
        {society.rejectionReason && society.status !== "VERIFIED" ? (
          <div className="mt-2">
            <Alert tone="warning">{society.rejectionReason}</Alert>
          </div>
        ) : null}
      </div>

      {isAdmin ? (
        <Section title="Rules & instructions">
          <Card className="p-4">
            <SocietySettingsForm
              societyId={society.id}
              initial={{
                deliveryInstructions: society.deliveryInstructions,
                securityNotifyEnabled: society.securityNotifyEnabled,
                exclusiveRiders: society.exclusiveRiders,
                boundaryRadiusMeters: society.boundaryRadiusMeters,
              }}
            />
          </Card>
        </Section>
      ) : null}

      <Section title={`Residents (${members.filter((m) => m.status === "ACTIVE").length})`}>
        {members.length === 0 ? (
          <EmptyState title="No members yet." />
        ) : (
          <Card className="divide-y divide-cream-100" data-testid="society-members">
            {members.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span>
                  {m.name ?? "Resident"}
                  <span className="text-xs text-ink-500">
                    {" "}
                    · {m.role.toLowerCase()}
                    {m.unitLabel ? ` · ${m.unitLabel}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={m.status} />
                  <MemberActions memberId={m.id} status={m.status} role={m.role} canSetRole={isAdmin} />
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Authorised riders">
        <p className="mb-3 text-xs text-ink-500">
          Listed riders are offered your residents&apos; deliveries first; preferred riders ahead of them.
          {society.exclusiveRiders ? " Only listed riders may deliver here." : ""}
        </p>
        {isAdmin ? (
          <div className="mb-3">
            <AddRiderForm societyId={society.id} />
          </div>
        ) : null}
        {riders.length === 0 ? (
          <p className="text-sm text-ink-500">No riders listed — any approved rider nearby can deliver.</p>
        ) : (
          <Card className="divide-y divide-cream-100">
            {riders.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span>
                  {r.name} <span className="text-xs text-ink-500">· {r.vehicleType}</span> {r.preferred ? <StatusBadge status="PREFERRED" /> : null}{" "}
                  <RatingBadge avgX100={r.ratingAvgX100} count={r.ratingCount} />
                </span>
                {isAdmin ? <RiderLinkActions linkId={r.id} status={r.status} preferred={r.preferred} /> : <StatusBadge status={r.status} />}
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Shops for our residents">
        {partnerShops.length === 0 ? (
          <p className="text-sm text-ink-500">No shops listed yet.</p>
        ) : (
          <Card className="mb-3 divide-y divide-cream-100">
            {partnerShops.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span>
                  {s.name} <span className="text-xs text-ink-500">· {shopTypeLabel(s.shopType)}</span>
                </span>
                {isAdmin ? <SocietyShopToggle societyId={society.id} shopId={s.shopId} active label="Add" /> : null}
              </div>
            ))}
          </Card>
        )}
        {isAdmin && nearbyShops.some((s) => !partnerIds.has(s.id)) ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-kesari-700">Add a shop in {society.pincode}</summary>
            <ul className="mt-2 divide-y divide-cream-100">
              {nearbyShops
                .filter((s) => !partnerIds.has(s.id))
                .map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 py-2">
                    <span>{s.name}</span>
                    <SocietyShopToggle societyId={society.id} shopId={s.id} active={false} label="Add" />
                  </li>
                ))}
            </ul>
          </details>
        ) : null}
      </Section>

      <Section title="Deliveries to the society (last 7 days)">
        {recentOrders.length === 0 ? (
          <p className="text-sm text-ink-500">No deliveries yet.</p>
        ) : (
          <Card className="divide-y divide-cream-100" data-testid="society-orders">
            {recentOrders.map((o) => (
              <div key={o.orderNumber} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span>
                  {o.orderNumber}
                  <span className="text-xs text-ink-500">
                    {" "}
                    · {o.shopName}
                    {o.unitLabel ? ` · to ${o.unitLabel}` : ""}
                    {o.riderName ? ` · rider ${o.riderName} (${o.riderVehicle}${o.riderVehicleNumber ? `, ${o.riderVehicleNumber}` : ""})` : ""}
                  </span>
                </span>
                <StatusBadge status={o.status} />
              </div>
            ))}
          </Card>
        )}
      </Section>
    </div>
  );
}
