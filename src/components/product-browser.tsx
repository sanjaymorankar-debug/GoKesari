/**
 * Product list with search and a category filter (plain GET form, so it works
 * without JavaScript and every filtered view has a shareable URL). Used by the
 * Product Master view and by each shop's "visible products" view.
 */
import Link from "next/link";

import { ProductCategoryMover } from "@/components/product-category-mover";
import { Card, EmptyState, inputClass } from "@/components/ui";
import type { CatalogueRow } from "@/server/services/product-categories";

export const PAGE_SIZE = 50;

export function ProductBrowser({
  basePath,
  hidden = {},
  products,
  total,
  categories,
  query,
  categoryId,
  offset,
  movable = false,
}: {
  basePath: string;
  /** Extra query parameters to keep (e.g. the selected shop). */
  hidden?: Record<string, string>;
  products: CatalogueRow[];
  total: number;
  categories: { id: string; name: string }[];
  query: string;
  categoryId: string;
  offset: number;
  /** Show a per-product category picker (staff). */
  movable?: boolean;
}) {
  const href = (nextOffset: number) => {
    const params = new URLSearchParams({ ...hidden, ...(query ? { q: query } : {}), ...(categoryId ? { category: categoryId } : {}) });
    if (nextOffset) params.set("offset", String(nextOffset));
    return `${basePath}?${params.toString()}`;
  };

  return (
    <div className="space-y-3">
      <form method="get" action={basePath} className="flex flex-wrap items-end gap-2" role="search">
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label className="min-w-48 flex-1 text-sm text-ink-700">
          Search
          <input name="q" defaultValue={query} placeholder="Name, product ID or brand" className={inputClass} />
        </label>
        <label className="min-w-48 text-sm text-ink-700">
          Category
          <select name="category" defaultValue={categoryId} className={inputClass}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800">
          Apply
        </button>
      </form>

      <p className="text-sm text-ink-500" data-testid="product-count">
        {total} product{total === 1 ? "" : "s"}
        {total > PAGE_SIZE ? ` · showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}` : ""}
      </p>

      {products.length === 0 ? (
        <EmptyState title="No products match." description="Try another search or category." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-cream-50 text-xs uppercase text-ink-500">
              <tr>
                <th className="px-3 py-2">Product ID</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Brand</th>
                <th className="px-3 py-2">Unit</th>
                <th className="px-3 py-2">Category</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-100">
              {products.map((p) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 font-mono text-xs">{p.code}</td>
                  <td className="px-3 py-2 text-ink-900">{p.name}</td>
                  <td className="px-3 py-2 text-ink-600">{p.brandName ?? "—"}</td>
                  <td className="px-3 py-2 text-ink-600">{p.unit}</td>
                  <td className="px-3 py-2">
                    {movable ? (
                      <ProductCategoryMover productId={p.id} productName={p.name} categoryId={p.categoryId} categories={categories} />
                    ) : (
                      p.categoryName
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {total > PAGE_SIZE ? (
        <div className="flex gap-3 text-sm">
          {offset > 0 ? <Link href={href(Math.max(0, offset - PAGE_SIZE))} className="text-kesari-700 underline">← Previous</Link> : null}
          {offset + PAGE_SIZE < total ? <Link href={href(offset + PAGE_SIZE)} className="text-kesari-700 underline">Next →</Link> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Reads the browser's query parameters defensively (a bad uuid or offset is ignored, not a 500). */
export function readBrowseParams(params: { q?: string; category?: string; offset?: string }) {
  const categoryId = params.category && /^[0-9a-f-]{36}$/i.test(params.category) ? params.category : "";
  const offset = Math.max(0, Number.parseInt(params.offset ?? "0", 10) || 0);
  return { query: (params.q ?? "").trim().slice(0, 100), categoryId, offset };
}
