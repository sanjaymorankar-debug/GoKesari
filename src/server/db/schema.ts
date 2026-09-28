/**
 * Database schema — Your Neighbourhood, Now Online.
 *
 * Conventions enforced across every table:
 *  - Money is ALWAYS integer paise (bigint). ₹70.00 → 7000. Never a float.
 *  - Quantity is ALWAYS integer milli-units (thousandths). 2 L → 2000, 0.5 L → 500.
 *  - Financial rows (wallet_transactions, order_items) are immutable once written.
 */
import { sql } from "drizzle-orm";
import { SHOP_TYPE_KEYS } from "@/lib/shop-types";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ enums */

export const userRoleEnum = pgEnum("user_role", [
  "CUSTOMER",
  "SHOP_OWNER",
  "OPERATOR",
  "ADMIN",
  "DELIVERY_PARTNER",
  /** Wave 1 skeleton (GS-002): customer capabilities only until the society
   * entity and its scoped permissions land (Wave 8, decision D5). */
  "SOCIETY_ADMIN",
]);

export const userStatusEnum = pgEnum("user_status", [
  "ACTIVE",
  "SUSPENDED",
  "DELETED",
]);

export const shopStatusEnum = pgEnum("shop_status", [
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
  "INACTIVE",
]);

/**
 * A shop's primary business category — one of the 44 standard shop types
 * (grocery, dairy, bakery, pharmacy, jewellery, ...). Source of truth is
 * `src/lib/shop-types.ts`; add new types there, not here.
 */
export const shopTypeEnum = pgEnum("shop_type", SHOP_TYPE_KEYS);

/** Operator/Admin-controlled quality classification. Shop owners cannot change this. */
export const classificationEnum = pgEnum("shop_classification", [
  "KESARI",
  "GREEN",
]);

/**
 * GST registration status (marketplace GST-readiness follow-up). Not every
 * shop is GST-registered, and GST registration itself is never assumed or
 * invented — a shop starts UNKNOWN until the owner actively says one way or
 * the other. PENDING_VERIFICATION means a GSTIN was submitted but no
 * verification provider is configured yet, so an admin confirms it by hand
 * (see gst-pan-verification.ts) — this is never silently treated as
 * REGISTERED.
 */
export const gstStatusEnum = pgEnum("gst_status", [
  "UNKNOWN",
  "NOT_REGISTERED",
  "PENDING_VERIFICATION",
  "REGISTERED",
  "COMPOSITION",
  "VERIFICATION_FAILED",
]);

/** Mirrors gstStatusEnum's verification states for PAN — a separate credential, verified independently. */
export const panStatusEnum = pgEnum("pan_status", [
  "UNKNOWN",
  "PENDING_VERIFICATION",
  "VERIFIED",
  "VERIFICATION_FAILED",
]);

/** Provenance for a GST/PAN status — same shape as shops.locationSource, for the same audit reason. */
export const identityVerificationSourceEnum = pgEnum("identity_verification_source", [
  "PROVIDER_VERIFIED",
  "SELF_DECLARED",
  "ADMIN_VERIFIED",
]);

/**
 * Which shop type a product category belongs to. Reuses the same value set as
 * shopTypeEnum: a catalogue category is always scoped to one shop type (e.g.
 * "Milk" → DAIRY, "Rice" → GROCERY_KIRANA).
 */
export const departmentEnum = pgEnum("department", SHOP_TYPE_KEYS);

/**
 * Order lifecycle. Mapping to the approved state machine (workbook "State
 * Machines", decision D8 — extended additively, never renamed):
 *   DRAFT            = the cart (no order row exists yet)
 *   PAYMENT_PENDING  = PENDING / WALLET_INSUFFICIENT / PAYMENT_FAILED
 *   PAID+SHOP_PENDING= CONFIRMED (paid, waiting for the shop to accept)
 *   ACCEPTED → PREPARING (pick & pack) → READY → ASSIGNED (rider accepted)
 *   → PICKED_UP → OUT_FOR_DELIVERY → DELIVERED
 *   exceptions: CANCELLED, FAILED (delivery failed), RETURNED (back at the
 *   shop), REFUND_PENDING/REFUNDED, DISPUTED.
 * Transitions live in services/orders.ts ALLOWED_TRANSITIONS; values added
 * after the first release are appended at the end (Postgres enum order).
 */
export const orderStatusEnum = pgEnum("order_status", [
  "PENDING",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
  "PAYMENT_FAILED",
  "WALLET_INSUFFICIENT",
  "REFUND_PENDING",
  "REFUNDED",
  "ACCEPTED",
  "ASSIGNED",
  "PICKED_UP",
  "FAILED",
  "RETURNED",
  "DISPUTED",
]);

/**
 * Per-line fulfilment (Slice 3, GS-035/036): picking, and substitution when
 * the shop cannot supply a line. SUBSTITUTION_PROPOSED waits for the
 * customer; REMOVED lines are refunded to the wallet.
 */
export const orderItemFulfilmentEnum = pgEnum("order_item_fulfilment", [
  "PENDING",
  "PICKED",
  "SUBSTITUTION_PROPOSED",
  "SUBSTITUTED",
  "REMOVED",
]);

export const orderSourceEnum = pgEnum("order_source", [
  "DIRECT",
  "SUBSCRIPTION",
]);

/**
 * Who the order is for (Wave 1, RBAC-002 decision): a person buying for
 * themselves, or an approved shop buying for its business. Kept as separate
 * flows — B2B needs ORDER_PLACE_B2B and a `buyerShopId`, and is listed apart
 * from personal orders.
 */
export const orderTypeEnum = pgEnum("order_type", ["PERSONAL", "B2B"]);

/* -------------------------------------------------------- delivery windows
 * (delivery-system Part 58 follow-up, Slice C). Fixed set for Phase 1 per
 * the brief ("initially support 30/60/scheduled") — true admin-defined
 * custom windows are Phase 2/3. Nullable on `orders`: existing orders and
 * any checkout that doesn't pick a window are unaffected. */
export const deliveryWindowEnum = pgEnum("delivery_window", [
  "EXPRESS_30",
  "STANDARD_60",
  "SCHEDULED",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "CREATED",
  "PENDING",
  "SUCCESS",
  "FAILED",
  "REFUNDED",
]);

export const walletTxnTypeEnum = pgEnum("wallet_txn_type", [
  "TOP_UP",
  "PRODUCT_PURCHASE",
  "SUBSCRIPTION_DEDUCTION",
  "REFUND",
  "PROMOTIONAL_CREDIT",
  "MANUAL_CREDIT",
  "MANUAL_DEBIT",
  "REVERSAL",
]);

export const walletTxnStatusEnum = pgEnum("wallet_txn_status", [
  "COMPLETED",
  "REVERSED",
]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "ACTIVE",
  "PAUSED",
  "CANCELLED",
  "COMPLETED",
  "PAYMENT_PENDING",
]);

export const subscriptionFrequencyEnum = pgEnum("subscription_frequency", [
  "DAILY",
  "WEEKLY",
]);

/** A per-date deviation from the standing subscription quantity. */
export const overrideTypeEnum = pgEnum("override_type", ["QUANTITY", "SKIP"]);

export const notificationChannelEnum = pgEnum("notification_channel", [
  "IN_APP",
  "EMAIL",
  "SMS",
  "PUSH",
]);

/* ------------------------------------- registration, fees & price approval */

/**
 * Lifecycle of a proposed price change. A request is only ever created for a
 * change that needs someone else's consent — an owner editing their own price
 * writes straight through and never lands here.
 */
export const priceRequestStatusEnum = pgEnum("price_request_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  /** A newer request for the same product superseded this one before decision. */
  "SUPERSEDED",
  "CANCELLED",
]);

/** Who originated a price change, for audit and for the owner's review screen. */
export const priceRequestSourceEnum = pgEnum("price_request_source", [
  "SHOP_OWNER",
  "OPERATOR",
  "ADMIN",
]);

export const excelUploadTypeEnum = pgEnum("excel_upload_type", [
  "GOODS",
  "PRICES",
]);

/**
 * An upload is VALIDATED (parsed, previewed, nothing written) before it can be
 * APPLIED. This two-step is what stops a bad sheet corrupting live prices (§21).
 */
export const excelUploadStatusEnum = pgEnum("excel_upload_status", [
  "VALIDATED",
  "APPLIED",
  "CANCELLED",
  "FAILED",
]);

/** Per-row verdict from Excel validation. Only VALID/NO_CHANGE rows are applied. */
export const excelRowStatusEnum = pgEnum("excel_row_status", [
  "VALID",
  "NO_CHANGE",
  "INVALID_PRICE",
  "DUPLICATE",
  "NOT_FOUND",
  "MISSING_FIELD",
  /** GOODS upload only: no code/name match anywhere — a new product will be created. */
  "NEW_PRODUCT",
]);

/** Registration-fee settlement state for one shop (§4.2). */
export const feePaymentStatusEnum = pgEnum("fee_payment_status", [
  "PENDING",
  "PARTIALLY_PAID",
  "PAID",
  "REFUNDED",
  "CANCELLED",
]);

export const shopPaymentTypeEnum = pgEnum("shop_payment_type", [
  "REGISTRATION_FEE",
  "RENEWAL",
  "ADJUSTMENT",
  "REFUND",
  "REVERSAL",
]);

export const shopPaymentMethodEnum = pgEnum("shop_payment_method", [
  "CASH",
  "UPI",
  "BANK_TRANSFER",
  "CARD",
  "CHEQUE",
  "RAZORPAY",
  "OTHER",
]);

export const referralStatusEnum = pgEnum("referral_status", [
  "ACTIVE",
  "INACTIVE",
  "EXPIRED",
]);

/**
 * Central-catalogue visibility for a product a SHOP_OWNER created (§ product
 * management brief). ACTIVE/INACTIVE already exist via `products.isActive` and
 * soft-delete, so this enum covers only the approval dimension — mirrors the
 * PENDING_APPROVAL/APPROVED/REJECTED vocabulary `shops.status` already uses.
 */
export const productApprovalStatusEnum = pgEnum("product_approval_status", [
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
]);

/* ------------------------------------------- product master (marketplace
 * Product Master / Inventory brief). A kirana genuinely sells both packaged
 * FMCG (branded, GTIN-carrying, printed MRP) and loose goods (rice by the
 * kilo, vegetables) that have none of those. `kind` is what makes the
 * difference explicit rather than leaving every identity field
 * mysteriously null: LOOSE legitimately has no GTIN, brand or MRP, so the
 * service layer only demands an MRP for PACKAGED. */
export const productKindEnum = pgEnum("product_kind", ["PACKAGED", "LOOSE"]);

/** Where a master MRP came from. Provenance matters because §13 forbids a shop owner silently overwriting a verified value. */
export const mrpSourceEnum = pgEnum("mrp_source", [
  "GS1",
  "BRAND",
  "ADMIN",
  "IMPORT",
  "API",
  "SELLER_SUBMITTED",
]);

export const mrpVerificationStatusEnum = pgEnum("mrp_verification_status", [
  "UNVERIFIED",
  "PENDING_VERIFICATION",
  "VERIFIED",
  "DISPUTED",
]);

/** Raised against a shop_product when stock crosses its own configured threshold. */
export const stockAlertTypeEnum = pgEnum("stock_alert_type", [
  "LOW_STOCK",
  "OUT_OF_STOCK",
  "REORDER",
]);

export const stockAlertStatusEnum = pgEnum("stock_alert_status", [
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
]);

/**
 * Voucher lifecycle (§21). EXPIRED and BUDGET_EXHAUSTED are computed states —
 * nothing ever writes them directly except the redemption engine flipping
 * BUDGET_EXHAUSTED the moment a redemption exhausts the budget; expiry is
 * derived from `end_date` at read time so a voucher is never "deleted",
 * matching §21's "maintain historical records".
 */
export const voucherStatusEnum = pgEnum("voucher_status", [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "EXPIRED",
  "BUDGET_EXHAUSTED",
]);

export const voucherApplyModeEnum = pgEnum("voucher_apply_mode", [
  "CODE",
  "AUTO_APPLY",
]);

export const voucherRedemptionStatusEnum = pgEnum("voucher_redemption_status", [
  "PENDING",
  "APPLIED",
  "REVERSED",
  "REJECTED",
]);

export const voucherUploadStatusEnum = pgEnum("voucher_upload_status", [
  "VALIDATED",
  "APPLIED",
  "CANCELLED",
]);

export const voucherUploadRowStatusEnum = pgEnum("voucher_upload_row_status", [
  "VALID",
  "DUPLICATE_IN_FILE",
  "DUPLICATE_EXISTING",
  "INVALID",
]);

/**
 * Grievance redressal (Part 58 — Information Technology Rules 2021, Rule
 * 3(2): an intermediary must acknowledge a complaint within 24 hours and
 * dispose of it within 15 days). Deliberately a plain status ladder, not a
 * generic support-ticket system — this table's whole purpose is to be the
 * thing a Grievance Officer can point to as their compliance record.
 */
export const grievanceStatusEnum = pgEnum("grievance_status", [
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
]);

export const grievanceCategoryEnum = pgEnum("grievance_category", [
  "PAYMENT",
  "WALLET",
  "ORDER",
  "SUBSCRIPTION",
  "SELLER",
  "PRODUCT",
  "PRIVACY",
  "OTHER",
]);

/** What a user consented to, and to which version — the DPDPA-relevant trail. */
export const consentTypeEnum = pgEnum("consent_type", [
  "TERMS_AND_PRIVACY",
  "MARKETING_COMMUNICATIONS",
]);

/* ------------------------------------------------- auth (Auth.js managed) */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name"),
    email: text("email").notNull(),
    emailVerified: timestamp("email_verified", { withTimezone: true }),
    image: text("image"),
    phone: text("phone"),
    // Role is server-owned. It is never read from a request body.
    role: userRoleEnum("role").notNull().default("CUSTOMER"),
    status: userStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index("accounts_user_idx").on(t.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    sessionToken: text("session_token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

/* -------------------------------------------------- roles & permissions */
/**
 * The capability matrix lives in code (authz/permissions.ts) for fast, typed checks.
 * These tables mirror it so permissions are inspectable/reportable from the database
 * and so future per-user grants can be layered on without a schema change.
 */

export const roles = pgTable("roles", {
  key: userRoleEnum("key").primaryKey(),
  label: text("label").notNull(),
  description: text("description"),
});

export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  description: text("description").notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleKey: userRoleEnum("role_key")
      .notNull()
      .references(() => roles.key, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleKey, t.permissionKey] })],
);

/* ------------------------------------------------------------ addresses */

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label"),
    line1: text("line1").notNull(),
    line2: text("line2"),
    area: text("area"),
    city: text("city").notNull(),
    state: text("state"),
    pincode: text("pincode").notNull(),
    latitude: text("latitude"),
    longitude: text("longitude"),
    landmark: text("landmark"),
    deliveryInstructions: text("delivery_instructions"),
    isDefault: boolean("is_default").notNull().default(false),
    /** Same provenance/verification pattern as shops — see schema.ts's shops table comment. */
    locationVerified: boolean("location_verified").notNull().default(false),
    locationVerifiedAt: timestamp("location_verified_at", { withTimezone: true }),
    locationSource: text("location_source", {
      enum: ["GOOGLE_VERIFIED", "MANUAL_ENTRY"],
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("addresses_user_idx").on(t.userId),
    index("addresses_pincode_idx").on(t.pincode),
  ],
);

/* ---------------------------------------------------------------- shops */

export const shops = pgTable(
  "shops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ownerName: text("owner_name").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    addressLine1: text("address_line1").notNull(),
    addressLine2: text("address_line2"),
    area: text("area"),
    city: text("city").notNull(),
    state: text("state"),
    pincode: text("pincode").notNull(),
    latitude: text("latitude"),
    longitude: text("longitude"),
    shopType: shopTypeEnum("shop_type").notNull(),
    status: shopStatusEnum("status").notNull().default("PENDING_APPROVAL"),
    // Only OPERATOR/ADMIN may write this column (enforced in the service layer).
    classification: classificationEnum("classification"),
    logoUrl: text("logo_url"),
    photos: jsonb("photos").$type<string[]>().notNull().default([]),
    /** [{ day: 0-6, open: "06:00", close: "22:00", closed?: boolean }] */
    openingHours: jsonb("opening_hours")
      .$type<
        { day: number; open: string; close: string; closed?: boolean }[]
      >()
      .notNull()
      .default([]),
    deliveryAvailable: boolean("delivery_available").notNull().default(false),
    /**
     * GS-010 delivery zone: straight-line km from the shop's pin within which
     * it delivers (see services/serviceability.ts). A radius, not a polygon,
     * on purpose for Phase 1 — it needs no map drawing and matches how the
     * delivery partner's `operatingRadiusKm` already works.
     */
    serviceRadiusKm: integer("service_radius_km").notNull().default(5),
    deliveryFeePaise: bigint("delivery_fee_paise", { mode: "number" })
      .notNull()
      .default(0),
    /** Orders below this value incur the delivery fee; at/above it delivery is free. */
    freeDeliveryAbovePaise: bigint("free_delivery_above_paise", {
      mode: "number",
    }),
    /** Feeds the delivery-window feasibility check (Part 58 §14) — never
     * promise a 30-minute delivery without accounting for how long this shop
     * actually takes to prepare an order. */
    preparationTimeMinutes: integer("preparation_time_minutes")
      .notNull()
      .default(15),
    description: text("description"),
    rejectionReason: text("rejection_reason"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id),

    /* --------------------------------------------- registration & fee (§4.1) */
    /**
     * Human-readable registration id shown to the owner, e.g. BKS-000123.
     * Allocated by a sequence so concurrent registrations cannot collide.
     */
    registrationNumber: text("registration_number")
      .notNull()
      .default(sql`'BKS-' || lpad(nextval('shop_registration_seq')::text, 6, '0')`),
    registrationDate: date("registration_date"),
    /**
     * SNAPSHOT of the fee that applied when this shop registered (§12).
     * Deliberately a copy, not a join: changing the current registration fee
     * must never rewrite what an existing shop was charged.
     */
    registrationFeePaise: bigint("registration_fee_paise", { mode: "number" }),
    /** Which fee row was in force at registration — provenance for the snapshot. */
    registrationFeeId: uuid("registration_fee_id"),
    referralCodeId: uuid("referral_code_id"),
    feePaymentStatus: feePaymentStatusEnum("fee_payment_status")
      .notNull()
      .default("PENDING"),
    /**
     * Running total of settled payments, maintained in the same transaction that
     * writes shop_payments — same pattern as wallets.balance_paise. Denormalised
     * so §13's "amount paid < registration fee" filter stays indexable.
     */
    amountPaidPaise: bigint("amount_paid_paise", { mode: "number" })
      .notNull()
      .default(0),

    /* ------------------------------- seller & compliance transparency (Part
     * 58: Consumer Protection (E-Commerce) Rules 2020 require the seller's
     * legal identity, not just a storefront display name, to be available to
     * a buyer before purchase. All nullable — not every shop is a registered
     * legal entity distinct from its owner, and only food-category shops need
     * an FSSAI number, so nothing here is force-collected at registration. */
    /** Registered legal/business name, if different from the storefront `name`. */
    legalBusinessName: text("legal_business_name"),
    /** GST Identification Number, where the seller is GST-registered. */
    gstin: text("gstin"),
    /** FSSAI licence/registration number — relevant for food-category shop types. */
    fssaiLicenseNumber: text("fssai_license_number"),

    /* ---------------------------------------------------- GST/PAN self-service
     * verification (marketplace GST-readiness follow-up). Distinct from the
     * admin-only `legalBusinessName`/`gstin` pair above: those are the
     * platform's own compliance-review edit path (Part 58), while these
     * columns back the shop owner's own self-service submission and its
     * verification state. A successful verification still writes through to
     * `legalBusinessName`/`gstin` above, so there's one source of truth for
     * what's actually displayed to buyers. */
    gstStatus: gstStatusEnum("gst_status").notNull().default("UNKNOWN"),
    gstTradeName: text("gst_trade_name"),
    gstVerificationSource: identityVerificationSourceEnum("gst_verification_source"),
    gstVerifiedAt: timestamp("gst_verified_at", { withTimezone: true }),
    gstVerifiedBy: uuid("gst_verified_by").references(() => users.id),

    panStatus: panStatusEnum("pan_status").notNull().default("UNKNOWN"),
    /** AES-256-GCM ciphertext, base64 — see gst-pan-verification.ts. Never stored or logged in plaintext. */
    panNumberEncrypted: text("pan_number_encrypted"),
    /** Last 4 characters only, plaintext — enough for a masked "XXXXXX1234F" display without decrypting. */
    panLast4: text("pan_last4"),
    panHolderName: text("pan_holder_name"),
    panVerificationSource: identityVerificationSourceEnum("pan_verification_source"),
    panVerifiedAt: timestamp("pan_verified_at", { withTimezone: true }),
    panVerifiedBy: uuid("pan_verified_by").references(() => users.id),
    /**
     * Shop-specific return/refund terms shown to buyers before purchase. Null
     * means the platform default (Refund & Cancellation Policy) applies.
     */
    returnPolicyText: text("return_policy_text"),

    /* ------------------------------------------------- delivery location.
     * `latitude`/`longitude` above are the shop's main location. Pickup can
     * differ (e.g. a mall unit vs. its service entrance), so it gets its own
     * pair rather than overloading the main one. Google Geocoding is called
     * exactly once, when the merchant clicks "Confirm location" — everything
     * downstream (search, maps, delivery distance) reads these stored
     * columns, never re-geocodes. See src/server/services/geocoding.ts. */
    pickupLatitude: text("pickup_latitude"),
    pickupLongitude: text("pickup_longitude"),
    pickupInstructions: text("pickup_instructions"),
    landmark: text("landmark"),
    locationVerified: boolean("location_verified").notNull().default(false),
    locationVerifiedAt: timestamp("location_verified_at", { withTimezone: true }),
    /** How `latitude`/`longitude` were obtained — provenance for the compliance/audit trail. */
    locationSource: text("location_source", {
      enum: ["GOOGLE_VERIFIED", "MANUAL_ENTRY"],
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("shops_slug_unique").on(t.slug),
    uniqueIndex("shops_registration_number_unique").on(t.registrationNumber),
    index("shops_owner_idx").on(t.ownerId),
    index("shops_status_idx").on(t.status),
    index("shops_city_idx").on(t.city),
    index("shops_pincode_idx").on(t.pincode),
    index("shops_fee_status_idx").on(t.feePaymentStatus),
    index("shops_referral_idx").on(t.referralCodeId),
    check(
      "shops_delivery_fee_non_negative",
      sql`${t.deliveryFeePaise} >= 0`,
    ),
    check(
      "shops_service_radius_range",
      sql`${t.serviceRadiusKm} BETWEEN 1 AND 50`,
    ),
    check(
      "shops_registration_amounts_non_negative",
      sql`(${t.registrationFeePaise} IS NULL OR ${t.registrationFeePaise} >= 0)
          AND ${t.amountPaidPaise} >= 0`,
    ),
  ],
);

/** Immutable audit trail of Kesari/Green changes (requirement §10). */
export const shopClassificationHistory = pgTable(
  "shop_classification_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    previousValue: classificationEnum("previous_value"),
    newValue: classificationEnum("new_value").notNull(),
    changedBy: uuid("changed_by")
      .notNull()
      .references(() => users.id),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("shop_class_hist_shop_idx").on(t.shopId)],
);

/* ------------------------------------------------------- delivery partners
 * (delivery-system Part 58 follow-up, Slice B — registration + verification
 * only. No online/offline status, no assignment, no earnings yet — those are
 * Slice C, once deliveryOrders/deliveryPartnerEarnings exist to attach them
 * to. Mirrors the shop registration/approval pattern: self-service create,
 * admin-gated status transitions, every transition audited. */

export const deliveryPartnerStatusEnum = pgEnum("delivery_partner_status", [
  "REGISTERED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
  "DEACTIVATED",
]);

export const deliveryPartners = pgTable(
  "delivery_partners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    /* ------------------------------------------------------- personal info */
    fullName: text("full_name").notNull(),
    mobile: text("mobile").notNull(),
    email: text("email"),
    dateOfBirth: date("date_of_birth"),
    profilePhotoUrl: text("profile_photo_url"),

    /* --------------------------------------------------- KYC — deliberately
     * minimal and all nullable; a partner can register and be reviewed
     * before supplying bank details, and nothing here is collected that
     * isn't named in the brief's own field list.
     *
     * SEC-02: the six `*Encrypted` columns are the source of truth
     * (AES-256-GCM, base64 iv||tag||ciphertext — src/lib/pan-crypto.ts,
     * src/server/services/delivery-partner-kyc.ts). The same-named plain
     * columns are LEGACY: no longer written, kept only so rows created
     * before this change can be backfilled (expand-then-contract — see
     * DEPLOYMENT.md), then dropped in a later release. Neither set is ever
     * returned by the service layer. */
    governmentIdType: text("government_id_type"),
    /** @deprecated legacy plaintext — see the SEC-02 note above. */
    panNumber: text("pan_number"),
    /** @deprecated legacy plaintext — see the SEC-02 note above. */
    governmentIdNumber: text("government_id_number"),
    /** @deprecated legacy plaintext — see the SEC-02 note above. */
    bankAccountHolderName: text("bank_account_holder_name"),
    /** @deprecated legacy plaintext — see the SEC-02 note above. */
    bankAccountNumber: text("bank_account_number"),
    /** @deprecated legacy plaintext — see the SEC-02 note above. */
    bankIfsc: text("bank_ifsc"),
    panNumberEncrypted: text("pan_number_encrypted"),
    governmentIdNumberEncrypted: text("government_id_number_encrypted"),
    bankAccountHolderNameEncrypted: text("bank_account_holder_name_encrypted"),
    bankAccountNumberEncrypted: text("bank_account_number_encrypted"),
    bankIfscEncrypted: text("bank_ifsc_encrypted"),
    drivingLicenceNumberEncrypted: text("driving_licence_number_encrypted"),

    /* ---------------------------------------------------------- vehicle */
    /** One of VEHICLE_TYPES in src/lib/vehicle-types.ts — app-level list, not a DB enum, so adding a type is a code change, not a migration. */
    vehicleType: text("vehicle_type").notNull(),
    vehicleRegistrationNumber: text("vehicle_registration_number"),
    /** @deprecated legacy plaintext — see the SEC-02 note in the KYC block above. */
    drivingLicenceNumber: text("driving_licence_number"),

    /* -------------------------------------------------- operating area —
     * same stored-coordinates discipline as shops/addresses (see
     * geocoding.ts): verified once, reused thereafter, never re-geocoded on
     * routine reads. */
    latitude: text("latitude"),
    longitude: text("longitude"),
    operatingRadiusKm: integer("operating_radius_km").notNull().default(5),
    locationVerified: boolean("location_verified").notNull().default(false),
    locationVerifiedAt: timestamp("location_verified_at", { withTimezone: true }),
    locationSource: text("location_source", {
      enum: ["GOOGLE_VERIFIED", "MANUAL_ENTRY"],
    }),

    /* ------------------------------------------------------- verification */
    status: deliveryPartnerStatusEnum("status").notNull().default("REGISTERED"),
    reviewNotes: text("review_notes"),
    rejectionReason: text("rejection_reason"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),

    /* --------------------------------------------------- online status (Slice
     * C). Written only while online, from the browser's native geolocation —
     * never a Google Maps Platform call (see haversine.ts). Never polled or
     * updated while offline, per the brief's own privacy requirement. */
    isOnline: boolean("is_online").notNull().default(false),
    lastLocationLatitude: text("last_location_latitude"),
    lastLocationLongitude: text("last_location_longitude"),
    lastLocationAt: timestamp("last_location_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // One delivery-partner profile per user account.
    uniqueIndex("delivery_partners_user_id_unique").on(t.userId),
    index("delivery_partners_status_idx").on(t.status),
  ],
);

/* ---------------------------------------------------- catalogue (master) */

/**
 * Manufacturer brand ("Amul", "Britannia"). Optional on a product: loose
 * goods and generic staples have no brand, and forcing one would mean
 * inventing fake brands for half a kirana's catalogue.
 */
export const brands = pgTable(
  "brands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    logoUrl: text("logo_url"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("brands_slug_unique").on(t.slug), index("brands_name_idx").on(t.name)],
);

export const productCategories = pgTable(
  "product_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    department: departmentEnum("department").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("product_categories_slug_unique").on(t.slug),
    index("product_categories_dept_idx").on(t.department),
  ],
);

/**
 * Second level of the category tree (Dairy → Milk, Curd, Paneer). Replaces
 * the freeform `products.subCategory` text column, which stays in place
 * untouched so nothing reading it breaks; new code should use this FK.
 */
export const productSubcategories = pgTable(
  "product_subcategories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => productCategories.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("product_subcategories_slug_unique").on(t.slug),
    index("product_subcategories_category_idx").on(t.categoryId),
  ],
);

/**
 * Master catalogue entry (e.g. "Cow Milk 1 L"). Shops attach to these via
 * shop_products, so the same product is comparable across shops.
 */
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => productCategories.id, { onDelete: "restrict" }),
    /**
     * Stable human-readable SKU (P00001…). This — not the uuid — is what the
     * "Product ID" column of an uploaded sheet is matched against, so operators
     * can hand-edit spreadsheets without pasting uuids.
     *
     * Allocated by a database sequence so callers never have to supply one and
     * two concurrent inserts cannot collide.
     */
    code: text("code")
      .notNull()
      .default(sql`'P' || lpad(nextval('product_code_seq')::text, 5, '0')`),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    /** Structured spec sheet (bullet points), distinct from prose description. */
    specifications: text("specifications"),
    /** @deprecated Legacy freeform text. Prefer `subcategoryId`; kept so existing rows/readers are untouched. */
    subCategory: text("sub_category"),
    subcategoryId: uuid("subcategory_id").references(() => productSubcategories.id),
    brandId: uuid("brand_id").references(() => brands.id),
    imageUrl: text("image_url"),

    /* ------------------------------------------- product identity (Product
     * Master brief §3). PACKAGED goods carry a GTIN and a printed MRP;
     * LOOSE goods (rice by the kilo) carry neither, which is why every
     * field here is nullable and `kind` records which case applies. */
    kind: productKindEnum("kind").notNull().default("PACKAGED"),
    /**
     * Canonical GTIN, digits only. EAN-13 and UPC-A *are* GTINs, so they
     * normalize into this one column rather than getting near-duplicate
     * `ean`/`upc` columns that would inevitably drift apart. Unique when
     * present — see the partial index below.
     */
    gtin: text("gtin"),
    /** Shop-local or legacy barcode that is NOT a GTIN. Deliberately not unique. */
    barcode: text("barcode"),
    /** Distinguishes otherwise-identical products (§11's duplicate key). Covers flavour/colour/size. */
    variant: text("variant"),

    /* ------------------------------------------------------ MRP (§12, §13).
     * Owned by the master, never by a shop: `shop_products` holds the
     * selling price. Nullable because LOOSE goods have no printed MRP —
     * the service layer requires one for PACKAGED products instead of a
     * NOT NULL constraint that would make loose goods unrepresentable. */
    mrpPaise: bigint("mrp_paise", { mode: "number" }),
    mrpSource: mrpSourceEnum("mrp_source"),
    mrpEffectiveFrom: date("mrp_effective_from"),
    mrpVerificationStatus: mrpVerificationStatusEnum("mrp_verification_status")
      .notNull()
      .default("UNVERIFIED"),
    mrpUpdatedAt: timestamp("mrp_updated_at", { withTimezone: true }),

    /* ---------------------------------------------------- tax (§3, GST-ready).
     * Rate in basis points (18% → 1800), matching this schema's integer-only
     * money/quantity discipline — no floats anywhere near tax maths. */
    hsnCode: text("hsn_code"),
    gstRateBp: integer("gst_rate_bp"),

    /* ------------------------------------------- manufacturer & packaging */
    manufacturerName: text("manufacturer_name"),
    manufacturerAddress: text("manufacturer_address"),
    countryOfOrigin: text("country_of_origin"),
    /** Printed net quantity, e.g. 500 with `netQuantityUnit` = "g". Distinct from unitSizeMilli, which drives subscription maths. */
    netQuantity: integer("net_quantity"),
    netQuantityUnit: text("net_quantity_unit"),
    /** Display unit: L, ml, kg, g, piece, pack. */
    unit: text("unit").notNull(),
    /** Size of one sellable unit in milli-units (1 L → 1000). */
    unitSizeMilli: integer("unit_size_milli").notNull().default(1000),
    /** Whether this product can be sold as a recurring daily subscription. */
    subscribable: boolean("subscribable").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * Central-catalogue visibility. Defaults APPROVED so every seeded/reference
     * product behaves exactly as before. Only a product a SHOP_OWNER creates
     * themselves starts PENDING_APPROVAL — it is immediately usable in their own
     * shop via shop_products regardless of this value; this column only gates
     * whether OTHER shops can discover it through search/suggestions.
     */
    approvalStatus: productApprovalStatusEnum("approval_status")
      .notNull()
      .default("APPROVED"),
    /** Who created this product row. Null for seeded/reference catalogue rows. */
    createdBy: uuid("created_by").references(() => users.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("products_slug_unique").on(t.slug),
    uniqueIndex("products_code_unique").on(t.code),
    index("products_category_idx").on(t.categoryId),
    index("products_approval_status_idx").on(t.approvalStatus),
    // Partial unique: one master row per GTIN (§11's primary duplicate key),
    // while any number of LOOSE/generic products legitimately have none.
    uniqueIndex("products_gtin_unique")
      .on(t.gtin)
      .where(sql`${t.gtin} IS NOT NULL`),
    index("products_barcode_idx").on(t.barcode),
    index("products_brand_idx").on(t.brandId),
    index("products_subcategory_idx").on(t.subcategoryId),
    index("products_name_idx").on(t.name),
    check(
      "products_mrp_non_negative",
      sql`${t.mrpPaise} IS NULL OR ${t.mrpPaise} >= 0`,
    ),
    check(
      "products_gst_rate_sane",
      sql`${t.gstRateBp} IS NULL OR (${t.gstRateBp} >= 0 AND ${t.gstRateBp} <= 10000)`,
    ),
  ],
);

/**
 * Immutable MRP trail (§12). Separate from product_price_history, which
 * tracks a *shop's* selling price — this one tracks the master MRP and is
 * never deleted, so a disputed price can always be traced to its source.
 */
export const productMrpHistory = pgTable(
  "product_mrp_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    previousMrpPaise: bigint("previous_mrp_paise", { mode: "number" }),
    newMrpPaise: bigint("new_mrp_paise", { mode: "number" }).notNull(),
    source: mrpSourceEnum("source").notNull(),
    effectiveFrom: date("effective_from"),
    reason: text("reason"),
    changedBy: uuid("changed_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("product_mrp_history_product_idx").on(t.productId)],
);

/** Additional product images. `products.imageUrl` stays as the primary/legacy image. */
export const productImages = pgTable(
  "product_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("product_images_product_idx").on(t.productId)],
);

/**
 * A shop's offering of a master product: independent online/offline
 * availability, pricing and stock (requirements §11–§14).
 */
export const shopProducts = pgTable(
  "shop_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    description: text("description"),
    imageUrl: text("image_url"),
    onlinePricePaise: bigint("online_price_paise", { mode: "number" }),
    offlinePricePaise: bigint("offline_price_paise", { mode: "number" }),
    // Both channels default OFF: a shop must explicitly enable each one and
    // supply its price, so a product is never accidentally sellable.
    onlineSaleEnabled: boolean("online_sale_enabled").notNull().default(false),
    offlineSaleEnabled: boolean("offline_sale_enabled")
      .notNull()
      .default(false),
    trackInventory: boolean("track_inventory").notNull().default(true),
    onlineStock: integer("online_stock").notNull().default(0),
    offlineStock: integer("offline_stock").notNull().default(0),

    /* ------------------------------------------ per-shop stock thresholds
     * (Product Master / Inventory brief §15–§18). Deliberately per-shop,
     * never global: a shop selling 200 packets of milk a day and one
     * selling 5 need completely different "low" marks. 0 disables the
     * alert entirely for shops that don't want to be nagged. */
    lowStockThreshold: integer("low_stock_threshold").notNull().default(0),
    reorderLevel: integer("reorder_level"),
    reorderQuantity: integer("reorder_quantity"),
    minimumOrderQuantity: integer("minimum_order_quantity").notNull().default(1),
    maximumOrderQuantity: integer("maximum_order_quantity"),
    isActive: boolean("is_active").notNull().default(true),
    /** Temporary availability toggle (e.g. sold out today) distinct from isActive. */
    isAvailable: boolean("is_available").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("shop_products_shop_product_unique").on(t.shopId, t.productId),
    index("shop_products_shop_idx").on(t.shopId),
    index("shop_products_product_idx").on(t.productId),
    // §13: selling online without a price is structurally impossible.
    check(
      "shop_products_online_requires_price",
      sql`(${t.onlineSaleEnabled} = false) OR (${t.onlinePricePaise} IS NOT NULL)`,
    ),
    check(
      "shop_products_offline_requires_price",
      sql`(${t.offlineSaleEnabled} = false) OR (${t.offlinePricePaise} IS NOT NULL)`,
    ),
    check(
      "shop_products_prices_non_negative",
      sql`(${t.onlinePricePaise} IS NULL OR ${t.onlinePricePaise} >= 0)
          AND (${t.offlinePricePaise} IS NULL OR ${t.offlinePricePaise} >= 0)`,
    ),
    check(
      "shop_products_stock_non_negative",
      sql`${t.onlineStock} >= 0 AND ${t.offlineStock} >= 0`,
    ),
    check(
      "shop_products_thresholds_non_negative",
      sql`${t.lowStockThreshold} >= 0
          AND (${t.reorderLevel} IS NULL OR ${t.reorderLevel} >= 0)
          AND (${t.reorderQuantity} IS NULL OR ${t.reorderQuantity} > 0)
          AND ${t.minimumOrderQuantity} > 0
          AND (${t.maximumOrderQuantity} IS NULL OR ${t.maximumOrderQuantity} >= ${t.minimumOrderQuantity})`,
    ),
    // §22's dashboard filters and the alert sweep both scan by stock level.
    index("shop_products_stock_idx").on(t.onlineStock),
  ],
);

/**
 * Raised when a shop's stock crosses that shop's own configured threshold
 * (§16–§18). Rows are kept after resolution rather than deleted, so a shop
 * can see how often a line actually runs dry.
 */
export const stockAlerts = pgTable(
  "stock_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopProductId: uuid("shop_product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    alertType: stockAlertTypeEnum("alert_type").notNull(),
    status: stockAlertStatusEnum("status").notNull().default("OPEN"),
    stockAtAlert: integer("stock_at_alert").notNull(),
    thresholdAtAlert: integer("threshold_at_alert").notNull(),
    acknowledgedBy: uuid("acknowledged_by").references(() => users.id),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("stock_alerts_shop_status_idx").on(t.shopId, t.status),
    index("stock_alerts_shop_product_idx").on(t.shopProductId),
    // At most one OPEN alert of a given type per shop-product, so a stock
    // change that stays below the threshold doesn't pile up duplicates.
    uniqueIndex("stock_alerts_open_unique")
      .on(t.shopProductId, t.alertType)
      .where(sql`${t.status} = 'OPEN'`),
  ],
);

/** Immutable price-change trail (§13). */
export const productPriceHistory = pgTable(
  "product_price_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopProductId: uuid("shop_product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    priceType: text("price_type", { enum: ["ONLINE", "OFFLINE"] }).notNull(),
    previousPricePaise: bigint("previous_price_paise", { mode: "number" }),
    newPricePaise: bigint("new_price_paise", { mode: "number" }).notNull(),
    changedBy: uuid("changed_by")
      .notNull()
      .references(() => users.id),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("price_history_shop_product_idx").on(t.shopProductId)],
);

/** Append-only stock ledger; shop_products holds the running balance. */
export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopProductId: uuid("shop_product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: ["ONLINE", "OFFLINE"] }).notNull(),
    /** Negative for consumption, positive for restock. */
    deltaUnits: integer("delta_units").notNull(),
    previousUnits: integer("previous_units").notNull(),
    newUnits: integer("new_units").notNull(),
    reason: text("reason").notNull(),
    orderId: uuid("order_id"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("inventory_movements_sp_idx").on(t.shopProductId)],
);

/* ----------------------------------------------------------------- cart */

export const carts = pgTable(
  "carts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("carts_user_unique").on(t.userId)],
);

export const cartItems = pgTable(
  "cart_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    shopProductId: uuid("shop_product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    /** Number of sellable units (not milli-units) — carts sell whole units. */
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("cart_items_cart_product_unique").on(t.cartId, t.shopProductId),
    index("cart_items_cart_idx").on(t.cartId),
    check("cart_items_quantity_positive", sql`${t.quantity} > 0`),
  ],
);

/* --------------------------------------------------------------- orders */

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderNumber: text("order_number").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    addressId: uuid("address_id").references(() => addresses.id),
    /** Address is snapshotted so later edits never rewrite delivery history. */
    deliveryAddressSnapshot: jsonb("delivery_address_snapshot").$type<{
      line1: string;
      line2?: string | null;
      area?: string | null;
      city: string;
      pincode: string;
      /** Carried forward from the address at order time — delivery-assignment
       * (Slice C) needs the customer's coordinates without re-geocoding. */
      latitude?: string | null;
      longitude?: string | null;
    } | null>(),
    status: orderStatusEnum("status").notNull().default("PENDING"),
    source: orderSourceEnum("source").notNull().default("DIRECT"),
    orderType: orderTypeEnum("order_type").notNull().default("PERSONAL"),
    /** B2B only: the approved shop buying for its business. Null for PERSONAL. */
    buyerShopId: uuid("buyer_shop_id").references(() => shops.id, { onDelete: "restrict" }),
    subtotalPaise: bigint("subtotal_paise", { mode: "number" }).notNull(),
    deliveryFeePaise: bigint("delivery_fee_paise", { mode: "number" })
      .notNull()
      .default(0),
    taxPaise: bigint("tax_paise", { mode: "number" }).notNull().default(0),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    /** Set once the wallet deduction has actually completed. */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    deliveryDate: date("delivery_date"),
    notes: text("notes"),
    cancellationReason: text("cancellation_reason"),
    /** Chosen at checkout, when set — see delivery-feasibility.ts. Null for
     * orders placed before this existed, or where no window was offered. */
    deliveryWindow: deliveryWindowEnum("delivery_window"),
    /** The deadline promised for `deliveryWindow`. Never set unless the
     * system determined it was actually achievable at checkout time. */
    promisedByAt: timestamp("promised_by_at", { withTimezone: true }),
    /** When the shop accepted the order (CONFIRMED → ACCEPTED). */
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** When the shop finished packing (→ READY). */
    packedAt: timestamp("packed_at", { withTimezone: true }),
    /**
     * Paise already refunded while the order continued (removed or cheaper
     * substituted lines). `totalPaise` is reduced by the same amount, so a
     * later cancellation refunds only what is still held.
     */
    refundedPaise: bigint("refunded_paise", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_number_unique").on(t.orderNumber),
    index("orders_user_idx").on(t.userId),
    index("orders_shop_idx").on(t.shopId),
    index("orders_status_idx").on(t.status),
    index("orders_created_idx").on(t.createdAt),
    index("orders_buyer_shop_idx").on(t.buyerShopId),
    check(
      "orders_totals_non_negative",
      sql`${t.subtotalPaise} >= 0 AND ${t.totalPaise} >= 0`,
    ),
    check(
      "orders_buyer_shop_matches_type",
      sql`(${t.orderType} = 'B2B') = (${t.buyerShopId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Immutable line items. Price and product name are snapshotted at order time so a
 * later price change can never rewrite the value of a completed order (§13, §34).
 */
export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    shopProductId: uuid("shop_product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "restrict" }),
    productNameSnapshot: text("product_name_snapshot").notNull(),
    unitSnapshot: text("unit_snapshot").notNull(),
    unitPricePaise: bigint("unit_price_paise", { mode: "number" }).notNull(),
    /** Milli-units, so 2.5 L is exactly 2500. */
    quantityMilli: integer("quantity_milli").notNull(),
    lineTotalPaise: bigint("line_total_paise", { mode: "number" }).notNull(),
    /* ------------------------------------------ fulfilment (Slice 3) —
     * the original snapshot above is never rewritten; a substitute is
     * recorded alongside it so the order keeps its history. */
    fulfilmentStatus: orderItemFulfilmentEnum("fulfilment_status").notNull().default("PENDING"),
    substituteShopProductId: uuid("substitute_shop_product_id").references(() => shopProducts.id, {
      onDelete: "restrict",
    }),
    substituteNameSnapshot: text("substitute_name_snapshot"),
    substituteUnitSnapshot: text("substitute_unit_snapshot"),
    substituteQuantityMilli: integer("substitute_quantity_milli"),
    /** What the customer pays for the substitute — never more than the original line. */
    substituteLineTotalPaise: bigint("substitute_line_total_paise", { mode: "number" }),
    fulfilmentNote: text("fulfilment_note"),
    fulfilmentUpdatedAt: timestamp("fulfilment_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("order_items_order_idx").on(t.orderId),
    check("order_items_quantity_positive", sql`${t.quantityMilli} > 0`),
    check(
      "order_items_amounts_non_negative",
      sql`${t.unitPricePaise} >= 0 AND ${t.lineTotalPaise} >= 0`,
    ),
  ],
);

export const orderStatusHistory = pgTable(
  "order_status_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    previousStatus: orderStatusEnum("previous_status"),
    newStatus: orderStatusEnum("new_status").notNull(),
    changedBy: uuid("changed_by").references(() => users.id),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("order_status_history_order_idx").on(t.orderId)],
);

/* ---------------------------------------------------- delivery assignment
 * (delivery-system Part 58 follow-up, Slice C). One row per order for now —
 * multi-order batching (Phase 2) would attach several deliveryOrders to a
 * shared route/batch, not change this table's shape. */

export const deliveryOrderStatusEnum = pgEnum("delivery_order_status", [
  "OFFERED",
  "ACCEPTED",
  "REJECTED",
  "PICKED_UP",
  "DELIVERED",
  "CANCELLED",
  /** Rider could not complete the drop (customer unavailable, etc.). */
  "FAILED",
]);

export const deliveryOrders = pgTable(
  "delivery_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    deliveryPartnerId: uuid("delivery_partner_id")
      .notNull()
      .references(() => deliveryPartners.id, { onDelete: "restrict" }),
    status: deliveryOrderStatusEnum("status").notNull().default("OFFERED"),
    /** Haversine straight-line distance, shop → customer, at assignment time — not a road-distance API call (see haversine.ts). */
    distanceKm: text("distance_km"),
    offeredAt: timestamp("offered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
    /* ---------------------------------------- handover (Slice 4, GS-041/043) */
    /** 4-digit code the shop reads to the rider at pickup; set when the rider accepts. */
    pickupCode: text("pickup_code"),
    /** 4-digit code only the customer sees; set when the rider starts the drop. */
    deliveryOtp: text("delivery_otp"),
    deliveryOtpAttempts: integer("delivery_otp_attempts").notNull().default(0),
    outForDeliveryAt: timestamp("out_for_delivery_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    /** How delivery was confirmed: CUSTOMER_OTP, or OPERATOR_OVERRIDE (proof note required). */
    deliveryConfirmation: text("delivery_confirmation"),
    proofNote: text("proof_note"),
    /** Riders who declined or let this order's offer expire — never re-offered it (GA-009 fallback). */
    rejectedPartnerIds: uuid("rejected_partner_ids").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One active delivery assignment per order, pre-batching.
    uniqueIndex("delivery_orders_order_id_unique").on(t.orderId),
    index("delivery_orders_partner_idx").on(t.deliveryPartnerId),
    index("delivery_orders_status_idx").on(t.status),
  ],
);

/**
 * Admin-configurable earnings rates (Part 58 §11) — same "one active row"
 * pattern as registrationFees. Changes are audited via recordAudit(), not a
 * dedicated history table: lower-stakes than the registration fee, which
 * has direct legal/billing weight.
 */
export const deliveryEarningsConfig = pgTable(
  "delivery_earnings_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    baseFeePaise: bigint("base_fee_paise", { mode: "number" }).notNull(),
    perKmFeePaise: bigint("per_km_fee_paise", { mode: "number" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("delivery_earnings_config_non_negative", sql`${t.baseFeePaise} >= 0 AND ${t.perKmFeePaise} >= 0`),
  ],
);

/** One row per completed delivery — the "transparent, delivery-wise earnings statement" the brief calls for. Idempotent on deliveryOrderId. */
export const deliveryPartnerEarnings = pgTable(
  "delivery_partner_earnings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliveryPartnerId: uuid("delivery_partner_id")
      .notNull()
      .references(() => deliveryPartners.id, { onDelete: "restrict" }),
    deliveryOrderId: uuid("delivery_order_id")
      .notNull()
      .references(() => deliveryOrders.id, { onDelete: "restrict" }),
    basePaise: bigint("base_paise", { mode: "number" }).notNull(),
    distancePaise: bigint("distance_paise", { mode: "number" }).notNull(),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    /** Set when this earning is included in a rider payout batch (GS-064). */
    payoutId: uuid("payout_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("delivery_partner_earnings_order_unique").on(t.deliveryOrderId),
    index("delivery_partner_earnings_payout_idx").on(t.payoutId),
    index("delivery_partner_earnings_partner_idx").on(t.deliveryPartnerId),
  ],
);

/* ------------------------------------------------------------- payments */

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    gateway: text("gateway").notNull().default("CASHFREE"),
    /** Cashfree order id — unique so one intent cannot be created twice. */
    gatewayOrderId: text("gateway_order_id").notNull(),
    /** Cashfree payment id (cf_payment_id) — UNIQUE, which is what blocks replayed callbacks. */
    gatewayPaymentId: text("gateway_payment_id"),
    gatewaySignature: text("gateway_signature"),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("INR"),
    status: paymentStatusEnum("status").notNull().default("CREATED"),
    purpose: text("purpose", { enum: ["WALLET_TOPUP"] })
      .notNull()
      .default("WALLET_TOPUP"),
    failureReason: text("failure_reason"),
    rawPayload: jsonb("raw_payload"),
    /**
     * The voucher code committed to at order-creation time (§19, §32) — read
     * back at verification rather than re-accepted from the client, so a
     * caller cannot swap in a better voucher after the price/amount was
     * already fixed. Null when no voucher was applied.
     */
    voucherCode: text("voucher_code"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("payments_gateway_order_unique").on(t.gatewayOrderId),
    uniqueIndex("payments_gateway_payment_unique").on(t.gatewayPaymentId),
    index("payments_user_idx").on(t.userId),
    check("payments_amount_positive", sql`${t.amountPaise} > 0`),
  ],
);

/* --------------------------------------------------------------- wallet */

export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    balancePaise: bigint("balance_paise", { mode: "number" })
      .notNull()
      .default(0),
    /**
     * The promotional/voucher-funded SLICE of balancePaise — not a second
     * balance. balancePaise is always customer-funded + promotional; this
     * column exists so spending priority (§28, promotional-first) and refund
     * source-preservation (§29) can be computed without re-scanning the
     * ledger on every purchase. It is maintained atomically alongside
     * balancePaise inside the same wallet-mutation transaction, so the two
     * can never drift.
     */
    promotionalBalancePaise: bigint("promotional_balance_paise", {
      mode: "number",
    })
      .notNull()
      .default(0),
    currency: text("currency").notNull().default("INR"),
    lowBalanceThresholdPaise: bigint("low_balance_threshold_paise", {
      mode: "number",
    })
      .notNull()
      .default(50000), // ₹500
    autoRechargeEnabled: boolean("auto_recharge_enabled")
      .notNull()
      .default(false),
    autoRechargeTriggerPaise: bigint("auto_recharge_trigger_paise", {
      mode: "number",
    }),
    autoRechargeAmountPaise: bigint("auto_recharge_amount_paise", {
      mode: "number",
    }),
    status: text("status", { enum: ["ACTIVE", "FROZEN"] })
      .notNull()
      .default("ACTIVE"),
    lowBalanceNotifiedAt: timestamp("low_balance_notified_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("wallets_user_unique").on(t.userId),
    // Last line of defence: a negative balance cannot be persisted, ever.
    check("wallets_balance_non_negative", sql`${t.balancePaise} >= 0`),
    check(
      "wallets_promotional_balance_bounded",
      sql`${t.promotionalBalancePaise} >= 0 AND ${t.promotionalBalancePaise} <= ${t.balancePaise}`,
    ),
  ],
);

/**
 * Immutable ledger. Never UPDATE or DELETE a row here — corrections are written
 * as a new REVERSAL entry.
 */
export const walletTransactions = pgTable(
  "wallet_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    type: walletTxnTypeEnum("type").notNull(),
    status: walletTxnStatusEnum("status").notNull().default("COMPLETED"),
    /** Signed: positive credits, negative debits. */
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    previousBalancePaise: bigint("previous_balance_paise", {
      mode: "number",
    }).notNull(),
    newBalancePaise: bigint("new_balance_paise", { mode: "number" }).notNull(),
    /**
     * Signed slice of `amountPaise` that moved the PROMOTIONAL balance (§27,
     * §28, §29). Zero for a plain TOP_UP. Equal to `amountPaise` for a
     * VOUCHER_BONUS credit. For a debit, the (negative) amount promotional
     * funds covered — read back on refund so the original customer-funded /
     * promotional split is restored rather than refunded as one lump sum.
     */
    promotionalAmountPaise: bigint("promotional_amount_paise", {
      mode: "number",
    })
      .notNull()
      .default(0),
    orderId: uuid("order_id").references(() => orders.id),
    subscriptionId: uuid("subscription_id"),
    paymentId: uuid("payment_id").references(() => payments.id),
    reversalOfId: uuid("reversal_of_id"),
    /**
     * voucher_redemptions.id — a plain uuid rather than .references() because
     * voucher_redemptions is declared later in this file (same rationale as
     * shops.registration_fee_id above); the FK constraint is added via raw
     * SQL in the migration once that table exists.
     */
    voucherRedemptionId: uuid("voucher_redemption_id"),
    /**
     * UNIQUE. This single index is what makes every wallet mutation safely
     * retryable: a duplicate attempt collides here instead of double-charging.
     */
    idempotencyKey: text("idempotency_key").notNull(),
    description: text("description").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("wallet_txn_idempotency_unique").on(t.idempotencyKey),
    index("wallet_txn_wallet_idx").on(t.walletId),
    index("wallet_txn_user_idx").on(t.userId),
    index("wallet_txn_created_idx").on(t.createdAt),
    check("wallet_txn_amount_non_zero", sql`${t.amountPaise} <> 0`),
    check(
      "wallet_txn_balances_non_negative",
      sql`${t.previousBalancePaise} >= 0 AND ${t.newBalancePaise} >= 0`,
    ),
    // The ledger must be arithmetically self-consistent.
    check(
      "wallet_txn_arithmetic",
      sql`${t.newBalancePaise} = ${t.previousBalancePaise} + ${t.amountPaise}`,
    ),
    // The promotional slice can never exceed, or point the opposite direction
    // from, the transaction it is a slice of.
    check(
      "wallet_txn_promotional_within_amount",
      sql`(${t.amountPaise} >= 0 AND ${t.promotionalAmountPaise} >= 0 AND ${t.promotionalAmountPaise} <= ${t.amountPaise})
          OR (${t.amountPaise} < 0 AND ${t.promotionalAmountPaise} <= 0 AND ${t.promotionalAmountPaise} >= ${t.amountPaise})`,
    ),
  ],
);

/* ---------------------------------------------------------- vouchers */

/**
 * A promotional top-up bonus rule (Part B of the wallet/voucher brief).
 *
 * A voucher never touches money the customer paid — it only ever describes
 * how big a PROMOTIONAL_CREDIT to add alongside a verified TOP_UP. The
 * percentage/limits here are advisory to the UI; the redemption engine
 * (services/vouchers.ts) recomputes everything server-side and never trusts a
 * client-supplied bonus amount (§32).
 */
export const vouchers = pgTable(
  "vouchers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Stored upper-cased; NULL when applyMode is AUTO_APPLY. */
    code: text("code"),
    description: text("description"),
    termsAndConditions: text("terms_and_conditions"),
    applyMode: voucherApplyModeEnum("apply_mode").notNull().default("CODE"),
    /** Basis points would overcomplicate this; whole/fractional percent as numeric. */
    bonusPercent: bigint("bonus_percent", { mode: "number" }).notNull(),
    minimumTopupPaise: bigint("minimum_topup_paise", { mode: "number" })
      .notNull()
      .default(0),
    maximumBonusPaise: bigint("maximum_bonus_paise", { mode: "number" }),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    /** NULL = unlimited. */
    usageLimit: integer("usage_limit"),
    perCustomerLimit: integer("per_customer_limit").notNull().default(1),
    /** NULL = unlimited promotional liability. */
    totalBudgetPaise: bigint("total_budget_paise", { mode: "number" }),
    /** Running total of bonus paise issued — maintained atomically with every redemption. */
    budgetUsedPaise: bigint("budget_used_paise", { mode: "number" })
      .notNull()
      .default(0),
    redemptionCount: integer("redemption_count").notNull().default(0),
    status: voucherStatusEnum("status").notNull().default("DRAFT"),
    /** Free-text scope hook for §26 (category/shop restriction) — unused by
     *  the engine in this first implementation, which applies vouchers to any
     *  eligible top-up per the brief's explicit "for the first implementation" scope. */
    applicableScope: text("applicable_scope"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("vouchers_code_unique").on(t.code),
    index("vouchers_status_idx").on(t.status),
    index("vouchers_dates_idx").on(t.startDate, t.endDate),
    // Upper bound is a sanity ceiling, not the "configured maximum" of §17 —
    // that is enforced (and can be tightened) in the service layer; this is
    // the backstop that makes a triple-zero typo impossible to persist.
    check(
      "vouchers_bonus_percent_range",
      sql`${t.bonusPercent} > 0 AND ${t.bonusPercent} <= 100`,
    ),
    check("vouchers_minimum_topup_non_negative", sql`${t.minimumTopupPaise} >= 0`),
    check(
      "vouchers_maximum_bonus_non_negative",
      sql`${t.maximumBonusPaise} IS NULL OR ${t.maximumBonusPaise} >= 0`,
    ),
    check("vouchers_dates_valid", sql`${t.endDate} >= ${t.startDate}`),
    check(
      "vouchers_usage_limit_positive",
      sql`${t.usageLimit} IS NULL OR ${t.usageLimit} > 0`,
    ),
    check("vouchers_per_customer_limit_positive", sql`${t.perCustomerLimit} > 0`),
    check(
      "vouchers_budget_non_negative",
      sql`(${t.totalBudgetPaise} IS NULL OR ${t.totalBudgetPaise} >= 0) AND ${t.budgetUsedPaise} >= 0`,
    ),
  ],
);

/**
 * One application of a voucher to one top-up (§24). This is the audit trail
 * AND the enforcement mechanism: the UNIQUE index on (voucher, customer) when
 * per_customer_limit = 1 — and more generally the row-count check under lock
 * in the redemption engine — is what makes "prevent duplicate use even under
 * concurrent requests" (§22) true rather than aspirational.
 */
export const voucherRedemptions = pgTable(
  "voucher_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    voucherId: uuid("voucher_id")
      .notNull()
      .references(() => vouchers.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "restrict" }),
    paymentId: uuid("payment_id").references(() => payments.id),
    topupAmountPaise: bigint("topup_amount_paise", { mode: "number" }).notNull(),
    bonusPercent: bigint("bonus_percent", { mode: "number" }).notNull(),
    bonusAmountPaise: bigint("bonus_amount_paise", { mode: "number" }).notNull(),
    status: voucherRedemptionStatusEnum("status").notNull().default("PENDING"),
    /**
     * Idempotency anchor: one redemption per payment. A retried/duplicate
     * verify call for the same payment can never double-apply the bonus.
     */
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("voucher_redemptions_idempotency_unique").on(t.idempotencyKey),
    index("voucher_redemptions_voucher_idx").on(t.voucherId),
    index("voucher_redemptions_user_idx").on(t.userId),
    check("voucher_redemptions_amounts_non_negative", sql`${t.topupAmountPaise} >= 0 AND ${t.bonusAmountPaise} >= 0`),
  ],
);

/** One uploaded voucher spreadsheet (§16), mirroring excel_uploads' two-phase shape. */
export const voucherUploads = pgTable(
  "voucher_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    fileName: text("file_name").notNull(),
    status: voucherUploadStatusEnum("status").notNull().default("VALIDATED"),
    totalRecords: integer("total_records").notNull().default(0),
    successfulRecords: integer("successful_records").notNull().default(0),
    failedRecords: integer("failed_records").notNull().default(0),
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("voucher_uploads_uploader_idx").on(t.uploadedBy)],
);

export const voucherUploadItems = pgTable(
  "voucher_upload_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => voucherUploads.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    rawData: jsonb("raw_data").$type<Record<string, unknown>>(),
    voucherName: text("voucher_name"),
    voucherCode: text("voucher_code"),
    status: voucherUploadRowStatusEnum("status").notNull(),
    errorMessage: text("error_message"),
    createdVoucherId: uuid("created_voucher_id").references(() => vouchers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("voucher_upload_items_row_unique").on(t.uploadId, t.rowNumber),
    index("voucher_upload_items_upload_idx").on(t.uploadId),
  ],
);

/* --------------------------------------------------------- subscriptions */

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    shopProductId: uuid("shop_product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "restrict" }),
    addressId: uuid("address_id").references(() => addresses.id),
    /** Standing quantity per delivery, in milli-units (2 L/day → 2000). */
    quantityMilli: integer("quantity_milli").notNull(),
    frequency: subscriptionFrequencyEnum("frequency").notNull().default("DAILY"),
    /** For WEEKLY: ISO weekdays 1-7 the delivery occurs on. */
    weekdays: jsonb("weekdays").$type<number[]>().notNull().default([]),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    nextDeliveryDate: date("next_delivery_date"),
    status: subscriptionStatusEnum("status").notNull().default("ACTIVE"),
    pauseFrom: date("pause_from"),
    pauseUntil: date("pause_until"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("subscriptions_user_idx").on(t.userId),
    index("subscriptions_shop_idx").on(t.shopId),
    index("subscriptions_status_idx").on(t.status),
    index("subscriptions_next_delivery_idx").on(t.nextDeliveryDate),
    check("subscriptions_quantity_positive", sql`${t.quantityMilli} > 0`),
    check(
      "subscriptions_pause_window_valid",
      sql`(${t.pauseFrom} IS NULL AND ${t.pauseUntil} IS NULL)
          OR (${t.pauseFrom} IS NOT NULL AND ${t.pauseUntil} IS NOT NULL AND ${t.pauseUntil} >= ${t.pauseFrom})`,
    ),
  ],
);

/**
 * Per-date deviation (§28–§30). Because a row is scoped to exactly one date, the
 * schedule reverts to the standing quantity automatically the following day.
 */
export const subscriptionDailyOverrides = pgTable(
  "subscription_daily_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    deliveryDate: date("delivery_date").notNull(),
    type: overrideTypeEnum("type").notNull(),
    /** NULL when type = SKIP. */
    quantityMilli: integer("quantity_milli"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("sub_override_sub_date_unique").on(
      t.subscriptionId,
      t.deliveryDate,
    ),
    check(
      "sub_override_quantity_matches_type",
      sql`(${t.type} = 'SKIP' AND ${t.quantityMilli} IS NULL)
          OR (${t.type} = 'QUANTITY' AND ${t.quantityMilli} IS NOT NULL AND ${t.quantityMilli} > 0)`,
    ),
  ],
);

/**
 * One materialised delivery for one date. The UNIQUE(subscription_id, delivery_date)
 * index is the mechanism that makes the daily generation job idempotent (§33).
 */
export const subscriptionOrders = pgTable(
  "subscription_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").references(() => orders.id),
    deliveryDate: date("delivery_date").notNull(),
    quantityMilli: integer("quantity_milli").notNull(),
    unitPricePaise: bigint("unit_price_paise", { mode: "number" }).notNull(),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    status: orderStatusEnum("status").notNull().default("PENDING"),
    failureReason: text("failure_reason"),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Running the daily job twice cannot create a second delivery for a date.
    uniqueIndex("subscription_orders_sub_date_unique").on(
      t.subscriptionId,
      t.deliveryDate,
    ),
    index("subscription_orders_date_idx").on(t.deliveryDate),
    index("subscription_orders_status_idx").on(t.status),
  ],
);

/* -------------------------------------------------------- notifications */

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    channel: notificationChannelEnum("channel").notNull().default("IN_APP"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Deep link into the app, e.g. /wallet or /subscriptions/:id. */
    actionUrl: text("action_url"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    readAt: timestamp("read_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Set for notifications that must not repeat (e.g. one low-balance alert). */
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId),
    index("notifications_read_idx").on(t.userId, t.readAt),
    uniqueIndex("notifications_dedupe_unique").on(t.dedupeKey),
  ],
);

/* --------------------------------------------------- registration fees */

/**
 * The registration fee schedule (§12). Rows are append-only: changing the fee
 * inserts a new row and deactivates the previous one, so the amount in force on
 * any past date stays recoverable.
 */
export const registrationFees = pgTable(
  "registration_fees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("INR"),
    effectiveFrom: date("effective_from").notNull(),
    /** Exactly one row is active at a time; enforced by a partial unique index. */
    isActive: boolean("is_active").notNull().default(true),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("registration_fees_effective_idx").on(t.effectiveFrom),
    check("registration_fees_amount_non_negative", sql`${t.amountPaise} >= 0`),
  ],
);

/** Immutable trail of fee changes (§12). Never updated, never deleted. */
export const registrationFeeHistory = pgTable(
  "registration_fee_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    registrationFeeId: uuid("registration_fee_id")
      .notNull()
      .references(() => registrationFees.id, { onDelete: "restrict" }),
    previousAmountPaise: bigint("previous_amount_paise", { mode: "number" }),
    newAmountPaise: bigint("new_amount_paise", { mode: "number" }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    changedBy: uuid("changed_by")
      .notNull()
      .references(() => users.id),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("registration_fee_history_created_idx").on(t.createdAt)],
);

/* -------------------------------------------------------- referral codes */

export const referralCodes = pgTable(
  "referral_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stored upper-cased; matching is case-insensitive at the service layer. */
    code: text("code").notNull(),
    label: text("label"),
    /** Optional: the person or partner the referral is credited to. */
    referrerName: text("referrer_name"),
    referrerUserId: uuid("referrer_user_id").references(() => users.id),
    status: referralStatusEnum("status").notNull().default("ACTIVE"),
    expiresAt: date("expires_at"),
    note: text("note"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("referral_codes_code_unique").on(t.code),
    index("referral_codes_status_idx").on(t.status),
  ],
);

/** One row per shop that registered under a referral code. */
export const referralRedemptions = pgTable(
  "referral_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referralCodeId: uuid("referral_code_id")
      .notNull()
      .references(() => referralCodes.id, { onDelete: "restrict" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    registrationFeePaise: bigint("registration_fee_paise", { mode: "number" }),
    redeemedBy: uuid("redeemed_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // A shop is attributed to at most one referral code.
    uniqueIndex("referral_redemptions_shop_unique").on(t.shopId),
    index("referral_redemptions_code_idx").on(t.referralCodeId),
  ],
);

/* --------------------------------------------------------- shop payments */

/**
 * Registration-fee and renewal payments (§3, §15). Immutable: a correction is a
 * new REVERSAL/REFUND row pointing at the original, never an UPDATE or DELETE —
 * the same discipline wallet_transactions uses.
 */
export const shopPayments = pgTable(
  "shop_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human-readable receipt id shown to the owner, e.g. PAY-2026-000045. */
    reference: text("reference").notNull(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    paymentType: shopPaymentTypeEnum("payment_type").notNull(),
    /** Signed: positive for receipts, negative for refunds/reversals. */
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("INR"),
    method: shopPaymentMethodEnum("method").notNull().default("CASH"),
    /** Bank/UPI/gateway reference supplied by the operator. */
    transactionId: text("transaction_id"),
    /** The fee this payment was settling — snapshot for reconciliation. */
    feeSnapshotPaise: bigint("fee_snapshot_paise", { mode: "number" }),
    paidAt: timestamp("paid_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    note: text("note"),
    receiptUrl: text("receipt_url"),
    /** Set on a REVERSAL/REFUND row to point at the payment being corrected. */
    reversalOfId: uuid("reversal_of_id"),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("shop_payments_reference_unique").on(t.reference),
    index("shop_payments_shop_idx").on(t.shopId),
    index("shop_payments_owner_idx").on(t.ownerId),
    index("shop_payments_paid_idx").on(t.paidAt),
    check("shop_payments_amount_non_zero", sql`${t.amountPaise} <> 0`),
  ],
);

/* -------------------------------------------------- excel bulk uploads */

/**
 * One uploaded spreadsheet. Rows land in excel_upload_items first and nothing
 * touches live prices until the upload is explicitly applied (§8, §24).
 */
export const excelUploads = pgTable(
  "excel_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    uploadType: excelUploadTypeEnum("upload_type").notNull().default("PRICES"),
    status: excelUploadStatusEnum("status").notNull().default("VALIDATED"),
    fileName: text("file_name").notNull(),
    fileSizeBytes: integer("file_size_bytes").notNull().default(0),
    totalRows: integer("total_rows").notNull().default(0),
    validRows: integer("valid_rows").notNull().default(0),
    invalidRows: integer("invalid_rows").notNull().default(0),
    unchangedRows: integer("unchanged_rows").notNull().default(0),
    duplicateRows: integer("duplicate_rows").notNull().default(0),
    notFoundRows: integer("not_found_rows").notNull().default(0),
    /** Counts and headline diffs, rendered on the preview screen. */
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("excel_uploads_shop_idx").on(t.shopId),
    index("excel_uploads_uploader_idx").on(t.uploadedBy),
    index("excel_uploads_created_idx").on(t.createdAt),
  ],
);

/** One parsed spreadsheet row, with its validation verdict. */
export const excelUploadItems = pgTable(
  "excel_upload_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => excelUploads.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    /** Verbatim cell values, so an operator can see exactly what they sent. */
    rawData: jsonb("raw_data").$type<Record<string, unknown>>(),
    productCode: text("product_code"),
    productName: text("product_name"),
    unit: text("unit"),
    parsedPricePaise: bigint("parsed_price_paise", { mode: "number" }),
    previousPricePaise: bigint("previous_price_paise", { mode: "number" }),
    matchedShopProductId: uuid("matched_shop_product_id").references(
      () => shopProducts.id,
      { onDelete: "set null" },
    ),
    /**
     * GOODS upload only: the row matched a product in the CENTRAL catalogue
     * that this shop does not yet carry — apply() attaches it via
     * createShopProduct rather than creating a new products row.
     */
    matchedProductId: uuid("matched_product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    /**
     * GOODS upload only: set when a NEW_PRODUCT row's name is close to an
     * existing product, so the preview can warn "this looks like X" without
     * blocking the row (§ "flag it for review").
     */
    possibleDuplicateProductId: uuid("possible_duplicate_product_id").references(
      () => products.id,
      { onDelete: "set null" },
    ),
    status: excelRowStatusEnum("status").notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("excel_upload_items_row_unique").on(t.uploadId, t.rowNumber),
    index("excel_upload_items_upload_idx").on(t.uploadId),
  ],
);

/* ------------------------------------------------- price update workflow */

/**
 * A group of proposed price changes submitted together (§2.4, §7). Batching is
 * what makes "Approve all" / "Reject all" a single decision.
 */
export const priceUpdateBatches = pgTable(
  "price_update_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    source: priceRequestSourceEnum("source").notNull(),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => users.id),
    excelUploadId: uuid("excel_upload_id").references(() => excelUploads.id, {
      onDelete: "set null",
    }),
    status: priceRequestStatusEnum("status").notNull().default("PENDING"),
    note: text("note"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("price_update_batches_shop_idx").on(t.shopId),
    index("price_update_batches_status_idx").on(t.status),
  ],
);

/**
 * One proposed price for one channel of one shop product. The live price in
 * shop_products is untouched until this row reaches APPROVED (§10).
 */
export const priceUpdateRequests = pgTable(
  "price_update_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => priceUpdateBatches.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    shopProductId: uuid("shop_product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    priceType: text("price_type", { enum: ["ONLINE", "OFFLINE"] }).notNull(),
    previousPricePaise: bigint("previous_price_paise", { mode: "number" }),
    proposedPricePaise: bigint("proposed_price_paise", {
      mode: "number",
    }).notNull(),
    status: priceRequestStatusEnum("status").notNull().default("PENDING"),
    source: priceRequestSourceEnum("source").notNull(),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => users.id),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("price_update_requests_batch_idx").on(t.batchId),
    index("price_update_requests_shop_idx").on(t.shopId),
    index("price_update_requests_status_idx").on(t.status),
    index("price_update_requests_sp_idx").on(t.shopProductId),
    check(
      "price_update_requests_price_non_negative",
      sql`${t.proposedPricePaise} >= 0`,
    ),
  ],
);

/* -------------------------------------------------- grievance redressal */

/**
 * A complaint filed through the grievance mechanism required by IT Rules
 * 2021 Rule 3(2). Deliberately open to unauthenticated submitters
 * (`submittedByUserId` nullable, `email` always required) — a grievance
 * about being unable to sign in must not itself require signing in.
 */
export const grievances = pgTable(
  "grievances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human-readable reference, e.g. GRV-000123 — what the complainant quotes back. */
    ticketNumber: text("ticket_number")
      .notNull()
      .default(sql`'GRV-' || lpad(nextval('grievance_ticket_seq')::text, 6, '0')`),
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    category: grievanceCategoryEnum("category").notNull().default("OTHER"),
    subject: text("subject").notNull(),
    description: text("description").notNull(),
    status: grievanceStatusEnum("status").notNull().default("OPEN"),
    assignedToUserId: uuid("assigned_to_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolutionNotes: text("resolution_notes"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("grievances_ticket_number_unique").on(t.ticketNumber),
    index("grievances_status_idx").on(t.status),
    index("grievances_email_idx").on(t.email),
    index("grievances_submitted_by_idx").on(t.submittedByUserId),
  ],
);

/** Append-only — a consent is never edited or deleted, only superseded by a newer row. */
export const userConsents = pgTable(
  "user_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    consentType: consentTypeEnum("consent_type").notNull(),
    /** The policy version consented to, e.g. "2026-08-21" — matches the policy page's "Last updated" date. */
    version: text("version").notNull(),
    /** false = a withdrawal (DPDPA §6(4)). Every existing row was a grant. */
    granted: boolean("granted").notNull().default(true),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("user_consents_user_idx").on(t.userId),
    index("user_consents_type_idx").on(t.consentType),
  ],
);

/* ----------------------------------------------------------- audit logs */

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id),
    actorRole: userRoleEnum("actor_role"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    previousValue: jsonb("previous_value"),
    newValue: jsonb("new_value"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_logs_actor_idx").on(t.actorId),
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);

/**
 * SKU-usage log for Google Maps Platform calls (delivery-system Part 58
 * follow-up — cost-optimization architecture). Written exactly once per
 * server-side Geocoding call, never per client-side Autocomplete keystroke
 * or map render — those never touch the server. Lets an admin see whether
 * "call Google exactly once per location" is actually being honoured.
 */
export const mapsApiCallLog = pgTable(
  "maps_api_call_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    service: text("service", { enum: ["GEOCODING"] }).notNull(),
    purpose: text("purpose").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    success: boolean("success").notNull(),
    responseTimeMs: integer("response_time_ms"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("maps_api_call_log_service_idx").on(t.service),
    index("maps_api_call_log_created_idx").on(t.createdAt),
    index("maps_api_call_log_entity_idx").on(t.entityType, t.entityId),
  ],
);

/* ------------------------------------------------------------ inference */


/* =========================================================== finance (Slice 6)
 * GS-061/062/063/064/031, WF-010. Built on the existing money records, not a
 * second payment system: customers pay through the wallet ledger
 * (wallet_transactions, linked by order_id — the order's payment record),
 * gateway top-ups live in `payments`, rider accruals in
 * `delivery_partner_earnings`. Added here, marketplace side only:
 *  - commission_rates        — % by default / shop type / shop (decision D6)
 *  - order_financials        — one snapshot per DELIVERED order (GMV, discount,
 *                              commission, shop payable)
 *  - financial_adjustments   — refunds after delivery and shop / rider /
 *                              delivery / marketplace corrections
 *  - shop_settlements, rider_payouts — weekly batches through PAYOUT_STATUS
 *  - finance_ledger_entries  — double-entry-style journal of every marketplace
 *                              money event (credit/debit per shop, rider, platform)
 *  - reconciliation_records  — persisted reconciliation results + resolution
 * Money never moves from here: PAID records a bank reference an admin entered
 * after paying outside the system. Delivery fee is platform revenue; rider
 * earnings are a platform cost (D6).
 */

export const commissionScopeEnum = pgEnum("commission_scope", ["DEFAULT", "SHOP_TYPE", "SHOP"]);

export const commissionRates = pgTable(
  "commission_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: commissionScopeEnum("scope").notNull(),
    /** Set for SHOP_TYPE. */
    shopType: shopTypeEnum("shop_type"),
    /** Set for SHOP. */
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "restrict" }),
    /** Basis points: 500 = 5.00%. */
    rateBp: integer("rate_bp").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("commission_rates_lookup_idx").on(t.scope, t.shopType, t.shopId),
    check("commission_rates_range", sql`${t.rateBp} BETWEEN 0 AND 5000`),
    check(
      "commission_rates_scope_target",
      sql`(${t.scope} = 'DEFAULT' AND ${t.shopType} IS NULL AND ${t.shopId} IS NULL)
          OR (${t.scope} = 'SHOP_TYPE' AND ${t.shopType} IS NOT NULL AND ${t.shopId} IS NULL)
          OR (${t.scope} = 'SHOP' AND ${t.shopId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Lifecycle of a shop settlement or rider payout (Part F):
 * PENDING (prepared) → ELIGIBLE (approved) → PROCESSING (sent to the bank)
 * → PAID (reference recorded) | FAILED (bank rejected; can be re-sent).
 * PAID → REVERSED (returned by the bank; items become payable again).
 * PENDING/ELIGIBLE → CANCELLED (items released to the next batch).
 */
export const payoutStatusEnum = pgEnum("payout_status", [
  "PENDING",
  "ELIGIBLE",
  "PROCESSING",
  "PAID",
  "FAILED",
  "REVERSED",
  "CANCELLED",
]);

const payoutLifecycleColumns = () => ({
  status: payoutStatusEnum("status").notNull().default("PENDING"),
  /** Bank/UTR reference entered when marked PAID. */
  paymentReference: text("payment_reference"),
  /** Why the bank rejected or reversed it. */
  failureReason: text("failure_reason"),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  processingAt: timestamp("processing_at", { withTimezone: true }),
  paidBy: uuid("paid_by").references(() => users.id),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shopSettlements = pgTable(
  "shop_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    /** Inclusive start / exclusive end of the settlement week (app-time-zone dates). */
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    orderCount: integer("order_count").notNull(),
    /** Gross goods value of the settled orders. */
    goodsPaise: bigint("goods_paise", { mode: "number" }).notNull(),
    commissionPaise: bigint("commission_paise", { mode: "number" }).notNull(),
    /** Shop's share of after-delivery refunds (negative). */
    refundsPaise: bigint("refunds_paise", { mode: "number" }).notNull(),
    /** Other shop adjustments (± ). */
    adjustmentsPaise: bigint("adjustments_paise", { mode: "number" }).notNull(),
    /** goods − commission + refunds + adjustments. */
    netPayablePaise: bigint("net_payable_paise", { mode: "number" }).notNull(),
    ...payoutLifecycleColumns(),
  },
  (t) => [
    index("shop_settlements_shop_idx").on(t.shopId),
    index("shop_settlements_status_idx").on(t.status),
    check("shop_settlements_period", sql`${t.periodEnd} > ${t.periodStart}`),
  ],
);

export const riderPayouts = pgTable(
  "rider_payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliveryPartnerId: uuid("delivery_partner_id")
      .notNull()
      .references(() => deliveryPartners.id, { onDelete: "restrict" }),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    earningsCount: integer("earnings_count").notNull(),
    /** Sum of the batched earnings. */
    grossPaise: bigint("gross_paise", { mode: "number" }).notNull(),
    /** Rider / delivery adjustments (±). */
    adjustmentsPaise: bigint("adjustments_paise", { mode: "number" }).notNull(),
    /** gross + adjustments — what is paid. */
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    ...payoutLifecycleColumns(),
  },
  (t) => [
    index("rider_payouts_partner_idx").on(t.deliveryPartnerId),
    index("rider_payouts_status_idx").on(t.status),
  ],
);

export const orderFinancials = pgTable(
  "order_financials",
  {
    orderId: uuid("order_id")
      .primaryKey()
      .references(() => orders.id, { onDelete: "restrict" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** The customer's wallet debit that paid for the order (Part A payment link). */
    paymentTransactionId: uuid("payment_transaction_id"),
    /** Goods actually sold (order subtotal after removed/substituted lines). */
    goodsPaise: bigint("goods_paise", { mode: "number" }).notNull(),
    /** Part of the payment funded by promotional wallet credit — a platform-funded discount. */
    discountPaise: bigint("discount_paise", { mode: "number" }).notNull().default(0),
    /** Delivery fee the customer paid — platform revenue (D6). */
    deliveryFeePaise: bigint("delivery_fee_paise", { mode: "number" }).notNull(),
    /** GMV of this order: goods + delivery fee as delivered. */
    gmvPaise: bigint("gmv_paise", { mode: "number" }).notNull(),
    /** Rate applied, snapshotted — later rate changes never rewrite it. */
    commissionRateBp: integer("commission_rate_bp").notNull(),
    commissionRateId: uuid("commission_rate_id").references(() => commissionRates.id),
    commissionPaise: bigint("commission_paise", { mode: "number" }).notNull(),
    /** goods − commission; owed to the shop for this order before refunds/adjustments. */
    shopPayablePaise: bigint("shop_payable_paise", { mode: "number" }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull(),
    settlementId: uuid("settlement_id").references(() => shopSettlements.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("order_financials_shop_idx").on(t.shopId),
    index("order_financials_settlement_idx").on(t.settlementId),
    index("order_financials_delivered_idx").on(t.deliveredAt),
  ],
);

export const financialPartyEnum = pgEnum("financial_party", ["SHOP", "RIDER", "PLATFORM"]);

export const adjustmentTypeEnum = pgEnum("financial_adjustment_type", [
  /** Refund to the customer after delivery; the shop bears its share. */
  "REFUND_SHOP",
  /** Refund to the customer after delivery; the platform bears it. */
  "REFUND_PLATFORM",
  /** Correction to what a shop is owed. */
  "SHOP_ADJUSTMENT",
  /** Correction to what a rider is owed (e.g. wrong earning). */
  "RIDER_ADJUSTMENT",
  /** Delivery-related correction to a rider (extra distance, waiting time). */
  "DELIVERY_ADJUSTMENT",
  /** Platform-only correction (write-off, goodwill credit). */
  "MARKETPLACE_ADJUSTMENT",
]);

export const adjustmentStatusEnum = pgEnum("financial_adjustment_status", [
  /** Waiting for the next settlement/payout batch. */
  "PENDING",
  /** Included in a batch. */
  "SETTLED",
  /** Platform-only; nothing to pay out. */
  "RECORDED",
]);

export const financialAdjustments = pgTable(
  "financial_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: adjustmentTypeEnum("type").notNull(),
    party: financialPartyEnum("party").notNull(),
    status: adjustmentStatusEnum("status").notNull().default("PENDING"),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "restrict" }),
    deliveryPartnerId: uuid("delivery_partner_id").references(() => deliveryPartners.id, {
      onDelete: "restrict",
    }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    /** The wallet ledger row of a customer refund (the refund's payment reference). */
    walletTransactionId: uuid("wallet_transaction_id"),
    /** Effect on the party: + owed to it, − recovered from it. */
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    /** What the customer got back (refunds), for reporting and reconciliation. */
    customerRefundPaise: bigint("customer_refund_paise", { mode: "number" }).notNull().default(0),
    reason: text("reason").notNull(),
    settlementId: uuid("settlement_id").references(() => shopSettlements.id),
    payoutId: uuid("payout_id").references(() => riderPayouts.id),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("financial_adjustments_idempotency_unique").on(t.idempotencyKey),
    index("financial_adjustments_shop_idx").on(t.shopId),
    index("financial_adjustments_partner_idx").on(t.deliveryPartnerId),
    index("financial_adjustments_order_idx").on(t.orderId),
    check(
      "financial_adjustments_party_target",
      sql`(${t.party} = 'SHOP' AND ${t.shopId} IS NOT NULL)
          OR (${t.party} = 'RIDER' AND ${t.deliveryPartnerId} IS NOT NULL)
          OR ${t.party} = 'PLATFORM'`,
    ),
  ],
);

export const ledgerEntryTypeEnum = pgEnum("ledger_entry_type", [
  "GOODS_SALE",
  "COMMISSION",
  "DELIVERY_FEE",
  "PROMOTIONAL_DISCOUNT",
  "RIDER_EARNING",
  "REFUND",
  "ADJUSTMENT",
  "SHOP_SETTLEMENT",
  "RIDER_PAYOUT",
  "REVERSAL",
]);

export const ledgerDirectionEnum = pgEnum("ledger_direction", ["CREDIT", "DEBIT"]);

/**
 * Append-only marketplace journal (Part I). CREDIT = the entity is owed /
 * earns; DEBIT = it pays / is paid out. One business event posts one or more
 * entries under the same idempotency prefix. Customer money stays in the
 * wallet ledger — referenced here, never duplicated.
 */
export const financeLedgerEntries = pgTable(
  "finance_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    entityType: financialPartyEnum("entity_type").notNull(),
    /** Shop id, delivery partner id, or null for the platform. */
    entityId: uuid("entity_id"),
    entryType: ledgerEntryTypeEnum("entry_type").notNull(),
    direction: ledgerDirectionEnum("direction").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("INR"),
    /** The record this entry came from: order_financials, adjustment, settlement, payout, earning. */
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    /** Payment/bank reference where one exists. */
    reference: text("reference"),
    status: text("status").notNull().default("POSTED"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("finance_ledger_idempotency_unique").on(t.idempotencyKey),
    index("finance_ledger_order_idx").on(t.orderId),
    index("finance_ledger_entity_idx").on(t.entityType, t.entityId),
    index("finance_ledger_created_idx").on(t.createdAt),
    check("finance_ledger_amount_positive", sql`${t.amountPaise} > 0`),
  ],
);

export const reconciliationEntityEnum = pgEnum("reconciliation_entity", [
  "PAYMENT",
  "ORDER",
  "SHOP",
  "RIDER",
  "SETTLEMENT",
  "PAYOUT",
]);

export const reconciliationStatusEnum = pgEnum("reconciliation_status", [
  "UNMATCHED",
  "MATCHED",
  "PARTIAL",
  "EXCEPTION",
  "RECONCILED",
]);

/** Latest reconciliation result per entity (Part H); RECONCILED once a person resolves it. */
export const reconciliationRecords = pgTable(
  "reconciliation_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: reconciliationEntityEnum("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    /** Human reference: order number, gateway order id, settlement id. */
    reference: text("reference").notNull(),
    checkType: text("check_type").notNull(),
    expectedPaise: bigint("expected_paise", { mode: "number" }),
    actualPaise: bigint("actual_paise", { mode: "number" }),
    status: reconciliationStatusEnum("status").notNull(),
    detail: text("detail"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reconciliation_entity_check_unique").on(t.entityType, t.entityId, t.checkType),
    index("reconciliation_status_idx").on(t.status),
  ],
);

export type User = typeof users.$inferSelect;
export type Shop = typeof shops.$inferSelect;
export type GstStatus = (typeof gstStatusEnum.enumValues)[number];
export type PanStatus = (typeof panStatusEnum.enumValues)[number];
export type IdentityVerificationSource = (typeof identityVerificationSourceEnum.enumValues)[number];
export type ProductCategory = typeof productCategories.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Brand = typeof brands.$inferSelect;
export type ProductSubcategory = typeof productSubcategories.$inferSelect;
export type ProductMrpHistoryRow = typeof productMrpHistory.$inferSelect;
export type ProductImage = typeof productImages.$inferSelect;
export type StockAlert = typeof stockAlerts.$inferSelect;
export type ProductKind = (typeof productKindEnum.enumValues)[number];
export type MrpSource = (typeof mrpSourceEnum.enumValues)[number];
export type MrpVerificationStatus = (typeof mrpVerificationStatusEnum.enumValues)[number];
export type StockAlertType = (typeof stockAlertTypeEnum.enumValues)[number];
export type StockAlertStatus = (typeof stockAlertStatusEnum.enumValues)[number];
export type ShopProduct = typeof shopProducts.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type Voucher = typeof vouchers.$inferSelect;
export type VoucherRedemption = typeof voucherRedemptions.$inferSelect;
export type VoucherUpload = typeof voucherUploads.$inferSelect;
export type VoucherUploadItem = typeof voucherUploadItems.$inferSelect;
export type VoucherStatus = (typeof voucherStatusEnum.enumValues)[number];
export type VoucherApplyMode = (typeof voucherApplyModeEnum.enumValues)[number];
export type VoucherRedemptionStatus =
  (typeof voucherRedemptionStatusEnum.enumValues)[number];
export type Grievance = typeof grievances.$inferSelect;
export type GrievanceStatus = (typeof grievanceStatusEnum.enumValues)[number];
export type GrievanceCategory = (typeof grievanceCategoryEnum.enumValues)[number];
export type UserConsent = typeof userConsents.$inferSelect;
export type ConsentType = (typeof consentTypeEnum.enumValues)[number];
export type Subscription = typeof subscriptions.$inferSelect;
export type SubscriptionDailyOverride =
  typeof subscriptionDailyOverrides.$inferSelect;
export type SubscriptionOrder = typeof subscriptionOrders.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Address = typeof addresses.$inferSelect;
export type DeliveryPartner = typeof deliveryPartners.$inferSelect;
export type DeliveryPartnerStatus = (typeof deliveryPartnerStatusEnum.enumValues)[number];
export type DeliveryOrder = typeof deliveryOrders.$inferSelect;
export type DeliveryOrderStatus = (typeof deliveryOrderStatusEnum.enumValues)[number];
export type DeliveryWindow = (typeof deliveryWindowEnum.enumValues)[number];
export type DeliveryEarningsConfig = typeof deliveryEarningsConfig.$inferSelect;
export type DeliveryPartnerEarning = typeof deliveryPartnerEarnings.$inferSelect;
export type MapsApiCallLog = typeof mapsApiCallLog.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type RegistrationFee = typeof registrationFees.$inferSelect;
export type ReferralCode = typeof referralCodes.$inferSelect;
export type ShopPayment = typeof shopPayments.$inferSelect;
export type ExcelUpload = typeof excelUploads.$inferSelect;
export type ExcelUploadItem = typeof excelUploadItems.$inferSelect;
export type PriceUpdateBatch = typeof priceUpdateBatches.$inferSelect;
export type PriceUpdateRequest = typeof priceUpdateRequests.$inferSelect;
export type UserRole = (typeof userRoleEnum.enumValues)[number];
export type PriceRequestStatus =
  (typeof priceRequestStatusEnum.enumValues)[number];
export type PriceRequestSource =
  (typeof priceRequestSourceEnum.enumValues)[number];
export type FeePaymentStatus = (typeof feePaymentStatusEnum.enumValues)[number];
export type ShopPaymentType = (typeof shopPaymentTypeEnum.enumValues)[number];
export type ShopPaymentMethod =
  (typeof shopPaymentMethodEnum.enumValues)[number];
export type ExcelRowStatus = (typeof excelRowStatusEnum.enumValues)[number];
export type ExcelUploadType = (typeof excelUploadTypeEnum.enumValues)[number];
export type ReferralStatus = (typeof referralStatusEnum.enumValues)[number];
export type ProductApprovalStatus =
  (typeof productApprovalStatusEnum.enumValues)[number];
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export type OrderType = (typeof orderTypeEnum.enumValues)[number];
export type CommissionScope = (typeof commissionScopeEnum.enumValues)[number];
export type PayoutStatus = (typeof payoutStatusEnum.enumValues)[number];
export type AdjustmentType = (typeof adjustmentTypeEnum.enumValues)[number];
export type FinancialParty = (typeof financialPartyEnum.enumValues)[number];
export type LedgerEntryType = (typeof ledgerEntryTypeEnum.enumValues)[number];
export type ReconciliationStatus = (typeof reconciliationStatusEnum.enumValues)[number];
export type ReconciliationEntity = (typeof reconciliationEntityEnum.enumValues)[number];
export type CommissionRate = typeof commissionRates.$inferSelect;
export type ShopSettlement = typeof shopSettlements.$inferSelect;
export type RiderPayout = typeof riderPayouts.$inferSelect;
export type OrderFinancial = typeof orderFinancials.$inferSelect;
export type FinancialAdjustment = typeof financialAdjustments.$inferSelect;
export type FinanceLedgerEntry = typeof financeLedgerEntries.$inferSelect;
export type ReconciliationRecord = typeof reconciliationRecords.$inferSelect;
export type OrderItemFulfilment = (typeof orderItemFulfilmentEnum.enumValues)[number];
export type ShopStatus = (typeof shopStatusEnum.enumValues)[number];
export type Classification = (typeof classificationEnum.enumValues)[number];
export type Department = (typeof departmentEnum.enumValues)[number];
