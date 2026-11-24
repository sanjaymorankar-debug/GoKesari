/**
 * Delivery Pricing Engine (docs/hdms-2026-11). `priceDelivery` is pure (unit-tested); `pricingRuleFor`
 * picks the rule (zone rule first, then city-wide, then lowest priority number; inside its validity).
 *
 * Fee = max(minimum, minimum + per-km × km beyond base) + per-kg × kg beyond free weight
 *       + express surcharge (30-minute window) + peak surcharge (IST peak windows), capped at max, − promo.
 * Who pays (commercial model):
 *   CUSTOMER_PAYS       customer pays the fee (less any GoKesari subsidy);
 *   SHOP_PAYS           the shop pays it all (from its wallet at delivery);
 *   SHARED              the shop pays shop_share_percent, the customer the rest (less subsidy);
 *   GOKESARI_SPONSORED  GoKesari pays (all of it, or up to gokesari_subsidy_paise when set), customer any rest;
 *   FREE_ABOVE_BASKET   free for the customer at/above free_above_paise (GoKesari pays), else customer pays.
 */
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { deliveryPricingRules, type BookingPricing, type DeliveryPricingRule } from "@/server/db/hdms-schema";

export interface PricingInput {
  distanceM: number;
  weightGrams: number;
  basketPaise: number;
  express: boolean;
  at: Date;
}

type RuleShape = Pick<
  DeliveryPricingRule,
  | "id"
  | "commercialModel"
  | "minFeePaise"
  | "baseKm"
  | "perKmPaise"
  | "freeWeightGrams"
  | "perKgPaise"
  | "expressSurchargePaise"
  | "peakSurchargePaise"
  | "peakWindows"
  | "freeAbovePaise"
  | "shopSharePercent"
  | "gokesariSubsidyPaise"
  | "promoDiscountPaise"
  | "maxFeePaise"
>;

/** "HH:MM" in India time. */
export function istClock(at: Date): string {
  const ist = new Date(at.getTime() + 330 * 60_000);
  return `${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
}

export function isPeak(at: Date, windows: { from: string; to: string }[]): boolean {
  const now = istClock(at);
  return windows.some((w) => (w.from <= w.to ? now >= w.from && now < w.to : now >= w.from || now < w.to));
}

export function priceDelivery(rule: RuleShape, input: PricingInput): BookingPricing {
  const lines: { label: string; paise: number }[] = [];
  const km = Math.max(0, input.distanceM) / 1000;
  const extraKm = Math.max(0, km - Number(rule.baseKm));
  const distancePart = Math.round(extraKm * rule.perKmPaise);
  lines.push({ label: `Minimum fee (first ${Number(rule.baseKm)} km)`, paise: rule.minFeePaise });
  if (distancePart > 0) lines.push({ label: `Distance ${extraKm.toFixed(1)} km × ₹${(rule.perKmPaise / 100).toFixed(2)}`, paise: distancePart });
  const extraKg = Math.max(0, input.weightGrams - rule.freeWeightGrams) / 1000;
  const weightPart = Math.round(Math.ceil(extraKg) * rule.perKgPaise);
  if (weightPart > 0) lines.push({ label: `Weight ${Math.ceil(extraKg)} kg over ${rule.freeWeightGrams / 1000} kg`, paise: weightPart });
  if (input.express && rule.expressSurchargePaise > 0) lines.push({ label: "Express delivery", paise: rule.expressSurchargePaise });
  if (rule.peakSurchargePaise > 0 && isPeak(input.at, rule.peakWindows)) lines.push({ label: "Peak hours", paise: rule.peakSurchargePaise });

  let total = lines.reduce((s, l) => s + l.paise, 0);
  if (rule.maxFeePaise != null && total > rule.maxFeePaise) {
    lines.push({ label: "Capped at maximum fee", paise: rule.maxFeePaise - total });
    total = rule.maxFeePaise;
  }
  if (rule.promoDiscountPaise > 0) {
    const promo = Math.min(total, rule.promoDiscountPaise);
    lines.push({ label: "Promotional discount", paise: -promo });
    total -= promo;
  }

  let customer = total;
  let shop = 0;
  let gokesari = 0;
  switch (rule.commercialModel) {
    case "SHOP_PAYS":
      shop = total;
      customer = 0;
      break;
    case "SHARED":
      shop = Math.round((total * rule.shopSharePercent) / 100);
      customer = total - shop;
      break;
    case "GOKESARI_SPONSORED":
      gokesari = rule.gokesariSubsidyPaise > 0 ? Math.min(total, rule.gokesariSubsidyPaise) : total;
      customer = total - gokesari;
      break;
    case "FREE_ABOVE_BASKET":
      if (rule.freeAbovePaise != null && input.basketPaise >= rule.freeAbovePaise) {
        gokesari = total;
        customer = 0;
      }
      break;
    case "CUSTOMER_PAYS":
      break;
  }
  // A GoKesari subsidy (when set) also lowers the customer's share under the other models.
  if (rule.commercialModel !== "GOKESARI_SPONSORED" && rule.gokesariSubsidyPaise > 0 && customer > 0) {
    const sub = Math.min(customer, rule.gokesariSubsidyPaise);
    customer -= sub;
    gokesari += sub;
  }
  return { totalFeePaise: total, customerPaise: customer, shopPaise: shop, gokesariPaise: gokesari, ruleId: rule.id ?? null, model: rule.commercialModel, lines };
}

/** The rule that applies in a zone (or city-wide when zoneId is null) at a time. */
export async function pricingRuleFor(zoneId: string | null, at: Date = new Date()): Promise<DeliveryPricingRule | null> {
  const rows = await db
    .select()
    .from(deliveryPricingRules)
    .where(
      and(
        eq(deliveryPricingRules.active, true),
        zoneId ? or(eq(deliveryPricingRules.zoneId, zoneId), isNull(deliveryPricingRules.zoneId)) : isNull(deliveryPricingRules.zoneId),
        or(isNull(deliveryPricingRules.validFrom), lte(deliveryPricingRules.validFrom, at)),
        or(isNull(deliveryPricingRules.validUntil), gt(deliveryPricingRules.validUntil, at)),
      ),
    )
    .orderBy(sql`(${deliveryPricingRules.zoneId} IS NULL)`, asc(deliveryPricingRules.priority), asc(deliveryPricingRules.createdAt));
  return rows[0] ?? null;
}
