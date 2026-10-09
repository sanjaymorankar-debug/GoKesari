"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";

import { InviteShopCard } from "@/components/invite-shop-card";
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
  area: string | null;
  city: string;
  pincode: string;
  ratingAvgX100: number;
  ratingCount: number;
  typeKey: string;
  typeLabel: string;
  open: boolean;
  /** "Open till 10 PM", "Closed · opens Fri 9:00 AM". */
  hoursLabel: string;
  isNew: boolean;
  /** "Delivers to you · 1.2 km", "Pickup only · ready in about 15 min". */
  fulfilment: string;
  pickupOnly: boolean;
  /** Null when no customer location is known. */
  deliversHere: boolean | null;
}

type Toggle = "open" | "delivers";

const chipClass = (active: boolean) =>
  `tap-target whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium transition-colors [--tap-h:44px] ${
    active
      ? "border-kesari-500 bg-kesari-50 text-kesari-700"
      : "border-cream-200 bg-white text-ink-700 hover:bg-cream-100"
  }`;

/** The cards, with optional quick filters and a grid/list switch (requirement §15). */
export function ShopGridView({
  shops,
  filterChips,
  viewToggle,
  toolbar,
  inviteArea,
}: {
  shops: ShopCardData[];
  filterChips: boolean;
  viewToggle: boolean;
  toolbar?: ReactNode;
  inviteArea: string | true | null;
}) {
  const [view, setView] = useState<ViewMode>("grid");
  const [type, setType] = useState<string | null>(null);
  const [toggles, setToggles] = useState<Toggle[]>([]);

  // A chip is offered only when it would narrow this list: some shops match
  // and some don't. One shop, or shops all of one kind, get no chips at all —
  // a filter that can only ever answer "nothing" is not offered.
  const types = [...new Map(shops.map((s) => [s.typeKey, s.typeLabel])).entries()];
  const narrows = (count: number) => count > 0 && count < shops.length;
  const typeChips = filterChips && types.length > 1 ? types : [];
  const offered: { key: Toggle; label: string }[] = filterChips
    ? [
        ...(narrows(shops.filter((s) => s.open).length) ? [{ key: "open" as const, label: "Open now" }] : []),
        ...(narrows(shops.filter((s) => s.deliversHere === true).length)
          ? [{ key: "delivers" as const, label: "Delivers to me" }]
          : []),
      ]
    : [];
  const hasChips = typeChips.length > 0 || offered.length > 0;

  const visible = shops.filter(
    (s) =>
      (type == null || s.typeKey === type) &&
      (!toggles.includes("open") || s.open) &&
      (!toggles.includes("delivers") || s.deliversHere === true),
  );
  const flip = (key: Toggle) =>
    setToggles((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));

  return (
    <div>
      {hasChips ? (
        <div className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 py-1" role="group" aria-label="Filter shops" data-testid="shop-filter-chips">
          <button type="button" aria-pressed={type == null && toggles.length === 0} className={chipClass(type == null && toggles.length === 0)} onClick={() => { setType(null); setToggles([]); }}>
            All
          </button>
          {typeChips.map(([key, label]) => (
            <button key={key} type="button" aria-pressed={type === key} className={chipClass(type === key)} onClick={() => setType(type === key ? null : key)}>
              {label}
            </button>
          ))}
          {offered.map((chip) => (
            <button key={chip.key} type="button" aria-pressed={toggles.includes(chip.key)} className={chipClass(toggles.includes(chip.key))} onClick={() => flip(chip.key)}>
              {chip.label}
            </button>
          ))}
        </div>
      ) : null}

      {viewToggle || toolbar ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>{toolbar}</div>
          {viewToggle ? (
            // 8px apart, with 40px-tall tap areas that stay clear of the
            // controls above and the first shop below.
            <div className="flex gap-2">
              <ViewButton mode="grid" view={view} setView={setView} />
              <ViewButton mode="list" view={view} setView={setView} />
            </div>
          ) : null}
        </div>
      ) : null}

      {visible.length === 0 && shops.length > 0 ? (
        <p className="rounded-xl border border-cream-200 bg-white p-6 text-center text-sm text-ink-600">
          No shops match these filters.{" "}
          <button type="button" className="font-medium text-kesari-600 underline" onClick={() => { setType(null); setToggles([]); }}>
            Show all
          </button>
        </p>
      ) : view === "grid" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {visible.map((shop) => (
            <ShopCard key={shop.id} shop={shop} />
          ))}
          {inviteArea ? <InviteShopCard area={inviteArea === true ? null : inviteArea} /> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((shop) => (
            <ShopListRow key={shop.id} shop={shop} />
          ))}
          {inviteArea ? <InviteShopCard area={inviteArea === true ? null : inviteArea} /> : null}
        </div>
      )}
    </div>
  );
}

function ViewButton({ mode, view, setView }: { mode: ViewMode; view: ViewMode; setView: (m: ViewMode) => void }) {
  const active = view === mode;
  return (
    <button
      type="button"
      onClick={() => setView(mode)}
      aria-pressed={active}
      aria-label={mode === "grid" ? "Grid view" : "List view"}
      className={`tap-target rounded-lg border px-3 py-1.5 text-sm font-medium [--tap-h:40px] ${
        active
          ? "border-kesari-300 bg-kesari-50 text-kesari-700"
          : "border-cream-200 bg-white text-ink-600 hover:bg-cream-100"
      }`}
    >
      {mode === "grid" ? "Grid" : "List"}
    </button>
  );
}

function ShopBadges({ shop }: { shop: ShopCardData }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge>{shop.typeLabel}</Badge>
      <Badge tone={shop.open ? "success" : "neutral"}>{shop.hoursLabel}</Badge>
      {shop.isNew ? <Badge tone="warning">New</Badge> : null}
    </div>
  );
}

const place = (shop: ShopCardData) => `${[shop.area, shop.city].filter(Boolean).join(", ")} · ${shop.pincode}`;

function FulfilmentLine({ shop }: { shop: ShopCardData }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-ink-700">
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden className="mt-0.5 shrink-0 text-ink-500">
        {shop.pickupOnly ? (
          <path d="M3 8l1.2-4h11.6L17 8M4 8v8h12V8M3 8h14M8 16v-4h4v4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        ) : (
          <path d="M2 5h10v8H2zM12 8h3.5L18 10.5V13h-6M5.5 15.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM14.5 15.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        )}
      </svg>
      <span>{shop.fulfilment}</span>
    </p>
  );
}

function ShopCard({ shop }: { shop: ShopCardData }) {
  return (
    <article className="relative flex h-full flex-col overflow-hidden rounded-xl border border-cream-200 bg-white transition-shadow hover:shadow-md" data-testid="shop-card">
      <div className="flex h-20 items-center justify-center bg-kesari-50">
        {shop.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shop.logoUrl} alt="" className="h-14 w-14 rounded-full object-cover" />
        ) : (
          <svg width="30" height="30" viewBox="0 0 20 20" fill="none" aria-hidden className="text-kesari-600">
            <path d="M2 3h2.2l2 9.2a1 1 0 0 0 1 .8h7.3a1 1 0 0 0 1-.8L17 6H5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="8" cy="16.2" r="1.1" stroke="currentColor" strokeWidth="1.2" />
            <circle cx="14.2" cy="16.2" r="1.1" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3.5">
        <ShopBadges shop={shop} />
        <h3 className="mt-1 text-base font-semibold text-ink-900">{shop.name}</h3>
        {shop.ratingCount > 0 ? <RatingBadge avgX100={shop.ratingAvgX100} count={shop.ratingCount} /> : null}
        <p className="text-sm text-ink-500">{place(shop)}</p>
        <FulfilmentLine shop={shop} />

        {/* The link's tap area covers the whole card. */}
        <Link
          href={`/shops/${shop.slug}`}
          aria-label={`View shop: ${shop.name}`}
          className="mt-auto pt-2 text-sm font-medium text-kesari-600 after:absolute after:inset-0 hover:underline"
        >
          View shop <span aria-hidden>→</span>
        </Link>
      </div>
    </article>
  );
}

function ShopListRow({ shop }: { shop: ShopCardData }) {
  return (
    <Link
      href={`/shops/${shop.slug}`}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-cream-200 bg-white p-3 hover:border-kesari-300 hover:bg-cream-50 sm:flex-nowrap"
      data-testid="shop-card"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-ink-900">{shop.name}</h3>
          <ShopBadges shop={shop} />
        </div>
        <p className="truncate text-sm text-ink-500">{shop.fulfilment}</p>
      </div>
      <p className="shrink-0 text-sm text-ink-500">{place(shop)}</p>
    </Link>
  );
}
