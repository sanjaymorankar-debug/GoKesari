import Link from "next/link";
import { redirect } from "next/navigation";

import { FranchiseAdmin } from "@/components/franchise/franchise-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";

export const metadata = { title: "Franchise zones" };
export const dynamic = "force-dynamic";

/** Admin → Dealers → Franchise zones (docs/franchise): admin changes; operators read. */
export default async function FranchiseAdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/admin/franchise");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <Link href="/admin/dealers" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealers
      </Link>
      <PageHeader title="Franchise zones — Pune" description="50 zones (one cluster each), tiered fees, at most 2 franchises a zone. Zone status, business data and fees, area master, coupons, franchises, expiry alerts, commission and settings (versioned), reports. Every change is logged; times are IST." />
      <FranchiseAdmin isAdmin={user.role === "ADMIN"} initialTab={(await searchParams).tab} />
    </div>
  );
}
