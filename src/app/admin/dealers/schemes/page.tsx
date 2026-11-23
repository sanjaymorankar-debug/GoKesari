import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { SchemeCreateForm } from "@/components/dealer/scheme-create-form";
import { SchemeTermsPanel } from "@/components/dealer/scheme-terms";
import { Badge, Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { isDealerStaff } from "@/server/dealers/staff-access";
import { schemePermissions } from "@/server/dealers/scheme-admin";
import { listSchemes } from "@/server/dealers/schemes";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Dealer schemes" };
export const dynamic = "force-dynamic";

const STATUS_TONE = { PUBLISHED: "success", DRAFT: "neutral", SCHEDULED: "info", SUSPENDED: "warning", EXPIRED: "neutral", ARCHIVED: "neutral", SUPERSEDED: "neutral", WITHDRAWN: "neutral" } as const;

/**
 * Dealership & Franchise Platform phase 1 (owner brief 23-Nov-2026; docs/dealer-platform/): every scheme, its
 * versions and how many dealers are on each; create or clone a scheme (phase 4); each opens in the builder.
 */
export default async function AdminDealerSchemesPage() {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!isDealerStaff(user.role)) redirect("/");
  const schemes = await listSchemes();
  const perms = await schemePermissions({ id: user.id, role: user.role });

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <Link href="/admin/dealers" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealers
      </Link>
      <PageHeader
        title="Dealership & franchise schemes"
        description="Create and run dealership and franchise schemes: terms by version, how many dealers are on each, a simulator, and publishing. A published version never changes: a change is a new version, and dealers keep the version they are on."
      />
      {perms.edit ? <div className="mb-4"><SchemeCreateForm versions={schemes.flatMap((s) => s.versions.map((v) => ({ id: v.id, label: `${s.name} v${v.version}` })))} /></div> : null}
      <div className="space-y-4">
        {schemes.map((s) => (
          <Card key={s.id} className="p-4" data-testid={`scheme-${s.code}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-ink-900">
                <Link className="underline" href={`/admin/dealers/schemes/${s.id}`}>{s.name}</Link>
              </h2>
              <Badge tone={STATUS_TONE[s.status]}>{s.status.toLowerCase()}</Badge>
              <Badge tone="info">{s.category === "FRANCHISE" ? "franchise" : "dealership"}</Badge>
              <span className="text-sm text-ink-600">
                {s.activeDealers} dealer{s.activeDealers === 1 ? "" : "s"}
              </span>
            </div>
            {s.versions.map((v) => (
              <details key={v.id} className="mt-3 rounded-lg border border-cream-200 p-3" open={v.status === "PUBLISHED" || (!s.current && v === s.versions[0])}>
                <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold">Version {v.version}</span>
                  <Badge tone={STATUS_TONE[v.status]}>{v.status.toLowerCase()}</Badge>
                  {v.label ? <span className="text-ink-600">{v.label}</span> : null}
                  <span className="text-ink-600">
                    · {v.activeDealers} dealer{v.activeDealers === 1 ? "" : "s"}
                  </span>
                </summary>
                <div className="mt-2">
                  <SchemeTermsPanel terms={v.terms} testId={`scheme-${s.code}-v${v.version}`} />
                  {v.changeReason ? <p className="mt-2 text-xs text-ink-600">Why: {v.changeReason}</p> : null}
                  <p className="mt-1 break-all text-xs text-ink-500">Terms fingerprint {v.termsHash.slice(0, 16)}</p>
                </div>
              </details>
            ))}
          </Card>
        ))}
      </div>
    </div>
  );
}
