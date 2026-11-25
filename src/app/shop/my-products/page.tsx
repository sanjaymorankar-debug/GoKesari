import clsx from "clsx";
import Link from "next/link";
import { redirect } from "next/navigation";

import { BulkPanel } from "@/components/shop-setup/bulk-panel";
import { StockEditor } from "@/components/shop-setup/stock-editor";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { LISTING_STATUSES, LISTING_STATUS_TEXT, type ListingStatus } from "@/lib/listing-status";
import { getBoardLang } from "@/server/board-lang";
import { addProductPath } from "@/lib/shop-setup-links";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { getImportLimits } from "@/server/services/product-import";
import { listShopListings } from "@/server/services/shop-product-setup";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "My products" };
export const dynamic = "force-dynamic";

const T = {
  title: L("My products", "मेरे उत्पाद", "माझी उत्पादने"),
  noShop: L("You haven't registered a shop yet", "आपने अभी कोई दुकान रजिस्टर नहीं की है", "तुम्ही अजून दुकान नोंदवलेले नाही"),
  all: L("All", "सभी", "सर्व"),
  add: L("Add products", "उत्पाद जोड़ें", "उत्पादने जोडा"),
  filterAria: L("Filter by status", "स्थिति से छाँटें", "स्थितीनुसार निवडा"),
  noProducts: L("Your shop has no products yet", "आपकी दुकान में अभी कोई उत्पाद नहीं है", "तुमच्या दुकानात अजून उत्पादने नाहीत"),
  noMatch: L("No products match", "कोई उत्पाद मेल नहीं खाता", "कोणतेही उत्पादन जुळत नाही"),
  clear: L("Clear filter", "फ़िल्टर हटाएँ", "फिल्टर काढा"),
  excel: L("Update many products with Excel", "Excel से कई उत्पाद एक साथ अपडेट करें", "Excel ने अनेक उत्पादने एकत्र अपडेट करा"),
} as const;

/** Every listing of the owner's shop by status; stock and price can be changed here at any time. */
export default async function MyProductsPage({ searchParams }: { searchParams: Promise<{ shop?: string; status?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const params = await searchParams;
  const [shops, lang] = await Promise.all([listShopsForOwner(user.id), getBoardLang()]);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title={tr(T.title, lang)} />
        <EmptyState title={tr(T.noShop, lang)} />
      </>
    );
  }
  const shop = await activeShop(shops, params.shop);
  const [listings, limits] = await Promise.all([listShopListings(shop.id), getImportLimits()]);
  const status = (LISTING_STATUSES as readonly string[]).includes(params.status ?? "") ? (params.status as ListingStatus) : null;
  const rows = status ? listings.filter((l) => l.status === status) : listings;
  const href = (s: ListingStatus | null) => {
    const query = new URLSearchParams({ ...(shops.length > 1 ? { shop: shop.id } : {}), ...(s ? { status: s } : {}) }).toString();
    return `/shop/my-products${query ? `?${query}` : ""}`;
  };
  const tabs: { value: ListingStatus | null; label: string; count: number }[] = [
    { value: null, label: tr(T.all, lang), count: listings.length },
    ...LISTING_STATUSES.map((s) => ({ value: s, label: tr(LISTING_STATUS_TEXT[s], lang), count: listings.filter((l) => l.status === s).length })),
  ];
  const setupHref = `/shop/product-categories${shops.length > 1 ? `?shop=${shop.id}` : ""}`;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={tr(T.title, lang)} description={shop.name} action={<LinkButton href={setupHref} variant="secondary">{tr(T.add, lang)}</LinkButton>} />

      <nav className="flex flex-wrap gap-2" aria-label={tr(T.filterAria, lang)}>
        {tabs.map((t) => (
          <Link
            key={t.label}
            href={href(t.value)}
            aria-current={t.value === status ? "page" : undefined}
            className={clsx("inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium", t.value === status ? "bg-kesari-600 text-white" : "bg-cream-100 text-ink-700")}
          >
            {t.label} ({t.count})
          </Link>
        ))}
      </nav>

      {listings.length === 0 ? (
        <EmptyState title={tr(T.noProducts, lang)} action={<LinkButton href={setupHref}>{tr(T.add, lang)}</LinkButton>} />
      ) : rows.length === 0 ? (
        <EmptyState title={tr(T.noMatch, lang)} action={<LinkButton href={href(null)} variant="secondary">{tr(T.clear, lang)}</LinkButton>} />
      ) : (
        // Remounted per filter, so it starts from what is saved now.
        <StockEditor key={status ?? "all"} shopId={shop.id} rows={rows} mode="manage" needsHref={href("NEEDS_STOCK")} productsHref={href(null)} />
      )}

      <details className="rounded-2xl border border-cream-200 bg-cream-50 p-4">
        <summary className="min-h-6 cursor-pointer font-medium text-ink-900">{tr(T.excel, lang)}</summary>
        <div className="mt-4">
          <BulkPanel
            shopId={shop.id}
            kind="mine"
            maxRows={limits.maxRows}
            maxFileMb={Math.round(limits.maxFileBytes / (1024 * 1024))}
            hasCategories
            chooseHref={setupHref}
            needsHref={href("NEEDS_STOCK")}
            productsHref={href(null)}
            addProductHref={addProductPath(shops.length > 1 ? shop.id : null)}
          />
        </div>
      </details>
    </div>
  );
}
