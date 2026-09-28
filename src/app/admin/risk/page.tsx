import Link from "next/link";
import { redirect } from "next/navigation";

import { RiskReviewButtons, RunRiskRulesButton } from "@/components/growth-actions";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { countOpenRiskFlags, listRiskFlags } from "@/server/services/risk";

export const metadata = { title: "Risk review" };
export const dynamic = "force-dynamic";

const STATUSES = ["OPEN", "ACTIONED", "DISMISSED"] as const;
const TONE = { HIGH: "danger", MEDIUM: "warning", LOW: "neutral" } as const;

/** Fraud / risk review queue (GS-068). Flags never act on their own except pausing COD. */
export default async function RiskPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.RISK_REVIEW)) redirect("/");
  const { status } = await searchParams;
  const current = (STATUSES as readonly string[]).includes(status ?? "") ? (status as (typeof STATUSES)[number]) : "OPEN";
  const [flags, counts] = await Promise.all([listRiskFlags({ status: current }), countOpenRiskFlags()]);

  return (
    <>
      <PageHeader
        title="Risk review"
        description={`Open: ${counts.HIGH} high · ${counts.MEDIUM} medium · ${counts.LOW} low. Rules run hourly; an open HIGH flag on a customer pauses cash on delivery.`}
        action={<RunRiskRulesButton />}
      />
      <nav className="mb-4 flex flex-wrap gap-2 text-sm">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/admin/risk?status=${s}`}
            className={`rounded-lg border px-3 py-1 ${s === current ? "border-kesari-400 bg-kesari-50" : "border-cream-200"}`}
          >
            {s.toLowerCase()}
          </Link>
        ))}
      </nav>
      {flags.length === 0 ? (
        <EmptyState title={`No ${current.toLowerCase()} flags.`} />
      ) : (
        <Card className="divide-y divide-cream-100" data-testid="risk-flags">
          {flags.map((f) => (
            <div key={f.id} className="space-y-1 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-ink-900">
                  {f.ruleLabel} — {f.subjectName}{" "}
                  <span className="text-xs text-ink-500">({f.subjectType.toLowerCase().replace("_", " ")})</span>
                </p>
                <Badge tone={TONE[f.severity]}>{f.severity}</Badge>
              </div>
              <p className="text-ink-700">{f.summary}</p>
              <p className="text-xs text-ink-400">
                First seen {f.firstDetectedAt.toLocaleString("en-IN")} · last {f.lastDetectedAt.toLocaleString("en-IN")} · detected {f.occurrences}×
              </p>
              {f.reviewNote ? <p className="text-xs text-ink-600">Review: {f.reviewNote}</p> : null}
              {f.status === "OPEN" ? <RiskReviewButtons flagId={f.id} /> : null}
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
