/**
 * Pickup by QR code (F4.1.3, GAP-001 — batch-2026-10 WS-B). Rule `pickupQr`;
 * off (the default) the typed 4-digit pickup code is the only way, as before.
 *
 * The QR on the shop's order screen and packing slip carries
 *
 *     GKP1.<orderId>.<nonce>.<expiry, unix seconds>.<signature>
 *
 * signature = HMAC-SHA256(PICKUP_QR_SECRET, "GKP1|orderId|nonce|expiry"),
 * base64url, 128 bits. The nonce is derived from the token row's id with the
 * same secret (so the server can redraw the same QR without storing it); the
 * row stores only a SHA-256 of the nonce. A scan is accepted once: the token
 * is spent (consumed_at) inside the pickup transaction itself
 * (markPickedUp's `inTransaction`), so a second scan is refused and a failed
 * pickup never burns it. The QR also stops working when it expires
 * (tokenTtlMinutes), when the order is no longer waiting for pickup, and for
 * any rider but the one holding the accepted delivery.
 *
 * Every scan is recorded (delivery_pickup_scans) with the rider's location;
 * a valid one marks the delivery PICKED_UP through the existing markPickedUp
 * path, which emits order.picked_up — the customer is told at once.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import QRCode from "qrcode";

import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { getEnv, type ServerEnv } from "@/lib/env";
import { db, type DbClient } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartners,
  deliveryPickupScans,
  deliveryPickupTokens,
  orders,
  type DeliveryPickupScan,
  type DeliveryPickupToken,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { markPickedUp, toRiderView, type RiderDeliveryView } from "./delivery-assignment";
import { getRule } from "./settings";

const VERSION = "GKP1";
/** Orders whose parcel is packed and waiting for the rider: the QR is shown (and valid) only then. */
export const PICKUP_QR_ORDER_STATUSES = ["READY", "ASSIGNED"] as const;

export type PickupScanOutcome = DeliveryPickupScan["outcome"];

/**
 * PICKUP_QR_SECRET; outside production AUTH_SECRET stands in when it is
 * unset. Null in production without it — the QR is then not offered.
 */
export function pickupQrSecret(env: ServerEnv = getEnv()): string | null {
  if (env.PICKUP_QR_SECRET) return env.PICKUP_QR_SECRET;
  return env.NODE_ENV === "production" ? null : env.AUTH_SECRET;
}

function requireSecret(): string {
  const secret = pickupQrSecret();
  if (!secret) throw conflict("Pickup QR is not configured on this server (PICKUP_QR_SECRET). Use the pickup code.");
  return secret;
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The nonce for a token row: re-derivable with the secret, never stored. */
export function nonceForToken(tokenId: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(`${VERSION}|nonce|${tokenId}`).digest()).slice(0, 22);
}

function signature(orderId: string, nonce: string, expiry: number, secret: string): string {
  return b64url(createHmac("sha256", secret).update(`${VERSION}|${orderId}|${nonce}|${expiry}`).digest()).slice(0, 22);
}

export function buildPickupPayload(orderId: string, nonce: string, expiresAt: Date, secret: string): string {
  const expiry = Math.floor(expiresAt.getTime() / 1000);
  return `${VERSION}.${orderId}.${nonce}.${expiry}.${signature(orderId, nonce, expiry, secret)}`;
}

export type VerifiedPayload =
  | { ok: true; orderId: string; nonce: string; expiresAt: Date }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checks the format, the signature (constant time) and the expiry. Touches no database. */
export function verifyPickupPayload(text: string, secret: string, now: Date = new Date()): VerifiedPayload {
  const parts = text.trim().split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) return { ok: false, reason: "MALFORMED" };
  const [, orderId, nonce, expiryText, sig] = parts;
  if (!UUID.test(orderId) || !/^[A-Za-z0-9_-]{22}$/.test(nonce) || !/^\d{1,12}$/.test(expiryText)) {
    return { ok: false, reason: "MALFORMED" };
  }
  const expiry = Number(expiryText);
  const expected = Buffer.from(signature(orderId, nonce, expiry, secret));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "BAD_SIGNATURE" };
  if (expiry * 1000 <= now.getTime()) return { ok: false, reason: "EXPIRED" };
  return { ok: true, orderId, nonce, expiresAt: new Date(expiry * 1000) };
}

/** The order's live token, or a new one (the old one revoked once it has expired). */
async function liveToken(orderId: string, ttlMinutes: number, secret: string, client: DbClient = db): Promise<DeliveryPickupToken> {
  const now = new Date();
  const [current] = await client
    .select()
    .from(deliveryPickupTokens)
    .where(and(eq(deliveryPickupTokens.orderId, orderId), isNull(deliveryPickupTokens.consumedAt), isNull(deliveryPickupTokens.revokedAt)));
  if (current && current.expiresAt.getTime() > now.getTime() + 60_000) return current;
  if (current) {
    await client.update(deliveryPickupTokens).set({ revokedAt: now }).where(eq(deliveryPickupTokens.id, current.id));
  }
  const id = randomUUID();
  const [created] = await client
    .insert(deliveryPickupTokens)
    .values({
      id,
      orderId,
      nonceHash: sha256(nonceForToken(id, secret)),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // A concurrent page load issued one first: use that.
  const [raced] = await client
    .select()
    .from(deliveryPickupTokens)
    .where(and(eq(deliveryPickupTokens.orderId, orderId), isNull(deliveryPickupTokens.consumedAt), isNull(deliveryPickupTokens.revokedAt)));
  if (!raced) throw conflict("Could not issue a pickup QR. Reload the page.");
  return raced;
}

export interface ShopPickupQr {
  payload: string;
  /** Inline SVG markup of the QR, ready to print. */
  svg: string;
  expiresAt: string;
}

export async function renderPickupQrSvg(payload: string): Promise<string> {
  return QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 192 });
}

/**
 * The QR for one packed order, for the shop's screens. Null when the rule is
 * off, the order is not packed and waiting (READY / ASSIGNED), or no secret
 * is configured. The caller has already checked the viewer owns the shop.
 */
export async function getPickupQrForOrder(orderId: string): Promise<ShopPickupQr | null> {
  const rule = await getRule("pickupQr");
  if (!rule.enabled) return null;
  const secret = pickupQrSecret();
  if (!secret) return null;
  const [order] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  if (!order || !(PICKUP_QR_ORDER_STATUSES as readonly string[]).includes(order.status)) return null;
  const token = await liveToken(orderId, rule.tokenTtlMinutes, secret);
  const payload = buildPickupPayload(orderId, nonceForToken(token.id, secret), token.expiresAt, secret);
  return { payload, svg: await renderPickupQrSvg(payload), expiresAt: token.expiresAt.toISOString() };
}

/** Bulk version for the shop's order list. */
export async function getPickupQrsForOrders(orderIds: readonly string[]): Promise<Map<string, ShopPickupQr>> {
  const out = new Map<string, ShopPickupQr>();
  const rule = await getRule("pickupQr");
  if (!rule.enabled || orderIds.length === 0) return out;
  for (const id of orderIds) {
    const qr = await getPickupQrForOrder(id).catch((error) => {
      console.error("[pickup-qr] could not issue QR", id, error);
      return null;
    });
    if (qr) out.set(id, qr);
  }
  return out;
}

const FAILURE_MESSAGES: Record<Exclude<PickupScanOutcome, "SUCCESS">, string> = {
  MALFORMED: "That is not a GoKesari pickup QR. Scan the QR on the order or packing slip, or type the pickup code.",
  BAD_SIGNATURE: "This pickup QR is not valid. Ask the shop for the pickup code instead.",
  EXPIRED: "This pickup QR has expired. Ask the shop to reopen the order for a fresh QR, or type the pickup code.",
  ALREADY_USED: "This pickup QR has already been used. Ask the shop for the pickup code.",
  WRONG_RIDER: "This order is assigned to another rider.",
  WRONG_ORDER: "This QR belongs to a different order. Check you have the right parcel.",
  NOT_READY: "This delivery is not waiting for pickup.",
  DISABLED: "Pickup by QR is switched off. Type the pickup code.",
  NO_GPS: "Your location is needed to confirm pickup by QR. Turn on location, or type the pickup code.",
};

function scanError(outcome: Exclude<PickupScanOutcome, "SUCCESS">): AppError {
  const details = { reason: outcome, fallback: "PICKUP_CODE" };
  const message = FAILURE_MESSAGES[outcome];
  if (outcome === "WRONG_RIDER") return new AppError("FORBIDDEN", message, details);
  if (outcome === "ALREADY_USED" || outcome === "NOT_READY" || outcome === "DISABLED") return conflict(message, details);
  return validationFailed(message, details);
}

export interface PickupScanInput {
  deliveryOrderId: string;
  actor: { id: string; role: UserRole };
  payload: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
}

export interface PickupScanResult {
  delivery: RiderDeliveryView;
  scannedAt: string;
}

/**
 * A rider scanned the shop's QR on their active delivery. Valid → PICKED_UP
 * (existing markPickedUp: order event, customer told), with the scan's time
 * and location recorded and the QR spent in the same transaction. Anything
 * else is refused with `details.reason` and `details.fallback: "PICKUP_CODE"`
 * — the typed code still works.
 */
export async function scanPickupQr(input: PickupScanInput): Promise<PickupScanResult> {
  const now = new Date();
  const gps = {
    latitude: input.latitude != null ? String(input.latitude) : null,
    longitude: input.longitude != null ? String(input.longitude) : null,
    accuracyM: input.accuracyM != null ? Math.round(input.accuracyM) : null,
  };
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, input.actor.id) });
  const [delivery] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, input.deliveryOrderId));
  if (!delivery) throw notFound("Delivery assignment");

  const record = async (
    outcome: PickupScanOutcome,
    extra: { orderId?: string | null; tokenId?: string | null } = {},
    client: DbClient = db,
  ) => {
    await client.insert(deliveryPickupScans).values({
      orderId: extra.orderId === undefined ? delivery.orderId : extra.orderId,
      deliveryOrderId: delivery.id,
      deliveryPartnerId: partner?.id ?? null,
      tokenId: extra.tokenId ?? null,
      method: "QR",
      outcome,
      ...gps,
      scannedAt: now,
    });
  };
  const refuse = async (
    outcome: Exclude<PickupScanOutcome, "SUCCESS">,
    extra: { orderId?: string | null; tokenId?: string | null } = {},
  ): Promise<never> => {
    await record(outcome, extra).catch((error) => console.error("[pickup-qr] could not record scan", error));
    throw scanError(outcome);
  };

  // Ownership first: another rider learns nothing about this delivery.
  if (!partner || delivery.deliveryPartnerId !== partner.id) {
    if (partner) await refuse("WRONG_RIDER");
    throw forbidden("This delivery assignment does not belong to you.");
  }

  const rule = await getRule("pickupQr");
  if (!rule.enabled) return refuse("DISABLED");
  const secret = requireSecret();

  const verified = verifyPickupPayload(input.payload, secret, now);
  if (!verified.ok) return refuse(verified.reason, { orderId: verified.reason === "EXPIRED" ? delivery.orderId : null });
  if (verified.orderId !== delivery.orderId) return refuse("WRONG_ORDER");

  const [token] = await db
    .select()
    .from(deliveryPickupTokens)
    .where(and(eq(deliveryPickupTokens.orderId, delivery.orderId), eq(deliveryPickupTokens.nonceHash, sha256(verified.nonce))));
  if (!token) return refuse("BAD_SIGNATURE");
  if (token.consumedAt) return refuse("ALREADY_USED", { tokenId: token.id });
  if (token.revokedAt || token.expiresAt.getTime() <= now.getTime()) return refuse("EXPIRED", { tokenId: token.id });
  if (delivery.status !== "ACCEPTED") {
    return refuse(delivery.status === "PICKED_UP" ? "ALREADY_USED" : "NOT_READY", { tokenId: token.id });
  }
  if (rule.requireGps && (input.latitude == null || input.longitude == null)) return refuse("NO_GPS", { tokenId: token.id });

  let spentByOther = false;
  try {
    const updated = await markPickedUp(delivery.id, input.actor, undefined, {
      qrVerified: true,
      inTransaction: async (tx) => {
        // Single use: spent here, in the pickup's own transaction.
        const [spent] = await tx
          .update(deliveryPickupTokens)
          .set({ consumedAt: now, consumedByPartnerId: partner.id, consumedDeliveryOrderId: delivery.id })
          .where(
            and(
              eq(deliveryPickupTokens.id, token.id),
              isNull(deliveryPickupTokens.consumedAt),
              isNull(deliveryPickupTokens.revokedAt),
            ),
          )
          .returning({ id: deliveryPickupTokens.id });
        if (!spent) {
          spentByOther = true;
          throw scanError("ALREADY_USED");
        }
        await record("SUCCESS", { tokenId: token.id }, tx);
        await recordAudit(
          {
            actorId: input.actor.id,
            actorRole: input.actor.role,
            action: AUDIT_ACTIONS.DELIVERY_PICKUP_QR_SCANNED,
            entityType: "delivery_order",
            entityId: delivery.id,
            newValue: { tokenId: token.id, ...gps },
          },
          tx,
        );
      },
    });
    return { delivery: toRiderView(updated), scannedAt: now.toISOString() };
  } catch (error) {
    if (spentByOther) {
      await record("ALREADY_USED", { tokenId: token.id }).catch(() => {});
    }
    throw error;
  }
}
