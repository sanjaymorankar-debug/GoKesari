import Link from "next/link";
import { redirect } from "next/navigation";

import { AssistForm, AssistStatusButtons, EndZoneButton, TaskComposer, TeamMemberButton, ZoneAssigner } from "@/components/staff/operations-desk";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatIst } from "@/lib/franchise";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import {
  getOpsActivityReport,
  getOpsUserDashboard,
  getShopOnboardingMonitor,
  getCustomerOnboardingMonitor,
  isOpsManager,
  listCustomerAssists,
  listOpsTasks,
  listOpsTeam,
  listUnteamedOpsUsers,
  listZones,
  istPeriod,
  type OpsTaskView,
  type ShopBreakdownRow,
} from "@/server/rbac-operations";
import { isFeatureEnabledForRole } from "@/server/services/feature-flags";

export const metadata = { title: "Operations" };
export const dynamic = "force-dynamic";

type Tab = { key: string; label: string };
const MANAGER_TABS: Tab[] = [
  { key: "overview", label: "Overview" },
  { key: "tasks", label: "Tasks" },
  { key: "team", label: "Team & zones" },
  { key: "reports", label: "Reports" },
  { key: "customers", label: "Customers" },
];
const USER_TABS: Tab[] = [
  { key: "today", label: "Today" },
  { key: "tasks", label: "My tasks" },
  { key: "customers", label: "Customers" },
];

const KIND: Record<string, string> = {
  SHOP_ONBOARDING: "Shop onboarding",
  CUSTOMER_ONBOARDING: "Customer onboarding",
  FOLLOW_UP: "Follow-up",
  DOCUMENT_COLLECTION: "Documents",
  OTHER: "Other",
};
const PRIORITY_TONE = { LOW: "neutral", NORMAL: "neutral", HIGH: "warning", URGENT: "danger" } as const;
const ASSIST: Record<string, { label: string; tone: "neutral" | "info" | "success" | "warning" }> = {
  ENQUIRY: { label: "Enquiry", tone: "neutral" },
  INVITED: { label: "Helped to sign in", tone: "info" },
  REGISTERED: { label: "Registered", tone: "success" },
  PROFILE_COMPLETE: { label: "Profile complete", tone: "success" },
  DROPPED: { label: "Not interested", tone: "warning" },
};

/** Theme 1 tile: one number, one label, optional link. */
function Tile({ label, value, tone = "plain", href }: { label: string; value: number | string; tone?: "plain" | "alert" | "good"; href?: string }) {
  const ring = tone === "alert" ? "border-red-300 bg-red-50" : tone === "good" ? "border-leaf-300 bg-leaf-50" : "border-cream-200 bg-white";
  const body = (
    <div className={`flex min-h-20 flex-col justify-between rounded-xl border p-3 shadow-sm ${ring}`}>
      <span className="text-2xl font-bold text-ink-900">{value}</span>
      <span className="text-xs font-medium text-ink-600">{label}</span>
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-xl focus-visible:outline-2 focus-visible:outline-kesari-600">
      {body}
    </Link>
  ) : (
    body
  );
}

const Tiles = ({ children }: { children: React.ReactNode }) => <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{children}</div>;

function TaskList({ tasks, showAssignee }: { tasks: OpsTaskView[]; showAssignee: boolean }) {
  if (tasks.length === 0) return <EmptyState title="No tasks here" />;
  return (
    <ul className="grid gap-2">
      {tasks.map((t) => (
        <li key={t.id}>
          <Link href={`/staff/operations/tasks/${t.id}`} className="block">
            <Card className={`p-3 hover:border-kesari-300 ${t.overdue ? "border-red-300" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{t.title}</span>
                <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority}</Badge>
                <Badge tone={t.status === "DONE" ? "success" : t.status === "CANCELLED" ? "warning" : "info"}>{t.status.replace("_", " ")}</Badge>
                {t.overdue ? <Badge tone="danger">Overdue</Badge> : null}
              </div>
              <p className="mt-1 text-sm text-ink-600">
                {KIND[t.kind]}
                {t.shopName ? ` · ${t.shopName}` : ""}
                {showAssignee ? ` · ${t.assigneeName ?? "—"}` : ""}
                {t.dueAt ? ` · due ${formatIst(t.dueAt)}` : ""}
                {t.followUpAt ? ` · follow up ${formatIst(t.followUpAt)}` : ""}
              </p>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: ShopBreakdownRow[] }) {
  return (
    <Card className="overflow-x-auto p-3">
      <h3 className="mb-1 font-semibold">{title}</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-ink-600">
            <th className="py-1"> </th>
            <th className="py-1 text-right">Total</th>
            <th className="py-1 text-right">New</th>
            <th className="py-1 text-right">Pending</th>
            <th className="py-1 text-right">Verifying</th>
            <th className="py-1 text-right">Auto</th>
            <th className="py-1 text-right">Manual</th>
            <th className="py-1 text-right">Active</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 15).map((r) => (
            <tr key={r.key ?? "none"} className="border-t border-cream-200">
              <td className="py-1">{r.label}</td>
              <td className="py-1 text-right">{r.counts.total}</td>
              <td className="py-1 text-right">{r.counts.new}</td>
              <td className="py-1 text-right">{r.counts.pending}</td>
              <td className="py-1 text-right">{r.counts.underVerification}</td>
              <td className="py-1 text-right">{r.counts.autoApproved}</td>
              <td className="py-1 text-right">{r.counts.manuallyApproved}</td>
              <td className="py-1 text-right">{r.counts.active}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * RBAC v2 Phase 6 Operations desk (docs/rbac/06-operations.md). Operations Manager: overview,
 * tasks, team & zones, reports, customers. Operations User: today, own tasks, customers. Shop
 * onboarding itself stays on the existing /operator flow. Behind rbac_v2_operations for the role.
 */
export default async function OperationsPage({ searchParams }: { searchParams: Promise<{ tab?: string; period?: string; date?: string; days?: string; assignee?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const manager = isOpsManager(user);
  const worker = can(user.role, PERMISSIONS.OPS_TASK_WORK_OWN);
  if (!manager && !worker) redirect("/staff");
  if (!(await isFeatureEnabledForRole("rbac_v2_operations", user.role))) redirect("/staff");
  const sp = await searchParams;
  const tabs = manager ? MANAGER_TABS : USER_TABS;
  const tab = tabs.some((t) => t.key === sp.tab) ? sp.tab! : tabs[0].key;

  let body: React.ReactNode = null;

  if (tab === "today") {
    const d = await getOpsUserDashboard(user);
    body = (
      <div className="grid gap-3">
        <Tiles>
          <Tile label="Open tasks" value={d.tasks.open + d.tasks.inProgress} href="?tab=tasks" />
          <Tile label="Overdue" value={d.tasks.overdue} tone={d.tasks.overdue ? "alert" : "plain"} href="?tab=tasks" />
          <Tile label="Due today" value={d.tasks.dueToday} />
          <Tile label="Follow-ups due" value={d.tasks.followUpsDue} tone={d.tasks.followUpsDue ? "alert" : "plain"} />
          <Tile label="Done today" value={d.tasks.doneToday} tone="good" />
          <Tile label="Shops I onboarded" value={d.shops.onboarded} href="/operator/shops" />
          <Tile label="Live" value={d.shops.live} tone="good" />
          <Tile label="Pending approval" value={d.shops.pending} />
          <Tile label="Documents missing" value={d.shops.awaitingDocuments} href="/operator/documents" />
          <Tile label="Fee unpaid" value={d.shops.awaitingPayment} />
          <Tile label="Customer enquiries" value={d.customers.enquiries + d.customers.invited} href="?tab=customers" />
          <Tile label="Customers registered" value={d.customers.registered + d.customers.profileComplete} tone="good" />
        </Tiles>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link className="font-semibold text-kesari-800 hover:underline" href="/operator/onboard">
            Onboard a shop →
          </Link>
          {d.zones.length ? <span className="text-ink-600">My zones: {d.zones.join(", ")}</span> : null}
        </div>
        <h2 className="font-semibold">Today</h2>
        <TaskList tasks={d.today} showAssignee={false} />
      </div>
    );
  } else if (tab === "overview") {
    const [shops, customers, team] = await Promise.all([getShopOnboardingMonitor(user, { days: 7 }), getCustomerOnboardingMonitor(user), listOpsTeam(user)]);
    const t = shops.totals;
    body = (
      <div className="grid gap-3">
        <h2 className="font-semibold">Shops</h2>
        <Tiles>
          <Tile label="Registered" value={t.total} />
          <Tile label="New (7 days)" value={t.new} />
          <Tile label="Pending" value={t.pending} />
          <Tile label="Under verification" value={t.underVerification} tone={t.underVerification ? "alert" : "plain"} />
          <Tile label="Auto-approved" value={t.autoApproved} tone="good" />
          <Tile label="Manually approved" value={t.manuallyApproved} />
          <Tile label="Rejected" value={t.rejected} />
          <Tile label="Active" value={t.active} tone="good" />
          <Tile label="Inactive" value={t.inactive} />
        </Tiles>
        <h2 className="font-semibold">Customers</h2>
        <Tiles>
          <Tile label="Total" value={customers.total} />
          <Tile label="New today" value={customers.newToday} />
          <Tile label="New this week" value={customers.newThisWeek} />
          <Tile label="Active (90 days)" value={customers.active} tone="good" />
          <Tile label="Operations-assisted" value={customers.bySource.find((s) => s.source === "OPERATIONS")?.total ?? 0} />
          <Tile label="Dealer code" value={customers.bySource.find((s) => s.source === "DEALER_CODE")?.total ?? 0} />
        </Tiles>
        <h2 className="font-semibold">Team</h2>
        <Tiles>
          <Tile label="Operations Users" value={team.length} href="?tab=team" />
          <Tile label="Open tasks" value={team.reduce((s, m) => s + m.openTasks, 0)} href="?tab=tasks" />
          <Tile label="Overdue tasks" value={team.reduce((s, m) => s + m.overdueTasks, 0)} tone={team.some((m) => m.overdueTasks) ? "alert" : "plain"} />
          <Tile label="Done (7 days)" value={team.reduce((s, m) => s + m.doneLast7Days, 0)} tone="good" />
        </Tiles>
        <p className="text-xs text-ink-600">Live data, {shops.generatedAt}.</p>
      </div>
    );
  } else if (tab === "tasks") {
    const [tasks, team, zones] = await Promise.all([
      listOpsTasks(user, { status: "ALL", assigneeUserId: manager && /^[0-9a-f-]{36}$/i.test(sp.assignee ?? "") ? sp.assignee : undefined }),
      manager ? listOpsTeam(user) : Promise.resolve([]),
      manager ? listZones(user) : Promise.resolve([]),
    ]);
    const active = tasks.filter((t) => t.status === "OPEN" || t.status === "IN_PROGRESS");
    const finished = tasks.filter((t) => !(t.status === "OPEN" || t.status === "IN_PROGRESS")).slice(0, 30);
    body = (
      <div className="grid gap-3">
        {manager ? (
          <TaskComposer
            people={team.filter((m) => m.status === "ACTIVE").map((m) => ({ id: m.id, name: m.name ?? m.email }))}
            zones={zones.map((z) => ({ zoneId: z.zoneId, name: z.name }))}
          />
        ) : null}
        <h2 className="font-semibold">Open ({active.length})</h2>
        <TaskList tasks={active} showAssignee={manager} />
        <h2 className="font-semibold">Finished (latest {finished.length})</h2>
        <TaskList tasks={finished} showAssignee={manager} />
      </div>
    );
  } else if (tab === "team") {
    const isAdmin = user.role === "ADMIN";
    const [team, zones, unteamed] = await Promise.all([listOpsTeam(user), listZones(user), listUnteamedOpsUsers(user)]);
    const zoneOpts = zones.map((z) => ({ zoneId: z.zoneId, name: `${z.name} (${z.region})` }));
    body = (
      <div className="grid gap-3">
        {team.length === 0 ? (
          <EmptyState
            title={isAdmin ? "No Operations Users yet" : "Your team is empty"}
            description={isAdmin ? "An admin gives the Operations User role from Users." : "Add Operations Users to your team below."}
          />
        ) : (
          <ul className="grid gap-2">
            {team.map((m) => (
              <li key={m.id}>
                <Card className="grid gap-2 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{m.name ?? m.email}</span>
                    {m.status !== "ACTIVE" ? <Badge tone="warning">{m.status}</Badge> : null}
                    <span className="text-sm text-ink-600">
                      {m.openTasks} open · {m.overdueTasks} overdue · {m.doneLast7Days} done in 7 days
                    </span>
                    <Link className="text-sm text-kesari-800 hover:underline" href={`?tab=tasks&assignee=${m.id}`}>
                      tasks
                    </Link>
                    {!isAdmin ? <TeamMemberButton managerUserId={user.id} memberUserId={m.id} mode="remove" /> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {m.zones.map((z) => (
                      <EndZoneButton key={z.assignmentId} assignmentId={z.assignmentId} label={z.zoneName ?? z.zoneId} />
                    ))}
                    {m.status === "ACTIVE" ? <ZoneAssigner userId={m.id} zones={zoneOpts.filter((z) => !m.zones.some((x) => x.zoneId === z.zoneId))} /> : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {unteamed.length ? (
          <Card className="grid gap-2 p-3">
            <h2 className="font-semibold">Operations Users not in a team</h2>
            <ul className="grid gap-1">
              {unteamed.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{u.name ?? u.email}</span>
                  {!isAdmin ? <TeamMemberButton managerUserId={user.id} memberUserId={u.id} mode="add" /> : null}
                </li>
              ))}
            </ul>
            {isAdmin ? <p className="text-xs text-ink-600">An Operations Manager adds them to their own team here.</p> : null}
          </Card>
        ) : null}
      </div>
    );
  } else if (tab === "reports") {
    const period = sp.period === "week" ? "week" : "day";
    const days = Math.min(365, Math.max(1, Number(sp.days) || 30));
    const { from } = istPeriod(period, sp.date);
    const [activity, shops] = await Promise.all([getOpsActivityReport(user, { period, date: sp.date }), getShopOnboardingMonitor(user, { days })]);
    const cols = [
      ["shopsContacted", "Contacted"],
      ["shopsRegistered", "Registered"],
      ["shopsVerified", "Verified"],
      ["shopsActivated", "Activated"],
      ["customersOnboarded", "Customers"],
      ["followUps", "Follow-ups"],
      ["tasksDone", "Tasks done"],
      ["pendingRegistrations", "Pending now"],
      ["unresolved", "Overdue now"],
    ] as const;
    body = (
      <div className="grid gap-3">
        <form className="flex flex-wrap items-end gap-2" method="get">
          <input type="hidden" name="tab" value="reports" />
          <label className="text-sm">
            Period
            <select name="period" defaultValue={period} className="block min-h-11 rounded-lg border border-cream-300 px-2">
              <option value="day">Day</option>
              <option value="week">Week (Mon–Sun)</option>
            </select>
          </label>
          <label className="text-sm">
            Date (IST)
            <input type="date" name="date" defaultValue={from} className="block min-h-11 rounded-lg border border-cream-300 px-2" />
          </label>
          <label className="text-sm">
            &ldquo;New&rdquo; window (days)
            <input type="number" name="days" min={1} max={365} defaultValue={days} className="block min-h-11 w-24 rounded-lg border border-cream-300 px-2" />
          </label>
          <button className="min-h-11 rounded-lg bg-kesari-600 px-4 text-sm font-medium text-white hover:bg-kesari-800">Show</button>
          <a
            className="inline-flex min-h-11 items-center rounded-lg border border-kesari-600 px-4 text-sm font-medium text-kesari-800 hover:bg-kesari-50"
            href={`/api/staff/operations/reports?kind=excel&period=${period}&date=${from}&days=${days}`}
          >
            Download Excel
          </a>
        </form>
        <Card className="overflow-x-auto p-3">
          <h3 className="mb-1 font-semibold">
            By Operations User — {activity.from === activity.to ? activity.from : `${activity.from} to ${activity.to}`} (IST)
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-600">
                <th className="py-1"> </th>
                {cols.map(([, h]) => (
                  <th key={h} className="py-1 text-right">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...activity.byUser, { key: "total", label: "Total", ...activity.totals }].map((r) => (
                <tr key={r.key ?? r.label} className={`border-t border-cream-200 ${r.key === "total" ? "font-semibold" : ""}`}>
                  <td className="py-1">{r.label}</td>
                  {cols.map(([k]) => (
                    <td key={k} className="py-1 text-right">
                      {r[k]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <BreakdownTable title="Shops by zone" rows={shops.byZone} />
        <BreakdownTable title="Shops by dealer" rows={shops.byDealer} />
        <BreakdownTable title="Shops by team lead" rows={shops.byTeamLead} />
        <BreakdownTable title="Shops by agent" rows={shops.byAgent} />
        <Card className="overflow-x-auto p-3">
          <h3 className="mb-1 font-semibold">Last 14 days (IST)</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-600">
                <th className="py-1">Day</th>
                <th className="py-1 text-right">Registered</th>
                <th className="py-1 text-right">Activated</th>
              </tr>
            </thead>
            <tbody>
              {shops.daily.map((d) => (
                <tr key={d.day} className="border-t border-cream-200">
                  <td className="py-1">{d.day}</td>
                  <td className="py-1 text-right">{d.registered}</td>
                  <td className="py-1 text-right">{d.activated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="text-xs text-ink-600">Live data, {activity.generatedAt}.</p>
      </div>
    );
  } else {
    const assists = await listCustomerAssists(user);
    body = (
      <div className="grid gap-3">
        {can(user.role, PERMISSIONS.CUSTOMER_ONBOARD_ASSIST) ? <AssistForm /> : null}
        {assists.length === 0 ? (
          <EmptyState title="No customers recorded yet" />
        ) : (
          <ul className="grid gap-2">
            {assists.map((a) => (
              <li key={a.id}>
                <Card className="flex flex-wrap items-center gap-2 p-3">
                  <span className="font-semibold">{a.customerName}</span>
                  <Badge tone={ASSIST[a.status].tone}>{ASSIST[a.status].label}</Badge>
                  <span className="text-sm text-ink-600">
                    {[a.contactEmail, a.contactPhone, a.pincode].filter(Boolean).join(" · ")}
                    {manager ? ` · by ${a.opsUserName ?? "—"}` : ""} · {formatIst(a.createdAt)}
                  </span>
                  {a.notes ? <span className="w-full text-sm text-ink-700">{a.notes}</span> : null}
                  {a.opsUserId === user.id || manager ? <AssistStatusButtons id={a.id} status={a.status} /> : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/staff" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← My work
      </Link>
      <PageHeader
        title="Operations"
        description={manager ? "Shop and customer onboarding: your team, its tasks and the numbers." : "Your onboarding tasks, follow-ups and customers."}
      />
      <nav className="mb-3 flex flex-wrap gap-1" aria-label="Operations sections">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`?tab=${t.key}`}
            aria-current={t.key === tab ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium ${
              t.key === tab ? "bg-kesari-600 text-white" : "bg-cream-100 text-ink-800 hover:bg-cream-200"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {body}
    </div>
  );
}
