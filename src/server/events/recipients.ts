/**
 * Who "support" is, for the event layer. There is no separate support role:
 * operators (and administrators) are the support team, and administrators are
 * the support lead an escalation goes to. A user counts by their active role
 * or by any ACTIVE grant of one of these roles; suspended and deleted accounts
 * never receive alerts.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import { userRoleGrants, users, type UserRole } from "@/server/db/schema";

export type Audience = "SUPPORT" | "SUPPORT_LEAD";

const AUDIENCE_ROLES: Record<Audience, UserRole[]> = {
  SUPPORT: ["OPERATOR", "ADMIN"],
  SUPPORT_LEAD: ["ADMIN"],
};

export async function listAudienceUserIds(audience: Audience, client: DbClient = db): Promise<string[]> {
  const roles = AUDIENCE_ROLES[audience];
  const rows = await client
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.status, "ACTIVE"),
        isNull(users.deletedAt),
        or(
          inArray(users.role, roles),
          sql`exists (select 1 from ${userRoleGrants} g where g.user_id = ${users.id}
                and g.role in (${sql.join(roles.map((r) => sql`${r}`), sql`, `)}) and g.status = 'ACTIVE')`,
        ),
      ),
    );
  return rows.map((r) => r.id);
}
