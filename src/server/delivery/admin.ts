/**
 * Delivery Administration (docs/hdms-2026-11): provider configuration, pricing rules, product delivery
 * attributes, shop-rider profiles, and the read models behind Admin → Delivery management.
 * Secrets are write-only: views say whether a credential is set, never what it is.
 */
import { and, asc, count, desc, eq, gte, inArray, sql, sum } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  COMMERCIAL_MODELS,
  deliveryAllocationRuns,
  deliveryApiLogs,
  deliveryBookings,
  deliveryEvents,
  deliveryPricingRules,
  deliveryProviders,
  deliveryQuotes,
  deliveryWebhookLogs,
  productDeliveryAttributes,
  type BookingStatus,
  type CommercialModel,
  type DeliveryProvider,
  type DeliveryProviderCode,
} from "@/server/db/hdms-schema";
import { orders, shopDeliveryStaff, shops } from "@/server/db/schema";
import { encryptCredentials, isCredentialEncryptionConfigured } from "@/server/integrations/credentials";

import { adapterFor } from "./providers/registry";
import { PARTNER_NOTES } from "./providers/partners";

/* ------------------------------------------------------------ providers */

export interface ProviderView {
  code: DeliveryProviderCode;
  name: string;
  enabled: boolean;
  environment: "SANDBOX" | "PRODUCTION";
  priority: number;
  baseUrl: string | null;
  integrated: boolean;
  note: string | null;
  hasCredentials: boolean;
  hasWebhookSecret: boolean;
  capabilities: DeliveryProvider["capabilities"];
  reliabilityPercent: number;
  timeoutMs: number;
  circuitState: "CLOSED" | "OPEN";
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export function toProviderView(p: DeliveryProvider): ProviderView {
  const adapter = adapterFor(p.code);
  return {
    code: p.code,
    name: p.name,
    enabled: p.enabled,
    environment: p.environment,
    priority: p.priority,
    baseUrl: p.baseUrl,
    integrated: Boolean(adapter?.integrated),
    note: p.code === "MOCK" ? "In-process sandbox simulator: never books a real rider and never runs on gokesari.com." : PARTNER_NOTES[p.code as Exclude<DeliveryProviderCode, "MOCK">] ?? null,
    hasCredentials: Boolean(p.credentialsEncrypted),
    hasWebhookSecret: Boolean(p.webhookSecretEncrypted),
    capabilities: p.capabilities,
    reliabilityPercent: Math.round(p.reliabilityX100 / 100),
    timeoutMs: p.timeoutMs,
    circuitState: p.circuitState,
    consecutiveFailures: p.consecutiveFailures,
    lastSuccessAt: p.lastSuccessAt?.toISOString() ?? null,
    lastError: p.lastError,
    lastErrorAt: p.lastErrorAt?.toISOString() ?? null,
  };
}

export async function listProviderViews(): Promise<ProviderView[]> {
  const rows = await db.select().from(deliveryProviders).orderBy(asc(deliveryProviders.priority), asc(deliveryProviders.code));
  return rows.map(toProviderView);
}

export interface ProviderUpdate {
  enabled?: boolean;
  environment?: "SANDBOX" | "PRODUCTION";
  priority?: number;
  baseUrl?: string | null;
  timeoutMs?: number;
  reliabilityPercent?: number;
  maxDistanceKm?: number | null;
  maxWeightKg?: number | null;
  refrigerated?: boolean;
  /** Write-only. An empty object clears the credentials. */
  credentials?: Record<string, string> | null;
  /** Write-only. Empty string clears it. */
  webhookSecret?: string | null;
  resetCircuit?: boolean;
}

export async function updateProvider(code: string, input: ProviderUpdate, actorId: string): Promise<ProviderView> {
  const [current] = await db.select().from(deliveryProviders).where(eq(deliveryProviders.code, code as DeliveryProviderCode));
  if (!current) throw notFound("Delivery partner");
  const adapter = adapterFor(current.code);
  if (input.enabled && !adapter?.integrated) {
    throw conflict(`${current.name} cannot be switched on yet: its API is not integrated. ${PARTNER_NOTES[current.code as Exclude<DeliveryProviderCode, "MOCK">] ?? ""}`.trim());
  }
  if (input.environment === "PRODUCTION" && current.capabilities?.sandboxOnly) {
    throw validationFailed("The sandbox simulator can only run in SANDBOX.");
  }
  if (input.baseUrl) {
    let url: URL;
    try {
      url = new URL(input.baseUrl);
    } catch {
      throw validationFailed("Base URL is not a valid URL.");
    }
    if (url.protocol !== "https:") throw validationFailed("Base URL must use https.");
  }
  const needsKey = (input.credentials && Object.keys(input.credentials).length > 0) || (input.webhookSecret ?? "") !== "";
  if (needsKey && !isCredentialEncryptionConfigured()) {
    throw conflict("The server has no INTEGRATION_ENCRYPTION_KEY, so partner secrets cannot be stored safely.");
  }
  const caps = { ...current.capabilities };
  if (input.maxDistanceKm !== undefined) caps.maxDistanceKm = input.maxDistanceKm ?? undefined;
  if (input.maxWeightKg !== undefined) caps.maxWeightKg = input.maxWeightKg ?? undefined;
  if (input.refrigerated !== undefined) caps.refrigerated = input.refrigerated;
  const [row] = await db
    .update(deliveryProviders)
    .set({
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl || null } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.reliabilityPercent !== undefined ? { reliabilityX100: Math.round(input.reliabilityPercent * 100) } : {}),
      ...(input.credentials !== undefined
        ? { credentialsEncrypted: input.credentials && Object.keys(input.credentials).length ? encryptCredentials(input.credentials) : null }
        : {}),
      ...(input.webhookSecret !== undefined ? { webhookSecretEncrypted: input.webhookSecret ? encryptCredentials({ secret: input.webhookSecret }) : null } : {}),
      ...(input.resetCircuit ? { circuitState: "CLOSED" as const, circuitOpenedAt: null, consecutiveFailures: 0 } : {}),
      capabilities: caps,
      updatedBy: actorId,
      updatedAt: new Date(),
    })
    .where(eq(deliveryProviders.code, current.code))
    .returning();
  return toProviderView(row);
}

/* ---------------------------------------------------------- pricing rules */

export interface PricingRuleInput {
  name: string;
  zoneId: string | null;
  active: boolean;
  priority: number;
  commercialModel: CommercialModel;
  minFeePaise: number;
  baseKm: number;
  perKmPaise: number;
  freeWeightGrams: number;
  perKgPaise: number;
  expressSurchargePaise: number;
  peakSurchargePaise: number;
  peakWindows: { from: string; to: string }[];
  freeAbovePaise: number | null;
  shopSharePercent: number;
  gokesariSubsidyPaise: number;
  promoDiscountPaise: number;
  maxFeePaise: number | null;
  validFrom: Date | null;
  validUntil: Date | null;
}

export async function savePricingRule(id: string | null, input: PricingRuleInput, actorId: string) {
  if (!COMMERCIAL_MODELS.includes(input.commercialModel)) throw validationFailed("Unknown commercial model.");
  if (input.commercialModel === "FREE_ABOVE_BASKET" && input.freeAbovePaise == null) {
    throw validationFailed("Free above basket needs the basket value.");
  }
  if (input.validFrom && input.validUntil && input.validUntil <= input.validFrom) throw validationFailed("Valid until must be after valid from.");
  const values = { ...input, baseKm: input.baseKm.toFixed(2), updatedBy: actorId, updatedAt: new Date() };
  if (id) {
    const [row] = await db.update(deliveryPricingRules).set(values).where(eq(deliveryPricingRules.id, id)).returning();
    if (!row) throw notFound("Pricing rule");
    return row;
  }
  const [row] = await db.insert(deliveryPricingRules).values(values).returning();
  return row;
}

export async function listPricingRules() {
  return db.select().from(deliveryPricingRules).orderBy(asc(deliveryPricingRules.priority), asc(deliveryPricingRules.name));
}

/* ------------------------------------------------- product delivery attrs */

export interface ProductDeliveryInput {
  perishable: boolean;
  fragile: boolean;
  temperatureSensitive: boolean;
  refrigerationRequired: boolean;
  maxDeliveryMinutes: number | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  packagingNote: string | null;
}

export async function saveProductDeliveryAttributes(productId: string, input: ProductDeliveryInput, actorId: string) {
  const values = { ...input, packagingNote: input.packagingNote?.slice(0, 300) ?? null, updatedBy: actorId, updatedAt: new Date() };
  const [row] = await db
    .insert(productDeliveryAttributes)
    .values({ productId, ...values })
    .onConflictDoUpdate({ target: productDeliveryAttributes.productId, set: values })
    .returning();
  return row;
}

/* ------------------------------------------------------- shop riders */

export interface ShopRiderProfileInput {
  isAvailable?: boolean;
  vehicleType?: string | null;
  idDocumentType?: "AADHAAR" | "PAN" | "DRIVING_LICENCE" | "VOTER_ID" | null;
  /** Full number typed by the shop: only its last 4 digits are kept. */
  idDocumentNumber?: string | null;
  idDocumentImageId?: string | null;
}

/** The shop updates its own rider (availability, vehicle, ID proof). Scoped to the shop: another shop's rider is "not found". */
export async function updateShopRiderProfile(shopId: string, staffId: string, input: ShopRiderProfileInput) {
  const [staff] = await db.select().from(shopDeliveryStaff).where(and(eq(shopDeliveryStaff.id, staffId), eq(shopDeliveryStaff.shopId, shopId)));
  if (!staff) throw notFound("Delivery person");
  const digits = input.idDocumentNumber?.replace(/\s/g, "") ?? null;
  if (digits != null && digits.length < 4) throw validationFailed("Enter the full ID number (only its last 4 characters are kept).");
  const submitting = input.idDocumentType != null && (digits != null || input.idDocumentImageId != null);
  const [row] = await db
    .update(shopDeliveryStaff)
    .set({
      ...(input.isAvailable !== undefined ? { isAvailable: input.isAvailable } : {}),
      ...(input.vehicleType !== undefined ? { vehicleType: input.vehicleType?.slice(0, 40) ?? null } : {}),
      ...(input.idDocumentType !== undefined ? { idDocumentType: input.idDocumentType } : {}),
      ...(digits != null ? { idDocumentLast4: digits.slice(-4).toUpperCase() } : {}),
      ...(input.idDocumentImageId !== undefined ? { idDocumentImageId: input.idDocumentImageId } : {}),
      ...(submitting ? { kycStatus: "SUBMITTED" as const } : {}),
      updatedAt: new Date(),
    })
    .where(eq(shopDeliveryStaff.id, staffId))
    .returning();
  return row;
}

export async function decideShopRiderKyc(staffId: string, verified: boolean) {
  const [row] = await db
    .update(shopDeliveryStaff)
    .set({ kycStatus: verified ? "VERIFIED" : "REJECTED", updatedAt: new Date() })
    .where(and(eq(shopDeliveryStaff.id, staffId), eq(shopDeliveryStaff.kycStatus, "SUBMITTED")))
    .returning();
  if (!row) throw conflict("Only a submitted ID proof can be verified or rejected.");
  return row;
}

export async function listShopRiders(filter: { kycStatus?: string } = {}) {
  return db
    .select({
      id: shopDeliveryStaff.id,
      shopId: shopDeliveryStaff.shopId,
      shopName: shops.name,
      name: shopDeliveryStaff.name,
      phone: shopDeliveryStaff.phoneE164,
      isActive: shopDeliveryStaff.isActive,
      isAvailable: shopDeliveryStaff.isAvailable,
      vehicleType: shopDeliveryStaff.vehicleType,
      idDocumentType: shopDeliveryStaff.idDocumentType,
      idDocumentLast4: shopDeliveryStaff.idDocumentLast4,
      kycStatus: shopDeliveryStaff.kycStatus,
    })
    .from(shopDeliveryStaff)
    .innerJoin(shops, eq(shops.id, shopDeliveryStaff.shopId))
    .where(filter.kycStatus ? eq(shopDeliveryStaff.kycStatus, filter.kycStatus as "SUBMITTED") : undefined)
    .orderBy(asc(shops.name), asc(shopDeliveryStaff.name))
    .limit(500);
}

/* ------------------------------------------------------------ read models */

export const BOOKING_GROUPS: Record<"active" | "completed" | "failed" | "cancelled", BookingStatus[]> = {
  active: ["CREATED", "SEARCHING", "ASSIGNED", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "RETURNING"],
  completed: ["DELIVERED"],
  failed: ["FAILED", "RETURNED"],
  cancelled: ["CANCELLED"],
};

export async function listBookings(filter: { group?: keyof typeof BOOKING_GROUPS; shopId?: string; limit?: number }) {
  const conds = [];
  if (filter.group) conds.push(inArray(deliveryBookings.status, BOOKING_GROUPS[filter.group]));
  if (filter.shopId) conds.push(eq(deliveryBookings.shopId, filter.shopId));
  return db
    .select({
      booking: deliveryBookings,
      orderNumber: orders.orderNumber,
      orderStatus: orders.status,
      shopName: shops.name,
    })
    .from(deliveryBookings)
    .innerJoin(orders, eq(orders.id, deliveryBookings.orderId))
    .leftJoin(shops, eq(shops.id, deliveryBookings.shopId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(deliveryBookings.createdAt))
    .limit(Math.min(filter.limit ?? 100, 500));
}

export async function bookingDetail(bookingId: string) {
  const [row] = await db
    .select({ booking: deliveryBookings, orderNumber: orders.orderNumber, orderStatus: orders.status, shopName: shops.name })
    .from(deliveryBookings)
    .innerJoin(orders, eq(orders.id, deliveryBookings.orderId))
    .leftJoin(shops, eq(shops.id, deliveryBookings.shopId))
    .where(eq(deliveryBookings.id, bookingId));
  if (!row) throw notFound("Delivery booking");
  const events = await db.select().from(deliveryEvents).where(eq(deliveryEvents.bookingId, bookingId)).orderBy(asc(deliveryEvents.occurredAt));
  const runs = await db.select().from(deliveryAllocationRuns).where(eq(deliveryAllocationRuns.orderId, row.booking.orderId)).orderBy(desc(deliveryAllocationRuns.createdAt)).limit(10);
  const quotes = runs.length ? await db.select().from(deliveryQuotes).where(inArray(deliveryQuotes.runId, runs.map((r) => r.id))) : [];
  return { ...row, events, runs, quotes };
}

export async function deliveryDashboard(since: Date) {
  const byStatus = await db
    .select({ status: deliveryBookings.status, n: count() })
    .from(deliveryBookings)
    .where(gte(deliveryBookings.createdAt, since))
    .groupBy(deliveryBookings.status);
  const byProvider = await db
    .select({
      provider: deliveryBookings.providerCode,
      n: count(),
      delivered: sql<number>`count(*) FILTER (WHERE ${deliveryBookings.status} = 'DELIVERED')`.mapWith(Number),
      failed: sql<number>`count(*) FILTER (WHERE ${deliveryBookings.status} IN ('FAILED','RETURNED'))`.mapWith(Number),
      cost: sum(sql`coalesce(${deliveryBookings.finalFeePaise}, ${deliveryBookings.quotedFeePaise}, 0)`).mapWith(Number),
      avgMinutes: sql<number>`avg(extract(epoch FROM (${deliveryBookings.terminalAt} - ${deliveryBookings.createdAt})) / 60) FILTER (WHERE ${deliveryBookings.status} = 'DELIVERED')`.mapWith(Number),
    })
    .from(deliveryBookings)
    .where(gte(deliveryBookings.createdAt, since))
    .groupBy(deliveryBookings.providerCode);
  const runs = await db
    .select({ outcome: deliveryAllocationRuns.outcome, channel: deliveryAllocationRuns.chosenChannel, n: count() })
    .from(deliveryAllocationRuns)
    .where(gte(deliveryAllocationRuns.createdAt, since))
    .groupBy(deliveryAllocationRuns.outcome, deliveryAllocationRuns.chosenChannel);
  return { byStatus, byProvider, runs };
}

export async function integrationHealth(since: Date) {
  const rows = await db
    .select({
      provider: deliveryApiLogs.providerCode,
      operation: deliveryApiLogs.operation,
      calls: count(),
      failures: sql<number>`count(*) FILTER (WHERE NOT ${deliveryApiLogs.ok})`.mapWith(Number),
      p95Ms: sql<number>`percentile_disc(0.95) WITHIN GROUP (ORDER BY ${deliveryApiLogs.durationMs})`.mapWith(Number),
    })
    .from(deliveryApiLogs)
    .where(gte(deliveryApiLogs.createdAt, since))
    .groupBy(deliveryApiLogs.providerCode, deliveryApiLogs.operation)
    .orderBy(deliveryApiLogs.providerCode, deliveryApiLogs.operation);
  const recentErrors = await db
    .select()
    .from(deliveryApiLogs)
    .where(and(gte(deliveryApiLogs.createdAt, since), eq(deliveryApiLogs.ok, false)))
    .orderBy(desc(deliveryApiLogs.createdAt))
    .limit(30);
  return { rows, recentErrors };
}

export async function listWebhookLogs(limit = 100) {
  return db.select().from(deliveryWebhookLogs).orderBy(desc(deliveryWebhookLogs.receivedAt)).limit(Math.min(limit, 500));
}
