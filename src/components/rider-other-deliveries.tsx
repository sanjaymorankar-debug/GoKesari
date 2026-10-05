"use client";

/**
 * F3 — when a busy rider is offered a second delivery (busy-rider fallback),
 * it shows here under the main delivery card with its own Accept / Reject.
 * Empty (and not rendered) for a rider holding one delivery, as before.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";

export interface OtherDelivery {
  id: string;
  status: string;
  orderNumber: string;
  shopName: string;
  distanceKm: string | null;
}

export function RiderOtherDeliveries({ deliveries }: { deliveries: OtherDelivery[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (deliveries.length === 0) return null;

  async function act(id: string, action: "accept" | "reject") {
    setBusy(id);
    setError(null);
    const res = await fetch(`/api/delivery-orders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action === "reject" ? { action, reason: "Busy with another delivery" } : { action }),
    });
    setBusy(null);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return setError(body?.error?.message ?? "Action failed.");
    }
    router.refresh();
  }

  return (
    <Card className="mt-4 space-y-3 p-4" data-testid="rider-other-deliveries">
      <p className="font-semibold text-ink-900">Also assigned to you</p>
      {deliveries.map((d) => (
        <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-cream-200 pt-2 text-sm">
          <span>
            <Badge tone={d.status === "OFFERED" ? "warning" : "info"}>{d.status === "OFFERED" ? "New offer" : d.status.toLowerCase().replace("_", " ")}</Badge>{" "}
            <strong>{d.orderNumber}</strong> · {d.shopName}
            {d.distanceKm ? ` · ~${Number(d.distanceKm).toFixed(1)} km` : ""}
          </span>
          {d.status === "OFFERED" ? (
            <span className="flex gap-2">
              <Button size="sm" disabled={busy === d.id} onClick={() => act(d.id, "accept")}>Accept</Button>
              <Button size="sm" variant="secondary" disabled={busy === d.id} onClick={() => act(d.id, "reject")}>Reject</Button>
            </span>
          ) : (
            <span className="text-xs text-ink-500">Finish your current delivery first; this one becomes your main card next.</span>
          )}
        </div>
      ))}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Card>
  );
}
