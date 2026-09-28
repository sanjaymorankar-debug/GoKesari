import { redirect } from "next/navigation";

import { DeliveryPartnerDashboard } from "@/components/delivery-partner-dashboard";
import { Alert, Card, Money, PageHeader, StatusBadge } from "@/components/ui";
import { vehicleTypeLabel } from "@/lib/vehicle-types";
import { getCurrentUser } from "@/server/authz/guards";
import { getMyActiveDeliveryDetail } from "@/server/services/delivery-assignment";
import { getRiderEarningsView, listAdjustments, listRiderPayouts } from "@/server/services/finance";
import { getPartnerEarningsSummary } from "@/server/services/delivery-earnings";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";

export const metadata = { title: "My Delivery Partner Application" };
export const dynamic = "force-dynamic";

const STATUS_MESSAGE: Record<string, string> = {
  REGISTERED: "Your application has been received and is waiting to be reviewed.",
  UNDER_REVIEW: "Our team is reviewing your application.",
  APPROVED: "You're approved as a delivery partner.",
  REJECTED: "Your application was not approved.",
  SUSPENDED: "Your delivery partner account is currently suspended.",
  DEACTIVATED: "Your delivery partner account has been deactivated.",
};

/**
 * Self-service status page — a minimal complement to registration (Slice B).
 * The fuller dashboard (deliveries, earnings, online toggle) is Slice C,
 * once there's an assignment/earnings system for it to show.
 */
export default async function DeliveryPartnerStatusPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) redirect("/delivery-partner/apply");

  const [activeDelivery, earnings] =
    partner.status === "APPROVED"
      ? await Promise.all([getMyActiveDeliveryDetail(user.id), getPartnerEarningsSummary(partner.id)])
      : [null, { todayPaise: 0, totalPaise: 0, deliveryCount: 0 }];
  // Weekly payouts (GS-064) — what has been batched and paid to the rider's bank.
  const [payouts, earningsView, adjustments] =
    partner.status === "APPROVED"
      ? await Promise.all([
          listRiderPayouts({ deliveryPartnerId: partner.id, limit: 12 }),
          getRiderEarningsView(partner.id, 30),
          listAdjustments({ deliveryPartnerId: partner.id, limit: 20 }),
        ])
      : [[], null, []];

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="My Delivery Partner Application" />

      <Card className="mb-6 p-6">
        <div className="mb-3 flex items-center gap-2">
          <StatusBadge status={partner.status} />
        </div>
        <p className="text-sm text-ink-700">{STATUS_MESSAGE[partner.status]}</p>

        {partner.status === "REJECTED" && partner.rejectionReason ? (
          <div className="mt-3">
            <Alert tone="danger" title="Reason">
              {partner.rejectionReason}
            </Alert>
          </div>
        ) : null}
        {partner.status === "SUSPENDED" && partner.rejectionReason ? (
          <div className="mt-3">
            <Alert tone="warning" title="Reason">
              {partner.rejectionReason}
            </Alert>
          </div>
        ) : null}
        {partner.reviewNotes ? (
          <div className="mt-3">
            <Alert tone="info" title="Note from our team">
              {partner.reviewNotes}
            </Alert>
          </div>
        ) : null}
      </Card>

      <Card className="p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">
          Application details
        </h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium text-ink-700">Full name</dt>
            <dd className="text-ink-500">{partner.fullName}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink-700">Mobile</dt>
            <dd className="text-ink-500">{partner.mobile}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink-700">Vehicle</dt>
            <dd className="text-ink-500">{vehicleTypeLabel(partner.vehicleType)}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink-700">Operating radius</dt>
            <dd className="text-ink-500">{partner.operatingRadiusKm} km</dd>
          </div>
        </dl>
      </Card>

      {partner.status === "APPROVED" ? (
        <div className="mt-4">
          <DeliveryPartnerDashboard
            isOnline={partner.isOnline}
            activeDelivery={activeDelivery}
            earnings={earnings}
          />
          {earningsView ? (
            <Card className="mt-4 p-5" data-testid="rider-earnings">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-500">Earnings</h2>
              <p className="mb-3 text-sm text-ink-600">
                Not yet paid out: <Money paise={earningsView.pendingEarningsPaise + earningsView.pendingAdjustmentsPaise} />
                {earningsView.pendingAdjustmentsPaise !== 0 ? (
                  <span className="text-xs text-ink-500">
                    {" "}
                    (incl. adjustments <Money paise={earningsView.pendingAdjustmentsPaise} />)
                  </span>
                ) : null}
              </p>
              {earningsView.earnings.length === 0 ? (
                <p className="text-sm text-ink-500">No earnings yet.</p>
              ) : (
                <ul className="divide-y divide-cream-100 text-sm">
                  {earningsView.earnings.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        {e.orderNumber}
                        <span className="text-xs text-ink-500"> · delivery {e.deliveryStatus.toLowerCase()}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <StatusBadge status={e.status} />
                        <Money paise={e.totalPaise} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {adjustments.length > 0 ? (
                <>
                  <p className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Adjustments</p>
                  <ul className="divide-y divide-cream-100 text-sm">
                    {adjustments.map(({ adjustment: a, orderNumber }) => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span>
                          {a.reason}
                          {orderNumber ? <span className="text-xs text-ink-500"> · {orderNumber}</span> : null}
                        </span>
                        <span className="flex items-center gap-2">
                          <StatusBadge status={a.status} />
                          <Money paise={a.amountPaise} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </Card>
          ) : null}
          <Card className="mt-4 p-5" data-testid="rider-payouts">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Payouts</h2>
            {payouts.length === 0 ? (
              <p className="text-sm text-ink-500">Earnings are paid out weekly — nothing batched yet.</p>
            ) : (
              <ul className="divide-y divide-cream-100 text-sm">
                {payouts.map(({ payout }) => (
                  <li key={payout.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      Week from {payout.periodStart} · {payout.earningsCount} deliveries
                      {payout.paymentReference ? ` · ref ${payout.paymentReference}` : ""}
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={payout.status} />
                      <Money paise={payout.amountPaise} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
