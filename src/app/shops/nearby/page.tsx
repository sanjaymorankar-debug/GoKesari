import Link from "next/link";

import { NearbyShops } from "@/components/nearby-shops";
import { PUJA_SHOP_TYPE_KEY } from "@/lib/puja";

export const metadata = { title: "Nearby shops" };

/**
 * Nearby (docs/nearby-referral-2026-10, feature 1): shops near the user's real
 * position, from the "Nearby" chip on the home board. Open to everyone; the
 * position is asked for in the browser, and becomes the delivery location
 * (a cookie on this device, not the database) only when none is chosen yet.
 *
 * ?type=PUJA_SAMAGRI (docs/puja-samagri-2026-11) keeps puja shops only, from the
 * Puja Samagri tile and page; the chips switch between all shops and puja shops.
 */
export default async function NearbyShopsPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type } = await searchParams;
  const puja = type === PUJA_SHOP_TYPE_KEY;
  const chip = (active: boolean) =>
    `inline-flex min-h-9 items-center rounded-full border px-3 text-sm font-semibold ${
      active ? "border-kesari-600 bg-kesari-600 text-white" : "border-ink-200 bg-white text-ink-800 hover:border-kesari-400"
    }`;
  return (
    <div className="-mx-4 min-h-[70svh] bg-[var(--gk-bg)] px-2 py-3 sm:mx-0 sm:rounded-3xl sm:px-4 lg:px-6" data-testid="nearby-page">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">{puja ? "Puja Samagri shops nearby" : "Nearby shops"}</h1>
          <p className="text-sm text-ink-700">
            {puja ? "Puja samagri and temple supply shops near you, nearest first." : "Registered GoKesari shops near you, nearest first."}
          </p>
        </div>
        <Link prefetch={false} href={puja ? "/puja" : "/shops"} className="inline-flex min-h-11 items-center whitespace-nowrap text-sm font-semibold text-kesari-800 hover:underline">
          {puja ? "Puja products →" : "All shops →"}
        </Link>
      </div>
      <div className="mb-3 flex gap-2" role="group" aria-label="Which shops">
        <Link prefetch={false} href="/shops/nearby" className={chip(!puja)} aria-current={!puja ? "page" : undefined}>
          All shops
        </Link>
        <Link prefetch={false} href={`/shops/nearby?type=${PUJA_SHOP_TYPE_KEY}`} className={chip(puja)} aria-current={puja ? "page" : undefined} data-testid="nearby-puja-chip">
          🪔 Puja Samagri
        </Link>
      </div>
      <NearbyShops key={puja ? "puja" : "all"} shopType={puja ? PUJA_SHOP_TYPE_KEY : null} />
    </div>
  );
}
