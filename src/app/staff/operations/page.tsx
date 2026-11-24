import Link from "next/link";
import { redirect } from "next/navigation";

import { AssistForm, AssistStatusButtons, EndZoneButton, TaskComposer, TeamMemberButton, ZoneAssigner } from "@/components/staff/operations-desk";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";
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

type Tab = { key: string; label: Text };
const MANAGER_TABS: Tab[] = [
  { key: "overview", label: L("Overview", "सारांश", "सारांश") },
  { key: "tasks", label: L("Tasks", "काम", "कामे") },
  { key: "team", label: L("Team & zones", "टीम और ज़ोन", "टीम आणि झोन") },
  { key: "reports", label: L("Reports", "रिपोर्ट", "अहवाल") },
  { key: "customers", label: L("Customers", "ग्राहक", "ग्राहक") },
];
const USER_TABS: Tab[] = [
  { key: "today", label: L("Today", "आज", "आज") },
  { key: "tasks", label: L("My tasks", "मेरे काम", "माझी कामे") },
  { key: "customers", label: L("Customers", "ग्राहक", "ग्राहक") },
];

const KIND: Record<string, Text> = {
  SHOP_ONBOARDING: L("Shop onboarding", "दुकान जोड़ना", "दुकान जोडणे"),
  CUSTOMER_ONBOARDING: L("Customer onboarding", "ग्राहक जोड़ना", "ग्राहक जोडणे"),
  FOLLOW_UP: L("Follow-up", "फ़ॉलो-अप", "फॉलो-अप"),
  DOCUMENT_COLLECTION: L("Documents", "दस्तावेज़", "कागदपत्रे"),
  OTHER: L("Other", "अन्य", "इतर"),
};
const PRIORITY_TONE = { LOW: "neutral", NORMAL: "neutral", HIGH: "warning", URGENT: "danger" } as const;
const ASSIST: Record<string, { label: Text; tone: "neutral" | "info" | "success" | "warning" }> = {
  ENQUIRY: { label: L("Enquiry", "पूछताछ", "चौकशी"), tone: "neutral" },
  INVITED: { label: L("Helped to sign in", "साइन इन में मदद की", "साइन इनसाठी मदत केली"), tone: "info" },
  REGISTERED: { label: L("Registered", "रजिस्टर हुआ", "नोंदणी झाली"), tone: "success" },
  PROFILE_COMPLETE: { label: L("Profile complete", "प्रोफ़ाइल पूरी", "प्रोफाइल पूर्ण"), tone: "success" },
  DROPPED: { label: L("Not interested", "रुचि नहीं", "रस नाही"), tone: "warning" },
};

const TILE = {
  "Open tasks": L("Open tasks", "खुले काम", "उघडी कामे"),
  "Overdue": L("Overdue", "देर से", "मुदत उलटलेली"),
  "Due today": L("Due today", "आज तक", "आज देय"),
  "Follow-ups due": L("Follow-ups due", "बाकी फ़ॉलो-अप", "बाकी फॉलो-अप"),
  "Done today": L("Done today", "आज पूरे", "आज पूर्ण"),
  "Shops I onboarded": L("Shops I onboarded", "मेरी जोड़ी दुकानें", "मी जोडलेली दुकाने"),
  "Live": L("Live", "लाइव", "लाइव्ह"),
  "Pending approval": L("Pending approval", "मंज़ूरी बाकी", "मंजुरी बाकी"),
  "Documents missing": L("Documents missing", "दस्तावेज़ बाकी", "कागदपत्रे बाकी"),
  "Fee unpaid": L("Fee unpaid", "शुल्क बाकी", "शुल्क बाकी"),
  "Customer enquiries": L("Customer enquiries", "ग्राहक पूछताछ", "ग्राहक चौकशी"),
  "Customers registered": L("Customers registered", "रजिस्टर हुए ग्राहक", "नोंदणी झालेले ग्राहक"),
  "Registered": L("Registered", "रजिस्टर हुईं", "नोंदणी झालेली"),
  "New (7 days)": L("New (7 days)", "नई (7 दिन)", "नवीन (7 दिवस)"),
  "Pending": L("Pending", "बाकी", "बाकी"),
  "Under verification": L("Under verification", "सत्यापन में", "पडताळणीत"),
  "Auto-approved": L("Auto-approved", "अपने-आप मंज़ूर", "आपोआप मंजूर"),
  "Manually approved": L("Manually approved", "हाथ से मंज़ूर", "हाताने मंजूर"),
  "Rejected": L("Rejected", "अस्वीकृत", "नाकारलेली"),
  "Active": L("Active", "सक्रिय", "सक्रिय"),
  "Inactive": L("Inactive", "निष्क्रिय", "निष्क्रिय"),
  "Total": L("Total", "कुल", "एकूण"),
  "New today": L("New today", "आज नए", "आज नवीन"),
  "New this week": L("New this week", "इस हफ़्ते नए", "या आठवड्यात नवीन"),
  "Active (90 days)": L("Active (90 days)", "सक्रिय (90 दिन)", "सक्रिय (90 दिवस)"),
  "Operations-assisted": L("Operations-assisted", "ऑपरेशंस की मदद से", "ऑपरेशन्सच्या मदतीने"),
  "Dealer code": L("Dealer code", "डीलर कोड", "डीलर कोड"),
  "Operations Users": L("Operations Users", "ऑपरेशंस यूज़र", "ऑपरेशन्स युजर"),
  "Overdue tasks": L("Overdue tasks", "देर वाले काम", "मुदत उलटलेली कामे"),
  "Done (7 days)": L("Done (7 days)", "पूरे (7 दिन)", "पूर्ण (7 दिवस)"),
} as const satisfies Record<string, Text>;

/** Module 6: Hindi / Marathi for the desk's other words (English unchanged; the manager's Reports tab stays English). */
const T = {
  noTasks: L("No tasks here", "यहाँ कोई काम नहीं", "इथे कामे नाहीत"),
  overdue: L("Overdue", "देर से", "मुदत उलटली"),
  due: L(" · due {date}", " · अंतिम तारीख {date}", " · अंतिम तारीख {date}"),
  followUp: L(" · follow up {date}", " · फ़ॉलो-अप {date}", " · फॉलो-अप {date}"),
  onboard: L("Onboard a shop →", "दुकान जोड़ें →", "दुकान जोडा →"),
  myZones: L("My zones: {zones}", "मेरे ज़ोन: {zones}", "माझे झोन: {zones}"),
  today: L("Today", "आज", "आज"),
  shops: L("Shops", "दुकानें", "दुकाने"),
  customers: L("Customers", "ग्राहक", "ग्राहक"),
  team: L("Team", "टीम", "टीम"),
  liveData: L("Live data, {at}.", "ताज़ा डेटा, {at}।", "ताजी माहिती, {at}."),
  open: L("Open ({n})", "खुले ({n})", "उघडी ({n})"),
  finished: L("Finished (latest {n})", "पूरे (नवीनतम {n})", "पूर्ण (नवीनतम {n})"),
  noOpsUsers: L("No Operations Users yet", "अभी कोई ऑपरेशंस यूज़र नहीं", "अजून ऑपरेशन्स युजर नाहीत"),
  teamEmpty: L("Your team is empty", "आपकी टीम खाली है", "तुमची टीम रिकामी आहे"),
  adminGives: L("An admin gives the Operations User role from Users.", "एडमिन Users से ऑपरेशंस यूज़र की भूमिका देते हैं।", "ॲडमिन Users मधून ऑपरेशन्स युजरची भूमिका देतात."),
  addBelow: L("Add Operations Users to your team below.", "नीचे अपनी टीम में ऑपरेशंस यूज़र जोड़ें।", "खाली तुमच्या टीममध्ये ऑपरेशन्स युजर जोडा."),
  memberLine: L("{open} open · {overdue} overdue · {done} done in 7 days", "{open} खुले · {overdue} देर से · 7 दिन में {done} पूरे", "{open} उघडी · {overdue} मुदत उलटली · 7 दिवसांत {done} पूर्ण"),
  tasks: L("tasks", "काम", "कामे"),
  notInTeam: L("Operations Users not in a team", "जो ऑपरेशंस यूज़र किसी टीम में नहीं हैं", "कोणत्याही टीममध्ये नसलेले ऑपरेशन्स युजर"),
  managerAdds: L("An Operations Manager adds them to their own team here.", "ऑपरेशंस मैनेजर उन्हें यहाँ अपनी टीम में जोड़ते हैं।", "ऑपरेशन्स मॅनेजर त्यांना इथे स्वतःच्या टीममध्ये जोडतात."),
  noCustomers: L("No customers recorded yet", "अभी कोई ग्राहक दर्ज नहीं", "अजून ग्राहक नोंदवलेले नाहीत"),
  by: L(" · by {name}", " · {name} द्वारा", " · {name} कडून"),
  myWork: L("← My work", "← मेरा काम", "← माझे काम"),
  title: L("Operations", "ऑपरेशंस", "ऑपरेशन्स"),
  descManager: L(
    "Shop and customer onboarding: your team, its tasks and the numbers.",
    "दुकान और ग्राहक जोड़ना: आपकी टीम, उसके काम और आँकड़े।",
    "दुकान आणि ग्राहक जोडणे: तुमची टीम, तिची कामे आणि आकडे.",
  ),
  descUser: L("Your onboarding tasks, follow-ups and customers.", "आपके जोड़ने के काम, फ़ॉलो-अप और ग्राहक।", "तुमची जोडणीची कामे, फॉलो-अप आणि ग्राहक."),
  sections: L("Operations sections", "ऑपरेशंस विभाग", "ऑपरेशन्स विभाग"),
} as const;

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

function TaskList({ tasks, showAssignee, lang }: { tasks: OpsTaskView[]; showAssignee: boolean; lang: Lang }) {
  if (tasks.length === 0) return <EmptyState title={tr(T.noTasks, lang)} />;
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
                {t.overdue ? <Badge tone="danger">{tr(T.overdue, lang)}</Badge> : null}
              </div>
              <p className="mt-1 text-sm text-ink-600">
                {KIND[t.kind] ? tr(KIND[t.kind], lang) : undefined}
                {t.shopName ? ` · ${t.shopName}` : ""}
                {showAssignee ? ` · ${t.assigneeName ?? "—"}` : ""}
                {t.dueAt ? tr(T.due, lang).replace("{date}", formatIst(t.dueAt)) : ""}
                {t.followUpAt ? tr(T.followUp, lang).replace("{date}", formatIst(t.followUpAt)) : ""}
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
  const lang = await getBoardLang();
  const tabs = manager ? MANAGER_TABS : USER_TABS;
  const tab = tabs.some((t) => t.key === sp.tab) ? sp.tab! : tabs[0].key;

  let body: React.ReactNode = null;

  if (tab === "today") {
    const d = await getOpsUserDashboard(user);
    body = (
      <div className="grid gap-3">
        <Tiles>
          <Tile label={tr(TILE["Open tasks"], lang)} value={d.tasks.open + d.tasks.inProgress} href="?tab=tasks" />
          <Tile label={tr(TILE["Overdue"], lang)} value={d.tasks.overdue} tone={d.tasks.overdue ? "alert" : "plain"} href="?tab=tasks" />
          <Tile label={tr(TILE["Due today"], lang)} value={d.tasks.dueToday} />
          <Tile label={tr(TILE["Follow-ups due"], lang)} value={d.tasks.followUpsDue} tone={d.tasks.followUpsDue ? "alert" : "plain"} />
          <Tile label={tr(TILE["Done today"], lang)} value={d.tasks.doneToday} tone="good" />
          <Tile label={tr(TILE["Shops I onboarded"], lang)} value={d.shops.onboarded} href="/operator/shops" />
          <Tile label={tr(TILE["Live"], lang)} value={d.shops.live} tone="good" />
          <Tile label={tr(TILE["Pending approval"], lang)} value={d.shops.pending} />
          <Tile label={tr(TILE["Documents missing"], lang)} value={d.shops.awaitingDocuments} href="/operator/documents" />
          <Tile label={tr(TILE["Fee unpaid"], lang)} value={d.shops.awaitingPayment} />
          <Tile label={tr(TILE["Customer enquiries"], lang)} value={d.customers.enquiries + d.customers.invited} href="?tab=customers" />
          <Tile label={tr(TILE["Customers registered"], lang)} value={d.customers.registered + d.customers.profileComplete} tone="good" />
        </Tiles>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link className="font-semibold text-kesari-800 hover:underline" href="/operator/onboard">
            {tr(T.onboard, lang)}
          </Link>
          {d.zones.length ? <span className="text-ink-600">{tr(T.myZones, lang).replace("{zones}", d.zones.join(", "))}</span> : null}
        </div>
        <h2 className="font-semibold">{tr(T.today, lang)}</h2>
        <TaskList tasks={d.today} showAssignee={false} lang={lang} />
      </div>
    );
  } else if (tab === "overview") {
    const [shops, customers, team] = await Promise.all([getShopOnboardingMonitor(user, { days: 7 }), getCustomerOnboardingMonitor(user), listOpsTeam(user)]);
    const t = shops.totals;
    body = (
      <div className="grid gap-3">
        <h2 className="font-semibold">{tr(T.shops, lang)}</h2>
        <Tiles>
          <Tile label={tr(TILE["Registered"], lang)} value={t.total} />
          <Tile label={tr(TILE["New (7 days)"], lang)} value={t.new} />
          <Tile label={tr(TILE["Pending"], lang)} value={t.pending} />
          <Tile label={tr(TILE["Under verification"], lang)} value={t.underVerification} tone={t.underVerification ? "alert" : "plain"} />
          <Tile label={tr(TILE["Auto-approved"], lang)} value={t.autoApproved} tone="good" />
          <Tile label={tr(TILE["Manually approved"], lang)} value={t.manuallyApproved} />
          <Tile label={tr(TILE["Rejected"], lang)} value={t.rejected} />
          <Tile label={tr(TILE["Active"], lang)} value={t.active} tone="good" />
          <Tile label={tr(TILE["Inactive"], lang)} value={t.inactive} />
        </Tiles>
        <h2 className="font-semibold">{tr(T.customers, lang)}</h2>
        <Tiles>
          <Tile label={tr(TILE["Total"], lang)} value={customers.total} />
          <Tile label={tr(TILE["New today"], lang)} value={customers.newToday} />
          <Tile label={tr(TILE["New this week"], lang)} value={customers.newThisWeek} />
          <Tile label={tr(TILE["Active (90 days)"], lang)} value={customers.active} tone="good" />
          <Tile label={tr(TILE["Operations-assisted"], lang)} value={customers.bySource.find((s) => s.source === "OPERATIONS")?.total ?? 0} />
          <Tile label={tr(TILE["Dealer code"], lang)} value={customers.bySource.find((s) => s.source === "DEALER_CODE")?.total ?? 0} />
        </Tiles>
        <h2 className="font-semibold">{tr(T.team, lang)}</h2>
        <Tiles>
          <Tile label={tr(TILE["Operations Users"], lang)} value={team.length} href="?tab=team" />
          <Tile label={tr(TILE["Open tasks"], lang)} value={team.reduce((s, m) => s + m.openTasks, 0)} href="?tab=tasks" />
          <Tile label={tr(TILE["Overdue tasks"], lang)} value={team.reduce((s, m) => s + m.overdueTasks, 0)} tone={team.some((m) => m.overdueTasks) ? "alert" : "plain"} />
          <Tile label={tr(TILE["Done (7 days)"], lang)} value={team.reduce((s, m) => s + m.doneLast7Days, 0)} tone="good" />
        </Tiles>
        <p className="text-xs text-ink-600">{tr(T.liveData, lang).replace("{at}", String(shops.generatedAt))}</p>
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
        <h2 className="font-semibold">{tr(T.open, lang).replace("{n}", String(active.length))}</h2>
        <TaskList tasks={active} showAssignee={manager} lang={lang} />
        <h2 className="font-semibold">{tr(T.finished, lang).replace("{n}", String(finished.length))}</h2>
        <TaskList tasks={finished} showAssignee={manager} lang={lang} />
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
            title={isAdmin ? tr(T.noOpsUsers, lang) : tr(T.teamEmpty, lang)}
            description={isAdmin ? tr(T.adminGives, lang) : tr(T.addBelow, lang)}
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
                      {tr(T.memberLine, lang).replace("{open}", String(m.openTasks)).replace("{overdue}", String(m.overdueTasks)).replace("{done}", String(m.doneLast7Days))}
                    </span>
                    <Link className="text-sm text-kesari-800 hover:underline" href={`?tab=tasks&assignee=${m.id}`}>
                      {tr(T.tasks, lang)}
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
            <h2 className="font-semibold">{tr(T.notInTeam, lang)}</h2>
            <ul className="grid gap-1">
              {unteamed.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{u.name ?? u.email}</span>
                  {!isAdmin ? <TeamMemberButton managerUserId={user.id} memberUserId={u.id} mode="add" /> : null}
                </li>
              ))}
            </ul>
            {isAdmin ? <p className="text-xs text-ink-600">{tr(T.managerAdds, lang)}</p> : null}
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
          <a
            className="inline-flex min-h-11 items-center rounded-lg border border-kesari-600 px-4 text-sm font-medium text-kesari-800 hover:bg-kesari-50"
            href={`/api/staff/operations/reports?kind=pdf&period=${period}&date=${from}&days=${days}`}
          >
            Download PDF
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
          <EmptyState title={tr(T.noCustomers, lang)} />
        ) : (
          <ul className="grid gap-2">
            {assists.map((a) => (
              <li key={a.id}>
                <Card className="flex flex-wrap items-center gap-2 p-3">
                  <span className="font-semibold">{a.customerName}</span>
                  <Badge tone={ASSIST[a.status].tone}>{tr(ASSIST[a.status].label, lang)}</Badge>
                  <span className="text-sm text-ink-600">
                    {[a.contactEmail, a.contactPhone, a.pincode].filter(Boolean).join(" · ")}
                    {manager ? tr(T.by, lang).replace("{name}", a.opsUserName ?? "—") : ""} · {formatIst(a.createdAt)}
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
        {tr(T.myWork, lang)}
      </Link>
      <PageHeader
        title={tr(T.title, lang)}
        description={manager ? tr(T.descManager, lang) : tr(T.descUser, lang)}
      />
      <nav className="mb-3 flex flex-wrap gap-1" aria-label={tr(T.sections, lang)}>
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`?tab=${t.key}`}
            aria-current={t.key === tab ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium ${
              t.key === tab ? "bg-kesari-600 text-white" : "bg-cream-100 text-ink-800 hover:bg-cream-200"
            }`}
          >
            {tr(t.label, lang)}
          </Link>
        ))}
      </nav>
      {body}
    </div>
  );
}
