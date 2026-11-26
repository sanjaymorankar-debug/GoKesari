/**
 * Flow spec v3, wave 1 (docs/flows-v3/wave1.md; drizzle/0221_flows_v3_wave1.sql; flag flow_f17).
 *
 * support_routing_rules: who receives a new help-desk ticket automatically — by ticket category and, optionally,
 * the district (geo_areas code, or a state code) of the ticket's shop. NULL district = every area. Admin-editable
 * (Admin → Support → Routing). One row per (category, district, user): unique index on
 * (category, COALESCE(district_code, ''), user_id) in the migration.
 * Re-exported by schema.ts.
 */
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./schema";

export const supportRoutingRules = pgTable(
  "support_routing_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    category: text("category").notNull(),
    districtCode: text("district_code"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("support_routing_rules_category_idx").on(t.category).where(sql`${t.active}`)],
);
export type SupportRoutingRule = typeof supportRoutingRules.$inferSelect;
