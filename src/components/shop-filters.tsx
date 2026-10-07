"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { SHOP_SORTS, type ShopSort } from "@/lib/shop-sort";

/** The select keeps its native arrow; the same look as the search box beside it. */
const fieldClass =
  "rounded-lg border border-cream-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-kesari-500 focus:outline-none";

const toggleClass = (active: boolean) =>
  `tap-target whitespace-nowrap rounded-full border px-3.5 py-2 text-sm font-medium transition-colors [--tap-h:44px] ${
    active
      ? "border-kesari-500 bg-kesari-50 text-kesari-700"
      : "border-cream-200 bg-white text-ink-700 hover:bg-cream-100"
  }`;

/** Writes one filter into the URL (the page reads it back), leaving the rest alone. */
function useFilterParam() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function set(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const query = next.toString();
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
  }
  return { params, set, pending };
}

/**
 * The Shops page filter bar (§15): search by name, shop type, and the two
 * quick toggles. Every control writes straight to the URL, so a filtered list
 * can be shared or bookmarked and there is no "Apply" step.
 *
 * `types` and the two `show…` flags come from the shops actually listed: a
 * type nobody nearby has, or a toggle that would leave nothing, is not
 * offered (unless it is switched on already, so it can be switched off).
 */
export function ShopFilters({
  types,
  showOpenNow,
  showDeliversToMe,
}: {
  types: { key: string; label: string }[];
  showOpenNow: boolean;
  showDeliversToMe: boolean;
}) {
  const { params, set, pending } = useFilterParam();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const openNow = params.get("open") === "1";
  const delivers = params.get("delivery") === "true";
  const type = params.get("type") ?? "";

  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-cream-200 bg-white p-3 shadow-sm"
      aria-busy={pending}
      data-testid="shop-filters"
    >
      <form
        role="search"
        className="relative min-w-0 flex-1 basis-56"
        onSubmit={(e) => {
          e.preventDefault();
          set({ q: query.trim() || null });
        }}
      >
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-500">
          <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M13.2 13.2 17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Clearing the box (the × in a search field) clears the filter too.
            if (e.target.value === "" && params.get("q")) set({ q: null });
          }}
          placeholder="Search by shop name"
          aria-label="Search by shop name"
          className={`${fieldClass} w-full bg-cream-50 pl-9 placeholder:text-ink-500`}
        />
      </form>

      {types.length > 1 || type ? (
        <select
          value={type}
          onChange={(e) => set({ type: e.target.value || null })}
          aria-label="Shop type"
          className={fieldClass}
        >
          <option value="">All shop types</option>
          {types.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      ) : null}

      {showOpenNow || openNow ? (
        <button type="button" aria-pressed={openNow} className={toggleClass(openNow)} onClick={() => set({ open: openNow ? null : "1" })}>
          Open now
        </button>
      ) : null}
      {showDeliversToMe || delivers ? (
        <button type="button" aria-pressed={delivers} className={toggleClass(delivers)} onClick={() => set({ delivery: delivers ? null : "true" })}>
          Delivers to me
        </button>
      ) : null}
    </div>
  );
}

/** Sort control for the Shops page; "Nearest first" needs a location to mean anything. */
export function ShopSortSelect({ value, hasLocation }: { value: ShopSort; hasLocation: boolean }) {
  const { set } = useFilterParam();
  const options = SHOP_SORTS.filter((s) => hasLocation || s.key !== "nearest");
  return (
    <label className="flex items-center gap-2 text-sm text-ink-600">
      Sort
      <select
        value={value}
        onChange={(e) => set({ sort: e.target.value === options[0].key ? null : e.target.value })}
        className={fieldClass}
      >
        {options.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}
