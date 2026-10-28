"use client";

import { useEffect, useState } from "react";

import { SHOP_TYPES } from "@/lib/shop-types";

export interface ShopTypeChoice {
  key: string;
  label: string;
}

/**
 * The shop types a person can choose: the built-in ones at once, then — once
 * `/api/shop-types` answers — those staff added from the admin screen.
 */
export function useShopTypes(): ShopTypeChoice[] {
  const [types, setTypes] = useState<ShopTypeChoice[]>(() => SHOP_TYPES.map((t) => ({ key: t.key, label: t.label })));
  useEffect(() => {
    let live = true;
    fetch("/api/shop-types")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const list = body?.data?.shopTypes ?? body?.shopTypes;
        if (live && Array.isArray(list) && list.length > 0) setTypes(list.map((t: ShopTypeChoice) => ({ key: t.key, label: t.label })));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return types;
}
