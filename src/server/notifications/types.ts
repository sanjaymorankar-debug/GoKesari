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
  /** TC-DEL-015: the rider is told of a reactivation and a deactivation too. */
  DELIVERY_PARTNER_REACTIVATED: "delivery_partner.reactivated",
  DELIVERY_PARTNER_DEACTIVATED: "delivery_partner.deactivated",
  DELIVERY_PARTNER_CHANGE_DECIDED: "delivery_partner.change_decided",
  SHOP_PRODUCT_IMAGE_DECIDED: "shop.product_image_decided",
  /* -------------------- Module 1: shop staff and bulk photo upload */
  /** To the person added: they may now edit a shop's product photos and descriptions. */
  SHOP_STAFF_ADDED: "shop.staff_added",
  SHOP_STAFF_REMOVED: "shop.staff_removed",
  /** To the uploader: a bulk photo/description upload finished applying. */
  SHOP_MEDIA_IMPORT_FINISHED: "shop.media_import_finished",
  /** To the shop owner, and to the operator/admin who ran it: a bulk product upload finished (docs/product-import-2026-10). */
  SHOP_PRODUCT_IMPORT_FINISHED: "shop.product_import_finished",
  /* ------------------------------- Module 2: accounting integration */
  /** To the owner: an invoice / credit note / sync could not be sent to their accounting software. */
  INTEGRATION_SYNC_FAILED: "shop.integration_sync_failed",
  /** Module 3: a self-registered shop is approved (to the owner: SMS, WhatsApp, email when there is one). */
  SHOP_SELF_REGISTERED: "shop.self_registered",
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
  SUPPORT_SHOP_SELF_REGISTERED: "support.shop_self_registered",
  SUPPORT_REGISTRATION_PAYMENT_MISMATCH: "support.registration_payment_mismatch",
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
  /** To operations: a customer asked for a referral code. To the customer: a code was issued, or the request declined. */
  SUPPORT_CUSTOMER_REFERRAL_REQUEST: "support.customer_referral_request",
  CUSTOMER_REFERRAL_REQUEST_DECIDED: "customer.referral_request_decided",
  /** To support: someone asked for a shop referral code. */
  SUPPORT_REFERRAL_REQUEST: "support.referral_request",
  /** To the requester (when signed in): a referral code was issued, or the request declined. */
  SHOP_REFERRAL_REQUEST_DECIDED: "shop.referral_request_decided",
  /* ------------------------------------------- docs/inventory-accounting-2026-10 */
  /** To the shop owner: a supplier bill was read and waits for their review. */
  SHOP_BILL_READY: "shop.bill_ready",
  /** To the shop owner: a GST return is due soon (estimate of tax payable). */
  SHOP_GST_DUE_REMINDER: "shop.gst_due_reminder",
  /* >>> batch-2026-10 WS-A (payments, OTP, reference prices) — add entries below this line only */
  /** To the customer: an online payment was received (F1.7.3). */
  ORDER_PAYMENT_CAPTURED: "order.payment_captured",
  /** To the customer: an online payment failed; the order can be paid again. */
  ORDER_PAYMENT_FAILED: "order.payment_failed",
  /** To the customer: an online payment was not completed in time. */
  ORDER_PAYMENT_EXPIRED: "order.payment_expired",
  /** To the customer: money went back to the original payment method. */
  ORDER_PAYMENT_REFUNDED: "order.payment_refunded",
  /** To support: a payment needs a person (amount mismatch, late capture, stuck refund). */
  SUPPORT_PAYMENT_ATTENTION: "support.payment_attention",
  /* <<< end WS-A */
  //
  /* >>> batch-2026-10 WS-B (dispatch, QR pickup, navigation) — add entries below this line only */
  /** To a rider: an order nearby was broadcast to every rider in range — first to accept gets it (F3.3.2). */
  DELIVERY_BROADCAST_OFFERED: "delivery.broadcast_offered",
  /** To a rider who had a broadcast offer: another rider accepted it first. */
  DELIVERY_OFFER_TAKEN: "delivery.offer_taken",
  /** To the shop: no rider took the single offer, so it went to all riders nearby. */
  SHOP_RIDER_OFFER_BROADCAST: "shop.rider_offer_broadcast",
  /* <<< end WS-B */
  //
  /* >>> batch-2026-10 WS-C (cancellation fee, refunds, help desk) — add entries below this line only */
  /** To the customer: a refund was requested / is processing / succeeded / failed (email + push). */
  ORDER_REFUND_UPDATED: "order.refund_updated",
  /** To the shop owner: the customer cancelled a packed order; the after-packing fee kept for the shop. */
  SHOP_ORDER_CANCELLED_AFTER_PACKING: "shop.order_cancelled_after_packing",
  /** To the requester: their ticket was received (number + SLA). */
  TICKET_RECEIVED: "ticket.received",
  /** To the requester / assignee: the ticket's status changed. */
  TICKET_STATUS_CHANGED: "ticket.status_changed",
  /** To the other side of the conversation: a new public reply. */
  TICKET_REPLY: "ticket.reply",
  /** To the requester: the ticket is closed — rate the help you got. */
  TICKET_CSAT_REQUESTED: "ticket.csat_requested",
  /** To the shop owner: support needs the shop's input on a ticket about its order. */
  SHOP_TICKET_AWAITING: "shop.ticket_awaiting",
  /** To support (operators + admins): a new ticket. */
  SUPPORT_TICKET_NEW: "support.ticket_new",
  /** To the assignee: a ticket was assigned to them. */
  SUPPORT_TICKET_ASSIGNED: "support.ticket_assigned",
  /** To administrators (and the assignee): a ticket was escalated (manually or on an SLA breach). */
  SUPPORT_TICKET_ESCALATED: "support.ticket_escalated",
  /** To the assignee or support: the requester or shop replied. */
  SUPPORT_TICKET_REPLY: "support.ticket_reply",
  /* <<< end WS-C */
  //
  /* >>> batch-2026-10 WS-D (operator-limited, product master data) — add entries below this line only */
  /** To the owner: an operator registered your shop for you (after you confirmed the emailed code). */
  SHOP_ONBOARDED_BY_OPERATOR: "shop.onboarded_by_operator",
  /** To the owner (email): pay the registration fee with this link. */
  SHOP_REGISTRATION_FEE_LINK: "shop.registration_fee_link",
  /** To the owner and the onboarding operator: the registration fee was paid online. */
  SHOP_REGISTRATION_FEE_PAID: "shop.registration_fee_paid",
  /** To the onboarding operator: the fee did not go through — the shop waits for an administrator. */
  SHOP_REGISTRATION_FEE_FAILED: "shop.registration_fee_failed",
  /** To administrators: an operator-onboarded shop's fee failed or expired; it is pending their approval. */
  SUPPORT_SHOP_FEE_FAILED: "support.shop_registration_fee_failed",
  /** To whoever started it: a product-master import finished (counts, error file). */
  PMD_IMPORT_FINISHED: "product.master_import_finished",
  /* <<< end WS-D */
  //
  /* >>> batch-2026-10 WS-E (invoicing, payouts, statutory) — add entries below this line only */
  /** To the shop owner: a copy of the customer's invoice for an order (PDF attached by email). */
  SHOP_INVOICE_COPY: "shop.invoice_copy",
  /** To the shop owner: a payout was paid (UTR) — statement PDF/CSV attached by email. */
  SHOP_PAYOUT_PAID: "shop.payout_paid",
  /** To the shop owner: this cycle's payout is held (no verified bank account, below the minimum, nothing owed). */
  SHOP_PAYOUT_HELD: "shop.payout_held",
  /** To the shop owner: the bank transfer failed (it is retried / handled by finance). */
  SHOP_PAYOUT_FAILED: "shop.payout_failed",
  /** To the shop owner: GoKesari's tax invoice for its fees this cycle. */
  SHOP_PLATFORM_INVOICE: "shop.platform_invoice",
  /** To administrators: a payout batch was drafted and waits for approval. */
  SUPPORT_PAYOUT_BATCH_DRAFTED: "support.payout_batch_drafted",
  /** To administrators: a payout transfer failed for good (retries used up). */
  SUPPORT_PAYOUT_FAILED: "support.payout_failed",
  /* <<< end WS-E */
  //
  /* >>> batch-2026-10 WS-F (notifications, push, broadcasts, mobile) — add entries below this line only */
  /** F3.3.2: an announcement from GoKesari (admin / operator broadcast) — category ANNOUNCEMENTS. */
  BROADCAST: "broadcast.announcement",
  /** F3.3.2: to the admin / operator who sent it — a broadcast finished sending. */
  SUPPORT_BROADCAST_FINISHED: "support.broadcast_finished",
  /* <<< end WS-F */
  //
} as const;

export type NotificationType =
  (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];
