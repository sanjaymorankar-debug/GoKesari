/**
 * Seller undertaking: fresh, safe and compliant goods (docs/seller-undertaking-2026-11).
 *
 * Every shop owner promises never to send expired, stale or non-compliant goods. The undertaking is
 * accepted at registration (onboarding wizard) and, while the feature flag
 * `seller_undertaking_gate_enabled` is on, by every existing owner the next time they open Seller
 * Central. Acceptance is recorded in `user_consents` (SELLER_GOODS_UNDERTAKING + SELLER_TERMS) with
 * the version below.
 *
 * Bumping SELLER_UNDERTAKING_VERSION (or SELLER_TERMS_VERSION) makes every owner accept again: the
 * check compares the version of their latest grant with the constant.
 *
 * Wording needs lawyer review before production.
 *
 * Pure data, no server imports: the client gate and the Seller Terms page read it too.
 */

/** Version of the undertaking text. Change it whenever a clause changes in substance (forces re-acceptance). */
export const SELLER_UNDERTAKING_VERSION = "2026-11-24";

/** The date the undertaking applies from (ISO date, read as a date in India). */
export const SELLER_UNDERTAKING_EFFECTIVE_DATE = "2026-11-24";

/**
 * Version of the Marketplace Seller Terms (/legal/seller-terms). Before 24-Nov-2026 the page used the
 * general CURRENT_POLICY_VERSION; it has its own version from the day the undertaking was added to it.
 * Change it when the Seller Terms change in substance (forces re-acceptance by every shop owner).
 */
export const SELLER_TERMS_VERSION = "2026-11-24";

export const SELLER_UNDERTAKING_TITLE = "Seller undertaking: fresh, safe and compliant goods";

/** The one-line promise shown beside the checkbox. */
export const SELLER_UNDERTAKING_PROMISE =
  "I promise never to send expired, stale or non-compliant goods, to always supply fresh goods and to always share the expiry / best-before date.";

/** Text of the separate terms checkbox (gate and registration). */
export const SELLER_TERMS_ACCEPT_TEXT = "I have read and accept the Seller Terms, Terms & Conditions and Privacy Policy";

export interface SellerUndertakingClause {
  heading: string;
  text: string;
}

/** The numbered clauses, in plain language. Wording needs lawyer review before production. */
export const SELLER_UNDERTAKING_CLAUSES: readonly SellerUndertakingClause[] = [
  {
    heading: "Fresh goods only",
    text: "I will supply only fresh goods in good condition. I will not send goods that are stale, spoiled, damaged, tampered with, mouldy, infested or otherwise unfit for use.",
  },
  {
    heading: "Never expired or past best-before",
    text: "I will never send goods that are past their expiry (use-by) date, and I will not send goods past their best-before date. Goods must have enough shelf life left for the customer to use them normally.",
  },
  {
    heading: "Always share the expiry / best-before date",
    text: "Where the law or the product requires it, I will show the expiry or best-before date on the product listing (when GoKesari asks for it) and make sure it is clearly printed on the pack the customer receives. I will not hide, alter or re-label these dates.",
  },
  {
    heading: "Follow the law",
    text: "I will comply with the Food Safety and Standards Act 2006 and its regulations (including FSSAI licensing and labelling), the Legal Metrology Act 2009 and the Packaged Commodities Rules (MRP, net quantity, manufacturer details), the Drugs and Cosmetics Act 1940 and its rules where I sell medicines or cosmetics, the Consumer Protection Act 2019 and its E-Commerce Rules, and every other law that applies to the goods I sell.",
  },
  {
    heading: "Storage and handling",
    text: "I will store, pack and hand over goods as the manufacturer and the law require — chilled, frozen, dry or away from contamination as needed — so that they reach the customer in a safe condition.",
  },
  {
    heading: "Recalls and customer complaints",
    text: "If a customer receives goods that are expired, stale, damaged or non-compliant, or a product is recalled, I will promptly replace the goods or refund the customer, and take the affected stock off sale. I will cooperate with GoKesari and with the authorities on any recall or complaint.",
  },
  {
    heading: "What GoKesari may do",
    text: "If I break this undertaking, GoKesari may remove the affected listings, stop my shop from taking new orders, suspend or close my shop, refund the customer and recover that amount from my payouts or shop wallet (chargeback), and report the matter to the authorities where the law requires.",
  },
  {
    heading: "Records",
    text: "I will keep purchase invoices, batch and lot numbers and expiry records for the goods I sell for as long as the law requires, and show them to GoKesari or an authority on request.",
  },
  {
    heading: "Changes to this undertaking",
    text: "GoKesari may update this undertaking. When it does, the new version applies once I accept it, and I must accept it again before my shop can take new orders.",
  },
];

/** "24 Nov 2026" — a calendar date shown in India's time zone. */
export function formatUndertakingDate(isoDate: string): string {
  // Noon IST on that date, so the day never shifts whatever the server's zone.
  return new Date(`${isoDate}T12:00:00+05:30`).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}
