import { EmptyIllustration } from "@/components/empty-illustrations";
import { HomePriceComparison } from "@/components/home-price-comparison";
import { OpenLocationButton } from "@/components/location-picker";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { HOME } from "@/lib/home-i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getCustomerLocation } from "@/server/location";
import { homePriceComparison } from "@/server/services/price-comparison";

export const metadata = { title: "Compare prices" };
export const dynamic = "force-dynamic";

/**
 * Shops › Compare prices: the comparison that used to sit below the old home
 * page's first screen. `?product=<id>` (the "Compare N prices" link on a
 * product card, docs/homepage-uiux-2026-10 F4) shows that product's prices
 * only. The lowest price is tagged "Best price", with the saving against the
 * highest.
 */
export default async function ComparePricesPage({ searchParams }: { searchParams: Promise<{ product?: string }> }) {
  const { product } = await searchParams;
  const productId = product && /^[0-9a-f-]{36}$/i.test(product) ? product : undefined;
  const user = await getCurrentUser();
  const [location, lang] = await Promise.all([getCustomerLocation(user?.id), getBoardLang()]);
  const compared = await homePriceComparison(location, productId ? { productId, maxProducts: 1 } : {}).catch((error) => {
    console.error("[compare] price comparison failed", error);
    return null;
  });

  return (
    <>
      <PageHeader
        title={compared?.length === 1 && productId ? `${tr(HOME.comparePageTitle, lang)}: ${compared[0].productName}` : tr(HOME.comparePageTitle, lang)}
        description={tr(HOME.comparePageText, lang)}
      />
      {!location ? (
        <EmptyState
          illustration={<EmptyIllustration name="search" />}
          title={tr(HOME.setLocationPrompt, lang)}
          action={<OpenLocationButton className="inline-flex h-11 items-center rounded-lg bg-kesari-600 px-4 text-sm font-medium text-white hover:bg-kesari-800">{tr(HOME.setLocation, lang)}</OpenLocationButton>}
          testId="compare-needs-location"
        />
      ) : compared === null ? (
        <EmptyState title="Prices could not be loaded just now." description="Please try again in a minute." />
      ) : compared.length === 0 ? (
        <EmptyState
          illustration={<EmptyIllustration name="search" />}
          title="Nothing to compare yet."
          description="When more than one shop near you sells the same product, it appears here."
          action={<LinkButton href="/shops">{tr(HOME.seeShopsNearYou, lang)}</LinkButton>}
        />
      ) : (
        <>
          <HomePriceComparison products={compared} lang={lang} />
          {productId ? (
            <p className="mt-4">
              <LinkButton href="/search/compare" variant="secondary">
                {tr(HOME.compareAllProducts, lang)}
              </LinkButton>
            </p>
          ) : null}
        </>
      )}
    </>
  );
}
