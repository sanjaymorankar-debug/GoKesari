import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { TaskActions } from "@/components/staff/operations-desk";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { L, tr, type Text } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";
import { AppError } from "@/lib/errors";
import { formatIst } from "@/lib/franchise";
import { getCurrentUser } from "@/server/authz/guards";
import { getOpsTaskDetail, isOpsManager, listOpsTeam } from "@/server/rbac-operations";
import { isFeatureEnabledForRole } from "@/server/services/feature-flags";

export const metadata = { title: "Operations task" };
export const dynamic = "force-dynamic";

const ACTION: Record<string, Text> = {
  CREATE: L("Created", "बनाया गया", "तयार केले"),
  ASSIGN: L("Assigned", "सौंपा गया", "सोपवले"),
  REASSIGN: L("Reassigned", "फिर से सौंपा गया", "पुन्हा सोपवले"),
  START: L("Started", "शुरू हुआ", "सुरू केले"),
  FOLLOW_UP: L("Follow-up set", "फ़ॉलो-अप तय", "फॉलो-अप ठरवला"),
  NOTE: L("Note", "नोट", "टीप"),
  DONE: L("Done", "पूरा", "पूर्ण"),
  CANCEL: L("Cancelled", "रद्द", "रद्द"),
  REOPEN: L("Reopened", "फिर से खोला", "पुन्हा उघडले"),
};

/** Module 6: Hindi / Marathi (English unchanged). */
const T = {
  tasks: L("← Tasks", "← काम", "← कामे"),
  overdue: L("Overdue", "देर से", "मुदत उलटली"),
  assignedTo: L("Assigned to: {name}", "किसे सौंपा: {name}", "कोणाला सोपवले: {name}"),
  shop: L("Shop: {name}", "दुकान: {name}", "दुकान: {name}"),
  zone: L("Zone: {name}", "ज़ोन: {name}", "झोन: {name}"),
  due: L("Due: {date}", "अंतिम तारीख: {date}", "अंतिम तारीख: {date}"),
  followUp: L("Follow up: {date}", "फ़ॉलो-अप: {date}", "फॉलो-अप: {date}"),
  notes: L("Notes: {text}", "नोट्स: {text}", "टिपा: {text}"),
  outcome: L("Outcome: {text}", "नतीजा: {text}", "निकाल: {text}"),
  history: L("History", "इतिहास", "इतिहास"),
} as const;

/** RBAC v2 Phase 6: one Operations task, its history and what the viewer may do with it. */
export default async function OpsTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!(await isFeatureEnabledForRole("rbac_v2_operations", user.role))) redirect("/staff");
  const { id } = await params;
  const lang = await getBoardLang();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let detail;
  try {
    detail = await getOpsTaskDetail(user, id);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    if (error instanceof AppError && error.code === "FORBIDDEN") redirect("/staff/operations");
    throw error;
  }
  const { task, events } = detail;
  const manager = isOpsManager(user);
  const [team, supportEnabled] = await Promise.all([
    manager ? listOpsTeam(user) : Promise.resolve([]),
    isFeatureEnabledForRole("rbac_v2_support", user.role),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/staff/operations?tab=tasks" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        {tr(T.tasks, lang)}
      </Link>
      <PageHeader title={task.title} />
      <Card className="mb-3 grid gap-1 p-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Badge tone={task.status === "DONE" ? "success" : task.status === "CANCELLED" ? "warning" : "info"}>{task.status.replace("_", " ")}</Badge>
          <Badge tone={task.priority === "URGENT" ? "danger" : task.priority === "HIGH" ? "warning" : "neutral"}>{task.priority}</Badge>
          {task.overdue ? <Badge tone="danger">{tr(T.overdue, lang)}</Badge> : null}
        </div>
        <p>{tr(T.assignedTo, lang).replace("{name}", task.assigneeName ?? "—")}</p>
        {task.shopName ? <p>{tr(T.shop, lang).replace("{name}", task.shopName)}</p> : null}
        {task.zoneId ? <p>{tr(T.zone, lang).replace("{name}", String(task.zoneId))}</p> : null}
        {task.dueAt ? <p>{tr(T.due, lang).replace("{date}", formatIst(task.dueAt))}</p> : null}
        {task.followUpAt ? <p>{tr(T.followUp, lang).replace("{date}", formatIst(task.followUpAt))}</p> : null}
        {task.notes ? <p className="whitespace-pre-wrap">{tr(T.notes, lang).replace("{text}", task.notes)}</p> : null}
        {task.outcome ? <Alert tone="success">{tr(T.outcome, lang).replace("{text}", task.outcome)}</Alert> : null}
      </Card>
      <TaskActions
        taskId={task.id}
        status={task.status}
        isManager={manager}
        isAssignee={task.assigneeUserId === user.id}
        people={team.filter((m) => m.status === "ACTIVE").map((m) => ({ id: m.id, name: m.name ?? m.email }))}
        assigneeUserId={task.assigneeUserId}
        shopId={task.shopId}
        supportEnabled={supportEnabled}
      />
      <h2 className="mb-1 mt-4 font-semibold">{tr(T.history, lang)}</h2>
      <ol className="grid gap-1 text-sm">
        {events.map((e) => (
          <li key={e.id} className="border-l-2 border-cream-300 pl-2">
            <span className="font-medium">{ACTION[e.action] ? tr(ACTION[e.action], lang) : e.action}</span> · {e.actorName ?? "—"} · {formatIst(e.createdAt)}
            {e.note ? <span className="block text-ink-700">{e.note}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
