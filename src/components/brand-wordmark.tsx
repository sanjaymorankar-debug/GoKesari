import clsx from "clsx";

/**
 * The "GoKesari" wordmark: the whole word in the logo's saffron, with the
 * capital G and K heavier than the rest. Every place that spells the brand as styled
 * text uses this, so the look stays the same across the site, Seller Central
 * and the apps (which show the website).
 *
 * `tone="dark"` is for dark backgrounds (Seller Central, the /sell page), where
 * the lighter saffron step keeps the contrast readable.
 */
export function BrandWordmark({ tone = "light", className }: { tone?: "light" | "dark"; className?: string }) {
  return (
    <span className={clsx("font-semibold", brandColour(tone), className)} data-testid="brand-wordmark">
      <span data-testid="brand-go">
        <span className="font-extrabold">G</span>o
      </span>
      <span data-testid="brand-kesari">
        <span className="font-extrabold">K</span>esari
      </span>
    </span>
  );
}

/** Saffron text that reads well on a light or a dark background. */
function brandColour(tone: "light" | "dark"): string {
  return tone === "dark" ? "text-kesari-300" : "text-kesari-700";
}

/** The tagline, saffron and bold wherever it appears. */
export const BRAND_TAGLINE = "Everything for Everyone";

export function BrandTagline({ tone = "light", className }: { tone?: "light" | "dark"; className?: string }) {
  return (
    <span className={clsx("font-bold", brandColour(tone), className)} data-testid="brand-tagline">
      {BRAND_TAGLINE}
    </span>
  );
}
