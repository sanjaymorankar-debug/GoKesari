/**
 * Rules behind the shop owner's photo catalogue (/shop/catalogue): which
 * tiles need attention, and how a tile's two price boxes become an update to
 * the listing. Pure, so the page and its tests share one definition.
 */
import { rupeesToPaise } from "./money";

export interface CatalogueTileState {
  /** The photo customers see now (the listing's own, else the product's); null when none. */
  liveImageUrl: string | null;
  /** The listing's own photos still waiting for review (F10). */
  pendingCount: number;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
}

/** Customers see no photo and none is waiting for review. */
export const needsPhoto = (tile: CatalogueTileState) => tile.liveImageUrl == null && tile.pendingCount === 0;

/** Neither an online nor an in-shop price is set, so the product cannot be sold. */
export const needsPrice = (tile: CatalogueTileState) => tile.onlinePricePaise == null && tile.offlinePricePaise == null;

/** The price a tile shows on its photo: online first, else in-shop. */
export function tagPrice(tile: Pick<CatalogueTileState, "onlinePricePaise" | "offlinePricePaise">): {
  pricePaise: number;
  channel: "online" | "in shop";
} | null {
  if (tile.onlinePricePaise != null) return { pricePaise: tile.onlinePricePaise, channel: "online" };
  if (tile.offlinePricePaise != null) return { pricePaise: tile.offlinePricePaise, channel: "in shop" };
  return null;
}

/** Body for PATCH /api/shop-products/{id}; only what changed. */
export interface PricePatch {
  onlinePricePaise?: number;
  offlinePricePaise?: number;
  onlineSaleEnabled?: true;
  offlineSaleEnabled?: true;
}

const CHANNELS = [
  { key: "online", price: "onlinePricePaise", sale: "onlineSaleEnabled", label: "online", where: "online" },
  { key: "offline", price: "offlinePricePaise", sale: "offlineSaleEnabled", label: "in-shop", where: "in the shop" },
] as const;

/**
 * Turns a tile's price boxes (rupees, as typed) into a listing update.
 *
 * An empty box leaves a channel that has no price as it is, but cannot remove
 * a price — that is done by switching the channel off under Edit on My Shop,
 * so a price is never lost by accident. A price given to a channel that had
 * none puts the product on sale there, as the inventory page's Save does.
 */
export function buildPricePatch(
  current: Pick<CatalogueTileState, "onlinePricePaise" | "offlinePricePaise">,
  input: { online: string; offline: string },
): { patch: PricePatch } | { error: string } {
  const patch: PricePatch = {};
  for (const channel of CHANNELS) {
    const raw = input[channel.key].trim();
    const before = current[channel.price];
    if (raw === "") {
      if (before != null) {
        return { error: `Enter the ${channel.label} price. To stop selling ${channel.where}, use Edit on My Shop.` };
      }
      continue;
    }
    const rupees = Number(raw);
    if (!Number.isFinite(rupees) || rupees <= 0) {
      return { error: `The ${channel.label} price must be a number greater than 0.` };
    }
    const paise = rupeesToPaise(rupees);
    if (paise === before) continue;
    patch[channel.price] = paise;
    if (before == null) patch[channel.sale] = true;
  }
  return { patch };
}
