import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge, Card, EmptyState, LinkButton, PageHeader, Section, inputClass } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { consentTypeEnum, type ConsentType } from "@/server/db/schema";
import {
  getConsentOverview,
  getUserConsentTrail,
  listConsentChanges,
  type ConsentTypeSummary,
} from "@/server/services/consents";
import { listUsers } from "@/server/services/users";

export const metadata = { title: "Consent record" };
export const dynamic = "force-dynamic";

const CONSENT_LABELS: Record<ConsentType, string> = {
  TERMS_AND_PRIVACY: "Terms & privacy policy",
  MARKETING_COMMUNICATIONS: "Marketing communications",
};

const DECISIONS = [
  { key: "granted", label: "grants", granted: true },
  { key: "withdrawn", label: "withdrawals", granted: false },
] as const;

function pickConsentType(raw: string | undefined): ConsentType | undefined {
  return consentTypeEnum.enumValues.find((v) => v === raw);
}

interface Filters {
  consentType?: ConsentType;
  decision?: "granted" | "withdrawn";
  q?: string;
  user?: string;
}

function href(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.consentType) params.set("type", filters.consentType);
  if (filters.decision) params.set("decision", filters.decision);
  if (filters.q) params.set("q", filters.q);
  if (filters.user) params.set("user", filters.user);
  const query = params.toString();
  return query ? `/admin/consents?${query}` : "/admin/consents";
}

function FilterRow({
  title,
  options,
}: {
  title: string;
  options: { key: string; text: string; href: string; active: boolean }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-20 text-xs font-medium text-ink-500">{title}</span>
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

function Count({ label, value, tone }: { label: string; value: number; tone?: "warning" | "danger" }) {
  const colour =
    tone === "danger" ? "text-red-700" : tone === "warning" ? "text-amber-700" : "text-ink-900";
  return (
    <div>
      <p className={`text-xl font-semibold ${colour}`}>{value}</p>
      <p className="text-xs text-ink-500">{label}</p>
    </div>
  );
}

function SummaryCard({ summary, policyVersion }: { summary: ConsentTypeSummary; policyVersion: string }) {
  return (
    <Card className="p-5">
      <h3 className="mb-3 text-sm font-semibold text-ink-900">{CONSENT_LABELS[summary.consentType]}</h3>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Count label={`current (${policyVersion})`} value={summary.current} />
        <Count label="on an older version" value={summary.stale} tone={summary.stale > 0 ? "warning" : undefined} />
        <Count label="withdrawn" value={summary.withdrawn} tone={summary.withdrawn > 0 ? "warning" : undefined} />
        <Count label="no record" value={summary.never} tone={summary.never > 0 ? "danger" : undefined} />
      </div>
    </Card>
  );
}

function when(value: Date): string {
  return new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * NAV-019 — the consent half of the admin security surface (the fraud half is
 * /admin/risk).
 *
 * DPDPA §6 requires the Data Fiduciary to be able to demonstrate that consent
 * was given; this is where that is actually demonstrable. The stored IP address
 * is deliberately not shown — it is evidence of the act of consenting, not
 * something staff browse — and reading one person's trail is audited.
 */
export default async function ConsentsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; decision?: string; q?: string; user?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.CONSENT_VIEW)) redirect("/");

  const params = await searchParams;
  const query = params.q?.trim() || undefined;
  const filters: Filters = {
    consentType: pickConsentType(params.type),
    decision: DECISIONS.find((d) => d.key === params.decision)?.key,
    q: query,
    user: params.user,
  };

  const [overview, changes, matches, trail] = await Promise.all([
    getConsentOverview(),
    listConsentChanges({
      consentType: filters.consentType,
      granted: DECISIONS.find((d) => d.key === filters.decision)?.granted,
    }),
    query ? listUsers({ query, limit: 20 }) : Promise.resolve([]),
    params.user ? getUserConsentTrail(params.user, user) : Promise.resolve(null),
  ]);

  const filtered = Boolean(filters.consentType || filters.decision);

  return (
    <>
      <PageHeader
        title="Consent record"
        description={`Current policy version ${overview.policyVersion}, across ${overview.liveUsers} live accounts. Consent is append-only — a withdrawal is a new row, never an edit. The IP address captured with each record is not shown here.`}
        action={
          <LinkButton href="/admin/risk" variant="secondary">
            Risk & fraud
          </LinkButton>
        }
      />

      <Section title="Where consent stands">
        <div className="grid gap-3 lg:grid-cols-2">
          {overview.byType.map((summary) => (
            <SummaryCard key={summary.consentType} summary={summary} policyVersion={overview.policyVersion} />
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-500">
          &quot;No record&quot; counts accounts with no row of that type at all. A campaign&apos;s audience filter
          asks only whether the newest row is a grant, so both the first two numbers are reachable for marketing
          and the last two are not — re-asking after a policy change is a policy decision, not something the
          send path enforces.
        </p>
      </Section>

      <Section title="Look up one person">
        <Card className="p-5">
          <form action="/admin/consents" className="flex max-w-xl flex-wrap gap-2">
            <input
              type="search"
              name="q"
              defaultValue={query ?? ""}
              placeholder="Search by name or email"
              aria-label="Search for a person by name or email"
              className={`${inputClass} flex-1`}
            />
            <button
              type="submit"
              className="rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800"
            >
              Search
            </button>
          </form>
          <p className="mt-2 text-xs text-ink-500">
            Opening someone&apos;s record is recorded in the audit log against your account.
          </p>

          {query && matches.length === 0 ? (
            <p className="mt-4 text-sm text-ink-600">Nobody matches “{query}”.</p>
          ) : null}

          {matches.length > 0 ? (
            <ul className="mt-4 space-y-1 text-sm">
              {matches.map((match) => (
                <li key={match.id}>
                  <Link
                    href={href({ q: query, user: match.id })}
                    className="font-medium text-kesari-600 hover:underline"
                  >
                    {match.name ?? "(no name)"} · {match.email}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          {params.user && !trail ? (
            <p className="mt-4 text-sm text-ink-600">That account no longer exists.</p>
          ) : null}

          {trail ? (
            <div className="mt-5 border-t border-cream-100 pt-4">
              <p className="font-medium text-ink-900">
                {trail.user.name ?? "(no name)"} · {trail.user.email}
              </p>
              {trail.history.length === 0 ? (
                <p className="mt-2 text-sm text-ink-600">
                  No consent has ever been recorded for this account.
                </p>
              ) : (
                <ul className="mt-2 space-y-2 text-sm" data-testid="consent-trail">
                  {trail.history.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-center gap-2">
                      <Badge tone={row.granted ? "success" : "danger"}>
                        {row.granted ? "granted" : "withdrawn"}
                      </Badge>
                      <span className="text-ink-700">{CONSENT_LABELS[row.consentType]}</span>
                      <span className="text-ink-500">policy {row.version}</span>
                      <span className="text-ink-500">{when(row.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </Card>
      </Section>

      <Section title="Recent grants & withdrawals">
        <nav aria-label="Filter consent changes" className="mb-4 space-y-2 text-sm" data-testid="consent-filters">
          <FilterRow
            title="Consent"
            options={[
              { key: "all", text: "all", href: href({ ...filters, consentType: undefined }), active: !filters.consentType },
              ...consentTypeEnum.enumValues.map((t) => ({
                key: t,
                text: CONSENT_LABELS[t],
                href: href({ ...filters, consentType: t }),
                active: t === filters.consentType,
              })),
            ]}
          />
          <FilterRow
            title="Decision"
            options={[
              { key: "all", text: "all", href: href({ ...filters, decision: undefined }), active: !filters.decision },
              ...DECISIONS.map((d) => ({
                key: d.key,
                text: d.label,
                href: href({ ...filters, decision: d.key }),
                active: d.key === filters.decision,
              })),
            ]}
          />
        </nav>

        {changes.length === 0 ? (
          <EmptyState
            title={filtered ? "No consent changes match these filters." : "No consent has been recorded yet."}
            action={
              filtered ? (
                <LinkButton href={href({ q: filters.q, user: filters.user })} variant="secondary">
                  Clear filters
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-100 text-left">
                  <th className="px-4 py-3 font-semibold">When</th>
                  <th className="px-4 py-3 font-semibold">Person</th>
                  <th className="px-4 py-3 font-semibold">Consent</th>
                  <th className="px-4 py-3 font-semibold">Decision</th>
                  <th className="px-4 py-3 font-semibold">Policy version</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((change) => (
                  <tr key={change.id} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3 text-ink-600">{when(change.createdAt)}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={href({ ...filters, user: change.userId })}
                        className="font-medium text-kesari-600 hover:underline"
                      >
                        {change.userName ?? change.userEmail}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-ink-700">{CONSENT_LABELS[change.consentType]}</td>
                    <td className="px-4 py-3">
                      <Badge tone={change.granted ? "success" : "danger"}>
                        {change.granted ? "granted" : "withdrawn"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-ink-600">{change.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
