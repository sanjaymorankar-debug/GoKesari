/**
 * Rider App v2 privacy guard: what a rider-facing response must never carry.
 *
 * A rider sees what THEY earn and, on cash-on-delivery orders, the cash to
 * collect at the door (`cashToCollectPaise`). Never the customer's delivery
 * fee, the order total, the platform's commission or margin, shop charges, or
 * the customer's name and phone. Tests run every rider response shape through
 * `findForbiddenKeys` (tests/unit/rider-privacy.test.ts); other tests may reuse it.
 *
 * No server imports: shared by unit tests and, if wanted, API routes.
 */

/** Key names a rider response must not contain (case-insensitive). */
export const RIDER_FORBIDDEN_KEY = /deliveryFee|commission|shopDeliveryCharge|shopCharge|margin|orderTotal|customerPhone|customerName|buyer/i;

/** Keys allowed even if a future pattern would catch them. */
export const RIDER_ALLOWED_KEYS: ReadonlySet<string> = new Set(["cashToCollectPaise"]);

/**
 * Every path (e.g. `jobs[0].breakdown.commissionPaise`) whose key matches the
 * forbidden pattern, walking objects and arrays to any depth. Empty = clean.
 */
export function findForbiddenKeys(
  value: unknown,
  pattern: RegExp = RIDER_FORBIDDEN_KEY,
  allowed: ReadonlySet<string> = RIDER_ALLOWED_KEYS,
): string[] {
  const found: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (node: unknown, path: string) => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (node instanceof Date) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (!allowed.has(key) && pattern.test(key)) found.push(childPath);
      walk(child, childPath);
    }
  };
  walk(value, "");
  return found;
}
