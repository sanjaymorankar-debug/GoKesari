import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { UnsavedChangesProvider } from "@/components/unsaved-changes-guard";
import { UserProfileAdminForm } from "@/components/user-profile-admin-form";
import { LinkButton, PageHeader } from "@/components/ui";
import { maskPhone } from "@/lib/phone";
import { getCurrentUser } from "@/server/authz/guards";
import { ROLE_LABELS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";

export const metadata = { title: "User profile" };
export const dynamic = "force-dynamic";

/**
 * Screen 3 — an admin edits one account's profile, with an explicit Save.
 *
 * USER_EDIT_PROFILE is admin-only, so an operator is redirected rather than
 * shown a form whose Save would 403.
 */
export default async function AdminUserProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor) redirect("/signin");
  if (actor.role !== "ADMIN") redirect("/");

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [target] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      phoneE164: users.phoneE164,
      phoneVerifiedAt: users.phoneVerifiedAt,
      role: users.role,
      status: users.status,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, id));
  if (!target || target.deletedAt) notFound();
  // DELETED accounts are not editable; nothing here can bring one back.
  if (target.status === "DELETED") notFound();

  const loginMobile = target.phoneE164
    ? `${maskPhone(target.phoneE164)}${target.phoneVerifiedAt ? " (verified)" : " (not verified)"}`
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title={`Profile — ${target.name ?? target.email}`}
        description="Changes are not saved until you press Save Changes, and every save is recorded in the audit log."
        action={
          <LinkButton href={`/admin/users/${id}/privileges`} variant="secondary">
            Manage privileges
          </LinkButton>
        }
      />
      <UnsavedChangesProvider>
        <UserProfileAdminForm
          userId={target.id}
          email={target.email}
          loginMobile={loginMobile}
          roleLabel={ROLE_LABELS[target.role] ?? target.role}
          isSelf={target.id === actor.id}
          initial={{ name: target.name, phone: target.phone, status: target.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE" }}
        />
      </UnsavedChangesProvider>
    </div>
  );
}
