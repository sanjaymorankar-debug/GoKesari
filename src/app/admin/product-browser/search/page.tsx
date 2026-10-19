import Link from "next/link";
import { redirect } from "next/navigation";

import { ProductBrowserTable } from "@/components/batch-d/product-browser-table";
import { PageHeader, inputClass } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { searchBrowser, type BrowserScope, type BrowserSort } from "@/server/pmd/browser";

export const metadata = { title: "Browse products" };
export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/** F9.1.4 — search, filter and sort across staging and master; select to promote, bulk edit or compare. */
export default async function BrowserSearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PMD_VIEW)) redirect("/");
  const p = await searchParams;
  const scope = (["staging", "master", "all"].includes(one(p.scope) ?? "") ? one(p.scope) : "all") as BrowserScope;
  const sort = (["name", "quality", "updated", "gtin"].includes(one(p.sort) ?? "") ? one(p.sort) : "updated") as BrowserSort;
  const page = Math.max(1, Number(one(p.page) ?? 1) || 1);
  const result = await searchBrowser({
    scope,
    q: one(p.q),
    brand: one(p.brand),
    category: one(p.category),
    source: one(p.source),
    missingHsn: one(p.missingHsn) === "true",
    sort,
    dir: one(p.dir) === "asc" ? "asc" : "desc",
    page,
    pageSize: 50,
  });
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const link = (over: Record<string, string>) => `?${new URLSearchParams({ ...Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === "string") as [string, string][]), ...over })}`;

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-3 py-4">
      <PageHeader title="Browse products" description={`${result.total.toLocaleString("en-IN")} product(s) · staging = imported, not yet in the catalogue; master = in the catalogue for every shop.`} />
      <form className="grid gap-2 rounded-xl border border-cream-200 bg-white p-3 sm:grid-cols-4" method="get">
        <input className={inputClass} name="q" placeholder="Name, brand or GTIN" defaultValue={one(p.q)} />
        <input className={inputClass} name="brand" placeholder="Brand" defaultValue={one(p.brand)} />
        <input className={inputClass} name="category" placeholder="Category code" defaultValue={one(p.category)} />
        <input className={inputClass} name="source" placeholder="Source key" defaultValue={one(p.source)} />
        <select className={inputClass} name="scope" defaultValue={scope}>
          <option value="all">Staging + master</option>
          <option value="staging">Staging</option>
          <option value="master">Master</option>
        </select>
        <select className={inputClass} name="sort" defaultValue={sort}>
          <option value="updated">Recently changed</option>
          <option value="name">Name</option>
          <option value="quality">Quality</option>
          <option value="gtin">GTIN</option>
        </select>
        <select className={inputClass} name="dir" defaultValue={one(p.dir) ?? "desc"}>
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="missingHsn" value="true" defaultChecked={one(p.missingHsn) === "true"} className="h-5 w-5" /> Missing HSN
        </label>
        <button className="min-h-11 rounded-lg bg-kesari-600 px-4 text-sm font-medium text-white sm:col-span-4" type="submit">Search</button>
      </form>
      <ProductBrowserTable
        rows={JSON.parse(JSON.stringify(result.rows))}
        canPromote={can(user.role, PERMISSIONS.PMD_PROMOTE)}
        canEdit={can(user.role, PERMISSIONS.PMD_BULK_EDIT)}
        canEditMrp={can(user.role, PERMISSIONS.PRODUCT_MRP_MANAGE)}
      />
      <nav className="flex items-center justify-between text-sm">
        {page > 1 ? <Link className="min-h-11 rounded-lg border border-cream-200 bg-white px-4 py-2" href={link({ page: String(page - 1) })}>Previous</Link> : <span />}
        <span>Page {page} of {pages}</span>
        {page < pages ? <Link className="min-h-11 rounded-lg border border-cream-200 bg-white px-4 py-2" href={link({ page: String(page + 1) })}>Next</Link> : <span />}
      </nav>
    </div>
  );
}
