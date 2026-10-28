import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { DealerAnalytics } from "@/components/dealer/dealer-analytics";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { activationReport, coverageReport, dealerScores } from "@/server/dealers/analytics";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Dealer coverage & analytics" };
export const dynamic = "force-dynamic";

/**
 * Dealer programme P1 analytics (docs/dealer-programme, step 8): the coverage
 * map (GKS-GEO-001), the performance score (GKS-AN-001) and activation with
 * 30-day activity (GKS-AN-002). Admin and operator read; only an admin sets
 * area targets (weights: Admin → Settings → business rules). Not there while
 * the programme is off.
 */
export default async function DealerAnalyticsPage({ searchParams }: { searchParams: Promise<{ area?: string }> }) {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  const { area } = await searchParams;
  const all = await coverageReport();
  const root = (area && all.find((r) => r.code === area)) || all.find((r) => r.level === "STATE") || null;
  const [scores, activation] = await Promise.all([dealerScores(), activationReport()]);
  const trail: { code: string; name: string }[] = [];
  for (let cur = root; cur; cur = all.find((r) => r.code === cur!.parentCode) ?? null) trail.unshift({ code: cur.code, name: cur.name });

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <Link href="/admin/dealers" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealers
      </Link>
      <PageHeader
        title="Coverage & analytics"
        description="Where GoKesari has dealers and shops, how each dealer performs against dealers in the same district, and how many of their shops went live and are taking orders."
      />
      <DealerAnalytics
        isAdmin={user.role === "ADMIN"}
        root={root}
        trail={trail}
        areas={all.filter((r) => r.parentCode === root?.code)}
        scores={scores.rows}
        weights={scores.weights}
        activation={activation}
      />
    </div>
  );
}
