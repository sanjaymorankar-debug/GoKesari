import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { AdminPrivilegesForm } from "@/components/admin-privileges-form";
import { UnsavedChangesProvider } from "@/components/unsaved-changes-guard";
import { LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { getUserPrivileges } from "@/server/services/users";

export const metadata = { title: "Admin privileges" };
export const dynamic = "force-dynamic";

/**
 * Screen 2 — role and permission changes for one account, saved explicitly.
 *
 * ADMIN only: an operator holds USER_VIEW_ANY but not USER_SET_ROLE, so it
 * redirects rather than rendering a form whose Save would always 403.
 */
export default async function AdminUserPrivilegesPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor) redirect("/signin");
  if (actor.role !== "ADMIN") redirect("/");

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [target] = await db
    .select({ id: users.id, name: users.name, email: users.email, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, id));
  if (!target || target.deletedAt) notFound();

  const privileges = await getUserPrivileges(id);
  const displayName = target.name ?? target.email;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title={`Privileges — ${displayName}`}
        description={`${target.email}. Changes are not saved until you press Save Changes, and every save is recorded in the audit log.`}
        action={
          <LinkButton href={`/admin/users/${id}`} variant="secondary">
            Edit profile
          </LinkButton>
        }
      />
      <UnsavedChangesProvider>
        <AdminPrivilegesForm
          userId={target.id}
          userName={displayName}
          isSelf={target.id === actor.id}
          isPermanentAdmin={privileges.isPermanentAdmin}
          initial={{ activeRole: privileges.activeRole, heldRoles: privileges.heldRoles }}
        />
      </UnsavedChangesProvider>
    </div>
  );
}
