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
  /** SM-004: the term ends soon, or the wallet will not cover the next delivery. */
  SUBSCRIPTION_RENEWAL_DUE: "subscription.renewal_due",
  SUBSCRIPTION_RENEWED: "subscription.renewed",
  /** SM-004: the end date passed; no further deliveries. */
  SUBSCRIPTION_COMPLETED: "subscription.completed",
  /** NEW-007: to the shop — accept this order soon or it is cancelled. */
  SHOP_ACCEPT_REMINDER: "shop.accept_reminder",
  /** NEW-007: to the shop — an order was cancelled because it was not accepted in time. */
  SHOP_ORDER_TIMED_OUT: "shop.order_timed_out",
  /** NEW-007: the order's tax invoice can be downloaded. */
  ORDER_INVOICE_READY: "order.invoice_ready",
  PRICE_CHANGED: "product.price_changed",
  GRIEVANCE_ACKNOWLEDGED: "grievance.acknowledged",
  GRIEVANCE_RESOLVED: "grievance.resolved",
  DELIVERY_PARTNER_APPROVED: "delivery_partner.approved",
  DELIVERY_PARTNER_REJECTED: "delivery_partner.rejected",
  DELIVERY_PARTNER_SUSPENDED: "delivery_partner.suspended",
  DELIVERY_PARTNER_CHANGE_DECIDED: "delivery_partner.change_decided",
  SHOP_PRODUCT_IMAGE_DECIDED: "shop.product_image_decided",
  REFERRAL_REWARDED: "referral.rewarded",
  DELIVERY_OFFERED: "delivery.offered",
  SHOP_GST_VERIFIED: "shop.gst_verified",
  SHOP_GST_REJECTED: "shop.gst_rejected",
  SHOP_PAN_VERIFIED: "shop.pan_verified",
  SHOP_PAN_REJECTED: "shop.pan_rejected",
  /** Seller verification: a document checked out. */
  SHOP_DOCUMENT_VERIFIED: "shop.document_verified",
  /** Seller verification: a document failed, needs re-upload, or was rejected by an admin. */
  SHOP_DOCUMENT_ATTENTION: "shop.document_attention",
  /** Seller verification: an FSSAI or Shop Act document expires soon. */
  SHOP_DOCUMENT_EXPIRING: "shop.document_expiring",
  STOCK_LOW: "inventory.stock_low",
  /* ------------------------------------------------ framework additions */
  ORDER_PICKED_UP: "order.picked_up",
  SHOP_SUSPENDED: "shop.suspended",
  SHOP_REACTIVATED: "shop.reactivated",
  SECURITY_SIGN_IN: "security.sign_in",
  SECURITY_PHONE_CHANGED: "security.phone_changed",
  SECURITY_ROLE_CHANGED: "security.role_changed",
  SECURITY_ACCOUNT_STATUS: "security.account_status",
  /* ------------------------------------- event layer (docs/event-driven-2026-10) */
  /** To the customer, once per order: the rider search has started. */
  ORDER_RIDER_SEARCH: "order.rider_search",
  /** To the shop, once per order: the rider search has started. */
  SHOP_RIDER_SEARCH_STARTED: "shop.rider_search_started",
  /** To the shop: a rider declined or let an offer lapse; the next rider is being asked. */
  SHOP_RIDER_DECLINED: "shop.rider_declined",
  /** To the shop: a rider accepted and is coming for the pickup. */
  SHOP_RIDER_ASSIGNED: "shop.rider_assigned",
  SHOP_ORDER_PICKED_UP: "shop.order_picked_up",
  SHOP_ORDER_OUT_FOR_DELIVERY: "shop.order_out_for_delivery",
  SHOP_ORDER_DELIVERED: "shop.order_delivered",
  /** To the shop: the accept-by time passed and support has been asked to step in. */
  SHOP_ACCEPT_ESCALATED: "shop.accept_escalated",
  /** To the rider: an accepted delivery was cancelled or reassigned. */
  DELIVERY_CANCELLED: "delivery.cancelled",
  /** To the seller: a document is waiting for a person to review it. */
  SHOP_DOCUMENT_IN_REVIEW: "shop.document_in_review",
  /** To the shop: a customer opened a dispute on one of its orders. */
  SHOP_DISPUTE_OPENED: "shop.dispute_opened",
  /** To the customer and the shop: a dispute moved on (status, escalation). */
  DISPUTE_UPDATED: "dispute.updated",
  /** To the parties of a dispute: someone wrote on the case. */
  DISPUTE_COMMENT: "dispute.comment",
  /* Support (operators; administrators for SUPPORT_LEAD alerts). */
  SUPPORT_ACCEPT_OVERDUE: "support.accept_overdue",
  SUPPORT_RIDER_UNASSIGNED: "support.rider_unassigned",
  SUPPORT_NOTIFICATION_DEAD: "support.notification_dead",
  SUPPORT_SELLER_REVIEW: "support.seller_review",
  SUPPORT_SELLER_REVIEW_REMINDER: "support.seller_review_reminder",
  SUPPORT_SELLER_DECIDED: "support.seller_decided",
  SUPPORT_SHOP_AUTO_APPROVED: "support.shop_auto_approved",
  SUPPORT_DISPUTE_OPENED: "support.dispute_opened",
  SUPPORT_DISPUTE_UPDATED: "support.dispute_updated",
  SUPPORT_DISPUTE_ESCALATED: "support.dispute_escalated",
  /* ------------------------- shop wallet & delivery code (docs/shop-wallet-delivery-otp-2026-10) */
  SHOP_WALLET_TOPUP_SUCCESS: "shop.wallet_topup_success",
  SHOP_WALLET_LOW_BALANCE: "shop.wallet_low_balance",
  SHOP_WALLET_ADJUSTED: "shop.wallet_adjusted",
  /** To the rider: the order they dropped is confirmed delivered. */
  DELIVERY_CONFIRMED: "delivery.confirmed",
  /** To the customer: too many wrong delivery codes; support is checking. */
  ORDER_DELIVERY_CODE_LOCKED: "order.delivery_code_locked",
  SHOP_DELIVERY_CODE_LOCKED: "shop.delivery_code_locked",
  SUPPORT_DELIVERY_CODE_LOCKED: "support.delivery_code_locked",
  /* ------------------------------------------------- docs/four-features-2026-10 */
  /** To the customer: the shop chose pickup / own delivery / GoKesari partner and a time. */
  ORDER_FULFILMENT_SET: "order.fulfilment_set",
  /** To the customer: the option, the delivery person or the time changed. */
  ORDER_FULFILMENT_CHANGED: "order.fulfilment_changed",
  /** To the shop: support changed how one of its orders is fulfilled. */
  SHOP_FULFILMENT_CHANGED: "shop.fulfilment_changed",
  /** To the customer and the shop: too many wrong pickup / delivery codes. */
  ORDER_FULFILMENT_CODE_LOCKED: "order.fulfilment_code_locked",
  SHOP_FULFILMENT_CODE_LOCKED: "shop.fulfilment_code_locked",
  SUPPORT_FULFILMENT_CODE_LOCKED: "support.fulfilment_code_locked",
  /** To the shop owner: a licence is required (grace period started) / decided / expiring. */
  SHOP_LEGAL_DOCUMENT_REQUIRED: "shop.legal_document_required",
  SHOP_LEGAL_DOCUMENT_DECIDED: "shop.legal_document_decided",
  SHOP_LEGAL_DOCUMENT_EXPIRING: "shop.legal_document_expiring",
  SUPPORT_LEGAL_DOCUMENT_SUBMITTED: "support.legal_document_submitted",
  /** To the account holder: the ₹1 verification of a bank account succeeded / failed. */
  BANK_ACCOUNT_VERIFIED: "wallet.bank_account_verified",
  BANK_ACCOUNT_VERIFICATION_FAILED: "wallet.bank_account_verification_failed",
  /** To the customer: a refund is on its way to their bank / was paid / failed and is back in the wallet / was cancelled. */
  BANK_REFUND_REQUESTED: "wallet.bank_refund_requested",
  BANK_REFUND_PAID: "wallet.bank_refund_paid",
  BANK_REFUND_RETURNED: "wallet.bank_refund_returned",
  /** To finance (admins): a customer asked for a refund to their bank. */
  SUPPORT_BANK_REFUND_REQUESTED: "support.bank_refund_requested",
  /** To support: someone asked for a shop referral code. */
  SUPPORT_REFERRAL_REQUEST: "support.referral_request",
  /** To the requester (when signed in): a referral code was issued, or the request declined. */
  SHOP_REFERRAL_REQUEST_DECIDED: "shop.referral_request_decided",
} as const;

export type NotificationType =
  (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];
