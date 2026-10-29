/**
 * Audit logging (requirement §46).
 *
 * Every sensitive mutation records who did what, to which entity, and the
 * before/after values. Audit writes must never break the operation they
 * describe, so failures are logged and swallowed — but they are always written
 * inside the caller's transaction when one is supplied, so a rolled-back
 * operation does not leave a phantom audit entry.
 */
import { db, type DbClient } from "@/server/db";
import { auditLogs, type UserRole } from "@/server/db/schema";

export const AUDIT_ACTIONS = {
  SHOP_REGISTERED: "shop.registered",
  /** docs/shop-onboarding-wizard-2026-10: a GSTIN / PAN checked in the onboarding wizard, before the shop exists. Masked numbers only. */
  SHOP_REGISTRATION_DRAFT_CHECKED: "shop_registration_draft.checked",
  /** docs/shop-onboarding-wizard-2026-10 step 2: the shop created from the wizard's draft, its checks copied. Masked numbers only. */
  SHOP_REGISTRATION_DRAFT_SUBMITTED: "shop_registration_draft.submitted",
  SHOP_APPROVED: "shop.approved",
  SHOP_REJECTED: "shop.rejected",
  SHOP_APPROVED_WITHOUT_DOCUMENTS: "shop.approved_without_documents",
  SHOP_DOCUMENTS_REMINDED: "shop.documents_reminded",
  SHOP_DOCUMENTS_PROMISED: "shop.documents_promised", // 0115: "I will provide all relevant documents within 30 days"
  SHOP_DOCUMENTS_FOLLOW_UP: "shop.documents_follow_up", // 0115: 1st / 15th reminder, or suspension after the last
  SHOP_REGISTRATION_FEE_WAIVED: "shop.registration_fee_waived",
  SHOP_SUSPENDED: "shop.suspended",
  SHOP_REACTIVATED: "shop.reactivated",
  SHOP_CLOSED: "shop.closed", // D-69: the owner closed the shop permanently
  SHOP_SUSPENSION_ORDER_RESOLVED: "shop.suspension_order_resolved",
  SHOP_UPDATED: "shop.updated",

  /* --------------------------- Module 1: shop product photos & descriptions */
  SHOP_PRODUCT_MEDIA_CHANGED: "shop_product.media_changed",
  SHOP_PRODUCT_DESCRIPTION_CHANGED: "shop_product.description_changed",
  SHOP_MEDIA_IMPORT_APPLIED: "shop_media_import.applied",
  SHOP_STAFF_ADDED: "shop_staff.added",
  SHOP_STAFF_REMOVED: "shop_staff.removed",

  /* ------------------------------ Module 2: accounting integration & GST */
  INTEGRATION_CONNECTED: "integration.connected",
  INTEGRATION_UPDATED: "integration.updated",
  INTEGRATION_DISCONNECTED: "integration.disconnected",
  INTEGRATION_TOKEN_ISSUED: "integration.token_issued",
  INTEGRATION_TOKEN_REVOKED: "integration.token_revoked",
  INTEGRATION_ITEM_MAPPED: "integration.item_mapped",
  INTEGRATION_JOB_RETRIED: "integration.job_retried",
  INTEGRATION_FILE_APPLIED: "integration.file_applied",
  INTEGRATION_EXPORTED: "integration.exported",
  CREDIT_NOTE_ISSUED: "credit_note.issued",
  EINVOICE_GENERATED: "einvoice.generated",
  EINVOICE_CANCELLED: "einvoice.cancelled",
  EWAY_BILL_GENERATED: "eway_bill.generated",
  GSTIN_LOOKED_UP: "gstin.looked_up",
  GST_RETURN_EXPORTED: "gst_return.exported",
  GST_CONFIG_CHANGED: "gst_config.changed",
  SHOP_EINVOICE_DECLARED: "shop.einvoice_declared",
  // Module 3: shop self-registration.
  SHOP_SELF_REGISTRATION_STARTED: "shop_registration.started",
  SHOP_SELF_REGISTERED: "shop.self_registered",
  SHOP_REGISTRATION_PAYMENT_MISMATCH: "shop_registration.payment_mismatch",
  SHOP_REGISTRATION_PAYMENT_FAILED: "shop_registration.payment_failed",
  SHOP_REGISTRATION_LINK_RESENT: "shop_registration.link_resent",
  SHOP_PROFILE_COMPLETED: "shop.profile_completed",
  REGISTRATION_FEE_TIER_CHANGED: "registration_fee_tier.changed",
  DISTRIBUTOR_TYPE_SAVED: "distributor_type.saved",
  DISTRIBUTOR_SAVED: "distributor.saved",
  REFERRAL_COMMISSION_STATUS_CHANGED: "referral_commission.status_changed",
  SHOP_CLASSIFICATION_CHANGED: "shop.classification_changed",
  /** A rejected registration submitted again — the same row goes back to PENDING_APPROVAL. */
  SHOP_RESUBMITTED: "shop.resubmitted",
  /** A registration or PAN refused because the shop is already registered (identifiers masked). */
  SHOP_DUPLICATE_BLOCKED: "shop.duplicate_blocked",
  PRODUCT_PRICE_CHANGED: "shop_product.price_changed",
  PRODUCT_AVAILABILITY_CHANGED: "shop_product.availability_changed",
  PRODUCT_CREATED: "shop_product.created",
  CATEGORY_CREATED: "category.created",
  WALLET_ADJUSTED: "wallet.adjusted",
  WALLET_REFUNDED: "wallet.refunded",
  WALLET_TOPUP_VERIFIED: "wallet.topup_verified",
  USER_ROLE_CHANGED: "user.role_changed",
  USER_SUSPENDED: "user.suspended",
  USER_REINSTATED: "user.reinstated",
  /** One explicit Save on the admin privileges screen: active role + grants together. */
  USER_PRIVILEGES_UPDATED: "user.privileges_updated",
  /** One explicit Save on the admin user profile screen. */
  USER_PROFILE_UPDATED: "user.profile_updated",
  ORDER_STATUS_CHANGED: "order.status_changed",
  ORDER_PLACED: "order.placed",
  SUBSCRIPTION_CREATED: "subscription.created",
  SUBSCRIPTION_MODIFIED: "subscription.modified",
  SUBSCRIPTION_PAUSED: "subscription.paused",
  SUBSCRIPTION_RESUMED: "subscription.resumed",
  SUBSCRIPTION_CANCELLED: "subscription.cancelled",
  SUBSCRIPTION_OVERRIDE_SET: "subscription.override_set",
  SUBSCRIPTION_ORDER_GENERATED: "subscription.order_generated",
  /** SM-004 */
  SUBSCRIPTION_ACTIVATED: "subscription.activated",
  SUBSCRIPTION_RENEWED: "subscription.renewed",
  /** NEW-007 */
  ORDER_AUTO_CANCELLED: "order.auto_cancelled_acceptance_timeout",
  /** Event layer: the accept-by time passed and support was alerted (shopAcceptance.onTimeout = ESCALATE). */
  ORDER_ACCEPT_ESCALATED: "order.accept_escalated",
  /** Event layer: no rider accepted within dispatch.alertSupportAfterMinutes; support alerted. */
  RIDER_SEARCH_SUPPORT_ALERTED: "delivery.rider_search_support_alerted",
  DISPUTE_COMMENTED: "dispute.commented",
  /** Event layer: a pending shop approved without a person, once its documents were verified. */
  SHOP_AUTO_APPROVED: "shop.auto_approved",
  DELIVERY_PROOF_UPLOADED: "delivery.proof_uploaded",
  INVOICE_ISSUED: "invoice.issued",

  /* --------------------------------------------- price approval workflow (§19) */
  PRICE_REQUEST_SUBMITTED: "price_request.submitted",
  PRICE_REQUEST_APPROVED: "price_request.approved",
  PRICE_REQUEST_REJECTED: "price_request.rejected",
  PRICE_REQUEST_SUPERSEDED: "price_request.superseded",
  /** Admin forced a price live without owner approval — always noteworthy. */
  PRICE_REQUEST_OVERRIDDEN: "price_request.overridden",

  /* ----------------------------------------------------- excel uploads (§19) */
  EXCEL_UPLOADED: "excel_upload.uploaded",
  /** Bulk product upload (docs/product-import-2026-10). */
  PRODUCT_IMPORT_UPLOADED: "product_import.uploaded",
  PRODUCT_IMPORT_COMMITTED: "product_import.committed",
  PRODUCT_IMPORT_COMPLETED: "product_import.completed",
  PRODUCT_IMPORT_CANCELLED: "product_import.cancelled",
  PRODUCT_IMPORT_REPORT_DOWNLOADED: "product_import.report_downloaded",
  EXCEL_APPLIED: "excel_upload.applied",
  EXCEL_CANCELLED: "excel_upload.cancelled",

  /* ------------------------------------------ registration, fees, referrals */
  REGISTRATION_FEE_CHANGED: "registration_fee.changed",
  REGISTRATION_FEE_COUPON_SAVED: "registration_fee_coupon.saved",
  SHOP_REGISTRATION_UPDATED: "shop.registration_updated",
  SHOP_PAYMENT_RECORDED: "shop_payment.recorded",
  SHOP_PAYMENT_REVERSED: "shop_payment.reversed",
  REFERRAL_CODE_CREATED: "referral_code.created",
  REFERRAL_CODE_UPDATED: "referral_code.updated",
  REFERRAL_CODE_ASSIGNED: "referral_code.assigned",
  CUSTOMER_REFERRAL_APPLIED: "customer_referral.applied",
  CUSTOMER_REFERRAL_DECIDED: "customer_referral.decided",
  CUSTOMER_REFERRAL_REVERSED: "customer_referral.reversed", // D-25: a fraudulent reward taken back
  CUSTOMER_REFERRAL_REFUSED: "customer_referral.refused", // someone tried their own code (risk rule REFERRAL_ABUSE)
  PRODUCT_REMOVED: "shop_product.removed",

  /* ---------------------------------------------- product creation & approval */
  GLOBAL_PRODUCT_CREATED: "product.created",
  PRODUCT_APPROVED: "product.approved",
  PRODUCT_REJECTED: "product.rejected",
  PRODUCT_UPLOAD_NEW: "excel_upload.product_created",

  /* ------------------------------------------------------------- vouchers */
  VOUCHER_CREATED: "voucher.created",
  VOUCHER_UPDATED: "voucher.updated",
  VOUCHER_ACTIVATED: "voucher.activated",
  VOUCHER_DEACTIVATED: "voucher.deactivated",
  VOUCHER_REDEEMED: "voucher.redeemed",
  VOUCHER_REJECTED: "voucher.rejected",
  VOUCHER_UPLOADED: "voucher_upload.uploaded",
  VOUCHER_UPLOAD_APPLIED: "voucher_upload.applied",

  /* ------------------------------------------------- grievance redressal */
  GRIEVANCE_SUBMITTED: "grievance.submitted",
  GRIEVANCE_UPDATED: "grievance.updated",
  GRIEVANCE_RESOLVED: "grievance.resolved",

  /* -------------------------------------------------------------- consent */
  CONSENT_RECORDED: "consent.recorded",
  /** Operations read one person's consent trail (NAV-019). Access to a
   *  consent record is itself worth a trail — see getUserConsentTrail(). */
  CONSENT_HISTORY_VIEWED: "consent.history_viewed",

  /* --------------------------------------------- seller/food compliance */
  SHOP_COMPLIANCE_UPDATED: "shop.compliance_updated",

  /* ------------------------------- product master & inventory thresholds */
  BRAND_CREATED: "brand.created",
  BRAND_UPDATED: "brand.updated",
  PRODUCT_MRP_CHANGED: "product.mrp_changed",
  /** A shop owner disputing the master MRP — the claim lives here, never in products.mrp_paise. */
  PRODUCT_MRP_CORRECTION_SUBMITTED: "product.mrp_correction_submitted",
  PRODUCT_IDENTITY_UPDATED: "product.identity_updated",
  /** An admin changed a master product's HSN code / GST rate (/admin/product-gst). */
  PRODUCT_GST_CHANGED: "product.gst_changed",
  STOCK_THRESHOLD_CHANGED: "shop_product.stock_threshold_changed",

  /* --------------------------------------------- GST/PAN verification */
  SHOP_GST_SUBMITTED: "shop.gst_submitted",
  SHOP_GST_VERIFIED: "shop.gst_verified",
  SHOP_GST_REJECTED: "shop.gst_rejected",
  SHOP_PAN_SUBMITTED: "shop.pan_submitted",
  SHOP_PAN_VERIFIED: "shop.pan_verified",
  SHOP_PAN_REJECTED: "shop.pan_rejected",
  /** Every full-PAN decrypt is audited — see revealPanForAdmin(). */
  SHOP_PAN_REVEALED: "shop.pan_revealed",

  /* --------------------------------------------- seller document verification */
  SELLER_DOCUMENT_APPROVED: "seller_document.approved",
  SELLER_DOCUMENT_REJECTED: "seller_document.rejected",
  SELLER_DOCUMENT_RECHECKED: "seller_document.rechecked",
  /** An admin opened an uploaded certificate — every view is recorded. */
  SELLER_DOCUMENT_FILE_VIEWED: "seller_document.file_viewed",
  /** All verification data for a closed shop erased (retention period over, or on request). Counts only. */
  SELLER_DOCUMENTS_ERASED: "seller_document.erased",
  /** docs/document-upload-2026-10: a document photo / file was read, and later confirmed by the owner. */
  SELLER_DOCUMENT_UPLOAD_READ: "seller_document.upload_read",
  SELLER_DOCUMENT_UPLOAD_CONFIRMED: "seller_document.upload_confirmed",

  /* --------------------------------------------- delivery partners (Part 58) */
  DELIVERY_PARTNER_REGISTERED: "delivery_partner.registered",
  DELIVERY_PARTNER_STATUS_CHANGED: "delivery_partner.status_changed",
  DELIVERY_PARTNER_ONLINE_STATUS_CHANGED: "delivery_partner.online_status_changed",
  /** F2: a rider edited their own profile (field names only — no values). */
  DELIVERY_PARTNER_PROFILE_UPDATED: "delivery_partner.profile_updated",
  DELIVERY_PARTNER_CHANGE_REQUESTED: "delivery_partner.change_requested",
  DELIVERY_PARTNER_CHANGE_DECIDED: "delivery_partner.change_decided",
  /** C5: a rider uploaded an identity document (type only — never the image). */
  DELIVERY_PARTNER_DOCUMENT_UPLOADED: "delivery_partner.document_uploaded",
  DELIVERY_PARTNER_DOCUMENT_DECIDED: "delivery_partner.document_decided",
  /** C5: an admin opened a rider's identity document. */
  DELIVERY_PARTNER_DOCUMENT_VIEWED: "delivery_partner.document_viewed",

  /* ------------------------------------ delivery assignment (Part 58, Slice C) */
  DELIVERY_ORDER_OFFERED: "delivery_order.offered",
  DELIVERY_ORDER_ACCEPTED: "delivery_order.accepted",
  DELIVERY_ORDER_REJECTED: "delivery_order.rejected",
  DELIVERY_ORDER_PICKED_UP: "delivery_order.picked_up",
  DELIVERY_ORDER_DELIVERED: "delivery_order.delivered",
  DELIVERY_ORDER_CANCELLED: "delivery_order.cancelled",
  DELIVERY_ORDER_OUT_FOR_DELIVERY: "delivery_order.out_for_delivery",
  DELIVERY_ORDER_FAILED: "delivery_order.failed",
  DELIVERY_OFFER_EXPIRED: "delivery_order.offer_expired",
  /** Delivered without the customer OTP — operator-confirmed with a proof note. */
  DELIVERY_CONFIRMED_BY_OPERATOR: "delivery_order.confirmed_by_operator",
  ORDER_ITEM_FULFILMENT_CHANGED: "order_item.fulfilment_changed",
  DELIVERY_ARRIVED_AT_SHOP: "delivery_order.arrived_at_shop",
  DELIVERY_ARRIVED_AT_CUSTOMER: "delivery_order.arrived_at_customer",
  RIDER_SEARCH_STOPPED: "delivery_order.search_stopped",
  /* ------------------------------------------------ finance (Slice 6) */
  COMMISSION_RATE_SET: "finance.commission_rate_set",
  ORDER_REFUNDED_AFTER_DELIVERY: "finance.order_refunded_after_delivery",
  FINANCIAL_ADJUSTMENT_RECORDED: "finance.adjustment_recorded",
  SETTLEMENT_PREPARED: "finance.settlement_prepared",
  SETTLEMENT_STATUS_CHANGED: "finance.settlement_status_changed",
  RIDER_PAYOUT_PREPARED: "finance.rider_payout_prepared",
  RIDER_PAYOUT_STATUS_CHANGED: "finance.rider_payout_status_changed",
  RECONCILIATION_RUN: "finance.reconciliation_run",
  /* ----------------------------- shop wallet (docs/shop-wallet-delivery-otp-2026-10) */
  SHOP_WALLET_TOPUP_VERIFIED: "shop_wallet.topup_verified",
  SHOP_WALLET_ORDER_CHARGED: "shop_wallet.order_charged",
  SHOP_WALLET_ADJUSTED: "shop_wallet.adjusted",
  /* ----------------------------------------------------- delivery code */
  DELIVERY_CODE_SENT: "delivery_order.code_sent",
  DELIVERY_CODE_WRONG: "delivery_order.code_wrong",
  DELIVERY_CODE_LOCKED: "delivery_order.code_locked",
  RECONCILIATION_RESOLVED: "finance.reconciliation_resolved",
  /* ------------------------------------------ society / ratings / subscriptions (Phase 2) */
  SOCIETY_REGISTERED: "society.registered",
  SOCIETY_STATUS_CHANGED: "society.status_changed",
  SOCIETY_UPDATED: "society.updated",
  SOCIETY_MEMBER_CHANGED: "society.member_changed",
  SOCIETY_RIDER_CHANGED: "society.rider_changed",
  SOCIETY_SHOP_CHANGED: "society.shop_changed",
  RATING_CREATED: "rating.created",
  RATING_MODERATED: "rating.moderated",
  // Phase 3
  ROLE_GRANTED: "user.role_granted",
  ROLE_REVOKED: "user.role_revoked",
  ROLE_SWITCHED: "user.role_switched",
  COD_CASH_COLLECTED: "cod.cash_collected",
  COD_CASH_DEPOSITED: "cod.cash_deposited",
  SHOP_COD_SETTING_CHANGED: "shop.cod_setting_changed",
  SEGMENT_SAVED: "marketing.segment_saved",
  SEGMENT_DELETED: "marketing.segment_deleted",
  CAMPAIGN_SAVED: "marketing.campaign_saved",
  CAMPAIGN_STATUS_CHANGED: "marketing.campaign_status_changed",
  CAMPAIGN_SENT: "marketing.campaign_sent",
  RISK_RULES_RUN: "risk.rules_run",
  RISK_FLAG_REVIEWED: "risk.flag_reviewed",
  DELIVERY_EARNINGS_CONFIG_CHANGED: "delivery_earnings_config.changed",
  NOTIFICATION_DELIVERY_DEAD: "notification.delivery_dead",
  NOTIFICATION_DELIVERY_REQUEUED: "notification.delivery_requeued",
  NOTIFICATION_PREFERENCE_CHANGED: "notification.preference_changed",
  PRICE_REFERENCE_SAVED: "price_reference.saved",
  PRICE_REFERENCE_VERIFIED: "price_reference.verified",
  PRICE_REFERENCE_REJECTED: "price_reference.rejected",
  MRP_CORRECTION_DECIDED: "product.mrp_correction_decided",
  MRP_CONFLICT_DETECTED: "product.mrp_conflict_detected",
  PRODUCT_IMAGE_CHANGED: "product_image.changed",
  PRODUCT_IMAGE_MODERATED: "product_image.moderated",
  SHOP_CATEGORY_SAVED: "shop_category.saved",
  SHOP_TYPE_SAVED: "shop_type.saved",
  SHOP_CATEGORIES_CHANGED: "shop.categories_changed",
  /* Category master and shop ↔ product-category links. */
  PRODUCT_CATEGORY_CREATED: "product_category.created",
  PRODUCT_CATEGORY_UPDATED: "product_category.updated",
  /** Soft delete; its products moved to General and its shop links removed (counts in newValue). */
  PRODUCT_CATEGORY_REMOVED: "product_category.removed",
  SHOP_PRODUCT_CATEGORY_ADDED: "shop.product_category_added",
  SHOP_PRODUCT_CATEGORY_REMOVED: "shop.product_category_removed",
  /** A product moved between categories (edit form or the one-time categorisation). */
  PRODUCT_CATEGORY_CHANGED: "product.category_changed",
  RETURN_REQUESTED: "return.requested",
  RETURN_STATUS_CHANGED: "return.status_changed",
  RETURN_PICKUP_OFFERED: "return_pickup.offered",
  RETURN_PICKUP_UPDATED: "return_pickup.updated",
  RETURN_REFUND_ISSUED: "return.refund_issued",

  /* ---------------------------------------------------- disputes (GS-058) */
  DISPUTE_OPENED: "dispute.opened",
  DISPUTE_STATUS_CHANGED: "dispute.status_changed",
  /** Separate from the status change so an automatic escalation is findable on its own. */
  DISPUTE_ESCALATED: "dispute.escalated",
  DISPUTE_RESOLVED: "dispute.resolved",
  IMAGE_UPLOADED: "image.uploaded",
  RIDER_EARNING_SLOT_SAVED: "rider_earning_slot.saved",
  RIDER_INCENTIVE_SAVED: "rider_incentive.saved",

  /* ------------------------------------ product master data platform */
  PMD_PRODUCT_PROMOTED: "pmd.product_promoted",
  PMD_PRODUCT_ADOPTED: "pmd.product_adopted",
  PMD_MATCH_DECIDED: "pmd.match_decided",
  PMD_PRODUCTS_IMPORTED: "pmd.products_imported",

  /* ------------------------------------------------ promotions (F7, F8) */
  COUPON_SAVED: "coupon.saved",
  SHOP_OFFER_SAVED: "shop.offer_saved",

  /* ------------------------------------------- platform rules & auth */
  SETTING_CHANGED: "setting.changed",
  OTP_REQUESTED: "auth.otp_requested",
  OTP_VERIFIED: "auth.otp_verified",
  OTP_FAILED: "auth.otp_failed",
  OTP_BLOCKED: "auth.otp_blocked",
  PHONE_LINKED: "auth.phone_linked",
  PHONE_RELEASED: "auth.phone_released",
  EMAIL_CHANGED: "auth.email_changed",
  SIGNED_OUT: "auth.signed_out", // QA TC-AUTH-045: Sign out, recorded like a sign-in (auth.otp_verified)
  PROFILE_UPDATED: "user.profile_updated",
  /* ------------------------------------------------- docs/four-features-2026-10 */
  ORDER_FULFILMENT_SET: "order.fulfilment_set",
  ORDER_FULFILMENT_CHANGED: "order.fulfilment_changed",
  ORDER_FULFILMENT_COMPLETED: "order.fulfilment_completed",
  ORDER_FULFILMENT_CODE_WRONG: "order.fulfilment_code_wrong",
  ORDER_FULFILMENT_CODE_LOCKED: "order.fulfilment_code_locked",
  ORDER_FULFILMENT_CODE_SENT: "order.fulfilment_code_sent",
  ORDER_DELIVERY_FEE_REFUNDED: "order.delivery_fee_refunded",
  SHOP_DELIVERY_STAFF_SAVED: "shop.delivery_staff_saved",
  SHOP_LEGAL_DOCUMENT_SUBMITTED: "shop.legal_document_submitted",
  SHOP_LEGAL_DOCUMENT_DECIDED: "shop.legal_document_decided",
  SHOP_LEGAL_DOCUMENT_FILE_VIEWED: "shop.legal_document_file_viewed",
  BANK_ACCOUNT_SAVED: "bank_account.saved",
  BANK_ACCOUNT_VERIFIED: "bank_account.verified",
  BANK_ACCOUNT_VERIFICATION_FAILED: "bank_account.verification_failed",
  BANK_ACCOUNT_REFUND: "bank_account.verification_refund",
  BANK_ACCOUNT_CHECKED: "bank_account.checked",
  BANK_REFUND_REQUESTED: "bank_refund.requested",
  BANK_REFUND_DECIDED: "bank_refund.decided",
  BANK_REFUND_DETAILS_VIEWED: "bank_refund.details_viewed",
  REFERRAL_REQUEST_CREATED: "referral_request.created",
  REFERRAL_REQUEST_DECIDED: "referral_request.decided",
  CUSTOMER_SIGNUP_REFERRAL: "customer.signup_referral",
  CUSTOMER_REFERRAL_REQUEST_CREATED: "customer_referral_request.created",
  CUSTOMER_REFERRAL_REQUEST_DECIDED: "customer_referral_request.decided",
  REFERRAL_SETTING_CHANGED: "referral_setting.changed",
  FEATURE_FLAG_CHANGED: "feature_flag.changed", // docs/dealer-programme
  GEO_AREA_SAVED: "geo_area.saved", // docs/dealer-programme
  DEALER_APPLICATION_SAVED: "dealer.application_saved", // docs/dealer-programme
  DEALER_APPLICATION_SUBMITTED: "dealer.application_submitted", // docs/dealer-programme
  DEALER_STATUS_CHANGED: "dealer.status_changed", // docs/dealer-programme
  DEALER_CREATED_BY_ADMIN: "dealer.created_by_admin", // docs/dealer-programme, all-India
  DEALER_DOCUMENT_UPLOADED: "dealer.document_uploaded", // docs/dealer-programme
  DEALER_DOCUMENT_REVIEWED: "dealer.document_reviewed", // docs/dealer-programme
  DEALER_DOCUMENT_VIEWED: "dealer.document_viewed", // docs/dealer-programme
  DEALER_DOC_REQUIREMENT_CHANGED: "dealer.document_requirement_changed", // docs/dealer-programme
  DEALER_PAN_REVEALED: "dealer.pan_revealed", // docs/dealer-programme
  DEALER_BANK_REVEALED: "dealer.bank_revealed", // docs/dealer-programme
  DEALER_BANK_CHECKED: "dealer.bank_checked", // docs/dealer-programme
  DEALER_CODE_ISSUED: "dealer.code_issued", // docs/dealer-programme
  DEALER_CODE_STATUS_CHANGED: "dealer.code_status_changed", // docs/dealer-programme
  DEALER_CODE_REPLACED: "dealer.code_replaced", // docs/dealer-programme
  DEALER_SALESPERSON_SAVED: "dealer.salesperson_saved", // docs/dealer-programme
  DEALER_ATTRIBUTION_RECORDED: "dealer.attribution_recorded", // docs/dealer-programme
  DEALER_ATTRIBUTION_CHANGED: "dealer.attribution_changed", // docs/dealer-programme
  DEALER_LEAD_SAVED: "dealer.lead_saved", // docs/dealer-programme
  DEALER_ASSISTED_STEP: "dealer.assisted_registration", // docs/dealer-programme
  DEALER_DISPUTE_SAVED: "dealer.dispute_saved", // docs/dealer-programme
  DEALER_COMMISSION_SETTINGS_CHANGED: "dealer.commission_settings_changed", // docs/dealer-programme
  DEALER_COMMISSION_RULE_CHANGED: "dealer.commission_rule_changed", // docs/dealer-programme
  DEALER_COMMISSION_RATES_CHANGED: "dealer.commission_rates_changed", // one dealer's base % and rating step (0116)
  DEALER_COMMISSION_ACCRUED: "dealer.commission_accrued", // docs/dealer-programme
  DEALER_COMMISSION_REVERSED: "dealer.commission_reversed", // docs/dealer-programme
  DEALER_COMMISSION_APPROVED: "dealer.commission_approved", // docs/dealer-programme
  DEALER_COMMISSION_CAP_OVERRIDE: "dealer.commission_cap_override", // docs/dealer-programme
  DEALER_COMMISSION_HOLD: "dealer.commission_hold", // docs/dealer-programme
  DEALER_PAYOUT_SAVED: "dealer.payout_saved", // docs/dealer-programme
  DEALER_RATING_SLAB_CHANGED: "dealer.rating_slab_changed", // docs/dealer-programme
  DEALER_RATING_CHANGED: "dealer.rating_changed", // docs/dealer-programme
  SUPPORT_SERVICE_REQUESTED: "support_service.requested", // docs/dealer-programme
  SUPPORT_SERVICE_PAID: "support_service.paid", // docs/dealer-programme
  SUPPORT_SERVICE_CANCELLED: "support_service.cancelled", // docs/dealer-programme
  SUPPORT_SERVICE_REFUNDED: "support_service.refunded", // docs/dealer-programme
  SUPPORT_SERVICE_CHARGE_CHANGED: "support_service.charge_changed", // docs/dealer-programme
  GEO_AREA_TARGET_SET: "geo_area.target_set", // docs/dealer-programme step 8
  DELIVERY_OFFER_BROADCAST: "delivery_order.offer_broadcast", // batch-2026-10 WS-B
  DELIVERY_BROADCAST_ACCEPTED: "delivery_order.broadcast_accepted", // batch-2026-10 WS-B
  DELIVERY_BROADCAST_CLOSED: "delivery_order.broadcast_closed", // batch-2026-10 WS-B
  DELIVERY_PICKUP_QR_SCANNED: "delivery_order.pickup_qr_scanned", // batch-2026-10 WS-B
  PAYOUT_CYCLE_CLOSED: "payout.cycle_closed", // batch-2026-10 WS-E
  PAYOUT_BATCH_STATUS_CHANGED: "payout.batch_status_changed", // batch-2026-10 WS-E
  PAYOUT_BANK_FILE_EXPORTED: "payout.bank_file_exported", // batch-2026-10 WS-E
  PAYOUT_ITEM_STATUS_CHANGED: "payout.item_status_changed", // batch-2026-10 WS-E
  PLATFORM_INVOICE_ISSUED: "platform_invoice.issued", // batch-2026-10 WS-E
  PLATFORM_NOTE_ISSUED: "platform_invoice.note_issued", // batch-2026-10 WS-E
  STATUTORY_RATE_CHANGED: "statutory_rate.changed", // batch-2026-10 WS-E
  STATUTORY_REPORT_EXPORTED: "statutory.report_exported", // batch-2026-10 WS-E
  // batch-2026-10 WS-D — Operator-Limited onboarding (F8.4.2): every action is audited.
  OPLTD_OWNER_OTP_SENT: "operator_limited.owner_otp_sent",
  OPLTD_OWNER_VERIFIED: "operator_limited.owner_verified",
  OPLTD_OWNER_OTP_FAILED: "operator_limited.owner_otp_failed",
  OPLTD_SHOP_SUBMITTED: "operator_limited.shop_submitted",
  OPLTD_SHOPS_VIEWED: "operator_limited.shops_viewed",
  OPLTD_DOCUMENTS_VIEWED: "operator_limited.documents_viewed",
  OPLTD_DOCUMENT_DECIDED: "operator_limited.document_decided",
  OPLTD_ACCESS_DENIED: "operator_limited.access_denied",
  OPLTD_FEE_REQUESTED: "operator_limited.fee_requested",
  OPLTD_FEE_PAID: "operator_limited.fee_paid",
  OPLTD_FEE_FAILED: "operator_limited.fee_failed",
  // batch-2026-10 WS-D — product master data (F9.1.2 / F9.1.4).
  PMD_MANUFACTURER_CREATED: "pmd.manufacturer_created",
  PMD_MANUFACTURER_MEMBER_ADDED: "pmd.manufacturer_member_added",
  PMD_API_KEY_ISSUED: "pmd.api_key_issued",
  PMD_API_KEY_REVOKED: "pmd.api_key_revoked",
  PMD_API_KEY_USED: "pmd.api_key_used",
  PMD_INGEST_JOB_CREATED: "pmd.ingest_job_created",
  PMD_INGEST_JOB_FINISHED: "pmd.ingest_job_finished",
  PMD_SOURCE_LOOKUP: "pmd.source_lookup",
  PMD_BULK_EDITED: "pmd.bulk_edited",
  PMD_PRODUCTS_MERGED: "pmd.products_merged",
  PMD_PRODUCTS_PROMOTED: "pmd.products_promoted",
  INVENTORY_SYNC_BLOCKED: "inventory_sync.blocked",
  BROADCAST_SAVED: "broadcast.saved", // batch-2026-10 WS-F
  BROADCAST_SCHEDULED: "broadcast.scheduled", // batch-2026-10 WS-F
  BROADCAST_SEND_STARTED: "broadcast.send_started", // batch-2026-10 WS-F
  BROADCAST_SENT: "broadcast.sent", // batch-2026-10 WS-F
  BROADCAST_CANCELLED: "broadcast.cancelled", // batch-2026-10 WS-F
  BROADCAST_EXPIRED: "broadcast.expired", // batch-2026-10 WS-F
  HOME_BANNER_SAVED: "home_banner.saved", // docs/homepage-uiux-2026-10
  HOME_BANNER_DELETED: "home_banner.deleted", // docs/homepage-uiux-2026-10
  PUSH_TOKEN_DEACTIVATED: "push_token.deactivated", // batch-2026-10 WS-F
  SHOP_CANCELLATION_FEE_CHANGED: "shop.cancellation_fee_changed", // batch-2026-10 WS-C
  ORDER_CANCELLATION_FEE_CHARGED: "order.cancellation_fee_charged", // batch-2026-10 WS-C
  ORDER_REFUND_RECORDED: "order.refund_recorded", // batch-2026-10 WS-C
  SUPPORT_TICKET_CREATED: "support_ticket.created", // batch-2026-10 WS-C
  SUPPORT_TICKET_UPDATED: "support_ticket.updated", // batch-2026-10 WS-C
  SUPPORT_CANNED_REPLY_CHANGED: "support_canned_reply.changed", // batch-2026-10 WS-C
  PAYMENT_INTENT_CREATED: "payment.intent_created", // batch-2026-10 WS-A
  PAYMENT_INTENT_STATUS_CHANGED: "payment.intent_status_changed", // batch-2026-10 WS-A
  PAYMENT_WEBHOOK_REJECTED: "payment.webhook_rejected", // batch-2026-10 WS-A
  PAYMENT_REFUND_REQUESTED: "payment.refund_requested", // batch-2026-10 WS-A
  PAYMENT_REFUND_SETTLED: "payment.refund_settled", // batch-2026-10 WS-A
  OTP_PURGED: "auth.otp_purged", // batch-2026-10 WS-A
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: UserRole | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * @param client Pass the surrounding transaction so the audit row commits or
 *               rolls back atomically with the change it records.
 */
export async function recordAudit(
  entry: AuditEntry,
  client: DbClient = db,
): Promise<void> {
  try {
    await client.insert(auditLogs).values({
      actorId: entry.actorId ?? null,
      actorRole: entry.actorRole ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      previousValue: (entry.previousValue ?? null) as never,
      newValue: (entry.newValue ?? null) as never,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
    });
  } catch (error) {
    // Never let observability break the business operation.
    console.error("[audit] failed to record entry", entry.action, error);
  }
}
