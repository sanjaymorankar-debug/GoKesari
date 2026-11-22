/**
 * RBAC v2 Phase 6 — Operations (docs/rbac/06-operations.md; drizzle/0174_rbac_v2_operations.sql).
 *
 *   ops_zone_assignments   which Operations User works which franchise zone (ended, never deleted)
 *   ops_tasks              onboarding / follow-up tasks an Operations Manager assigns
 *   ops_task_events        every change to a task, append-only (DB trigger)
 *   ops_customer_assists   a customer an Operations User is helping to register
 *
 * Users, shops and zones are not referenced by foreign key (the service checks those links).
 * Imported directly by src/server/rbac-operations (not re-exported by schema.ts).
 */
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const OPS_TASK_KINDS = ["SHOP_ONBOARDING", "CUSTOMER_ONBOARDING", "FOLLOW_UP", "DOCUMENT_COLLECTION", "OTHER"] as const;
export type OpsTaskKind = (typeof OPS_TASK_KINDS)[number];

export const OPS_TASK_STATUSES = ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"] as const;
export type OpsTaskStatus = (typeof OPS_TASK_STATUSES)[number];

export const OPS_TASK_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type OpsTaskPriority = (typeof OPS_TASK_PRIORITIES)[number];

export const OPS_TASK_ACTIONS = ["CREATE", "ASSIGN", "REASSIGN", "START", "FOLLOW_UP", "NOTE", "DONE", "CANCEL", "REOPEN"] as const;
export type OpsTaskAction = (typeof OPS_TASK_ACTIONS)[number];

export const OPS_ASSIST_STATUSES = ["ENQUIRY", "INVITED", "REGISTERED", "PROFILE_COMPLETE", "DROPPED"] as const;
export type OpsAssistStatus = (typeof OPS_ASSIST_STATUSES)[number];

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const opsZoneAssignments = pgTable(
  "ops_zone_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    zoneId: text("zone_id").notNull(),
    assignedBy: uuid("assigned_by").notNull(),
    reason: text("reason"),
    active: boolean("active").notNull().default(true),
    assignedAt: ts("assigned_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
    endedBy: uuid("ended_by"),
  },
  (t) => [index("ops_zone_assignments_zone_idx").on(t.zoneId)],
);
export type OpsZoneAssignment = typeof opsZoneAssignments.$inferSelect;

export const opsTasks = pgTable(
  "ops_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: OPS_TASK_KINDS }).notNull(),
    title: text("title").notNull(),
    notes: text("notes"),
    status: text("status", { enum: OPS_TASK_STATUSES }).notNull().default("OPEN"),
    priority: text("priority", { enum: OPS_TASK_PRIORITIES }).notNull().default("NORMAL"),
    assigneeUserId: uuid("assignee_user_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    shopId: uuid("shop_id"),
    customerUserId: uuid("customer_user_id"),
    assistId: uuid("assist_id"),
    zoneId: text("zone_id"),
    dueAt: ts("due_at"),
    followUpAt: ts("follow_up_at"),
    completedAt: ts("completed_at"),
    outcome: text("outcome"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("ops_tasks_assignee_idx").on(t.assigneeUserId, t.status, t.dueAt)],
);
export type OpsTask = typeof opsTasks.$inferSelect;

export const opsTaskEvents = pgTable(
  "ops_task_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull(),
    action: text("action", { enum: OPS_TASK_ACTIONS }).notNull(),
    actorId: uuid("actor_id").notNull(),
    actorRole: text("actor_role").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    assigneeUserId: uuid("assignee_user_id"),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("ops_task_events_task_idx").on(t.taskId, t.createdAt)],
);
export type OpsTaskEvent = typeof opsTaskEvents.$inferSelect;

export const opsCustomerAssists = pgTable(
  "ops_customer_assists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opsUserId: uuid("ops_user_id").notNull(),
    customerName: text("customer_name").notNull(),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    pincode: text("pincode"),
    zoneId: text("zone_id"),
    status: text("status", { enum: OPS_ASSIST_STATUSES }).notNull().default("ENQUIRY"),
    customerUserId: uuid("customer_user_id"),
    notes: text("notes"),
    followUpAt: ts("follow_up_at"),
    registeredAt: ts("registered_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("ops_customer_assists_user_idx").on(t.opsUserId, t.status)],
);
export type OpsCustomerAssist = typeof opsCustomerAssists.$inferSelect;
