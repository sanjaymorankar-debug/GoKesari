/**
 * Registry of published legal/policy pages (Part 58).
 *
 * A single source of truth for the nav sidebar, the footer links, and the
 * admin compliance dashboard's "is this document published" check — so
 * adding a policy page only means adding one entry here plus the route.
 */

/** 24 Oct 2026: Privacy Policy section 2 (location data) and the location cookie. */
export const CURRENT_POLICY_VERSION = "2026-10-24";

/**
 * Placeholders that MUST be replaced with real, verified details before this
 * site is used to actually transact — see the "manual configuration
 * required" list produced alongside this feature. Centralised here so a
 * search for PLACEHOLDER finds everything that still needs a human to fill
 * it in.
 */
export const LEGAL_ENTITY = {
  legalName: "ASMY GLOBAL TRADING & CONSULTANCY INDIA PRIVATE LIMITED",
  registeredAddress: "Flat No B-1102, Yin Yang CHS, Opp EoN IT Park Phase II, Kharadi, Pune 411014",
  cinOrRegistrationNumber: "U70200PN2025PTC241573",
  gstin: "27ABCCA8318D1ZV",
  supportEmail: "support@gokesari.com",
  grievanceOfficer: {
    name: "Sonali",
    designation: "Grievance Officer",
    email: "grievance@gokesari.com",
    phone: "9175193009",
    address: "Flat No B-1102, Yin Yang CHS, Opp EoN IT Park Phase II, Kharadi, Pune 411014",
  },
};

export interface LegalDocMeta {
  slug: string;
  title: string;
  shortLabel: string;
}

export const LEGAL_DOCS: readonly LegalDocMeta[] = [
  { slug: "privacy-policy", title: "Privacy Policy", shortLabel: "Privacy Policy" },
  { slug: "terms", title: "Terms & Conditions", shortLabel: "Terms & Conditions" },
  { slug: "cookie-policy", title: "Cookie Policy", shortLabel: "Cookie Policy" },
  { slug: "refund-policy", title: "Refund & Cancellation Policy", shortLabel: "Refunds & Cancellations" },
  { slug: "shipping-policy", title: "Shipping & Delivery Policy", shortLabel: "Shipping & Delivery" },
  { slug: "subscription-terms", title: "Subscription Terms", shortLabel: "Subscription Terms" },
  { slug: "wallet-terms", title: "Wallet Terms", shortLabel: "Wallet Terms" },
  { slug: "voucher-terms", title: "Voucher Terms", shortLabel: "Voucher Terms" },
  { slug: "seller-terms", title: "Marketplace Seller Terms", shortLabel: "Seller Terms" },
  { slug: "grievance-redressal", title: "Grievance Redressal", shortLabel: "Grievance Redressal" },
] as const;
