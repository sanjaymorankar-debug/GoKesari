import Link from "next/link";
import { redirect } from "next/navigation";

import { IdentityFlagSwitch, IdentityReviewQueue } from "@/components/identity-verification-admin";
import { Card, PageHeader } from "@/components/ui";
import { IDENTITY_METHOD_LABELS, IDENTITY_STATUS_LABELS } from "@/lib/kyc/identity";
import { getCurrentUser } from "@/server/authz/guards";
import { IDENTITY_VERIFICATION_METHODS, IDENTITY_VERIFICATION_STATUSES, type UserRole } from "@/server/db/schema";
import { getFeatureFlags, listFeatureFlagChanges } from "@/server/services/feature-flags";
import { IDENTITY_FLAGS, identityStatusCounts, listIdentityReviews, type IdentitySubject } from "@/server/services/identity-verification";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Identity verification" };
export const dynamic = "force-dynamic";

const TABS = [
  { key: "settings", label: "Settings" },
  { key: "queue", label: "Review queue" },
  { key: "status", label: "Status" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const SWITCH_LABELS: Record<IdentitySubject, string> = {
  CUSTOMER: "Customers: verify identity before first checkout",
  SHOP_OWNER: "Shop owners: verify identity before going live / accepting orders",
};

function ist(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}-${get("month")}-${get("year")}, ${get("hour")}.${get("minute")}`;
}

/**
 * docs/identity-verification-2026-11 (owner, 24-Nov-2026): the identity
 * check's own admin tab — switch it on or off separately for customers and
 * shop owners, review name mismatches, see the counts. Admins only (others
 * are sent home; every API refuses them too).
 */
export default async function IdentityVerificationAdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  const { tab: rawTab } = await searchParams;
  const tab: Tab = TABS.some((t) => t.key === rawTab) ? (rawTab as Tab) : "settings";

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Identity verification"
        description="One-time identity check (Aadhaar through DigiLocker, or PAN) for customers and shop owners. Legal advice is pending — keep it off on gokesari.com until it is given."
      />
      <nav aria-label="Identity verification" className="flex flex-wrap gap-2" data-testid="identity-admin-tabs">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/identity-verification?tab=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={
              tab === t.key
                ? "flex h-11 items-center rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white"
                : "flex h-11 items-center rounded-xl border border-[var(--gk-line)] bg-white px-4 text-sm font-semibold text-ink-900 hover:bg-kesari-50"
            }
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "settings" ? <SettingsTab /> : null}
      {tab === "queue" ? <QueueTab actor={user} /> : null}
      {tab === "status" ? <StatusTab actor={user} /> : null}
    </div>
  );
}

async function SettingsTab() {
  const [flags, rule] = await Promise.all([getFeatureFlags(), getRule("identityVerification")]);
  const subjects: IdentitySubject[] = ["CUSTOMER", "SHOP_OWNER"];
  const lastChanges = await Promise.all(subjects.map((s) => listFeatureFlagChanges({ key: IDENTITY_FLAGS[s], limit: 1 })));
  return (
    <div className="space-y-4">
      {subjects.map((subject, i) => {
        const key = IDENTITY_FLAGS[subject];
        const last = lastChanges[i][0];
        return (
          <IdentityFlagSwitch
            key={key}
            flagKey={key}
            label={SWITCH_LABELS[subject]}
            enabled={flags[key]?.enabled ?? false}
            lastChange={last ? { by: last.changedByEmail, at: ist(last.changedAt), reason: last.reason } : null}
          />
        );
      })}
      <Card className="space-y-1 p-5" data-testid="identity-rule-values">
        <h2 className="font-semibold text-ink-900">Rule identityVerification</h2>
        <p className="text-sm text-ink-700">
          Allowed methods: <strong>{rule.allowedMethods === "aadhaar_or_alternative" ? "Aadhaar (DigiLocker) or PAN" : "Aadhaar (DigiLocker) only"}</strong>
        </p>
        <p className="text-sm text-ink-700">
          Shop owner grace period: <strong>{rule.sellerGraceDays} days</strong> from the first time they are asked after the switch is turned on
        </p>
        <p className="text-sm text-ink-700">
          Name match threshold: <strong>{rule.nameMatchThreshold}</strong> · provider: <strong>{rule.provider}</strong> (off production the mock is always used)
        </p>
        <Link href="/admin/settings" className="text-sm font-medium text-kesari-700 underline">
          Change in Settings → rules
        </Link>
      </Card>
    </div>
  );
}

async function QueueTab({ actor }: { actor: { id: string; role: UserRole } }) {
  const items = await listIdentityReviews(actor);
  return (
    <IdentityReviewQueue
      items={items.map((i) => ({
        id: i.id,
        userName: i.userName,
        userEmail: i.userEmail,
        subject: i.subject,
        method: IDENTITY_METHOD_LABELS[i.method],
        maskedId: i.maskedId,
        verifiedName: i.verifiedName,
        comparedName: i.comparedName,
        nameMatchScore: i.nameMatchScore,
        reason: i.reason,
        provider: i.provider,
        updatedAt: `${ist(i.updatedAt)} IST`,
      }))}
    />
  );
}

async function StatusTab({ actor }: { actor: { id: string; role: UserRole } }) {
  const counts = await identityStatusCounts(actor);
  const subjects: IdentitySubject[] = ["CUSTOMER", "SHOP_OWNER"];
  const methods = IDENTITY_VERIFICATION_METHODS.filter((m) => m === "AADHAAR_DIGILOCKER" || m === "PAN");
  const n = (subject: IdentitySubject, method: string, status: string) =>
    counts.find((c) => c.subject === subject && c.method === method && c.status === status)?.count ?? 0;
  return (
    <div className="space-y-4" data-testid="identity-status-counts">
      {subjects.map((subject) => (
        <Card key={subject} className="overflow-x-auto p-5">
          <h2 className="mb-2 font-semibold text-ink-900">{subject === "CUSTOMER" ? "Customers" : "Shop owners"} (attempts)</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-500">
                <th className="py-1 pr-2">Method</th>
                {IDENTITY_VERIFICATION_STATUSES.map((s) => (
                  <th key={s} className="py-1 pr-2">
                    {IDENTITY_STATUS_LABELS[s]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {methods.map((m) => (
                <tr key={m} className="border-t border-cream-200">
                  <td className="py-1 pr-2">{IDENTITY_METHOD_LABELS[m]}</td>
                  {IDENTITY_VERIFICATION_STATUSES.map((s) => (
                    <td key={s} className="py-1 pr-2 tabular-nums">
                      {n(subject, m, s)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
      <p className="text-xs text-ink-500">Each attempt counts once; a person verified with PAN after a failed DigiLocker attempt appears in both rows.</p>
    </div>
  );
}
