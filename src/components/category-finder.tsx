"use client";

import Link from "next/link";
import { useState } from "react";

import { categoryEmoji } from "@/lib/board/product-look";

/**
 * Shop categories as compact picture tiles with a search box: 44 types fit
 * in about one phone screen, and typing narrows them at once (it used to be
 * 44 text-only cards, nearly seven phone screens long).
 */
export function CategoryFinder({ types }: { types: { key: string; label: string; goods: string[] }[] }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? types.filter((t) => t.label.toLowerCase().includes(needle) || t.goods.some((g) => g.toLowerCase().includes(needle)))
    : types;
  return (
    <>
      <label className="mb-3 flex h-12 items-center gap-2 rounded-xl border-2 border-[var(--gk-line)] bg-white px-3 focus-within:border-kesari-600">
        <span aria-hidden>🔎</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a category or a product (milk, medicine…)"
          aria-label="Find a category"
          className="h-full min-w-0 flex-1 bg-transparent text-base text-ink-900 placeholder:text-ink-600 focus:outline-none"
        />
      </label>
      <p className="mb-2 text-sm text-ink-700" aria-live="polite">
        {shown.length} of {types.length}
      </p>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-[var(--gk-line)] bg-white p-4 text-base text-ink-700">
          No category matches “{q}”. Try another word, or{" "}
          <Link href={`/search?q=${encodeURIComponent(q)}`} className="font-semibold text-kesari-800 underline">
            search all products and shops
          </Link>
          .
        </p>
      ) : (
        <ul className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-6 lg:gap-2">
          {shown.map((t) => (
            <li key={t.key} className="min-w-0">
              <Link
                href={`/category/${t.key}`}
                title={t.goods.slice(0, 6).join(", ")}
                className="flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl border border-[var(--gk-line)] bg-white px-1 py-1.5 text-center hover:border-kesari-300 hover:bg-kesari-50"
              >
                <span aria-hidden className="text-xl leading-none">
                  {categoryEmoji(t.label, t.goods.join(" "))}
                </span>
                <span className="line-clamp-2 text-[0.8125rem] font-semibold leading-tight text-ink-900">{t.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
