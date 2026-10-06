"use client";

import { useState } from "react";
import Link from "next/link";

import { RatingBadge } from "@/components/rating-badge";
import { Badge } from "@/components/ui";

type ViewMode = "grid" | "list";

/**
 * Exactly what a shop card shows, resolved on the server by ShopGrid. Only
 * these fields are serialised into the page — never the full shop row, which
 * carries the owner's phone, fee and tax details.
 */
export interface ShopCardData {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  ownerName: string;
  area: string | null;
  city: string;
  pincode: string;
  deliveryAvailable: boolean;
  ratingAvgX100: number;
  ratingCount: number;
  typeLabel: string;
  open: boolean;
  /** Present when discovery ran against a customer location (GS-019). */
  distanceKm: number | null;
}

/** The grid/list toggle and the cards themselves (requirement §15). */
export function ShopGridView({ shops }: { shops: ShopCardData[] }) {
  const [view, setView] = useState<ViewMode>("grid");

  return (
    <div>
      <div className="mb-3 flex justify-end gap-1">
        <button
          type="button"
          onClick={() => setView("grid")}
          aria-pressed={view === "grid"}
          aria-label="Grid view"
          className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
            view === "grid"
              ? "border-kesari-300 bg-kesari-50 text-kesari-700"
              : "border-cream-200 text-ink-500 hover:bg-cream-100"
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="inline-block align-[-2px]">
            <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" />
            <rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" />
            <rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" />
            <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
          </svg>{" "}
          Grid
        </button>
        <button
          type="button"
          onClick={() => setView("list")}
          aria-pressed={view === "list"}
          aria-label="List view"
          className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
            view === "list"
              ? "border-kesari-300 bg-kesari-50 text-kesari-700"
              : "border-cream-200 text-ink-500 hover:bg-cream-100"
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="inline-block align-[-2px]">
            <rect x="1" y="2" width="14" height="2.4" rx="1" fill="currentColor" />
            <rect x="1" y="6.8" width="14" height="2.4" rx="1" fill="currentColor" />
            <rect x="1" y="11.6" width="14" height="2.4" rx="1" fill="currentColor" />
          </svg>{" "}
          List
        </button>
      </div>

      {view === "grid" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {shops.map((shop) => (
            <ShopCard key={shop.id} shop={shop} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {shops.map((shop) => (
            <ShopListRow key={shop.id} shop={shop} />
          ))}
        </div>
      )}
    </div>
  );
}

function distanceText(distanceKm: number | null): string | null {
  return distanceKm == null ? null : `${distanceKm} km away`;
}

function ShopCard({ shop }: { shop: ShopCardData }) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-cream-200 bg-white transition-shadow hover:shadow-md">
      <div className="flex h-24 items-center justify-center bg-gradient-to-br from-cream-100 to-cream-200">
        {shop.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shop.logoUrl}
            alt=""
            className="h-16 w-16 rounded-full object-cover"
          />
        ) : (
          <span className="text-2xl font-bold text-kesari-600">
            {shop.name.charAt(0)}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <Badge>{shop.typeLabel}</Badge>
          {shop.open ? (
            <Badge tone="success">Open</Badge>
          ) : (
            <Badge tone="danger">Closed</Badge>
          )}
        </div>

        <h3 className="text-base font-semibold text-ink-900">{shop.name}</h3>
        <RatingBadge avgX100={shop.ratingAvgX100} count={shop.ratingCount} />
        <p className="mt-0.5 text-sm text-ink-500">{shop.ownerName}</p>
        <p className="mt-0.5 text-sm text-ink-500">
          {[shop.area, shop.city].filter(Boolean).join(", ")} · {shop.pincode}
        </p>

        <div className="mt-2 text-xs text-ink-500">
          {shop.deliveryAvailable ? "Home delivery available" : "Pickup only"}
          {distanceText(shop.distanceKm) ? ` · ${distanceText(shop.distanceKm)}` : null}
        </div>

        <Link
          href={`/shops/${shop.slug}`}
          className="mt-4 inline-flex justify-center rounded-lg border border-cream-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-cream-100"
        >
          View Shop
        </Link>
      </div>
    </div>
  );
}

function ShopListRow({ shop }: { shop: ShopCardData }) {
  return (
    <Link
      href={`/shops/${shop.slug}`}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-cream-200 bg-white p-3 hover:border-kesari-300 hover:bg-cream-50 sm:flex-nowrap"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-ink-900">{shop.name}</h3>
          {shop.open ? (
            <Badge tone="success">Open</Badge>
          ) : (
            <Badge tone="danger">Closed</Badge>
          )}
        </div>
        <p className="truncate text-sm text-ink-500">{shop.ownerName}</p>
      </div>
      <p className="shrink-0 text-sm text-ink-500">
        {[shop.area, shop.city].filter(Boolean).join(", ")} · {shop.pincode}
        {distanceText(shop.distanceKm) ? ` · ${distanceText(shop.distanceKm)}` : null}
      </p>
    </Link>
  );
}
