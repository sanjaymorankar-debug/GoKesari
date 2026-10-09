import { HomePriceComparison } from "@/components/home-price-comparison";
import { EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { homePriceComparison } from "@/server/services/price-comparison";

export const metadata = { title: "Compare prices" };
export const dynamic = "force-dynamic";

/** Shops › Compare prices: the comparison that used to sit below the old home page's first screen. */
export default async function ComparePricesPage() {
  const user = await getCurrentUser();
  const location = await getCustomerLocation(user?.id);
  const compared = await homePriceComparison(location).catch((error) => {
    console.error("[compare] price comparison failed", error);
    return null;
  });

  return (
    <>
      <PageHeader title="Compare prices near you" description="The same product at different shops near your delivery location." />
      {compared === null ? (
        <EmptyState title="Prices could not be loaded just now." description="Please try again in a minute." />
      ) : compared.length === 0 ? (
        <EmptyState title="Nothing to compare yet." description="When more than one shop near you sells the same product, it appears here." />
      ) : (
        <HomePriceComparison products={compared} />
      )}
    </>
  );
}
