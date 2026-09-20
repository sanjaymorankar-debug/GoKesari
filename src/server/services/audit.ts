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
  SHOP_APPROVED: "shop.approved",
  SHOP_REJECTED: "shop.rejected",
  SHOP_SUSPENDED: "shop.suspended",
  SHOP_UPDATED: "shop.updated",
  SHOP_CLASSIFICATION_CHANGED: "shop.classification_changed",
  PRODUCT_PRICE_CHANGED: "shop_product.price_changed",
  PRODUCT_AVAILABILITY_CHANGED: "shop_product.availability_changed",
  PRODUCT_CREATED: "shop_product.created",
  CATEGORY_CREATED: "category.created",
  WALLET_ADJUSTED: "wallet.adjusted",
  WALLET_REFUNDED: "wallet.refunded",
  WALLET_TOPUP_VERIFIED: "wallet.topup_verified",
  USER_ROLE_CHANGED: "user.role_changed",
  USER_SUSPENDED: "user.suspended",
  ORDER_STATUS_CHANGED: "order.status_changed",
  ORDER_PLACED: "order.placed",
  SUBSCRIPTION_CREATED: "subscription.created",
  SUBSCRIPTION_MODIFIED: "subscription.modified",
  SUBSCRIPTION_PAUSED: "subscription.paused",
  SUBSCRIPTION_RESUMED: "subscription.resumed",
  SUBSCRIPTION_CANCELLED: "subscription.cancelled",
  SUBSCRIPTION_OVERRIDE_SET: "subscription.override_set",
  SUBSCRIPTION_ORDER_GENERATED: "subscription.order_generated",

  /* --------------------------------------------- price approval workflow (§19) */
  PRICE_REQUEST_SUBMITTED: "price_request.submitted",
  PRICE_REQUEST_APPROVED: "price_request.approved",
  PRICE_REQUEST_REJECTED: "price_request.rejected",
  PRICE_REQUEST_SUPERSEDED: "price_request.superseded",
  /** Admin forced a price live without owner approval — always noteworthy. */
  PRICE_REQUEST_OVERRIDDEN: "price_request.overridden",

  /* ----------------------------------------------------- excel uploads (§19) */
  EXCEL_UPLOADED: "excel_upload.uploaded",
  EXCEL_APPLIED: "excel_upload.applied",
  EXCEL_CANCELLED: "excel_upload.cancelled",

  /* ------------------------------------------ registration, fees, referrals */
  REGISTRATION_FEE_CHANGED: "registration_fee.changed",
  SHOP_REGISTRATION_UPDATED: "shop.registration_updated",
  SHOP_PAYMENT_RECORDED: "shop_payment.recorded",
  SHOP_PAYMENT_REVERSED: "shop_payment.reversed",
  REFERRAL_CODE_CREATED: "referral_code.created",
  REFERRAL_CODE_UPDATED: "referral_code.updated",
  REFERRAL_CODE_ASSIGNED: "referral_code.assigned",
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

  /* --------------------------------------------- seller/food compliance */
  SHOP_COMPLIANCE_UPDATED: "shop.compliance_updated",

  /* ------------------------------- product master & inventory thresholds */
  BRAND_CREATED: "brand.created",
  BRAND_UPDATED: "brand.updated",
  PRODUCT_MRP_CHANGED: "product.mrp_changed",
  /** A shop owner disputing the master MRP — the claim lives here, never in products.mrp_paise. */
  PRODUCT_MRP_CORRECTION_SUBMITTED: "product.mrp_correction_submitted",
  PRODUCT_IDENTITY_UPDATED: "product.identity_updated",
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

  /* --------------------------------------------- delivery partners (Part 58) */
  DELIVERY_PARTNER_REGISTERED: "delivery_partner.registered",
  DELIVERY_PARTNER_STATUS_CHANGED: "delivery_partner.status_changed",
  DELIVERY_PARTNER_ONLINE_STATUS_CHANGED: "delivery_partner.online_status_changed",

  /* ------------------------------------ delivery assignment (Part 58, Slice C) */
  DELIVERY_ORDER_OFFERED: "delivery_order.offered",
  DELIVERY_ORDER_ACCEPTED: "delivery_order.accepted",
  DELIVERY_ORDER_REJECTED: "delivery_order.rejected",
  DELIVERY_ORDER_PICKED_UP: "delivery_order.picked_up",
  DELIVERY_ORDER_DELIVERED: "delivery_order.delivered",
  DELIVERY_ORDER_CANCELLED: "delivery_order.cancelled",
  DELIVERY_EARNINGS_CONFIG_CHANGED: "delivery_earnings_config.changed",

  /* ------------------------------------ product master data platform */
  PMD_PRODUCT_PROMOTED: "pmd.product_promoted",
  PMD_PRODUCT_ADOPTED: "pmd.product_adopted",
  PMD_MATCH_DECIDED: "pmd.match_decided",
  PMD_PRODUCTS_IMPORTED: "pmd.products_imported",
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
