/** Notification event types — a dependency-free module so templates and services can both import it. */

export const NOTIFICATION_TYPES = {
  SHOP_APPROVED: "shop.approved",
  SHOP_REJECTED: "shop.rejected",
  /** DEF-02 (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): a shop previously learned about a new order only by refreshing /shop/orders. */
  SHOP_NEW_ORDER: "shop.new_order",
  /** To the shop: an order arrived while the shop is closed (customer confirmed they want to wait). */
  SHOP_ORDER_WHILE_CLOSED: "shop.order_while_closed",
  /** To the shop, once: it is open again and these queued orders are waiting for acceptance. */
  SHOP_OPENED_ORDERS_WAITING: "shop.opened_orders_waiting",
  /** To the customer: order placed, shop closed, it will be processed when the shop opens. */
  ORDER_QUEUED_SHOP_CLOSED: "order.queued_shop_closed",
  /** To the customer, once: the shop has opened and can now accept the order. */
  ORDER_SHOP_NOW_OPEN: "order.shop_now_open",
  ORDER_CONFIRMED: "order.confirmed",
  ORDER_ACCEPTED: "order.accepted",
  ORDER_ASSIGNED: "order.assigned",
  ORDER_DELIVERY_FAILED: "order.delivery_failed",
  /** Shop proposed a replacement for an unavailable item; customer must decide. */
  ORDER_SUBSTITUTION_PROPOSED: "order.substitution_proposed",
  ORDER_ITEM_REMOVED: "order.item_removed",
  /** To the shop: no rider accepted yet — the system keeps retrying. */
  DELIVERY_UNASSIGNED: "delivery.unassigned",
  /** To the shop: the automatic rider search gave up (limit, time or delivery window). */
  DELIVERY_SEARCH_STOPPED: "delivery.search_stopped",
  /* --------------------------------------------------- disputes (GS-058) */
  DISPUTE_OPENED: "dispute.opened",
  DISPUTE_RESOLUTION_PROPOSED: "dispute.resolution_proposed",
  DISPUTE_RESOLVED: "dispute.resolved",
  DISPUTE_REJECTED: "dispute.rejected",
  /* ---------------------------------------------------- returns */
  RETURN_REQUESTED: "return.requested",
  RETURN_APPROVED: "return.approved",
  RETURN_REJECTED: "return.rejected",
  RETURN_CANCELLED: "return.cancelled",
  RETURN_PICKUP_OFFERED: "return.pickup_offered",
  RETURN_PICKUP_ASSIGNED: "return.pickup_assigned",
  RETURN_PICKUP_UNASSIGNED: "return.pickup_unassigned",
  RETURN_RIDER_EN_ROUTE: "return.rider_en_route",
  RETURN_PICKED_UP: "return.picked_up",
  RETURN_PICKUP_FAILED: "return.pickup_failed",
  RETURN_INSPECTION_PENDING: "return.inspection_pending",
  RETURN_REFUND_INITIATED: "return.refund_initiated",
  RETURN_REFUND_COMPLETED: "return.refund_completed",
  /** To the shop: the rider is at the counter. */
  DELIVERY_RIDER_AT_SHOP: "delivery.rider_at_shop",
  /** To the customer: the rider has reached the door / gate. */
  ORDER_RIDER_ARRIVING: "order.rider_arriving",
  /* ---------------------------------------------------- Phase 2 */
  SOCIETY_VERIFIED: "society.verified",
  SOCIETY_REJECTED: "society.rejected",
  SOCIETY_MEMBERSHIP_REQUESTED: "society.membership_requested",
  SOCIETY_MEMBERSHIP_DECIDED: "society.membership_decided",
  /** To society admins/operators: a rider is on the way to a society home (GS-046). */
  SOCIETY_SECURITY_ALERT: "society.security_alert",
  /** To the customer after delivery: rate the shop and rider. */
  RATING_REQUESTED: "rating.requested",
  SUBSCRIPTION_RESUMED: "subscription.resumed",
  SUBSCRIPTION_CANCELLED: "subscription.cancelled",
  // Phase 3
  MARKETING_CAMPAIGN: "marketing.campaign",
  CAMPAIGN_DECIDED: "marketing.campaign_decided",
  CAMPAIGN_SUBMITTED: "marketing.campaign_submitted",
  RISK_FLAG_RAISED: "risk.flag_raised",
  ORDER_READY: "order.ready",
  ORDER_OUT_FOR_DELIVERY: "order.out_for_delivery",
  ORDER_DELIVERED: "order.delivered",
  ORDER_CANCELLED: "order.cancelled",
  WALLET_TOPUP_SUCCESS: "wallet.topup_success",
  WALLET_LOW_BALANCE: "wallet.low_balance",
  SUBSCRIPTION_CREATED: "subscription.created",
  SUBSCRIPTION_MODIFIED: "subscription.modified",
  SUBSCRIPTION_SKIPPED: "subscription.skipped",
  SUBSCRIPTION_PAUSED: "subscription.paused",
  SUBSCRIPTION_ORDER_CREATED: "subscription.order_created",
  SUBSCRIPTION_PAYMENT_FAILED: "subscription.payment_failed",
  SUBSCRIPTION_UPCOMING_REMINDER: "subscription.upcoming_reminder",
  PRICE_CHANGED: "product.price_changed",
  GRIEVANCE_ACKNOWLEDGED: "grievance.acknowledged",
  GRIEVANCE_RESOLVED: "grievance.resolved",
  DELIVERY_PARTNER_APPROVED: "delivery_partner.approved",
  DELIVERY_PARTNER_REJECTED: "delivery_partner.rejected",
  DELIVERY_PARTNER_SUSPENDED: "delivery_partner.suspended",
  DELIVERY_OFFERED: "delivery.offered",
  SHOP_GST_VERIFIED: "shop.gst_verified",
  SHOP_GST_REJECTED: "shop.gst_rejected",
  SHOP_PAN_VERIFIED: "shop.pan_verified",
  SHOP_PAN_REJECTED: "shop.pan_rejected",
  STOCK_LOW: "inventory.stock_low",
  /* ------------------------------------------------ framework additions */
  ORDER_PICKED_UP: "order.picked_up",
  SHOP_SUSPENDED: "shop.suspended",
  SHOP_REACTIVATED: "shop.reactivated",
  SECURITY_SIGN_IN: "security.sign_in",
  SECURITY_PHONE_CHANGED: "security.phone_changed",
  SECURITY_ROLE_CHANGED: "security.role_changed",
  SECURITY_ACCOUNT_STATUS: "security.account_status",
} as const;

export type NotificationType =
  (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];
