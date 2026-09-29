import { inArray } from "drizzle-orm";
import { redirect } from "next/navigation";

import { Alert, Card, EmptyState, LinkButton, Money, PageHeader, Section, StatusBadge } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { orders } from "@/server/db/schema";
import {
  OFFER_TTL_SECONDS,
  getMyActiveDeliveryDetail,
  listMyDeliveryHistory,
  toRiderView,
} from "@/server/services/delivery-assignment";
import { listPartnerEarnings } from "@/server/services/delivery-earnings";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";

export const metadata = { title: "My Deliveries" };
export const dynamic = "force-dynamic";

const ACTIVE_LABEL: Record<string, string> = {
  OFFERED: "New offer waiting for your answer",
  ACCEPTED: "Accepted — head to the shop for pickup",
  PICKED_UP: "Picked up — on the way to the customer",
};

function formatWhen(date: Date): string {
  return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function formatKm(distanceKm: string | null): string | null {
  return distanceKm ? `${Number(distanceKm).toFixed(1)} km` : null;
}

export default async function GigOrdersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="My Deliveries" />
        <EmptyState
          title="You're not a delivery partner yet"
          description="Apply to deliver with GoKesari. Once you're approved and online, delivery offers are sent to you."
          action={<LinkButton href="/delivery-partner/apply">Become a delivery partner</LinkButton>}
        />
      </div>
    );
  }
  if (!can(user.role, PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN)) redirect("/delivery-partner");

  const [active, history, earnings] = await Promise.all([
    getMyActiveDeliveryDetail(user.id),
    listMyDeliveryHistory(user.id),
    listPartnerEarnings(partner.id),
  ]);

  const past = history.filter((d) => d.id !== active?.id).map(toRiderView);
  const orderIds = past.map((d) => d.orderId);
  const orderRows =
    orderIds.length > 0
      ? await db
          .select({ id: orders.id, orderNumber: orders.orderNumber })
          .from(orders)
          .where(inArray(orders.id, orderIds))
      : [];
  const orderNumberById = new Map(orderRows.map((o) => [o.id, o.orderNumber]));
  const earnedByDelivery = new Map(earnings.map((e) => [e.deliveryOrderId, e.totalPaise]));
  const offerMinutes = Math.round(OFFER_TTL_SECONDS / 60);
  const isApproved = partner.status === "APPROVED";
  const statusText = partner.status.replace(/_/g, " ").toLowerCase();

  return (
    <div className="mx-auto max-w-3xl pb-10">
      <PageHeader
        title="My Deliveries"
        description="Orders are offered to one nearby rider at a time. Accept, pick up and deliver from the rider dashboard."
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/gig/profile" variant="secondary">
              My profile
            </LinkButton>
            <LinkButton href="/delivery-partner">Rider dashboard</LinkButton>
          </div>
        }
      />

      {isApproved ? null : (
        <div className="mb-6">
          <Alert tone="info" title="Not receiving offers">
            Only approved delivery partners are offered deliveries. Your delivery partner status is currently{" "}
            {statusText}.
          </Alert>
        </div>
      )}

      <Section title="Current delivery">
        {active ? (
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-kesari-600">
                {isApproved ? (ACTIVE_LABEL[active.status] ?? active.status) : "Assigned delivery"}
              </p>
              <StatusBadge status={active.status} />
            </div>
            <p className="mt-2 font-semibold text-ink-900">{active.orderNumber}</p>
            <dl className="mt-3 space-y-2 text-sm">
              <div>
                <dt className="font-medium text-ink-700">Pickup</dt>
                <dd className="text-ink-500">
                  {active.shopName} — {active.shopAddress}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink-700">Drop</dt>
                <dd className="text-ink-500">{active.customerAddress ?? "Address on order details"}</dd>
              </div>
              {formatKm(active.distanceKm) ? (
                <div>
                  <dt className="font-medium text-ink-700">Delivery leg</dt>
                  <dd className="text-ink-500">~{formatKm(active.distanceKm)}</dd>
                </div>
              ) : null}
              {active.cashToCollectPaise != null ? (
                <div>
                  <dt className="font-medium text-ink-700">Cash on delivery</dt>
                  <dd className="text-ink-500">
                    Collect <Money paise={active.cashToCollectPaise} />
                  </dd>
                </div>
              ) : null}
            </dl>
            {isApproved ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <LinkButton href="/delivery-partner">
                  {active.status === "OFFERED" ? "Accept or reject" : "Continue delivery"}
                </LinkButton>
                {active.status === "OFFERED" ? (
                  <p className="text-xs text-ink-500">
                    Offers move to the next rider after {offerMinutes} minute{offerMinutes === 1 ? "" : "s"}.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-4 text-sm text-ink-500">
                Delivery actions are unavailable while your account is {statusText}. Please contact support about
                this delivery.
              </p>
            )}
          </Card>
        ) : isApproved ? (
          <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-sm text-ink-500">
              {partner.isOnline
                ? "You're online and waiting for a delivery offer."
                : "You're offline. Go online from the rider dashboard to receive delivery offers."}
            </p>
            {partner.isOnline ? null : <LinkButton href="/delivery-partner">Go online</LinkButton>}
          </Card>
        ) : (
          <Card className="p-5 text-sm text-ink-500">No active delivery.</Card>
        )}
      </Section>

      <Section title="Delivery history">
        {past.length === 0 ? (
          <EmptyState
            title="No deliveries yet"
            description="Deliveries assigned to you are listed here once they're completed, failed or cancelled."
          />
        ) : (
          <Card className="divide-y divide-cream-100">
            {past.map((d) => {
              const orderNumber = orderNumberById.get(d.orderId);
              const earned = earnedByDelivery.get(d.id);
              const reason = d.status === "FAILED" ? d.failureReason : d.cancellationReason;
              const km = formatKm(d.distanceKm);
              return (
                <div key={d.id} className="flex flex-wrap items-start justify-between gap-2 p-4 text-sm">
                  <div>
                    <p className="font-medium text-ink-900">{orderNumber ?? "Order"}</p>
                    <p className="text-xs text-ink-500">
                      {formatWhen(d.deliveredAt ?? d.failedAt ?? d.cancelledAt ?? d.offeredAt)}
                      {km ? ` · ${km}` : ""}
                    </p>
                    {reason ? <p className="mt-1 text-xs text-ink-500">{reason}</p> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={d.status} />
                    {earned != null ? <Money paise={earned} className="font-medium text-ink-900" /> : null}
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </Section>
    </div>
  );
}
