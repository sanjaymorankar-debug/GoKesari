import { Badge, Card } from "@/components/ui";
import { formatShortDate } from "@/lib/dates";
import { formatQuantity } from "@/lib/money";
import {
  DELIVERY_SKIP_REASON_LABELS,
  DELIVERY_STATUS_LABELS,
  deliveryStatusTone,
  type DeliverySkipReason,
  type SubscriptionDeliveryStatus,
} from "@/lib/subscription-deliveries";

export interface DeliveryRowView {
  id: string;
  deliveryDate: string;
  status: SubscriptionDeliveryStatus;
  quantityMilli: number | null;
  reason: string | null;
  orderNumber: string | null;
  /** Shop / admin views: whose delivery and what. */
  customerName?: string | null;
  productName?: string;
}

/** SM-004: each delivery of a subscription with its own status. */
export function DeliveryStatusBadge({ status }: { status: SubscriptionDeliveryStatus }) {
  return <Badge tone={deliveryStatusTone(status)}>{DELIVERY_STATUS_LABELS[status]}</Badge>;
}

export function SubscriptionDeliveryList({
  title = "Deliveries",
  description,
  rows,
  unit,
  emptyText = "No deliveries in this period.",
  showCustomer = false,
}: {
  title?: string;
  description?: string;
  rows: DeliveryRowView[];
  unit?: string;
  emptyText?: string;
  showCustomer?: boolean;
}) {
  return (
    <Card className="p-5" data-testid="subscription-deliveries">
      <h2 className="text-base font-semibold text-ink-900">{title}</h2>
      {description ? <p className="mt-1 text-sm text-ink-500">{description}</p> : null}
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">{emptyText}</p>
      ) : (
        <ul className="mt-3 divide-y divide-cream-200 text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium text-ink-900">{formatShortDate(row.deliveryDate)}</span>
                {showCustomer && row.customerName ? <span className="text-ink-600"> · {row.customerName}</span> : null}
                {row.productName ? <span className="text-ink-600"> · {row.productName}</span> : null}
                {row.quantityMilli && unit ? <span className="text-ink-500"> · {formatQuantity(row.quantityMilli, unit)}</span> : null}
                {row.orderNumber ? <span className="block text-xs text-ink-500">Order {row.orderNumber}</span> : null}
                {row.reason && row.reason in DELIVERY_SKIP_REASON_LABELS ? (
                  <span className="block text-xs text-ink-500">{DELIVERY_SKIP_REASON_LABELS[row.reason as DeliverySkipReason]}</span>
                ) : null}
              </span>
              <DeliveryStatusBadge status={row.status} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
