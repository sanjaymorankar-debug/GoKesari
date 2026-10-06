import Link from "next/link";
import { redirect } from "next/navigation";

import {
  Alert,
  Badge,
  Card,
  EmptyState,
  LinkButton,
  Money,
  PageHeader,
} from "@/components/ui";
import { formatDisplayDate } from "@/lib/dates";
import { MILLI_PER_UNIT, lineTotalPaise } from "@/lib/money";
import { subscriptionStatusLabel, subscriptionStatusTone } from "@/lib/subscription-status-view";
import { getCurrentUser } from "@/server/authz/guards";
import {
  getWalletForecast,
  isDeliveringStatus,
  listSubscriptionsForUser,
} from "@/server/services/subscriptions";

export const metadata = { title: "My Subscriptions" };
export const dynamic = "force-dynamic";

export default async function SubscriptionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const [subscriptions, forecast] = await Promise.all([
    listSubscriptionsForUser(user.id),
    getWalletForecast(user.id, 15),
  ]);

  const active = subscriptions.filter((s) => isDeliveringStatus(s.status));

  return (
    <>
      <PageHeader
        title="My Subscriptions"
        description="Recurring deliveries paid from your wallet."
        action={<LinkButton href="/category/DAIRY">Browse products</LinkButton>}
      />

      {!forecast.sufficient && active.length > 0 ? (
        <div className="mb-6">
          <Alert tone="warning" title="Your wallet may be insufficient">
            The next {forecast.horizonDays} days of subscriptions need{" "}
            <Money paise={forecast.upcomingCostPaise} /> but your balance is{" "}
            <Money paise={forecast.walletBalancePaise} />. We recommend adding{" "}
            <Money paise={forecast.recommendedTopUpPaise} />.{" "}
            <Link href="/wallet" className="font-medium underline">
              Add money
            </Link>
          </Alert>
        </div>
      ) : null}

      {subscriptions.length === 0 ? (
        <EmptyState
          title="No subscriptions yet"
          description="Subscribe to milk, curd or bread and it will be delivered automatically each day."
          action={<LinkButton href="/category/DAIRY">Find something to subscribe to</LinkButton>}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {subscriptions.map((s) => {
            const perDelivery = s.currentUnitPricePaise
              ? lineTotalPaise(s.currentUnitPricePaise, s.quantityMilli)
              : 0;

            return (
              <Card key={s.id} className="p-5">
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <Badge tone={subscriptionStatusTone(s.status)}>
                    {subscriptionStatusLabel(s.status, s.renewalReason)}
                  </Badge>
                  <Badge>{s.frequency.toLowerCase()}</Badge>
                </div>

                <h2 className="text-lg font-semibold text-ink-900">
                  {s.productName}
                </h2>
                <p className="text-sm text-ink-500">from {s.shopName}</p>

                <p className="mt-3 text-2xl font-bold text-ink-900">
                  {s.quantityMilli / MILLI_PER_UNIT} {s.unit}
                  <span className="text-sm font-normal text-ink-500">
                    {" "}
                    / delivery
                  </span>
                </p>

                {perDelivery > 0 ? (
                  <p className="mt-1 text-sm text-ink-600">
                    <Money paise={perDelivery} /> per delivery
                  </p>
                ) : null}

                {s.nextDeliveryDate ? (
                  <p className="mt-2 text-sm text-ink-500">
                    Next delivery {formatDisplayDate(s.nextDeliveryDate)}
                  </p>
                ) : s.status === "ACTIVE" ? (
                  <p className="mt-2 text-sm text-ink-500">
                    No upcoming delivery scheduled
                  </p>
                ) : s.status === "DRAFT" ? (
                  <p className="mt-2 text-sm text-ink-500">Draft — activate it to start deliveries</p>
                ) : null}
                {s.status === "RENEWAL_PENDING" ? (
                  <p className="mt-1 text-sm font-medium text-amber-700">
                    {s.renewalReason === "PAYMENT_DUE"
                      ? `Top up your wallet before ${s.renewalDueDate ?? "the next delivery"}`
                      : `Renew before ${s.renewalDueDate ?? s.endDate}`}
                  </p>
                ) : null}

                <Link
                  href={`/subscriptions/${s.id}`}
                  className="mt-4 inline-flex w-full justify-center rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-700"
                >
                  Manage &amp; change quantities
                </Link>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
