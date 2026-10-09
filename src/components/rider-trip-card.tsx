/**
 * GA-005 — a batched rider's trip: every pickup, then every drop, in the
 * order to do them, with arrival estimates. The main delivery card above
 * always holds the stop marked "Next"; each order keeps its own status and
 * handover codes.
 */
import { Badge, Card } from "@/components/ui";

export interface TripStopView {
  kind: "PICKUP" | "DROP";
  deliveryOrderId: string;
  orderNumber: string;
  label: string;
  done: boolean;
  current: boolean;
  eta: string | null;
  late: boolean;
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function RiderTripCard({ stops }: { stops: TripStopView[] }) {
  const orders = new Set(stops.map((s) => s.orderNumber)).size;
  return (
    <Card className="mt-4 p-4" data-testid="rider-trip">
      <p className="font-semibold text-ink-900">Your trip — {orders} orders</p>
      <p className="text-xs text-ink-500">Collect every order first, then drop them in this order.</p>
      <ol className="mt-3 space-y-2 text-sm">
        {stops.map((stop, i) => (
          <li
            key={`${stop.kind}-${stop.deliveryOrderId}`}
            className={stop.current ? "rounded-lg bg-kesari-50 p-2" : "p-2"}
            data-testid={`trip-stop-${i}`}
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className={stop.done ? "text-ink-500 line-through" : "font-medium text-ink-900"}>
                {i + 1}. {stop.kind === "PICKUP" ? "Pick up" : "Drop"} {stop.orderNumber}
              </span>
              {stop.current ? <Badge tone="warning">Next</Badge> : null}
              {stop.done ? <Badge tone="success">Done</Badge> : null}
              {stop.late ? <Badge tone="danger">Running late</Badge> : null}
            </span>
            <span className="block text-xs text-ink-500">
              {stop.label}
              {stop.eta && !stop.done ? ` · about ${time(stop.eta)}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
