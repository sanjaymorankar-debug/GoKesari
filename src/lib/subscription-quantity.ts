/**
 * How much a subscription delivery may be (TC-FLD-107) — client-safe, so the
 * subscription pages and the server use the same numbers.
 *
 * Loose goods sold by the litre or kilogram move in halves (0.5 L, 1 L,
 * 1.5 L …); anything counted or pre-packed moves one pack at a time. A
 * delivery is at most SUBSCRIPTION_MAX_UNITS litres / kilograms / packs. The
 * server refuses anything else, so an off-step amount (2.3 L) can no longer be
 * charged while stock is taken in whole units.
 */
import { MILLI_PER_UNIT } from "./money";

/** The most one delivery may carry: 50 L / 50 kg / 50 packs. */
export const SUBSCRIPTION_MAX_UNITS = 50;

const isLoose = (unit: string) => unit === "L" || unit === "kg";

/** The − / + step, in milli-units. */
export function subscriptionQuantityStep(unit: string, unitSizeMilli: number): number {
  if (isLoose(unit)) return MILLI_PER_UNIT / 2;
  return unitSizeMilli > 0 ? unitSizeMilli : MILLI_PER_UNIT;
}

/** The largest quantity one delivery may be, in milli-units (a whole number of steps). */
export function subscriptionQuantityMax(unit: string, unitSizeMilli: number): number {
  return isLoose(unit) ? SUBSCRIPTION_MAX_UNITS * MILLI_PER_UNIT : SUBSCRIPTION_MAX_UNITS * subscriptionQuantityStep(unit, unitSizeMilli);
}

/** Why a quantity is not allowed for this product, or null when it is. */
export function subscriptionQuantityProblem(quantityMilli: number, unit: string, unitSizeMilli: number): string | null {
  const step = subscriptionQuantityStep(unit, unitSizeMilli);
  const max = subscriptionQuantityMax(unit, unitSizeMilli);
  const label = (milli: number) => `${milli / MILLI_PER_UNIT} ${unit}`;
  if (!Number.isInteger(quantityMilli) || quantityMilli < step || quantityMilli % step !== 0 || quantityMilli > max) {
    return `Choose a quantity in steps of ${label(step)}, from ${label(step)} to ${label(max)} per delivery.`;
  }
  return null;
}
