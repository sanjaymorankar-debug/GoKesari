/**
 * RBAC v2 Phase 6 — Operations (docs/rbac/06-operations.md): the flag gate, backend permission
 * boundaries and data scope, tasks (create, work, follow-up, done, cancel, reopen, reassign) with
 * an append-only history, zones, customer assists linked to the accounts customers open themselves,
 * the Operations User dashboard, the onboarding monitors and the day / week activity report and its
 * Excel export.
 */
import ExcelJS from "exceljs";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { opsTaskEvents } from "@/server/db/ops-schema";
import { auditLogs, featureFlags, notifications, shops, staffTeamMembers, users, type UserRole } from "@/server/db/schema";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import {
  assignZone,
  buildOpsReportWorkbook,
  createCustomerAssist,
  createOpsTask,
  endZoneAssignment,
  getCustomerOnboardingMonitor,
  getOpsActivityReport,
  getOpsTask,
  getOpsTaskDetail,
  getOpsUserDashboard,
  getShopOnboardingMonitor,
  istPeriod,
  listCustomerAssists,
  listOpsTasks,
  listOpsTeam,
  listUnteamedOpsUsers,
  reassignOpsTask,
  updateCustomerAssist,
  updateOpsTask,
  zonesOf,
  type OpsActor,
} from "@/server/rbac-operations";
import { createShop, createUser, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";

vi.mock("@/server/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("@/server/auth", () => ({ auth: async () => null, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

const ZONE = "GKZ-PUN-03"; // seeded by 0157; pincode 411005 is one of its areas

async function setFlag(enabled: boolean, roleScope: UserRole[] | null = null) {
  await db
    .insert(featureFlags)
    .values({ key: "rbac_v2_operations", enabled, roleScope })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled, roleScope } });
  clearFeatureFlagCache();
}

const actor = (u: { id: string; role: UserRole; name: string | null }): OpsActor => ({ id: u.id, role: u.role, name: u.name });

let manager: OpsActor;
let opsA: OpsActor;
let opsB: OpsActor;
let admin: OpsActor;

beforeEach(async () => {
  await resetDatabase();
  // Not referenced by any FK, so resetDatabase's TRUNCATE … CASCADE leaves them: clear them here.
  await db.execute(sql`TRUNCATE ops_task_events, ops_tasks, ops_zone_assignments, ops_customer_assists`);
  await setFlag(true);
  manager = actor(await createUser({ role: "OPERATIONS_MANAGER", name: "Meera Manager" }));
  opsA = actor(await createUser({ role: "OPERATIONS_USER", name: "Arun Ops" }));
  opsB = actor(await createUser({ role: "OPERATIONS_USER", name: "Bina Ops" }));
  admin = actor(await createUser({ role: "ADMIN", name: "Admin" }));
  await joinTeam(manager, opsA);
  await joinTeam(manager, opsB);
});

async function joinTeam(mgr: OpsActor, member: OpsActor) {
  await db.insert(staffTeamMembers).values({ team: "OPERATIONS", managerUserId: mgr.id, memberUserId: member.id, addedBy: mgr.id });
}

describe("flag and permission boundaries", () => {
  it("is not available to anyone while rbac_v2_operations is off", async () => {
    await setFlag(false);
    await expect(listOpsTeam(manager)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getOpsUserDashboard(opsA)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getShopOnboardingMonitor(admin)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("honours the flag's role scope", async () => {
    await setFlag(true, ["OPERATIONS_MANAGER"]);
    await expect(listOpsTeam(manager)).resolves.toBeDefined();
    await expect(getOpsUserDashboard(opsA)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses other roles and logs every refusal", async () => {
    const customer = actor(await createUser({ role: "CUSTOMER" }));
    const support = actor(await createUser({ role: "SUPPORT_USER" }));
    const accountant = actor(await createUser({ role: "ACCOUNTANT" }));
    for (const who of [customer, support, accountant]) {
      await expect(listOpsTeam(who)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(getShopOnboardingMonitor(who)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(createCustomerAssist(who, { customerName: "X Y", contactEmail: "x@test.local" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    // An Operations User cannot manage, report or assign.
    await expect(createOpsTask(opsA, { kind: "OTHER", title: "Self task", assigneeUserId: opsA.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assignZone(opsA, { userId: opsA.id, zoneId: ZONE })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getOpsActivityReport(opsA)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listOpsTeam(opsA)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // An Operations Manager does not work tasks as an assignee or see Operations User screens.
    await expect(getOpsUserDashboard(manager)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await new Promise((r) => setTimeout(r, 50)); // logDenied writes after the refusal
    const denied = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "authz.denied"), eq(auditLogs.actorId, opsA.id)));
    expect(denied.length).toBeGreaterThanOrEqual(4);
  });
});

describe("tasks", () => {
  it("lets a manager assign a task, notifies the assignee and records the history", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", name: "Kesari Kirana" });
    const task = await createOpsTask(manager, {
      kind: "SHOP_ONBOARDING",
      title: "Visit Kesari Kirana",
      assigneeUserId: opsA.id,
      shopId: shop.id,
      priority: "HIGH",
      dueAt: new Date(Date.now() + 86400_000),
    });
    expect(task.status).toBe("OPEN");
    const [note] = await db.select().from(notifications).where(eq(notifications.userId, opsA.id));
    expect(note?.type).toBe("staff.task_assigned");
    expect(note?.title).toContain("Visit Kesari Kirana");
    expect(await getOpsTask(task.id)).toEqual({ id: task.id, assigneeUserId: opsA.id, shopId: shop.id });
    const detail = await getOpsTaskDetail(opsA, task.id);
    expect(detail.task.shopName).toBe("Kesari Kirana");
    expect(detail.events.map((e) => e.action)).toEqual(["CREATE"]);
  });

  it("only gives tasks to active Operations Users and to existing shops", async () => {
    const support = await createUser({ role: "SUPPORT_USER" });
    await expect(createOpsTask(manager, { kind: "OTHER", title: "Wrong person", assigneeUserId: support.id })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      createOpsTask(manager, { kind: "OTHER", title: "No such shop", assigneeUserId: opsA.id, shopId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lets the assignee work their own task through to done", async () => {
    const task = await createOpsTask(manager, { kind: "FOLLOW_UP", title: "Call back about documents", assigneeUserId: opsA.id });
    await updateOpsTask(opsA, task.id, { action: "START" });
    await updateOpsTask(opsA, task.id, { action: "FOLLOW_UP", followUpAt: new Date(Date.now() + 3600_000), note: "Owner busy" });
    await updateOpsTask(opsA, task.id, { action: "NOTE", note: "GST copy promised" });
    await expect(updateOpsTask(opsA, task.id, { action: "DONE", outcome: " " })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const done = await updateOpsTask(opsA, task.id, { action: "DONE", outcome: "Documents uploaded" });
    expect(done.status).toBe("DONE");
    expect(done.completedAt).toBeInstanceOf(Date);
    const { events } = await getOpsTaskDetail(manager, task.id);
    expect(events.map((e) => e.action)).toEqual(["CREATE", "START", "FOLLOW_UP", "NOTE", "DONE"]);
  });

  it("keeps each Operations User to their own tasks", async () => {
    const task = await createOpsTask(manager, { kind: "OTHER", title: "For Arun only", assigneeUserId: opsA.id });
    await expect(getOpsTaskDetail(opsB, task.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateOpsTask(opsB, task.id, { action: "START" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listOpsTasks(opsB)).length).toBe(0);
    expect((await listOpsTasks(opsA)).map((t) => t.id)).toEqual([task.id]);
    expect((await listOpsTasks(manager)).map((t) => t.id)).toEqual([task.id]);
  });

  it("lets only a manager cancel and reopen", async () => {
    const task = await createOpsTask(manager, { kind: "OTHER", title: "Cancel me", assigneeUserId: opsA.id });
    await expect(updateOpsTask(opsA, task.id, { action: "CANCEL", note: "No" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateOpsTask(manager, task.id, { action: "CANCEL", note: "" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await updateOpsTask(manager, task.id, { action: "CANCEL", note: "Shop closed" })).status).toBe("CANCELLED");
    await expect(updateOpsTask(opsA, task.id, { action: "REOPEN", note: "Back" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await updateOpsTask(manager, task.id, { action: "REOPEN", note: "Shop reopened" })).status).toBe("OPEN");
  });

  it("reassigns, notifies the new assignee and moves the scope with it", async () => {
    const task = await createOpsTask(manager, { kind: "OTHER", title: "Hand over", assigneeUserId: opsA.id });
    await expect(reassignOpsTask(manager, task.id, { assigneeUserId: opsA.id })).rejects.toMatchObject({ code: "CONFLICT" });
    await reassignOpsTask(manager, task.id, { assigneeUserId: opsB.id, note: "Arun on leave" });
    await expect(getOpsTaskDetail(opsA, task.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await getOpsTaskDetail(opsB, task.id)).events.at(-1)?.action).toBe("REASSIGN");
    const toB = await db.select().from(notifications).where(eq(notifications.userId, opsB.id));
    expect(toB.length).toBe(1);
  });

  it("keeps the task history append-only", async () => {
    const task = await createOpsTask(manager, { kind: "OTHER", title: "History", assigneeUserId: opsA.id });
    const why = (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? e);
    const upd = await db.update(opsTaskEvents).set({ note: "rewritten" }).where(eq(opsTaskEvents.taskId, task.id)).catch(why);
    const del = await db.delete(opsTaskEvents).where(eq(opsTaskEvents.taskId, task.id)).catch(why);
    expect(upd).toMatch(/append-only/);
    expect(del).toMatch(/append-only/);
  });
});

describe("team scope (staff_team_members)", () => {
  it("keeps an Operations Manager to their own team; an admin sees everyone", async () => {
    const other = actor(await createUser({ role: "OPERATIONS_MANAGER", name: "Other Manager" }));
    const opsC = actor(await createUser({ role: "OPERATIONS_USER", name: "Chetan Ops" }));
    await joinTeam(other, opsC);
    const theirs = await createOpsTask(other, { kind: "OTHER", title: "Other team's task", assigneeUserId: opsC.id });
    const mine = await createOpsTask(manager, { kind: "OTHER", title: "My team's task", assigneeUserId: opsA.id });
    // Not across teams: assign, read, cancel, zones, assists, team list, activity report.
    await expect(createOpsTask(manager, { kind: "OTHER", title: "Poach", assigneeUserId: opsC.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getOpsTaskDetail(manager, theirs.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateOpsTask(manager, theirs.id, { action: "CANCEL", note: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(reassignOpsTask(manager, mine.id, { assigneeUserId: opsC.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assignZone(manager, { userId: opsC.id, zoneId: ZONE })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const cAssist = await createCustomerAssist(opsC, { customerName: "C's customer", contactEmail: "c1@test.local" });
    await expect(updateCustomerAssist(manager, cAssist.id, { status: "DROPPED" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listCustomerAssists(manager)).map((a) => a.id)).not.toContain(cAssist.id);
    expect((await listOpsTasks(manager, { status: "ALL" })).map((t) => t.id)).toEqual([mine.id]);
    expect((await listOpsTeam(manager)).map((m) => m.id).sort()).toEqual([opsA.id, opsB.id].sort());
    expect((await getOpsActivityReport(manager)).byUser.map((r) => r.key)).not.toContain(opsC.id);
    // The admin sees and acts across teams.
    expect((await listOpsTasks(admin, { status: "ALL" })).length).toBe(2);
    expect((await listOpsTeam(admin)).length).toBe(3);
    await updateOpsTask(admin, theirs.id, { action: "CANCEL", note: "Admin tidy-up" });
  });

  it("lists Operations Users not yet in a team, and a manager with no team sees nobody", async () => {
    const loner = await createUser({ role: "OPERATIONS_USER", name: "New Joiner" });
    const fresh = actor(await createUser({ role: "OPERATIONS_MANAGER", name: "Fresh Manager" }));
    expect((await listUnteamedOpsUsers(fresh)).map((u) => u.id)).toEqual([loner.id]);
    expect(await listOpsTeam(fresh)).toEqual([]);
    expect(await listOpsTasks(fresh)).toEqual([]);
  });
});

describe("team and zones", () => {
  it("assigns, lists and ends zones, keeping the history", async () => {
    const z = await assignZone(manager, { userId: opsA.id, zoneId: ZONE, reason: "Kothrud beat" });
    await expect(assignZone(manager, { userId: opsA.id, zoneId: ZONE })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(assignZone(manager, { userId: opsA.id, zoneId: "NO-SUCH-ZONE" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(assignZone(manager, { userId: manager.id, zoneId: ZONE })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await zonesOf(opsA)).toEqual([ZONE]);
    await expect(zonesOf(opsB, opsA.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const team = await listOpsTeam(manager);
    expect(team.find((m) => m.id === opsA.id)?.zones.map((x) => x.zoneId)).toEqual([ZONE]);
    await endZoneAssignment(manager, z.id);
    expect(await zonesOf(opsA)).toEqual([]);
    await assignZone(manager, { userId: opsA.id, zoneId: ZONE }); // can be given again
    const rows = (await db.execute(sql`select count(*)::int as n from ops_zone_assignments where user_id = ${opsA.id}`)) as unknown as { n: number }[];
    expect(rows[0].n).toBe(2);
  });

  it("shows each member's workload", async () => {
    await createOpsTask(manager, { kind: "OTHER", title: "Late one", assigneeUserId: opsA.id, dueAt: new Date(Date.now() - 3600_000) });
    const t2 = await createOpsTask(manager, { kind: "OTHER", title: "Finished", assigneeUserId: opsA.id });
    await updateOpsTask(opsA, t2.id, { action: "DONE", outcome: "ok" });
    const a = (await listOpsTeam(manager)).find((m) => m.id === opsA.id)!;
    expect([a.openTasks, a.overdueTasks, a.doneLast7Days]).toEqual([1, 1, 1]);
  });
});

describe("customer assists", () => {
  it("links an assist to the account the customer opens afterwards, by e-mail or mobile", async () => {
    const byEmail = await createCustomerAssist(opsA, { customerName: "Sita Rao", contactEmail: "Sita.Rao@Test.Local", pincode: "411005" });
    expect(byEmail.zoneId).toBe(ZONE);
    const byPhone = await createCustomerAssist(opsA, { customerName: "Ravi K", contactPhone: "+91 98765 43210" });
    expect(byPhone.contactPhone).toBe("9876543210");
    await updateCustomerAssist(opsA, byEmail.id, { status: "INVITED" });
    // The customers sign up themselves (their own e-mailed code) after the assist was recorded.
    const sita = await createUser({ email: "sita.rao@test.local", role: "CUSTOMER" });
    await createUser({ role: "CUSTOMER", mobile: "9876543210" });
    const list = await listCustomerAssists(opsA);
    const s = list.find((x) => x.id === byEmail.id)!;
    expect(s.status).toBe("REGISTERED");
    expect(s.customerUserId).toBe(sita.id);
    expect(list.find((x) => x.id === byPhone.id)?.status).toBe("REGISTERED");
    await db.update(users).set({ profileCompletedAt: new Date() }).where(eq(users.id, sita.id));
    expect((await listCustomerAssists(opsA)).find((x) => x.id === byEmail.id)?.status).toBe("PROFILE_COMPLETE");
    await expect(updateCustomerAssist(opsA, byEmail.id, { status: "DROPPED" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("does not claim a customer who already had an account", async () => {
    await createUser({ email: "old@test.local", role: "CUSTOMER" });
    const a = await createCustomerAssist(opsA, { customerName: "Old Customer", contactEmail: "old@test.local" });
    await db.execute(sql`update users set created_at = now() - interval '2 days' where email = 'old@test.local'`);
    expect((await listCustomerAssists(opsA)).find((x) => x.id === a.id)?.status).toBe("ENQUIRY");
  });

  it("validates the contact details and keeps assists to their owner", async () => {
    await expect(createCustomerAssist(opsA, { customerName: "No Contact" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createCustomerAssist(opsA, { customerName: "Bad", contactEmail: "nope" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createCustomerAssist(opsA, { customerName: "Bad", contactPhone: "123" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createCustomerAssist(opsA, { customerName: "Bad", contactEmail: "a@b.co", pincode: "12" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const a = await createCustomerAssist(opsA, { customerName: "Mine", contactEmail: "mine@test.local" });
    await expect(updateCustomerAssist(opsB, a.id, { status: "DROPPED" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listCustomerAssists(opsB)).length).toBe(0);
    expect((await listCustomerAssists(manager)).length).toBe(1);
  });
});

/* ------------------------------------------------------------- reporting */

async function seedShops() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  // Created in their final status (the lifecycle trigger refuses jumps), then the report columns set.
  type Status = "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "SUSPENDED";
  const mk = async (name: string, status: Status, set: Partial<typeof shops.$inferInsert> = {}) => {
    const shop = await createShop(owner.id, { name, status });
    if (Object.keys(set).length) await db.update(shops).set(set).where(eq(shops.id, shop.id));
    return shop;
  };
  const auto = await mk("Auto Shop", "APPROVED", { approvedAt: new Date(), autoApprovedAt: new Date(), onboardedByUserId: opsA.id });
  const manual = await mk("Manual Shop", "APPROVED", { approvedAt: new Date() });
  const pending = await mk("Pending Shop", "PENDING_APPROVAL", { onboardedByUserId: opsA.id });
  const verifying = await mk("Verifying Shop", "PENDING_APPROVAL");
  // Documents verified and fee paid: the shops trigger derives VERIFIED (waiting for a decision).
  await verifySellerDocuments(verifying.id);
  await db.execute(sql`update shops set fee_payment_status = 'PAID' where id = ${verifying.id}`);
  await mk("Rejected Shop", "REJECTED");
  await mk("Suspended Shop", "SUSPENDED", { approvedAt: new Date() });
  // Zone of the auto-approved shop, and a dealer with a team lead and an agent behind the manual one.
  const [area] = (await db.execute(sql`select id from franchise_areas where zone_id = ${ZONE} limit 1`)) as unknown as { id: string }[];
  await db.execute(sql`insert into franchise_shop_area_periods (shop_id, area_id, zone_id, source) values (${auto.id}, ${area.id}, ${ZONE}, 'BACKFILL')`);
  const [dealer] = (await db.execute(sql`
    insert into dealers (legal_name, contact_name, dealer_type, status) values ('Shivneri Traders', 'Shiv', 'PROPRIETORSHIP', 'APPROVED') returning id`)) as unknown as { id: string }[];
  const [lead] = (await db.execute(sql`
    insert into dealer_salespeople (dealer_id, employee_id, name, team_role) values (${dealer.id}, 'TL1', 'Lata Lead', 'TEAM_LEAD') returning id`)) as unknown as { id: string }[];
  const [agent] = (await db.execute(sql`
    insert into dealer_salespeople (dealer_id, employee_id, name, team_role, parent_id, parent_depth, parent_role, depth)
    values (${dealer.id}, 'AG1', 'Amit Agent', 'AGENT', ${lead.id}, 2, 'TEAM_LEAD', 3) returning id`)) as unknown as { id: string }[];
  await db.execute(sql`insert into shop_attributions (shop_id, dealer_id, salesperson_id, source) values (${manual.id}, ${dealer.id}, ${agent.id}, 'DEALER_ASSISTED')`);
  return { auto, manual, pending };
}

describe("Operations Manager monitoring", () => {
  it("counts shops by status and breaks them down by zone, dealer, team lead and agent", async () => {
    await seedShops();
    const m = await getShopOnboardingMonitor(manager, { days: 7 });
    expect(m.totals).toMatchObject({
      total: 6,
      new: 6,
      pending: 1,
      underVerification: 1,
      autoApproved: 1,
      manuallyApproved: 2, // the manual one and the suspended one (approved by a person earlier)
      rejected: 1,
      active: 2,
      inactive: 1,
    });
    expect(m.byZone.find((r) => r.key === ZONE)?.counts.autoApproved).toBe(1);
    expect(m.byDealer.find((r) => r.label === "Shivneri Traders")?.counts.manuallyApproved).toBe(1);
    expect(m.byTeamLead.find((r) => r.label === "Lata Lead")?.counts.total).toBe(1);
    expect(m.byAgent.find((r) => r.label === "Amit Agent")?.counts.total).toBe(1);
    expect(m.daily).toHaveLength(14);
    expect(m.daily.at(-1)?.registered).toBe(6);
    expect(m.weekly).toHaveLength(8);
  });

  it("counts customers by source", async () => {
    await createUser({ role: "CUSTOMER" });
    await createCustomerAssist(opsA, { customerName: "Assisted One", contactEmail: "assisted@test.local" });
    await createUser({ role: "CUSTOMER", email: "assisted@test.local" });
    const c = await getCustomerOnboardingMonitor(manager);
    expect(c.total).toBe(2);
    expect(c.newToday).toBe(2);
    expect(c.bySource.find((s) => s.source === "OPERATIONS")?.total).toBe(1);
    expect(c.bySource.find((s) => s.source === "DIRECT")?.total).toBe(1);
    expect(c.inactive).toBe(2);
  });

  it("reports the day per Operations User and per zone, and exports it to Excel", async () => {
    await seedShops();
    await assignZone(manager, { userId: opsA.id, zoneId: ZONE });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "Visited Shop" });
    const task = await createOpsTask(manager, { kind: "SHOP_ONBOARDING", title: "Visit", assigneeUserId: opsA.id, shopId: shop.id });
    await updateOpsTask(opsA, task.id, { action: "FOLLOW_UP", followUpAt: new Date(Date.now() + 3600_000) });
    await updateOpsTask(opsA, task.id, { action: "DONE", outcome: "Registered" });
    const r = await getOpsActivityReport(manager, { period: "day" });
    const a = r.byUser.find((x) => x.key === opsA.id)!;
    expect(a).toMatchObject({ shopsContacted: 1, shopsRegistered: 2, shopsActivated: 1, followUps: 1, tasksDone: 1, pendingRegistrations: 1 });
    expect(r.byZone.find((z) => z.key === ZONE)?.shopsRegistered).toBe(2);
    expect(r.totals.tasksDone).toBe(1);

    const { filename, buffer } = await buildOpsReportWorkbook(manager, { period: "week" });
    expect(filename).toMatch(/^gokesari-operations-week-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(
      expect.arrayContaining(["Activity by user", "Activity by zone", "Shops by zone", "Shops by dealer", "Shops by team lead", "Shops by agent", "Customers"]),
    );
  });

  it("works out IST days and Monday-to-Sunday weeks", () => {
    expect(istPeriod("day", "2026-11-22")).toEqual({ from: "2026-11-22", to: "2026-11-22" });
    expect(istPeriod("week", "2026-11-22")).toEqual({ from: "2026-11-16", to: "2026-11-22" }); // a Sunday
    expect(istPeriod("week", "2026-11-23")).toEqual({ from: "2026-11-23", to: "2026-11-29" });
  });
});

describe("Operations User dashboard", () => {
  it("shows only the user's own tasks, shops and customers", async () => {
    await seedShops();
    await createOpsTask(manager, { kind: "OTHER", title: "Overdue", assigneeUserId: opsA.id, dueAt: new Date(Date.now() - 3600_000) });
    await createOpsTask(manager, { kind: "OTHER", title: "Not mine", assigneeUserId: opsB.id });
    await createCustomerAssist(opsA, { customerName: "Enquiry One", contactEmail: "e1@test.local" });
    const d = await getOpsUserDashboard(opsA);
    expect(d.tasks).toMatchObject({ open: 1, overdue: 1 });
    expect(d.today.map((t) => t.title)).toEqual(["Overdue"]);
    expect(d.shops).toMatchObject({ onboarded: 2, live: 1, pending: 1, awaitingDocuments: 1 });
    expect(d.customers.enquiries).toBe(1);
    const b = await getOpsUserDashboard(opsB);
    expect(b.shops.onboarded).toBe(0);
    expect(b.customers.enquiries).toBe(0);
  });
});
