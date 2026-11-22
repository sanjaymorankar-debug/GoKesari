/**
 * RBAC v2 Phase 6 — Operations tasks, zones and team (docs/rbac/06-operations.md).
 *
 * Operations Manager: creates tasks for an Operations User, reassigns, cancels or reopens them,
 * gives users franchise zones, and sees the team's workload.
 * Operations User: sees and works only their own tasks (start, note, follow-up date, done).
 *
 * Every change to a task is one row in ops_task_events (append-only). Assigning a task notifies
 * the assignee (in-app + e-mail, STAFF_TASK_ASSIGNED) after the change commits.
 *
 * Nothing here touches shop registration, auto-approval or the onboarding services: an
 * Operations User onboards a shop through the existing /operator flow (operator-limited.ts), and a
 * task only points at the shop.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { formatIst } from "@/lib/franchise";
import { db } from "@/server/db";
import {
  OPS_TASK_KINDS,
  OPS_TASK_PRIORITIES,
  opsTaskEvents,
  opsTasks,
  opsZoneAssignments,
  type OpsTask,
  type OpsTaskAction,
  type OpsTaskEvent,
  type OpsTaskKind,
  type OpsTaskPriority,
  type OpsTaskStatus,
} from "@/server/db/ops-schema";
import { franchiseZones } from "@/server/db/franchise-schema";
import { shops, staffTeamMembers, users } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { notify } from "@/server/services/notifications";
import { denyNotOwn, isOpsManager, requireOps, type OpsActor } from "./access";

/* ------------------------------------------------------------------ team */

export interface OpsTeamMember {
  id: string;
  name: string | null;
  email: string;
  status: string;
  zones: { assignmentId: string; zoneId: string; zoneName: string | null }[];
  openTasks: number;
  overdueTasks: number;
  doneLast7Days: number;
}

/**
 * Whose work a manager sees (brief §11 data scope). ADMIN: everyone (null). Operations Manager: the
 * active members of their own OPERATIONS team (staff_team_members, migration 0172; the manager or an
 * admin adds members). Anyone else: nobody.
 */
export async function managedUserIds(actor: OpsActor): Promise<string[] | null> {
  if (actor.role === "ADMIN") return null;
  if (!isOpsManager(actor)) return [];
  const rows = await db
    .select({ id: staffTeamMembers.memberUserId })
    .from(staffTeamMembers)
    .where(and(eq(staffTeamMembers.team, "OPERATIONS"), eq(staffTeamMembers.managerUserId, actor.id), eq(staffTeamMembers.active, true)));
  return rows.map((r) => r.id);
}

const inScope = (scope: string[] | null, userId: string) => scope === null || scope.includes(userId);

/** Operations Users not yet in any Operations team (a manager can add them to theirs). */
export async function listUnteamedOpsUsers(actor: OpsActor): Promise<{ id: string; name: string | null; email: string }[]> {
  await requireOps(actor, "manage");
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(
      and(
        eq(users.role, "OPERATIONS_USER"),
        eq(users.status, "ACTIVE"),
        isNull(users.deletedAt),
        sql`not exists (select 1 from staff_team_members m where m.member_user_id = ${users.id} and m.team = 'OPERATIONS' and m.active)`,
      ),
    )
    .orderBy(asc(users.name));
}

export async function listOpsTeam(actor: OpsActor): Promise<OpsTeamMember[]> {
  await requireOps(actor, "manage");
  const scope = await managedUserIds(actor);
  if (scope !== null && scope.length === 0) return [];
  const members = await db
    .select({ id: users.id, name: users.name, email: users.email, status: users.status })
    .from(users)
    .where(and(eq(users.role, "OPERATIONS_USER"), isNull(users.deletedAt), scope ? inArray(users.id, scope) : undefined))
    .orderBy(asc(users.name));
  if (members.length === 0) return [];
  const ids = members.map((m) => m.id);
  const [zones, load] = await Promise.all([
    db
      .select({ id: opsZoneAssignments.id, userId: opsZoneAssignments.userId, zoneId: opsZoneAssignments.zoneId, zoneName: franchiseZones.name })
      .from(opsZoneAssignments)
      .leftJoin(franchiseZones, eq(franchiseZones.zoneId, opsZoneAssignments.zoneId))
      .where(and(eq(opsZoneAssignments.active, true), inArray(opsZoneAssignments.userId, ids))),
    db
      .select({
        userId: opsTasks.assigneeUserId,
        open: sql<number>`count(*) filter (where ${opsTasks.status} in ('OPEN','IN_PROGRESS'))::int`,
        overdue: sql<number>`count(*) filter (where ${opsTasks.status} in ('OPEN','IN_PROGRESS') and ${opsTasks.dueAt} < now())::int`,
        done7: sql<number>`count(*) filter (where ${opsTasks.status} = 'DONE' and ${opsTasks.completedAt} >= now() - interval '7 days')::int`,
      })
      .from(opsTasks)
      .where(inArray(opsTasks.assigneeUserId, ids))
      .groupBy(opsTasks.assigneeUserId),
  ]);
  const loadBy = new Map(load.map((l) => [l.userId, l]));
  return members.map((m) => ({
    ...m,
    zones: zones.filter((z) => z.userId === m.id).map((z) => ({ assignmentId: z.id, zoneId: z.zoneId, zoneName: z.zoneName })),
    openTasks: loadBy.get(m.id)?.open ?? 0,
    overdueTasks: loadBy.get(m.id)?.overdue ?? 0,
    doneLast7Days: loadBy.get(m.id)?.done7 ?? 0,
  }));
}

/** The user must be an active Operations User in the actor's team (any, for an admin). */
async function assertOpsUser(actor: OpsActor, userId: string): Promise<{ id: string; name: string | null; email: string }> {
  const [u] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!u || u.deletedAt) throw notFound("Operations User");
  if (u.role !== "OPERATIONS_USER") throw validationFailed("Tasks and zones can be given only to an Operations User.");
  if (u.status !== "ACTIVE") throw validationFailed("This Operations User is not active.");
  if (!inScope(await managedUserIds(actor), userId)) denyNotOwn(actor, "team");
  return u;
}

/* ----------------------------------------------------------------- zones */

export async function listZones(actor: OpsActor): Promise<{ zoneId: string; name: string; region: string; status: string }[]> {
  await requireOps(actor, "manage", "report");
  return db
    .select({ zoneId: franchiseZones.zoneId, name: franchiseZones.name, region: franchiseZones.region, status: franchiseZones.status })
    .from(franchiseZones)
    .where(eq(franchiseZones.isTest, false))
    .orderBy(asc(franchiseZones.region), asc(franchiseZones.name));
}

export async function assignZone(actor: OpsActor, input: { userId: string; zoneId: string; reason?: string | null }): Promise<{ id: string }> {
  await requireOps(actor, "manage");
  await assertOpsUser(actor, input.userId);
  const [zone] = await db.select({ zoneId: franchiseZones.zoneId }).from(franchiseZones).where(eq(franchiseZones.zoneId, input.zoneId));
  if (!zone) throw notFound("Zone");
  const [existing] = await db
    .select({ id: opsZoneAssignments.id })
    .from(opsZoneAssignments)
    .where(and(eq(opsZoneAssignments.userId, input.userId), eq(opsZoneAssignments.zoneId, input.zoneId), eq(opsZoneAssignments.active, true)));
  if (existing) throw conflict("This zone is already assigned to this user.");
  const [row] = await db
    .insert(opsZoneAssignments)
    .values({ userId: input.userId, zoneId: input.zoneId, assignedBy: actor.id, reason: input.reason?.trim() || null })
    .returning({ id: opsZoneAssignments.id });
  return row;
}

/** Ends a zone assignment (kept as history; never deleted). */
export async function endZoneAssignment(actor: OpsActor, assignmentId: string): Promise<void> {
  await requireOps(actor, "manage");
  const [row] = await db.select({ userId: opsZoneAssignments.userId }).from(opsZoneAssignments).where(eq(opsZoneAssignments.id, assignmentId));
  if (!row) throw notFound("Zone assignment");
  if (!inScope(await managedUserIds(actor), row.userId)) denyNotOwn(actor, "team");
  const updated = await db
    .update(opsZoneAssignments)
    .set({ active: false, endedAt: new Date(), endedBy: actor.id })
    .where(and(eq(opsZoneAssignments.id, assignmentId), eq(opsZoneAssignments.active, true)))
    .returning({ id: opsZoneAssignments.id });
  if (updated.length === 0) throw notFound("Zone assignment");
}

/** The zones an Operations User works (their own, or any user's for a manager). */
export async function zonesOf(actor: OpsActor, userId = actor.id): Promise<string[]> {
  await requireOps(actor, "manage", "work");
  if (userId !== actor.id && (!isOpsManager(actor) || !inScope(await managedUserIds(actor), userId))) denyNotOwn(actor, "zones");
  const rows = await db
    .select({ zoneId: opsZoneAssignments.zoneId })
    .from(opsZoneAssignments)
    .where(and(eq(opsZoneAssignments.userId, userId), eq(opsZoneAssignments.active, true)));
  return rows.map((r) => r.zoneId);
}

/* ----------------------------------------------------------------- tasks */

export interface CreateOpsTaskInput {
  kind: OpsTaskKind;
  title: string;
  notes?: string | null;
  priority?: OpsTaskPriority;
  assigneeUserId: string;
  shopId?: string | null;
  customerUserId?: string | null;
  assistId?: string | null;
  zoneId?: string | null;
  dueAt?: Date | null;
}

async function logEvent(
  taskId: string,
  actor: OpsActor,
  action: OpsTaskAction,
  extra: { from?: OpsTaskStatus | null; to?: OpsTaskStatus | null; assignee?: string | null; note?: string | null } = {},
  client: Pick<typeof db, "insert"> = db,
): Promise<void> {
  await client.insert(opsTaskEvents).values({
    taskId,
    action,
    actorId: actor.id,
    actorRole: actor.role,
    fromStatus: extra.from ?? null,
    toStatus: extra.to ?? null,
    assigneeUserId: extra.assignee ?? null,
    note: extra.note?.trim() || null,
  });
}

function notifyAssigned(task: Pick<OpsTask, "id" | "title" | "assigneeUserId" | "dueAt">, actor: OpsActor): Promise<void> {
  return notify({
    userId: task.assigneeUserId,
    type: NOTIFICATION_TYPES.STAFF_TASK_ASSIGNED,
    vars: { title: task.title, assignedBy: actor.name ?? "Your manager", due: task.dueAt ? `, due ${formatIst(task.dueAt)}` : "" },
    actionUrl: `/staff/operations/tasks/${task.id}`,
    metadata: { opsTaskId: task.id },
  });
}

export async function createOpsTask(actor: OpsActor, input: CreateOpsTaskInput): Promise<OpsTask> {
  await requireOps(actor, "manage");
  if (!OPS_TASK_KINDS.includes(input.kind)) throw validationFailed("Unknown task kind.");
  if (input.priority && !OPS_TASK_PRIORITIES.includes(input.priority)) throw validationFailed("Unknown priority.");
  const title = input.title.trim();
  if (title.length < 3) throw validationFailed("Give the task a title.");
  await assertOpsUser(actor, input.assigneeUserId);
  if (input.shopId) {
    const [shop] = await db.select({ id: shops.id }).from(shops).where(eq(shops.id, input.shopId));
    if (!shop) throw notFound("Shop");
  }
  if (input.customerUserId) {
    const [cust] = await db.select({ id: users.id }).from(users).where(eq(users.id, input.customerUserId));
    if (!cust) throw notFound("Customer");
  }
  const task = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(opsTasks)
      .values({
        kind: input.kind,
        title,
        notes: input.notes?.trim() || null,
        priority: input.priority ?? "NORMAL",
        assigneeUserId: input.assigneeUserId,
        createdBy: actor.id,
        shopId: input.shopId ?? null,
        customerUserId: input.customerUserId ?? null,
        assistId: input.assistId ?? null,
        zoneId: input.zoneId ?? null,
        dueAt: input.dueAt ?? null,
      })
      .returning();
    await logEvent(row.id, actor, "CREATE", { to: "OPEN", assignee: row.assigneeUserId, note: row.notes }, tx);
    return row;
  });
  await notifyAssigned(task, actor); // after commit (never inside the transaction)
  return task;
}

async function loadTask(id: string): Promise<OpsTask> {
  const [task] = await db.select().from(opsTasks).where(eq(opsTasks.id, id));
  if (!task) throw notFound("Task");
  return task;
}

/** A user may read only their own task; a manager any. */
async function readableTask(actor: OpsActor, id: string): Promise<OpsTask> {
  await requireOps(actor, "manage", "work");
  const task = await loadTask(id);
  if (task.assigneeUserId === actor.id) return task;
  if (!isOpsManager(actor)) denyNotOwn(actor, "task");
  if (task.createdBy !== actor.id && !inScope(await managedUserIds(actor), task.assigneeUserId)) denyNotOwn(actor, "task");
  return task;
}

export interface OpsTaskView extends OpsTask {
  assigneeName: string | null;
  shopName: string | null;
  overdue: boolean;
}

export async function listOpsTasks(
  actor: OpsActor,
  filter: { status?: "ACTIVE" | "DONE" | "ALL"; assigneeUserId?: string; shopId?: string; limit?: number } = {},
): Promise<OpsTaskView[]> {
  await requireOps(actor, "manage", "work");
  const conds = [];
  if (!isOpsManager(actor)) conds.push(eq(opsTasks.assigneeUserId, actor.id));
  else {
    const scope = await managedUserIds(actor);
    if (scope !== null) conds.push(or(eq(opsTasks.createdBy, actor.id), scope.length ? inArray(opsTasks.assigneeUserId, scope) : sql`false`)!);
    if (filter.assigneeUserId) conds.push(eq(opsTasks.assigneeUserId, filter.assigneeUserId));
  }
  if (filter.shopId) conds.push(eq(opsTasks.shopId, filter.shopId));
  const status = filter.status ?? "ACTIVE";
  if (status === "ACTIVE") conds.push(inArray(opsTasks.status, ["OPEN", "IN_PROGRESS"]));
  if (status === "DONE") conds.push(inArray(opsTasks.status, ["DONE", "CANCELLED"]));
  const rows = await db
    .select({ task: opsTasks, assigneeName: users.name, shopName: shops.name })
    .from(opsTasks)
    .leftJoin(users, eq(users.id, opsTasks.assigneeUserId))
    .leftJoin(shops, eq(shops.id, opsTasks.shopId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(sql`${opsTasks.dueAt} asc nulls last`, desc(opsTasks.createdAt))
    .limit(Math.min(500, filter.limit ?? 200));
  const now = Date.now();
  return rows.map((r) => ({
    ...r.task,
    assigneeName: r.assigneeName,
    shopName: r.shopName,
    overdue: !!r.task.dueAt && r.task.dueAt.getTime() < now && (r.task.status === "OPEN" || r.task.status === "IN_PROGRESS"),
  }));
}

export async function getOpsTaskDetail(actor: OpsActor, id: string): Promise<{ task: OpsTaskView; events: (OpsTaskEvent & { actorName: string | null })[] }> {
  const task = await readableTask(actor, id);
  const [[extra], events] = await Promise.all([
    db
      .select({ assigneeName: users.name, shopName: shops.name })
      .from(opsTasks)
      .leftJoin(users, eq(users.id, opsTasks.assigneeUserId))
      .leftJoin(shops, eq(shops.id, opsTasks.shopId))
      .where(eq(opsTasks.id, id)),
    db
      .select({ event: opsTaskEvents, actorName: users.name })
      .from(opsTaskEvents)
      .leftJoin(users, eq(users.id, opsTaskEvents.actorId))
      .where(eq(opsTaskEvents.taskId, id))
      .orderBy(asc(opsTaskEvents.createdAt)),
  ]);
  const active = task.status === "OPEN" || task.status === "IN_PROGRESS";
  return {
    task: { ...task, assigneeName: extra?.assigneeName ?? null, shopName: extra?.shopName ?? null, overdue: active && !!task.dueAt && task.dueAt.getTime() < Date.now() },
    events: events.map((e) => ({ ...e.event, actorName: e.actorName })),
  };
}

/**
 * For the Support desk (Phase 7, other session): the minimum it needs to link a ticket to a task.
 * No permission check here — the caller (the ticket service) checks its own.
 */
export async function getOpsTask(id: string): Promise<{ id: string; assigneeUserId: string; shopId: string | null } | null> {
  const [t] = await db
    .select({ id: opsTasks.id, assigneeUserId: opsTasks.assigneeUserId, shopId: opsTasks.shopId })
    .from(opsTasks)
    .where(eq(opsTasks.id, id));
  return t ?? null;
}

export async function reassignOpsTask(actor: OpsActor, id: string, input: { assigneeUserId: string; note?: string | null }): Promise<OpsTask> {
  await requireOps(actor, "manage");
  const task = await loadTask(id);
  if (task.status === "DONE" || task.status === "CANCELLED") throw conflict("A finished task cannot be reassigned. Reopen it first.");
  if (task.assigneeUserId === input.assigneeUserId) throw conflict("The task is already assigned to this user.");
  await assertOpsUser(actor, input.assigneeUserId);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(opsTasks)
      .set({ assigneeUserId: input.assigneeUserId, updatedAt: new Date() })
      .where(eq(opsTasks.id, id))
      .returning();
    await logEvent(id, actor, "REASSIGN", { from: task.status, to: task.status, assignee: input.assigneeUserId, note: input.note }, tx);
    return row;
  });
  await notifyAssigned(updated, actor);
  return updated;
}

export type OpsTaskUpdate =
  | { action: "START"; note?: string | null }
  | { action: "NOTE"; note: string }
  | { action: "FOLLOW_UP"; followUpAt: Date; note?: string | null }
  | { action: "DONE"; outcome: string }
  | { action: "CANCEL"; note: string }
  | { action: "REOPEN"; note: string };

/**
 * Works a task. The assignee may START, NOTE, FOLLOW_UP and DONE their own task; only a manager may
 * CANCEL or REOPEN, and a manager may also do everything an assignee may.
 */
export async function updateOpsTask(actor: OpsActor, id: string, update: OpsTaskUpdate): Promise<OpsTask> {
  const task = await readableTask(actor, id);
  const manager = isOpsManager(actor);
  if ((update.action === "CANCEL" || update.action === "REOPEN") && !manager) {
    await requireOps(actor, "manage"); // throws and logs the refusal
  }
  const active = task.status === "OPEN" || task.status === "IN_PROGRESS";
  const now = new Date();
  let set: Partial<OpsTask> = {};
  let to: OpsTaskStatus = task.status;
  switch (update.action) {
    case "START":
      if (task.status !== "OPEN") throw conflict("Only an open task can be started.");
      to = "IN_PROGRESS";
      set = { status: to };
      break;
    case "NOTE":
      if (!update.note?.trim()) throw validationFailed("Write the note.");
      break;
    case "FOLLOW_UP":
      if (!active) throw conflict("This task is finished.");
      if (!(update.followUpAt instanceof Date) || Number.isNaN(update.followUpAt.getTime())) throw validationFailed("Pick a follow-up date.");
      set = { followUpAt: update.followUpAt };
      if (task.status === "OPEN") {
        to = "IN_PROGRESS";
        set.status = to;
      }
      break;
    case "DONE":
      if (!active) throw conflict("This task is already finished.");
      if (!update.outcome?.trim()) throw validationFailed("Say what was done.");
      to = "DONE";
      set = { status: to, completedAt: now, outcome: update.outcome.trim(), followUpAt: null };
      break;
    case "CANCEL":
      if (!active) throw conflict("This task is already finished.");
      if (!update.note?.trim()) throw validationFailed("Give a reason for cancelling.");
      to = "CANCELLED";
      set = { status: to, completedAt: now };
      break;
    case "REOPEN":
      if (active) throw conflict("This task is still open.");
      if (!update.note?.trim()) throw validationFailed("Give a reason for reopening.");
      to = "OPEN";
      set = { status: to, completedAt: null, outcome: null };
      break;
  }
  const note =
    update.action === "DONE" ? update.outcome : update.action === "FOLLOW_UP" ? [`Follow up ${formatIst(update.followUpAt)}`, update.note].filter(Boolean).join(" — ") : update.note;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(opsTasks)
      .set({ ...set, updatedAt: now })
      .where(and(eq(opsTasks.id, id), eq(opsTasks.status, task.status))) // no lost update
      .returning();
    if (!row) throw conflict("The task changed meanwhile. Reload and try again.");
    await logEvent(id, actor, update.action, { from: task.status, to, note }, tx);
    return row;
  });
}

/* ----------------------------------------------------------- my dashboard */

export interface OpsUserDashboard {
  tasks: { open: number; inProgress: number; overdue: number; dueToday: number; followUpsDue: number; doneToday: number };
  today: OpsTaskView[];
  shops: { onboarded: number; live: number; pending: number; awaitingDocuments: number; awaitingPayment: number; rejected: number };
  customers: { enquiries: number; invited: number; registered: number; profileComplete: number; dropped: number };
  zones: string[];
}

const IST_TODAY = sql`(now() at time zone 'Asia/Kolkata')::date`;

/** The Operations User's one-screen day: own tasks, own onboarded shops, own customer assists. */
export async function getOpsUserDashboard(actor: OpsActor): Promise<OpsUserDashboard> {
  await requireOps(actor, "work");
  const [[t], [s], [c], zones, open] = await Promise.all([
    db
      .select({
        open: sql<number>`count(*) filter (where ${opsTasks.status} = 'OPEN')::int`,
        inProgress: sql<number>`count(*) filter (where ${opsTasks.status} = 'IN_PROGRESS')::int`,
        overdue: sql<number>`count(*) filter (where ${opsTasks.status} in ('OPEN','IN_PROGRESS') and ${opsTasks.dueAt} < now())::int`,
        dueToday: sql<number>`count(*) filter (where ${opsTasks.status} in ('OPEN','IN_PROGRESS') and (${opsTasks.dueAt} at time zone 'Asia/Kolkata')::date = ${IST_TODAY})::int`,
        followUpsDue: sql<number>`count(*) filter (where ${opsTasks.status} in ('OPEN','IN_PROGRESS') and (${opsTasks.followUpAt} at time zone 'Asia/Kolkata')::date <= ${IST_TODAY})::int`,
        doneToday: sql<number>`count(*) filter (where ${opsTasks.status} = 'DONE' and (${opsTasks.completedAt} at time zone 'Asia/Kolkata')::date = ${IST_TODAY})::int`,
      })
      .from(opsTasks)
      .where(eq(opsTasks.assigneeUserId, actor.id)),
    db
      .select({
        onboarded: sql<number>`count(*)::int`,
        live: sql<number>`count(*) filter (where ${shops.status} = 'APPROVED')::int`,
        pending: sql<number>`count(*) filter (where ${shops.status} = 'PENDING_APPROVAL')::int`,
        awaitingDocuments: sql<number>`count(*) filter (where ${shops.status} = 'PENDING_APPROVAL' and ${shops.lifecycleStatus} = 'KYC_PENDING')::int`,
        awaitingPayment: sql<number>`count(*) filter (where ${shops.status} = 'PENDING_APPROVAL' and ${shops.lifecycleStatus} = 'PAYMENT_PENDING')::int`,
        rejected: sql<number>`count(*) filter (where ${shops.status} = 'REJECTED')::int`,
      })
      .from(shops)
      .where(and(eq(shops.onboardedByUserId, actor.id), isNull(shops.deletedAt))),
    db.execute(sql`
      select count(*) filter (where status = 'ENQUIRY')::int as enquiries,
             count(*) filter (where status = 'INVITED')::int as invited,
             count(*) filter (where status = 'REGISTERED')::int as registered,
             count(*) filter (where status = 'PROFILE_COMPLETE')::int as profile_complete,
             count(*) filter (where status = 'DROPPED')::int as dropped
      from ops_customer_assists where ops_user_id = ${actor.id}`) as unknown as Promise<Record<string, number>[]>,
    zonesOf(actor),
    listOpsTasks(actor, { status: "ACTIVE", limit: 50 }),
  ]);
  const todayIst = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const istDay = (d: Date | null) => (d ? new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) : null);
  const today = open.filter((x) => x.overdue || (istDay(x.dueAt) ?? "9999") <= todayIst || (istDay(x.followUpAt) ?? "9999") <= todayIst);
  return {
    tasks: t,
    today,
    shops: s,
    customers: {
      enquiries: Number(c?.enquiries ?? 0),
      invited: Number(c?.invited ?? 0),
      registered: Number(c?.registered ?? 0),
      profileComplete: Number(c?.profile_complete ?? 0),
      dropped: Number(c?.dropped ?? 0),
    },
    zones,
  };
}

/** Shops an Operations User onboarded (via /operator), for picking a shop on a task. Manager: any shop by name. */
export async function searchShopsForOps(actor: OpsActor, q: string): Promise<{ id: string; name: string; status: string; pincode: string }[]> {
  await requireOps(actor, "manage", "work");
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
  const scope = isOpsManager(actor) ? undefined : eq(shops.onboardedByUserId, actor.id);
  return db
    .select({ id: shops.id, name: shops.name, status: shops.status, pincode: shops.pincode })
    .from(shops)
    .where(and(isNull(shops.deletedAt), or(sql`${shops.name} ilike ${like}`, sql`${shops.pincode} = ${term}`), scope))
    .orderBy(asc(shops.name))
    .limit(20);
}

