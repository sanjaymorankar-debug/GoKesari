import Link from "next/link";
import { redirect } from "next/navigation";
import { inArray } from "drizzle-orm";

import { ApprovalsQueue, type ApprovalRow } from "@/components/approvals-queue";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { countActiveAdmins, listApprovals, listOverdueConfirmations, superAdminEmail } from "@/server/approvals";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Approvals" };
export const dynamic = "force-dynamic";

const ist = (d: Date) =>
  d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * RBAC v2 (docs/rbac): the four-eye queue. Admins see every pending request; a request raised by
 * an admin needs a different admin. While fewer than two admins are active the Super Admin may
 * approve their own (single-admin, audited and e-mailed).
 */
export default async function ApprovalsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.APPROVAL_VIEW_ANY)) redirect("/");

  const [requests, overdueRows, fourEyeOn, activeAdmins] = await Promise.all([
    listApprovals({ statuses: ["PENDING"], checkers: ["ADMIN", "CA_THEN_ADMIN"] }),
    listOverdueConfirmations(),
    isFeatureEnabled("rbac_v2_four_eye_admin"),
    countActiveAdmins(),
  ]);
  const visible = requests.filter((r) => r.checker === "ADMIN" || r.stage === 2);
  const ids = [...new Set(visible.map((r) => r.requestedBy))];
  const people = ids.length ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids)) : [];
  const nameOf = new Map(people.map((p) => [p.id, p.name || p.email]));
  // Overdue is decided by the database clock (now()), not during render.
  const overdue = new Set(overdueRows.map((r) => r.id));
  const rows: ApprovalRow[] = visible.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    reason: r.reason,
    status: r.status,
    checker: r.checker,
    stage: r.stage,
    requestedBy: r.requestedBy,
    requestedByName: nameOf.get(r.requestedBy) ?? "Unknown",
    requestedAtIst: ist(r.requestedAt),
    confirmByIst: r.confirmBy ? ist(r.confirmBy) : null,
    overdue: overdue.has(r.id),
    mine: r.requestedBy === user.id,
  }));
  const canSingleAdmin = activeAdmins < 2 && user.email.toLowerCase() === superAdminEmail();

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Admin
      </Link>
      <PageHeader
        title="Approvals"
        description="Changes one admin made that wait for a second admin: roles, suspensions, reactivations and feature flags. You cannot approve your own request."
      />
      {!fourEyeOn ? (
        <div className="mb-3">
          <Alert tone="info">Two-admin approval is off (flag rbac_v2_four_eye_admin). Admin changes apply at once, as before.</Alert>
        </div>
      ) : null}
      {activeAdmins < 2 ? (
        <div className="mb-3">
          <Alert tone="warning">
            Fewer than two admins are active, so the Super Admin may approve alone. Each such approval is marked single-admin in the audit log and
            e-mailed to the Super Admin.
          </Alert>
        </div>
      ) : null}
      <ApprovalsQueue rows={rows} canSingleAdmin={canSingleAdmin} />
    </div>
  );
}
