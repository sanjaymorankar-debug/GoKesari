/**
 * Database schema — Your Neighbourhood, Now Online.
 *
 * Conventions enforced across every table:
 *  - Money is ALWAYS integer paise (bigint). ₹70.00 → 7000. Never a float.
 *  - Quantity is ALWAYS integer milli-units (thousandths). 2 L → 2000, 0.5 L → 500.
 *  - Financial rows (wallet_transactions, order_items) are immutable once written.
 */
import { sql } from "drizzle-orm";
import {
  RETURN_CONDITIONS,
  RETURN_REASONS,
  RETURN_STATUSES,
  PICKUP_STATUSES,
} from "@/lib/return-states";
import { SHOP_TYPE_KEYS } from "@/lib/shop-types";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  datetime,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/* ----------------------------------------------------------- primary keys */

/**
 * Primary-key id, generated in the APPLICATION rather than by the database.
 *
 * `.defaultRandom()` is kept, so the column keeps its `DEFAULT gen_random_uuid()`
 * in Postgres: no migration is needed and anything inserting outside Drizzle is
 * unaffected. `$defaultFn` is what changes behaviour — with it Drizzle sends the
 * id as a bound parameter instead of `DEFAULT`, so the application knows the id
 * *before* the insert:
 *
 *     with $defaultFn     insert into t ("id", "n") values ($1, $2)
 *     without it          insert into t ("id", "n") values (default, $1)
 *
 * That is the prerequisite for MySQL (docs/MYSQL_MIGRATION_ASSESSMENT.md §2.1).
 * MySQL has no `RETURNING`, so a row can only be read back by an id the caller
 * already holds, and `LAST_INSERT_ID()` covers only `AUTO_INCREMENT` keys —
 * never a UUID. Doing this first, while still on Postgres, keeps that change
 * separate from the dialect switch.
 */
/**
 * Every timestamp column carries `fsp: 3` — millisecond precision — and every
 * server-side default is `CURRENT_TIMESTAMP(3)` to match.
 *
 * MySQL's `datetime` keeps whole seconds unless a precision is given, where the
 * Postgres `timestamptz` these were ported from kept microseconds. Without this
 * every row written in the same second shares one `created_at`, so
 * `order by created_at desc` stops being a total order and "the latest row"
 * queries — consent checks, fee history, MRP history — return an arbitrary one
 * of them. Three integration tests caught it.
 *
 * 3 rather than 6 because a JavaScript `Date` only has millisecond resolution,
 * so anything finer would be false precision.
 */
const uuidPk = () =>
  varchar("id", { length: 36 })
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

/**
 * mysql-core has no `blob` helper (only `binary` / `varbinary`, both length-capped),
 * so the column type is declared here -- the same thing the PostgreSQL schema did
 * for `bytea`. LONGBLOB because stored images are not bounded by a row limit.
 */
const blob = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "longblob";
  },
});

/* ------------------------------------------------------------------ enums */

/**
 * `pgEnum` returned a reusable object; `mysqlEnum(name, values)` is per-column.
 * But `.enumValues` is public API of this module -- 62 uses, including
 * `users.ts`, `roles.ts`, `ops-exceptions.ts` and ~50 exported type aliases of
 * the form `(typeof xEnum.enumValues)[number]`. So the shim is callable like the
 * old enum object AND still carries `.enumValues`, which is why 67 declarations
 * change here and 112 usages elsewhere do not change at all.
 *
 * MySQL has no `CREATE TYPE`, so the Postgres type name is dropped: the allowed
 * values live inline on each column instead.
 */
function mysqlEnumType<const T extends readonly [string, ...string[]]>(
  values: T,
) {
  return Object.assign((name: string) => mysqlEnum(name, values), {
    enumValues: values,
  });
}

export const userRoleEnum = mysqlEnumType([
  "CUSTOMER",
  "SHOP_OWNER",
  "OPERATOR",
  "ADMIN",
  "DELIVERY_PARTNER",
  /** Wave 1 skeleton (GS-002): customer capabilities only until the society
   * entity and its scoped permissions land (Wave 8, decision D5). */
  "SOCIETY_ADMIN",
]);

export const userStatusEnum = mysqlEnumType(["ACTIVE", "SUSPENDED", "DELETED"]);

export const shopStatusEnum = mysqlEnumType([
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
export const shopTypeEnum = mysqlEnumType(SHOP_TYPE_KEYS);

/** Operator/Admin-controlled quality classification. Shop owners cannot change this. */
export const classificationEnum = mysqlEnumType(["KESARI", "GREEN"]);

/**
 * GST registration status (marketplace GST-readiness follow-up). Not every
 * shop is GST-registered, and GST registration itself is never assumed or
 * invented — a shop starts UNKNOWN until the owner actively says one way or
 * the other. PENDING_VERIFICATION means a GSTIN was submitted but no
 * verification provider is configured yet, so an admin confirms it by hand
 * (see gst-pan-verification.ts) — this is never silently treated as
 * REGISTERED.
 */
export const gstStatusEnum = mysqlEnumType([
  "UNKNOWN",
  "NOT_REGISTERED",
  "PENDING_VERIFICATION",
  "REGISTERED",
  "COMPOSITION",
  "VERIFICATION_FAILED",
]);

/** Mirrors gstStatusEnum's verification states for PAN — a separate credential, verified independently. */
export const panStatusEnum = mysqlEnumType([
  "UNKNOWN",
  "PENDING_VERIFICATION",
  "VERIFIED",
  "VERIFICATION_FAILED",
]);

/** Provenance for a GST/PAN status — same shape as shops.locationSource, for the same audit reason. */
export const identityVerificationSourceEnum = mysqlEnumType([
  "PROVIDER_VERIFIED",
  "SELF_DECLARED",
  "ADMIN_VERIFIED",
]);

/**
 * Which shop type a product category belongs to. Reuses the same value set as
 * shopTypeEnum: a catalogue category is always scoped to one shop type (e.g.
 * "Milk" → DAIRY, "Rice" → GROCERY_KIRANA).
 */
export const departmentEnum = mysqlEnumType(SHOP_TYPE_KEYS);

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
export const orderStatusEnum = mysqlEnumType([
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
export const orderItemFulfilmentEnum = mysqlEnumType([
  "PENDING",
  "PICKED",
  "SUBSTITUTION_PROPOSED",
  "SUBSTITUTED",
  "REMOVED",
]);

export const orderSourceEnum = mysqlEnumType(["DIRECT", "SUBSCRIPTION"]);

/**
 * Who the order is for (Wave 1, RBAC-002 decision): a person buying for
 * themselves, or an approved shop buying for its business. Kept as separate
 * flows — B2B needs ORDER_PLACE_B2B and a `buyerShopId`, and is listed apart
 * from personal orders.
 */
export const orderTypeEnum = mysqlEnumType(["PERSONAL", "B2B"]);

/**
 * How an order is paid (GS-030). WALLET is charged at checkout; COD is
 * collected in cash at the door (by the rider, or the shop when it delivers
 * itself) and only then counts as paid.
 */
export const paymentMethodEnum = mysqlEnumType(["WALLET", "COD"]);

/* -------------------------------------------------------- delivery windows
 * (delivery-system Part 58 follow-up, Slice C). Fixed set for Phase 1 per
 * the brief ("initially support 30/60/scheduled") — true admin-defined
 * custom windows are Phase 2/3. Nullable on `orders`: existing orders and
 * any checkout that doesn't pick a window are unaffected. */
export const deliveryWindowEnum = mysqlEnumType([
  "EXPRESS_30",
  "STANDARD_60",
  "SCHEDULED",
]);

export const paymentStatusEnum = mysqlEnumType([
  "CREATED",
  "PENDING",
  "SUCCESS",
  "FAILED",
  "REFUNDED",
]);

export const walletTxnTypeEnum = mysqlEnumType([
  "TOP_UP",
  "PRODUCT_PURCHASE",
  "SUBSCRIPTION_DEDUCTION",
  "REFUND",
  "PROMOTIONAL_CREDIT",
  "MANUAL_CREDIT",
  "MANUAL_DEBIT",
  "REVERSAL",
]);

export const walletTxnStatusEnum = mysqlEnumType(["COMPLETED", "REVERSED"]);

export const subscriptionStatusEnum = mysqlEnumType([
  "ACTIVE",
  "PAUSED",
  "CANCELLED",
  "COMPLETED",
  "PAYMENT_PENDING",
]);

export const subscriptionFrequencyEnum = mysqlEnumType(["DAILY", "WEEKLY"]);

/** A per-date deviation from the standing subscription quantity. */
export const overrideTypeEnum = mysqlEnumType(["QUANTITY", "SKIP"]);

export const notificationChannelEnum = mysqlEnumType([
  "IN_APP",
  "EMAIL",
  "SMS",
  "PUSH",
  "WHATSAPP",
]);

/* ------------------------------------- registration, fees & price approval */

/**
 * Lifecycle of a proposed price change. A request is only ever created for a
 * change that needs someone else's consent — an owner editing their own price
 * writes straight through and never lands here.
 */
export const priceRequestStatusEnum = mysqlEnumType([
  "PENDING",
  "APPROVED",
  "REJECTED",
  /** A newer request for the same product superseded this one before decision. */
  "SUPERSEDED",
  "CANCELLED",
]);

/** Who originated a price change, for audit and for the owner's review screen. */
export const priceRequestSourceEnum = mysqlEnumType([
  "SHOP_OWNER",
  "OPERATOR",
  "ADMIN",
]);

export const excelUploadTypeEnum = mysqlEnumType(["GOODS", "PRICES"]);

/**
 * An upload is VALIDATED (parsed, previewed, nothing written) before it can be
 * APPLIED. This two-step is what stops a bad sheet corrupting live prices (§21).
 */
export const excelUploadStatusEnum = mysqlEnumType([
  "VALIDATED",
  "APPLIED",
  "CANCELLED",
  "FAILED",
]);

/** Per-row verdict from Excel validation. Only VALID/NO_CHANGE rows are applied. */
export const excelRowStatusEnum = mysqlEnumType([
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
export const feePaymentStatusEnum = mysqlEnumType([
  "PENDING",
  "PARTIALLY_PAID",
  "PAID",
  "REFUNDED",
  "CANCELLED",
]);

export const shopPaymentTypeEnum = mysqlEnumType([
  "REGISTRATION_FEE",
  "RENEWAL",
  "ADJUSTMENT",
  "REFUND",
  "REVERSAL",
]);

export const shopPaymentMethodEnum = mysqlEnumType([
  "CASH",
  "UPI",
  "BANK_TRANSFER",
  "CARD",
  "CHEQUE",
  "RAZORPAY",
  "OTHER",
]);

export const referralStatusEnum = mysqlEnumType([
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
export const productApprovalStatusEnum = mysqlEnumType([
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
export const productKindEnum = mysqlEnumType(["PACKAGED", "LOOSE"]);

/** Where a master MRP came from. Provenance matters because §13 forbids a shop owner silently overwriting a verified value. */
export const mrpSourceEnum = mysqlEnumType([
  "GS1",
  "BRAND",
  "ADMIN",
  "IMPORT",
  "API",
  "SELLER_SUBMITTED",
]);

export const mrpVerificationStatusEnum = mysqlEnumType([
  "UNVERIFIED",
  "PENDING_VERIFICATION",
  "VERIFIED",
  "DISPUTED",
]);

/** Raised against a shop_product when stock crosses its own configured threshold. */
export const stockAlertTypeEnum = mysqlEnumType([
  "LOW_STOCK",
  "OUT_OF_STOCK",
  "REORDER",
]);

export const stockAlertStatusEnum = mysqlEnumType([
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
export const voucherStatusEnum = mysqlEnumType([
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "EXPIRED",
  "BUDGET_EXHAUSTED",
]);

export const voucherApplyModeEnum = mysqlEnumType(["CODE", "AUTO_APPLY"]);

export const voucherRedemptionStatusEnum = mysqlEnumType([
  "PENDING",
  "APPLIED",
  "REVERSED",
  "REJECTED",
]);

export const voucherUploadStatusEnum = mysqlEnumType([
  "VALIDATED",
  "APPLIED",
  "CANCELLED",
]);

export const voucherUploadRowStatusEnum = mysqlEnumType([
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
export const grievanceStatusEnum = mysqlEnumType([
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
]);

export const grievanceCategoryEnum = mysqlEnumType([
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
export const consentTypeEnum = mysqlEnumType([
  "TERMS_AND_PRIVACY",
  "MARKETING_COMMUNICATIONS",
]);

/* ------------------------------------------------- counters (sequences) */

/**
 * Stands in for the three Postgres sequences the port had to drop:
 * `shop_registration_seq`, `product_code_seq` and `grievance_ticket_seq`.
 *
 * MySQL has no `CREATE SEQUENCE`, and `AUTO_INCREMENT` cannot be used here
 * because these are formatted strings on tables that already have a primary
 * key (`BKS-000001`, `P00001`, `GRV-000123`). One row per counter, incremented
 * by `nextSequenceValue()` in src/server/db/sequence.ts — see that file for why
 * the increment is atomic without a `SELECT ... FOR UPDATE`.
 */
export const counters = mysqlTable("counters", {
  name: varchar("name", { length: 64 }).primaryKey(),
  value: bigint("value", { mode: "number" }).notNull().default(0),
});

/**
 * One row per registration identifier being checked, so two concurrent
 * registrations of the same shop serialise on it.
 *
 * Replaces `pg_advisory_xact_lock`. MySQL's nearest equivalent, `GET_LOCK`, is
 * scoped to the *session* rather than the transaction: it would survive the
 * commit and have to be released by hand, and a forgotten release would wedge
 * every later registration. An InnoDB row lock is released at commit or
 * rollback, which is exactly the lifetime the Postgres version had.
 */
export const registrationLocks = mysqlTable("registration_locks", {
  name: varchar("name", { length: 191 }).primaryKey(),
});

/* ------------------------------------------------- auth (Auth.js managed) */

export const users = mysqlTable(
  "users",
  {
    id: uuidPk(),
    name: text("name"),
    email: varchar("email", { length: 255 }).notNull(),
    /**
     * `timestamp`, not `datetime` like the rest of the schema: @auth/drizzle-adapter
     * types this column as `MySqlTimestamp` and will not accept anything else.
     * The 2038 ceiling that ruled TIMESTAMP out elsewhere does not bite here —
     * this records when verification happened, which is always in the past.
     */
    emailVerified: timestamp("email_verified", { mode: "date", fsp: 3 }),
    image: text("image"),
    phone: text("phone"),
    /**
     * Normalised E.164 number ("+919876543210") used for mobile login lookup.
     * `phoneVerifiedAt` is set only when possession of the number is proven
     * (an SMS code); an email-OTP login never sets it.
     */
    phoneE164: varchar("phone_e164", { length: 255 }),
    phoneVerifiedAt: datetime("phone_verified_at", { mode: "date", fsp: 3 }),
    // Role is server-owned. It is never read from a request body.
    role: userRoleEnum("role").notNull().default("CUSTOMER"),
    status: userStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
    /**
     * MySQL has no partial indexes, so the predicate of the old PostgreSQL
     * partial UNIQUE index lives in this generated column: it is NULL when the
     * predicate is false, and MySQL's UNIQUE ignores NULLs. Verified against
     * both engines -- a second matching row is rejected with a duplicate-key
     * error, non-matching rows are unconstrained, and leaving the predicate
     * frees the slot again.
     *
     * VIRTUAL, not STORED. MySQL refuses a foreign key with ON DELETE CASCADE
     * on any column a STORED generated column is built from (ER_CANNOT_ADD_
     * FOREIGN), and five of these columns are built from exactly such a
     * column. For a VIRTUAL column only ON UPDATE CASCADE is disallowed, which
     * nothing here uses. MariaDB accepts both forms, so this only shows up on
     * MySQL -- it was caught by CI, not by local testing.
     */
    activePhoneKey: varchar("active_phone_key", {
      length: 255,
    }).generatedAlwaysAs(
      sql`CASE WHEN phone_e164 IS NOT NULL AND deleted_at IS NULL THEN phone_e164 END`,
      { mode: "virtual" },
    ),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email),
    uniqueIndex("users_phone_e164_unique").on(t.activePhoneKey),
  ],
);

/**
 * Admin-tunable business rules (OTP limits, matching retries, earnings slots,
 * return windows, suspension policy...). One JSON document per key; the code
 * carries the defaults, so an absent row simply means "use the default".
 * Every change is audited (services/settings.ts).
 */
export const platformSettings = mysqlTable("platform_settings", {
  key: varchar("key", { length: 255 }).primaryKey(),
  value: json("value").$type<unknown>().notNull(),
  updatedBy: varchar("updated_by", { length: 36 }).references(() => users.id),
  updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`),
});

/**
 * One-time codes for mobile login. Only a salted HMAC of the code is stored.
 * `userId` is null when the number matched no account: the request still
 * behaves identically from the outside (no account enumeration) but nothing
 * is ever sent for it.
 */
export const loginOtps = mysqlTable(
  "login_otps",
  {
    id: uuidPk(),
    userId: varchar("user_id", { length: 36 }).references(() => users.id, {
      onDelete: "cascade",
    }),
    phoneE164: varchar("phone_e164", { length: 255 }).notNull(),
    channel: text("channel", { enum: ["EMAIL", "SMS"] }).notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
    attempts: int("attempts").notNull().default(0),
    maxAttempts: int("max_attempts").notNull(),
    /** Set when the code was used, or when a newer code replaced it. */
    consumedAt: datetime("consumed_at", { mode: "date", fsp: 3 }),
    supersededAt: datetime("superseded_at", { mode: "date", fsp: 3 }),
    ipAddress: text("ip_address"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("login_otps_phone_created_idx").on(t.phoneE164, t.createdAt),
    index("login_otps_user_idx").on(t.userId),
  ],
);

export const accounts = mysqlTable(
  "accounts",
  {
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: varchar("provider", { length: 255 }).notNull(),
    providerAccountId: varchar("provider_account_id", {
      length: 255,
    }).notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: int("expires_at"),
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

export const sessions = mysqlTable(
  "sessions",
  {
    sessionToken: varchar("session_token", { length: 255 }).primaryKey(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // `timestamp` for the adapter's sake, as with users.emailVerified above.
    // A session/token expiry is always near-term, so 2038 is not a concern.
    expires: timestamp("expires", { mode: "date", fsp: 3 }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const verificationTokens = mysqlTable(
  "verification_tokens",
  {
    identifier: varchar("identifier", { length: 255 }).notNull(),
    token: varchar("token", { length: 255 }).notNull(),
    // `timestamp` for the adapter's sake, as with users.emailVerified above.
    // A session/token expiry is always near-term, so 2038 is not a concern.
    expires: timestamp("expires", { mode: "date", fsp: 3 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

/* -------------------------------------------------- roles & permissions */
/**
 * The capability matrix lives in code (authz/permissions.ts) for fast, typed checks.
 * These tables mirror it so permissions are inspectable/reportable from the database
 * and so future per-user grants can be layered on without a schema change.
 */

export const roles = mysqlTable("roles", {
  key: userRoleEnum("key").primaryKey(),
  label: text("label").notNull(),
  description: text("description"),
});

export const permissions = mysqlTable("permissions", {
  key: varchar("key", { length: 255 }).primaryKey(),
  description: text("description").notNull(),
});

export const rolePermissions = mysqlTable(
  "role_permissions",
  {
    roleKey: userRoleEnum("role_key")
      .notNull()
      .references(() => roles.key, { onDelete: "cascade" }),
    permissionKey: varchar("permission_key", { length: 255 })
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleKey, t.permissionKey] })],
);

/* ------------------------------------------------------------ addresses */

export const addresses = mysqlTable(
  "addresses",
  {
    id: uuidPk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label"),
    /** Who receives the delivery, when not the account holder. */
    recipientName: text("recipient_name"),
    recipientPhone: text("recipient_phone"),
    addressType: varchar("address_type", {
      length: 255,
      enum: ["HOME", "WORK", "OTHER"],
    })
      .notNull()
      .default("OTHER"),
    line1: text("line1").notNull(),
    line2: text("line2"),
    area: text("area"),
    city: text("city").notNull(),
    state: text("state"),
    pincode: varchar("pincode", { length: 255 }).notNull(),
    latitude: text("latitude"),
    longitude: text("longitude"),
    landmark: text("landmark"),
    deliveryInstructions: text("delivery_instructions"),
    /** Set when the address is inside a verified society the user belongs to (GS-005). */
    societyId: varchar("society_id", { length: 36 }).references(
      () => societies.id,
      { onDelete: "set null" },
    ),
    isDefault: boolean("is_default").notNull().default(false),
    /** Same provenance/verification pattern as shops — see schema.ts's shops table comment. */
    locationVerified: boolean("location_verified").notNull().default(false),
    locationVerifiedAt: datetime("location_verified_at", {
      mode: "date",
      fsp: 3,
    }),
    locationSource: text("location_source", {
      enum: ["GOOGLE_VERIFIED", "MANUAL_ENTRY"],
    }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
  },
  (t) => [
    index("addresses_user_idx").on(t.userId),
    index("addresses_pincode_idx").on(t.pincode),
  ],
);

/* ---------------------------------------------------------------- shops */

export const shops = mysqlTable(
  "shops",
  {
    id: uuidPk(),
    ownerId: varchar("owner_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    ownerName: text("owner_name").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    addressLine1: text("address_line1").notNull(),
    addressLine2: text("address_line2"),
    area: text("area"),
    city: varchar("city", { length: 255 }).notNull(),
    state: text("state"),
    pincode: varchar("pincode", { length: 255 }).notNull(),
    latitude: text("latitude"),
    longitude: text("longitude"),
    shopType: shopTypeEnum("shop_type").notNull(),
    status: shopStatusEnum("status").notNull().default("PENDING_APPROVAL"),
    // Only OPERATOR/ADMIN may write this column (enforced in the service layer).
    classification: classificationEnum("classification"),
    logoUrl: text("logo_url"),
    photos: json("photos").$type<string[]>().notNull().default([]),
    /** [{ day: 0-6, open: "06:00", close: "22:00", closed?: boolean }] */
    openingHours: json("opening_hours")
      .$type<{ day: number; open: string; close: string; closed?: boolean }[]>()
      .notNull()
      .default([]),
    deliveryAvailable: boolean("delivery_available").notNull().default(false),
    /** The shop accepts cash on delivery (GS-030) — opt-in, within the platform's COD limits. */
    codEnabled: boolean("cod_enabled").notNull().default(false),
    /**
     * GS-010 delivery zone: straight-line km from the shop's pin within which
     * it delivers (see services/serviceability.ts). A radius, not a polygon,
     * on purpose for Phase 1 — it needs no map drawing and matches how the
     * delivery partner's `operatingRadiusKm` already works.
     */
    serviceRadiusKm: int("service_radius_km").notNull().default(5),
    /**
     * Extra delivery zones: PIN codes the shop delivers to in addition to its
     * radius (e.g. a neighbouring locality just outside it).
     */
    deliveryPincodes: json("delivery_pincodes")
      .$type<string[]>()
      .notNull()
      .default([]),
    /**
     * Stock-alert defaults for every listing of this shop that does not set its
     * own (see services/inventory-alerts.ts resolveThresholds). 0 / null = none.
     */
    defaultLowStockThreshold: int("default_low_stock_threshold")
      .notNull()
      .default(0),
    defaultReorderLevel: int("default_reorder_level"),
    defaultReorderQuantity: int("default_reorder_quantity"),
    /** Orders below this subtotal are refused at checkout; 0 = no minimum. */
    minOrderPaise: bigint("min_order_paise", { mode: "number" })
      .notNull()
      .default(0),
    /** Owner switch: the shop keeps its listing but takes no new orders for now. */
    ordersPaused: boolean("orders_paused").notNull().default(false),
    /** Rating aggregate (GS-059), maintained from visible order_ratings. Average × 100. */
    ratingAvgX100: int("rating_avg_x100").notNull().default(0),
    ratingCount: int("rating_count").notNull().default(0),
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
    preparationTimeMinutes: int("preparation_time_minutes")
      .notNull()
      .default(15),
    description: text("description"),
    rejectionReason: text("rejection_reason"),
    approvedAt: datetime("approved_at", { mode: "date", fsp: 3 }),
    approvedBy: varchar("approved_by", { length: 36 }).references(
      () => users.id,
    ),

    /* --------------------------------------------- registration & fee (§4.1) */
    /**
     * Human-readable registration id shown to the owner, e.g. BKS-000123.
     * Allocated by a sequence so concurrent registrations cannot collide.
     */
    registrationNumber: varchar("registration_number", {
      length: 255,
    }).notNull(),
    registrationDate: date("registration_date", { mode: "string" }),
    /**
     * SNAPSHOT of the fee that applied when this shop registered (§12).
     * Deliberately a copy, not a join: changing the current registration fee
     * must never rewrite what an existing shop was charged.
     */
    registrationFeePaise: bigint("registration_fee_paise", { mode: "number" }),
    /** Which fee row was in force at registration — provenance for the snapshot. */
    registrationFeeId: varchar("registration_fee_id", { length: 36 }),
    referralCodeId: varchar("referral_code_id", { length: 36 }),
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
    gstVerificationSource: identityVerificationSourceEnum(
      "gst_verification_source",
    ),
    gstVerifiedAt: datetime("gst_verified_at", { mode: "date", fsp: 3 }),
    gstVerifiedBy: varchar("gst_verified_by", { length: 36 }).references(
      () => users.id,
    ),

    panStatus: panStatusEnum("pan_status").notNull().default("UNKNOWN"),
    /** AES-256-GCM ciphertext, base64 — see gst-pan-verification.ts. Never stored or logged in plaintext. */
    panNumberEncrypted: text("pan_number_encrypted"),
    /** Last 4 characters only, plaintext — enough for a masked "XXXXXX1234F" display without decrypting. */
    panLast4: text("pan_last4"),
    panHolderName: text("pan_holder_name"),
    panVerificationSource: identityVerificationSourceEnum(
      "pan_verification_source",
    ),
    panVerifiedAt: datetime("pan_verified_at", { mode: "date", fsp: 3 }),
    panVerifiedBy: varchar("pan_verified_by", { length: 36 }).references(
      () => users.id,
    ),
    /**
     * HMAC-SHA256 blind index of the normalised PAN (lib/pan-crypto.ts
     * panBlindIndex) — lets the duplicate-registration check find the same
     * PAN on another shop without the PAN ever being stored in plaintext.
     */
    panHash: varchar("pan_hash", { length: 255 }),

    /* ---------------------------------------- duplicate-registration guard.
     * Business identifiers checked before a shop is registered, so the same
     * shop cannot be registered twice (services/shop-duplicates.ts). Stored
     * normalised (lib/shop-identity.ts) so every check compares like with
     * like. At least one of Shop Act / PAN / Udyam is required by the
     * registration API; shops registered before this existed have none. */
    /** Shop Act / Gumasta licence number as entered — trimmed, uppercased — for display. */
    shopActNumber: text("shop_act_number"),
    /** shopActNumber reduced to letters and digits: the matching key. */
    shopActKey: varchar("shop_act_key", { length: 255 }),
    /** Udyam number as UDYAM-XX-00-0000000, or an old Udyog Aadhaar number (MH26A0012345). */
    udyamNumber: varchar("udyam_number", { length: 255 }),
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
    locationVerifiedAt: datetime("location_verified_at", {
      mode: "date",
      fsp: 3,
    }),
    /** How `latitude`/`longitude` were obtained — provenance for the compliance/audit trail. */
    locationSource: text("location_source", {
      enum: ["GOOGLE_VERIFIED", "MANUAL_ENTRY"],
    }),

    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
    /**
     * MySQL has no partial indexes, so the predicate of the old PostgreSQL
     * partial UNIQUE index lives in this generated column: it is NULL when the
     * predicate is false, and MySQL's UNIQUE ignores NULLs. Verified against
     * both engines -- a second matching row is rejected with a duplicate-key
     * error, non-matching rows are unconstrained, and leaving the predicate
     * frees the slot again.
     *
     * VIRTUAL, not STORED. MySQL refuses a foreign key with ON DELETE CASCADE
     * on any column a STORED generated column is built from (ER_CANNOT_ADD_
     * FOREIGN), and five of these columns are built from exactly such a
     * column. For a VIRTUAL column only ON UPDATE CASCADE is disallowed, which
     * nothing here uses. MariaDB accepts both forms, so this only shows up on
     * MySQL -- it was caught by CI, not by local testing.
     */
    shopActActiveKey: varchar("shop_act_active_key", {
      length: 255,
    }).generatedAlwaysAs(
      sql`CASE WHEN shop_act_key IS NOT NULL AND deleted_at IS NULL AND status <> 'REJECTED' THEN shop_act_key END`,
      { mode: "virtual" },
    ),
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
    // A Shop Act licence belongs to exactly one establishment, so it is a
    // hard duplicate key across every live registration — the safety net
    // behind the service-level check if two submissions race. REJECTED rows
    // are excluded so a rejected applicant's record never blocks the real
    // owner. PAN and Udyam are deliberately NOT unique: one owner's PAN or
    // one enterprise's Udyam number legitimately covers several branches.
    uniqueIndex("shops_shop_act_key_active_unique").on(t.shopActActiveKey),
    index("shops_pan_hash_idx").on(t.panHash),
    index("shops_udyam_number_idx").on(t.udyamNumber),
    check(
      "shops_shop_act_key_with_number",
      sql`(${t.shopActNumber} IS NULL) = (${t.shopActKey} IS NULL)`,
    ),
    check("shops_delivery_fee_non_negative", sql`${t.deliveryFeePaise} >= 0`),
    check("shops_min_order_non_negative", sql`${t.minOrderPaise} >= 0`),
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

/**
 * Shop categories — what kind of business a shop runs, chosen by the owner
 * (many per shop) and managed centrally by staff. NOT the same as:
 *   - `shops.shop_type`, the single business type that drives product suggestions;
 *   - `product_categories`, which classify the products a shop sells;
 *   - `shops.classification` (Kesari / Green), set by staff.
 * Customers do not browse by these; search and reporting use them internally.
 */
export const shopCategories = mysqlTable(
  "shop_categories",
  {
    id: uuidPk(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 255, enum: ["ACTIVE", "INACTIVE"] })
      .notNull()
      .default("ACTIVE"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("shop_categories_slug_unique").on(t.slug),
    // PostgreSQL needed lower() here because its default collation is
    // case-sensitive. MySQL's utf8mb4_unicode_ci is not, so a plain unique
    // index already rejects "Dairy" against "dairy" -- verified on the server.
    uniqueIndex("shop_categories_name_unique").on(t.name),
  ],
);

/** Many-to-many: one shop, many categories; one category, many shops. */
export const shopCategoryMapping = mysqlTable(
  "shop_category_mapping",
  {
    id: uuidPk(),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    categoryId: varchar("category_id", { length: 36 })
      .notNull()
      .references(() => shopCategories.id, { onDelete: "restrict" }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("shop_category_mapping_unique").on(t.shopId, t.categoryId),
    index("shop_category_mapping_category_idx").on(t.categoryId),
  ],
);

/** Immutable audit trail of Kesari/Green changes (requirement §10). */
export const shopClassificationHistory = mysqlTable(
  "shop_classification_history",
  {
    id: uuidPk(),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    previousValue: classificationEnum("previous_value"),
    newValue: classificationEnum("new_value").notNull(),
    changedBy: varchar("changed_by", { length: 36 })
      .notNull()
      .references(() => users.id),
    reason: text("reason"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index("shop_class_hist_shop_idx").on(t.shopId)],
);

/* ------------------------------------------------------- delivery partners
 * (delivery-system Part 58 follow-up, Slice B — registration + verification
 * only. No online/offline status, no assignment, no earnings yet — those are
 * Slice C, once deliveryOrders/deliveryPartnerEarnings exist to attach them
 * to. Mirrors the shop registration/approval pattern: self-service create,
 * admin-gated status transitions, every transition audited. */

export const deliveryPartnerStatusEnum = mysqlEnumType([
  "REGISTERED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
  "DEACTIVATED",
]);

export const deliveryPartners = mysqlTable(
  "delivery_partners",
  {
    id: uuidPk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    /* ------------------------------------------------------- personal info */
    fullName: text("full_name").notNull(),
    mobile: text("mobile").notNull(),
    email: text("email"),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
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
    operatingRadiusKm: int("operating_radius_km").notNull().default(5),
    /** Rating aggregate (GS-060), maintained from visible order_ratings. Average × 100. */
    ratingAvgX100: int("rating_avg_x100").notNull().default(0),
    ratingCount: int("rating_count").notNull().default(0),
    locationVerified: boolean("location_verified").notNull().default(false),
    locationVerifiedAt: datetime("location_verified_at", {
      mode: "date",
      fsp: 3,
    }),
    locationSource: text("location_source", {
      enum: ["GOOGLE_VERIFIED", "MANUAL_ENTRY"],
    }),

    /* ------------------------------------------------------- verification */
    status: deliveryPartnerStatusEnum("status").notNull().default("REGISTERED"),
    reviewNotes: text("review_notes"),
    rejectionReason: text("rejection_reason"),
    reviewedBy: varchar("reviewed_by", { length: 36 }).references(
      () => users.id,
    ),
    reviewedAt: datetime("reviewed_at", { mode: "date", fsp: 3 }),

    /* --------------------------------------------------- online status (Slice
     * C). Written only while online, from the browser's native geolocation —
     * never a Google Maps Platform call (see haversine.ts). Never polled or
     * updated while offline, per the brief's own privacy requirement. */
    isOnline: boolean("is_online").notNull().default(false),
    lastLocationLatitude: text("last_location_latitude"),
    lastLocationLongitude: text("last_location_longitude"),
    lastLocationAt: datetime("last_location_at", { mode: "date", fsp: 3 }),

    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
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
export const brands = mysqlTable(
  "brands",
  {
    id: uuidPk(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    description: text("description"),
    logoUrl: text("logo_url"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
  },
  (t) => [
    uniqueIndex("brands_slug_unique").on(t.slug),
    index("brands_name_idx").on(t.name),
  ],
);

export const productCategories = mysqlTable(
  "product_categories",
  {
    id: uuidPk(),
    department: departmentEnum("department").notNull(),
    name: text("name").notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    sortOrder: int("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
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
export const productSubcategories = mysqlTable(
  "product_subcategories",
  {
    id: uuidPk(),
    categoryId: varchar("category_id", { length: 36 })
      .notNull()
      .references(() => productCategories.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    sortOrder: int("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
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
export const products = mysqlTable(
  "products",
  {
    id: uuidPk(),
    categoryId: varchar("category_id", { length: 36 })
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
    code: varchar("code", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    description: text("description"),
    /** Structured spec sheet (bullet points), distinct from prose description. */
    specifications: text("specifications"),
    /** @deprecated Legacy freeform text. Prefer `subcategoryId`; kept so existing rows/readers are untouched. */
    subCategory: text("sub_category"),
    subcategoryId: varchar("subcategory_id", { length: 36 }).references(
      () => productSubcategories.id,
    ),
    brandId: varchar("brand_id", { length: 36 }).references(() => brands.id),
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
    gtin: varchar("gtin", { length: 255 }),
    /** Shop-local or legacy barcode that is NOT a GTIN. Deliberately not unique. */
    barcode: varchar("barcode", { length: 255 }),
    /** Distinguishes otherwise-identical products (§11's duplicate key). Covers flavour/colour/size. */
    variant: text("variant"),

    /* ------------------------------------------------------ MRP (§12, §13).
     * Owned by the master, never by a shop: `shop_products` holds the
     * selling price. Nullable because LOOSE goods have no printed MRP —
     * the service layer requires one for PACKAGED products instead of a
     * NOT NULL constraint that would make loose goods unrepresentable. */
    mrpPaise: bigint("mrp_paise", { mode: "number" }),
    mrpSource: mrpSourceEnum("mrp_source"),
    mrpEffectiveFrom: date("mrp_effective_from", { mode: "string" }),
    mrpVerificationStatus: mrpVerificationStatusEnum("mrp_verification_status")
      .notNull()
      .default("UNVERIFIED"),
    mrpUpdatedAt: datetime("mrp_updated_at", { mode: "date", fsp: 3 }),

    /* ---------------------------------------------------- tax (§3, GST-ready).
     * Rate in basis points (18% → 1800), matching this schema's integer-only
     * money/quantity discipline — no floats anywhere near tax maths. */
    hsnCode: text("hsn_code"),
    gstRateBp: int("gst_rate_bp"),

    /* Stock-alert defaults for this product in every shop, set by catalogue
     * staff (a milk packet needs a higher mark than a slow-moving line).
     * Outranked by a listing's own values, outranks the shop default. */
    defaultLowStockThreshold: int("default_low_stock_threshold"),
    defaultReorderLevel: int("default_reorder_level"),
    defaultReorderQuantity: int("default_reorder_quantity"),

    /* ------------------------------------------- manufacturer & packaging */
    manufacturerName: text("manufacturer_name"),
    manufacturerAddress: text("manufacturer_address"),
    countryOfOrigin: text("country_of_origin"),
    /** Printed net quantity, e.g. 500 with `netQuantityUnit` = "g". Distinct from unitSizeMilli, which drives subscription maths. */
    netQuantity: int("net_quantity"),
    netQuantityUnit: text("net_quantity_unit"),
    /** Display unit: L, ml, kg, g, piece, pack. */
    unit: text("unit").notNull(),
    /** Size of one sellable unit in milli-units (1 L → 1000). */
    unitSizeMilli: int("unit_size_milli").notNull().default(1000),
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
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    approvedBy: varchar("approved_by", { length: 36 }).references(
      () => users.id,
    ),
    approvedAt: datetime("approved_at", { mode: "date", fsp: 3 }),
    rejectionReason: text("rejection_reason"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
  },
  (t) => [
    uniqueIndex("products_slug_unique").on(t.slug),
    uniqueIndex("products_code_unique").on(t.code),
    index("products_category_idx").on(t.categoryId),
    index("products_approval_status_idx").on(t.approvalStatus),
    // Partial unique: one master row per GTIN (§11's primary duplicate key),
    // while any number of LOOSE/generic products legitimately have none.
    uniqueIndex("products_gtin_unique").on(t.gtin),
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
export const productMrpHistory = mysqlTable(
  "product_mrp_history",
  {
    id: uuidPk(),
    productId: varchar("product_id", { length: 36 })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    previousMrpPaise: bigint("previous_mrp_paise", { mode: "number" }),
    newMrpPaise: bigint("new_mrp_paise", { mode: "number" }).notNull(),
    source: mrpSourceEnum("source").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }),
    reason: text("reason"),
    changedBy: varchar("changed_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index("product_mrp_history_product_idx").on(t.productId)],
);

/**
 * Product photos. `shopProductId` null = a photo of the product itself (every
 * shop sees it); set = a photo of that one shop's listing (SKU), which takes
 * precedence for that shop. One primary per scope; its URL is mirrored onto
 * `products.image_url` / `shop_products.image_url` so existing readers keep
 * working. New images point at `stored_images` (services/product-images.ts);
 * older rows may carry only an external `url`.
 */
export const productImages = mysqlTable(
  "product_images",
  {
    id: uuidPk(),
    productId: varchar("product_id", { length: 36 })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    shopProductId: varchar("shop_product_id", { length: 36 }).references(
      () => shopProducts.id,
      { onDelete: "cascade" },
    ),
    storedImageId: varchar("stored_image_id", { length: 36 }).references(
      () => storedImages.id,
      { onDelete: "set null" },
    ),
    url: text("url").notNull(),
    altText: text("alt_text"),
    isPrimary: boolean("is_primary").notNull().default(false),
    sortOrder: int("sort_order").notNull().default(0),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    /**
     * MySQL has no partial indexes, so the predicate of the old PostgreSQL
     * partial UNIQUE index lives in this generated column: it is NULL when the
     * predicate is false, and MySQL's UNIQUE ignores NULLs. Verified against
     * both engines -- a second matching row is rejected with a duplicate-key
     * error, non-matching rows are unconstrained, and leaving the predicate
     * frees the slot again.
     *
     * VIRTUAL, not STORED. MySQL refuses a foreign key with ON DELETE CASCADE
     * on any column a STORED generated column is built from (ER_CANNOT_ADD_
     * FOREIGN), and five of these columns are built from exactly such a
     * column. For a VIRTUAL column only ON UPDATE CASCADE is disallowed, which
     * nothing here uses. MariaDB accepts both forms, so this only shows up on
     * MySQL -- it was caught by CI, not by local testing.
     */
    primaryProductKey: varchar("primary_product_key", {
      length: 36,
    }).generatedAlwaysAs(
      sql`CASE WHEN is_primary AND shop_product_id IS NULL THEN product_id END`,
      { mode: "virtual" },
    ),
    /**
     * MySQL has no partial indexes, so the predicate of the old PostgreSQL
     * partial UNIQUE index lives in this generated column: it is NULL when the
     * predicate is false, and MySQL's UNIQUE ignores NULLs. Verified against
     * both engines -- a second matching row is rejected with a duplicate-key
     * error, non-matching rows are unconstrained, and leaving the predicate
     * frees the slot again.
     *
     * VIRTUAL, not STORED. MySQL refuses a foreign key with ON DELETE CASCADE
     * on any column a STORED generated column is built from (ER_CANNOT_ADD_
     * FOREIGN), and five of these columns are built from exactly such a
     * column. For a VIRTUAL column only ON UPDATE CASCADE is disallowed, which
     * nothing here uses. MariaDB accepts both forms, so this only shows up on
     * MySQL -- it was caught by CI, not by local testing.
     */
    primaryListingKey: varchar("primary_listing_key", {
      length: 36,
    }).generatedAlwaysAs(
      sql`CASE WHEN is_primary AND shop_product_id IS NOT NULL THEN shop_product_id END`,
      { mode: "virtual" },
    ),
  },
  (t) => [
    index("product_images_product_idx").on(t.productId),
    index("product_images_shop_product_idx").on(t.shopProductId),
    uniqueIndex("product_images_one_primary_product").on(t.primaryProductKey),
    uniqueIndex("product_images_one_primary_listing").on(t.primaryListingKey),
  ],
);

/**
 * A shop's offering of a master product: independent online/offline
 * availability, pricing and stock (requirements §11–§14).
 */
export const shopProducts = mysqlTable(
  "shop_products",
  {
    id: uuidPk(),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    productId: varchar("product_id", { length: 36 })
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
    onlineStock: int("online_stock").notNull().default(0),
    offlineStock: int("offline_stock").notNull().default(0),

    /* ------------------------------------------ per-shop stock thresholds
     * (Product Master / Inventory brief §15–§18). Deliberately per-shop,
     * never global: a shop selling 200 packets of milk a day and one
     * selling 5 need completely different "low" marks. 0 disables the
     * alert entirely for shops that don't want to be nagged. */
    lowStockThreshold: int("low_stock_threshold").notNull().default(0),
    reorderLevel: int("reorder_level"),
    reorderQuantity: int("reorder_quantity"),
    minimumOrderQuantity: int("minimum_order_quantity").notNull().default(1),
    maximumOrderQuantity: int("maximum_order_quantity"),
    /** The owner opted this listing out of every stock alert (explicit, unlike a 0 threshold that just inherits). */
    stockAlertsDisabled: boolean("stock_alerts_disabled")
      .notNull()
      .default(false),
    isActive: boolean("is_active").notNull().default(true),
    /** Temporary availability toggle (e.g. sold out today) distinct from isActive. */
    isAvailable: boolean("is_available").notNull().default(true),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
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
export const stockAlerts = mysqlTable(
  "stock_alerts",
  {
    id: uuidPk(),
    shopProductId: varchar("shop_product_id", { length: 36 })
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    alertType: stockAlertTypeEnum("alert_type").notNull(),
    status: stockAlertStatusEnum("status").notNull().default("OPEN"),
    stockAtAlert: int("stock_at_alert").notNull(),
    thresholdAtAlert: int("threshold_at_alert").notNull(),
    acknowledgedBy: varchar("acknowledged_by", { length: 36 }).references(
      () => users.id,
    ),
    acknowledgedAt: datetime("acknowledged_at", { mode: "date", fsp: 3 }),
    resolvedAt: datetime("resolved_at", { mode: "date", fsp: 3 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    /**
     * MySQL has no partial indexes, so the predicate of the old PostgreSQL
     * partial UNIQUE index lives in this generated column: it is NULL when the
     * predicate is false, and MySQL's UNIQUE ignores NULLs. Verified against
     * both engines -- a second matching row is rejected with a duplicate-key
     * error, non-matching rows are unconstrained, and leaving the predicate
     * frees the slot again.
     *
     * VIRTUAL, not STORED. MySQL refuses a foreign key with ON DELETE CASCADE
     * on any column a STORED generated column is built from (ER_CANNOT_ADD_
     * FOREIGN), and five of these columns are built from exactly such a
     * column. For a VIRTUAL column only ON UPDATE CASCADE is disallowed, which
     * nothing here uses. MariaDB accepts both forms, so this only shows up on
     * MySQL -- it was caught by CI, not by local testing.
     */
    openAlertKey: varchar("open_alert_key", { length: 600 }).generatedAlwaysAs(
      sql`CASE WHEN status = 'OPEN' THEN CONCAT(shop_product_id,':',alert_type) END`,
      { mode: "virtual" },
    ),
  },
  (t) => [
    index("stock_alerts_shop_status_idx").on(t.shopId, t.status),
    index("stock_alerts_shop_product_idx").on(t.shopProductId),
    // At most one OPEN alert of a given type per shop-product, so a stock
    // change that stays below the threshold doesn't pile up duplicates.
    uniqueIndex("stock_alerts_open_unique").on(t.openAlertKey),
  ],
);

/** Immutable price-change trail (§13). */
export const productPriceHistory = mysqlTable(
  "product_price_history",
  {
    id: uuidPk(),
    shopProductId: varchar("shop_product_id", { length: 36 })
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    priceType: text("price_type", { enum: ["ONLINE", "OFFLINE"] }).notNull(),
    previousPricePaise: bigint("previous_price_paise", { mode: "number" }),
    newPricePaise: bigint("new_price_paise", { mode: "number" }).notNull(),
    changedBy: varchar("changed_by", { length: 36 })
      .notNull()
      .references(() => users.id),
    reason: text("reason"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index("price_history_shop_product_idx").on(t.shopProductId)],
);

/** Append-only stock ledger; shop_products holds the running balance. */
export const inventoryMovements = mysqlTable(
  "inventory_movements",
  {
    id: uuidPk(),
    shopProductId: varchar("shop_product_id", { length: 36 })
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: ["ONLINE", "OFFLINE"] }).notNull(),
    /** Negative for consumption, positive for restock. */
    deltaUnits: int("delta_units").notNull(),
    previousUnits: int("previous_units").notNull(),
    newUnits: int("new_units").notNull(),
    reason: text("reason").notNull(),
    orderId: varchar("order_id", { length: 36 }),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index("inventory_movements_sp_idx").on(t.shopProductId)],
);

/* ----------------------------------------------------------------- cart */

export const carts = mysqlTable(
  "carts",
  {
    id: uuidPk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [uniqueIndex("carts_user_unique").on(t.userId)],
);

export const cartItems = mysqlTable(
  "cart_items",
  {
    id: uuidPk(),
    cartId: varchar("cart_id", { length: 36 })
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    shopProductId: varchar("shop_product_id", { length: 36 })
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    /** Number of sellable units (not milli-units) — carts sell whole units. */
    quantity: int("quantity").notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("cart_items_cart_product_unique").on(t.cartId, t.shopProductId),
    index("cart_items_cart_idx").on(t.cartId),
    check("cart_items_quantity_positive", sql`${t.quantity} > 0`),
  ],
);

/* --------------------------------------------------------------- orders */

export const orders = mysqlTable(
  "orders",
  {
    id: uuidPk(),
    orderNumber: varchar("order_number", { length: 255 }).notNull(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    addressId: varchar("address_id", { length: 36 }).references(
      () => addresses.id,
    ),
    /** Address is snapshotted so later edits never rewrite delivery history. */
    deliveryAddressSnapshot: json("delivery_address_snapshot").$type<{
      line1: string;
      line2?: string | null;
      area?: string | null;
      city: string;
      pincode: string;
      /** Carried forward from the address at order time — delivery-assignment
       * (Slice C) needs the customer's coordinates without re-geocoding. */
      latitude?: string | null;
      longitude?: string | null;
      /** For the rider on an active job (GS-047). */
      landmark?: string | null;
      deliveryInstructions?: string | null;
    } | null>(),
    status: orderStatusEnum("status").notNull().default("PENDING"),
    source: orderSourceEnum("source").notNull().default("DIRECT"),
    orderType: orderTypeEnum("order_type").notNull().default("PERSONAL"),
    paymentMethod: paymentMethodEnum("payment_method")
      .notNull()
      .default("WALLET"),
    /**
     * `checkout:<userId>:<requestId>:<shopId>` — the per-shop idempotency key of
     * the checkout that created the order. Replays of a COD checkout (which has
     * no wallet debit to find) are recognised through it. Null for older and
     * subscription orders.
     */
    checkoutKey: varchar("checkout_key", { length: 255 }),
    /** COD: when the cash was collected (the order counts as paid from then). */
    codCollectedAt: datetime("cod_collected_at", { mode: "date", fsp: 3 }),
    /** Placed after the customer confirmed the shop was closed: processed once it opens. */
    placedWhileClosed: boolean("placed_while_closed").notNull().default(false),
    /** When the shop was expected to open, at the time of ordering (informational). */
    expectedOpenAt: datetime("expected_open_at", { mode: "date", fsp: 3 }),
    /** Set when the "shop is open, orders are waiting" alert has been sent (one alert only). */
    shopOpenAlertSentAt: datetime("shop_open_alert_sent_at", {
      mode: "date",
      fsp: 3,
    }),
    /** Society of the delivery address (society rider rules, security, society visibility). */
    societyId: varchar("society_id", { length: 36 }).references(
      () => societies.id,
      { onDelete: "set null" },
    ),
    /** B2B only: the approved shop buying for its business. Null for PERSONAL. */
    buyerShopId: varchar("buyer_shop_id", { length: 36 }).references(
      () => shops.id,
      { onDelete: "restrict" },
    ),
    subtotalPaise: bigint("subtotal_paise", { mode: "number" }).notNull(),
    deliveryFeePaise: bigint("delivery_fee_paise", { mode: "number" })
      .notNull()
      .default(0),
    taxPaise: bigint("tax_paise", { mode: "number" }).notNull().default(0),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    /** Set once the wallet deduction has actually completed. */
    paidAt: datetime("paid_at", { mode: "date", fsp: 3 }),
    deliveryDate: date("delivery_date", { mode: "string" }),
    notes: text("notes"),
    cancellationReason: text("cancellation_reason"),
    /** Chosen at checkout, when set — see delivery-feasibility.ts. Null for
     * orders placed before this existed, or where no window was offered. */
    deliveryWindow: deliveryWindowEnum("delivery_window"),
    /** The deadline promised for `deliveryWindow`. Never set unless the
     * system determined it was actually achievable at checkout time. */
    promisedByAt: datetime("promised_by_at", { mode: "date", fsp: 3 }),
    /** When the shop accepted the order (CONFIRMED → ACCEPTED). */
    acceptedAt: datetime("accepted_at", { mode: "date", fsp: 3 }),
    /** When the shop finished packing (→ READY). */
    packedAt: datetime("packed_at", { mode: "date", fsp: 3 }),
    /**
     * Paise already refunded while the order continued (removed or cheaper
     * substituted lines). `totalPaise` is reduced by the same amount, so a
     * later cancellation refunds only what is still held.
     */
    refundedPaise: bigint("refunded_paise", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("orders_number_unique").on(t.orderNumber),
    index("orders_user_idx").on(t.userId),
    index("orders_shop_idx").on(t.shopId),
    index("orders_status_idx").on(t.status),
    index("orders_created_idx").on(t.createdAt),
    index("orders_buyer_shop_idx").on(t.buyerShopId),
    index("orders_society_idx").on(t.societyId),
    index("orders_open_alert_pending_idx").on(t.shopId),
    uniqueIndex("orders_checkout_key_unique").on(t.checkoutKey),
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
export const orderItems = mysqlTable(
  "order_items",
  {
    id: uuidPk(),
    orderId: varchar("order_id", { length: 36 })
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    shopProductId: varchar("shop_product_id", { length: 36 })
      .notNull()
      .references(() => shopProducts.id, { onDelete: "restrict" }),
    productNameSnapshot: text("product_name_snapshot").notNull(),
    unitSnapshot: text("unit_snapshot").notNull(),
    unitPricePaise: bigint("unit_price_paise", { mode: "number" }).notNull(),
    /** Milli-units, so 2.5 L is exactly 2500. */
    quantityMilli: int("quantity_milli").notNull(),
    lineTotalPaise: bigint("line_total_paise", { mode: "number" }).notNull(),
    /* ------------------------------------------ fulfilment (Slice 3) —
     * the original snapshot above is never rewritten; a substitute is
     * recorded alongside it so the order keeps its history. */
    fulfilmentStatus: orderItemFulfilmentEnum("fulfilment_status")
      .notNull()
      .default("PENDING"),
    substituteShopProductId: varchar("substitute_shop_product_id", {
      length: 36,
    }).references(() => shopProducts.id, {
      onDelete: "restrict",
    }),
    substituteNameSnapshot: text("substitute_name_snapshot"),
    substituteUnitSnapshot: text("substitute_unit_snapshot"),
    substituteQuantityMilli: int("substitute_quantity_milli"),
    /** What the customer pays for the substitute — never more than the original line. */
    substituteLineTotalPaise: bigint("substitute_line_total_paise", {
      mode: "number",
    }),
    fulfilmentNote: text("fulfilment_note"),
    fulfilmentUpdatedAt: datetime("fulfilment_updated_at", {
      mode: "date",
      fsp: 3,
    }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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

export const orderStatusHistory = mysqlTable(
  "order_status_history",
  {
    id: uuidPk(),
    orderId: varchar("order_id", { length: 36 })
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    previousStatus: orderStatusEnum("previous_status"),
    newStatus: orderStatusEnum("new_status").notNull(),
    changedBy: varchar("changed_by", { length: 36 }).references(() => users.id),
    note: text("note"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index("order_status_history_order_idx").on(t.orderId)],
);

/* ---------------------------------------------------- delivery assignment
 * (delivery-system Part 58 follow-up, Slice C). One row per order for now —
 * multi-order batching (Phase 2) would attach several deliveryOrders to a
 * shared route/batch, not change this table's shape. */

export const deliveryOrderStatusEnum = mysqlEnumType([
  "OFFERED",
  "ACCEPTED",
  "REJECTED",
  "PICKED_UP",
  "DELIVERED",
  "CANCELLED",
  /** Rider could not complete the drop (customer unavailable, etc.). */
  "FAILED",
]);

export const deliveryOrders = mysqlTable(
  "delivery_orders",
  {
    id: uuidPk(),
    orderId: varchar("order_id", { length: 36 })
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    deliveryPartnerId: varchar("delivery_partner_id", { length: 36 })
      .notNull()
      .references(() => deliveryPartners.id, { onDelete: "restrict" }),
    status: deliveryOrderStatusEnum("status").notNull().default("OFFERED"),
    /** Haversine straight-line distance, shop → customer, at assignment time — not a road-distance API call (see haversine.ts). */
    distanceKm: text("distance_km"),
    offeredAt: datetime("offered_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    acceptedAt: datetime("accepted_at", { mode: "date", fsp: 3 }),
    pickedUpAt: datetime("picked_up_at", { mode: "date", fsp: 3 }),
    deliveredAt: datetime("delivered_at", { mode: "date", fsp: 3 }),
    cancelledAt: datetime("cancelled_at", { mode: "date", fsp: 3 }),
    cancellationReason: text("cancellation_reason"),
    /* ---------------------------------------- handover (Slice 4, GS-041/043) */
    /** 4-digit code the shop reads to the rider at pickup; set when the rider accepts. */
    pickupCode: text("pickup_code"),
    /** 4-digit code only the customer sees; set when the rider starts the drop. */
    deliveryOtp: text("delivery_otp"),
    deliveryOtpAttempts: int("delivery_otp_attempts").notNull().default(0),
    outForDeliveryAt: datetime("out_for_delivery_at", { mode: "date", fsp: 3 }),
    /** Rider checkpoints (no status change): reached the shop / reached the customer's door or gate. */
    arrivedAtShopAt: datetime("arrived_at_shop_at", { mode: "date", fsp: 3 }),
    arrivedAtCustomerAt: datetime("arrived_at_customer_at", {
      mode: "date",
      fsp: 3,
    }),
    failedAt: datetime("failed_at", { mode: "date", fsp: 3 }),
    failureReason: text("failure_reason"),
    /** How delivery was confirmed: CUSTOMER_OTP, or OPERATOR_OVERRIDE (proof note required). */
    deliveryConfirmation: text("delivery_confirmation"),
    proofNote: text("proof_note"),
    /** Riders who declined or let this order's offer expire — never re-offered it (GA-009 fallback). */
    rejectedPartnerIds: json("rejected_partner_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    // One active delivery assignment per order, pre-batching.
    uniqueIndex("delivery_orders_order_id_unique").on(t.orderId),
    index("delivery_orders_partner_idx").on(t.deliveryPartnerId),
    index("delivery_orders_status_idx").on(t.status),
  ],
);

/**
 * "Find rider" search state, one row per order (see delivery-assignment.ts).
 * Tracks how long and how often the platform has tried to match a rider so
 * retries are bounded by configurable rules rather than looping forever.
 */
export const riderSearches = mysqlTable(
  "rider_searches",
  {
    id: uuidPk(),
    orderId: varchar("order_id", { length: 36 })
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    status: varchar("status", {
      length: 255,
      enum: ["SEARCHING", "ASSIGNED", "STOPPED"],
    })
      .notNull()
      .default("SEARCHING"),
    stopReason: text("stop_reason", {
      enum: [
        "RIDER_ACCEPTED",
        "ORDER_CANCELLED",
        "ORDER_NOT_READY",
        "WINDOW_EXPIRED",
        "RETRY_LIMIT",
        "TIME_LIMIT",
        "STOPPED_BY_SHOP",
      ],
    }),
    attempts: int("attempts").notNull().default(0),
    /** Rule values in force when the search (re)started, so a later rule change never moves the goalposts. */
    maxAttempts: int("max_attempts").notNull(),
    startedAt: datetime("started_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    lastAttemptAt: datetime("last_attempt_at", { mode: "date", fsp: 3 }),
    nextAttemptAt: datetime("next_attempt_at", { mode: "date", fsp: 3 }),
    stoppedAt: datetime("stopped_at", { mode: "date", fsp: 3 }),
    startedBy: varchar("started_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("rider_searches_order_unique").on(t.orderId),
    index("rider_searches_status_next_idx").on(t.status, t.nextAttemptAt),
  ],
);

/** One row per matching attempt — who triggered it, and what came of it. */
export const dispatchAttempts = mysqlTable(
  "dispatch_attempts",
  {
    id: uuidPk(),
    orderId: varchar("order_id", { length: 36 })
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    searchId: varchar("search_id", { length: 36 }).references(
      () => riderSearches.id,
      { onDelete: "set null" },
    ),
    attemptNo: int("attempt_no").notNull(),
    trigger: text("trigger", {
      enum: ["SHOP_MANUAL", "AUTO_READY", "SWEEP", "REOFFER"],
    }).notNull(),
    outcome: varchar("outcome", {
      length: 255,
      enum: ["OFFERED", "NO_RIDER", "STOPPED", "ERROR"],
    }).notNull(),
    deliveryOrderId: varchar("delivery_order_id", { length: 36 }).references(
      () => deliveryOrders.id,
      { onDelete: "set null" },
    ),
    deliveryPartnerId: varchar("delivery_partner_id", {
      length: 36,
    }).references(() => deliveryPartners.id, { onDelete: "set null" }),
    detail: text("detail"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index("dispatch_attempts_order_idx").on(t.orderId, t.createdAt)],
);

/**
 * Admin-configurable earnings rates (Part 58 §11) — same "one active row"
 * pattern as registrationFees. Changes are audited via recordAudit(), not a
 * dedicated history table: lower-stakes than the registration fee, which
 * has direct legal/billing weight.
 */
export const deliveryEarningsConfig = mysqlTable(
  "delivery_earnings_config",
  {
    id: uuidPk(),
    baseFeePaise: bigint("base_fee_paise", { mode: "number" }).notNull(),
    perKmFeePaise: bigint("per_km_fee_paise", { mode: "number" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    note: text("note"),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    check(
      "delivery_earnings_config_non_negative",
      sql`${t.baseFeePaise} >= 0 AND ${t.perKmFeePaise} >= 0`,
    ),
  ],
);

/** One row per completed delivery — the "transparent, delivery-wise earnings statement" the brief calls for. Idempotent on deliveryOrderId. */
export const deliveryPartnerEarnings = mysqlTable(
  "delivery_partner_earnings",
  {
    id: uuidPk(),
    deliveryPartnerId: varchar("delivery_partner_id", { length: 36 }).notNull(),
    /** Null for a return-pickup earning (see returnPickupId). */
    deliveryOrderId: varchar("delivery_order_id", { length: 36 }),
    /** Set for the flat fee a rider earns for collecting a customer return. */
    returnPickupId: varchar("return_pickup_id", { length: 36 }),
    basePaise: bigint("base_paise", { mode: "number" }).notNull(),
    distancePaise: bigint("distance_paise", { mode: "number" }).notNull(),
    /* Breakdown added with the slot/incentive engine. `totalPaise` is the net
     * the rider is paid: base + distance + order component + slot incentive +
     * minimum top-up + order incentive + other incentive − deductions. */
    orderComponentPaise: bigint("order_component_paise", { mode: "number" })
      .notNull()
      .default(0),
    slotIncentivePaise: bigint("slot_incentive_paise", { mode: "number" })
      .notNull()
      .default(0),
    minTopUpPaise: bigint("min_top_up_paise", { mode: "number" })
      .notNull()
      .default(0),
    orderIncentivePaise: bigint("order_incentive_paise", { mode: "number" })
      .notNull()
      .default(0),
    otherIncentivePaise: bigint("other_incentive_paise", { mode: "number" })
      .notNull()
      .default(0),
    deductionsPaise: bigint("deductions_paise", { mode: "number" })
      .notNull()
      .default(0),
    /** The slot whose rates applied (null when none matched and the default rates were used). */
    slotId: varchar("slot_id", { length: 36 }),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    /** Set when this earning is included in a rider payout batch (GS-064). */
    payoutId: varchar("payout_id", { length: 36 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    // Named explicitly: Drizzle's auto-generated name for this foreign key is
    // longer than MySQL's 64-character identifier limit, which MySQL rejects
    // outright (PostgreSQL silently truncated it).
    foreignKey({
      columns: [t.deliveryOrderId],
      foreignColumns: [deliveryOrders.id],
      name: "dp_earnings_order_fk",
    }).onDelete("restrict"),
    // Named explicitly: Drizzle's auto-generated name for this foreign key is
    // longer than MySQL's 64-character identifier limit, which MySQL rejects
    // outright (PostgreSQL silently truncated it).
    foreignKey({
      columns: [t.deliveryPartnerId],
      foreignColumns: [deliveryPartners.id],
      name: "dp_earnings_partner_fk",
    }).onDelete("restrict"),
    uniqueIndex("delivery_partner_earnings_order_unique").on(t.deliveryOrderId),
    uniqueIndex("delivery_partner_earnings_return_unique").on(t.returnPickupId),
    index("delivery_partner_earnings_payout_idx").on(t.payoutId),
    index("delivery_partner_earnings_partner_idx").on(t.deliveryPartnerId),
  ],
);

/* ------------------------------------------------------ shop suspensions
 * One row per suspension, with what the policy did to each open order at that
 * moment, so operations can see the impact and resolve the orders that need a
 * decision (services/shop-suspension.ts).
 */
export const shopSuspensions = mysqlTable(
  "shop_suspensions",
  {
    id: uuidPk(),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    /** What the owner is expected to do (shown in the notice), e.g. "Upload a valid FSSAI licence". */
    expectedAction: text("expected_action").notNull(),
    suspendedBy: varchar("suspended_by", { length: 36 }).references(
      () => users.id,
    ),
    effectiveAt: datetime("effective_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    status: varchar("status", { length: 255, enum: ["ACTIVE", "LIFTED"] })
      .notNull()
      .default("ACTIVE"),
    liftedAt: datetime("lifted_at", { mode: "date", fsp: 3 }),
    liftedBy: varchar("lifted_by", { length: 36 }).references(() => users.id),
    liftNote: text("lift_note"),
    /** Policy in force and the counts it produced — a snapshot, not a live view. */
    policy: json("policy")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    impact: json("impact")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    /**
     * MySQL has no partial indexes, so the predicate of the old PostgreSQL
     * partial UNIQUE index lives in this generated column: it is NULL when the
     * predicate is false, and MySQL's UNIQUE ignores NULLs. Verified against
     * both engines -- a second matching row is rejected with a duplicate-key
     * error, non-matching rows are unconstrained, and leaving the predicate
     * frees the slot again.
     *
     * VIRTUAL, not STORED. MySQL refuses a foreign key with ON DELETE CASCADE
     * on any column a STORED generated column is built from (ER_CANNOT_ADD_
     * FOREIGN), and five of these columns are built from exactly such a
     * column. For a VIRTUAL column only ON UPDATE CASCADE is disallowed, which
     * nothing here uses. MariaDB accepts both forms, so this only shows up on
     * MySQL -- it was caught by CI, not by local testing.
     */
    activeShopKey: varchar("active_shop_key", { length: 36 }).generatedAlwaysAs(
      sql`CASE WHEN status = 'ACTIVE' THEN shop_id END`,
      { mode: "virtual" },
    ),
  },
  (t) => [
    index("shop_suspensions_shop_idx").on(t.shopId, t.createdAt),
    uniqueIndex("shop_suspensions_one_active").on(t.activeShopKey),
  ],
);

export const shopSuspensionOrders = mysqlTable(
  "shop_suspension_orders",
  {
    id: uuidPk(),
    suspensionId: varchar("suspension_id", { length: 36 })
      .notNull()
      .references(() => shopSuspensions.id, { onDelete: "cascade" }),
    orderId: varchar("order_id", { length: 36 })
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    statusAtSuspension: text("status_at_suspension").notNull(),
    plannedAction: text("planned_action", {
      enum: ["CANCEL_REFUND", "CONTINUE", "REVIEW"],
    }).notNull(),
    /** CANCELLED: refunded and closed. CONTINUING: the shop finishes it. AWAITING_REVIEW: an operator decides. FAILED: the automatic action could not run — an operator must act. */
    outcome: varchar("outcome", {
      length: 255,
      enum: ["CANCELLED", "CONTINUING", "AWAITING_REVIEW", "FAILED"],
    }).notNull(),
    note: text("note"),
    resolvedBy: varchar("resolved_by", { length: 36 }).references(
      () => users.id,
    ),
    resolvedAt: datetime("resolved_at", { mode: "date", fsp: 3 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("shop_suspension_orders_unique").on(t.suspensionId, t.orderId),
    index("shop_suspension_orders_order_idx").on(t.orderId),
    index("shop_suspension_orders_outcome_idx").on(t.outcome),
  ],
);

/* ------------------------------------------- external price references
 * A reference price seen OUTSIDE Gokesari (a mandi, a manufacturer list, a
 * survey). It is information — never the shop's selling price and never the
 * MRP, and nothing here writes to either (services/price-references.ts).
 * Changes are appended to the history table.
 */
export const externalPriceReferences = mysqlTable(
  "external_price_references",
  {
    id: uuidPk(),
    productId: varchar("product_id", { length: 36 })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    pricePaise: bigint("price_paise", { mode: "number" }).notNull(),
    /** What the price is for, e.g. "per 500 g pack" or "per kg, loose". */
    unitBasis: text("unit_basis"),
    sourceType: text("source_type", {
      enum: [
        "MARKET_SURVEY",
        "MANUFACTURER",
        "GOVT_MANDI",
        "PARTNER_FEED",
        "PMD_IMPORT",
        "OTHER",
      ],
    }).notNull(),
    sourceName: text("source_name").notNull(),
    /** The source's own identifier for the listing or record, where it has one. */
    sourceIdentifier: text("source_identifier"),
    referenceUrl: text("reference_url"),
    /** Where the price applies: market / city / locality. */
    marketLocation: text("market_location"),
    pincode: text("pincode"),
    /** When the price was observed at the source (not when it was entered). */
    referencedAt: datetime("referenced_at", { mode: "date", fsp: 3 }).notNull(),
    verificationStatus: varchar("verification_status", {
      length: 255,
      enum: ["UNVERIFIED", "VERIFIED", "REJECTED"],
    })
      .notNull()
      .default("UNVERIFIED"),
    verifiedBy: varchar("verified_by", { length: 36 }).references(
      () => users.id,
    ),
    verifiedAt: datetime("verified_at", { mode: "date", fsp: 3 }),
    verificationNote: text("verification_note"),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("external_price_refs_product_idx").on(t.productId, t.referencedAt),
    check("external_price_refs_price_positive", sql`${t.pricePaise} > 0`),
  ],
);

export const externalPriceReferenceHistory = mysqlTable(
  "external_price_reference_history",
  {
    id: uuidPk(),
    referenceId: varchar("reference_id", { length: 36 }).notNull(),
    action: text("action", {
      enum: ["CREATED", "EDITED", "VERIFIED", "REJECTED", "REOPENED"],
    }).notNull(),
    previous: json("previous").$type<Record<string, unknown> | null>(),
    next: json("next").$type<Record<string, unknown>>().notNull(),
    note: text("note"),
    actorId: varchar("actor_id", { length: 36 }).references(() => users.id),
    actorRole: text("actor_role"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    // Named explicitly: Drizzle's auto-generated name for this foreign key is
    // longer than MySQL's 64-character identifier limit, which MySQL rejects
    // outright (PostgreSQL silently truncated it).
    foreignKey({
      columns: [t.referenceId],
      foreignColumns: [externalPriceReferences.id],
      name: "eprh_reference_fk",
    }).onDelete("cascade"),
    index("external_price_ref_history_idx").on(t.referenceId, t.createdAt),
  ],
);

/**
 * A shop owner's claim that the master MRP is wrong. The claimed figure lives
 * here until an operator decides; it never reaches products.mrp_paise on its own.
 */
export const mrpCorrections = mysqlTable(
  "mrp_corrections",
  {
    id: uuidPk(),
    productId: varchar("product_id", { length: 36 })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    shopId: varchar("shop_id", { length: 36 }).references(() => shops.id, {
      onDelete: "set null",
    }),
    claimedMrpPaise: bigint("claimed_mrp_paise", { mode: "number" }).notNull(),
    note: text("note"),
    submittedBy: varchar("submitted_by", { length: 36 })
      .notNull()
      .references(() => users.id),
    status: varchar("status", {
      length: 255,
      enum: ["PENDING", "ACCEPTED", "REJECTED"],
    })
      .notNull()
      .default("PENDING"),
    /** The product's verification status before the dispute, restored if the claim is rejected. */
    previousVerificationStatus: text("previous_verification_status"),
    decidedBy: varchar("decided_by", { length: 36 }).references(() => users.id),
    decidedAt: datetime("decided_at", { mode: "date", fsp: 3 }),
    decisionNote: text("decision_note"),
    appliedMrpPaise: bigint("applied_mrp_paise", { mode: "number" }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("mrp_corrections_status_idx").on(t.status, t.createdAt),
    index("mrp_corrections_product_idx").on(t.productId),
    check("mrp_corrections_claim_non_negative", sql`${t.claimedMrpPaise} >= 0`),
  ],
);

/* ------------------------------------------------------- stored images
 * Uploaded images (product photos, return evidence). Kept in the database so
 * they survive redeploys on hosts with an ephemeral filesystem; the browser
 * shrinks them before upload (components/image-uploader.tsx) and the server
 * re-validates type, size and dimensions (services/image-store.ts).
 */
export const storedImages = mysqlTable(
  "stored_images",
  {
    id: uuidPk(),
    ownerId: varchar("owner_id", { length: 36 }).references(() => users.id, {
      onDelete: "set null",
    }),
    purpose: text("purpose", {
      enum: ["PRODUCT", "RETURN_EVIDENCE"],
    }).notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: int("size_bytes").notNull(),
    width: int("width").notNull(),
    height: int("height").notNull(),
    sha256: varchar("sha256", { length: 255 }).notNull(),
    data: blob("data").notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("stored_images_owner_idx").on(t.ownerId),
    index("stored_images_sha_idx").on(t.sha256),
  ],
);

/* ------------------------------------------------------------- returns
 * Request → validation → approval → pickup → inspection → refund
 * (lib/return-states.ts has the state machine; services/returns.ts drives it).
 */
export const returnRequests = mysqlTable(
  "return_requests",
  {
    id: uuidPk(),
    returnNumber: varchar("return_number", { length: 255 }).notNull(),
    orderId: varchar("order_id", { length: 36 })
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 255, enum: RETURN_STATUSES })
      .notNull()
      .default("RETURN_REQUESTED"),
    reason: text("reason", { enum: RETURN_REASONS }).notNull(),
    comment: text("comment"),
    /** Goods-only value of the requested items, worked out at request time. */
    refundAmountPaise: bigint("refund_amount_paise", {
      mode: "number",
    }).notNull(),
    /** Who bears the refund, decided by the reason's policy when the request is made. */
    chargeTo: text("charge_to", { enum: ["SHOP", "PLATFORM"] }).notNull(),
    /** True when a rider collects the goods; false when the customer hands them to the shop. */
    pickupRequired: boolean("pickup_required").notNull().default(true),
    pickupAddress: json("pickup_address").$type<Record<string, unknown>>(),
    /** Set once the refund has actually been paid; the amount may be lower than requested after inspection. */
    refundedPaise: bigint("refunded_paise", { mode: "number" }),
    refundAdjustmentId: varchar("refund_adjustment_id", { length: 36 }),
    decidedBy: varchar("decided_by", { length: 36 }).references(() => users.id),
    decidedAt: datetime("decided_at", { mode: "date", fsp: 3 }),
    decisionNote: text("decision_note"),
    inspectedBy: varchar("inspected_by", { length: 36 }).references(
      () => users.id,
    ),
    inspectedAt: datetime("inspected_at", { mode: "date", fsp: 3 }),
    inspectionNote: text("inspection_note"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("return_requests_number_unique").on(t.returnNumber),
    index("return_requests_order_idx").on(t.orderId),
    index("return_requests_user_idx").on(t.userId, t.createdAt),
    index("return_requests_shop_status_idx").on(t.shopId, t.status),
    check(
      "return_requests_refund_non_negative",
      sql`${t.refundAmountPaise} >= 0`,
    ),
  ],
);

export const returnItems = mysqlTable(
  "return_items",
  {
    id: uuidPk(),
    returnId: varchar("return_id", { length: 36 })
      .notNull()
      .references(() => returnRequests.id, { onDelete: "cascade" }),
    orderItemId: varchar("order_item_id", { length: 36 })
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    /** Milli-units being returned (same scale as order_items.quantity_milli). */
    quantityMilli: int("quantity_milli").notNull(),
    condition: text("condition", { enum: RETURN_CONDITIONS }).notNull(),
    comment: text("comment"),
    /** stored_images ids showing the item. */
    imageIds: json("image_ids").$type<string[]>().notNull().default([]),
    refundPaise: bigint("refund_paise", { mode: "number" }).notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("return_items_return_idx").on(t.returnId),
    index("return_items_order_item_idx").on(t.orderItemId),
    check("return_items_quantity_positive", sql`${t.quantityMilli} > 0`),
  ],
);

export const returnStatusHistory = mysqlTable(
  "return_status_history",
  {
    id: uuidPk(),
    returnId: varchar("return_id", { length: 36 })
      .notNull()
      .references(() => returnRequests.id, { onDelete: "cascade" }),
    fromStatus: text("from_status", { enum: RETURN_STATUSES }),
    toStatus: text("to_status", { enum: RETURN_STATUSES }).notNull(),
    changedBy: varchar("changed_by", { length: 36 }).references(() => users.id),
    changedByRole: text("changed_by_role"),
    note: text("note"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("return_status_history_return_idx").on(t.returnId, t.createdAt),
  ],
);

/** A rider's collection of returned goods from the customer, back to the shop. */
export const returnPickups = mysqlTable(
  "return_pickups",
  {
    id: uuidPk(),
    returnId: varchar("return_id", { length: 36 })
      .notNull()
      .references(() => returnRequests.id, { onDelete: "cascade" }),
    deliveryPartnerId: varchar("delivery_partner_id", {
      length: 36,
    }).references(() => deliveryPartners.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 255, enum: PICKUP_STATUSES })
      .notNull()
      .default("PENDING"),
    /** Window the customer is asked to be ready in (start); the rider sees it. */
    scheduledFor: datetime("scheduled_for", { mode: "date", fsp: 3 }),
    /** Read out by the customer at handover; the rider must enter it. Never sent to the rider. */
    handoverCode: text("handover_code").notNull(),
    handoverAttempts: int("handover_attempts").notNull().default(0),
    offeredAt: datetime("offered_at", { mode: "date", fsp: 3 }),
    acceptedAt: datetime("accepted_at", { mode: "date", fsp: 3 }),
    enRouteAt: datetime("en_route_at", { mode: "date", fsp: 3 }),
    pickedUpAt: datetime("picked_up_at", { mode: "date", fsp: 3 }),
    failedAt: datetime("failed_at", { mode: "date", fsp: 3 }),
    failureReason: text("failure_reason"),
    /** Riders who declined or let the offer lapse — never re-offered this pickup. */
    rejectedPartnerIds: json("rejected_partner_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    attempts: int("attempts").notNull().default(0),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    /**
     * MySQL has no partial indexes, so the predicate of the old PostgreSQL
     * partial UNIQUE index lives in this generated column: it is NULL when the
     * predicate is false, and MySQL's UNIQUE ignores NULLs. Verified against
     * both engines -- a second matching row is rejected with a duplicate-key
     * error, non-matching rows are unconstrained, and leaving the predicate
     * frees the slot again.
     *
     * VIRTUAL, not STORED. MySQL refuses a foreign key with ON DELETE CASCADE
     * on any column a STORED generated column is built from (ER_CANNOT_ADD_
     * FOREIGN), and five of these columns are built from exactly such a
     * column. For a VIRTUAL column only ON UPDATE CASCADE is disallowed, which
     * nothing here uses. MariaDB accepts both forms, so this only shows up on
     * MySQL -- it was caught by CI, not by local testing.
     */
    liveReturnKey: varchar("live_return_key", { length: 36 }).generatedAlwaysAs(
      sql`CASE WHEN status IN ('PENDING','OFFERED','ACCEPTED','EN_ROUTE') THEN return_id END`,
      { mode: "virtual" },
    ),
  },
  (t) => [
    index("return_pickups_return_idx").on(t.returnId),
    index("return_pickups_partner_idx").on(t.deliveryPartnerId, t.status),
    // One live pickup per return.
    uniqueIndex("return_pickups_one_live").on(t.liveReturnKey),
  ],
);

/* ------------------------------------------------- rider earnings engine
 * Configurable slots (Morning / Evening / custom range), each with its own
 * rates, plus incentive rules. Every completed delivery's earning is computed
 * from these (services/delivery-earnings.ts) and written as a breakdown on
 * delivery_partner_earnings plus append-only lines in rider_earnings_ledger.
 */

/** Local-time window (APP_TIMEZONE) with its own earning rates. NULL rates fall back to the default config. */
export const riderEarningSlots = mysqlTable(
  "rider_earning_slots",
  {
    id: uuidPk(),
    name: text("name").notNull(),
    /** "HH:MM" local start (inclusive) and end (exclusive); end < start means the window crosses midnight. */
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    /** Weekdays (0 = Sunday .. 6) the slot applies to; empty = every day. */
    daysOfWeek: json("days_of_week").$type<number[]>().notNull().default([]),
    baseFeePaise: bigint("base_fee_paise", { mode: "number" }),
    perKmFeePaise: bigint("per_km_fee_paise", { mode: "number" }),
    /** Floor for one order's earning in this slot (before incentives). */
    minEarningPaise: bigint("min_earning_paise", { mode: "number" }),
    /** Order-based component: flat amount plus a share of the order subtotal (basis points). */
    orderFeePaise: bigint("order_fee_paise", { mode: "number" })
      .notNull()
      .default(0),
    orderPercentBp: int("order_percent_bp").notNull().default(0),
    /** Peak-period component paid on top in this slot. */
    peakBonusPaise: bigint("peak_bonus_paise", { mode: "number" })
      .notNull()
      .default(0),
    isPeak: boolean("is_peak").notNull().default(false),
    /** The highest-priority active slot containing the delivery time wins. */
    priority: int("priority").notNull().default(0),
    validFrom: date("valid_from", { mode: "string" }),
    validTo: date("valid_to", { mode: "string" }),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    check(
      "rider_slots_percent_range",
      sql`${t.orderPercentBp} BETWEEN 0 AND 10000`,
    ),
    check(
      "rider_slots_amounts_non_negative",
      sql`${t.orderFeePaise} >= 0 AND ${t.peakBonusPaise} >= 0
          AND (${t.baseFeePaise} IS NULL OR ${t.baseFeePaise} >= 0)
          AND (${t.perKmFeePaise} IS NULL OR ${t.perKmFeePaise} >= 0)
          AND (${t.minEarningPaise} IS NULL OR ${t.minEarningPaise} >= 0)`,
    ),
  ],
);

/**
 * Incentive rules. `thresholdValue` is in orders for ORDER_COUNT / DAILY_TARGET /
 * WEEKLY_TARGET and in metres for DISTANCE.
 *  ORDER_COUNT   — `rewardPaise` on every delivery beyond the Nth in the period
 *  DAILY_TARGET  — one-off reward on the delivery that reaches N in a day
 *  WEEKLY_TARGET — one-off reward on the delivery that reaches N in a week
 *  DISTANCE      — reward on a delivery whose leg is at least the threshold
 *  PEAK_HOUR     — reward on a delivery inside the rule's own time window
 *  CAMPAIGN      — reward on every delivery while the campaign window is live
 */
export const riderIncentiveRules = mysqlTable(
  "rider_incentive_rules",
  {
    id: uuidPk(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type", {
      enum: [
        "ORDER_COUNT",
        "DAILY_TARGET",
        "WEEKLY_TARGET",
        "DISTANCE",
        "PEAK_HOUR",
        "CAMPAIGN",
      ],
    }).notNull(),
    thresholdValue: int("threshold_value").notNull().default(0),
    rewardPaise: bigint("reward_paise", { mode: "number" }).notNull(),
    /** ORDER_COUNT counts deliveries per DAY or per WEEK. */
    period: varchar("period", { length: 255, enum: ["DAY", "WEEK"] })
      .notNull()
      .default("DAY"),
    startTime: text("start_time"),
    endTime: text("end_time"),
    daysOfWeek: json("days_of_week").$type<number[]>().notNull().default([]),
    validFrom: date("valid_from", { mode: "string" }),
    validTo: date("valid_to", { mode: "string" }),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [check("rider_incentive_reward_positive", sql`${t.rewardPaise} > 0`)],
);

/** One row per incentive actually paid; the unique key stops a target being paid twice for the same period. */
export const riderIncentiveAwards = mysqlTable(
  "rider_incentive_awards",
  {
    id: uuidPk(),
    ruleId: varchar("rule_id", { length: 36 })
      .notNull()
      .references(() => riderIncentiveRules.id, { onDelete: "restrict" }),
    deliveryPartnerId: varchar("delivery_partner_id", { length: 36 }).notNull(),
    earningId: varchar("earning_id", { length: 36 }),
    /** Day key, ISO-week key, or the delivery order id for per-order rewards. */
    periodKey: varchar("period_key", { length: 255 }).notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    // Named explicitly: Drizzle's auto-generated name for this foreign key is
    // longer than MySQL's 64-character identifier limit, which MySQL rejects
    // outright (PostgreSQL silently truncated it).
    foreignKey({
      columns: [t.earningId],
      foreignColumns: [deliveryPartnerEarnings.id],
      name: "incentive_awards_earning_fk",
    }).onDelete("set null"),
    // Named explicitly: Drizzle's auto-generated name for this foreign key is
    // longer than MySQL's 64-character identifier limit, which MySQL rejects
    // outright (PostgreSQL silently truncated it).
    foreignKey({
      columns: [t.deliveryPartnerId],
      foreignColumns: [deliveryPartners.id],
      name: "incentive_awards_partner_fk",
    }).onDelete("restrict"),
    uniqueIndex("rider_incentive_awards_unique").on(
      t.ruleId,
      t.deliveryPartnerId,
      t.periodKey,
    ),
  ],
);

/** Append-only audit lines behind every earning: the components sum to the earning's net total. */
export const riderEarningsLedger = mysqlTable(
  "rider_earnings_ledger",
  {
    id: uuidPk(),
    deliveryPartnerId: varchar("delivery_partner_id", { length: 36 }).notNull(),
    earningId: varchar("earning_id", { length: 36 })
      .notNull()
      .references(() => deliveryPartnerEarnings.id, { onDelete: "cascade" }),
    deliveryOrderId: varchar("delivery_order_id", { length: 36 }).references(
      () => deliveryOrders.id,
      { onDelete: "set null" },
    ),
    component: text("component", {
      enum: [
        "BASE",
        "DISTANCE",
        "ORDER_COMPONENT",
        "SLOT_INCENTIVE",
        "MIN_TOP_UP",
        "ORDER_INCENTIVE",
        "OTHER_INCENTIVE",
        "DEDUCTION",
      ],
    }).notNull(),
    /** Signed: deductions are negative. */
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    description: text("description").notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    // Named explicitly: Drizzle's auto-generated name for this foreign key is
    // longer than MySQL's 64-character identifier limit, which MySQL rejects
    // outright (PostgreSQL silently truncated it).
    foreignKey({
      columns: [t.deliveryPartnerId],
      foreignColumns: [deliveryPartners.id],
      name: "earnings_ledger_partner_fk",
    }).onDelete("restrict"),
    index("rider_earnings_ledger_earning_idx").on(t.earningId),
    index("rider_earnings_ledger_partner_idx").on(
      t.deliveryPartnerId,
      t.createdAt,
    ),
  ],
);

/* ------------------------------------------------------------- payments */

export const payments = mysqlTable(
  "payments",
  {
    id: uuidPk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    gateway: varchar("gateway", { length: 255 }).notNull().default("CASHFREE"),
    /** Cashfree order id — unique so one intent cannot be created twice. */
    gatewayOrderId: varchar("gateway_order_id", { length: 255 }).notNull(),
    /** Cashfree payment id (cf_payment_id) — UNIQUE, which is what blocks replayed callbacks. */
    gatewayPaymentId: varchar("gateway_payment_id", { length: 255 }),
    gatewaySignature: text("gateway_signature"),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 255 }).notNull().default("INR"),
    status: paymentStatusEnum("status").notNull().default("CREATED"),
    purpose: varchar("purpose", { length: 255, enum: ["WALLET_TOPUP"] })
      .notNull()
      .default("WALLET_TOPUP"),
    failureReason: text("failure_reason"),
    rawPayload: json("raw_payload"),
    /**
     * The voucher code committed to at order-creation time (§19, §32) — read
     * back at verification rather than re-accepted from the client, so a
     * caller cannot swap in a better voucher after the price/amount was
     * already fixed. Null when no voucher was applied.
     */
    voucherCode: text("voucher_code"),
    verifiedAt: datetime("verified_at", { mode: "date", fsp: 3 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("payments_gateway_order_unique").on(t.gatewayOrderId),
    uniqueIndex("payments_gateway_payment_unique").on(t.gatewayPaymentId),
    index("payments_user_idx").on(t.userId),
    check("payments_amount_positive", sql`${t.amountPaise} > 0`),
  ],
);

/* --------------------------------------------------------------- wallet */

export const wallets = mysqlTable(
  "wallets",
  {
    id: uuidPk(),
    userId: varchar("user_id", { length: 36 })
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
    currency: varchar("currency", { length: 255 }).notNull().default("INR"),
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
    status: varchar("status", { length: 255, enum: ["ACTIVE", "FROZEN"] })
      .notNull()
      .default("ACTIVE"),
    lowBalanceNotifiedAt: datetime("low_balance_notified_at", {
      mode: "date",
      fsp: 3,
    }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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
export const walletTransactions = mysqlTable(
  "wallet_transactions",
  {
    id: uuidPk(),
    walletId: varchar("wallet_id", { length: 36 })
      .notNull()
      .references(() => wallets.id, { onDelete: "restrict" }),
    userId: varchar("user_id", { length: 36 })
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
    orderId: varchar("order_id", { length: 36 }).references(() => orders.id),
    subscriptionId: varchar("subscription_id", { length: 36 }),
    paymentId: varchar("payment_id", { length: 36 }).references(
      () => payments.id,
    ),
    reversalOfId: varchar("reversal_of_id", { length: 36 }),
    /**
     * voucher_redemptions.id — a plain uuid rather than .references() because
     * voucher_redemptions is declared later in this file (same rationale as
     * shops.registration_fee_id above); the FK constraint is added via raw
     * SQL in the migration once that table exists.
     */
    voucherRedemptionId: varchar("voucher_redemption_id", { length: 36 }),
    /**
     * UNIQUE. This single index is what makes every wallet mutation safely
     * retryable: a duplicate attempt collides here instead of double-charging.
     */
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    description: text("description").notNull(),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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
export const vouchers = mysqlTable(
  "vouchers",
  {
    id: uuidPk(),
    name: text("name").notNull(),
    /** Stored upper-cased; NULL when applyMode is AUTO_APPLY. */
    code: varchar("code", { length: 255 }),
    description: text("description"),
    termsAndConditions: text("terms_and_conditions"),
    applyMode: voucherApplyModeEnum("apply_mode").notNull().default("CODE"),
    /** Basis points would overcomplicate this; whole/fractional percent as numeric. */
    bonusPercent: bigint("bonus_percent", { mode: "number" }).notNull(),
    minimumTopupPaise: bigint("minimum_topup_paise", { mode: "number" })
      .notNull()
      .default(0),
    maximumBonusPaise: bigint("maximum_bonus_paise", { mode: "number" }),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    /** NULL = unlimited. */
    usageLimit: int("usage_limit"),
    perCustomerLimit: int("per_customer_limit").notNull().default(1),
    /** NULL = unlimited promotional liability. */
    totalBudgetPaise: bigint("total_budget_paise", { mode: "number" }),
    /** Running total of bonus paise issued — maintained atomically with every redemption. */
    budgetUsedPaise: bigint("budget_used_paise", { mode: "number" })
      .notNull()
      .default(0),
    redemptionCount: int("redemption_count").notNull().default(0),
    status: voucherStatusEnum("status").notNull().default("DRAFT"),
    /** Free-text scope hook for §26 (category/shop restriction) — unused by
     *  the engine in this first implementation, which applies vouchers to any
     *  eligible top-up per the brief's explicit "for the first implementation" scope. */
    applicableScope: text("applicable_scope"),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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
    check(
      "vouchers_minimum_topup_non_negative",
      sql`${t.minimumTopupPaise} >= 0`,
    ),
    check(
      "vouchers_maximum_bonus_non_negative",
      sql`${t.maximumBonusPaise} IS NULL OR ${t.maximumBonusPaise} >= 0`,
    ),
    check("vouchers_dates_valid", sql`${t.endDate} >= ${t.startDate}`),
    check(
      "vouchers_usage_limit_positive",
      sql`${t.usageLimit} IS NULL OR ${t.usageLimit} > 0`,
    ),
    check(
      "vouchers_per_customer_limit_positive",
      sql`${t.perCustomerLimit} > 0`,
    ),
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
export const voucherRedemptions = mysqlTable(
  "voucher_redemptions",
  {
    id: uuidPk(),
    voucherId: varchar("voucher_id", { length: 36 })
      .notNull()
      .references(() => vouchers.id, { onDelete: "restrict" }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    walletId: varchar("wallet_id", { length: 36 })
      .notNull()
      .references(() => wallets.id, { onDelete: "restrict" }),
    paymentId: varchar("payment_id", { length: 36 }).references(
      () => payments.id,
    ),
    topupAmountPaise: bigint("topup_amount_paise", {
      mode: "number",
    }).notNull(),
    bonusPercent: bigint("bonus_percent", { mode: "number" }).notNull(),
    bonusAmountPaise: bigint("bonus_amount_paise", {
      mode: "number",
    }).notNull(),
    status: voucherRedemptionStatusEnum("status").notNull().default("PENDING"),
    /**
     * Idempotency anchor: one redemption per payment. A retried/duplicate
     * verify call for the same payment can never double-apply the bonus.
     */
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("voucher_redemptions_idempotency_unique").on(t.idempotencyKey),
    index("voucher_redemptions_voucher_idx").on(t.voucherId),
    index("voucher_redemptions_user_idx").on(t.userId),
    check(
      "voucher_redemptions_amounts_non_negative",
      sql`${t.topupAmountPaise} >= 0 AND ${t.bonusAmountPaise} >= 0`,
    ),
  ],
);

/** One uploaded voucher spreadsheet (§16), mirroring excel_uploads' two-phase shape. */
export const voucherUploads = mysqlTable(
  "voucher_uploads",
  {
    id: uuidPk(),
    uploadedBy: varchar("uploaded_by", { length: 36 })
      .notNull()
      .references(() => users.id),
    fileName: text("file_name").notNull(),
    status: voucherUploadStatusEnum("status").notNull().default("VALIDATED"),
    totalRecords: int("total_records").notNull().default(0),
    successfulRecords: int("successful_records").notNull().default(0),
    failedRecords: int("failed_records").notNull().default(0),
    summary: json("summary").$type<Record<string, unknown>>(),
    appliedAt: datetime("applied_at", { mode: "date", fsp: 3 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index("voucher_uploads_uploader_idx").on(t.uploadedBy)],
);

export const voucherUploadItems = mysqlTable(
  "voucher_upload_items",
  {
    id: uuidPk(),
    uploadId: varchar("upload_id", { length: 36 })
      .notNull()
      .references(() => voucherUploads.id, { onDelete: "cascade" }),
    rowNumber: int("row_number").notNull(),
    rawData: json("raw_data").$type<Record<string, unknown>>(),
    voucherName: text("voucher_name"),
    voucherCode: text("voucher_code"),
    status: voucherUploadRowStatusEnum("status").notNull(),
    errorMessage: text("error_message"),
    createdVoucherId: varchar("created_voucher_id", { length: 36 }).references(
      () => vouchers.id,
      {
        onDelete: "set null",
      },
    ),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("voucher_upload_items_row_unique").on(t.uploadId, t.rowNumber),
    index("voucher_upload_items_upload_idx").on(t.uploadId),
  ],
);

/* --------------------------------------------------------- subscriptions */

export const subscriptions = mysqlTable(
  "subscriptions",
  {
    id: uuidPk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    shopProductId: varchar("shop_product_id", { length: 36 })
      .notNull()
      .references(() => shopProducts.id, { onDelete: "restrict" }),
    addressId: varchar("address_id", { length: 36 }).references(
      () => addresses.id,
    ),
    /** Standing quantity per delivery, in milli-units (2 L/day → 2000). */
    quantityMilli: int("quantity_milli").notNull(),
    frequency: subscriptionFrequencyEnum("frequency")
      .notNull()
      .default("DAILY"),
    /** For WEEKLY: ISO weekdays 1-7 the delivery occurs on. */
    weekdays: json("weekdays").$type<number[]>().notNull().default([]),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }),
    nextDeliveryDate: date("next_delivery_date", { mode: "string" }),
    status: subscriptionStatusEnum("status").notNull().default("ACTIVE"),
    pauseFrom: date("pause_from", { mode: "string" }),
    pauseUntil: date("pause_until", { mode: "string" }),
    cancelledAt: datetime("cancelled_at", { mode: "date", fsp: 3 }),
    cancellationReason: text("cancellation_reason"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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
export const subscriptionDailyOverrides = mysqlTable(
  "subscription_daily_overrides",
  {
    id: uuidPk(),
    subscriptionId: varchar("subscription_id", { length: 36 })
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    deliveryDate: date("delivery_date", { mode: "string" }).notNull(),
    type: overrideTypeEnum("type").notNull(),
    /** NULL when type = SKIP. */
    quantityMilli: int("quantity_milli"),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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
export const subscriptionOrders = mysqlTable(
  "subscription_orders",
  {
    id: uuidPk(),
    subscriptionId: varchar("subscription_id", { length: 36 })
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    orderId: varchar("order_id", { length: 36 }).references(() => orders.id),
    deliveryDate: date("delivery_date", { mode: "string" }).notNull(),
    quantityMilli: int("quantity_milli").notNull(),
    unitPricePaise: bigint("unit_price_paise", { mode: "number" }).notNull(),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    status: orderStatusEnum("status").notNull().default("PENDING"),
    failureReason: text("failure_reason"),
    generatedAt: datetime("generated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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

export const notifications = mysqlTable(
  "notifications",
  {
    id: uuidPk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    channel: notificationChannelEnum("channel").notNull().default("IN_APP"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Deep link into the app, e.g. /wallet or /subscriptions/:id. */
    actionUrl: text("action_url"),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    readAt: datetime("read_at", { mode: "date", fsp: 3 }),
    sentAt: datetime("sent_at", { mode: "date", fsp: 3 }),
    /** Set for notifications that must not repeat (e.g. one low-balance alert). */
    dedupeKey: varchar("dedupe_key", { length: 255 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId),
    index("notifications_read_idx").on(t.userId, t.readAt),
    uniqueIndex("notifications_dedupe_unique").on(t.dedupeKey),
  ],
);

/**
 * A user's choice per notification category and channel. No row = the
 * template's default applies. Security notices ignore these (always sent).
 */
export const notificationPreferences = mysqlTable(
  "notification_preferences",
  {
    id: uuidPk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: varchar("category", { length: 255 }).notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    enabled: boolean("enabled").notNull(),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("notification_preferences_unique").on(
      t.userId,
      t.category,
      t.channel,
    ),
  ],
);

/**
 * Outbound (non in-app) delivery queue and log: one row per notification per
 * channel. PENDING/FAILED rows are retried with backoff until `maxAttempts`,
 * then marked DEAD; SKIPPED means the channel had nowhere to send (no provider,
 * no address). The in-app inbox stays in `notifications`.
 */
export const notificationDeliveries = mysqlTable(
  "notification_deliveries",
  {
    id: uuidPk(),
    notificationId: varchar("notification_id", { length: 36 }).references(
      () => notifications.id,
      { onDelete: "set null" },
    ),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    category: text("category").notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    status: varchar("status", {
      length: 255,
      enum: ["PENDING", "SENDING", "SENT", "FAILED", "SKIPPED", "DEAD"],
    })
      .notNull()
      .default("PENDING"),
    attempts: int("attempts").notNull().default(0),
    maxAttempts: int("max_attempts").notNull().default(4),
    nextAttemptAt: datetime("next_attempt_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    lastError: text("last_error"),
    providerRef: text("provider_ref"),
    toAddress: text("to_address"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    html: text("html"),
    actionUrl: text("action_url"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    sentAt: datetime("sent_at", { mode: "date", fsp: 3 }),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("notification_deliveries_due_idx").on(t.status, t.nextAttemptAt),
    index("notification_deliveries_user_idx").on(t.userId, t.createdAt),
  ],
);

/* --------------------------------------------------- registration fees */

/**
 * The registration fee schedule (§12). Rows are append-only: changing the fee
 * inserts a new row and deactivates the previous one, so the amount in force on
 * any past date stays recoverable.
 */
export const registrationFees = mysqlTable(
  "registration_fees",
  {
    id: uuidPk(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 255 }).notNull().default("INR"),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    /** Exactly one row is active at a time; enforced by a partial unique index. */
    isActive: boolean("is_active").notNull().default(true),
    note: text("note"),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("registration_fees_effective_idx").on(t.effectiveFrom),
    check("registration_fees_amount_non_negative", sql`${t.amountPaise} >= 0`),
  ],
);

/** Immutable trail of fee changes (§12). Never updated, never deleted. */
export const registrationFeeHistory = mysqlTable(
  "registration_fee_history",
  {
    id: uuidPk(),
    registrationFeeId: varchar("registration_fee_id", { length: 36 }).notNull(),
    previousAmountPaise: bigint("previous_amount_paise", { mode: "number" }),
    newAmountPaise: bigint("new_amount_paise", { mode: "number" }).notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    changedBy: varchar("changed_by", { length: 36 })
      .notNull()
      .references(() => users.id),
    reason: text("reason"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    // Named explicitly: Drizzle's auto-generated name for this foreign key is
    // longer than MySQL's 64-character identifier limit, which MySQL rejects
    // outright (PostgreSQL silently truncated it).
    foreignKey({
      columns: [t.registrationFeeId],
      foreignColumns: [registrationFees.id],
      name: "reg_fee_history_fee_fk",
    }).onDelete("restrict"),
    index("registration_fee_history_created_idx").on(t.createdAt),
  ],
);

/* -------------------------------------------------------- referral codes */

export const referralCodes = mysqlTable(
  "referral_codes",
  {
    id: uuidPk(),
    /** Stored upper-cased; matching is case-insensitive at the service layer. */
    code: varchar("code", { length: 255 }).notNull(),
    label: text("label"),
    /** Optional: the person or partner the referral is credited to. */
    referrerName: text("referrer_name"),
    referrerUserId: varchar("referrer_user_id", { length: 36 }).references(
      () => users.id,
    ),
    status: referralStatusEnum("status").notNull().default("ACTIVE"),
    expiresAt: date("expires_at", { mode: "string" }),
    note: text("note"),
    createdBy: varchar("created_by", { length: 36 })
      .notNull()
      .references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("referral_codes_code_unique").on(t.code),
    index("referral_codes_status_idx").on(t.status),
  ],
);

/** One row per shop that registered under a referral code. */
export const referralRedemptions = mysqlTable(
  "referral_redemptions",
  {
    id: uuidPk(),
    referralCodeId: varchar("referral_code_id", { length: 36 })
      .notNull()
      .references(() => referralCodes.id, { onDelete: "restrict" }),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    registrationFeePaise: bigint("registration_fee_paise", { mode: "number" }),
    redeemedBy: varchar("redeemed_by", { length: 36 }).references(
      () => users.id,
    ),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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
export const shopPayments = mysqlTable(
  "shop_payments",
  {
    id: uuidPk(),
    /** Human-readable receipt id shown to the owner, e.g. PAY-2026-000045. */
    reference: varchar("reference", { length: 255 }).notNull(),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    ownerId: varchar("owner_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    paymentType: shopPaymentTypeEnum("payment_type").notNull(),
    /** Signed: positive for receipts, negative for refunds/reversals. */
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 255 }).notNull().default("INR"),
    method: shopPaymentMethodEnum("method").notNull().default("CASH"),
    /** Bank/UPI/gateway reference supplied by the operator. */
    transactionId: text("transaction_id"),
    /** The fee this payment was settling — snapshot for reconciliation. */
    feeSnapshotPaise: bigint("fee_snapshot_paise", { mode: "number" }),
    paidAt: datetime("paid_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    note: text("note"),
    receiptUrl: text("receipt_url"),
    /** Set on a REVERSAL/REFUND row to point at the payment being corrected. */
    reversalOfId: varchar("reversal_of_id", { length: 36 }),
    recordedBy: varchar("recorded_by", { length: 36 })
      .notNull()
      .references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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
export const excelUploads = mysqlTable(
  "excel_uploads",
  {
    id: uuidPk(),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    uploadedBy: varchar("uploaded_by", { length: 36 })
      .notNull()
      .references(() => users.id),
    uploadType: excelUploadTypeEnum("upload_type").notNull().default("PRICES"),
    status: excelUploadStatusEnum("status").notNull().default("VALIDATED"),
    fileName: text("file_name").notNull(),
    fileSizeBytes: int("file_size_bytes").notNull().default(0),
    totalRows: int("total_rows").notNull().default(0),
    validRows: int("valid_rows").notNull().default(0),
    invalidRows: int("invalid_rows").notNull().default(0),
    unchangedRows: int("unchanged_rows").notNull().default(0),
    duplicateRows: int("duplicate_rows").notNull().default(0),
    notFoundRows: int("not_found_rows").notNull().default(0),
    /** Counts and headline diffs, rendered on the preview screen. */
    summary: json("summary").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    appliedAt: datetime("applied_at", { mode: "date", fsp: 3 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("excel_uploads_shop_idx").on(t.shopId),
    index("excel_uploads_uploader_idx").on(t.uploadedBy),
    index("excel_uploads_created_idx").on(t.createdAt),
  ],
);

/** One parsed spreadsheet row, with its validation verdict. */
export const excelUploadItems = mysqlTable(
  "excel_upload_items",
  {
    id: uuidPk(),
    uploadId: varchar("upload_id", { length: 36 })
      .notNull()
      .references(() => excelUploads.id, { onDelete: "cascade" }),
    rowNumber: int("row_number").notNull(),
    /** Verbatim cell values, so an operator can see exactly what they sent. */
    rawData: json("raw_data").$type<Record<string, unknown>>(),
    productCode: text("product_code"),
    productName: text("product_name"),
    unit: text("unit"),
    parsedPricePaise: bigint("parsed_price_paise", { mode: "number" }),
    previousPricePaise: bigint("previous_price_paise", { mode: "number" }),
    matchedShopProductId: varchar("matched_shop_product_id", {
      length: 36,
    }).references(() => shopProducts.id, { onDelete: "set null" }),
    /**
     * GOODS upload only: the row matched a product in the CENTRAL catalogue
     * that this shop does not yet carry — apply() attaches it via
     * createShopProduct rather than creating a new products row.
     */
    matchedProductId: varchar("matched_product_id", { length: 36 }).references(
      () => products.id,
      {
        onDelete: "set null",
      },
    ),
    /**
     * GOODS upload only: set when a NEW_PRODUCT row's name is close to an
     * existing product, so the preview can warn "this looks like X" without
     * blocking the row (§ "flag it for review").
     */
    possibleDuplicateProductId: varchar("possible_duplicate_product_id", {
      length: 36,
    }).references(() => products.id, { onDelete: "set null" }),
    status: excelRowStatusEnum("status").notNull(),
    errorMessage: text("error_message"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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
export const priceUpdateBatches = mysqlTable(
  "price_update_batches",
  {
    id: uuidPk(),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    source: priceRequestSourceEnum("source").notNull(),
    submittedBy: varchar("submitted_by", { length: 36 })
      .notNull()
      .references(() => users.id),
    excelUploadId: varchar("excel_upload_id", { length: 36 }).references(
      () => excelUploads.id,
      {
        onDelete: "set null",
      },
    ),
    status: priceRequestStatusEnum("status").notNull().default("PENDING"),
    note: text("note"),
    decidedBy: varchar("decided_by", { length: 36 }).references(() => users.id),
    decidedAt: datetime("decided_at", { mode: "date", fsp: 3 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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
export const priceUpdateRequests = mysqlTable(
  "price_update_requests",
  {
    id: uuidPk(),
    batchId: varchar("batch_id", { length: 36 })
      .notNull()
      .references(() => priceUpdateBatches.id, { onDelete: "cascade" }),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    shopProductId: varchar("shop_product_id", { length: 36 })
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    priceType: text("price_type", { enum: ["ONLINE", "OFFLINE"] }).notNull(),
    previousPricePaise: bigint("previous_price_paise", { mode: "number" }),
    proposedPricePaise: bigint("proposed_price_paise", {
      mode: "number",
    }).notNull(),
    status: priceRequestStatusEnum("status").notNull().default("PENDING"),
    source: priceRequestSourceEnum("source").notNull(),
    submittedBy: varchar("submitted_by", { length: 36 })
      .notNull()
      .references(() => users.id),
    decidedBy: varchar("decided_by", { length: 36 }).references(() => users.id),
    decidedAt: datetime("decided_at", { mode: "date", fsp: 3 }),
    rejectionReason: text("rejection_reason"),
    appliedAt: datetime("applied_at", { mode: "date", fsp: 3 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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
export const grievances = mysqlTable(
  "grievances",
  {
    id: uuidPk(),
    /** Human-readable reference, e.g. GRV-000123 — what the complainant quotes back. */
    ticketNumber: varchar("ticket_number", { length: 255 }).notNull(),
    submittedByUserId: varchar("submitted_by_user_id", {
      length: 36,
    }).references(() => users.id, {
      onDelete: "set null",
    }),
    /** The order a customer reported a problem with (GS-056 / WF-007). */
    orderId: varchar("order_id", { length: 36 }).references(() => orders.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    phone: text("phone"),
    category: grievanceCategoryEnum("category").notNull().default("OTHER"),
    subject: text("subject").notNull(),
    description: text("description").notNull(),
    status: grievanceStatusEnum("status").notNull().default("OPEN"),
    assignedToUserId: varchar("assigned_to_user_id", { length: 36 }).references(
      () => users.id,
      {
        onDelete: "set null",
      },
    ),
    resolutionNotes: text("resolution_notes"),
    resolvedAt: datetime("resolved_at", { mode: "date", fsp: 3 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("grievances_ticket_number_unique").on(t.ticketNumber),
    index("grievances_status_idx").on(t.status),
    index("grievances_email_idx").on(t.email),
    index("grievances_submitted_by_idx").on(t.submittedByUserId),
  ],
);

/** Append-only — a consent is never edited or deleted, only superseded by a newer row. */
export const userConsents = mysqlTable(
  "user_consents",
  {
    id: uuidPk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    consentType: consentTypeEnum("consent_type").notNull(),
    /** The policy version consented to, e.g. "2026-08-21" — matches the policy page's "Last updated" date. */
    version: text("version").notNull(),
    /** false = a withdrawal (DPDPA §6(4)). Every existing row was a grant. */
    granted: boolean("granted").notNull().default(true),
    ipAddress: text("ip_address"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("user_consents_user_idx").on(t.userId),
    index("user_consents_type_idx").on(t.consentType),
  ],
);

/* ----------------------------------------------------------- audit logs */

export const auditLogs = mysqlTable(
  "audit_logs",
  {
    id: uuidPk(),
    actorId: varchar("actor_id", { length: 36 }).references(() => users.id),
    actorRole: userRoleEnum("actor_role"),
    action: text("action").notNull(),
    entityType: varchar("entity_type", { length: 255 }).notNull(),
    entityId: varchar("entity_id", { length: 255 }),
    previousValue: json("previous_value"),
    newValue: json("new_value"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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
export const mapsApiCallLog = mysqlTable(
  "maps_api_call_log",
  {
    id: uuidPk(),
    service: varchar("service", { length: 255, enum: ["GEOCODING"] }).notNull(),
    purpose: text("purpose").notNull(),
    entityType: varchar("entity_type", { length: 255 }),
    entityId: varchar("entity_id", { length: 255 }),
    success: boolean("success").notNull(),
    responseTimeMs: int("response_time_ms"),
    errorMessage: text("error_message"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("maps_api_call_log_service_idx").on(t.service),
    index("maps_api_call_log_created_idx").on(t.createdAt),
    index("maps_api_call_log_entity_idx").on(t.entityType, t.entityId),
  ],
);

/* ------------------------------------------------------------ inference */

/* ============================================================ society (Phase 2)
 * GS-005, GS-044..047, GA-001/002. A society is a verified residential
 * community. Roles are SCOPED to a society through society_members
 * (ADMIN / OPERATOR / RESIDENT) rather than being global user roles, so a
 * user can be a resident of one society and an admin of another without
 * gaining powers anywhere else. The global SOCIETY_ADMIN user role is only a
 * navigation hint for people who administer at least one society.
 */

export const societyStatusEnum = mysqlEnumType([
  "APPLIED",
  "VERIFIED",
  "REJECTED",
  "SUSPENDED",
]);
export const societyMemberRoleEnum = mysqlEnumType([
  "ADMIN",
  "OPERATOR",
  "RESIDENT",
]);
export const societyMemberStatusEnum = mysqlEnumType([
  "PENDING",
  "ACTIVE",
  "REMOVED",
]);
export const societyLinkStatusEnum = mysqlEnumType(["ACTIVE", "REVOKED"]);

export const societies = mysqlTable(
  "societies",
  {
    id: uuidPk(),
    name: text("name").notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    addressLine1: text("address_line1").notNull(),
    area: text("area"),
    city: text("city").notNull(),
    pincode: varchar("pincode", { length: 255 }).notNull(),
    latitude: text("latitude"),
    longitude: text("longitude"),
    /** Addresses within this distance of the society pin are treated as inside it. */
    boundaryRadiusMeters: int("boundary_radius_meters").notNull().default(300),
    status: societyStatusEnum("status").notNull().default("APPLIED"),
    /** Gate / parking / access notes shown only to the rider on an active job (GS-047). */
    deliveryInstructions: text("delivery_instructions"),
    /** Notify society admins/operators when a rider is assigned to a society order (GS-046). */
    securityNotifyEnabled: boolean("security_notify_enabled")
      .notNull()
      .default(false),
    /**
     * Gate-access workflow. OPEN: riders walk in. CALL_RESIDENT: the gate calls
     * the resident before letting the rider in. PRE_APPROVAL: the resident
     * approves the rider ahead of arrival. DROP_AT_GATE: goods are handed over
     * at the gate.
     */
    gateEntryMode: varchar("gate_entry_mode", {
      length: 255,
      enum: ["OPEN", "CALL_RESIDENT", "PRE_APPROVAL", "DROP_AT_GATE"],
    })
      .notNull()
      .default("OPEN"),
    /** Security desk contact; shown to a rider only when `shareGateContactWithRider` is on. */
    gateContactName: text("gate_contact_name"),
    gateContactPhone: text("gate_contact_phone"),
    shareGateContactWithRider: boolean("share_gate_contact_with_rider")
      .notNull()
      .default(false),
    /** Tell the customer when the rider reaches the gate, with what the gate will ask of them. */
    notifyCustomerAtGate: boolean("notify_customer_at_gate")
      .notNull()
      .default(true),
    /** GA-001: when true and the rider list is non-empty, only listed riders may deliver here. */
    exclusiveRiders: boolean("exclusive_riders").notNull().default(false),
    registeredBy: varchar("registered_by", { length: 36 }).references(
      () => users.id,
    ),
    verifiedBy: varchar("verified_by", { length: 36 }).references(
      () => users.id,
    ),
    verifiedAt: datetime("verified_at", { mode: "date", fsp: 3 }),
    rejectionReason: text("rejection_reason"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
  },
  (t) => [
    uniqueIndex("societies_slug_unique").on(t.slug),
    index("societies_status_idx").on(t.status),
    index("societies_pincode_idx").on(t.pincode),
    check(
      "societies_boundary_range",
      sql`${t.boundaryRadiusMeters} BETWEEN 50 AND 3000`,
    ),
  ],
);

export const societyMembers = mysqlTable(
  "society_members",
  {
    id: uuidPk(),
    societyId: varchar("society_id", { length: 36 })
      .notNull()
      .references(() => societies.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: societyMemberRoleEnum("role").notNull().default("RESIDENT"),
    status: societyMemberStatusEnum("status").notNull().default("PENDING"),
    /** Flat / house / tower label as the resident gave it, e.g. "B-1204". */
    unitLabel: text("unit_label"),
    approvedBy: varchar("approved_by", { length: 36 }).references(
      () => users.id,
    ),
    approvedAt: datetime("approved_at", { mode: "date", fsp: 3 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("society_members_unique").on(t.societyId, t.userId),
    index("society_members_user_idx").on(t.userId),
  ],
);

/** GS-045 authorised rider list; `preferred` = GA-002 preferred partner. */
export const societyRiders = mysqlTable(
  "society_riders",
  {
    id: uuidPk(),
    societyId: varchar("society_id", { length: 36 })
      .notNull()
      .references(() => societies.id, { onDelete: "cascade" }),
    deliveryPartnerId: varchar("delivery_partner_id", { length: 36 })
      .notNull()
      .references(() => deliveryPartners.id, { onDelete: "cascade" }),
    status: societyLinkStatusEnum("status").notNull().default("ACTIVE"),
    preferred: boolean("preferred").notNull().default(false),
    addedBy: varchar("added_by", { length: 36 }).references(() => users.id),
    revokedBy: varchar("revoked_by", { length: 36 }).references(() => users.id),
    revokedAt: datetime("revoked_at", { mode: "date", fsp: 3 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("society_riders_unique").on(t.societyId, t.deliveryPartnerId),
    index("society_riders_partner_idx").on(t.deliveryPartnerId),
  ],
);

/** Shops a society lists for its residents (society-aware discovery). */
export const societyShops = mysqlTable(
  "society_shops",
  {
    id: uuidPk(),
    societyId: varchar("society_id", { length: 36 })
      .notNull()
      .references(() => societies.id, { onDelete: "cascade" }),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    status: societyLinkStatusEnum("status").notNull().default("ACTIVE"),
    addedBy: varchar("added_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [uniqueIndex("society_shops_unique").on(t.societyId, t.shopId)],
);

/* ============================================================ ratings (Phase 2)
 * GS-059 shop rating, GS-060 rider rating. One row per (order, target): a
 * customer rates the shop and, when a platform rider delivered, the rider —
 * only after DELIVERED, only their own order, only once. Aggregates live on
 * shops / delivery_partners and are recomputed from VISIBLE rows.
 */

export const ratingTargetEnum = mysqlEnumType(["SHOP", "DELIVERY_PARTNER"]);
export const ratingStatusEnum = mysqlEnumType(["VISIBLE", "HIDDEN"]);

export const orderRatings = mysqlTable(
  "order_ratings",
  {
    id: uuidPk(),
    orderId: varchar("order_id", { length: 36 })
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    targetType: ratingTargetEnum("target_type").notNull(),
    customerId: varchar("customer_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    deliveryPartnerId: varchar("delivery_partner_id", {
      length: 36,
    }).references(() => deliveryPartners.id, { onDelete: "cascade" }),
    score: int("score").notNull(),
    comment: text("comment"),
    status: ratingStatusEnum("status").notNull().default("VISIBLE"),
    moderatedBy: varchar("moderated_by", { length: 36 }).references(
      () => users.id,
    ),
    moderatedAt: datetime("moderated_at", { mode: "date", fsp: 3 }),
    moderationReason: text("moderation_reason"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("order_ratings_order_target_unique").on(
      t.orderId,
      t.targetType,
    ),
    index("order_ratings_shop_idx").on(t.shopId),
    index("order_ratings_partner_idx").on(t.deliveryPartnerId),
    check("order_ratings_score_range", sql`${t.score} BETWEEN 1 AND 5`),
    check(
      "order_ratings_target_partner",
      sql`(${t.targetType} = 'DELIVERY_PARTNER') = (${t.deliveryPartnerId} IS NOT NULL)`,
    ),
  ],
);

/* ================================================ subscription history (Phase 2) */

/** Append-only lifecycle history of a subscription (created, paused, resumed, skipped, cancelled, payment failed). */
export const subscriptionEvents = mysqlTable(
  "subscription_events",
  {
    id: uuidPk(),
    subscriptionId: varchar("subscription_id", { length: 36 })
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    fromStatus: subscriptionStatusEnum("from_status"),
    toStatus: subscriptionStatusEnum("to_status"),
    note: text("note"),
    actorId: varchar("actor_id", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index("subscription_events_subscription_idx").on(t.subscriptionId)],
);

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

export const commissionScopeEnum = mysqlEnumType([
  "DEFAULT",
  "SHOP_TYPE",
  "SHOP",
]);

export const commissionRates = mysqlTable(
  "commission_rates",
  {
    id: uuidPk(),
    scope: commissionScopeEnum("scope").notNull(),
    /** Set for SHOP_TYPE. */
    shopType: shopTypeEnum("shop_type"),
    /** Set for SHOP. */
    shopId: varchar("shop_id", { length: 36 }).references(() => shops.id, {
      onDelete: "restrict",
    }),
    /** Basis points: 500 = 5.00%. */
    rateBp: int("rate_bp").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    note: text("note"),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
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
export const payoutStatusEnum = mysqlEnumType([
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
  approvedBy: varchar("approved_by", { length: 36 }).references(() => users.id),
  approvedAt: datetime("approved_at", { mode: "date", fsp: 3 }),
  processingAt: datetime("processing_at", { mode: "date", fsp: 3 }),
  paidBy: varchar("paid_by", { length: 36 }).references(() => users.id),
  paidAt: datetime("paid_at", { mode: "date", fsp: 3 }),
  failedAt: datetime("failed_at", { mode: "date", fsp: 3 }),
  reversedAt: datetime("reversed_at", { mode: "date", fsp: 3 }),
  createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
  createdAt: datetime("created_at", { mode: "date", fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`),
});

export const shopSettlements = mysqlTable(
  "shop_settlements",
  {
    id: uuidPk(),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    /** Inclusive start / exclusive end of the settlement week (app-time-zone dates). */
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    orderCount: int("order_count").notNull(),
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

export const riderPayouts = mysqlTable(
  "rider_payouts",
  {
    id: uuidPk(),
    deliveryPartnerId: varchar("delivery_partner_id", { length: 36 })
      .notNull()
      .references(() => deliveryPartners.id, { onDelete: "restrict" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    earningsCount: int("earnings_count").notNull(),
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

export const orderFinancials = mysqlTable(
  "order_financials",
  {
    orderId: varchar("order_id", { length: 36 })
      .primaryKey()
      .references(() => orders.id, { onDelete: "restrict" }),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    customerId: varchar("customer_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** The customer's wallet debit that paid for the order (Part A payment link). */
    paymentTransactionId: varchar("payment_transaction_id", { length: 36 }),
    /** Goods actually sold (order subtotal after removed/substituted lines). */
    goodsPaise: bigint("goods_paise", { mode: "number" }).notNull(),
    /** Part of the payment funded by promotional wallet credit — a platform-funded discount. */
    discountPaise: bigint("discount_paise", { mode: "number" })
      .notNull()
      .default(0),
    /** Delivery fee the customer paid — platform revenue (D6). */
    deliveryFeePaise: bigint("delivery_fee_paise", {
      mode: "number",
    }).notNull(),
    /** GMV of this order: goods + delivery fee as delivered. */
    gmvPaise: bigint("gmv_paise", { mode: "number" }).notNull(),
    /** Rate applied, snapshotted — later rate changes never rewrite it. */
    commissionRateBp: int("commission_rate_bp").notNull(),
    commissionRateId: varchar("commission_rate_id", { length: 36 }).references(
      () => commissionRates.id,
    ),
    commissionPaise: bigint("commission_paise", { mode: "number" }).notNull(),
    /** goods − commission; owed to the shop for this order before refunds/adjustments. */
    shopPayablePaise: bigint("shop_payable_paise", {
      mode: "number",
    }).notNull(),
    deliveredAt: datetime("delivered_at", { mode: "date", fsp: 3 }).notNull(),
    settlementId: varchar("settlement_id", { length: 36 }).references(
      () => shopSettlements.id,
    ),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("order_financials_shop_idx").on(t.shopId),
    index("order_financials_settlement_idx").on(t.settlementId),
    index("order_financials_delivered_idx").on(t.deliveredAt),
  ],
);

export const financialPartyEnum = mysqlEnumType(["SHOP", "RIDER", "PLATFORM"]);

export const adjustmentTypeEnum = mysqlEnumType([
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
  /** COD cash the rider/shop collected for the platform (−, recovered in the next batch). */
  "COD_CASH_COLLECTED",
  /** That cash handed over to the platform (+, cancels the collection). */
  "COD_CASH_DEPOSITED",
]);

export const adjustmentStatusEnum = mysqlEnumType([
  /** Waiting for the next settlement/payout batch. */
  "PENDING",
  /** Included in a batch. */
  "SETTLED",
  /** Platform-only; nothing to pay out. */
  "RECORDED",
]);

export const financialAdjustments = mysqlTable(
  "financial_adjustments",
  {
    id: uuidPk(),
    type: adjustmentTypeEnum("type").notNull(),
    party: financialPartyEnum("party").notNull(),
    status: adjustmentStatusEnum("status").notNull().default("PENDING"),
    shopId: varchar("shop_id", { length: 36 }).references(() => shops.id, {
      onDelete: "restrict",
    }),
    deliveryPartnerId: varchar("delivery_partner_id", { length: 36 }),
    orderId: varchar("order_id", { length: 36 }).references(() => orders.id, {
      onDelete: "restrict",
    }),
    /** The wallet ledger row of a customer refund (the refund's payment reference). */
    walletTransactionId: varchar("wallet_transaction_id", { length: 36 }),
    /** Effect on the party: + owed to it, − recovered from it. */
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    /** What the customer got back (refunds), for reporting and reconciliation. */
    customerRefundPaise: bigint("customer_refund_paise", { mode: "number" })
      .notNull()
      .default(0),
    reason: text("reason").notNull(),
    settlementId: varchar("settlement_id", { length: 36 }).references(
      () => shopSettlements.id,
    ),
    payoutId: varchar("payout_id", { length: 36 }).references(
      () => riderPayouts.id,
    ),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    // Named explicitly: Drizzle's auto-generated name for this foreign key is
    // longer than MySQL's 64-character identifier limit, which MySQL rejects
    // outright (PostgreSQL silently truncated it).
    foreignKey({
      columns: [t.deliveryPartnerId],
      foreignColumns: [deliveryPartners.id],
      name: "fin_adjustments_partner_fk",
    }).onDelete("restrict"),
    uniqueIndex("financial_adjustments_idempotency_unique").on(
      t.idempotencyKey,
    ),
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

export const ledgerEntryTypeEnum = mysqlEnumType([
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
  /** Cash on delivery collected / deposited (GS-030). */
  "COD_CASH",
]);

export const ledgerDirectionEnum = mysqlEnumType(["CREDIT", "DEBIT"]);

/**
 * Append-only marketplace journal (Part I). CREDIT = the entity is owed /
 * earns; DEBIT = it pays / is paid out. One business event posts one or more
 * entries under the same idempotency prefix. Customer money stays in the
 * wallet ledger — referenced here, never duplicated.
 */
export const financeLedgerEntries = mysqlTable(
  "finance_ledger_entries",
  {
    id: uuidPk(),
    orderId: varchar("order_id", { length: 36 }).references(() => orders.id, {
      onDelete: "restrict",
    }),
    entityType: financialPartyEnum("entity_type").notNull(),
    /** Shop id, delivery partner id, or null for the platform. */
    entityId: varchar("entity_id", { length: 36 }),
    entryType: ledgerEntryTypeEnum("entry_type").notNull(),
    direction: ledgerDirectionEnum("direction").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 255 }).notNull().default("INR"),
    /** The record this entry came from: order_financials, adjustment, settlement, payout, earning. */
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    /** Payment/bank reference where one exists. */
    reference: text("reference"),
    status: varchar("status", { length: 255 }).notNull().default("POSTED"),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("finance_ledger_idempotency_unique").on(t.idempotencyKey),
    index("finance_ledger_order_idx").on(t.orderId),
    index("finance_ledger_entity_idx").on(t.entityType, t.entityId),
    index("finance_ledger_created_idx").on(t.createdAt),
    check("finance_ledger_amount_positive", sql`${t.amountPaise} > 0`),
  ],
);

export const reconciliationEntityEnum = mysqlEnumType([
  "PAYMENT",
  "ORDER",
  "SHOP",
  "RIDER",
  "SETTLEMENT",
  "PAYOUT",
]);

export const reconciliationStatusEnum = mysqlEnumType([
  "UNMATCHED",
  "MATCHED",
  "PARTIAL",
  "EXCEPTION",
  "RECONCILED",
]);

/** Latest reconciliation result per entity (Part H); RECONCILED once a person resolves it. */
export const reconciliationRecords = mysqlTable(
  "reconciliation_records",
  {
    id: uuidPk(),
    entityType: reconciliationEntityEnum("entity_type").notNull(),
    entityId: varchar("entity_id", { length: 255 }).notNull(),
    /** Human reference: order number, gateway order id, settlement id. */
    reference: text("reference").notNull(),
    checkType: varchar("check_type", { length: 255 }).notNull(),
    expectedPaise: bigint("expected_paise", { mode: "number" }),
    actualPaise: bigint("actual_paise", { mode: "number" }),
    status: reconciliationStatusEnum("status").notNull(),
    detail: text("detail"),
    lastCheckedAt: datetime("last_checked_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    resolvedBy: varchar("resolved_by", { length: 36 }).references(
      () => users.id,
    ),
    resolvedAt: datetime("resolved_at", { mode: "date", fsp: 3 }),
    resolutionNote: text("resolution_note"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("reconciliation_entity_check_unique").on(
      t.entityType,
      t.entityId,
      t.checkType,
    ),
    index("reconciliation_status_idx").on(t.status),
  ],
);

/* ============================================================ Phase 3 */
/* Multi-role accounts (GS-003), rider online sessions (KPI-013), customer
 * segments and shop campaigns (GS-052/053, WF-009, KPI-015), fraud / risk
 * rules (GS-068). */

export const roleGrantStatusEnum = mysqlEnumType(["ACTIVE", "REVOKED"]);

/**
 * Roles a user holds (GS-003). `users.role` is the ACTIVE role — the one the
 * session and every permission check use; a user switches between the roles
 * granted here. CUSTOMER is implicit for everyone. Business approval stays
 * with each role's own flow (shop approval, rider KYC, society verification).
 */
export const userRoleGrants = mysqlTable(
  "user_role_grants",
  {
    id: uuidPk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: userRoleEnum("role").notNull(),
    status: roleGrantStatusEnum("status").notNull().default("ACTIVE"),
    /** SHOP_REGISTRATION, DELIVERY_PARTNER_APPLICATION, SOCIETY, ADMIN, BOOTSTRAP, BACKFILL. */
    source: text("source").notNull(),
    grantedBy: varchar("granted_by", { length: 36 }).references(() => users.id),
    grantedAt: datetime("granted_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    revokedBy: varchar("revoked_by", { length: 36 }).references(() => users.id),
    revokedAt: datetime("revoked_at", { mode: "date", fsp: 3 }),
  },
  (t) => [
    uniqueIndex("user_role_grants_user_role_unique").on(t.userId, t.role),
    index("user_role_grants_user_idx").on(t.userId),
  ],
);

/** One row per online stretch of a rider (KPI-013 utilisation). */
export const deliveryPartnerSessions = mysqlTable(
  "delivery_partner_sessions",
  {
    id: uuidPk(),
    deliveryPartnerId: varchar("delivery_partner_id", { length: 36 }).notNull(),
    startedAt: datetime("started_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    /** Null while online. */
    endedAt: datetime("ended_at", { mode: "date", fsp: 3 }),
  },
  (t) => [
    // Named explicitly: Drizzle's auto-generated name for this foreign key is
    // longer than MySQL's 64-character identifier limit, which MySQL rejects
    // outright (PostgreSQL silently truncated it).
    foreignKey({
      columns: [t.deliveryPartnerId],
      foreignColumns: [deliveryPartners.id],
      name: "dp_sessions_partner_fk",
    }).onDelete("cascade"),
    index("delivery_partner_sessions_partner_idx").on(t.deliveryPartnerId),
    index("delivery_partner_sessions_started_idx").on(t.startedAt),
  ],
);

/**
 * Rules of a customer segment (GS-052). Every rule is optional; all given
 * rules must hold. Marketing consent is always required and is not a rule.
 */
export interface SegmentRules {
  /** Delivery PIN codes of the customer's orders with the shop. */
  pincodes?: string[];
  /** Societies of those orders. */
  societyIds?: string[];
  /** At least this many delivered orders with the shop. */
  minOrders?: number;
  /** Ordered from the shop within the last N days. */
  orderedWithinDays?: number;
  /** Has NOT ordered from the shop in the last N days (lapsed customers). */
  lapsedForDays?: number;
  /** Spent at least this much with the shop (delivered orders). */
  minSpendPaise?: number;
}

export const customerSegments = mysqlTable(
  "customer_segments",
  {
    id: uuidPk(),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    rules: json("rules").$type<SegmentRules>().notNull(),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
  },
  (t) => [index("customer_segments_shop_idx").on(t.shopId)],
);

export const campaignStatusEnum = mysqlEnumType([
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "SENT",
  "CANCELLED",
]);

/**
 * A shop's promotional message to one of its segments (GS-053, WF-009):
 * DRAFT → SUBMITTED → APPROVED (operations) → SENT, or REJECTED / CANCELLED.
 * `maxRecipients` is the campaign's budget; frequency caps protect customers.
 */
export const marketingCampaigns = mysqlTable(
  "marketing_campaigns",
  {
    id: uuidPk(),
    shopId: varchar("shop_id", { length: 36 })
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    segmentId: varchar("segment_id", { length: 36 })
      .notNull()
      .references(() => customerSegments.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    message: text("message").notNull(),
    /** Optional offer line shown with the message (e.g. "10% off vegetables this week"). */
    offerText: text("offer_text"),
    maxRecipients: int("max_recipients").notNull(),
    /** Days after sending during which a recipient's order counts as a conversion. */
    attributionDays: int("attribution_days").notNull().default(7),
    status: campaignStatusEnum("status").notNull().default("DRAFT"),
    submittedAt: datetime("submitted_at", { mode: "date", fsp: 3 }),
    decidedBy: varchar("decided_by", { length: 36 }).references(() => users.id),
    decidedAt: datetime("decided_at", { mode: "date", fsp: 3 }),
    rejectionReason: text("rejection_reason"),
    sentAt: datetime("sent_at", { mode: "date", fsp: 3 }),
    sentCount: int("sent_count").notNull().default(0),
    /** Matched but skipped by the frequency caps or the budget. */
    suppressedCount: int("suppressed_count").notNull().default(0),
    createdBy: varchar("created_by", { length: 36 }).references(() => users.id),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    index("marketing_campaigns_shop_idx").on(t.shopId),
    index("marketing_campaigns_status_idx").on(t.status),
    check(
      "marketing_campaigns_max_recipients",
      sql`${t.maxRecipients} BETWEEN 1 AND 5000`,
    ),
    check(
      "marketing_campaigns_attribution_days",
      sql`${t.attributionDays} BETWEEN 1 AND 30`,
    ),
  ],
);

export const campaignRecipients = mysqlTable(
  "campaign_recipients",
  {
    id: uuidPk(),
    campaignId: varchar("campaign_id", { length: 36 })
      .notNull()
      .references(() => marketingCampaigns.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The in-app notification's dedupe key — its read_at is the "opened" signal. */
    notificationKey: text("notification_key").notNull(),
    sentAt: datetime("sent_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex("campaign_recipients_unique").on(t.campaignId, t.userId),
    index("campaign_recipients_user_idx").on(t.userId, t.sentAt),
  ],
);

export const riskSubjectEnum = mysqlEnumType([
  "USER",
  "SHOP",
  "DELIVERY_PARTNER",
]);
export const riskSeverityEnum = mysqlEnumType(["LOW", "MEDIUM", "HIGH"]);
export const riskFlagStatusEnum = mysqlEnumType([
  "OPEN",
  "DISMISSED",
  "ACTIONED",
]);

/**
 * A fraud / risk rule hit awaiting review (GS-068). One OPEN flag per
 * subject and rule; a re-detection updates it. An OPEN HIGH flag on a
 * customer blocks cash on delivery.
 */
export const riskFlags = mysqlTable(
  "risk_flags",
  {
    id: uuidPk(),
    subjectType: riskSubjectEnum("subject_type").notNull(),
    subjectId: varchar("subject_id", { length: 36 }).notNull(),
    ruleCode: varchar("rule_code", { length: 255 }).notNull(),
    severity: riskSeverityEnum("severity").notNull(),
    status: riskFlagStatusEnum("status").notNull().default("OPEN"),
    summary: text("summary").notNull(),
    details: json("details").$type<Record<string, unknown>>(),
    occurrences: int("occurrences").notNull().default(1),
    firstDetectedAt: datetime("first_detected_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    lastDetectedAt: datetime("last_detected_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    reviewedBy: varchar("reviewed_by", { length: 36 }).references(
      () => users.id,
    ),
    reviewedAt: datetime("reviewed_at", { mode: "date", fsp: 3 }),
    reviewNote: text("review_note"),
    /**
     * MySQL has no partial indexes, so the predicate of the old PostgreSQL
     * partial UNIQUE index lives in this generated column: it is NULL when the
     * predicate is false, and MySQL's UNIQUE ignores NULLs. Verified against
     * both engines -- a second matching row is rejected with a duplicate-key
     * error, non-matching rows are unconstrained, and leaving the predicate
     * frees the slot again.
     *
     * VIRTUAL, not STORED. MySQL refuses a foreign key with ON DELETE CASCADE
     * on any column a STORED generated column is built from (ER_CANNOT_ADD_
     * FOREIGN), and five of these columns are built from exactly such a
     * column. For a VIRTUAL column only ON UPDATE CASCADE is disallowed, which
     * nothing here uses. MariaDB accepts both forms, so this only shows up on
     * MySQL -- it was caught by CI, not by local testing.
     */
    openFlagKey: varchar("open_flag_key", { length: 600 }).generatedAlwaysAs(
      sql`CASE WHEN status = 'OPEN' THEN CONCAT(subject_type,':',subject_id,':',rule_code) END`,
      { mode: "virtual" },
    ),
  },
  (t) => [
    uniqueIndex("risk_flags_open_unique").on(t.openFlagKey),
    index("risk_flags_status_idx").on(t.status, t.severity),
    index("risk_flags_subject_idx").on(t.subjectType, t.subjectId),
  ],
);

export type User = typeof users.$inferSelect;
export type Shop = typeof shops.$inferSelect;
export type GstStatus = (typeof gstStatusEnum.enumValues)[number];
export type PanStatus = (typeof panStatusEnum.enumValues)[number];
export type IdentityVerificationSource =
  (typeof identityVerificationSourceEnum.enumValues)[number];
export type ProductCategory = typeof productCategories.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Brand = typeof brands.$inferSelect;
export type ProductSubcategory = typeof productSubcategories.$inferSelect;
export type ProductMrpHistoryRow = typeof productMrpHistory.$inferSelect;
export type ProductImage = typeof productImages.$inferSelect;
export type StockAlert = typeof stockAlerts.$inferSelect;
export type ProductKind = (typeof productKindEnum.enumValues)[number];
export type MrpSource = (typeof mrpSourceEnum.enumValues)[number];
export type MrpVerificationStatus =
  (typeof mrpVerificationStatusEnum.enumValues)[number];
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
export type GrievanceCategory =
  (typeof grievanceCategoryEnum.enumValues)[number];
export type UserConsent = typeof userConsents.$inferSelect;
export type ConsentType = (typeof consentTypeEnum.enumValues)[number];
export type Subscription = typeof subscriptions.$inferSelect;
export type SubscriptionDailyOverride =
  typeof subscriptionDailyOverrides.$inferSelect;
export type SubscriptionOrder = typeof subscriptionOrders.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Address = typeof addresses.$inferSelect;
export type DeliveryPartner = typeof deliveryPartners.$inferSelect;
export type DeliveryPartnerStatus =
  (typeof deliveryPartnerStatusEnum.enumValues)[number];
export type DeliveryOrder = typeof deliveryOrders.$inferSelect;
export type DeliveryOrderStatus =
  (typeof deliveryOrderStatusEnum.enumValues)[number];
export type DeliveryWindow = (typeof deliveryWindowEnum.enumValues)[number];
export type DeliveryEarningsConfig = typeof deliveryEarningsConfig.$inferSelect;
export type DeliveryPartnerEarning =
  typeof deliveryPartnerEarnings.$inferSelect;
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
export type Society = typeof societies.$inferSelect;
export type SocietyMember = typeof societyMembers.$inferSelect;
export type SocietyMemberRole =
  (typeof societyMemberRoleEnum.enumValues)[number];
export type SocietyStatus = (typeof societyStatusEnum.enumValues)[number];
export type OrderRating = typeof orderRatings.$inferSelect;
export type RatingTarget = (typeof ratingTargetEnum.enumValues)[number];
export type SubscriptionEvent = typeof subscriptionEvents.$inferSelect;
export type CommissionScope = (typeof commissionScopeEnum.enumValues)[number];
export type PayoutStatus = (typeof payoutStatusEnum.enumValues)[number];
export type AdjustmentType = (typeof adjustmentTypeEnum.enumValues)[number];
export type FinancialParty = (typeof financialPartyEnum.enumValues)[number];
export type LedgerEntryType = (typeof ledgerEntryTypeEnum.enumValues)[number];
export type ReconciliationStatus =
  (typeof reconciliationStatusEnum.enumValues)[number];
export type ReconciliationEntity =
  (typeof reconciliationEntityEnum.enumValues)[number];
export type CommissionRate = typeof commissionRates.$inferSelect;
export type ShopSettlement = typeof shopSettlements.$inferSelect;
export type RiderPayout = typeof riderPayouts.$inferSelect;
export type OrderFinancial = typeof orderFinancials.$inferSelect;
export type FinancialAdjustment = typeof financialAdjustments.$inferSelect;
export type FinanceLedgerEntry = typeof financeLedgerEntries.$inferSelect;
export type ReconciliationRecord = typeof reconciliationRecords.$inferSelect;
export type OrderItemFulfilment =
  (typeof orderItemFulfilmentEnum.enumValues)[number];
export type ShopStatus = (typeof shopStatusEnum.enumValues)[number];
export type Classification = (typeof classificationEnum.enumValues)[number];
export type Department = (typeof departmentEnum.enumValues)[number];
export type PaymentMethod = (typeof paymentMethodEnum.enumValues)[number];
export type UserRoleGrant = typeof userRoleGrants.$inferSelect;
export type CustomerSegment = typeof customerSegments.$inferSelect;
export type MarketingCampaign = typeof marketingCampaigns.$inferSelect;
export type CampaignStatus = (typeof campaignStatusEnum.enumValues)[number];
export type RiskFlag = typeof riskFlags.$inferSelect;
export type RiskSeverity = (typeof riskSeverityEnum.enumValues)[number];
export type RiskSubject = (typeof riskSubjectEnum.enumValues)[number];
export type RiskFlagStatus = (typeof riskFlagStatusEnum.enumValues)[number];
export type RiderSearch = typeof riderSearches.$inferSelect;
export type DispatchAttempt = typeof dispatchAttempts.$inferSelect;
export type RiderEarningSlot = typeof riderEarningSlots.$inferSelect;
export type RiderIncentiveRule = typeof riderIncentiveRules.$inferSelect;
export type RiderIncentiveAward = typeof riderIncentiveAwards.$inferSelect;
export type RiderEarningsLedgerLine = typeof riderEarningsLedger.$inferSelect;
export type StoredImage = typeof storedImages.$inferSelect;
export type ReturnRequest = typeof returnRequests.$inferSelect;
export type ReturnItem = typeof returnItems.$inferSelect;
export type ReturnStatusHistoryRow = typeof returnStatusHistory.$inferSelect;
export type ReturnPickup = typeof returnPickups.$inferSelect;
export type NotificationPreference =
  typeof notificationPreferences.$inferSelect;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type ShopSuspension = typeof shopSuspensions.$inferSelect;
export type ShopSuspensionOrder = typeof shopSuspensionOrders.$inferSelect;
export type ExternalPriceReference =
  typeof externalPriceReferences.$inferSelect;
export type ExternalPriceReferenceHistoryRow =
  typeof externalPriceReferenceHistory.$inferSelect;
export type MrpCorrection = typeof mrpCorrections.$inferSelect;
export type ShopCategory = typeof shopCategories.$inferSelect;
export type ShopCategoryMapping = typeof shopCategoryMapping.$inferSelect;
