/**
 * docs/flows-v3/wave2.md: on the shop's Orders page — customers asking to cancel a packed order (flag flow_f16) and
 * pickups not collected after their slot and grace (flag flow_f19). Renders nothing while both are off or empty.
 */
import { Card } from "@/components/ui";
import { listPendingCancelRequestsForShop } from "@/server/flows/f16-cancellations";
import { listUncollectedPickupsForShop } from "@/server/flows/f19-timeouts";
import { FlowAction } from "./flow-action";

export async function ShopOrderRequests({ shopId }: { shopId: string }) {
  const [requests, pickups] = await Promise.all([listPendingCancelRequestsForShop(shopId), listUncollectedPickupsForShop(shopId)]);
  if (requests.length === 0 && pickups.length === 0) return null;
  return (
    <Card className="mb-4 space-y-3 p-4" data-testid="flows-v3-shop-requests">
      {requests.map((r) => (
        <div key={r.requestId} className="border-b border-cream-100 pb-3 last:border-0">
          <p className="text-sm font-medium text-ink-900">Order {r.orderNumber}: the customer asks you to cancel it</p>
          {r.reason ? <p className="text-sm text-ink-600">“{r.reason}”</p> : null}
          <p className="text-xs text-ink-500">If you agree, the order is cancelled and the customer refunded in full. No charge.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <FlowAction url={`/api/orders/${r.orderId}/cancel-request/decision`} body={{ accept: true }} label="Agree and cancel" variant="primary" />
            <FlowAction url={`/api/orders/${r.orderId}/cancel-request/decision`} body={{ accept: false }} label="Decline" noteLabel="Tell the customer why (optional)" />
          </div>
        </div>
      ))}
      {pickups.map((p) => (
        <div key={p.orderId} className="border-b border-cream-100 pb-3 last:border-0">
          <p className="text-sm font-medium text-ink-900">Order {p.orderNumber}: not collected</p>
          <p className="text-xs text-ink-500">
            Its pickup time ended {p.slotEnd.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}. You may cancel it; the
            customer is refunded.
          </p>
          <div className="mt-2">
            <FlowAction
              url={`/api/orders/${p.orderId}/pickup-not-collected`}
              label="Cancel — not collected"
              variant="danger"
              confirmText="Cancel this order as not collected? The customer is refunded."
            />
          </div>
        </div>
      ))}
    </Card>
  );
}
