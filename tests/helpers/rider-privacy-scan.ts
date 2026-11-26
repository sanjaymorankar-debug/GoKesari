/** Keys a rider-facing response must never carry (Rider App v2 privacy rule). cashToCollectPaise is allowed. */
const FORBIDDEN = /deliveryFee|commission|shopDeliveryCharge|shopCharge|margin|orderTotal|subtotal|customerPhone|customerName|buyer|otherRider/i;

export function findForbiddenRiderKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findForbiddenRiderKeys(v, `${path}[${i}]`));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      ...(FORBIDDEN.test(k) ? [`${path}.${k}`] : []),
      ...findForbiddenRiderKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}
