import Link from "next/link";
import { redirect } from "next/navigation";

import { CategoryMaster } from "@/components/category-master";
import { PageHeader, inputClass } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listCategoryMaster } from "@/server/services/product-categories";

export const metadata = { title: "Product categories" };
export const dynamic = "force-dynamic";

/** Category Master — Admin, Operator and Shop Owner (each with their own reach). */
export default async function CategoryMasterPage({ searchParams }: { searchParams: Promise<{ q?: string; all?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.CATALOGUE_BROWSE)) redirect("/");
  const { q, all } = await searchParams;
  const query = (q ?? "").trim().slice(0, 100);
  const categories = await listCategoryMaster(user, { query, includeInactive: all !== "0" });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Product categories"
        description="Every product belongs to one category. A shop sees every product in the categories it carries. General is permanent: removing any other category moves its products to General."
        action={
          <Link href="/product-categories/products" className="text-sm font-medium text-kesari-600 hover:underline">
            Browse all products →
          </Link>
        }
      />
      <form method="get" className="flex gap-2" role="search">
        <input name="q" defaultValue={query} placeholder="Search categories" className={inputClass} />
        <button type="submit" className="rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800">
          Search
        </button>
      </form>
      <CategoryMaster
        categories={categories.map((c) => ({ ...c, createdAt: c.createdAt.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }) }))}
      />
    </div>
  );
}
