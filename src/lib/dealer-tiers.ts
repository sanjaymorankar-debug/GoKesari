/**
 * Tiered dealer commission and shop-refers-shop (docs/dealer-programme/TIERED_COMMISSION.md):
 * names shared by the server and the screens. No secrets — client bundles import this file.
 *
 * A dealer network has at most three levels: the MAIN_DEALER (the dealers row,
 * level 1), TEAM_LEADs reporting to it (level 2) and AGENTs reporting to a lead
 * (level 3) or straight to the main dealer (level 2). The database refuses a
 * fourth level (migration 0136).
 */

export const DEALER_COMMISSION_MODELS = ["STANDARD", "TIERED"] as const;
export type DealerCommissionModel = (typeof DEALER_COMMISSION_MODELS)[number];

export const TEAM_ROLES = ["TEAM_LEAD", "AGENT"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
/** Including the main dealer, for statements and the tree. */
export type NetworkRole = TeamRole | "MAIN_DEALER";

export const NETWORK_ROLE_LABELS: Record<NetworkRole, string> = {
  MAIN_DEALER: "Main dealer",
  TEAM_LEAD: "Team lead",
  AGENT: "Agent",
};

/**
 * One line per entry type in the ledger and the statement. BASE is the
 * standard (BASE_PERCENT / milestone rules) commission; the rest are TIERED.
 */
export const COMMISSION_ENTRY_TYPES = [
  "BASE",
  "DIRECT_1",
  "DIRECT_2",
  "OVERRIDE_LEAD",
  "OVERRIDE_MAIN",
  "RENEWAL",
  "DEVELOPMENT",
  "BONUS",
] as const;
export type CommissionEntryType = (typeof COMMISSION_ENTRY_TYPES)[number];

export const COMMISSION_ENTRY_TYPE_LABELS: Record<CommissionEntryType, string> = {
  BASE: "Commission",
  DIRECT_1: "Direct — part 1 (activation)",
  DIRECT_2: "Direct — part 2 (trading)",
  OVERRIDE_LEAD: "Team-lead override",
  OVERRIDE_MAIN: "Main-dealer override",
  RENEWAL: "Renewal commission",
  DEVELOPMENT: "Development bonus",
  BONUS: "Monthly target bonus",
};

/** Short names for the statement's "line per type" (direct-1, direct-2, override, renewal, development, bonus). */
export const STATEMENT_LINES: { key: string; label: string; types: CommissionEntryType[] }[] = [
  { key: "standard", label: "Commission (standard)", types: ["BASE"] },
  { key: "direct-1", label: "Direct — part 1", types: ["DIRECT_1"] },
  { key: "direct-2", label: "Direct — part 2", types: ["DIRECT_2"] },
  { key: "override", label: "Overrides", types: ["OVERRIDE_LEAD", "OVERRIDE_MAIN"] },
  { key: "renewal", label: "Renewal", types: ["RENEWAL"] },
  { key: "development", label: "Development bonus", types: ["DEVELOPMENT"] },
  { key: "bonus", label: "Target bonus", types: ["BONUS"] },
];

export const TIER_PLAN_STATUSES = ["PENDING", "TRADING", "LAPSED", "REVERSED"] as const;
export type TierPlanStatus = (typeof TIER_PLAN_STATUSES)[number];

export const TIER_PLAN_STATUS_LABELS: Record<TierPlanStatus, string> = {
  PENDING: "Waiting for trading",
  TRADING: "Trading — paid in full",
  LAPSED: "Lapsed (not trading in time)",
  REVERSED: "Reversed",
};

export const TEAM_REQUEST_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type TeamRequestStatus = (typeof TEAM_REQUEST_STATUSES)[number];

/** The agent agreement a team member (and a main dealer moving to TIERED) accepts before earning; bump when its text changes. */
export const AGENT_AGREEMENT_VERSION = "2026-11-02";

export const AGENT_AGREEMENT_TEXT = [
  "I join the GoKesari dealer network as an independent agent, not as an employee of GoKesari.",
  "I pay no joining fee, and I am never paid for recruiting anyone. I earn commission only when a shop I signed (or my team signed) pays its GoKesari registration or renewal fee.",
  "Commission is a percentage of the fee actually paid, before GST and after any coupon, as shown in my dealer portal. It is reversed if the fee is refunded or waived, or the shop is found to be a duplicate, a branch or fraudulent; a reversal after payment is deducted from my next payout.",
  "I am paid monthly to my own verified bank account, under my own PAN. Tax may be deducted at source as the law requires.",
  "I will not mislead shop owners, promise income, or take any money from them myself.",
];

/** Shop referral codes: "SHOP" + 5 letters/digits (9 characters), never confused with the 8-character dealer and customer codes. */
export const SHOP_REFERRAL_CODE_PATTERN = /^SHOP[A-HJ-NP-Z2-9]{5}$/;
export const isShopReferralCode = (code: string | null | undefined) => SHOP_REFERRAL_CODE_PATTERN.test((code ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""));

export const SHOP_REFERRAL_STATUSES = ["PENDING", "REWARDED", "REJECTED", "REVERSED"] as const;
export type ShopReferralStatus = (typeof SHOP_REFERRAL_STATUSES)[number];

/** Basis points → "20%" / "2.5%". */
export function formatBp(bp: number): string {
  const pct = bp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}
