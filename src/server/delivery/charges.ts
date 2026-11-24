/**
 * Money hooks of delivery management into the existing finance flow (docs/hdms-2026-11).
 * - partnerDeliveryShopCharge: the shop's share of a partner delivery, debited from the shop wallet by the
 *   existing walletCollectionFor at delivery (rule shopWallet on). No new ledger or wallet of its own.
 * - quoteDeliveryFee: what the pricing rules give for a shop → address trip (who pays what). Used for
 *   partner bookings and the quote API; the checkout fee itself stays the shop's flat fee (see README §Pricing).
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import { deliveryBookings } from "@/server/db/hdms-schema";

import { haversineMeters, parsePoint, ROAD_FACTOR } from "./geo";
import { priceDelivery, pricingRuleFor } from "./pricing";
import { zoneForPoint } from "./zones";

export async function partnerDeliveryShopCharge(orderId: string, client: DbClient = db): Promise<{ chargePaise: number; distanceM: number | null }> {
  const [b] = await client
    .select({ pricing: deliveryBookings.pricing, distanceM: deliveryBookings.distanceM })
    .from(deliveryBookings)
    .where(and(eq(deliveryBookings.orderId, orderId), eq(deliveryBookings.channel, "EXTERNAL"), inArray(deliveryBookings.status, ["DELIVERED"])))
    .orderBy(desc(deliveryBookings.createdAt))
    .limit(1);
  const share = b?.pricing?.shopPaise ?? 0;
  return { chargePaise: Math.max(0, Math.round(share)), distanceM: b?.distanceM ?? null };
}

export interface FeeQuoteInput {
  shop: { latitude: string | null; longitude: string | null };
  drop: { latitude?: string | null; longitude?: string | null } | null;
  subtotalPaise: number;
  weightGrams?: number;
  express: boolean;
  at?: Date;
}

/** The pricing-rule split for a trip, or null (no location / no rule). */
export async function quoteDeliveryFee(input: FeeQuoteInput): Promise<{ feePaise: number; breakdown: ReturnType<typeof priceDelivery> } | null> {
  const shopPoint = parsePoint(input.shop.latitude, input.shop.longitude);
  const dropPoint = parsePoint(input.drop?.latitude, input.drop?.longitude);
  if (!shopPoint || !dropPoint) return null;
  const zone = await zoneForPoint(shopPoint);
  const rule = await pricingRuleFor(zone?.id ?? null, input.at);
  if (!rule) return null;
  const breakdown = priceDelivery(rule, {
    distanceM: Math.round(haversineMeters(shopPoint, dropPoint) * ROAD_FACTOR),
    weightGrams: input.weightGrams ?? 0,
    basketPaise: input.subtotalPaise,
    express: input.express,
    at: input.at ?? new Date(),
  });
  return { feePaise: breakdown.customerPaise, breakdown };
}
