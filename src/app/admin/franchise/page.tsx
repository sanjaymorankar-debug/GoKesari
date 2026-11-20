import Link from "next/link";
import { redirect } from "next/navigation";

import { FranchiseAdmin } from "@/components/franchise/franchise-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";

export const metadata = { title: "Franchise areas" };
export const dynamic = "force-dynamic";

/** Admin → Dealers → Franchise areas (docs/franchise): admin changes; operators read. */
export default async function FranchiseAdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/admin/franchise");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <Link href="/admin/dealers" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealers
      </Link>
      <PageHeader title="Franchise areas — Pune PMR" description="91 zones in 7 clusters, at most 2 owners a zone. Boundaries, allocations, expiry alerts, settings (versioned), bonus formula, reports. Every change is logged; times are IST." />
      <FranchiseAdmin isAdmin={user.role === "ADMIN"} initialTab={(await searchParams).tab} />
    </div>
  );
}
