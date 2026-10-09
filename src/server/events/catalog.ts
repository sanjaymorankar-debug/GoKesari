/**
 * The event catalogue: every business event the event layer knows, what its
 * subject is, and who hears about it. This is the one place that answers
 * "who is notified when X happens" — the test checklist in
 * docs/event-driven-2026-10/TEST_CHECKLIST.md is written from it.
 *
 * A message goes to a user id, or to an audience ("SUPPORT" = operators and
 * administrators, "SUPPORT_LEAD" = administrators). The person who caused the
 * event is skipped unless a message says `includeActor` — nobody needs to be
 * told what they just did, but a result (a document verified, a ticket number)
 * is still worth confirming.
 */
import { formatPaise } from "@/lib/money";
import type { MachineKind } from "@/lib/state-machines";
import type { Channel } from "@/server/notifications/templates";
import { NOTIFICATION_TYPES as N, type NotificationType } from "@/server/notifications/types";
import type { Audience } from "./recipients";

type Vars = Record<string, string | number | null | undefined>;

export type SubjectKind = MachineKind | "shop" | "risk_flag" | "notification" | "seller_review" | "bank_account" | "referral_request" | "bank_refund" | "customer_referral_request";

export interface EventMessage {
  /** A user id, an audience, or nothing (skipped — e.g. an order with no rider). */
  to: string | Audience | null | undefined;
  type: NotificationType;
  vars?: Vars;
  title?: string;
  body?: string;
  actionUrl?: string;
  channels?: Channel[];
  includeActor?: boolean;
  /**
   * The scope of "at most once per person". Defaults to this event; a wider
   * scope (e.g. `order:<id>:rider-search`) sends once across many events.
   */
  dedupe?: string;
}

interface EventDefinition<P> {
  subject: SubjectKind;
  messages: (payload: P) => EventMessage[];
}

const define = <P>(subject: SubjectKind, messages: EventDefinition<P>["messages"]): EventDefinition<P> => ({
  subject,
  messages,
});

/* ------------------------------------------------------------------ payloads */

export interface OrderEventPayload {
  orderId: string;
  orderNumber: string;
  buyerId: string;
  shopOwnerId: string | null;
  shopName: string;
  riderUserId?: string | null;
  riderName?: string | null;
  reason?: string | null;
  /** For order.ready: READY reached again after a rider was taken off (reassignment). */
  reassigned?: boolean;
  /** For order.cancelled: who cancelled, and whether the shop had already started on it. */
  cancelledBy?: "CUSTOMER" | "SHOP" | "SUPPORT" | "SYSTEM";
  beforePacking?: boolean;
  minutes?: number;
  acceptByLabel?: string;
  /** order.delivered with rule shopWallet on: what was debited from the shop wallet, and the balance after. */
  walletCharge?: {
    commissionPaise: number;
    deliveryChargePaise: number;
    deliveryDistanceM?: number | null;
    balancePaise: number;
    belowMinimum: boolean;
  } | null;
}

export interface DeliveryEventPayload {
  orderId: string;
  orderNumber: string;
  buyerId: string;
  shopOwnerId: string | null;
  riderUserId: string | null;
  distanceKm?: number;
  batched?: boolean;
  reason?: string | null;
  shopName?: string;
  minutes?: number;
  attempts?: number;
  /** delivery.code_locked: the support ticket raised for the lockout. */
  ticketNumber?: string | null;
}

/** Shop prepaid wallet events (shop-wallet.ts). */
export interface ShopWalletEventPayload {
  shopId: string;
  shopName: string;
  ownerId: string;
  balancePaise: number;
  amountPaise?: number;
  minBalancePaise?: number;
  thresholdPaise?: number;
  direction?: "CREDIT" | "DEBIT";
  reason?: string;
}

export interface SellerDocumentPayload {
  shopId: string;
  shopName: string;
  ownerId: string;
  docLabel: string;
  status: string;
  numberMasked?: string | null;
  /** Seller-facing explanation for a failed / expired / more-info result. */
  message?: string | null;
  /** Support-facing reason the document needs review. */
  why?: string | null;
  decision?: "approved" | "rejected" | "sent back for more information";
  by?: string | null;
}

export interface DisputeEventPayload {
  disputeId: string;
  caseNumber: string;
  orderNumber: string;
  buyerId: string | null;
  shopOwnerId: string | null;
  level: "L1" | "L2";
  statusLabel: string;
  reasonLabel?: string;
  amountPaise?: number;
  detail?: string | null;
  proposal?: string | null;
  outcome?: string | null;
  author?: string;
  excerpt?: string;
  internal?: boolean;
  why?: string;
  /** dispute.status_changed: which customer template applies. */
  customerTemplate?: "RESOLUTION_PROPOSED" | "REJECTED";
}

/* ------------------------------------------------- docs/four-features-2026-10 */

/** Fulfilment options (services/fulfilment-options.ts). */
export interface FulfilmentEventPayload {
  orderId: string;
  orderNumber: string;
  buyerId: string;
  /** Named apart from OrderEventPayload.shopOwnerId so these are not order status events. */
  shopOwnerUserId: string | null;
  shopName: string;
  /** "Pickup from the shop", "Shop's own delivery", "GoKesari delivery partner". */
  optionLabel: string;
  /** "Thu 8 Oct, 5:00–6:00 pm". */
  whenLabel: string;
  staffName?: string | null;
  /** order.fulfilment_changed: what it was before. */
  previousLabel?: string | null;
  /** True when support (not the shop) made the change: the shop is told too. */
  bySupport?: boolean;
  attempts?: number;
  ticketNumber?: string | null;
  codeKind?: "pickup" | "delivery";
  /** Pickup: the delivery fee given back ("Your ₹20.00 delivery fee has been refunded…"). */
  deliveryFeeNote?: string | null;
}

/** Mandatory legal documents (services/legal-documents.ts). */
export interface LegalDocumentEventPayload {
  shopId: string;
  shopName: string;
  ownerId: string;
  docLabel: string;
  decision?: "approved" | "rejected";
  reason?: string | null;
  graceUntilLabel?: string | null;
  expiryLabel?: string | null;
}

/** Bank account verification (services/bank-accounts.ts). */
export interface BankAccountEventPayload {
  userId: string;
  accountLabel: string;
  reason?: string | null;
  forShop: boolean;
}

/** Refunds to a customer's bank (services/bank-refunds.ts). */
export interface BankRefundEventPayload {
  requestId: string;
  userId: string;
  customerName: string | null;
  amountLabel: string;
  accountLabel: string;
  orderNumber: string | null;
  expectedWorkingDays?: number;
  reference?: string | null;
  reason?: string | null;
}

/** Customer referral-code requests (services/customer-referral-requests.ts). */
export interface CustomerReferralRequestEventPayload {
  requestId: string;
  reference: string;
  name: string;
  city: string;
  pincode: string;
  requesterUserId: string;
  decision?: "issued" | "rejected";
  code?: string | null;
  reason?: string | null;
}

/** Shop referral-code requests (services/referral-requests.ts). */
export interface ReferralRequestEventPayload {
  requestId: string;
  name: string;
  city: string;
  pincode: string;
  shopTypeLabel: string;
  requesterUserId?: string | null;
  decision?: "issued" | "rejected";
  code?: string | null;
  reason?: string | null;
}

/* ------------------------------------------------------------------- helpers */

const ORDERS = "/orders";
const SHOP_ORDERS = "/shop/orders";
const SHOP_WALLET = "/shop/wallet";
const disputeUrl = (id: string) => `/disputes/${id}`;

const forShop = (p: OrderEventPayload, type: NotificationType, vars: Vars = {}): EventMessage => ({
  to: p.shopOwnerId,
  type,
  vars: { orderNumber: p.orderNumber, riderName: p.riderName ?? "The rider", ...vars },
  actionUrl: SHOP_ORDERS,
});

const forBuyer = (p: OrderEventPayload, type: NotificationType, vars: Vars = {}): EventMessage => ({
  to: p.buyerId,
  type,
  vars: { orderNumber: p.orderNumber, shopName: p.shopName, ...vars },
  actionUrl: ORDERS,
});

/* ----------------------------------------------------------------- the list */

export const EVENTS = {
  /* ---------------------------------------------------------------- orders */
  // Checkout already tells the customer and the shop (orders.ts); the event is the record.
  "order.placed": define<OrderEventPayload>("order", () => []),
  "order.accepted": define<OrderEventPayload>("order", (p) => [forBuyer(p, N.ORDER_ACCEPTED)]),
  "order.preparing": define<OrderEventPayload>("order", () => []),
  "order.ready": define<OrderEventPayload>("order", (p) => (p.reassigned ? [] : [forBuyer(p, N.ORDER_READY)])),
  "order.assigned": define<OrderEventPayload>("order", (p) => [
    forBuyer(p, N.ORDER_ASSIGNED),
    forShop(p, N.SHOP_RIDER_ASSIGNED),
  ]),
  "order.picked_up": define<OrderEventPayload>("order", (p) => [
    forBuyer(p, N.ORDER_PICKED_UP),
    forShop(p, N.SHOP_ORDER_PICKED_UP),
  ]),
  "order.out_for_delivery": define<OrderEventPayload>("order", (p) => [
    forBuyer(p, N.ORDER_OUT_FOR_DELIVERY),
    forShop(p, N.SHOP_ORDER_OUT_FOR_DELIVERY),
  ]),
  "order.delivered": define<OrderEventPayload>("order", (p) => [
    forBuyer(p, N.ORDER_DELIVERED),
    // Shop wallet: the shop hears what was debited and the balance after, at once.
    p.walletCharge
      ? {
          ...forShop(p, N.SHOP_ORDER_DELIVERED),
          title: "Order delivered — wallet charged",
          body:
            `Order ${p.orderNumber} has been delivered. Deducted from your shop wallet: ` +
            `commission ${formatPaise(p.walletCharge.commissionPaise)}, delivery charge ${formatPaise(p.walletCharge.deliveryChargePaise)}` +
            (p.walletCharge.deliveryChargePaise > 0 && p.walletCharge.deliveryDistanceM != null
              ? ` (${(p.walletCharge.deliveryDistanceM / 1000).toFixed(1)} km)`
              : "") +
            ". " +
            `New balance: ${formatPaise(p.walletCharge.balancePaise)}.` +
            (p.walletCharge.belowMinimum ? " Recharge your wallet to keep accepting new orders." : ""),
          actionUrl: SHOP_WALLET,
        }
      : forShop(p, N.SHOP_ORDER_DELIVERED),
    // The rider who made the drop gets the confirmation, once per order.
    {
      to: p.riderUserId,
      type: N.DELIVERY_CONFIRMED,
      vars: { orderNumber: p.orderNumber },
      actionUrl: "/delivery-partner",
      includeActor: true,
      dedupe: `order:${p.orderId}:delivered`,
    },
  ]),
  "order.failed": define<OrderEventPayload>("order", (p) => [
    forBuyer(p, N.ORDER_DELIVERY_FAILED, { reason: p.reason }),
    {
      ...forShop(p, N.ORDER_DELIVERY_FAILED),
      title: "Delivery failed",
      body: `Order ${p.orderNumber} could not be delivered: ${p.reason ?? "no reason given"}. The rider will bring it back.`,
    },
  ]),
  "order.cancelled": define<OrderEventPayload>("order", (p) => {
    const messages: EventMessage[] = [
      {
        ...forBuyer(p, N.ORDER_CANCELLED),
        title: "Order cancelled",
        body: `Your order ${p.orderNumber} was cancelled: ${p.reason ?? ""}`.trim(),
      },
    ];
    // The shop is told when someone else took the order off it: support, or
    // the customer after the shop had started (D6). A customer cancelling an
    // order the shop has not accepted yet stays silent for the shop (D10); a
    // system cancel (acceptance timeout) sends its own shop notice.
    if (p.cancelledBy === "SUPPORT" || (p.cancelledBy === "CUSTOMER" && p.beforePacking)) {
      messages.push({
        ...forShop(p, N.ORDER_CANCELLED),
        title: p.cancelledBy === "CUSTOMER" ? "Order cancelled by the customer" : "Order cancelled by support",
        body:
          p.cancelledBy === "CUSTOMER"
            ? `Order ${p.orderNumber} was cancelled by the customer before packing: ${p.reason}. Put the items back on the shelf.`
            : `Order ${p.orderNumber} was cancelled by support: ${p.reason}.`,
      });
    }
    if (p.riderUserId) {
      messages.push({
        to: p.riderUserId,
        type: N.DELIVERY_CANCELLED,
        vars: { orderNumber: p.orderNumber, reason: p.reason },
        actionUrl: "/delivery-partner",
      });
    }
    return messages;
  }),
  // DISPUTED, REFUND_PENDING, REFUNDED, RETURNED and the payment states: recorded, nobody notified here.
  "order.status_changed": define<OrderEventPayload>("order", () => []),
  "order.accept_reminder": define<OrderEventPayload>("order", (p) => [
    {
      to: p.shopOwnerId,
      type: N.SHOP_ACCEPT_REMINDER,
      title: "Accept the new order",
      body: `Order ${p.orderNumber} is cancelled automatically unless you accept it in the next ${p.minutes} min.`,
      actionUrl: SHOP_ORDERS,
    },
  ]),
  "order.accept_timed_out": define<OrderEventPayload>("order", (p) => [
    {
      to: p.shopOwnerId,
      type: N.SHOP_ORDER_TIMED_OUT,
      title: "Order cancelled — not accepted in time",
      body: `Order ${p.orderNumber} was cancelled and the customer refunded because it was not accepted by ${p.acceptByLabel}.`,
      actionUrl: SHOP_ORDERS,
    },
  ]),
  "order.accept_escalated": define<OrderEventPayload>("order", (p) => [
    {
      to: "SUPPORT",
      type: N.SUPPORT_ACCEPT_OVERDUE,
      vars: { orderNumber: p.orderNumber, shopName: p.shopName, minutes: p.minutes },
      actionUrl: "/admin/exceptions",
    },
    forShop(p, N.SHOP_ACCEPT_ESCALATED, { minutes: p.minutes }),
  ]),

  /* ------------------------------------------------------------ deliveries */
  "delivery.offered": define<DeliveryEventPayload>("delivery", (p) => [
    {
      to: p.riderUserId,
      type: N.DELIVERY_OFFERED,
      title: p.batched ? "Add a delivery to your trip" : "New delivery offer",
      body: p.batched
        ? `Another order fits your current trip (~${(p.distanceKm ?? 0).toFixed(1)} km from its pickup).`
        : `A delivery is available near you (~${(p.distanceKm ?? 0).toFixed(1)} km).`,
      actionUrl: "/delivery-partner",
    },
    // Once per order, however many riders are asked.
    {
      to: p.buyerId,
      type: N.ORDER_RIDER_SEARCH,
      vars: { orderNumber: p.orderNumber },
      actionUrl: ORDERS,
      dedupe: `order:${p.orderId}:rider-search`,
    },
    {
      to: p.shopOwnerId,
      type: N.SHOP_RIDER_SEARCH_STARTED,
      vars: { orderNumber: p.orderNumber },
      actionUrl: SHOP_ORDERS,
      includeActor: true,
      dedupe: `order:${p.orderId}:rider-search`,
    },
  ]),
  // The order's own ASSIGNED / PICKED_UP / OUT_FOR_DELIVERY / DELIVERED / FAILED
  // events tell the customer and the shop; these record the rider's side.
  "delivery.accepted": define<DeliveryEventPayload>("delivery", () => []),
  "delivery.rejected": define<DeliveryEventPayload>("delivery", (p) => [
    {
      to: p.shopOwnerId,
      type: N.SHOP_RIDER_DECLINED,
      vars: { orderNumber: p.orderNumber, why: "declined it" },
      actionUrl: SHOP_ORDERS,
    },
  ]),
  "delivery.offer_expired": define<DeliveryEventPayload>("delivery", (p) => [
    {
      to: p.shopOwnerId,
      type: N.SHOP_RIDER_DECLINED,
      vars: { orderNumber: p.orderNumber, why: "did not answer in time" },
      actionUrl: SHOP_ORDERS,
    },
  ]),
  "delivery.picked_up": define<DeliveryEventPayload>("delivery", () => []),
  "delivery.started": define<DeliveryEventPayload>("delivery", () => []),
  "delivery.delivered": define<DeliveryEventPayload>("delivery", () => []),
  "delivery.failed": define<DeliveryEventPayload>("delivery", () => []),
  "delivery.cancelled": define<DeliveryEventPayload>("delivery", (p) => [
    {
      to: p.riderUserId,
      type: N.DELIVERY_CANCELLED,
      vars: { orderNumber: p.orderNumber, reason: p.reason },
      actionUrl: "/delivery-partner",
    },
  ]),
  // Wrong delivery codes reached the limit: the drop is locked and a ticket raised.
  "delivery.code_locked": define<DeliveryEventPayload>("delivery", (p) => [
    {
      to: p.buyerId,
      type: N.ORDER_DELIVERY_CODE_LOCKED,
      vars: { orderNumber: p.orderNumber, ticketNumber: p.ticketNumber },
      actionUrl: ORDERS,
    },
    {
      to: p.shopOwnerId,
      type: N.SHOP_DELIVERY_CODE_LOCKED,
      vars: { orderNumber: p.orderNumber, ticketNumber: p.ticketNumber },
      actionUrl: SHOP_ORDERS,
    },
    {
      to: "SUPPORT",
      type: N.SUPPORT_DELIVERY_CODE_LOCKED,
      vars: { orderNumber: p.orderNumber, shopName: p.shopName, attempts: p.attempts, ticketNumber: p.ticketNumber },
      actionUrl: "/admin/exceptions",
    },
  ]),
  "delivery.search_overdue": define<DeliveryEventPayload>("delivery", (p) => [
    {
      to: "SUPPORT",
      type: N.SUPPORT_RIDER_UNASSIGNED,
      vars: { orderNumber: p.orderNumber, shopName: p.shopName, minutes: p.minutes, attempts: p.attempts },
      actionUrl: "/admin/orders",
    },
  ]),

  /* ------------------------------------------------------ seller documents */
  "seller_document.checked": define<SellerDocumentPayload>("seller_verification", (p) => {
    const seller = { to: p.ownerId, actionUrl: "/shop/verification", includeActor: true };
    switch (p.status) {
      case "VERIFIED":
        return [
          {
            ...seller,
            type: N.SHOP_DOCUMENT_VERIFIED,
            title: `${p.docLabel} verified`,
            body: `${p.shopName}'s ${p.docLabel} (${p.numberMasked ?? "on file"}) has been verified.`,
          },
        ];
      case "FAILED":
      case "EXPIRED":
        return [
          {
            ...seller,
            type: N.SHOP_DOCUMENT_ATTENTION,
            title: `${p.docLabel} needs your attention`,
            body: p.message ?? `We couldn't verify ${p.shopName}'s ${p.docLabel}.`,
          },
        ];
      case "MANUAL_REVIEW":
        return [
          { ...seller, type: N.SHOP_DOCUMENT_IN_REVIEW, vars: { shopName: p.shopName, docLabel: p.docLabel } },
          {
            to: "SUPPORT",
            type: N.SUPPORT_SELLER_REVIEW,
            vars: { shopName: p.shopName, docLabel: p.docLabel, why: p.why ?? "the automatic check could not decide" },
            actionUrl: "/admin/seller-verification",
          },
        ];
      default:
        // PENDING: the vendor did not answer; the daily job retries it.
        return [];
    }
  }),
  "seller_document.decided": define<SellerDocumentPayload>("seller_verification", (p) => [
    p.status === "VERIFIED"
      ? {
          to: p.ownerId,
          type: N.SHOP_DOCUMENT_VERIFIED,
          title: `${p.docLabel} verified`,
          body: `${p.shopName}'s ${p.docLabel} (${p.numberMasked ?? "on file"}) has been verified.`,
          actionUrl: "/shop/verification",
        }
      : {
          to: p.ownerId,
          type: N.SHOP_DOCUMENT_ATTENTION,
          title:
            p.decision === "sent back for more information"
              ? `More information needed for ${p.docLabel}`
              : `${p.docLabel} needs your attention`,
          body: p.message ?? `We couldn't verify ${p.shopName}'s ${p.docLabel}.`,
          actionUrl: "/shop/verification",
        },
    {
      to: "SUPPORT",
      type: N.SUPPORT_SELLER_DECIDED,
      vars: { shopName: p.shopName, docLabel: p.docLabel, decision: p.decision, by: p.by ?? "a reviewer", reason: p.message },
      actionUrl: "/admin/seller-verification",
    },
  ]),
  "seller_document.review_reminder": define<{ count: number; hours: number; oldest: string }>("seller_review", (p) => [
    {
      to: "SUPPORT",
      type: N.SUPPORT_SELLER_REVIEW_REMINDER,
      vars: { count: p.count, hours: p.hours, oldest: p.oldest },
      actionUrl: "/admin/seller-verification",
    },
  ]),
  "shop.auto_approved": define<{ shopName: string }>("shop", (p) => [
    { to: "SUPPORT", type: N.SUPPORT_SHOP_AUTO_APPROVED, vars: { shopName: p.shopName }, actionUrl: "/admin/shops" },
  ]),

  /* -------------------------------------------------------------- disputes */
  "dispute.opened": define<DisputeEventPayload>("dispute", (p) => [
    // The customer is told the ticket number even when they opened the case themselves.
    {
      to: p.buyerId,
      type: N.DISPUTE_OPENED,
      vars: { caseNumber: p.caseNumber, orderNumber: p.orderNumber },
      actionUrl: disputeUrl(p.disputeId),
      includeActor: true,
    },
    {
      to: p.shopOwnerId,
      type: N.SHOP_DISPUTE_OPENED,
      vars: { caseNumber: p.caseNumber, orderNumber: p.orderNumber, reason: p.reasonLabel },
      actionUrl: disputeUrl(p.disputeId),
    },
    {
      to: p.level === "L2" ? "SUPPORT_LEAD" : "SUPPORT",
      type: N.SUPPORT_DISPUTE_OPENED,
      vars: {
        caseNumber: p.caseNumber,
        orderNumber: p.orderNumber,
        amount: formatPaise(p.amountPaise ?? 0),
        reason: p.reasonLabel,
        level: p.level === "L2" ? " and escalated at once (above the review limit)" : "",
      },
      actionUrl: disputeUrl(p.disputeId),
    },
  ]),
  "dispute.comment_added": define<DisputeEventPayload>("dispute", (p) => {
    const vars = { caseNumber: p.caseNumber, author: p.author, excerpt: p.excerpt };
    const support: EventMessage = {
      to: p.level === "L2" ? "SUPPORT_LEAD" : "SUPPORT",
      type: N.DISPUTE_COMMENT,
      vars,
      actionUrl: disputeUrl(p.disputeId),
    };
    if (p.internal) return [support];
    return [
      { to: p.buyerId, type: N.DISPUTE_COMMENT, vars, actionUrl: disputeUrl(p.disputeId) },
      { to: p.shopOwnerId, type: N.DISPUTE_COMMENT, vars, actionUrl: disputeUrl(p.disputeId) },
      support,
    ];
  }),
  "dispute.status_changed": define<DisputeEventPayload>("dispute", (p) => {
    const updated = {
      type: N.DISPUTE_UPDATED,
      vars: { caseNumber: p.caseNumber, orderNumber: p.orderNumber, status: p.statusLabel.toLowerCase(), detail: p.detail },
      actionUrl: disputeUrl(p.disputeId),
    };
    const buyer: EventMessage =
      p.customerTemplate === "RESOLUTION_PROPOSED"
        ? {
            to: p.buyerId,
            type: N.DISPUTE_RESOLUTION_PROPOSED,
            vars: { caseNumber: p.caseNumber, proposal: p.proposal ?? "" },
            actionUrl: disputeUrl(p.disputeId),
          }
        : p.customerTemplate === "REJECTED"
          ? {
              to: p.buyerId,
              type: N.DISPUTE_REJECTED,
              vars: { caseNumber: p.caseNumber, reason: p.detail ?? "" },
              actionUrl: disputeUrl(p.disputeId),
            }
          : { to: p.buyerId, ...updated };
    return [
      buyer,
      { to: p.shopOwnerId, ...updated },
      {
        to: p.level === "L2" ? "SUPPORT_LEAD" : "SUPPORT",
        type: N.SUPPORT_DISPUTE_UPDATED,
        vars: { caseNumber: p.caseNumber, detail: `Dispute ${p.caseNumber} is now ${p.statusLabel.toLowerCase()}. ${p.detail ?? ""}` },
        actionUrl: disputeUrl(p.disputeId),
      },
    ];
  }),
  "dispute.escalated": define<DisputeEventPayload>("dispute", (p) => [
    {
      to: "SUPPORT_LEAD",
      type: N.SUPPORT_DISPUTE_ESCALATED,
      vars: { caseNumber: p.caseNumber, orderNumber: p.orderNumber, why: p.why },
      actionUrl: disputeUrl(p.disputeId),
    },
    {
      to: p.buyerId,
      type: N.DISPUTE_UPDATED,
      vars: {
        caseNumber: p.caseNumber,
        orderNumber: p.orderNumber,
        status: "with a senior reviewer",
        detail: "It has been passed to a senior member of our team.",
      },
      actionUrl: disputeUrl(p.disputeId),
    },
    // The escalation note is written for colleagues; the shop gets fixed wording.
    {
      to: p.shopOwnerId,
      type: N.DISPUTE_UPDATED,
      vars: {
        caseNumber: p.caseNumber,
        orderNumber: p.orderNumber,
        status: "with a senior reviewer",
        detail: "It has been passed to a senior member of the GoKesari team.",
      },
      actionUrl: disputeUrl(p.disputeId),
    },
  ]),
  "dispute.resolved": define<DisputeEventPayload>("dispute", (p) => [
    {
      to: p.buyerId,
      type: N.DISPUTE_RESOLVED,
      vars: { caseNumber: p.caseNumber, outcome: p.outcome ?? "" },
      actionUrl: disputeUrl(p.disputeId),
    },
    {
      to: p.shopOwnerId,
      type: N.DISPUTE_UPDATED,
      vars: { caseNumber: p.caseNumber, orderNumber: p.orderNumber, status: "resolved", detail: p.outcome },
      actionUrl: disputeUrl(p.disputeId),
    },
    {
      to: p.level === "L2" ? "SUPPORT_LEAD" : "SUPPORT",
      type: N.SUPPORT_DISPUTE_UPDATED,
      vars: { caseNumber: p.caseNumber, detail: `Dispute ${p.caseNumber} was resolved. ${p.outcome ?? ""}` },
      actionUrl: disputeUrl(p.disputeId),
    },
  ]),

  /* ----------------------------------------------------------- shop wallet */
  "shop_wallet.topped_up": define<ShopWalletEventPayload>("shop", (p) => [
    {
      to: p.ownerId,
      type: N.SHOP_WALLET_TOPUP_SUCCESS,
      vars: { shopName: p.shopName, amount: formatPaise(p.amountPaise ?? 0), balance: formatPaise(p.balancePaise) },
      actionUrl: SHOP_WALLET,
      includeActor: true,
    },
  ]),
  "shop_wallet.low_balance": define<ShopWalletEventPayload>("shop", (p) => [
    {
      to: p.ownerId,
      type: N.SHOP_WALLET_LOW_BALANCE,
      vars: {
        shopName: p.shopName,
        balance: formatPaise(p.balancePaise),
        detail:
          p.balancePaise < (p.minBalancePaise ?? 0)
            ? "You cannot accept new orders until you recharge."
            : `Recharge before it falls below ${formatPaise(p.minBalancePaise ?? 0)}, or you will not be able to accept new orders.`,
      },
      actionUrl: SHOP_WALLET,
      includeActor: true,
    },
  ]),
  "shop_wallet.adjusted": define<ShopWalletEventPayload>("shop", (p) => [
    {
      to: p.ownerId,
      type: N.SHOP_WALLET_ADJUSTED,
      vars: {
        shopName: p.shopName,
        amount: formatPaise(p.amountPaise ?? 0),
        change: p.direction === "CREDIT" ? "added to" : "deducted from",
        reason: p.reason,
        balance: formatPaise(p.balancePaise),
      },
      actionUrl: SHOP_WALLET,
    },
  ]),

  /* ------------------------------------- fulfilment options (four-features-2026-10) */
  "order.fulfilment_set": define<FulfilmentEventPayload>("order", (p) => [
    {
      to: p.buyerId,
      type: N.ORDER_FULFILMENT_SET,
      title: p.optionLabel.startsWith("Pickup") ? "Ready for pickup" : "Delivery scheduled",
      body:
        `Order ${p.orderNumber} from ${p.shopName}: ${p.optionLabel}${p.staffName ? ` (${p.staffName})` : ""}, ${p.whenLabel}.` +
        (p.optionLabel.startsWith("Pickup") ? " Show your pickup code from My Orders at the shop." : "") +
        (p.deliveryFeeNote ? ` ${p.deliveryFeeNote}` : ""),
      actionUrl: ORDERS,
      channels: ["EMAIL"],
    },
    ...(p.bySupport
      ? [{ to: p.shopOwnerUserId, type: N.SHOP_FULFILMENT_CHANGED, title: "Order fulfilment set by support", body: `Order ${p.orderNumber}: ${p.optionLabel}, ${p.whenLabel}.`, actionUrl: SHOP_ORDERS }]
      : []),
  ]),
  "order.fulfilment_changed": define<FulfilmentEventPayload>("order", (p) => [
    {
      to: p.buyerId,
      type: N.ORDER_FULFILMENT_CHANGED,
      title: "Your order's delivery plan changed",
      body: `Order ${p.orderNumber} from ${p.shopName} is now: ${p.optionLabel}${p.staffName ? ` (${p.staffName})` : ""}, ${p.whenLabel}.${p.previousLabel ? ` Before: ${p.previousLabel}.` : ""}${p.deliveryFeeNote ? ` ${p.deliveryFeeNote}` : ""}`,
      actionUrl: ORDERS,
      channels: ["EMAIL"],
    },
    ...(p.bySupport
      ? [{ to: p.shopOwnerUserId, type: N.SHOP_FULFILMENT_CHANGED, title: "Order fulfilment changed by support", body: `Order ${p.orderNumber} is now: ${p.optionLabel}, ${p.whenLabel}.`, actionUrl: SHOP_ORDERS }]
      : []),
  ]),
  "order.fulfilment_code_locked": define<FulfilmentEventPayload>("order", (p) => [
    {
      to: p.buyerId,
      type: N.ORDER_FULFILMENT_CODE_LOCKED,
      title: p.codeKind === "pickup" ? "Pickup on hold" : "Delivery on hold",
      body: `Too many wrong ${p.codeKind === "pickup" ? "pickup" : "delivery"} codes were entered for order ${p.orderNumber}. Our support team will contact you${p.ticketNumber ? ` (ticket ${p.ticketNumber})` : ""}.`,
      actionUrl: ORDERS,
      includeActor: true,
    },
    {
      to: p.shopOwnerUserId,
      type: N.SHOP_FULFILMENT_CODE_LOCKED,
      title: "Code locked — support will confirm",
      body: `Order ${p.orderNumber}: ${p.attempts ?? "too many"} wrong codes. Support will confirm the handover with the customer${p.ticketNumber ? ` (ticket ${p.ticketNumber})` : ""}.`,
      actionUrl: SHOP_ORDERS,
      includeActor: true,
    },
    {
      to: "SUPPORT",
      type: N.SUPPORT_FULFILMENT_CODE_LOCKED,
      title: "Pickup / own-delivery code locked",
      body: `Order ${p.orderNumber} (${p.shopName}) is locked after ${p.attempts ?? "too many"} wrong codes${p.ticketNumber ? ` — ticket ${p.ticketNumber}` : ""}. Confirm with the customer from Order monitoring.`,
      actionUrl: "/admin/orders",
    },
  ]),

  /* ------------------------------------- legal documents (four-features-2026-10) */
  "shop.legal_document_required": define<LegalDocumentEventPayload>("shop", (p) => [
    {
      to: p.ownerId,
      type: N.SHOP_LEGAL_DOCUMENT_REQUIRED,
      title: `${p.docLabel} required`,
      body: `${p.shopName} needs a ${p.docLabel} to keep accepting orders.${p.graceUntilLabel ? ` Upload it by ${p.graceUntilLabel}.` : " Upload it to go live."}`,
      actionUrl: "/shop/legal-documents",
      channels: ["EMAIL"],
      includeActor: true,
    },
  ]),
  "shop.legal_document_submitted": define<LegalDocumentEventPayload>("shop", (p) => [
    {
      to: "SUPPORT",
      type: N.SUPPORT_LEGAL_DOCUMENT_SUBMITTED,
      title: "Legal document to review",
      body: `${p.shopName} submitted a ${p.docLabel}. Review it in Legal documents.`,
      actionUrl: "/admin/legal-documents",
    },
  ]),
  "shop.legal_document_decided": define<LegalDocumentEventPayload>("shop", (p) => [
    {
      to: p.ownerId,
      type: N.SHOP_LEGAL_DOCUMENT_DECIDED,
      title: p.decision === "approved" ? `${p.docLabel} approved` : `${p.docLabel} rejected`,
      body:
        p.decision === "approved"
          ? `The ${p.docLabel} for ${p.shopName} has been approved.`
          : `The ${p.docLabel} for ${p.shopName} was rejected: ${p.reason ?? "no reason given"}. Upload a corrected copy.`,
      actionUrl: "/shop/legal-documents",
      channels: ["EMAIL"],
    },
  ]),
  "shop.legal_document_expiring": define<LegalDocumentEventPayload>("shop", (p) => [
    {
      to: p.ownerId,
      type: N.SHOP_LEGAL_DOCUMENT_EXPIRING,
      title: `${p.docLabel} expires soon`,
      body: `The ${p.docLabel} for ${p.shopName} expires on ${p.expiryLabel}. Upload the renewed licence before then to keep accepting orders.`,
      actionUrl: "/shop/legal-documents",
      channels: ["EMAIL"],
      includeActor: true,
    },
  ]),

  /* --------------------------------------- bank accounts (four-features-2026-10) */
  "bank_account.verified": define<BankAccountEventPayload>("bank_account", (p) => [
    {
      to: p.userId,
      type: N.BANK_ACCOUNT_VERIFIED,
      title: "Bank account verified",
      body: `${p.accountLabel} is verified. The ₹1 verification payment is being refunded.`,
      actionUrl: p.forShop ? "/shop/bank-account" : "/profile/bank-account",
      includeActor: true,
    },
  ]),
  "bank_account.verification_failed": define<BankAccountEventPayload>("bank_account", (p) => [
    {
      to: p.userId,
      type: N.BANK_ACCOUNT_VERIFICATION_FAILED,
      title: "Bank account not verified",
      body: `${p.accountLabel} could not be verified: ${p.reason ?? "the payment did not go through"}. You can try again.`,
      actionUrl: p.forShop ? "/shop/bank-account" : "/profile/bank-account",
      includeActor: true,
    },
  ]),

  /* ------------------------------------------ refunds to a customer's bank */
  "bank_refund.requested": define<BankRefundEventPayload>("bank_refund", (p) => [
    {
      to: p.userId,
      type: N.BANK_REFUND_REQUESTED,
      title: "Refund on its way to your bank",
      body: `${p.amountLabel}${p.orderNumber ? ` (order ${p.orderNumber})` : ""} will be sent to ${p.accountLabel} within ${p.expectedWorkingDays ?? 5} working days. It has left your wallet.`,
      actionUrl: "/wallet",
      channels: ["EMAIL"],
      includeActor: true,
    },
    {
      to: "SUPPORT_LEAD",
      type: N.SUPPORT_BANK_REFUND_REQUESTED,
      title: "Refund to send to a bank",
      body: `${p.customerName ?? "A customer"} asked for ${p.amountLabel} to ${p.accountLabel}${p.orderNumber ? ` (order ${p.orderNumber})` : ""}.`,
      actionUrl: "/admin/bank-refunds",
    },
  ]),
  "bank_refund.paid": define<BankRefundEventPayload>("bank_refund", (p) => [
    {
      to: p.userId,
      type: N.BANK_REFUND_PAID,
      title: "Refund sent to your bank",
      body: `${p.amountLabel} was sent to ${p.accountLabel}${p.reference ? ` (bank reference ${p.reference})` : ""}.`,
      actionUrl: "/wallet",
      channels: ["EMAIL"],
    },
  ]),
  "bank_refund.returned": define<BankRefundEventPayload>("bank_refund", (p) => [
    {
      to: p.userId,
      type: N.BANK_REFUND_RETURNED,
      title: "Refund back in your wallet",
      body: `${p.amountLabel} could not be sent to ${p.accountLabel}${p.reason ? `: ${p.reason}` : ""}. It is back in your wallet.`,
      actionUrl: "/wallet",
      channels: ["EMAIL"],
      includeActor: true,
    },
  ]),

  /* --------------------------------------------- customer referral-code requests */
  "customer_referral_request.created": define<CustomerReferralRequestEventPayload>("customer_referral_request", (p) => [
    {
      to: "SUPPORT",
      type: N.SUPPORT_CUSTOMER_REFERRAL_REQUEST,
      title: "Customer asked for a referral code",
      body: `${p.name}, ${p.city} ${p.pincode} (${p.reference}). Send someone or issue a code in Referral requests.`,
      actionUrl: "/admin/referral-requests",
    },
  ]),
  "customer_referral_request.decided": define<CustomerReferralRequestEventPayload>("customer_referral_request", (p) => [
    {
      to: p.requesterUserId,
      type: N.CUSTOMER_REFERRAL_REQUEST_DECIDED,
      title: p.decision === "issued" ? "Your GoKesari referral code" : "About your referral code request",
      body:
        p.decision === "issued"
          ? `Your referral code is ${p.code}. Enter it in My referral code to start ordering (${p.reference}).`
          : `We could not give you a referral code this time${p.reason ? `: ${p.reason}` : ""} (${p.reference}).`,
      actionUrl: "/referral",
      channels: ["EMAIL"],
    },
  ]),

  /* ------------------------------ shop referral requests (four-features-2026-10) */
  "referral_request.created": define<ReferralRequestEventPayload>("referral_request", (p) => [
    {
      to: "SUPPORT",
      type: N.SUPPORT_REFERRAL_REQUEST,
      title: "New referral-code request",
      body: `${p.name} (${p.shopTypeLabel}, ${p.city} ${p.pincode}) asked for a shop referral code.`,
      actionUrl: "/admin/referral-requests",
    },
  ]),
  "referral_request.decided": define<ReferralRequestEventPayload>("referral_request", (p) => [
    {
      to: p.requesterUserId,
      type: N.SHOP_REFERRAL_REQUEST_DECIDED,
      title: p.decision === "issued" ? "Your referral code is ready" : "Referral code request declined",
      body:
        p.decision === "issued"
          ? `Use referral code ${p.code} to register your shop.`
          : `Your request for a referral code was declined${p.reason ? `: ${p.reason}` : "."}`,
      actionUrl: "/shop/register",
      channels: ["EMAIL"],
    },
  ]),

  /* --------------------------------------------------------- risk & system */
  "risk.flag_raised": define<{ severity: string; label: string; summary: string }>("risk_flag", (p) => [
    { to: "SUPPORT", type: N.RISK_FLAG_RAISED, vars: p, actionUrl: "/admin/risk" },
  ]),
  "notification.dead": define<{
    count: number;
    attempts: number;
    type: string;
    channel: string;
    error: string;
  }>("notification", (p) => [
    // In the app only: the failing channel may be the one an alert would use.
    { to: "SUPPORT", type: N.SUPPORT_NOTIFICATION_DEAD, vars: p, actionUrl: "/admin" },
  ]),
} as const;

export type EventType = keyof typeof EVENTS;
export type EventPayload<T extends EventType> = (typeof EVENTS)[T] extends EventDefinition<infer P> ? P : never;

export type OrderEventType = {
  [K in EventType]: EventPayload<K> extends OrderEventPayload ? K : never;
}[EventType];

/** The order event for an order status, used by every order status change. */
export function orderEventFor(status: string): OrderEventType {
  switch (status) {
    case "CONFIRMED":
      return "order.placed";
    case "ACCEPTED":
      return "order.accepted";
    case "PREPARING":
      return "order.preparing";
    case "READY":
      return "order.ready";
    case "ASSIGNED":
      return "order.assigned";
    case "PICKED_UP":
      return "order.picked_up";
    case "OUT_FOR_DELIVERY":
      return "order.out_for_delivery";
    case "DELIVERED":
      return "order.delivered";
    case "FAILED":
      return "order.failed";
    case "CANCELLED":
      return "order.cancelled";
    default:
      return "order.status_changed";
  }
}
