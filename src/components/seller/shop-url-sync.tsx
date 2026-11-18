"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { setActiveShopAction } from "@/server/active-shop-action";

/**
 * D-3: a Seller Central page opened with `?shop=` works on that shop, but the
 * top bar (and its counts) follow the remembered shop. When the link names
 * another of the owner's shops, remember it, as if it were picked in the shop
 * switcher, so the top bar, the page and later pages agree. Tried once per
 * shop, so a blocked cookie cannot loop.
 */
export function ShopUrlSync({ currentId, shopIds }: { currentId: string; shopIds: readonly string[] }) {
  const requested = useSearchParams().get("shop");
  const tried = useRef<string | null>(null);
  const known = requested !== null && shopIds.includes(requested);

  useEffect(() => {
    if (!requested || !known || requested === currentId || tried.current === requested) return;
    tried.current = requested;
    const form = new FormData();
    form.set("shopId", requested);
    void setActiveShopAction(form);
  }, [requested, known, currentId]);

  return null;
}
