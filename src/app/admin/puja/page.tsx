import { redirect } from "next/navigation";

import { PujaAdmin } from "@/components/puja/puja-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listPujaCategories } from "@/server/puja/service";

export const metadata = { title: "Puja Samagri — catalogue" };
export const dynamic = "force-dynamic";

const TABS = ["catalogue", "review", "festivals", "config"] as const;

/**
 * Puja Samagri & Temple Supplies for operators and admins (docs/puja-samagri-2026-11, brief §6):
 * the master catalogue, the review queue for owner-created types and products, festival
 * collections and the shop-type configuration.
 */
export default async function AdminPujaPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/admin/puja");
  if (user.role !== "OPERATOR" && user.role !== "ADMIN") redirect("/");
  const { tab } = await searchParams;
  const canFestivals = can(user.role, PERMISSIONS.HOME_BANNER_MANAGE);
  const initial = (TABS as readonly string[]).includes(tab ?? "") && (tab !== "festivals" || canFestivals) ? (tab as (typeof TABS)[number]) : "catalogue";
  const categories = await listPujaCategories();
  return (
    <div className="mx-auto max-w-7xl space-y-3">
      <PageHeader
        title="🪔 Puja Samagri & Temple Supplies"
        description="Master catalogue (HSN / GST to verify with CA), review queue for shop owners' types and products, festival collections, configuration."
      />
      <PujaAdmin initialTab={initial} categories={categories.map((c) => ({ id: c.id, name: c.name }))} canFestivals={canFestivals} />
    </div>
  );
}
