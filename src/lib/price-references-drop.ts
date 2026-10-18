/**
 * F1.4.3 "Online reference prices" (GS-023) — DROPPED (batch-2026-10 WS-A).
 *
 * Other websites do not permit their prices to be used, so external reference
 * prices are never shown to customers or shops, and nothing fetches them at
 * runtime. This is a code constant on purpose, not a setting: no admin switch
 * can bring the section back. The PR #23 code (service, tables, admin
 * manager, API) stays in place, isolated, in case the decision changes — that
 * would be a code change with its own review.
 */
export const PRICE_REFERENCES_DROPPED = true as boolean;

export const PRICE_REFERENCES_DROPPED_NOTICE = "Dropped — other websites do not permit their prices to be used.";

/** The flag an offline price-fetching script must be given to run at all. */
export const DROPPED_ACK_FLAG = "--i-understand-dropped";

/**
 * Offline CLIs that pull prices from other websites (scripts/pmd/fetch-prices.ts)
 * refuse to run unless explicitly acknowledged. Returns the refusal message, or
 * null when the flag was given.
 */
export function droppedFeatureRefusal(argv: readonly string[]): string | null {
  if (!PRICE_REFERENCES_DROPPED || argv.includes(DROPPED_ACK_FLAG)) return null;
  return (
    `F1.4.3 "Online reference prices" is DROPPED: ${PRICE_REFERENCES_DROPPED_NOTICE}\n` +
    `This script fetches prices from another website and is kept only for the record. ` +
    `Pass ${DROPPED_ACK_FLAG} if you really need to run it (offline research only; never shown in the app).`
  );
}
