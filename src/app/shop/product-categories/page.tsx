import clsx from "clsx";
import Link from "next/link";
import { redirect } from "next/navigation";

import { BulkPanel } from "@/components/shop-setup/bulk-panel";
import { ChooseCategories } from "@/components/shop-setup/choose-categories";
import { ProductPicker } from "@/components/shop-setup/product-picker";
import { StockEditor } from "@/components/shop-setup/stock-editor";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { getImportLimits } from "@/server/services/product-import";
import { getSetupOverview } from "@/server/services/shop-product-setup";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Set up your shop's products" };
export const dynamic = "force-dynamic";

const STEP_NAMES = ["Choose categories", "Add products", "Set stock and price"];

function Progress({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div data-testid="setup-progress">
      <p className="text-sm font-medium text-ink-700" aria-live="polite">
        Step {step} of 3: {STEP_NAMES[step - 1]}
      </p>
      <div className="mt-2 flex gap-1.5" aria-hidden>
        {[1, 2, 3].map((n) => (
          <span key={n} className={clsx("h-2 flex-1 rounded-full", n <= step ? "bg-kesari-600" : "bg-cream-200")} />
        ))}
      </div>
    </div>
  );
}

/** A shop owner sets up the products of their own shop(s) — never anyone else's. */
export default async function ShopProductSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string; step?: string; mode?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const params = await searchParams;
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title="Set up your shop's products" />
        <EmptyState title="You haven't registered a shop yet" />
      </>
    );
  }
  // Only the owner's own shops can be selected; anything else falls back to the first.
  const shop = await activeShop(shops, params.shop);
  const [overview, limits] = await Promise.all([getSetupOverview(shop.id), getImportLimits()]);

  const href = (extra: Record<string, string>) => {
    const query = new URLSearchParams({ ...(shops.length > 1 ? { shop: shop.id } : {}), ...extra });
    return `/shop/product-categories?${query.toString()}`;
  };
  const needsHref = "/shop/my-products?status=NEEDS_STOCK";
  const productsHref = "/shop/my-products";
  const hasCategories = overview.carried > 0;
  const asked = params.step === "1" || params.step === "2" || params.step === "3" ? (Number(params.step) as 1 | 2 | 3) : null;
  // Without categories there is nothing further on to resume.
  const step = !hasCategories && asked !== 1 ? null : (asked ?? overview.step);
  const waiting = overview.listings.filter((l) => l.status === "NEEDS_STOCK" || l.status === "NEEDS_PRICE");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Set up your shop's products"
        description={shop.name}
        action={
          <Link href="/product-categories" className="text-sm font-medium text-kesari-600 hover:underline">
            Browse the full category list →
          </Link>
        }
      />
      {shops.length > 1 ? (
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Your shops">
          {shops.map((s) => (
            <Link
              key={s.id}
              href={`/shop/product-categories?shop=${s.id}`}
              className={s.id === shop.id ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}
            >
              {s.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {step === null ? (
        <EmptyState
          testId="setup-empty"
          title="Start by choosing what your shop sells"
          action={<LinkButton href={href({ step: "1" })}>Choose categories</LinkButton>}
        />
      ) : (
        <>
          <Progress step={step} />
          {step > 1 ? (
            <Link href={href(step === 2 && params.mode ? { step: "2" } : { step: String(step - 1) })} className="inline-flex min-h-11 items-center text-sm font-medium text-kesari-700">
              ← Back
            </Link>
          ) : null}

          {step === 1 ? <ChooseCategories key={shop.id} shopId={shop.id} tiles={overview.tiles} nextHref={href({ step: "2" })} /> : null}

          {step === 2 && !params.mode ? (
            <div className="grid gap-3 md:grid-cols-2" data-testid="add-choice">
              <Link href={href({ step: "2", mode: "screen" })} className="block rounded-2xl border-2 border-cream-200 bg-white p-5 hover:border-kesari-300">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink-900">Select products on screen</span>
                  <span className="rounded-full bg-kesari-100 px-2 py-0.5 text-xs font-medium text-kesari-700 md:hidden">Recommended</span>
                </span>
                <span className="mt-1 block text-sm text-ink-500">Tick the products you sell from your categories.</span>
              </Link>
              <Link href={href({ step: "2", mode: "excel" })} className="block rounded-2xl border-2 border-cream-200 bg-white p-5 hover:border-kesari-300">
                <span className="font-semibold text-ink-900">Add in bulk with Excel</span>
                <span className="mt-1 block text-sm text-ink-500">Download a file, fill it in and upload it.</span>
              </Link>
            </div>
          ) : null}
          {step === 2 && params.mode === "screen" ? (
            <ProductPicker
              shopId={shop.id}
              categories={overview.tiles.filter((t) => t.selected)}
              newProducts={overview.newProducts}
              nextHref={href({ step: "3" })}
              addProductHref="/shop/manage/products#products"
            />
          ) : null}
          {step === 2 && params.mode === "excel" ? (
            <BulkPanel
              shopId={shop.id}
              kind="template"
              maxRows={limits.maxRows}
              maxFileMb={Math.round(limits.maxFileBytes / (1024 * 1024))}
              hasCategories={hasCategories}
              chooseHref={href({ step: "1" })}
              needsHref={needsHref}
              productsHref={productsHref}
            />
          ) : null}

          {step === 3 ? (
            waiting.length === 0 ? (
              <Card className="p-5">
                <p className="font-medium text-ink-900">No products are waiting for stock or price.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <LinkButton href={href({ step: "2" })}>Add more products</LinkButton>
                  <LinkButton href={productsHref} variant="secondary">
                    Go to my products
                  </LinkButton>
                </div>
              </Card>
            ) : (
              <StockEditor shopId={shop.id} rows={waiting} mode="setup" needsHref={needsHref} productsHref={productsHref} />
            )
          ) : null}
        </>
      )}
    </div>
  );
}
