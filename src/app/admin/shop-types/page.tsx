import { redirect } from "next/navigation";

import { ShopTypesAdmin } from "@/components/shop-types-admin";
import { UnsavedChangesProvider } from "@/components/unsaved-changes-guard";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopTypes, shopCountsByType } from "@/server/services/shop-types";

export const metadata = { title: "Shop types" };
export const dynamic = "force-dynamic";

export default async function ShopTypesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "OPERATOR" && user.role !== "ADMIN") redirect("/");
  const [types, counts] = await Promise.all([listShopTypes({ includeInactive: true }), shopCountsByType()]);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Shop types"
        description="The kind of shop a seller registers as (grocery, pharmacy, clinic, tent house…). Add a new type here and it appears in registration and filters straight away. Built-in types cannot be edited."
      />
      <UnsavedChangesProvider>
        <ShopTypesAdmin
          types={types.map((t) => ({
            key: t.key,
            label: t.label,
            standardGoods: [...t.standardGoods],
            isFood: t.isFood,
            builtIn: t.builtIn,
            status: t.status,
            shopCount: counts[t.key] ?? 0,
          }))}
        />
      </UnsavedChangesProvider>
    </div>
  );
}
