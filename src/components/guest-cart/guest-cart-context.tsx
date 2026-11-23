"use client";

/**
 * docs/guest-cart-2026-11: tells client components whether a signed-out
 * shopper may fill a cart (flag guest_cart_enabled, read by the root layout
 * only for guests) and gives them the browser cart, kept in step across
 * cards, tabs and the header badge.
 */
import { createContext, useContext, useEffect, useState } from "react";

import { emptyGuestCart, GUEST_CART_EVENT, GUEST_CART_STORAGE_KEY, readGuestCart, type GuestCart } from "@/lib/guest-cart";

const GuestCartEnabled = createContext(false);

export function GuestCartProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return <GuestCartEnabled.Provider value={enabled}>{children}</GuestCartEnabled.Provider>;
}

/** True when this visitor is a guest and the guest cart is switched on. */
export function useGuestCartEnabled(): boolean {
  return useContext(GuestCartEnabled);
}

/** The browser's guest cart, updated live; empty on the server's render and while switched off. */
export function useGuestCart(active: boolean): GuestCart {
  const [cart, setCart] = useState<GuestCart>(() => emptyGuestCart(0));
  useEffect(() => {
    if (!active) return;
    const sync = () => setCart(readGuestCart());
    sync();
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === GUEST_CART_STORAGE_KEY) sync();
    };
    window.addEventListener(GUEST_CART_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(GUEST_CART_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, [active]);
  return cart;
}
