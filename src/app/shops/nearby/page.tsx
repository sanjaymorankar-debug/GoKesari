import Link from "next/link";

import { NearbyShops } from "@/components/nearby-shops";

export const metadata = { title: "Nearby shops" };

/**
 * Nearby (docs/nearby-referral-2026-10, feature 1): shops near the user's real
 * position, from the "Nearby" chip on the home board. Open to everyone; the
 * position is asked for in the browser, and becomes the delivery location
 * (a cookie on this device, not the database) only when none is chosen yet.
 */
export default function NearbyShopsPage() {
  return (
    <div className="-mx-4 min-h-[70svh] bg-[var(--gk-bg)] px-2 py-3 sm:mx-0 sm:rounded-3xl sm:px-4 lg:px-6" data-testid="nearby-page">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Nearby shops</h1>
          <p className="text-sm text-ink-700">Registered GoKesari shops near you, nearest first.</p>
        </div>
        <Link prefetch={false} href="/shops" className="inline-flex min-h-11 items-center whitespace-nowrap text-sm font-semibold text-kesari-800 hover:underline">
          All shops →
        </Link>
      </div>
      <NearbyShops />
    </div>
  );
}
