"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { RETURN_TO_COOKIE, RETURN_TO_MAX_AGE_S, safeReturnPath } from "@/lib/return-to";

/**
 * D-23: remembers the page reached by a tap inside the app. It runs only for a
 * page actually shown, so prefetched links are never recorded (src/lib/return-to.ts).
 */
export function RememberReturnTo() {
  const pathname = usePathname();
  const query = useSearchParams().toString();

  useEffect(() => {
    const path = safeReturnPath(query ? `${pathname}?${query}` : pathname);
    if (!path) return;
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${RETURN_TO_COOKIE}=${encodeURIComponent(path)}; Max-Age=${RETURN_TO_MAX_AGE_S}; Path=/; SameSite=Lax${secure}`;
  }, [pathname, query]);

  return null;
}
