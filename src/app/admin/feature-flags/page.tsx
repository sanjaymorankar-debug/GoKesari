import Link from "next/link";
import { redirect } from "next/navigation";

import { FeatureFlagsPanel, type FeatureFlagChangeRow } from "@/components/feature-flags-panel";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { FEATURE_FLAG_HINTS, FEATURE_FLAG_LABELS, getFeatureFlags, listFeatureFlagChanges } from "@/server/services/feature-flags";
import { listDistricts, listStates } from "@/server/services/geo-areas";

export const metadata = { title: "Feature flags" };
export const dynamic = "force-dynamic";

/**
 * Feature flags (docs/dealer-programme, step 1) — admin only. Operators, shop
 * owners, dealers and customers are sent home; the API refuses them too.
 */
export default async function FeatureFlagsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  const [flags, changes, states, districts] = await Promise.all([getFeatureFlags(), listFeatureFlagChanges({ limit: 30 }), listStates(), listDistricts()]);
  const rows = Object.values(flags).map((f) => ({
    key: f.key,
    label: FEATURE_FLAG_LABELS[f.key],
    hint: FEATURE_FLAG_HINTS[f.key],
    enabled: f.enabled,
    districtCodes: f.districtCodes,
  }));
  const log: FeatureFlagChangeRow[] = changes.map((c) => ({ ...c, changedAt: c.changedAt.toISOString() }));

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/menu/settings" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Settings
      </Link>
      <PageHeader
        title="Feature flags"
        description="Switch the dealer programme's features on or off, for all of India or only chosen states and districts. Off: the site works exactly as before. Every change needs a reason and is logged."
      />
      <FeatureFlagsPanel
        flags={rows}
        changes={log}
        labels={FEATURE_FLAG_LABELS}
        // Whole states first, then districts (with their state), so a flag can open the programme state by state.
        districts={[
          ...states.filter((s) => s.status === "ACTIVE").map((s) => ({ code: s.code, name: `${s.name} (whole state)` })),
          ...districts.filter((d) => d.status === "ACTIVE").map((d) => ({ code: d.code, name: `${d.name} (${d.code.split("-")[0]})` })),
        ]}
      />
    </div>
  );
}
