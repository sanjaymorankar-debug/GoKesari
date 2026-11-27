/**
 * Admin → Delivery management → Pico Xpress (docs/pico-xpress-2026-11): switches and set-up status (never the
 * keys), AWB pool, settings (rule picoXpress), shipments with filters, API calls and webhook events.
 */
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/server/db";
import { deliveryPartnerApiLogs, deliveryShipmentEvents, deliveryShipments, type AwbStatus } from "@/server/db/pico-schema";
import { orders, shops } from "@/server/db/schema";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";

import { poolLevels } from "./awb-pool";
import { picoConfig, picoEnvForSite } from "./config";
import { BOOKING_FAILED, BOOKING_UNCONFIRMED } from "./service";
import { picoStateLabel } from "./status";

export const SHIPMENT_FILTERS = {
  live: ["CREATED", "DRAFT", "DP_ASSIGNED", "ARRIVED_AT_PICKUP", "PICKED", "OUT_FOR_DELIVERY", "ARRIVED_AT_LOCATION", "ATTEMPTED_UNDELIVERED", "RTO", BOOKING_UNCONFIRMED],
  delivered: ["DELIVERED"],
  problems: ["LOST", "DAMAGED", "RTO_DELIVERED", BOOKING_FAILED, BOOKING_UNCONFIRMED, "ATTEMPTED_UNDELIVERED"],
  cancelled: ["CANCELLED"],
} as const;
export type ShipmentFilter = keyof typeof SHIPMENT_FILTERS | "all";

export async function picoOverview() {
  const cfg = picoConfig();
  const env = picoEnvForSite();
  const [enabled, liveLocation, pool, rules] = await Promise.all([
    isFeatureEnabled("delivery_partner_picoxpress_enabled", { districtCode: null }),
    isFeatureEnabled("pico_live_location_enabled", { districtCode: null }),
    poolLevels(env).catch(() => ({ AVAILABLE: 0, ALLOCATED: 0, USED: 0, CANCELLED: 0 }) as Record<AwbStatus, number>),
    getRule("picoXpress"),
  ]);
  return {
    enabled,
    liveLocation,
    env,
    configured: cfg.ok,
    configProblem: cfg.ok ? null : cfg.problem,
    host: cfg.ok ? new URL(cfg.config.baseUrl).host : null,
    webhookTokenSet: cfg.ok ? cfg.config.webhookToken != null : false,
    pool,
    rules,
  };
}

export interface ShipmentRow {
  id: string;
  orderId: string;
  orderNumber: string;
  shopName: string;
  awbNumber: string;
  picoOrderId: string;
  status: string;
  statusLabel: string;
  paymentType: string;
  collectiblePaise: number;
  goodsTotalPaise: number;
  numBoxes: number;
  partnerName: string | null;
  lastReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function listShipments(filter: ShipmentFilter = "live", q = "", limit = 100): Promise<ShipmentRow[]> {
  const where: SQL[] = [];
  if (filter !== "all") where.push(inArray(deliveryShipments.status, [...SHIPMENT_FILTERS[filter]]));
  const term = q.trim().slice(0, 40);
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(orders.orderNumber, like), ilike(deliveryShipments.awbNumber, like), ilike(shops.name, like))!);
  }
  const rows = await db
    .select({ s: deliveryShipments, orderNumber: orders.orderNumber, shopName: shops.name })
    .from(deliveryShipments)
    .innerJoin(orders, eq(orders.id, deliveryShipments.orderId))
    .innerJoin(shops, eq(shops.id, deliveryShipments.shopId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(deliveryShipments.updatedAt))
    .limit(Math.min(500, limit));
  return rows.map(({ s, orderNumber, shopName }) => ({
    id: s.id,
    orderId: s.orderId,
    orderNumber,
    shopName,
    awbNumber: s.awbNumber,
    picoOrderId: s.picoOrderId,
    status: s.status,
    statusLabel: s.status === BOOKING_UNCONFIRMED ? "Not confirmed" : s.status === BOOKING_FAILED ? "Refused" : picoStateLabel(s.status),
    paymentType: s.paymentType,
    collectiblePaise: s.collectiblePaise,
    goodsTotalPaise: s.goodsTotalPaise,
    numBoxes: s.numBoxes,
    partnerName: s.partnerName,
    lastReason: s.lastReason,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
}

export async function recentApiLogs(limit = 50) {
  return db
    .select({
      id: deliveryPartnerApiLogs.id,
      endpoint: deliveryPartnerApiLogs.endpoint,
      method: deliveryPartnerApiLogs.method,
      attempt: deliveryPartnerApiLogs.attempt,
      httpStatus: deliveryPartnerApiLogs.httpStatus,
      pxCode: deliveryPartnerApiLogs.pxCode,
      ok: deliveryPartnerApiLogs.ok,
      latencyMs: deliveryPartnerApiLogs.latencyMs,
      responseMessage: deliveryPartnerApiLogs.responseMessage,
      error: deliveryPartnerApiLogs.error,
      orderId: deliveryPartnerApiLogs.orderId,
      createdAt: deliveryPartnerApiLogs.createdAt,
    })
    .from(deliveryPartnerApiLogs)
    .orderBy(desc(deliveryPartnerApiLogs.createdAt))
    .limit(Math.min(200, limit));
}

export async function apiLogDetail(id: string) {
  const [row] = await db.select().from(deliveryPartnerApiLogs).where(eq(deliveryPartnerApiLogs.id, id));
  return row ?? null;
}

export async function recentEvents(limit = 50) {
  return db
    .select({
      id: deliveryShipmentEvents.id,
      awbNumber: deliveryShipmentEvents.awbNumber,
      status: deliveryShipmentEvents.status,
      eventTs: deliveryShipmentEvents.eventTs,
      source: deliveryShipmentEvents.source,
      reason: deliveryShipmentEvents.reason,
      known: sql<boolean>`${deliveryShipmentEvents.shipmentId} IS NOT NULL`,
      receivedAt: deliveryShipmentEvents.receivedAt,
    })
    .from(deliveryShipmentEvents)
    .orderBy(desc(deliveryShipmentEvents.receivedAt))
    .limit(Math.min(200, limit));
}
