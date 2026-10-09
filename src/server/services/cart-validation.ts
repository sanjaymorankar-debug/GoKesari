/**
 * Cart ⇄ delivery-location validation.
 *
 * Whenever the delivery location changes (or before checkout) the cart is
 * re-checked, shop by shop, against that location:
 *   - does the shop deliver there (radius / extra zones / PIN / society partner)?
 *   - is the shop taking orders (approved, not paused)?
 *   - are the lines still purchasable (stock, availability)?
 *   - does the subtotal meet the shop's minimum order value?
 *   - what is the delivery charge at this location?
 *
 * Each issue carries a suggested action so the customer is told what to do,
 * not just that something is wrong. Checkout re-checks the hard rules itself;
 * this is the customer-facing explanation of them.
 */
import { inArray } from "drizzle-orm";

import { formatShopTime, isShopOpenNow, nextOpeningAt } from "@/lib/shop-hours";
import type { CustomerLocation } from "@/lib/location";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { clearCartForShop, getCart, type CartSummary } from "./cart";
import { shopServiceability, societyPartnerShopIds, withWalletGate } from "./serviceability";

export type CartIssueCode =
  | "NOT_DELIVERABLE"
  | "ORDERS_PAUSED"
  | "SHOP_UNAVAILABLE"
  | "ITEMS_UNAVAILABLE"
  | "BELOW_MINIMUM"
  | "SHOP_CLOSED_NOW";

export type CartIssueAction =
  | "CHANGE_ADDRESS"
  | "REMOVE_SHOP_ITEMS"
  | "REMOVE_UNAVAILABLE_ITEMS"
  | "ADD_ITEMS"
  | "NONE";

export interface CartIssue {
  code: CartIssueCode;
  /** True when checkout would be refused for this shop because of the issue. */
  blocking: boolean;
  message: string;
  action: CartIssueAction;
}

export interface ShopCartCheck {
  shopId: string;
  shopName: string;
  eligible: boolean;
  distanceKm: number | null;
  subtotalPaise: number;
  deliveryFeePaise: number;
  minOrderPaise: number;
  shortfallPaise: number;
  issues: CartIssue[];
}

export interface CartLocationValidation {
  ok: boolean;
  location: Pick<CustomerLocation, "label" | "pincode" | "addressId"> | null;
  shops: ShopCartCheck[];
}

export function checkShopForLocation(
  shop: typeof shops.$inferSelect,
  group: CartSummary["groups"][number],
  location: CustomerLocation | null,
  societyPartners: Set<string>,
  now: Date = new Date(),
): ShopCartCheck {
  const issues: CartIssue[] = [];
  const purchasable = group.lines.filter((l) => l.purchasable);
  const unavailable = group.lines.filter((l) => !l.purchasable);
  let distanceKm: number | null = null;

  if (shop.status !== "APPROVED" || shop.deletedAt) {
    issues.push({
      code: "SHOP_UNAVAILABLE",
      blocking: true,
      message: `${shop.name} is not open for orders.`,
      action: "REMOVE_SHOP_ITEMS",
    });
  } else if (shop.ordersPaused) {
    issues.push({
      code: "ORDERS_PAUSED",
      blocking: true,
      message: `${shop.name} is not taking new orders right now. Try again later or remove its items.`,
      action: "REMOVE_SHOP_ITEMS",
    });
  } else if (location && shop.deliveryAvailable) {
    const check = shopServiceability(shop, location);
    distanceKm = check.distanceKm;
    const partner = societyPartners.has(shop.id);
    if (!check.deliversHere && !partner) {
      issues.push({
        code: "NOT_DELIVERABLE",
        blocking: true,
        message: `${shop.name} does not deliver to ${location.label}. ${check.reason ?? ""}`.trim(),
        action: "CHANGE_ADDRESS",
      });
    }
  }

  if (unavailable.length > 0) {
    issues.push({
      code: "ITEMS_UNAVAILABLE",
      blocking: purchasable.length === 0,
      message:
        purchasable.length === 0
          ? `None of the items from ${shop.name} can be ordered right now.`
          : `${unavailable.length} item${unavailable.length === 1 ? "" : "s"} from ${shop.name} cannot be ordered and will be left out.`,
      action: "REMOVE_UNAVAILABLE_ITEMS",
    });
  }

  const subtotalPaise = group.subtotalPaise;
  const shortfallPaise = Math.max(0, shop.minOrderPaise - subtotalPaise);
  if (purchasable.length > 0 && shop.deliveryAvailable && shortfallPaise > 0) {
    issues.push({
      code: "BELOW_MINIMUM",
      blocking: true,
      message: `${shop.name} needs a minimum order of ₹${(shop.minOrderPaise / 100).toFixed(0)} — add ₹${(shortfallPaise / 100).toFixed(0)} more.`,
      action: "ADD_ITEMS",
    });
  }

  if (!isShopOpenNow(shop, now)) {
    const opens = nextOpeningAt(shop, now);
    issues.push({
      code: "SHOP_CLOSED_NOW",
      blocking: false,
      message: `${shop.name} might be closed right now${opens ? ` (opens ${formatShopTime(opens)})` : ""}. You can still place the order — it may be processed once the shop opens, and you will be asked to confirm.`,
      action: "NONE",
    });
  }

  return {
    shopId: shop.id,
    shopName: shop.name,
    eligible: !issues.some((i) => i.blocking),
    distanceKm,
    subtotalPaise,
    deliveryFeePaise: group.deliveryFeePaise,
    minOrderPaise: shop.minOrderPaise,
    shortfallPaise,
    issues,
  };
}

export async function validateCartForLocation(
  userId: string,
  location: CustomerLocation | null,
): Promise<CartLocationValidation> {
  const cart = await getCart(userId);
  const ids = cart.groups.map((g) => g.shop.id);
  // A shop whose wallet is below the minimum counts as paused (rule shopWallet).
  const rows = await withWalletGate(ids.length ? await db.select().from(shops).where(inArray(shops.id, ids)) : []);
  const partners = await societyPartnerShopIds(location?.societyId);

  const checks = cart.groups.flatMap((group) => {
    const shop = rows.find((r) => r.id === group.shop.id);
    return shop ? [checkShopForLocation(shop, group, location, partners)] : [];
  });

  return {
    ok: checks.every((c) => c.eligible),
    location: location
      ? { label: location.label, pincode: location.pincode, addressId: location.addressId }
      : null,
    shops: checks,
  };
}

/** Removes every line of one shop from the cart — the "cannot deliver here" resolution. */
export async function removeShopFromCart(userId: string, shopId: string): Promise<void> {
  await clearCartForShop(userId, shopId);
}
