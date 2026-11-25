import Link from "next/link";

import { Pager } from "@/components/board/list-tabs";
import { ProductGrid } from "@/components/product-grid";
import { AskPriceButton } from "@/components/puja/ask-price-button";
import { EmptyState } from "@/components/ui";
import { formatRupees } from "@/lib/board/format";
import { PUJA_FESTIVALS, PUJA_SHOP_TYPE_KEY, festivalLabel, formatIst } from "@/lib/puja";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getCustomerLocation } from "@/server/location";
import { liveFestivalCollections } from "@/server/puja/admin";
import { listPujaCategories } from "@/server/puja/service";
import { listPujaStorefront } from "@/server/puja/storefront";
import { getCartLineQuantities } from "@/server/services/cart";
import { serviceableShopIds } from "@/server/services/serviceability";

export const metadata = { title: "Puja Samagri" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

type Query = {
  q?: string;
  cat?: string;
  festival?: string;
  kind?: string;
  min?: string;
  max?: string;
  stock?: string;
  all?: string;
  page?: string;
};

const T = {
  title: { en: "Puja Samagri", hi: "पूजा सामग्री", mr: "पूजा साहित्य" },
  subtitle: {
    en: "Agarbatti, diye, havan samagri, kumkum, murti, puja kits and temple supplies from shops near you.",
    hi: "अगरबत्ती, दीये, हवन सामग्री, कुमकुम, मूर्ति, पूजा किट और मंदिर सामग्री — आपके पास की दुकानों से।",
    mr: "अगरबत्ती, दिवे, हवन साहित्य, कुंकू, मूर्ती, पूजा किट आणि मंदिर साहित्य — जवळच्या दुकानांतून.",
  },
  nearby: { en: "Puja shops near me", hi: "पास की पूजा दुकानें", mr: "जवळची पूजा दुकाने" },
  search: { en: "Search kapur, agarbatti, दीया, कुंकू…", hi: "कपूर, अगरबत्ती, दीया खोजें…", mr: "कापूर, अगरबत्ती, पणती शोधा…" },
  poc: { en: "Price on confirmation", hi: "कीमत पुष्टि पर", mr: "किंमत खात्रीनंतर" },
} as const;

function pick<K extends keyof typeof T>(key: K, lang: "en" | "hi" | "mr"): string {
  return T[key][lang];
}

/** Customer storefront for the Puja Samagri shop type (docs/puja-samagri-2026-11, brief §7). */
export default async function PujaPage({ searchParams }: { searchParams: Promise<Query> }) {
  const [query, lang, user] = await Promise.all([searchParams, getBoardLang(), getCurrentUser()]);
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const [categories, live, location] = await Promise.all([
    listPujaCategories().catch(() => []),
    liveFestivalCollections(),
    getCustomerLocation(user?.id).catch(() => null),
  ]);
  const category = categories.find((c) => c.slug === query.cat) ?? null;
  const festival = PUJA_FESTIVALS.some((f) => f.key === query.festival) ? query.festival! : null;
  const kind = query.kind === "loose" || query.kind === "packed" ? query.kind : null;
  const rupees = (v?: string) => (v && Number(v) >= 0 ? Math.round(Number(v) * 100) : null);
  // Shops that deliver to the customer first; "all=1" (or no location / none nearby) shows every puja shop.
  const served = location && query.all !== "1" ? await serviceableShopIds(location).catch(() => null) : null;
  const shopIds = served && served.size > 0 ? [...served.keys()] : null;

  const filters = {
    q: query.q?.trim() || null,
    categoryId: category?.id ?? null,
    festival,
    kind,
    minPricePaise: rupees(query.min),
    maxPricePaise: rupees(query.max),
    inStock: query.stock === "1",
    shopIds,
    liveFestivals: live.map((l) => l.festivalKey),
  } as const;
  const [{ items, total }, cartLines] = await Promise.all([
    listPujaStorefront({ ...filters, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }).catch(() => ({ items: [], total: 0 })),
    user ? getCartLineQuantities(user.id) : null,
  ]);
  const priced = items.filter((i) => !i.priceOnConfirmation);
  const poc = items.filter((i) => i.priceOnConfirmation);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (extra: Partial<Query>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...query, page: undefined, ...extra })) if (v) next.set(k, String(v));
    const s = next.toString();
    return s ? `/puja?${s}` : "/puja";
  };
  const localName = (i: { nameHi: string | null; nameMr: string | null }) => (lang === "hi" ? i.nameHi : lang === "mr" ? i.nameMr : null);
  const chip = (active: boolean) =>
    `inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full border px-3 text-sm font-semibold ${
      active ? "border-kesari-600 bg-kesari-600 text-white" : "border-[var(--gk-line)] bg-white text-ink-800 hover:border-kesari-400"
    }`;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4" data-testid="puja-page">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">🪔 {pick("title", lang)}</h1>
          <p className="text-sm text-ink-700">{pick("subtitle", lang)}</p>
        </div>
        <Link prefetch={false} href={`/shops/nearby?type=${PUJA_SHOP_TYPE_KEY}`} className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-kesari-600 bg-white px-3 text-sm font-semibold text-kesari-800" data-testid="puja-nearby">
          📍 {pick("nearby", lang)}
        </Link>
      </header>

      {live.length ? (
        <section aria-label="Festival collections" className="grid gap-2 sm:grid-cols-2" data-testid="puja-festival-banners">
          {live.map((c) => (
            <Link
              key={c.id}
              href={href({ festival: c.festivalKey, cat: undefined })}
              className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-kesari-600 to-orange-500 p-4 text-white shadow-sm"
            >
              <span aria-hidden className="text-3xl">🎉</span>
              <span className="min-w-0">
                <span className="block text-lg font-bold">{(lang === "hi" ? c.titleHi : lang === "mr" ? c.titleMr : null) || c.title}</span>
                <span className="block text-sm text-white/90">
                  {c.subtitle ?? `${festivalLabel(c.festivalKey, lang)} kits and items`} · till {formatIst(c.endsAt).replace(/ \d\d\.\d\d IST$/, "")}
                </span>
              </span>
            </Link>
          ))}
        </section>
      ) : null}

      <nav aria-label="Puja categories" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" data-testid="puja-categories">
        <Link href={href({ cat: undefined })} className={chip(!category)}>
          {lang === "hi" ? "सभी" : lang === "mr" ? "सर्व" : "All"}
        </Link>
        {categories.map((c) => (
          <Link key={c.id} href={href({ cat: c.slug })} className={chip(category?.id === c.id)}>
            <span aria-hidden>{c.emoji}</span> {lang === "hi" ? c.nameHi : lang === "mr" ? c.nameMr : c.name}
          </Link>
        ))}
      </nav>

      <form action="/puja" method="get" className="grid grid-cols-2 gap-2 rounded-2xl border border-[var(--gk-line)] bg-white p-3 sm:grid-cols-6" data-testid="puja-filters">
        {category ? <input type="hidden" name="cat" value={category.slug} /> : null}
        <label className="col-span-2 text-xs font-medium text-ink-700 sm:col-span-2">
          Search
          <input name="q" defaultValue={query.q ?? ""} placeholder={pick("search", lang)} className="mt-1 min-h-10 w-full rounded-lg border border-cream-200 px-2 text-sm" />
        </label>
        <label className="text-xs font-medium text-ink-700">
          Festival
          <select name="festival" defaultValue={festival ?? ""} className="mt-1 min-h-10 w-full rounded-lg border border-cream-200 px-2 text-sm">
            <option value="">Any</option>
            {PUJA_FESTIVALS.map((f) => (
              <option key={f.key} value={f.key}>
                {f[lang]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-ink-700">
          Loose / packed
          <select name="kind" defaultValue={kind ?? ""} className="mt-1 min-h-10 w-full rounded-lg border border-cream-200 px-2 text-sm">
            <option value="">Both</option>
            <option value="packed">Packed</option>
            <option value="loose">Loose</option>
          </select>
        </label>
        <div className="flex gap-2">
          <label className="w-1/2 text-xs font-medium text-ink-700">
            Min ₹
            <input name="min" inputMode="numeric" defaultValue={query.min ?? ""} className="mt-1 min-h-10 w-full rounded-lg border border-cream-200 px-2 text-sm" />
          </label>
          <label className="w-1/2 text-xs font-medium text-ink-700">
            Max ₹
            <input name="max" inputMode="numeric" defaultValue={query.max ?? ""} className="mt-1 min-h-10 w-full rounded-lg border border-cream-200 px-2 text-sm" />
          </label>
        </div>
        <div className="flex items-end justify-between gap-2">
          <label className="flex min-h-10 items-center gap-2 text-sm text-ink-800">
            <input type="checkbox" name="stock" value="1" defaultChecked={query.stock === "1"} className="h-4 w-4" /> In stock
          </label>
          <button type="submit" className="min-h-10 rounded-xl bg-kesari-600 px-4 text-sm font-semibold text-white">
            Apply
          </button>
        </div>
      </form>

      <p className="text-sm text-ink-700" data-testid="puja-result-count">
        {total} {total === 1 ? "item" : "items"}
        {shopIds ? " from shops that deliver to you" : location ? " from all puja shops" : ""}
        {shopIds ? (
          <>
            {" · "}
            <Link href={href({ all: "1" })} className="font-semibold text-kesari-800 underline">
              show all shops
            </Link>
          </>
        ) : null}
        {live.length && !festival ? " · festival kits first" : ""}
      </p>

      {items.length === 0 ? (
        <EmptyState title="No puja items match these filters yet." />
      ) : (
        <>
          {priced.length ? <ProductGrid lang={lang} products={priced} signedIn={Boolean(user)} cartLines={cartLines} /> : null}
          {poc.length ? (
            <section aria-labelledby="puja-poc" className="space-y-2">
              <h2 id="puja-poc" className="text-lg font-bold text-ink-900">
                {pick("poc", lang)}
              </h2>
              <p className="text-sm text-ink-700">Loose and fresh items: the shop confirms today&apos;s price, then you can order.</p>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" data-testid="puja-poc-list">
                {poc.map((i) => (
                  <li key={i.shopProductId} className="flex flex-col gap-2 rounded-2xl border border-[var(--gk-line)] bg-white p-3">
                    <div className="min-w-0">
                      <p className="line-clamp-2 text-sm font-semibold text-ink-900">{localName(i) ?? i.productName}</p>
                      {localName(i) ? <p className="line-clamp-1 text-xs text-ink-600">{i.productName}</p> : null}
                      <p className="mt-1 text-xs text-ink-700">{i.shopName}</p>
                    </div>
                    <p className="text-sm font-bold text-kesari-800" data-testid="poc-label">
                      {pick("poc", lang)}
                      {i.mrpPaise ? <span className="ml-1 text-xs font-normal text-ink-600">MRP {formatRupees(i.mrpPaise)}</span> : null}
                    </p>
                    <AskPriceButton shopProductId={i.shopProductId} signedIn={Boolean(user)} unit={i.unit} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <Pager lang={lang} page={page} pageCount={pageCount} hrefFor={(n) => `${href({})}${href({}).includes("?") ? "&" : "?"}page=${n}`} />
        </>
      )}
    </div>
  );
}
