/**
 * Capability matrix (requirement §4, §42, §43).
 *
 * Authorization is decided here and nowhere else. Route handlers call `can()` or
 * `requirePermission()`; UI may *also* hide controls, but hiding is cosmetic —
 * the server check is the real boundary.
 *
 * Two distinct questions are always asked separately:
 *   1. Capability — may this ROLE ever perform this action?  (this file)
 *   2. Ownership  — does this specific row belong to this user? (guards.ts)
 * Both must pass.
 */
import type { UserRole } from "@/server/db/schema";

export const PERMISSIONS = {
  // Shops
  SHOP_CREATE: "shop:create",
  SHOP_UPDATE_OWN: "shop:update:own",
  SHOP_UPDATE_ANY: "shop:update:any",
  SHOP_APPROVE: "shop:approve",
  SHOP_REJECT: "shop:reject",
  SHOP_SUSPEND: "shop:suspend",
  /** Kesari/Green. Deliberately NOT granted to SHOP_OWNER (§10). */
  SHOP_SET_CLASSIFICATION: "shop:set-classification",

  // Catalogue
  CATEGORY_MANAGE: "category:manage",
  PRODUCT_MANAGE: "product:manage",
  SHOP_PRODUCT_MANAGE_OWN: "shop-product:manage:own",
  SHOP_PRODUCT_MANAGE_ANY: "shop-product:manage:any",
  /** Create a brand-new master product and attach it to the actor's own shop. */
  PRODUCT_CREATE_OWN: "product:create:own",
  /** Create a brand-new master product and attach it to any shop. */
  PRODUCT_CREATE_ANY: "product:create:any",
  /**
   * Publish a shop-owner-created product to the central catalogue (or reject
   * it). Deliberately ADMIN-only, separate from PRODUCT_MANAGE — an operator
   * may create products but not decide what other shops get to discover.
   */
  PRODUCT_APPROVE: "product:approve",

  // Orders
  ORDER_PLACE: "order:place",
  /** Place a B2B order on behalf of an approved shop the user owns. */
  ORDER_PLACE_B2B: "order:place:b2b",
  ORDER_VIEW_OWN: "order:view:own",
  ORDER_VIEW_SHOP: "order:view:shop",
  ORDER_VIEW_ANY: "order:view:any",
  ORDER_UPDATE_STATUS_SHOP: "order:update-status:shop",
  ORDER_UPDATE_STATUS_ANY: "order:update-status:any",
  ORDER_CANCEL_OWN: "order:cancel:own",

  // Wallet
  WALLET_VIEW_OWN: "wallet:view:own",
  WALLET_TOPUP_OWN: "wallet:topup:own",
  WALLET_VIEW_ANY: "wallet:view:any",
  /** Manual credit/debit — admin only; every use is audit-logged. */
  WALLET_ADJUST: "wallet:adjust",
  WALLET_REFUND: "wallet:refund",

  // Subscriptions
  SUBSCRIPTION_MANAGE_OWN: "subscription:manage:own",
  SUBSCRIPTION_VIEW_SHOP: "subscription:view:shop",
  SUBSCRIPTION_MANAGE_ANY: "subscription:manage:any",

  // Users & system
  USER_VIEW_ANY: "user:view:any",
  USER_SET_ROLE: "user:set-role",
  USER_SUSPEND: "user:suspend",
  SYSTEM_CONFIG: "system:config",
  AUDIT_LOG_VIEW: "audit-log:view",

  // Reports
  REPORT_VIEW_SHOP: "report:view:shop",
  REPORT_VIEW_OPERATIONAL: "report:view:operational",
  REPORT_VIEW_ALL: "report:view:all",

  /* ------------------------------------------- price approval workflow (§10) */
  /** Propose a price change for a shop the actor does not own. */
  PRICE_REQUEST_SUBMIT: "price-request:submit",
  /** Decide requests raised against the actor's OWN shop — the owner's veto. */
  PRICE_REQUEST_DECIDE_OWN: "price-request:decide:own",
  /**
   * Decide requests for any shop. Deliberately NOT granted to OPERATOR: an
   * operator must never approve the change they themselves proposed (§17).
   */
  PRICE_REQUEST_DECIDE_ANY: "price-request:decide:any",
  /** Force a price live, bypassing owner approval. ADMIN only; always audited. */
  PRICE_REQUEST_OVERRIDE: "price-request:override",

  /* ------------------------------------------------------ excel uploads (§6) */
  EXCEL_UPLOAD_OWN: "excel-upload:own",
  EXCEL_UPLOAD_ANY: "excel-upload:any",

  /* ------------------------------------- registration, fees & payments (§12) */
  /** Change the registration fee schedule. ADMIN only. */
  REGISTRATION_FEE_MANAGE: "registration-fee:manage",
  /** Set a shop's registration details, fee and status. OPERATOR/ADMIN. */
  SHOP_REGISTRATION_MANAGE: "shop-registration:manage",
  PAYMENT_VIEW_OWN: "payment:view:own",
  PAYMENT_VIEW_ANY: "payment:view:any",
  /** Record a received payment, or a reversal/refund. */
  PAYMENT_RECORD: "payment:record",

  /* --------------------------------------------------- referral codes (§4.3) */
  REFERRAL_MANAGE: "referral:manage",

  /** Audit visibility scoped to the actor's operational surface (§17 "Limited"). */
  AUDIT_LOG_VIEW_LIMITED: "audit-log:view:limited",

  /* --------------------------------------------- vouchers (wallet brief §37) */
  /** Create/edit a voucher, set its percentage, activate/deactivate it. ADMIN only. */
  VOUCHER_MANAGE: "voucher:manage",
  /** Upload a voucher list. Distinct from VOUCHER_MANAGE — an operator may
   *  upload but never hand-set a promotional percentage themselves (§37). */
  VOUCHER_UPLOAD: "voucher:upload",
  /** View vouchers, redemptions and promotional-liability figures. */
  VOUCHER_VIEW: "voucher:view",

  /* ----------------------------------------- grievance redressal (Part 58) */
  /** View, assign and resolve grievances (IT Rules 2021 Rule 3(2)). */
  GRIEVANCE_MANAGE: "grievance:manage",

  /* ---------------------------------- seller/food compliance (Part 58) */
  /** Set a shop's legal name, GSTIN, FSSAI number, return-policy override. */
  SHOP_COMPLIANCE_MANAGE: "shop-compliance:manage",

  /** View the admin compliance dashboard (checklist + policy status). */
  COMPLIANCE_DASHBOARD_VIEW: "compliance-dashboard:view",

  /* --------------------------------------------- delivery system (Part 58) */
  /** View Google Maps Platform SKU usage (admin-only — cost-sensitive). */
  MAPS_USAGE_VIEW: "maps-usage:view",

  /** Any customer may apply to become a delivery partner. */
  DELIVERY_PARTNER_REGISTER: "delivery-partner:register",
  /** View/edit one's own delivery-partner profile and application status. */
  DELIVERY_PARTNER_VIEW_OWN: "delivery-partner:view:own",
  /** Admin/operator: review queue, approve/reject/suspend/reactivate/deactivate. */
  DELIVERY_PARTNER_MANAGE: "delivery-partner:manage",

  /** A delivery partner acting on their own offer/active delivery: accept, reject, pickup, deliver, go online/offline. */
  DELIVERY_ORDER_MANAGE_OWN: "delivery-order:manage:own",
  /** A shop owner triggering assignment for their own shop's READY order. */
  DELIVERY_ORDER_ASSIGN_SHOP: "delivery-order:assign:shop",
  /** Operator/admin: trigger assignment for any order, manually reassign. */
  DELIVERY_ORDER_MANAGE_ANY: "delivery-order:manage:any",
  /** Set the base/per-km delivery earnings rate. ADMIN only. */
  DELIVERY_EARNINGS_CONFIG_MANAGE: "delivery-earnings-config:manage",

  /** Submit/update own shop's GSTIN and PAN for verification. */
  SHOP_GST_PAN_MANAGE_OWN: "shop-gst-pan:manage:own",
  /** Admin/operator: confirm or reject a submitted GSTIN/PAN by hand (no automated provider configured). */
  SHOP_GST_PAN_VERIFY: "shop-gst-pan:verify",
  /** Decrypt and view a shop's full PAN number. ADMIN only — every use is audited. */
  SHOP_PAN_REVEAL: "shop-pan:reveal",

  /* ------------------------------- product master & inventory thresholds */
  /** Create and edit brands. Shared across every shop, so never shop-owner-editable. */
  BRAND_MANAGE: "brand:manage",
  /** Edit master identity: GTIN, HSN, manufacturer, pack size, subcategory. */
  PRODUCT_IDENTITY_MANAGE: "product-identity:manage",
  /** Write the master MRP directly (§13). Deliberately absent from SHOP_OWNER. */
  PRODUCT_MRP_MANAGE: "product-mrp:manage",
  /** Flag a master MRP as wrong — raises a verification request, never overwrites. */
  PRODUCT_MRP_DISPUTE: "product-mrp:dispute",
  /** Set low-stock threshold, reorder level and order limits on own shop's lines. */
  INVENTORY_THRESHOLD_MANAGE_OWN: "inventory-threshold:manage:own",

  /* -------------------- product master data platform (pmd schema) */
  /** Browse and search the universal product master, offers, price history and data quality. Staff only. */
  PMD_VIEW: "pmd:view",
  /** Resolve the possible-duplicate review queue and merge products. */
  PMD_REVIEW: "pmd:review",
  /** Promote a master product into the live marketplace catalogue (public.products). */
  PMD_PROMOTE: "pmd:promote",
  /** Bulk-import product records into the master. ADMIN only - it writes to the master. */
  PMD_IMPORT: "pmd:import",

  /* ----------------------------------------------- finance (Slice 6) */
  /** Global finance: GMV, commission, settlements, payouts, ledger, full reconciliation. Admin only. */
  FINANCE_VIEW: "finance:view",
  /** Commission rates; approve / process / mark settlements and payouts paid; adjustments. Admin only. */
  FINANCE_MANAGE: "finance:manage",
  /** Prepare weekly settlement and payout batches. Admin only (the weekly cron also prepares). */
  FINANCE_PREPARE: "finance:prepare",
  /**
   * Operational financial exceptions only (Part K): failed/pending payments,
   * refunds pending, order/payment mismatches, missing rider earnings,
   * delivery adjustments — never settlement or payout totals. Operator + admin.
   */
  FINANCE_EXCEPTIONS_VIEW: "finance:exceptions:view",
  /** Refund a delivered order (full or partial) to the customer's wallet. Operator + admin (RBAC-011). */
  ORDER_REFUND: "order:refund",
  /** A shop owner's own settlement statements and per-order payable. */
  SETTLEMENT_VIEW_OWN: "settlement:view:own",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const CUSTOMER_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.SHOP_CREATE, // any customer may apply to register a shop
  PERMISSIONS.ORDER_PLACE,
  PERMISSIONS.ORDER_VIEW_OWN,
  PERMISSIONS.ORDER_CANCEL_OWN,
  PERMISSIONS.WALLET_VIEW_OWN,
  PERMISSIONS.WALLET_TOPUP_OWN,
  PERMISSIONS.SUBSCRIPTION_MANAGE_OWN,
  PERMISSIONS.DELIVERY_PARTNER_REGISTER, // any customer may apply to become a delivery partner
];

/**
 * A user who registers as a delivery partner keeps their ability to shop
 * (same as SHOP_OWNER keeps customer capabilities) and gains visibility into
 * their own application/profile — nothing operational (going online,
 * accepting deliveries) exists yet; that's Slice C.
 */
const DELIVERY_PARTNER_PERMISSIONS: readonly Permission[] = [
  ...CUSTOMER_PERMISSIONS,
  PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN,
  PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN,
];

const SHOP_OWNER_PERMISSIONS: readonly Permission[] = [
  ...CUSTOMER_PERMISSIONS,
  PERMISSIONS.SHOP_UPDATE_OWN,
  // Buying for the shop's business is a separate flow from personal orders.
  PERMISSIONS.ORDER_PLACE_B2B,
  PERMISSIONS.SHOP_PRODUCT_MANAGE_OWN,
  PERMISSIONS.PRODUCT_CREATE_OWN,
  PERMISSIONS.ORDER_VIEW_SHOP,
  PERMISSIONS.ORDER_UPDATE_STATUS_SHOP,
  PERMISSIONS.SUBSCRIPTION_VIEW_SHOP,
  PERMISSIONS.REPORT_VIEW_SHOP,
  // The owner's veto over operator-proposed prices (§2.4).
  PERMISSIONS.PRICE_REQUEST_DECIDE_OWN,
  PERMISSIONS.EXCEL_UPLOAD_OWN,
  PERMISSIONS.PAYMENT_VIEW_OWN,
  PERMISSIONS.DELIVERY_ORDER_ASSIGN_SHOP,
  PERMISSIONS.SHOP_GST_PAN_MANAGE_OWN,
  PERMISSIONS.INVENTORY_THRESHOLD_MANAGE_OWN,
  // A shop owner may dispute a master MRP but never write it (§13).
  PERMISSIONS.PRODUCT_MRP_DISPUTE,
  PERMISSIONS.SETTLEMENT_VIEW_OWN,
  // Deliberately absent: SHOP_SET_CLASSIFICATION, CATEGORY_MANAGE,
  // SHOP_UPDATE_ANY, SYSTEM_CONFIG, REGISTRATION_FEE_MANAGE,
  // SHOP_REGISTRATION_MANAGE, PAYMENT_RECORD, REFERRAL_MANAGE, PRODUCT_APPROVE
  // — every one of these is an administrative field the owner may read but
  // never write (§2.5). A product the owner creates is usable in their own
  // shop immediately; PRODUCT_APPROVE only controls whether OTHER shops can
  // discover it, which is deliberately not the owner's call.
];

const OPERATOR_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.SHOP_CREATE,
  PERMISSIONS.ORDER_PLACE,
  PERMISSIONS.ORDER_VIEW_OWN,
  PERMISSIONS.ORDER_CANCEL_OWN,
  PERMISSIONS.WALLET_VIEW_OWN,
  PERMISSIONS.WALLET_TOPUP_OWN,
  PERMISSIONS.SUBSCRIPTION_MANAGE_OWN,

  PERMISSIONS.SHOP_UPDATE_ANY,
  PERMISSIONS.SHOP_APPROVE,
  PERMISSIONS.SHOP_REJECT,
  PERMISSIONS.SHOP_SUSPEND,
  PERMISSIONS.SHOP_SET_CLASSIFICATION,
  PERMISSIONS.CATEGORY_MANAGE,
  PERMISSIONS.PRODUCT_MANAGE,
  PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY,
  PERMISSIONS.PRODUCT_CREATE_ANY,
  PERMISSIONS.ORDER_VIEW_ANY,
  PERMISSIONS.ORDER_UPDATE_STATUS_ANY,
  PERMISSIONS.SUBSCRIPTION_MANAGE_ANY,
  PERMISSIONS.USER_VIEW_ANY,
  PERMISSIONS.REPORT_VIEW_OPERATIONAL,

  PERMISSIONS.PRICE_REQUEST_SUBMIT,
  PERMISSIONS.EXCEL_UPLOAD_ANY,
  PERMISSIONS.SHOP_REGISTRATION_MANAGE,
  PERMISSIONS.PAYMENT_VIEW_ANY,
  PERMISSIONS.PAYMENT_RECORD,
  PERMISSIONS.REFERRAL_MANAGE,
  PERMISSIONS.AUDIT_LOG_VIEW_LIMITED,
  PERMISSIONS.VOUCHER_UPLOAD,
  PERMISSIONS.VOUCHER_VIEW,
  PERMISSIONS.GRIEVANCE_MANAGE,
  PERMISSIONS.SHOP_COMPLIANCE_MANAGE,
  PERMISSIONS.DELIVERY_PARTNER_MANAGE,
  PERMISSIONS.DELIVERY_ORDER_MANAGE_ANY,
  PERMISSIONS.SHOP_GST_PAN_VERIFY,
  PERMISSIONS.BRAND_MANAGE,
  PERMISSIONS.PRODUCT_IDENTITY_MANAGE,
  PERMISSIONS.PRODUCT_MRP_MANAGE,
  // Product master platform: operators curate the master and feed the catalogue,
  // but only an admin may bulk-import into it (PMD_IMPORT).
  PERMISSIONS.PMD_VIEW,
  PERMISSIONS.PMD_REVIEW,
  PERMISSIONS.PMD_PROMOTE,
  // Finance (Part K): operators see and work operational money exceptions
  // and may refund delivered orders (RBAC-011) — but not global finance,
  // settlements, payouts or commission, which stay admin-only.
  PERMISSIONS.FINANCE_EXCEPTIONS_VIEW,
  PERMISSIONS.ORDER_REFUND,
  // Deliberately absent (§43 "not unrestricted system access"):
  // USER_SET_ROLE, USER_SUSPEND, WALLET_ADJUST, SYSTEM_CONFIG,
  // AUDIT_LOG_VIEW, REPORT_VIEW_ALL, WALLET_VIEW_ANY.
  // Also absent, and central to §7: PRICE_REQUEST_DECIDE_ANY and
  // PRICE_REQUEST_OVERRIDE. An operator proposes prices; only the shop owner
  // (or an admin) may approve them.
  // REGISTRATION_FEE_MANAGE is admin-only (§12) — an operator records payments
  // against the fee but cannot change the fee schedule itself.
  // VOUCHER_MANAGE is admin-only (wallet brief §37): an operator may upload a
  // voucher list but must never be able to hand-set a bonus percentage.
];

const ADMIN_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

/**
 * Wave 1 skeleton (GS-002). A society admin is also a resident who shops, so
 * they keep customer capabilities; society-scoped powers (whitelisting riders,
 * society order view) arrive with the society entity in Wave 8 (decision D5).
 */
const SOCIETY_ADMIN_PERMISSIONS: readonly Permission[] = [...CUSTOMER_PERMISSIONS];

export const ROLE_PERMISSIONS: Readonly<
  Record<UserRole, readonly Permission[]>
> = {
  CUSTOMER: CUSTOMER_PERMISSIONS,
  SHOP_OWNER: SHOP_OWNER_PERMISSIONS,
  OPERATOR: OPERATOR_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  DELIVERY_PARTNER: DELIVERY_PARTNER_PERMISSIONS,
  SOCIETY_ADMIN: SOCIETY_ADMIN_PERMISSIONS,
};

const PERMISSION_SETS: Readonly<Record<UserRole, ReadonlySet<Permission>>> = {
  CUSTOMER: new Set(CUSTOMER_PERMISSIONS),
  SHOP_OWNER: new Set(SHOP_OWNER_PERMISSIONS),
  OPERATOR: new Set(OPERATOR_PERMISSIONS),
  ADMIN: new Set(ADMIN_PERMISSIONS),
  DELIVERY_PARTNER: new Set(DELIVERY_PARTNER_PERMISSIONS),
  SOCIETY_ADMIN: new Set(SOCIETY_ADMIN_PERMISSIONS),
};

export function can(role: UserRole, permission: Permission): boolean {
  return PERMISSION_SETS[role].has(permission);
}

export function canAny(
  role: UserRole,
  permissions: readonly Permission[],
): boolean {
  return permissions.some((p) => can(role, p));
}

/** Roles a user may never assign to themselves (§5). */
export const SELF_ASSIGNABLE_ROLES: readonly UserRole[] = [];

/** Human labels for dashboards. */
export const ROLE_LABELS: Record<UserRole, string> = {
  CUSTOMER: "Customer",
  SHOP_OWNER: "Shop Owner",
  OPERATOR: "Operator",
  ADMIN: "Administrator",
  DELIVERY_PARTNER: "Delivery Partner",
  SOCIETY_ADMIN: "Society Admin",
};

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  [PERMISSIONS.SHOP_CREATE]: "Submit a shop registration",
  [PERMISSIONS.SHOP_UPDATE_OWN]: "Edit own shop details",
  [PERMISSIONS.SHOP_UPDATE_ANY]: "Edit any shop's details",
  [PERMISSIONS.SHOP_APPROVE]: "Approve a pending shop",
  [PERMISSIONS.SHOP_REJECT]: "Reject a pending shop",
  [PERMISSIONS.SHOP_SUSPEND]: "Suspend an approved shop",
  [PERMISSIONS.SHOP_SET_CLASSIFICATION]: "Change Kesari/Green classification",
  [PERMISSIONS.CATEGORY_MANAGE]: "Create and edit product categories",
  [PERMISSIONS.PRODUCT_MANAGE]: "Create and edit catalogue products",
  [PERMISSIONS.SHOP_PRODUCT_MANAGE_OWN]: "Manage own shop's products",
  [PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY]: "Manage any shop's products",
  [PERMISSIONS.PRODUCT_CREATE_OWN]: "Create a new product for own shop",
  [PERMISSIONS.PRODUCT_CREATE_ANY]: "Create a new product for any shop",
  [PERMISSIONS.PRODUCT_APPROVE]:
    "Publish or reject a shop-created product in the central catalogue",
  [PERMISSIONS.ORDER_PLACE]: "Place a personal order",
  [PERMISSIONS.ORDER_PLACE_B2B]: "Place a business (B2B) order for own approved shop",
  [PERMISSIONS.ORDER_VIEW_OWN]: "View own orders",
  [PERMISSIONS.ORDER_VIEW_SHOP]: "View orders for own shop",
  [PERMISSIONS.ORDER_VIEW_ANY]: "View all orders",
  [PERMISSIONS.ORDER_UPDATE_STATUS_SHOP]: "Advance own shop's order status",
  [PERMISSIONS.ORDER_UPDATE_STATUS_ANY]: "Advance any order's status",
  [PERMISSIONS.ORDER_CANCEL_OWN]: "Cancel own order",
  [PERMISSIONS.WALLET_VIEW_OWN]: "View own wallet",
  [PERMISSIONS.WALLET_TOPUP_OWN]: "Top up own wallet",
  [PERMISSIONS.WALLET_VIEW_ANY]: "View any wallet",
  [PERMISSIONS.WALLET_ADJUST]: "Manually credit or debit a wallet",
  [PERMISSIONS.WALLET_REFUND]: "Issue a refund to a wallet",
  [PERMISSIONS.SUBSCRIPTION_MANAGE_OWN]: "Manage own subscriptions",
  [PERMISSIONS.SUBSCRIPTION_VIEW_SHOP]: "View subscriptions for own shop",
  [PERMISSIONS.SUBSCRIPTION_MANAGE_ANY]: "Manage any subscription",
  [PERMISSIONS.USER_VIEW_ANY]: "View user records",
  [PERMISSIONS.USER_SET_ROLE]: "Change a user's role",
  [PERMISSIONS.USER_SUSPEND]: "Suspend a user",
  [PERMISSIONS.SYSTEM_CONFIG]: "Change system configuration",
  [PERMISSIONS.AUDIT_LOG_VIEW]: "View audit logs",
  [PERMISSIONS.REPORT_VIEW_SHOP]: "View own shop reports",
  [PERMISSIONS.REPORT_VIEW_OPERATIONAL]: "View operational reports",
  [PERMISSIONS.REPORT_VIEW_ALL]: "View all reports",
  [PERMISSIONS.PRICE_REQUEST_SUBMIT]: "Propose a price change for any shop",
  [PERMISSIONS.PRICE_REQUEST_DECIDE_OWN]:
    "Approve or reject price changes for own shop",
  [PERMISSIONS.PRICE_REQUEST_DECIDE_ANY]:
    "Approve or reject price changes for any shop",
  [PERMISSIONS.PRICE_REQUEST_OVERRIDE]:
    "Force a price live, bypassing owner approval",
  [PERMISSIONS.EXCEL_UPLOAD_OWN]: "Upload a price sheet for own shop",
  [PERMISSIONS.EXCEL_UPLOAD_ANY]: "Upload a price sheet for any shop",
  [PERMISSIONS.REGISTRATION_FEE_MANAGE]:
    "Change the registration fee schedule",
  [PERMISSIONS.SHOP_REGISTRATION_MANAGE]:
    "Set a shop's registration details and fee",
  [PERMISSIONS.PAYMENT_VIEW_OWN]: "View own shop's payment history",
  [PERMISSIONS.PAYMENT_VIEW_ANY]: "View any shop's payment history",
  [PERMISSIONS.PAYMENT_RECORD]: "Record a payment, refund or reversal",
  [PERMISSIONS.REFERRAL_MANAGE]: "Create and assign referral codes",
  [PERMISSIONS.AUDIT_LOG_VIEW_LIMITED]: "View operational audit entries",
  [PERMISSIONS.VOUCHER_MANAGE]: "Create, edit, and activate or deactivate vouchers",
  [PERMISSIONS.VOUCHER_UPLOAD]: "Upload a voucher list",
  [PERMISSIONS.VOUCHER_VIEW]: "View vouchers and redemptions",
  [PERMISSIONS.GRIEVANCE_MANAGE]: "View, assign and resolve grievances",
  [PERMISSIONS.SHOP_COMPLIANCE_MANAGE]:
    "Set a shop's legal name, GSTIN, FSSAI number and return policy",
  [PERMISSIONS.COMPLIANCE_DASHBOARD_VIEW]: "View the legal compliance dashboard",
  [PERMISSIONS.MAPS_USAGE_VIEW]: "View Google Maps Platform SKU usage",
  [PERMISSIONS.DELIVERY_PARTNER_REGISTER]: "Apply to become a delivery partner",
  [PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN]: "View own delivery-partner profile and status",
  [PERMISSIONS.DELIVERY_PARTNER_MANAGE]:
    "Review, approve, reject, suspend or reactivate delivery partners",
  [PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN]:
    "Go online/offline and act on own delivery offers (accept, reject, pick up, deliver)",
  [PERMISSIONS.DELIVERY_ORDER_ASSIGN_SHOP]: "Assign a delivery partner to own shop's ready orders",
  [PERMISSIONS.DELIVERY_ORDER_MANAGE_ANY]: "Assign or reassign a delivery partner to any order",
  [PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE]: "Set the delivery-partner base and per-km earnings rate",
  [PERMISSIONS.SHOP_GST_PAN_MANAGE_OWN]: "Submit own shop's GSTIN and PAN for verification",
  [PERMISSIONS.SHOP_GST_PAN_VERIFY]: "Confirm or reject a shop's submitted GSTIN or PAN",
  [PERMISSIONS.SHOP_PAN_REVEAL]: "Decrypt and view a shop's full PAN number",
  [PERMISSIONS.BRAND_MANAGE]: "Create and edit product brands",
  [PERMISSIONS.PRODUCT_IDENTITY_MANAGE]:
    "Edit master product identity — GTIN, HSN, manufacturer, pack size",
  [PERMISSIONS.PRODUCT_MRP_MANAGE]: "Set the master MRP for a product",
  [PERMISSIONS.PRODUCT_MRP_DISPUTE]: "Flag a master MRP as incorrect for verification",
  [PERMISSIONS.INVENTORY_THRESHOLD_MANAGE_OWN]:
    "Set low-stock threshold and reorder levels for own shop's products",
  [PERMISSIONS.PMD_VIEW]: "Browse the universal product master and its data quality",
  [PERMISSIONS.PMD_REVIEW]: "Resolve possible-duplicate review items and merge products",
  [PERMISSIONS.PMD_PROMOTE]: "Promote a master product into the marketplace catalogue",
  [PERMISSIONS.PMD_IMPORT]: "Bulk-import product records into the master",
  [PERMISSIONS.FINANCE_VIEW]: "View global finance: GMV, commission, settlements, payouts, ledger",
  [PERMISSIONS.FINANCE_MANAGE]: "Set commission rates; approve and mark settlements and payouts paid",
  [PERMISSIONS.FINANCE_PREPARE]: "Prepare weekly settlement and payout batches",
  [PERMISSIONS.FINANCE_EXCEPTIONS_VIEW]: "View and resolve operational financial exceptions",
  [PERMISSIONS.ORDER_REFUND]: "Refund a delivered order to the customer's wallet",
  [PERMISSIONS.SETTLEMENT_VIEW_OWN]: "View own shop's settlement statements",
};
