import { redirect } from "next/navigation";

import { BroadcastActions, BroadcastComposer } from "@/components/broadcasts/broadcast-composer";
import { ListTabs } from "@/components/board/list-tabs";
import { Alert, Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { pickTab } from "@/lib/board/status-groups";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { pushTokenStats } from "@/server/notifications/push/tokens";
import { listBroadcasts, type BroadcastView } from "@/server/services/broadcasts";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Broadcasts" };
export const dynamic = "force-dynamic";

const TABS = ["all", "SCHEDULED", "SENDING", "SENT", "DRAFT", "CANCELLED", "EXPIRED"] as const;
const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  all: "All",
  SCHEDULED: "Scheduled",
  SENDING: "Sending",
  SENT: "Sent",
  DRAFT: "Drafts",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};
const TONE: Record<BroadcastView["status"], "neutral" | "success" | "warning" | "danger" | "info"> = {
  DRAFT: "neutral",
  SCHEDULED: "info",
  SENDING: "warning",
  SENT: "success",
  CANCELLED: "danger",
  EXPIRED: "neutral",
};
const ROLE_NAMES: Record<string, string> = { CUSTOMER: "customers", SHOP_OWNER: "shop owners", DELIVERY_PARTNER: "riders" };

const ist = (d: Date | null) =>
  d ? d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) : null;

function audienceText(b: BroadcastView): string {
  const who = b.audience.roles.map((r) => ROLE_NAMES[r] ?? r).join(", ");
  const where = [...(b.audience.cities ?? []), ...(b.audience.pincodes ?? [])];
  return where.length ? `${who} in ${where.join(", ")}` : `All ${who}`;
}

/**
 * Broadcast announcements (F3.3.2) for admins and operators (BROADCAST_MANAGE):
 * compose with a preview and audience estimate, then the list with sent and
 * read counts, Send now and Cancel. Sending is audited.
 */
export default async function BroadcastsPage({ searchParams }: { searchParams: Promise<{ status?: string; id?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.BROADCAST_MANAGE)) redirect("/");
  const query = await searchParams;
  const tab = pickTab(query.status, TABS, "all");
  const [rows, rules, pushRule, devices] = await Promise.all([
    listBroadcasts({ status: tab === "all" ? undefined : tab, limit: 100 }),
    getRule("broadcasts"),
    getRule("push"),
    pushTokenStats(),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-4" data-testid="admin-broadcasts">
      <PageHeader
        title="Broadcasts"
        description="Announcements to customers, shop owners and riders — in the app's notification centre, with push and email by each person's settings."
      />
      {!rules.enabled ? <Alert tone="warning">Broadcasts are switched off (rule broadcasts.enabled in Settings → Rules).</Alert> : null}
      <Alert tone="info">
        Push notifications are {pushRule.enabled ? `on (${pushRule.provider})` : "off (rule push.enabled)"} · app devices registered:{" "}
        {devices.android} Android, {devices.ios} iPhone.
      </Alert>

      {rules.enabled ? <BroadcastComposer /> : null}

      <ListTabs
        label="Broadcasts"
        active={tab}
        tabs={TABS.map((t) => ({ key: t, label: TAB_LABELS[t], href: t === "all" ? "/admin/broadcasts" : `/admin/broadcasts?status=${t}` }))}
      />
      {rows.length === 0 ? (
        <EmptyState title="No broadcasts here yet." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((b) => (
            <Card
              key={b.id}
              className={b.id === query.id ? "p-4 ring-2 ring-kesari-600" : "p-4"}
              data-testid="broadcast-row"
              data-status={b.status}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-base font-bold text-ink-900">{b.title}</p>
                <Badge tone={TONE[b.status]}>{b.status.toLowerCase()}</Badge>
              </div>
              <p className="mt-1 text-sm text-ink-700">{b.message}</p>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-ink-500">Audience</dt>
                  <dd className="text-ink-900">{audienceText(b)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-500">Reached / read</dt>
                  <dd className="tabular-nums text-ink-900">
                    {b.recipientCount}
                    {b.audienceEstimate != null && b.status === "SENDING" ? ` of ~${b.audienceEstimate}` : ""} / {b.readCount}
                  </dd>
                </div>
                {b.scheduleAt ? (
                  <div>
                    <dt className="text-xs text-ink-500">Send at</dt>
                    <dd className="text-ink-900">{ist(b.scheduleAt)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="text-xs text-ink-500">Expires</dt>
                  <dd className="text-ink-900">{ist(b.expiresAt) ?? ((b.status === "DRAFT" || b.status === "SCHEDULED") && rules.defaultExpiryDays > 0 ? `${rules.defaultExpiryDays} days after sending` : "never")}</dd>
                </div>
              </dl>
              {b.lastError ? <p className="mt-2 text-xs text-red-800">Last error: {b.lastError} (the dispatcher retries)</p> : null}
              <div className="mt-3">
                <BroadcastActions id={b.id} status={b.status} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
