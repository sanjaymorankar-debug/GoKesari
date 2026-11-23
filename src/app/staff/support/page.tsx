import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, isNotNull } from "drizzle-orm";

import { DeskTicketList, RaiseTicketForm, type DeskRow } from "@/components/staff/support-desk";
import { Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import {
  listMyAssignedTickets,
  listRaisedTickets,
  listSupportQueue,
  listTeam,
  STAFF_TICKET_CATEGORIES,
  STAFF_TICKET_CATEGORY_LABELS,
  supportDashboard,
  type DeskTicketRow,
} from "@/server/rbac-support/desk";
import { isFeatureEnabledForRole } from "@/server/services/feature-flags";

export const metadata = { title: "Support desk" };
export const dynamic = "force-dynamic";

const ist = (d: Date) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const toDesk = (r: DeskTicketRow): DeskRow => ({ ...r, dueIst: ist(r.resolveBy) });

/**
 * RBAC v2 Phases 4 and 7 (docs/rbac/04-support-and-change-requests.md). Tabs by role:
 *   Support Manager: dashboard (queue counts, average resolution, team workload) and the live queue with controls
 *   Support User:    tickets assigned to me
 *   Operations / any staff: raise a ticket, tickets I raised (confirm when resolved)
 */
export default async function SupportDeskPage({ searchParams }: { searchParams: Promise<{ tab?: string; shopId?: string; opsTaskId?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!(await isFeatureEnabledForRole("rbac_v2_support", user.role))) redirect("/staff");
  const manager = can(user.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE);
  const worker = can(user.role, PERMISSIONS.SUPPORT_TICKET_WORK_ASSIGNED);
  const params = await searchParams;
  const tab = params.tab ?? (manager ? "dashboard" : worker ? "mine" : "raised");
  const tabs = [
    ...(manager ? [{ key: "dashboard", label: "Dashboard" }, { key: "queue", label: "Queue" }] : []),
    ...(worker ? [{ key: "mine", label: "My tickets" }] : []),
    { key: "raised", label: "Raised by me" },
    { key: "raise", label: "Raise a ticket" },
  ];

  let body: React.ReactNode = null;
  if (tab === "dashboard" && manager) {
    const d = await supportDashboard(user);
    const tiles: [string, number][] = [
      ["New", d.counts.new],
      ["Assigned", d.counts.assigned],
      ["In progress", d.counts.inProgress],
      ["Pending / on hold", d.counts.pending],
      ["Awaiting shop owner", d.counts.awaitingOwner],
      ["Resolved", d.counts.resolved],
      ["Overdue", d.counts.overdue],
    ];
    body = (
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {tiles.map(([label, n]) => (
            <Card key={label}>
              <p className="text-sm text-ink-600">{label}</p>
              <p className={`text-2xl font-bold ${label === "Overdue" && n > 0 ? "text-red-700" : "text-ink-900"}`}>{n}</p>
            </Card>
          ))}
          <Card>
            <p className="text-sm text-ink-600">Avg. resolution (30 days)</p>
            <p className="text-2xl font-bold">{d.avgResolutionHours == null ? "—" : `${d.avgResolutionHours} h`}</p>
          </Card>
        </div>
        <Card>
          <p className="mb-2 font-semibold">Workload per Support User</p>
          {d.team.length === 0 ? (
            <p className="text-sm text-ink-600">No Support Users in your team yet. An admin adds them (Admin → Users, or POST /api/staff/teams).</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-600">
                  <th>Name</th>
                  <th className="text-right">Open</th>
                  <th className="text-right">Awaiting owner</th>
                  <th className="text-right">Overdue</th>
                  <th className="text-right">Resolved 7 d</th>
                  <th className="text-right">Avg h</th>
                </tr>
              </thead>
              <tbody>
                {d.team.map((m) => (
                  <tr key={m.userId} className="border-t border-cream-200">
                    <td className="py-1">{m.name}</td>
                    <td className="text-right">{m.open}</td>
                    <td className="text-right">{m.awaitingOwner}</td>
                    <td className={`text-right ${m.overdue ? "text-red-700" : ""}`}>{m.overdue}</td>
                    <td className="text-right">{m.resolved7d}</td>
                    <td className="text-right">{m.avgResolutionHours ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    );
  } else if (tab === "queue" && manager) {
    const team = await listTeam("SUPPORT", user.id);
    body = <DeskTicketList mode="manager" team={team} rows={(await listSupportQueue()).map(toDesk)} />;
  } else if (tab === "mine" && worker) {
    body = <DeskTicketList mode="mine" rows={(await listMyAssignedTickets(user)).map(toDesk)} />;
  } else if (tab === "raise") {
    const own = await db
      .select({ id: shops.id, name: shops.name })
      .from(shops)
      .where(and(isNotNull(shops.onboardedByUserId), eq(shops.onboardedByUserId, user.id)))
      .limit(500);
    body = (
      <RaiseTicketForm
        categories={STAFF_TICKET_CATEGORIES.map((k) => ({ key: k, label: STAFF_TICKET_CATEGORY_LABELS[k] }))}
        shops={params.shopId ? [] : own}
        defaultShopId={params.shopId ?? null}
        opsTaskId={params.opsTaskId ?? null}
      />
    );
  } else {
    body = <DeskTicketList mode="raised" rows={(await listRaisedTickets(user)).map(toDesk)} />;
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/staff" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← My work
      </Link>
      <PageHeader title="Support desk" description="Tickets, assignments and the work that waits for shop owners." />
      <nav className="mb-3 flex flex-wrap gap-1" aria-label="Support sections">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/staff/support?tab=${t.key}`}
            className={`inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold ${tab === t.key ? "bg-kesari-600 text-white" : "bg-cream-100 text-ink-700"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {body}
    </div>
  );
}
