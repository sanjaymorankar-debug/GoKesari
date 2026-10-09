"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { tr, UI, type Lang } from "@/lib/board/i18n";

/**
 * Every tap on a link gets a visible answer at once, even on a slow 4G
 * phone: a progress bar across the top (and "Loading…" for screen readers)
 * from the tap until the next page arrives. Client-side only, so pages keep
 * their real HTTP redirects and status codes.
 */
export function NavigationFeedback({ lang }: { lang: Lang }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [shown, setShown] = useState(`${pathname}?${search}`);

  // A new page has arrived: stop (render-time sync, not an effect).
  const current = `${pathname}?${search}`;
  if (current !== shown) {
    setShown(current);
    setLoading(false);
  }

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return; // same page (an #anchor)
      setLoading(true);
    };
    const onSubmit = () => setLoading(true);
    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("submit", onSubmit);
    };
  }, []);

  // Never stay stuck: a navigation that does not change the URL (a refused form) clears after 10 s.
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setLoading(false), 10_000);
    return () => clearTimeout(t);
  }, [loading]);

  if (!loading) return null;
  return (
    <div role="status" aria-live="polite" className="fixed inset-x-0 top-0 z-[60] h-1 overflow-hidden bg-kesari-100" data-testid="navigation-feedback">
      <div className="h-full w-1/3 animate-[gk-progress_1.2s_ease-in-out_infinite] bg-kesari-700" />
      <span className="sr-only">{tr(UI.loading, lang)}</span>
    </div>
  );
}
