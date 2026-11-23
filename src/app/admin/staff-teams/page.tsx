import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";

import { StaffTeamsAdmin, type TeamView } from "@/components/staff-teams-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { listTeam } from "@/server/rbac-support/desk";

export const metadata = { title: "Staff teams" };
export const dynamic = "force-dynamic";

/** RBAC v2 (docs/rbac): Support and Operations teams — which manager each staff member reports to. Admin only. */
export default async function StaffTeamsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  const staff = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(and(inArray(users.role, ["SUPPORT_MANAGER", "SUPPORT_USER", "OPERATIONS_MANAGER", "OPERATIONS_USER"]), eq(users.status, "ACTIVE")))
    .limit(1000);
  const label = (u: { name: string | null; email: string }) => u.name ?? u.email;
  const teams: TeamView[] = [];
  for (const m of staff.filter((s) => s.role === "SUPPORT_MANAGER" || s.role === "OPERATIONS_MANAGER")) {
    const team = m.role === "SUPPORT_MANAGER" ? "SUPPORT" : "OPERATIONS";
    teams.push({ team, managerId: m.id, managerName: label(m), members: (await listTeam(team, m.id)).map((x) => ({ userId: x.userId, name: x.name })) });
  }
  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/menu/settings" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Settings
      </Link>
      <PageHeader title="Staff teams" description="Which Support Users report to which Support Manager, and which Operations Users to which Operations Manager. Managers see their own team's work." />
      <StaffTeamsAdmin
        teams={teams}
        candidates={{
          SUPPORT: staff.filter((s) => s.role === "SUPPORT_USER").map((s) => ({ id: s.id, name: label(s) })),
          OPERATIONS: staff.filter((s) => s.role === "OPERATIONS_USER").map((s) => ({ id: s.id, name: label(s) })),
        }}
      />
    </div>
  );
}
