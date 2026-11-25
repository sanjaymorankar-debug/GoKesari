import { redirect } from "next/navigation";

import { Badge, Card, PageHeader, Section } from "@/components/ui";
import { POLICY_DOC_LABEL } from "@/lib/policy-reconsent";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getPolicyAcceptanceReport, RECONSENT_FLAG } from "@/server/services/policy-versions";

import { PublishPolicyVersionForm } from "./publish-form";

export const metadata = { title: "Policy versions" };
export const dynamic = "force-dynamic";

const CHANNEL_LABEL: Record<string, string> = {
  WEB: "website",
  APP: "app",
  SHOP_PORTAL: "shop portal",
  RIDER_PORTAL: "rider portal",
  DEALER_PORTAL: "dealer portal",
  SIGNUP: "sign-up",
  SHOP_REGISTRATION: "shop registration",
  API: "API",
};

function when(value: Date): string {
  return new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/**
 * docs/policy-reconsent-2026-11: which version of each policy is in force, how
 * many people accepted each version, and (administrators) publishing a new one.
 * Counts only — nobody is identified here; one person's record is on
 * Admin → Consent.
 */
export default async function PolicyVersionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.CONSENT_VIEW)) redirect("/");

  const [report, enabled] = await Promise.all([
    getPolicyAcceptanceReport(),
    isFeatureEnabled(RECONSENT_FLAG).catch(() => false),
  ]);

  return (
    <>
      <PageHeader
        title="Policy versions"
        description={
          enabled
            ? "Re-consent is ON: signed-in users who have not accepted a document's required version see a page asking them to accept it."
            : "Re-consent is OFF (Admin → Settings → Feature flags → “Ask signed-in users to accept a new policy version”). Nobody is asked; the counts below are still kept."
        }
      />

      <Section title="Acceptance by document and version">
        <div className="grid gap-3 lg:grid-cols-3" data-testid="policy-acceptance-report">
          {report.map((d) => (
            <Card key={d.doc} className="p-5">
              <h3 className="text-sm font-semibold text-ink-900">{POLICY_DOC_LABEL[d.doc].en}</h3>
              <p className="mt-1 text-xs text-ink-500">
                {d.required ? `Required version ${d.required.version} (since ${when(d.required.publishedAt)})` : "No version needs acceptance yet"}
              </p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div>
                  <p className="text-xl font-semibold">{d.audience}</p>
                  <p className="text-xs text-ink-500">{d.doc === "seller-terms" ? "shop owners" : "live accounts"}</p>
                </div>
                <div>
                  <p className="text-xl font-semibold">{d.upToDate}</p>
                  <p className="text-xs text-ink-500">up to date</p>
                </div>
                <div>
                  <p className={`text-xl font-semibold ${d.pending > 0 ? "text-amber-700" : ""}`}>{d.pending}</p>
                  <p className="text-xs text-ink-500">still to accept</p>
                </div>
              </div>
              <table className="mt-4 w-full text-left text-xs">
                <thead className="text-ink-500">
                  <tr>
                    <th className="py-1 font-medium">Version</th>
                    <th className="py-1 font-medium">Accepted by</th>
                    <th className="py-1 font-medium">Channels</th>
                  </tr>
                </thead>
                <tbody>
                  {d.versions.map((v) => (
                    <tr key={v.version} className="border-t border-cream-200 align-top">
                      <td className="py-1">
                        {v.version}{" "}
                        {v.requiresAcceptance ? null : <Badge tone="neutral">minor</Badge>}
                        <div className="text-ink-500">{when(v.publishedAt)}</div>
                      </td>
                      <td className="py-1">{v.acceptedBy}</td>
                      <td className="py-1">
                        {Object.entries(v.byChannel)
                          .map(([c, n]) => `${CHANNEL_LABEL[c] ?? c} ${n}`)
                          .join(", ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-500">
          &quot;Up to date&quot; also counts sign-ups made after a Terms or Privacy version was published (their sign-up
          consent covers it). The table counts explicit acceptances of each version.
        </p>
      </Section>

      {user.role === "ADMIN" ? (
        <Section title="Publish a new version">
          <Card className="p-5">
            <p className="mb-3 text-sm text-ink-600">
              Publish after the new text is live on the policy page. A version that users must accept asks everyone
              it applies to on their next visit (while re-consent is on). Versions cannot be edited or withdrawn.
            </p>
            <PublishPolicyVersionForm today={todayIst()} />
          </Card>
        </Section>
      ) : null}
    </>
  );
}
