/**
 * Common contract every external delivery partner adapter implements (docs/hdms-2026-11).
 * Core order code never sees a provider's own fields: adapters translate to and from these shapes.
 */
import type { BookingStatus, DeliveryProviderCode } from "@/server/db/hdms-schema";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface DeliveryParty {
  name: string;
  phone: string;
  address: string;
  pincode: string | null;
  point: GeoPoint;
}

export interface ShipmentSpec {
  orderNumber: string;
  orderValuePaise: number;
  weightGrams: number;
  /** Cash to collect from the customer (COD), 0 when prepaid. */
  codPaise: number;
  requiresRefrigeration: boolean;
  fragile: boolean;
  itemCount: number;
}

export interface QuoteRequest {
  pickup: DeliveryParty;
  drop: DeliveryParty;
  shipment: ShipmentSpec;
  distanceM: number;
}

export interface QuoteResult {
  serviceable: boolean;
  feePaise?: number;
  /** Minutes until the parcel reaches the customer, including pickup. */
  etaMinutes?: number;
  reason?: string;
}

export interface BookRequest extends QuoteRequest {
  /** Sent to the provider so a retried call never books twice. */
  idempotencyKey: string;
  /** The customer's delivery code, if the provider can check it at the door. */
  deliveryOtp?: string | null;
}

export interface BookResult {
  externalRef: string;
  status: BookingStatus;
  feePaise?: number;
  etaMinutes?: number;
  trackingUrl?: string | null;
}

export interface TrackResult {
  status: BookingStatus;
  riderName?: string | null;
  riderPhone?: string | null;
  riderLocation?: GeoPoint | null;
  etaMinutes?: number | null;
  failureReason?: string | null;
  finalFeePaise?: number | null;
}

/** One normalised event from a provider webhook. */
export interface ProviderEvent {
  eventId: string;
  externalRef: string;
  status: BookingStatus;
  occurredAt: Date;
  riderName?: string | null;
  riderPhone?: string | null;
  riderLocation?: GeoPoint | null;
  etaMinutes?: number | null;
  reason?: string | null;
  finalFeePaise?: number | null;
}

export interface ProviderContext {
  code: DeliveryProviderCode;
  environment: "SANDBOX" | "PRODUCTION";
  baseUrl: string | null;
  credentials: Record<string, unknown>;
  timeoutMs: number;
}

export interface DeliveryProviderAdapter {
  code: DeliveryProviderCode;
  /** False until the provider's official API documentation and sandbox are implemented. */
  integrated: boolean;
  quote(ctx: ProviderContext, req: QuoteRequest): Promise<QuoteResult>;
  book(ctx: ProviderContext, req: BookRequest): Promise<BookResult>;
  track(ctx: ProviderContext, externalRef: string): Promise<TrackResult>;
  cancel(ctx: ProviderContext, externalRef: string, reason: string): Promise<{ cancelled: boolean; feePaise?: number }>;
  /** Checks the webhook signature over the exact raw body. */
  verifyWebhook(rawBody: string, headers: Headers, secret: string | null): boolean;
  parseWebhook(rawBody: string): ProviderEvent[];
}

/** Thrown for a call that must not be retried (bad request, refused, not integrated). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_INTEGRATED" | "NOT_CONFIGURED" | "TIMEOUT" | "UNAVAILABLE" | "REJECTED" | "CIRCUIT_OPEN" | "BAD_RESPONSE",
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
