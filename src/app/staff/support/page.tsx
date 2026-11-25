import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, isNotNull } from "drizzle-orm";

import { DeskTicketList, RaiseTicketForm, type DeskRow } from "@/components/staff/support-desk";
import { Card, PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";
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

/** Module 6: Hindi / Marathi for the desk's own words (English unchanged). */
const T = {
  dashboard: L("Dashboard", "डैशबोर्ड", "डॅशबोर्ड"),
  queue: L("Queue", "कतार", "रांग"),
  myTickets: L("My tickets", "मेरे टिकट", "माझी तिकिटे"),
  raisedByMe: L("Raised by me", "मेरे बनाए", "मी तयार केलेली"),
  raise: L("Raise a ticket", "टिकट बनाएँ", "तिकीट तयार करा"),
  new: L("New", "नए", "नवीन"),
  assigned: L("Assigned", "सौंपे गए", "सोपवलेली"),
  inProgress: L("In progress", "चल रहे", "सुरू"),
  pending: L("Pending / on hold", "बाकी / रुके हुए", "बाकी / थांबवलेली"),
  awaitingOwner: L("Awaiting shop owner", "दुकान मालिक का इंतज़ार", "दुकान मालकाची वाट"),
  resolved: L("Resolved", "हल हुए", "सोडवलेली"),
  overdue: L("Overdue", "देर से", "मुदत उलटलेली"),
  avg: L("Avg. resolution (30 days)", "औसत समाधान समय (30 दिन)", "सरासरी निराकरण वेळ (30 दिवस)"),
  workload: L("Workload per Support User", "हर सपोर्ट यूज़र का काम", "प्रत्येक सपोर्ट युजरचे काम"),
  noTeam: L(
    "No Support Users in your team yet. An admin adds them (Admin → Users, or POST /api/staff/teams).",
    "आपकी टीम में अभी कोई सपोर्ट यूज़र नहीं है। एडमिन उन्हें जोड़ते हैं (Admin → Users, या POST /api/staff/teams)।",
    "तुमच्या टीममध्ये अजून सपोर्ट युजर नाहीत. ॲडमिन त्यांना जोडतात (Admin → Users, किंवा POST /api/staff/teams).",
  ),
  name: L("Name", "नाम", "नाव"),
  open: L("Open", "खुले", "उघडी"),
  awaitingOwnerShort: L("Awaiting owner", "मालिक का इंतज़ार", "मालकाची वाट"),
  resolved7: L("Resolved 7 d", "7 दिन में हल", "7 दिवसांत सोडवलेली"),
  avgH: L("Avg h", "औसत घंटे", "सरासरी तास"),
  myWork: L("← My work", "← मेरा काम", "← माझे काम"),
  title: L("Support desk", "सपोर्ट डेस्क", "सपोर्ट डेस्क"),
  description: L(
    "Tickets, assignments and the work that waits for shop owners.",
    "टिकट, सौंपे गए काम और वह काम जो दुकान मालिकों का इंतज़ार कर रहा है।",
    "तिकिटे, सोपवलेली कामे आणि दुकान मालकांची वाट पाहणारे काम.",
  ),
  sections: L("Support sections", "सपोर्ट विभाग", "सपोर्ट विभाग"),
} as const;

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
  const lang = await getBoardLang();
  const tab = params.tab ?? (manager ? "dashboard" : worker ? "mine" : "raised");
  const tabs = [
    ...(manager ? [{ key: "dashboard", label: tr(T.dashboard, lang) }, { key: "queue", label: tr(T.queue, lang) }] : []),
    ...(worker ? [{ key: "mine", label: tr(T.myTickets, lang) }] : []),
    { key: "raised", label: tr(T.raisedByMe, lang) },
    { key: "raise", label: tr(T.raise, lang) },
  ];

  let body: React.ReactNode = null;
  if (tab === "dashboard" && manager) {
    const d = await supportDashboard(user);
    const tiles: [string, number][] = [
      [tr(T.new, lang), d.counts.new],
      [tr(T.assigned, lang), d.counts.assigned],
      [tr(T.inProgress, lang), d.counts.inProgress],
      [tr(T.pending, lang), d.counts.pending],
      [tr(T.awaitingOwner, lang), d.counts.awaitingOwner],
      [tr(T.resolved, lang), d.counts.resolved],
      [tr(T.overdue, lang), d.counts.overdue],
    ];
    body = (
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {tiles.map(([label, n]) => (
            <Card key={label}>
              <p className="text-sm text-ink-600">{label}</p>
              <p className={`text-2xl font-bold ${label === tr(T.overdue, lang) && n > 0 ? "text-red-700" : "text-ink-900"}`}>{n}</p>
            </Card>
          ))}
          <Card>
            <p className="text-sm text-ink-600">{tr(T.avg, lang)}</p>
            <p className="text-2xl font-bold">{d.avgResolutionHours == null ? "—" : `${d.avgResolutionHours} h`}</p>
          </Card>
        </div>
        <Card>
          <p className="mb-2 font-semibold">{tr(T.workload, lang)}</p>
          {d.team.length === 0 ? (
            <p className="text-sm text-ink-600">{tr(T.noTeam, lang)}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-600">
                  <th>{tr(T.name, lang)}</th>
                  <th className="text-right">{tr(T.open, lang)}</th>
                  <th className="text-right">{tr(T.awaitingOwnerShort, lang)}</th>
                  <th className="text-right">{tr(T.overdue, lang)}</th>
                  <th className="text-right">{tr(T.resolved7, lang)}</th>
                  <th className="text-right">{tr(T.avgH, lang)}</th>
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
        {tr(T.myWork, lang)}
      </Link>
      <PageHeader title={tr(T.title, lang)} description={tr(T.description, lang)} />
      <nav className="mb-3 flex flex-wrap gap-1" aria-label={tr(T.sections, lang)}>
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
