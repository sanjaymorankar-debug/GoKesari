/**
 * Hyperlocal Delivery Management System (docs/hdms-2026-11; drizzle/0189_hdms_delivery.sql).
 *
 * Extends the existing delivery stack (delivery_partners, delivery_orders, shop_delivery_staff,
 * rider searches) with external providers, zones, pricing rules, bookings across every channel,
 * provider settlements and product delivery attributes. Shops and products are not referenced by
 * foreign key (seller-side tables): the services check those links. Re-exported by schema.ts.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const DELIVERY_PROVIDER_CODES = ["SHADOWFAX", "PIDGE", "PORTER", "BORZO", "MOCK", "PICO"] as const;
export type DeliveryProviderCode = (typeof DELIVERY_PROVIDER_CODES)[number];

export interface DeliveryProviderCapabilities {
  /** False until the provider's official API is implemented in its adapter. */
  integrated?: boolean;
  maxDistanceKm?: number;
  maxWeightKg?: number;
  refrigerated?: boolean;
  /** Only ever used on staging / tests (the in-process simulator). */
  sandboxOnly?: boolean;
}

export const deliveryProviders = pgTable("delivery_providers", {
  code: text("code").$type<DeliveryProviderCode>().primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  environment: text("environment").$type<"SANDBOX" | "PRODUCTION">().notNull().default("SANDBOX"),
  priority: integer("priority").notNull().default(100),
  baseUrl: text("base_url"),
  credentialsEncrypted: text("credentials_encrypted"),
  webhookSecretEncrypted: text("webhook_secret_encrypted"),
  capabilities: jsonb("capabilities").$type<DeliveryProviderCapabilities>().notNull().default({}),
  reliabilityX100: integer("reliability_x100").notNull().default(9000),
  timeoutMs: integer("timeout_ms").notNull().default(8000),
  circuitState: text("circuit_state").$type<"CLOSED" | "OPEN">().notNull().default("CLOSED"),
  circuitOpenedAt: ts("circuit_opened_at"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastSuccessAt: ts("last_success_at"),
  lastError: text("last_error"),
  lastErrorAt: ts("last_error_at"),
  updatedBy: uuid("updated_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type DeliveryProvider = typeof deliveryProviders.$inferSelect;

export const deliveryZones = pgTable("delivery_zones", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  city: text("city").notNull(),
  centerLat: numeric("center_lat", { precision: 9, scale: 6 }).notNull(),
  centerLng: numeric("center_lng", { precision: 9, scale: 6 }).notNull(),
  radiusM: integer("radius_m").notNull().default(3000),
  /** [[lat, lng], ...] — when set, it replaces the circle. */
  polygon: jsonb("polygon").$type<[number, number][] | null>(),
  maxDeliveryKm: numeric("max_delivery_km", { precision: 5, scale: 2 }).notNull().default("6"),
  status: text("status").$type<"ACTIVE" | "SUSPENDED">().notNull().default("ACTIVE"),
  suspendedReason: text("suspended_reason"),
  suspendedUntil: ts("suspended_until"),
  updatedBy: uuid("updated_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type DeliveryZone = typeof deliveryZones.$inferSelect;

export const COMMERCIAL_MODELS = ["CUSTOMER_PAYS", "SHOP_PAYS", "SHARED", "GOKESARI_SPONSORED", "FREE_ABOVE_BASKET"] as const;
export type CommercialModel = (typeof COMMERCIAL_MODELS)[number];

export const deliveryPricingRules = pgTable("delivery_pricing_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  zoneId: uuid("zone_id"),
  active: boolean("active").notNull().default(true),
  priority: integer("priority").notNull().default(100),
  commercialModel: text("commercial_model").$type<CommercialModel>().notNull().default("CUSTOMER_PAYS"),
  minFeePaise: integer("min_fee_paise").notNull().default(2000),
  baseKm: numeric("base_km", { precision: 5, scale: 2 }).notNull().default("2"),
  perKmPaise: integer("per_km_paise").notNull().default(800),
  freeWeightGrams: integer("free_weight_grams").notNull().default(5000),
  perKgPaise: integer("per_kg_paise").notNull().default(500),
  expressSurchargePaise: integer("express_surcharge_paise").notNull().default(1000),
  peakSurchargePaise: integer("peak_surcharge_paise").notNull().default(1000),
  peakWindows: jsonb("peak_windows").$type<{ from: string; to: string }[]>().notNull().default([]),
  freeAbovePaise: integer("free_above_paise"),
  shopSharePercent: integer("shop_share_percent").notNull().default(50),
  gokesariSubsidyPaise: integer("gokesari_subsidy_paise").notNull().default(0),
  promoDiscountPaise: integer("promo_discount_paise").notNull().default(0),
  maxFeePaise: integer("max_fee_paise"),
  validFrom: ts("valid_from"),
  validUntil: ts("valid_until"),
  updatedBy: uuid("updated_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type DeliveryPricingRule = typeof deliveryPricingRules.$inferSelect;

export const DELIVERY_CHANNELS = ["SHOP_RIDER", "GOKESARI_RIDER", "EXTERNAL"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const BOOKING_STATUSES = [
  "CREATED",
  "SEARCHING",
  "ASSIGNED",
  "AT_PICKUP",
  "PICKED_UP",
  "IN_TRANSIT",
  "DELIVERED",
  "FAILED",
  "RETURNING",
  "RETURNED",
  "CANCELLED",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const TERMINAL_BOOKING_STATUSES: readonly BookingStatus[] = ["DELIVERED", "FAILED", "RETURNED", "CANCELLED"];

export interface BookingPricing {
  totalFeePaise: number;
  customerPaise: number;
  shopPaise: number;
  gokesariPaise: number;
  ruleId: string | null;
  model: CommercialModel;
  lines: { label: string; paise: number }[];
}

export const deliveryBookings = pgTable(
  "delivery_bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull(),
    shopId: uuid("shop_id").notNull(),
    channel: text("channel").$type<DeliveryChannel>().notNull(),
    providerCode: text("provider_code").$type<DeliveryProviderCode>(),
    shopDeliveryStaffId: uuid("shop_delivery_staff_id"),
    zoneId: uuid("zone_id"),
    status: text("status").$type<BookingStatus>().notNull().default("CREATED"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    externalRef: text("external_ref"),
    trackingUrl: text("tracking_url"),
    riderName: text("rider_name"),
    riderPhoneMasked: text("rider_phone_masked"),
    riderLat: numeric("rider_lat", { precision: 9, scale: 6 }),
    riderLng: numeric("rider_lng", { precision: 9, scale: 6 }),
    riderLocationAt: ts("rider_location_at"),
    etaAt: ts("eta_at"),
    distanceM: integer("distance_m"),
    quotedFeePaise: integer("quoted_fee_paise"),
    finalFeePaise: integer("final_fee_paise"),
    pricing: jsonb("pricing").$type<BookingPricing | null>(),
    cancelReason: text("cancel_reason"),
    cancelledBy: text("cancelled_by").$type<"CUSTOMER" | "SHOP" | "PROVIDER" | "ADMIN" | "SYSTEM">(),
    failureReason: text("failure_reason"),
    lastPolledAt: ts("last_polled_at"),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    terminalAt: ts("terminal_at"),
  },
  (t) => [
    uniqueIndex("delivery_bookings_one_live_per_order")
      .on(t.orderId)
      .where(sql`${t.status} NOT IN ('DELIVERED','FAILED','RETURNED','CANCELLED')`),
    index("delivery_bookings_status_idx").on(t.status, t.createdAt),
    index("delivery_bookings_shop_idx").on(t.shopId, t.createdAt),
  ],
);
export type DeliveryBooking = typeof deliveryBookings.$inferSelect;

export const deliveryEvents = pgTable("delivery_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingId: uuid("booking_id").notNull(),
  status: text("status").notNull(),
  source: text("source").$type<"WEBHOOK" | "POLL" | "SHOP" | "ADMIN" | "SYSTEM" | "CUSTOMER">().notNull(),
  note: text("note"),
  lat: numeric("lat", { precision: 9, scale: 6 }),
  lng: numeric("lng", { precision: 9, scale: 6 }),
  occurredAt: ts("occurred_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type DeliveryEvent = typeof deliveryEvents.$inferSelect;

export const deliveryAllocationRuns = pgTable("delivery_allocation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull(),
  trigger: text("trigger").notNull(),
  outcome: text("outcome").$type<"BOOKED" | "INTERNAL" | "NO_CANDIDATE" | "SKIPPED" | "ERROR">().notNull(),
  chosenChannel: text("chosen_channel"),
  chosenProvider: text("chosen_provider"),
  bookingId: uuid("booking_id"),
  distanceM: integer("distance_m"),
  requirements: jsonb("requirements").$type<Record<string, unknown>>().notNull().default({}),
  detail: text("detail"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type DeliveryAllocationRun = typeof deliveryAllocationRuns.$inferSelect;

export const deliveryQuotes = pgTable("delivery_quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  channel: text("channel").notNull(),
  providerCode: text("provider_code"),
  serviceable: boolean("serviceable").notNull(),
  feePaise: integer("fee_paise"),
  etaMinutes: integer("eta_minutes"),
  reliabilityX100: integer("reliability_x100"),
  score: numeric("score", { precision: 8, scale: 4 }),
  rejectedReason: text("rejected_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type DeliveryQuote = typeof deliveryQuotes.$inferSelect;

export const deliveryWebhookLogs = pgTable("delivery_webhook_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerCode: text("provider_code").notNull(),
  eventId: text("event_id").notNull(),
  signatureValid: boolean("signature_valid").notNull(),
  bookingId: uuid("booking_id"),
  result: text("result").notNull(),
  payload: jsonb("payload"),
  receivedAt: ts("received_at").notNull().defaultNow(),
});
export type DeliveryWebhookLog = typeof deliveryWebhookLogs.$inferSelect;

export const deliveryApiLogs = pgTable("delivery_api_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerCode: text("provider_code").notNull(),
  operation: text("operation").notNull(),
  ok: boolean("ok").notNull(),
  httpStatus: integer("http_status"),
  durationMs: integer("duration_ms").notNull(),
  attempt: integer("attempt").notNull().default(1),
  error: text("error"),
  bookingId: uuid("booking_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type DeliveryApiLog = typeof deliveryApiLogs.$inferSelect;

export const deliverySettlements = pgTable("delivery_settlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerCode: text("provider_code").$type<DeliveryProviderCode>().notNull(),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  status: text("status").$type<"OPEN" | "RECONCILED" | "DISPUTED" | "PAID">().notNull().default("OPEN"),
  bookingCount: integer("booking_count").notNull().default(0),
  expectedPaise: bigint("expected_paise", { mode: "number" }).notNull().default(0),
  invoicedPaise: bigint("invoiced_paise", { mode: "number" }),
  differencePaise: bigint("difference_paise", { mode: "number" }),
  invoiceRef: text("invoice_ref"),
  paidRef: text("paid_ref"),
  notes: text("notes"),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type DeliverySettlement = typeof deliverySettlements.$inferSelect;

export const deliveryReconciliationLines = pgTable("delivery_reconciliation_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  settlementId: uuid("settlement_id").notNull(),
  bookingId: uuid("booking_id"),
  externalRef: text("external_ref"),
  expectedPaise: integer("expected_paise"),
  invoicedPaise: integer("invoiced_paise"),
  result: text("result").$type<"MATCHED" | "AMOUNT_MISMATCH" | "NOT_IN_INVOICE" | "UNKNOWN_BOOKING">().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type DeliveryReconciliationLine = typeof deliveryReconciliationLines.$inferSelect;

export const productDeliveryAttributes = pgTable("product_delivery_attributes", {
  productId: uuid("product_id").primaryKey(),
  perishable: boolean("perishable").notNull().default(false),
  fragile: boolean("fragile").notNull().default(false),
  temperatureSensitive: boolean("temperature_sensitive").notNull().default(false),
  refrigerationRequired: boolean("refrigeration_required").notNull().default(false),
  maxDeliveryMinutes: integer("max_delivery_minutes"),
  weightGrams: integer("weight_grams"),
  lengthMm: integer("length_mm"),
  widthMm: integer("width_mm"),
  heightMm: integer("height_mm"),
  packagingNote: text("packaging_note"),
  updatedBy: uuid("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type ProductDeliveryAttributes = typeof productDeliveryAttributes.$inferSelect;
