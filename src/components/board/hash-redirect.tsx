"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Old links into sections of a long page (`/admin#users`, `/shop#products`)
 * keep working now that each section has its own page: the browser never
 * sends `#…` to the server, so the board page sends the visitor on here.
 */
export function HashRedirect({ map }: { map: Record<string, string> }) {
  const router = useRouter();
  useEffect(() => {
    const target = map[window.location.hash.slice(1)];
    if (target) router.replace(target);
  }, [map, router]);
  return null;
}
