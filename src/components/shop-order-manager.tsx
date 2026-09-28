"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Money, StatusBadge } from "@/components/ui";
import { formatQuantity } from "@/lib/money";

/**
 * Manual status steps that stay available for shops delivering themselves or
 * handing over in store (READY/OUT_FOR_DELIVERY/FAILED). Accept → pick →
 * pack → ready now goes through the fulfilment actions below.
 */
const MANUAL_STEPS: Record<string, { to: string; label: string }[]> = {
  READY: [
    { to: "OUT_FOR_DELIVERY", label: "Out for delivery (own delivery)" },
    { to: "DELIVERED", label: "Handed to customer" },
  ],
  OUT_FOR_DELIVERY: [{ to: "DELIVERED", label: "Mark delivered" }],
  FAILED: [
    { to: "RETURNED", label: "Mark returned to shop" },
    { to: "OUT_FOR_DELIVERY", label: "Retry delivery" },
  ],
};

const DELIVERY_STATUS_LABEL: Record<string, string> = {
  OFFERED: "Offer sent to rider",
  ACCEPTED: "Rider on the way to you",
  PICKED_UP: "Picked up by rider",
  DELIVERED: "Delivered by rider",
  REJECTED: "Looking for another rider",
  CANCELLED: "Assignment cancelled",
  FAILED: "Delivery failed",
};

const ITEM_STATUS_LABEL: Record<string, string> = {
  PICKED: "picked",
  SUBSTITUTION_PROPOSED: "waiting for customer",
  SUBSTITUTED: "substituted",
  REMOVED: "removed · refunded",
};

export interface ShopOrderItem {
  id: string;
  productNameSnapshot: string;
  unitSnapshot: string;
  quantityMilli: number;
  lineTotalPaise: number;
  fulfilmentStatus: string;
  substituteNameSnapshot: string | null;
  substituteUnitSnapshot: string | null;
  substituteQuantityMilli: number | null;
  substituteLineTotalPaise: number | null;
}

export interface ShopOrderRow {
  id: string;
  orderNumber: string;
  status: string;
  totalPaise: number;
  createdAt: string;
  items: ShopOrderItem[];
  deliveryStatus: string | null;
  /** Read this to the rider at handover (only while a rider is assigned). */
  pickupCode: string | null;
  orderType?: string;
}

export interface SubstituteOption {
  shopProductId: string;
  label: string;
}

/** Shop-owner order queue: accept → pick → pack → ready → rider handover (Slices 3–4). */
export function ShopOrderManager({
  orders,
  deliveryAvailable,
  substitutes = [],
}: {
  orders: ShopOrderRow[];
  deliveryAvailable: boolean;
  /** This shop's online-buyable products, for proposing a substitute. */
  substitutes?: SubstituteOption[];
}) {
  const router = useRouter();

  return (
    <div className="space-y-3">
      {orders.map((order) => (
        <OrderRow
          key={order.id}
          order={order}
          deliveryAvailable={deliveryAvailable}
          substitutes={substitutes}
          onChanged={() => router.refresh()}
        />
      ))}
    </div>
  );
}

function OrderRow({
  order,
  deliveryAvailable,
  substitutes,
  onChanged,
}: {
  order: ShopOrderRow;
  deliveryAvailable: boolean;
  substitutes: SubstituteOption[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  async function call(url: string, method: string, body: unknown, fallback: string) {
    setBusy(true);
    setError(null);
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? fallback);
      return false;
    }
    onChanged();
    return true;
  }

  const fulfil = (body: Record<string, unknown>) =>
    call(`/api/orders/${order.id}/fulfilment`, "POST", body, "Could not update the order.");
  const advance = (to: string) =>
    call(`/api/orders/${order.id}/status`, "PATCH", { status: to }, "Could not update status.");
  const findRider = () =>
    call(`/api/orders/${order.id}/assign`, "POST", {}, "No delivery partner is available right now.");

  const working = order.status === "ACCEPTED" || order.status === "PREPARING";
  const waitingOnCustomer = order.items.some((i) => i.fulfilmentStatus === "SUBSTITUTION_PROPOSED");
  // A rider is actively on this order (a declined/expired/cancelled offer
  // does not count — the shop can retry or deliver itself).
  const riderActive = ["OFFERED", "ACCEPTED", "PICKED_UP"].includes(order.deliveryStatus ?? "");

  return (
    <Card className="p-4" data-testid="shop-order">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={order.status} />
          {order.orderType === "B2B" ? <Badge tone="info">business order</Badge> : null}
          {order.deliveryStatus ? (
            <Badge tone="info">{DELIVERY_STATUS_LABEL[order.deliveryStatus] ?? order.deliveryStatus}</Badge>
          ) : null}
          <span className="text-sm text-ink-500">{order.orderNumber}</span>
        </div>
        <span className="font-semibold text-ink-900">
          <Money paise={order.totalPaise} />
        </span>
      </div>

      {order.pickupCode && order.status === "ASSIGNED" ? (
        <p className="mt-2 rounded-lg bg-kesari-50 px-3 py-2 text-sm text-kesari-800" data-testid="pickup-code">
          Pickup code for the rider: <span className="font-mono text-lg font-bold tracking-widest">{order.pickupCode}</span>
        </p>
      ) : null}

      <ul className="mt-2 divide-y divide-cream-100 text-sm text-ink-600">
        {order.items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            editable={working && !busy}
            substitutes={substitutes}
            onPick={() => fulfil({ action: "pick", itemId: item.id })}
            onRemove={() => fulfil({ action: "remove", itemId: item.id, reason: "Out of stock" })}
            onSubstitute={(substituteShopProductId) =>
              fulfil({ action: "substitute", itemId: item.id, substituteShopProductId })
            }
          />
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap gap-2">
        {order.status === "CONFIRMED" ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => fulfil({ action: "accept" })}>
              Accept order
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRejecting((v) => !v)}>
              Reject
            </Button>
          </>
        ) : null}
        {order.status === "ACCEPTED" ? (
          <Button size="sm" disabled={busy} onClick={() => fulfil({ action: "start" })}>
            Start picking
          </Button>
        ) : null}
        {order.status === "PREPARING" ? (
          <Button size="sm" disabled={busy || waitingOnCustomer} onClick={() => fulfil({ action: "ready" })}>
            Packed — mark ready
          </Button>
        ) : null}
        {order.status === "READY" && deliveryAvailable && !riderActive ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={findRider}>
            Find rider now
          </Button>
        ) : null}
        {(MANUAL_STEPS[order.status] ?? [])
          .filter(() => !(order.status === "READY" && riderActive))
          .map((step) => (
            <Button key={step.to} size="sm" variant="secondary" disabled={busy} onClick={() => advance(step.to)}>
              {step.label}
            </Button>
          ))}
        {order.status === "RETURNED" ? (
          <Button size="sm" variant="danger" disabled={busy} onClick={() => advance("CANCELLED")}>
            Cancel &amp; refund customer
          </Button>
        ) : null}
      </div>

      {waitingOnCustomer ? (
        <p className="mt-2 text-xs text-ink-500">Waiting for the customer to approve or reject a substitute.</p>
      ) : null}

      {rejecting ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-sm"
            placeholder="Reason, shown to the customer"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            aria-label="Reason for rejecting the order"
          />
          <Button
            size="sm"
            variant="danger"
            disabled={busy || rejectReason.trim().length < 3}
            onClick={() => fulfil({ action: "reject", reason: rejectReason })}
          >
            Reject &amp; refund
          </Button>
        </div>
      ) : null}

      {error ? (
        <div className="mt-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}

function ItemRow({
  item,
  editable,
  substitutes,
  onPick,
  onRemove,
  onSubstitute,
}: {
  item: ShopOrderItem;
  editable: boolean;
  substitutes: SubstituteOption[];
  onPick: () => void;
  onRemove: () => void;
  onSubstitute: (substituteShopProductId: string) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [choice, setChoice] = useState("");
  const open = item.fulfilmentStatus === "PENDING" || item.fulfilmentStatus === "PICKED";

  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={item.fulfilmentStatus === "REMOVED" ? "line-through" : undefined}>
          {item.productNameSnapshot} · {formatQuantity(item.quantityMilli, item.unitSnapshot)}
          {ITEM_STATUS_LABEL[item.fulfilmentStatus] ? (
            <span className="ml-2 text-xs text-ink-400">({ITEM_STATUS_LABEL[item.fulfilmentStatus]})</span>
          ) : null}
        </span>
        <Money paise={item.lineTotalPaise} />
      </div>
      {item.substituteNameSnapshot && item.fulfilmentStatus !== "REMOVED" ? (
        <p className="text-xs text-ink-500">
          Substitute: {item.substituteNameSnapshot}
          {item.substituteQuantityMilli && item.substituteUnitSnapshot
            ? ` · ${formatQuantity(item.substituteQuantityMilli, item.substituteUnitSnapshot)}`
            : ""}
          {item.substituteLineTotalPaise != null ? (
            <>
              {" "}
              · <Money paise={item.substituteLineTotalPaise} />
            </>
          ) : null}
        </p>
      ) : null}

      {editable && open ? (
        <div className="mt-1 flex flex-wrap gap-2">
          {item.fulfilmentStatus === "PENDING" ? (
            <Button size="sm" variant="ghost" onClick={onPick}>
              Picked ✓
            </Button>
          ) : null}
          {substitutes.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setChoosing((v) => !v)}>
              Offer substitute
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onRemove}>
            Unavailable — remove &amp; refund
          </Button>
        </div>
      ) : null}

      {choosing ? (
        <div className="mt-1 flex flex-wrap gap-2">
          <select
            className="min-w-0 flex-1 rounded-lg border border-cream-200 px-2 py-1.5 text-sm"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            aria-label="Substitute product"
          >
            <option value="">Choose a substitute…</option>
            {substitutes.map((s) => (
              <option key={s.shopProductId} value={s.shopProductId}>
                {s.label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={!choice}
            onClick={() => {
              onSubstitute(choice);
              setChoosing(false);
            }}
          >
            Send to customer
          </Button>
        </div>
      ) : null}
    </li>
  );
}
