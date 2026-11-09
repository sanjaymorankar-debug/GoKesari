"use client";

/**
 * Step 1: a searchable grid of category tiles. Nothing is preselected except
 * the categories the shop already has; taking one of those away asks first.
 */
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Icon } from "@/components/board/icons";
import { postJson } from "@/components/save-changes-bar";
import { Alert, Button, inputClass } from "@/components/ui";
import type { CategoryTile } from "@/server/services/shop-product-setup";

export function ChooseCategories({ shopId, tiles, nextHref }: { shopId: string; tiles: CategoryTile[]; nextHref: string }) {
  const router = useRouter();
  const [carried, setCarried] = useState(() => new Set(tiles.filter((t) => t.selected).map((t) => t.id)));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<CategoryTile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? tiles.filter((t) => t.name.toLowerCase().includes(q)) : tiles;
  }, [tiles, query]);
  const total = carried.size + picked.size;

  function tap(tile: CategoryTile) {
    if (carried.has(tile.id)) return setConfirming(tile);
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(tile.id)) next.add(tile.id);
      return next;
    });
  }

  async function remove() {
    if (!confirming) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/shops/${shopId}/product-categories/${confirming.id}`, "DELETE");
      setCarried((current) => {
        const next = new Set(current);
        next.delete(confirming.id);
        return next;
      });
      setConfirming(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/shops/${shopId}/product-setup/categories`, "PUT", { categoryIds: [...carried, ...picked] });
      router.push(nextHref);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-ink-900">What does your shop sell?</h2>
        <p className="text-sm text-ink-500">Tap every category you sell. You can change this later.</p>
      </div>
      <label className="block text-sm text-ink-700">
        Search categories
        <input className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="For example, Dairy" />
      </label>

      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-500">
          No categories match.{" "}
          <button type="button" className="font-medium text-kesari-700 underline" onClick={() => setQuery("")}>
            Clear search
          </button>
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="category-tiles">
          {visible.map((t) => {
            const selected = carried.has(t.id) || picked.has(t.id);
            return (
              <li key={t.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => tap(t)}
                  className={clsx(
                    "relative flex min-h-28 w-full flex-col items-start gap-2 rounded-2xl border-2 bg-white p-3 text-left transition-colors",
                    selected ? "border-kesari-600 bg-kesari-50" : "border-cream-200 hover:border-kesari-300",
                  )}
                >
                  <span className="flex size-10 items-center justify-center overflow-hidden rounded-xl bg-kesari-100 text-kesari-700">
                    {t.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.imageUrl} alt="" className="size-10 object-cover" loading="lazy" />
                    ) : (
                      <Icon name="boxes" />
                    )}
                  </span>
                  <span className="font-medium leading-tight text-ink-900">{t.name}</span>
                  <span className="text-xs text-ink-500">{t.productCount > 0 ? `${t.productCount} products` : "No products here yet."}</span>
                  {selected ? (
                    <span className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-kesari-600 text-sm font-bold text-white" aria-hidden>
                      ✓
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {confirming ? (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label={`Remove ${confirming.name}`}>
          <div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5">
            <h3 className="font-semibold text-ink-900">Remove {confirming.name}?</h3>
            <p className="text-sm text-ink-700">
              Products in this category will stop showing to customers. Your stock and prices are saved, and you can add the category back anytime.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                Keep it
              </Button>
              <Button variant="danger" disabled={busy} onClick={remove}>
                Remove
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="sticky bottom-0 z-20 -mx-4 border-t border-cream-200 bg-white p-3 sm:mx-0 sm:rounded-xl sm:border">
        <Button className="w-full" disabled={busy || total === 0} onClick={next}>
          {busy ? "Saving…" : `Continue with ${total} ${total === 1 ? "category" : "categories"}`}
        </Button>
      </div>
    </div>
  );
}
