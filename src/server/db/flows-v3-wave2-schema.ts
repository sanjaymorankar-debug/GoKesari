/**
 * Flow spec v3, wave 2 (docs/flows-v3/wave2.md; drizzle/0222_flows_v3_wave2.sql; flag flow_f16).
 *
 * order_cancel_requests: a customer asks the shop to cancel an order that is already packed (READY / ASSIGNED).
 * The shop agrees (the order is cancelled through the normal cancel path with a full refund — the after-packing
 * charge is ₹0 under the flag) or declines (the order carries on). One PENDING request per order: partial unique
 * index on (order_id) WHERE status = 'PENDING' in the migration.
 * Re-exported by schema.ts.
 */
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { orders, users } from "./schema";

export const ORDER_CANCEL_REQUEST_STATUSES = ["PENDING", "ACCEPTED", "DECLINED", "WITHDRAWN", "CLOSED"] as const;
export type OrderCancelRequestStatus = (typeof ORDER_CANCEL_REQUEST_STATUSES)[number];

export const orderCancelRequests = pgTable(
  "order_cancel_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason"),
    status: text("status", { enum: ORDER_CANCEL_REQUEST_STATUSES }).notNull().default("PENDING"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("order_cancel_requests_pending_uq").on(t.orderId).where(sql`${t.status} = 'PENDING'`),
    index("order_cancel_requests_order_idx").on(t.orderId),
  ],
);
export type OrderCancelRequest = typeof orderCancelRequests.$inferSelect;
