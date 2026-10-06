"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";

import { LiveTrackingMap } from "@/components/live-tracking-map";
import { Button, Card, Money, StatusBadge } from "@/components/ui";
import { isTrackableOrderStatus } from "@/lib/tracking";

export interface MonitoringRow {
  id: string;
  orderNumber: string;
  shopName: string;
  customerName: string | null;
  status: string;
  totalPaise: number;
  createdAt: Date;
  riderName: string | null;
  deliveryStatus: string | null;
  /** GA-005: orders sharing a trip show the same short trip code. */
  tripId?: string | null;
  /** NEW-007: invoice and delivery-photo links. */
  invoiceUrl?: string | null;
  proofPhotoUrl?: string | null;
}

const LIVE_DELIVERY = new Set(["OFFERED", "ACCEPTED", "PICKED_UP"]);
/** Keep in step with the header row below. */
const COLUMN_COUNT = 8;
const REASON_MAX = 500;

// A stale OFFERED row on an order that has moved on would be cancelled and then fail to re-offer.
function isReassignable(status: string, deliveryStatus: string | null): boolean {
  return (status === "READY" && deliveryStatus === "OFFERED") || (status === "ASSIGNED" && deliveryStatus === "ACCEPTED");
}

export function OrderMonitoringTable({
  orders,
  canReassign,
}: {
  orders: MonitoringRow[];
  canReassign: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // GS-042: one order's tracking at a time, so monitoring a long list does not
  // open a poll per row.
  const [trackingId, setTrackingId] = useState<string | null>(null);

  async function assign(orderId: string, reassign: boolean) {
    let reason: string | undefined;
    if (reassign) {
      const input = window.prompt(
        "Reason for reassigning this delivery? The current rider is removed first; if nobody else is free the order goes back to Ready with no rider.",
      );
      if (input === null) return;
      reason = input.trim().slice(0, REASON_MAX) || undefined;
    }
    setBusyId(orderId);
    setError(null);
    try {
      const response = await fetch(`/api/orders/${orderId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reassign ? { reassign: true, reason } : {}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "Action failed.");
        // A failed reassign can already have cancelled the old assignment, so show the order's real state.
        if (reassign) router.refresh();
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
      if (reassign) router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  if (orders.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="text-gray-600">No orders match these filters.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-100 text-left">
              <th className="px-4 py-3 font-semibold">Order</th>
              <th className="px-4 py-3 font-semibold">Placed</th>
              <th className="px-4 py-3 font-semibold">Shop</th>
              <th className="px-4 py-3 font-semibold">Customer</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">Amount</th>
              <th className="px-4 py-3 font-semibold">Rider</th>
              <th className="px-4 py-3 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              const hasLiveDelivery = !!order.deliveryStatus && LIVE_DELIVERY.has(order.deliveryStatus);
              const canAssign = order.status === "READY" && !hasLiveDelivery;
              const canReassignDelivery = isReassignable(order.status, order.deliveryStatus);
              const busy = busyId === order.id;
              const trackable = isTrackableOrderStatus(order.status) && hasLiveDelivery;
              const tracking = trackingId === order.id;
              return (
                <Fragment key={order.id}>
                  <tr className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">#{order.orderNumber}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {new Date(order.createdAt).toLocaleString("en-IN", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{order.shopName}</td>
                    <td className="px-4 py-3 text-gray-700">{order.customerName ?? "—"}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={order.status} />
                    </td>
                    <td className="px-4 py-3 font-medium">
                      <Money paise={order.totalPaise} />
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {order.riderName ? (
                        <div>
                          <p className="font-medium">{order.riderName}</p>
                          <p className="text-xs text-gray-500">{order.deliveryStatus?.replace(/_/g, " ").toLowerCase()}</p>
                          {order.proofPhotoUrl ? (
                            <a href={order.proofPhotoUrl} target="_blank" rel="noreferrer" className="block text-xs text-kesari-700 hover:underline">
                              Photo at delivery
                            </a>
                          ) : null}
                          {order.tripId ? (
                            <p className="text-xs text-kesari-700" data-testid="batched-trip">
                              Batched trip {order.tripId.slice(0, 6).toUpperCase()}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                      {order.invoiceUrl ? (
                        <a href={order.invoiceUrl} className="block text-xs text-kesari-700 hover:underline">
                          Tax invoice
                        </a>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {canReassign && canAssign && (
                        <Button size="sm" disabled={busy} onClick={() => assign(order.id, false)}>
                          {busy ? "Assigning…" : "Assign rider"}
                        </Button>
                      )}
                      {canReassign && canReassignDelivery && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => assign(order.id, true)}
                        >
                          {busy ? "Reassigning…" : "Reassign"}
                        </Button>
                      )}
                      {trackable && (
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-expanded={tracking}
                          onClick={() => setTrackingId(tracking ? null : order.id)}
                        >
                          {tracking ? "Hide tracking" : "Track"}
                        </Button>
                      )}
                    </td>
                  </tr>
                  {trackable && tracking && (
                    <tr className="border-b bg-gray-50">
                      <td colSpan={COLUMN_COUNT} className="px-4 py-3">
                        <LiveTrackingMap orderId={order.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
