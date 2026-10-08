import { ItemMapping } from "@/components/integrations/item-mapping";
import { LinkButton, PageHeader } from "@/components/ui";
import { itemListSchema, listItemLinks } from "@/server/integrations/connections";
import { integrationPageShop } from "@/server/integrations/page-context";

export const metadata = { title: "Match items" };
export const dynamic = "force-dynamic";

/** Module 2: match the shop software's items to GoKesari products. */
export default async function MappingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop } = await integrationPageShop(params.shop);
  const query = itemListSchema.parse({
    status: typeof params.status === "string" && params.status ? params.status : undefined,
    q: typeof params.q === "string" && params.q ? params.q : undefined,
    page: typeof params.page === "string" ? params.page : undefined,
  });
  const result = await listItemLinks(shop.id, query);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Match items"
        description={`${shop.name} — which GoKesari product each item in your software is. Matched items take their stock, price and tax from your software.`}
        action={<LinkButton href={`/shop/settings/integrations?shop=${shop.id}`} variant="secondary">Back</LinkButton>}
      />
      <ItemMapping
        shopId={shop.id}
        items={JSON.parse(JSON.stringify(result.items))}
        total={result.total}
        page={query.page}
        pageSize={result.pageSize}
        status={query.status ?? ""}
        q={query.q ?? ""}
      />
    </div>
  );
}
