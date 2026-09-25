import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { DailyQuantityControl } from "@/components/daily-quantity-control";
import { SubscriptionCalendar } from "@/components/subscription-calendar";
import { SubscriptionControls } from "@/components/subscription-controls";
import { Badge, Card, Money, PageHeader } from "@/components/ui";
import { addDays, formatDisplayDate, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { MILLI_PER_UNIT } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import {
  getCalendar,
  getSubscriptionDetail,
  listSubscriptionEvents,
} from "@/server/services/subscriptions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Subscription" };

export default async function SubscriptionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const { id } = await params;
  const subscription = await getSubscriptionDetail(id);
  if (!subscription) notFound();
  const history = await listSubscriptionEvents(id);

  // Ownership: a customer may only view their own subscription. Operators and
  // admins reach subscriptions through the admin area, not this page.
  // Only the owner, or staff who manage subscriptions (was: any non-CUSTOMER role).
  if (subscription.userId !== user.id && !can(user.role, PERMISSIONS.SUBSCRIPTION_MANAGE_ANY)) {
    notFound();
  }

  const today = todayIn(getEnv().APP_TIMEZONE);
  const tomorrow = addDays(today, 1);
  const calendar = await getCalendar(id, 30, today);

  const tomorrowEntry = calendar.find((d) => d.date === tomorrow);
  const upcomingCost = calendar.reduce((n, d) => n + d.estimatedCostPaise, 0);

  return (
    <>
      <PageHeader
        title={subscription.productName}
        description={`${subscription.quantityMilli / MILLI_PER_UNIT} ${subscription.unit} · ${subscription.frequency.toLowerCase()} · from ${subscription.shopName}`}
        action={
          <Link
            href="/subscriptions"
            className="text-sm font-medium text-kesari-600 hover:underline"
          >
            ← All subscriptions
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap gap-2">
        <Badge
          tone={
            subscription.status === "ACTIVE"
              ? "success"
              : subscription.status === "PAYMENT_PENDING"
                ? "danger"
                : "warning"
          }
        >
          {subscription.status.replace(/_/g, " ").toLowerCase()}
        </Badge>
        {subscription.currentUnitPricePaise ? (
          <Badge>
            <Money paise={subscription.currentUnitPricePaise} /> per{" "}
            {subscription.unit}
          </Badge>
        ) : null}
        {subscription.nextDeliveryDate ? (
          <Badge tone="info">
            Next delivery {formatDisplayDate(subscription.nextDeliveryDate)}
          </Badge>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          {tomorrowEntry ? (
            <DailyQuantityControl
              subscriptionId={id}
              date={tomorrow}
              dateLabel="Tomorrow"
              standingQuantityMilli={subscription.quantityMilli}
              currentQuantityMilli={
                tomorrowEntry.quantityMilli || subscription.quantityMilli
              }
              unit={subscription.unit}
              unitPricePaise={subscription.currentUnitPricePaise}
              isSkipped={tomorrowEntry.reason === "SKIPPED"}
              isOverridden={tomorrowEntry.isOverridden}
              locked={
                tomorrowEntry.generatedStatus !== null &&
                tomorrowEntry.generatedStatus !== "WALLET_INSUFFICIENT"
              }
            />
          ) : null}

          <SubscriptionControls
            subscriptionId={id}
            status={subscription.status}
            standingQuantityMilli={subscription.quantityMilli}
            unit={subscription.unit}
            pauseFrom={subscription.pauseFrom}
            pauseUntil={subscription.pauseUntil}
          />

          <Card className="p-5" data-testid="subscription-history">
            <h2 className="text-base font-semibold text-ink-900">History</h2>
            {history.length === 0 ? (
              <p className="mt-1 text-sm text-ink-500">No changes yet.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm text-ink-600">
                {history.map((event) => (
                  <li key={event.id} className="flex justify-between gap-3">
                    <span>
                      {event.action.toLowerCase().replace(/_/g, " ")}
                      {event.note ? <span className="text-xs text-ink-500"> · {event.note}</span> : null}
                    </span>
                    <span className="text-xs text-ink-400">
                      {new Date(event.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-base font-semibold text-ink-900">
              Next 30 days
            </h2>
            <p className="mt-1 text-sm text-ink-500">
              Estimated cost, based on today&apos;s price.
            </p>
            <p className="mt-2 text-2xl font-bold text-ink-900">
              <Money paise={upcomingCost} />
            </p>
            <p className="mt-2 text-xs text-ink-500">
              Actual deductions may vary if the product price changes.
            </p>
          </Card>
        </div>

        <SubscriptionCalendar
          subscriptionId={id}
          days={calendar}
          unit={subscription.unit}
          standingQuantityMilli={subscription.quantityMilli}
          unitPricePaise={subscription.currentUnitPricePaise}
        />
      </div>
    </>
  );
}
