import { notFound, redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";

import { ShopCategoriesEditor } from "@/components/shop-categories-editor";
import { LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { getShopCategories } from "@/server/services/shop-categories";

export const metadata = { title: "Shop categories" };
export const dynamic = "force-dynamic";

/** Operations assigns or edits the categories of any shop (and sees what the owner chose). */
export default async function AdminShopCategoriesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "OPERATOR" && user.role !== "ADMIN") redirect("/");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [shop] = await db.select().from(shops).where(and(eq(shops.id, id), isNull(shops.deletedAt)));
  if (!shop) notFound();
  const current = await getShopCategories(id);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title={`Categories — ${shop.name}`}
        description={`${shop.ownerName} · ${shop.city}. Changes here replace the shop's current selection; its products and orders are not affected.`}
        action={<LinkButton href="/admin/shop-categories" variant="secondary">All categories</LinkButton>}
      />
      <ShopCategoriesEditor shopId={shop.id} current={current.map((c) => ({ id: c.id, name: c.name, status: c.status }))} />
    </div>
  );
}
