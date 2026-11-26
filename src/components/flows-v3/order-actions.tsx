/**
 * docs/flows-v3/wave2.md: the customer's wave-2 actions on their order page. Each part renders only while its flag
 * is on and it applies:
 *   F16 (flow_f16)  a packed order: ask the shop to cancel it, or the request's state;
 *   F20 (flow_f20)  this part was cancelled by the shop: cancel the other parts of the checkout;
 *   F2  (flow_f2)   the first order is paid and no referral code was given: give one (optional).
 */
import { Alert } from "@/components/ui";
import { CANCEL_REQUEST_STATUSES, getLatestCancelRequest } from "@/server/flows/f16-cancellations";
import { referralAfterFirstOrderIds } from "@/server/flows/f2-order";
import { groupRestState } from "@/server/flows/f20-multishop";
import { flowOn } from "@/server/flows/wave2-rules";
import type { OrderStatus } from "@/server/db/schema";
import { FlowAction } from "./flow-action";

export async function FlowsV3OrderActions({ order, userId }: { order: { id: string; status: OrderStatus; source: string }; userId: string }) {
  const [f16, rest, referralIds] = await Promise.all([flowOn("flow_f16"), groupRestState(order.id, userId), referralAfterFirstOrderIds(userId)]);
  const request = f16 ? await getLatestCancelRequest(order.id) : null;
  const packed = f16 && order.source !== "SUBSCRIPTION" && CANCEL_REQUEST_STATUSES.includes(order.status);
  const referral = referralIds.includes(order.id);
  if (!packed && !rest.offer && !referral && request?.status !== "DECLINED") return null;

  return (
    <div className="mt-3 space-y-3 border-t border-cream-100 pt-3" data-testid="flows-v3-order-actions">
      {packed && request?.status === "PENDING" ? (
        <div className="space-y-2">
          <Alert tone="info" title="Cancellation asked">
            You asked the shop to cancel this packed order. If it agrees, you are refunded in full.
          </Alert>
          <FlowAction url={`/api/orders/${order.id}/cancel-request`} method="DELETE" label="Withdraw the request" />
        </div>
      ) : packed && request?.status !== "DECLINED" ? (
        <div className="space-y-1">
          <p className="text-sm text-ink-600">This order is packed. You can ask the shop to cancel it — no charge if it agrees.</p>
          <FlowAction
            url={`/api/orders/${order.id}/cancel-request`}
            label="Ask the shop to cancel"
            noteLabel="Why do you want to cancel? (optional)"
            noteField="reason"
            doneText="The shop has been asked. You will be told its answer."
            testId="flows-v3-cancel-request"
          />
        </div>
      ) : null}
      {request?.status === "DECLINED" ? (
        <Alert tone="warning" title="The shop could not cancel this order">
          {request.decisionNote ?? "It will be delivered as planned."}
        </Alert>
      ) : null}
      {rest.offer ? (
        <div className="space-y-1">
          <p className="text-sm text-ink-600">
            The other {rest.orders.length === 1 ? "order" : "orders"} from this checkout ({rest.orders.map((o) => `${o.orderNumber} · ${o.shopName}`).join(", ")}) still
            continue.
          </p>
          <FlowAction
            url={`/api/orders/${order.id}/cancel-group-rest`}
            label={rest.orders.length === 1 ? "Cancel the other order too" : "Cancel the other orders too"}
            confirmText="Cancel the other orders from this checkout? Each is refunded in full."
            doneText="The other orders were cancelled."
            testId="flows-v3-cancel-group-rest"
          />
        </div>
      ) : null}
      {referral ? (
        <div className="space-y-1">
          <p className="text-sm text-ink-600">Were you referred by someone? You can add their referral code now (optional).</p>
          <FlowAction url="/api/me/signup-referral" label="Add a referral code" noteLabel="Referral code" noteField="code" doneText="Referral code saved." />
        </div>
      ) : null}
    </div>
  );
}
