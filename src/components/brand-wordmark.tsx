import clsx from "clsx";

/**
 * The "GoKesari" wordmark: "Go" in green, "Kesari" in saffron, with the G and
 * the K heavier than the rest. Every place that spells the brand as styled
 * text uses this, so the look stays the same across the site, Seller Central
 * and the apps (which show the website).
 *
 * `tone="dark"` is for dark backgrounds (Seller Central, the /sell page), where
 * the lighter green and saffron steps keep the contrast readable.
 */
export function BrandWordmark({ tone = "light", className }: { tone?: "light" | "dark"; className?: string }) {
  return (
    <span className={clsx("font-semibold", className)} data-testid="brand-wordmark">
      <span className={tone === "dark" ? "text-leaf-500" : "text-leaf-700"} data-testid="brand-go">
        <span className="font-extrabold">G</span>o
      </span>
      <span className={tone === "dark" ? "text-kesari-300" : "text-kesari-700"} data-testid="brand-kesari">
        <span className="font-extrabold">K</span>esari
      </span>
    </span>
  );
}

/** The tagline, green and bold wherever it appears. */
export const BRAND_TAGLINE = "Everything for Everyone";

export function BrandTagline({ tone = "light", className }: { tone?: "light" | "dark"; className?: string }) {
  return (
    <span className={clsx("font-bold", tone === "dark" ? "text-leaf-500" : "text-leaf-700", className)} data-testid="brand-tagline">
      {BRAND_TAGLINE}
    </span>
  );
}
