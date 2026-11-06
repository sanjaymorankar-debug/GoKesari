/**
 * "Finish set-up" on Seller Central (onboarding Phase B, G20 — docs/onboarding-benchmark):
 * what a new shop still has to do after it goes live, each with its live status, so nothing
 * done in the registration wizard's last steps — or outside it — is forgotten. Read-only.
 *
 * Owner, 05-Nov-2026 (D4): payouts need a verified bank account; that line stays on the list
 * (and the bank banner shows) until the account is verified.
 */
import { count, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { shopCategoryMapping, shopProducts, type Shop } from "@/server/db/schema";
import { shopBankPrompt } from "./bank-accounts";
import { payoutHoldReason } from "./shop-onboarding";

/** Products a shop should list before it is "set up" (the brief's "first 10 products"). */
export const SETUP_PRODUCT_TARGET = 10;

export type SetupItemKey = "pin" | "categories" | "products" | "bank" | "delivery" | "documents";

export interface SetupItem {
  key: SetupItemKey;
  done: boolean;
  href: string;
  /** e.g. products listed so far. */
  progress?: { have: number; target: number };
}

export interface ShopSetupChecklist {
  items: SetupItem[];
  done: number;
  total: number;
  complete: boolean;
}

export async function getShopSetupChecklist(
  shop: Pick<Shop, "id" | "status" | "latitude" | "longitude" | "deliveryAvailable">,
): Promise<ShopSetupChecklist | null> {
  // A shop that is not live yet has its own next step (the approval alert); a rejected or
  // suspended one has bigger problems than its set-up.
  if (shop.status !== "APPROVED") return null;
  const [[categories], [products], bank, hold] = await Promise.all([
    db.select({ n: count() }).from(shopCategoryMapping).where(eq(shopCategoryMapping.shopId, shop.id)),
    db.select({ n: count() }).from(shopProducts).where(eq(shopProducts.shopId, shop.id)),
    shopBankPrompt(shop.id),
    payoutHoldReason(shop.id),
  ]);
  const productCount = Number(products?.n ?? 0);
  const items: SetupItem[] = [
    { key: "pin", done: shop.latitude != null && shop.longitude != null, href: "/shop/manage/location" },
    { key: "categories", done: Number(categories?.n ?? 0) > 0, href: "/shop/product-categories" },
    {
      key: "products",
      done: productCount >= SETUP_PRODUCT_TARGET,
      href: "/shop/manage/products",
      progress: { have: Math.min(productCount, SETUP_PRODUCT_TARGET), target: SETUP_PRODUCT_TARGET },
    },
    // null: bank verification is switched off on this site — nothing to ask for.
    ...(bank === null ? [] : [{ key: "bank" as const, done: bank === "VERIFIED", href: "/shop/bank-account" }]),
    { key: "delivery", done: shop.deliveryAvailable, href: "/shop/manage/location" },
    { key: "documents", done: hold === null, href: "/shop/documents" },
  ];
  const done = items.filter((i) => i.done).length;
  return { items, done, total: items.length, complete: done === items.length };
}
