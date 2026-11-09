/**
 * A listing's status as its shop owner sees it. Pure and client-safe, so the
 * setup flow, My products, the Excel preview and the tests read one rule. The
 * customer side applies the same rule in SQL (catalogue.ts `storefrontLive`).
 */
export const LISTING_STATUSES = ["LIVE", "NEEDS_STOCK", "NEEDS_PRICE", "OUT_OF_STOCK", "PAUSED"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const LISTING_STATUS_LABEL: Record<ListingStatus, string> = {
  LIVE: "Live",
  NEEDS_STOCK: "Needs Stock",
  NEEDS_PRICE: "Needs Price",
  OUT_OF_STOCK: "Out of Stock",
  PAUSED: "Paused",
};

export interface ListingStatusInput {
  isActive: boolean;
  isAvailable: boolean;
  ownerPaused: boolean;
  categoryCarried: boolean;
  stockPending: boolean;
  trackInventory: boolean;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  onlineSaleEnabled: boolean;
  offlineSaleEnabled: boolean;
  onlineStock: number;
  offlineStock: number;
}

export function listingStatus(l: ListingStatusInput): ListingStatus {
  if (!l.isActive || l.ownerPaused || !l.categoryCarried) return "PAUSED";
  // Any stock that arrives later (a typed quantity, a supplier bill) ends the wait by itself.
  if (l.stockPending && l.trackInventory && l.onlineStock <= 0 && l.offlineStock <= 0) return "NEEDS_STOCK";
  if (l.onlinePricePaise == null && l.offlinePricePaise == null) return "NEEDS_PRICE";
  if (!l.onlineSaleEnabled && !l.offlineSaleEnabled) return "PAUSED";
  const stock = l.onlineSaleEnabled ? l.onlineStock : l.offlineStock;
  if (l.trackInventory && stock <= 0) return "OUT_OF_STOCK";
  // isAvailable also goes false at zero stock, so it means "switched off" only once stock is known to be there.
  if (l.onlineSaleEnabled && !l.isAvailable) return "PAUSED";
  return "LIVE";
}
