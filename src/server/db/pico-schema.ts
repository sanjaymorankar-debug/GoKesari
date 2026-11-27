/**
 * Pico Xpress, the "gokesari.com delivery partner" (docs/pico-xpress-2026-11; drizzle/0227_pico_xpress.sql).
 *
 * A Pico shipment is an HDMS booking (delivery_bookings, provider PICO, external_ref = parent AWB), so the
 * order sync, customer tracking, wallet charge and admin lists of docs/hdms-2026-11 apply unchanged. These
 * tables hold only what is Pico's own:
 *  - delivery_awb_pool          AWB numbers fetched in bulk from Pico, allocated atomically, never reused;
 *  - delivery_shipments         the manifest we sent (Pico order id, AWB, payment, boxes, codes' nonce) and
 *                               Pico's raw state, rider and ETAs;
 *  - delivery_shipment_events   every status Pico reported, once (unique AWB + status + time) — webhook and pull;
 *  - delivery_location_pings    live rider positions (paid add-on, flag pico_live_location_enabled);
 *  - delivery_partner_api_logs  every call to Pico with phone numbers, OTPs, names, addresses and keys masked.
 * Shops, orders and bookings are referenced without foreign keys (seller / customer tables): the services check.
 */
import { bigint, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const PICO_ENVS = ["STAGING", "PRODUCTION"] as const;
export type PicoEnv = (typeof PICO_ENVS)[number];

export const AWB_STATUSES = ["AVAILABLE", "ALLOCATED", "USED", "CANCELLED"] as const;
export type AwbStatus = (typeof AWB_STATUSES)[number];

export const deliveryAwbPool = pgTable(
  "delivery_awb_pool",
  {
    awbNumber: text("awb_number").notNull(),
    env: text("env").$type<PicoEnv>().notNull(),
    status: text("status").$type<AwbStatus>().notNull().default("AVAILABLE"),
    orderId: uuid("order_id"),
    shipmentId: uuid("shipment_id"),
    /** 1 = parent AWB of the shipment, 2.. = child AWBs of extra boxes. */
    boxNo: integer("box_no"),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
    allocatedAt: ts("allocated_at"),
    usedAt: ts("used_at"),
    cancelledAt: ts("cancelled_at"),
  },
  (t) => [primaryKey({ columns: [t.awbNumber] }), index("delivery_awb_pool_available_idx").on(t.env, t.status, t.fetchedAt)],
);
export type DeliveryAwb = typeof deliveryAwbPool.$inferSelect;

/** Pico's shipment states (doc pages 5 and 6). Unknown states are stored as they come and never rejected. */
export const PICO_STATES = [
  "DRAFT",
  "CREATED",
  "DP_ASSIGNED",
  "ARRIVED_AT_PICKUP",
  "PICKED",
  "OUT_FOR_DELIVERY",
  "ARRIVED_AT_LOCATION",
  "ATTEMPTED_UNDELIVERED",
  "DELIVERED",
  "RTO",
  "RTO_DELIVERED",
  "LOST",
  "CANCELLED",
  "DAMAGED",
] as const;
export type PicoState = (typeof PICO_STATES)[number];

export const deliveryShipments = pgTable(
  "delivery_shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id").notNull(),
    orderId: uuid("order_id").notNull(),
    shopId: uuid("shop_id").notNull(),
    partnerCode: text("partner_code").notNull().default("PICO"),
    env: text("env").$type<PicoEnv>().notNull(),
    /** Our order number, with "-2", "-3"… when the order is booked again after a cancel (Pico needs it unique). */
    picoOrderId: text("pico_order_id").notNull(),
    awbNumber: text("awb_number").notNull(),
    childAwbs: jsonb("child_awbs").$type<string[]>().notNull().default([]),
    paymentType: text("payment_type").$type<"COD" | "PREPAID">().notNull(),
    collectiblePaise: bigint("collectible_paise", { mode: "number" }).notNull().default(0),
    goodsTotalPaise: bigint("goods_total_paise", { mode: "number" }).notNull(),
    numBoxes: integer("num_boxes").notNull().default(1),
    deadWeightGrams: integer("dead_weight_grams").notNull(),
    pickupType: text("pickup_type").notNull(),
    ewayBillNo: text("eway_bill_no"),
    /** Seeds the 6-digit pickup and delivery codes (HMAC with AUTH_SECRET): the codes themselves are never stored. */
    codeNonce: text("code_nonce").notNull(),
    /** Pico's raw state; unknown values kept as received. */
    status: text("status").notNull().default("CREATED"),
    partnerName: text("partner_name"),
    /** The rider's number, shown to the shop and the customer while the delivery is live; cleared when it ends. */
    partnerPhone: text("partner_phone"),
    trackingUrl: text("tracking_url"),
    pickupEtaMin: integer("pickup_eta_min"),
    deliveryEtaMin: integer("delivery_eta_min"),
    eta: ts("eta"),
    ata: ts("ata"),
    etd: ts("etd"),
    atd: ts("atd"),
    lastLat: numeric("last_lat", { precision: 9, scale: 6 }),
    lastLng: numeric("last_lng", { precision: 9, scale: 6 }),
    lastLocationAt: ts("last_location_at"),
    lastEventAt: ts("last_event_at"),
    lastReason: text("last_reason"),
    cancelReason: text("cancel_reason"),
    cancelledBy: text("cancelled_by"),
    disputeId: uuid("dispute_id"),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("delivery_shipments_booking_uq").on(t.bookingId),
    uniqueIndex("delivery_shipments_awb_uq").on(t.awbNumber),
    uniqueIndex("delivery_shipments_pico_order_uq").on(t.env, t.picoOrderId),
    index("delivery_shipments_order_idx").on(t.orderId, t.createdAt),
    index("delivery_shipments_status_idx").on(t.status, t.updatedAt),
  ],
);
export type DeliveryShipment = typeof deliveryShipments.$inferSelect;

export const deliveryShipmentEvents = pgTable(
  "delivery_shipment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentId: uuid("shipment_id"),
    awbNumber: text("awb_number").notNull(),
    status: text("status").notNull(),
    eventTs: ts("event_ts").notNull(),
    lat: numeric("lat", { precision: 9, scale: 6 }),
    lng: numeric("lng", { precision: 9, scale: 6 }),
    reason: text("reason"),
    source: text("source").$type<"WEBHOOK" | "PULL" | "SYSTEM">().notNull(),
    /** The payload with personal fields masked (DPDP). */
    rawPayload: jsonb("raw_payload"),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("delivery_shipment_events_dedupe_uq").on(t.awbNumber, t.status, t.eventTs),
    index("delivery_shipment_events_shipment_idx").on(t.shipmentId, t.eventTs),
  ],
);
export type DeliveryShipmentEvent = typeof deliveryShipmentEvents.$inferSelect;

export const deliveryLocationPings = pgTable(
  "delivery_location_pings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    awbNumber: text("awb_number").notNull(),
    lat: numeric("lat", { precision: 9, scale: 6 }).notNull(),
    lng: numeric("lng", { precision: 9, scale: 6 }).notNull(),
    pickupEtaMin: integer("pickup_eta_min"),
    deliveryEtaMin: integer("delivery_eta_min"),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [index("delivery_location_pings_awb_idx").on(t.awbNumber, t.receivedAt)],
);
export type DeliveryLocationPing = typeof deliveryLocationPings.$inferSelect;

export const deliveryPartnerApiLogs = pgTable(
  "delivery_partner_api_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerCode: text("partner_code").notNull().default("PICO"),
    env: text("env"),
    endpoint: text("endpoint").notNull(),
    method: text("method").notNull(),
    attempt: integer("attempt").notNull().default(1),
    httpStatus: integer("http_status"),
    pxCode: text("px_code"),
    responseMessage: text("response_message"),
    ok: text("ok").$type<"Y" | "N">().notNull(),
    latencyMs: integer("latency_ms").notNull(),
    requestBody: jsonb("request_body"),
    responseBody: jsonb("response_body"),
    error: text("error"),
    orderId: uuid("order_id"),
    shipmentId: uuid("shipment_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("delivery_partner_api_logs_created_idx").on(t.createdAt), index("delivery_partner_api_logs_order_idx").on(t.orderId)],
);
export type DeliveryPartnerApiLog = typeof deliveryPartnerApiLogs.$inferSelect;
