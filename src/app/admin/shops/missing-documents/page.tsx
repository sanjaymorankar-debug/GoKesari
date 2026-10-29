import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { addDays, formatDisplayDate, todayIn, type IsoDate } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { SELLER_DOC_LABELS } from "@/lib/kyc/doc-formats";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getRule } from "@/server/services/settings";
import { documentsDueLabel } from "@/server/services/shop-document-gate";
import { nextFollowUpDay, shopsMissingDocuments } from "@/server/services/shop-document-follow-up";

export const metadata = { title: "Shops missing documents" };
export const dynamic = "force-dynamic";

const VIEWS = {
  live: { label: "Live", statuses: ["APPROVED"] as const },
  suspended: { label: "Suspended", statuses: ["SUSPENDED"] as const },
  pending: { label: "Awaiting approval", statuses: ["PENDING_APPROVAL"] as const },
} as const;
type View = keyof typeof VIEWS;

/**
 * Owner decision 29 Oct 2026 (docs/shop-documents-2026-10): shops whose mandatory documents
 * are not verified, with the reminders sent on the 1st / 15th and the promised date.
 */
export default async function ShopsMissingDocumentsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_APPROVE)) redirect("/");
  const params = await searchParams;
  const view: View = params.view && params.view in VIEWS ? (params.view as View) : "live";
  const rule = await getRule("shopDocumentFollowUp");
  const rows = await shopsMissingDocuments({ statuses: [...VIEWS[view].statuses] });
  const today = todayIn(getEnv().APP_TIMEZONE);
  // Counted from today itself: today is the next one when it is a reminder day.
  const next = formatDisplayDate(nextFollowUpDay(addDays(today, -1), rule.reminderDaysOfMonth));
  const now = Date.now();

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/admin/menu/shops" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Shops
      </Link>
      <PageHeader
        title="Shops missing documents"
        description={
          rule.enabled
            ? `Live shops are reminded on day ${rule.reminderDaysOfMonth.join(" and ")} of each month (next: ${next}) and suspended automatically after reminder ${rule.remindersBeforeSuspension}. Documents waiting for our check are not chased.`
            : "The documents follow-up is switched off (rule shopDocumentFollowUp): no reminders are sent and no shop is suspended."
        }
      />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Filter">
        {(Object.keys(VIEWS) as View[]).map((key) => (
          <Link
            key={key}
            href={`/admin/shops/missing-documents?view=${key}`}
            aria-current={key === view ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium ${
              key === view ? "border-kesari-600 bg-kesari-50 text-kesari-800" : "border-cream-200 text-ink-700 hover:bg-cream-50"
            }`}
          >
            {VIEWS[key].label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <EmptyState title="No shops missing documents" description="Every shop in this view has its mandatory documents verified." />
      ) : (
        <div className="space-y-3" data-testid="missing-documents-list">
          <p className="text-sm text-ink-600">
            {rows.length} shop{rows.length === 1 ? "" : "s"}
          </p>
          {rows.map((r) => {
            const overdue = r.shop.documentsDueAt !== null && r.shop.documentsDueAt.getTime() < now;
            return (
              <Card key={r.shop.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink-900">{r.shop.name}</p>
                    <p className="text-sm text-ink-500">
                      {r.shop.registrationNumber ? `${r.shop.registrationNumber} · ` : ""}
                      {r.shop.ownerName} · {r.shop.phone} · {r.shop.city}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {r.missing.map((d) => (
                        <Badge key={d} tone="danger">
                          {SELLER_DOC_LABELS[d]} missing
                        </Badge>
                      ))}
                      {r.withTeam.map((d) => (
                        <Badge key={d} tone="info">
                          {SELLER_DOC_LABELS[d]} waiting for our check
                        </Badge>
                      ))}
                      {r.shop.documentsDueAt ? (
                        <Badge tone={overdue ? "danger" : "warning"}>
                          {overdue ? "promise overdue since" : "promised by"} {documentsDueLabel(r.shop.documentsDueAt)}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="text-right text-sm text-ink-700">
                    <p>
                      <span className="font-medium">Reminders:</span> {r.remindersSent} of {rule.remindersBeforeSuspension}
                    </p>
                    {r.lastReminderOn ? (
                      <p className="text-ink-500">Last sent {formatDisplayDate(r.lastReminderOn as IsoDate)}</p>
                    ) : null}
                    <Link href={`/admin/shops/${r.shop.id}`} className="font-medium text-kesari-600 hover:underline">
                      Open shop →
                    </Link>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
