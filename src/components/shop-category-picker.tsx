"use client";

import { useEffect, useMemo, useState } from "react";

import { inputClass } from "@/components/ui";

export interface PickerCategory {
  id: string;
  name: string;
  status?: string;
}

/**
 * Searchable multi-select for shop categories.
 * - type to filter; "Select all" / "Clear all" act on what is currently shown
 * - shows how many are selected and a clear message when none are
 * - categories a shop already has but that were since retired stay visible so
 *   they can be kept or removed (they cannot be newly added)
 */
export function ShopCategoryPicker({
  value,
  onChange,
  error,
  retained = [],
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  error?: string | null;
  /** The shop's current categories — lets inactive ones remain listed. */
  retained?: PickerCategory[];
}) {
  const [all, setAll] = useState<PickerCategory[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/shop-categories")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { categories: PickerCategory[] }) => !cancelled && setAll(d.categories))
      .catch(() => !cancelled && setLoadError(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(() => {
    const byId = new Map<string, PickerCategory>();
    for (const c of all ?? []) byId.set(c.id, c);
    for (const c of retained) if (!byId.has(c.id)) byId.set(c.id, { ...c, status: "INACTIVE" });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [all, retained]);

  const shown = options.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = new Set(value);
  const selectable = shown.filter((c) => c.status !== "INACTIVE" || selected.has(c.id));

  function toggle(id: string) {
    onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  return (
    <div className="space-y-2" data-testid="category-picker">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search categories…"
          aria-label="Search shop categories"
          className={`${inputClass} min-w-0 flex-1`}
        />
        <button
          type="button"
          className="rounded-lg border border-cream-200 px-3 py-1.5 text-sm text-ink-700 hover:bg-cream-100"
          onClick={() => onChange([...new Set([...value, ...selectable.filter((c) => c.status !== "INACTIVE").map((c) => c.id)])])}
        >
          Select all{query.trim() ? " shown" : ""}
        </button>
        <button
          type="button"
          className="rounded-lg border border-cream-200 px-3 py-1.5 text-sm text-ink-700 hover:bg-cream-100"
          onClick={() => onChange(query.trim() ? value.filter((v) => !shown.some((c) => c.id === v)) : [])}
        >
          Clear all{query.trim() ? " shown" : ""}
        </button>
      </div>

      <div className="max-h-64 overflow-y-auto rounded-lg border border-cream-200 bg-white p-2" role="group" aria-label="Shop categories">
        {all === null && !loadError ? <p className="p-2 text-sm text-ink-500">Loading categories…</p> : null}
        {loadError ? <p className="p-2 text-sm text-red-700">Could not load categories. Refresh and try again.</p> : null}
        {all !== null && shown.length === 0 ? <p className="p-2 text-sm text-ink-500">No category matches “{query}”.</p> : null}
        <div className="grid gap-x-4 sm:grid-cols-2">
          {shown.map((c) => {
            const retired = c.status === "INACTIVE";
            return (
              <label
                key={c.id}
                className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${retired && !selected.has(c.id) ? "text-ink-400" : "text-ink-800 hover:bg-cream-50"}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  disabled={retired && !selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                  className="h-4 w-4 accent-kesari-600"
                />
                <span>
                  {c.name}
                  {retired ? <span className="ml-1 text-xs text-ink-400">(retired)</span> : null}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-ink-500" aria-live="polite" data-testid="category-count">
        Selected: {value.length} categor{value.length === 1 ? "y" : "ies"}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
