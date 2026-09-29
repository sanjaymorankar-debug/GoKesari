"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Card, Money, StatusBadge } from "@/components/ui";

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
}

const LIVE_DELIVERY = new Set(["OFFERED", "ACCEPTED", "PICKED_UP"]);
const REASSIGNABLE_DELIVERY = new Set(["OFFERED", "ACCEPTED"]);

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

  async function assign(orderId: string, reassign: boolean) {
    let reason: string | undefined;
    if (reassign) {
      const input = window.prompt("Reason for reassigning this delivery?");
      if (input === null) return;
      reason = input.trim() || undefined;
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
        return;
      }
      router.refresh();
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
              const canReassignDelivery = !!order.deliveryStatus && REASSIGNABLE_DELIVERY.has(order.deliveryStatus);
              const busy = busyId === order.id;
              return (
                <tr key={order.id} className="border-b hover:bg-gray-50">
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
                      </div>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
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
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
