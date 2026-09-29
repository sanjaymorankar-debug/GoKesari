import Link from "next/link";
import { redirect } from "next/navigation";

import { OpsExceptionActions } from "@/components/ops-exception-actions";
import { Alert, Badge, Card, EmptyState, Money, PageHeader, StatusBadge } from "@/components/ui";
import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import {
  formatElapsed,
  isOpsExceptionCategory,
  listOpsExceptions,
  OPS_EXCEPTION_CATEGORIES,
  OPS_EXCEPTION_CATEGORY_LABELS,
  type OpsExceptionCategory,
  type OpsExceptionRow,
} from "@/server/services/ops-exceptions";

export const metadata = { title: "Operations exceptions" };
export const dynamic = "force-dynamic";

const MINUTE_MS = 60_000;
const AFTER_DELIVERY_CATEGORIES: ReadonlySet<OpsExceptionCategory> = new Set<OpsExceptionCategory>([
  "FAILED_DELIVERY",
  "RETURNED_PENDING",
  "DISPUTED",
]);

function categoryHref(category: OpsExceptionCategory | null): string {
  return category ? `/admin/exceptions?category=${category}` : "/admin/exceptions";
}

function Chip({
  href,
  label,
  critical,
  total,
  active,
}: {
  href: string;
  label: string;
  critical: number;
  total: number;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      title={`${critical} critical of ${total}`}
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
        active ? "border-kesari-400 bg-kesari-50" : "border-cream-200 bg-white hover:bg-cream-100"
      } ${total === 0 && !active ? "text-ink-400" : "text-ink-800"}`}
    >
      <span>{label}</span>
      <span className="tabular-nums text-xs">
        <span className={critical > 0 ? "font-semibold text-red-700" : undefined}>{critical}</span>/{total}
      </span>
    </Link>
  );
}

function PromiseText({ row, formatTime }: { row: OpsExceptionRow; formatTime: (date: Date) => string }) {
  if (row.lateByMinutes != null && row.promisedByAt) {
    return (
      <span className="font-medium text-red-700">
        Late by {formatElapsed(row.lateByMinutes * MINUTE_MS)} (promised {formatTime(row.promisedByAt)})
      </span>
    );
  }
  if (row.dueInMinutes != null && row.promisedByAt) {
    return (
      <span>
        Due in {formatElapsed(row.dueInMinutes * MINUTE_MS)} (by {formatTime(row.promisedByAt)})
      </span>
    );
  }
  if (row.promisedByAt || AFTER_DELIVERY_CATEGORIES.has(row.category)) return null;
  return <span className="text-ink-400">No delivery time promised</span>;
}

function RiderText({ row, now }: { row: OpsExceptionRow; now: number }) {
  if (!row.riderName) return <span className="text-ink-400">No rider</span>;
  return (
    <span>
      {row.riderName} · {row.riderOnline ? "online" : "offline"} ·{" "}
      {row.riderLastLocationAt
        ? `last location ${formatElapsed(now - row.riderLastLocationAt.getTime())} ago`
        : "no location shared"}
    </span>
  );
}

export default async function OpsExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string | string[] }>;
}) {
  const user = await getCurrentUser();
  if (!user || !can(user.role, PERMISSIONS.ORDER_VIEW_ANY)) {
    redirect("/signin");
  }

  const params = await searchParams;
  const category = isOpsExceptionCategory(params.category) ? params.category : null;
  const queue = await listOpsExceptions({ category: category ?? undefined });

  const canUpdateStatus = can(user.role, PERMISSIONS.ORDER_UPDATE_STATUS_ANY);
  const canManageDelivery = can(user.role, PERMISSIONS.DELIVERY_ORDER_MANAGE_ANY);
  const canRefund = can(user.role, PERMISSIONS.ORDER_REFUND);
  const canManageGrievances = can(user.role, PERMISSIONS.GRIEVANCE_MANAGE);
  const canSeeFinanceExceptions =
    can(user.role, PERMISSIONS.FINANCE_EXCEPTIONS_VIEW) || can(user.role, PERMISSIONS.FINANCE_VIEW);

  const timeFormat = new Intl.DateTimeFormat("en-IN", {
    timeZone: getEnv().APP_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  });
  const formatTime = (date: Date) => timeFormat.format(date);
  const now = queue.generatedAt.getTime();
  const { summary, health } = queue;

  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        title="Operations exceptions"
        description={
          <>
            Orders stuck in fulfilment or delivery, most urgent first. Updated {formatTime(queue.generatedAt)}.{" "}
            {canSeeFinanceExceptions ? (
              <>
                Payment, refund and reconciliation problems are on{" "}
                <Link href="/admin/finance/exceptions" className="font-medium text-kesari-700 underline">
                  Financial exceptions
                </Link>
                .
              </>
            ) : (
              "Payment, refund and reconciliation problems are handled on Financial exceptions."
            )}
          </>
        }
      />

      {health.dispatchSweepLooksDown ? (
        <Alert tone="danger" title="Rider dispatch looks stalled">
          {health.staleOfferCount} rider {health.staleOfferCount === 1 ? "offer has" : "offers have"} been open for
          more than {Math.round(health.staleAfterSeconds / 60)} minutes
          {health.oldestStaleOfferAt ? ` (oldest ${formatElapsed(now - health.oldestStaleOfferAt.getTime())})` : ""},
          although offers should expire after {health.offerTtlSeconds} seconds. The delivery-dispatch cron (POST
          /api/cron/delivery-dispatch, every minute) may not be scheduled. Until it runs, unanswered offers are not
          passed to the next rider and orders without a rider are not retried.
        </Alert>
      ) : null}

      <section className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Chip
            href={categoryHref(null)}
            label="All"
            critical={summary.critical}
            total={summary.total}
            active={category === null}
          />
          {OPS_EXCEPTION_CATEGORIES.map((c) => (
            <Chip
              key={c}
              href={categoryHref(c)}
              label={OPS_EXCEPTION_CATEGORY_LABELS[c]}
              critical={summary.byCategory[c].critical}
              total={summary.byCategory[c].total}
              active={category === c}
            />
          ))}
        </div>
        <p className="text-xs text-ink-500">Counts are critical / total. Each order appears under one category only.</p>
      </section>

      {queue.capped ? (
        <Alert tone="warning">
          Showing the {queue.rows.length} most urgent of {queue.matchingRows} orders. Pick a category to narrow the
          list.
        </Alert>
      ) : null}

      {queue.rows.length === 0 ? (
        category ? (
          <EmptyState
            title={`Nothing under "${OPS_EXCEPTION_CATEGORY_LABELS[category]}"`}
            description="No order is in this state right now."
            action={
              <Link href={categoryHref(null)} className="text-sm font-medium text-kesari-700 underline">
                Show all categories
              </Link>
            }
          />
        ) : (
          <EmptyState
            title="No stuck orders"
            description="Every order in fulfilment or delivery is within its time limits, and none is failed, returned or disputed."
          />
        )
      ) : (
        <Card className="divide-y divide-cream-100">
          {queue.rows.map((row) => (
            <div key={row.orderId} className="space-y-2 p-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-ink-900">
                  <span className="font-semibold">#{row.orderNumber}</span>
                  <span className="text-ink-500">
                    {" "}
                    · {row.shopName} · {row.customerName ?? "Customer"}
                  </span>
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={row.severity === "CRITICAL" ? "danger" : "warning"}>
                    {row.severity === "CRITICAL" ? "Critical" : "Warning"}
                  </Badge>
                  <Badge tone="info">{OPS_EXCEPTION_CATEGORY_LABELS[row.category]}</Badge>
                  <StatusBadge status={row.orderStatus} />
                </div>
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-600">
                <span>
                  <span className="font-medium text-ink-800">{formatElapsed(now - row.enteredAt.getTime())}</span>{" "}
                  {row.clockLabel}
                </span>
                <PromiseText row={row} formatTime={formatTime} />
                <RiderText row={row} now={now} />
                <span>
                  <Money paise={row.totalPaise} /> · {row.isCod ? (row.isPaid ? "cash, collected" : "cash on delivery") : "wallet"}
                </span>
              </div>

              <p className="text-ink-700">{row.detail}</p>

              {row.orderStatus === "DISPUTED" ? (
                row.openGrievance ? (
                  <p className="text-xs text-ink-600">
                    Grievance {row.openGrievance.ticketNumber} ({row.openGrievance.status.replace(/_/g, " ").toLowerCase()}):
                    &ldquo;{row.openGrievance.subject}&rdquo;{" "}
                    {canManageGrievances ? (
                      <Link href="/admin" className="font-medium text-kesari-700 underline">
                        Resolve it on the admin dashboard
                      </Link>
                    ) : null}
                  </p>
                ) : (
                  <p className="text-xs text-ink-500">No open grievance is linked to this order.</p>
                )
              ) : null}

              <OpsExceptionActions
                order={{
                  orderId: row.orderId,
                  orderNumber: row.orderNumber,
                  orderStatus: row.orderStatus,
                  category: row.category,
                  deliveryStatus: row.deliveryStatus,
                  isCod: row.isCod,
                  isPaid: row.isPaid,
                  totalPaise: row.totalPaise,
                }}
                canUpdateStatus={canUpdateStatus}
                canManageDelivery={canManageDelivery}
                canRefund={canRefund}
              />
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
