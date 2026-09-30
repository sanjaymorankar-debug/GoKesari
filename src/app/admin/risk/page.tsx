import Link from "next/link";
import { redirect } from "next/navigation";

import { RiskReviewButtons, RiskSuspendButton, RunRiskRulesButton } from "@/components/growth-actions";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS, type Permission } from "@/server/authz/permissions";
import {
  riskFlagStatusEnum,
  riskSeverityEnum,
  riskSubjectEnum,
  type RiskFlagStatus,
  type RiskSeverity,
  type RiskSubject,
} from "@/server/db/schema";
import { countOpenRiskFlags, listRiskFlags } from "@/server/services/risk";

export const metadata = { title: "Risk review" };
export const dynamic = "force-dynamic";

const STATUSES: readonly RiskFlagStatus[] = ["OPEN", "ACTIONED", "DISMISSED"];
const SEVERITIES: readonly RiskSeverity[] = ["HIGH", "MEDIUM", "LOW"];
const SUBJECTS: readonly RiskSubject[] = ["USER", "DELIVERY_PARTNER", "SHOP"];
const TONE = { HIGH: "danger", MEDIUM: "warning", LOW: "neutral" } as const;

const SUSPEND_PERMISSION: Record<RiskSubject, Permission> = {
  USER: PERMISSIONS.USER_SUSPEND,
  SHOP: PERMISSIONS.SHOP_SUSPEND,
  DELIVERY_PARTNER: PERMISSIONS.DELIVERY_PARTNER_MANAGE,
};
const SUSPENDABLE_FROM: Record<RiskSubject, string> = { USER: "ACTIVE", SHOP: "APPROVED", DELIVERY_PARTNER: "APPROVED" };

const ACCOUNT_TONE: Record<string, "success" | "warning" | "danger"> = {
  ACTIVE: "success",
  APPROVED: "success",
  PENDING_APPROVAL: "warning",
  REGISTERED: "warning",
  UNDER_REVIEW: "warning",
  INACTIVE: "warning",
  SUSPENDED: "danger",
  DELETED: "danger",
  DEACTIVATED: "danger",
  REJECTED: "danger",
};

interface Filters {
  status: RiskFlagStatus;
  severity?: RiskSeverity;
  subjectType?: RiskSubject;
}

function pick<T extends string>(values: readonly T[], raw: string | undefined): T | undefined {
  return values.find((v) => v === raw);
}

function riskHref(filters: Filters): string {
  const params = new URLSearchParams({ status: filters.status });
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.subjectType) params.set("subjectType", filters.subjectType);
  return `/admin/risk?${params.toString()}`;
}

function label(value: string): string {
  return value.toLowerCase().replace(/_/g, " ");
}

function FilterRow({ title, options }: { title: string; options: { key: string; text: string; href: string; active: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-16 text-xs font-medium text-ink-500">{title}</span>
      {options.map((o) => (
        <Link
          key={o.key}
          href={o.href}
          aria-current={o.active ? "page" : undefined}
          className={`rounded-lg border px-3 py-1 ${o.active ? "border-kesari-400 bg-kesari-50" : "border-cream-200"}`}
        >
          {o.text}
        </Link>
      ))}
    </div>
  );
}

/** Fraud / risk review queue (GS-068). Flags never act on their own except pausing COD. */
export default async function RiskPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; severity?: string; subjectType?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.RISK_REVIEW)) redirect("/");
  const params = await searchParams;
  const filters: Filters = {
    status: pick(riskFlagStatusEnum.enumValues, params.status) ?? "OPEN",
    severity: pick(riskSeverityEnum.enumValues, params.severity),
    subjectType: pick(riskSubjectEnum.enumValues, params.subjectType),
  };
  const filtered = Boolean(filters.severity || filters.subjectType);
  const [flags, counts] = await Promise.all([listRiskFlags(filters), countOpenRiskFlags()]);

  return (
    <>
      <PageHeader
        title="Risk review"
        description={`Open: ${counts.HIGH} high · ${counts.MEDIUM} medium · ${counts.LOW} low. Rules run hourly; an open HIGH flag on a customer pauses cash on delivery.`}
        action={<RunRiskRulesButton />}
      />
      <nav aria-label="Filter flags" className="mb-4 space-y-2 text-sm" data-testid="risk-filters">
        <FilterRow
          title="Status"
          options={STATUSES.map((s) => ({ key: s, text: label(s), href: riskHref({ ...filters, status: s }), active: s === filters.status }))}
        />
        <FilterRow
          title="Severity"
          options={[
            { key: "all", text: "all", href: riskHref({ ...filters, severity: undefined }), active: !filters.severity },
            ...SEVERITIES.map((s) => ({ key: s, text: label(s), href: riskHref({ ...filters, severity: s }), active: s === filters.severity })),
          ]}
        />
        <FilterRow
          title="Subject"
          options={[
            { key: "all", text: "all", href: riskHref({ ...filters, subjectType: undefined }), active: !filters.subjectType },
            ...SUBJECTS.map((s) => ({ key: s, text: label(s), href: riskHref({ ...filters, subjectType: s }), active: s === filters.subjectType })),
          ]}
        />
      </nav>
      {flags.length === 0 ? (
        <EmptyState
          title={filtered ? `No ${label(filters.status)} flags match these filters.` : `No ${label(filters.status)} flags.`}
          action={
            filtered ? (
              <LinkButton href={riskHref({ status: filters.status })} variant="secondary">
                Clear filters
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <Card className="divide-y divide-cream-100" data-testid="risk-flags">
          {flags.map((f) => (
            <div key={f.id} className="space-y-1 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-ink-900">
                  {f.ruleLabel} — {f.subjectName}{" "}
                  <span className="text-xs text-ink-500">({label(f.subjectType)})</span>
                </p>
                <Badge tone={TONE[f.severity]}>{f.severity}</Badge>
              </div>
              <p className="text-ink-700">{f.summary}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                <span>Account status</span>
                <Badge tone={f.subjectStatus ? (ACCOUNT_TONE[f.subjectStatus] ?? "neutral") : "neutral"}>
                  {f.subjectStatus ? label(f.subjectStatus) : "not found"}
                </Badge>
                {f.status === "OPEN" && f.subjectStatus === "SUSPENDED" ? (
                  <span>Already suspended — record what you checked and close the flag.</span>
                ) : null}
                {f.status === "OPEN" && f.subjectIsAdmin ? (
                  <span>Admin account — it cannot be suspended from here. Remove its admin role first.</span>
                ) : null}
              </div>
              <p className="text-xs text-ink-400">
                First seen {f.firstDetectedAt.toLocaleString("en-IN")} · last {f.lastDetectedAt.toLocaleString("en-IN")} · detected {f.occurrences}×
              </p>
              {f.reviewNote ? <p className="text-xs text-ink-600">Review: {f.reviewNote}</p> : null}
              {f.status === "OPEN" ? (
                <div className="space-y-2 pt-1">
                  <RiskReviewButtons flagId={f.id} />
                  {can(user.role, SUSPEND_PERMISSION[f.subjectType]) ? (
                    <RiskSuspendButton
                      flagId={f.id}
                      subjectType={f.subjectType}
                      subjectId={f.subjectId}
                      available={
                        f.subjectStatus === SUSPENDABLE_FROM[f.subjectType] &&
                        !f.subjectIsAdmin &&
                        !(f.subjectType === "USER" && f.subjectId === user.id)
                      }
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
