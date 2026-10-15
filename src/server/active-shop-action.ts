"use server";

import { refresh } from "next/cache";
import { cookies } from "next/headers";

import { ACTIVE_SHOP_COOKIE, ACTIVE_SHOP_COOKIE_MAX_AGE_SECONDS } from "@/lib/seller/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopsForOwner } from "@/server/services/shops";

/**
 * Seller Central's shop switcher. Remembers the chosen shop in a cookie and
 * re-renders the page for it. Only one of the signed-in owner's own shops is
 * accepted; anything else is ignored. A form action, so it also works before
 * JavaScript loads.
 */
export async function setActiveShopAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;
  const shopId = String(formData.get("shopId") ?? "");
  const shops = await listShopsForOwner(user.id);
  if (!shops.some((s) => s.id === shopId)) return;
  (await cookies()).set(ACTIVE_SHOP_COOKIE, shopId, {
    path: "/",
    maxAge: ACTIVE_SHOP_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });
  refresh();
}
