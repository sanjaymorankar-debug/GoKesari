import Link from "next/link";
import { redirect } from "next/navigation";

import { PmdReviewQueue } from "@/components/pmd-review-queue";
import { Alert, Card, PageHeader, Section } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { appSql } from "@/server/pmd/db";
import { getDataQualityReport, listReviewQueue, type DataQualityReport } from "@/server/pmd/services/reference";

export const metadata = { title: "Product master" };
export const dynamic = "force-dynamic";

/**
 * Product Master quality dashboard (brief section 27): what is in the master, how good it is,
 * what is missing, and what a person still has to decide.
 */
export default async function ProductMasterPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PMD_VIEW)) redirect("/");

  let report: DataQualityReport | null = null;
  let queue: Awaited<ReturnType<typeof listReviewQueue>> | null = null;
  let unavailable: string | null = null;
  try {
    const sql = appSql();
    [report, queue] = await Promise.all([getDataQualityReport(sql), listReviewQueue(sql, { limit: 15 })]);
  } catch {
    unavailable = "The product master schema is not installed in this database. Apply the latest migration (npm run db:migrate).";
  }

  const t = report?.totals ?? {};
  const n = (k: string) => Math.round(t[k] ?? 0);
  const maxOf = (rows: { count: number }[]) => Math.max(1, ...rows.map((r) => r.count));

  return (
    <>
      <PageHeader
        title="Product master"
        description="The universal, multi-source product database that feeds the marketplace catalogue."
        action={
          <Link href="/admin" className="text-sm font-medium text-kesari-600 hover:underline">
            ← Admin console
          </Link>
        }
      />

      {unavailable ? <Alert tone="danger">{unavailable}</Alert> : null}

      {report ? (
        <>
          <section className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Total products" value={n("total_products")} />
            <Stat label={`New (last ${report.windowDays} days)`} value={n("new_products")} />
            <Stat label={`Updated (last ${report.windowDays} days)`} value={n("updated_products")} />
            <Stat label="Average quality score" value={(t["avg_quality_score"] ?? 0).toFixed(1)} />
            <Stat label="Duplicates merged" value={n("duplicates_merged")} />
            <Stat label="Possible duplicates" value={n("possible_duplicates")} warn />
            <Stat label="Awaiting manual review" value={n("manual_review")} warn />
            <Stat label="Conflicting specifications" value={n("conflicting_specs")} warn />
            <Stat label="Missing GTIN" value={n("missing_gtin")} warn />
            <Stat label="Missing brand" value={n("missing_brand")} warn />
            <Stat label="Missing manufacturer" value={n("missing_manufacturer")} warn />
            <Stat label="Missing category" value={n("missing_category")} warn />
            <Stat label="Missing MRP" value={n("missing_mrp")} warn />
            <Stat label="Missing GST rate" value={n("missing_gst")} warn />
            <Stat label="Missing HSN" value={n("missing_hsn")} warn />
            <Stat label="Import errors" value={n("import_errors")} warn />
            <Stat label="Source records" value={n("source_records")} />
            <Stat label="Current seller offers" value={n("offers")} />
            <Stat label="Price observations" value={n("price_observations")} />
          </section>

          <div className="mb-8 grid gap-6 lg:grid-cols-3">
            <Breakdown title="Products by marketplace / source" rows={report.byMarketplace.map((r) => ({ label: r.source, count: r.count }))} max={maxOf(report.byMarketplace)} />
            <Breakdown title="Products by category" rows={report.byCategory.map((r) => ({ label: r.category, count: r.count }))} max={maxOf(report.byCategory)} />
            <Breakdown title="Products by brand (top 15)" rows={report.byBrand.slice(0, 15).map((r) => ({ label: r.brand, count: r.count }))} max={maxOf(report.byBrand)} />
          </div>

          <Section title={`Possible duplicates awaiting a person (${n("manual_review")})`}>
            <PmdReviewQueue
              canDecide={can(user.role, PERMISSIONS.PMD_REVIEW)}
              rows={(queue?.items ?? []).map((r) => ({
                candidateId: r.candidateId,
                matchScore: r.matchScore,
                matchStatus: r.matchStatus,
                relation: r.relation,
                rule: r.rule,
                hardConflicts: r.hardConflicts,
                incoming: { source: r.incoming.source, name: r.incoming.name, brand: r.incoming.brand },
                candidate: r.candidate,
              }))}
            />
          </Section>

          <Section title="Recent collection runs">
            <Card className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-cream-200 text-xs uppercase tracking-wide text-ink-500">
                  <tr>
                    <th className="p-3">Run</th>
                    <th className="p-3">Source</th>
                    <th className="p-3">Mode</th>
                    <th className="p-3">Status</th>
                    <th className="p-3 text-right">Read</th>
                    <th className="p-3 text-right">Created</th>
                    <th className="p-3 text-right">Linked</th>
                    <th className="p-3 text-right">Review</th>
                    <th className="p-3 text-right">Errors</th>
                    <th className="p-3">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-cream-200">
                  {report.recentRuns.map((r) => (
                    <tr key={r.runId}>
                      <td className="p-3 text-ink-500">#{r.runId}</td>
                      <td className="p-3 font-medium text-ink-900">{r.source}</td>
                      <td className="p-3">{r.mode}</td>
                      <td className="p-3">{r.status}</td>
                      <td className="p-3 text-right">{r.recordsRead}</td>
                      <td className="p-3 text-right">{r.productsCreated}</td>
                      <td className="p-3 text-right">{r.productsLinked}</td>
                      <td className="p-3 text-right">{r.reviewQueued}</td>
                      <td className="p-3 text-right">{r.errorCount}</td>
                      <td className="p-3 text-ink-500">{new Date(r.startedAt).toLocaleString("en-IN")}</td>
                    </tr>
                  ))}
                  {report.recentRuns.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="p-6 text-center text-ink-500">
                        No collection has run yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </Card>
            <p className="mt-2 text-xs text-ink-500">
              Snapshot computed {report.computedAt ? new Date(report.computedAt).toLocaleString("en-IN") : "just now"}. Counts refresh after every run.
            </p>
          </Section>
        </>
      ) : null}
    </>
  );
}

function Stat({ label, value, warn = false }: { label: string; value: string | number; warn?: boolean }) {
  const attention = warn && Number(value) > 0;
  return (
    <Card className="p-4">
      <p className="text-xs text-ink-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${attention ? "text-kesari-600" : "text-ink-900"}`}>{value}</p>
    </Card>
  );
}

function Breakdown({ title, rows, max }: { title: string; rows: { label: string; count: number }[]; max: number }) {
  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink-900">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-500">Nothing yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.label} className="text-sm">
              <div className="flex justify-between gap-2">
                <span className="truncate text-ink-700">{r.label}</span>
                <span className="font-medium text-ink-900">{r.count}</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-cream-200">
                <div className="h-1.5 rounded bg-kesari-500" style={{ width: `${Math.max(2, Math.round((100 * r.count) / max))}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
