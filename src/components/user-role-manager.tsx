import Link from "next/link";

import { Badge, Card, EmptyState } from "@/components/ui";
import type { UserRole } from "@/server/db/schema";

const ROLE_LABELS: Record<string, string> = {
  CUSTOMER: "Customer",
  SHOP_OWNER: "Shop Owner",
  DELIVERY_PARTNER: "Delivery Partner",
  SOCIETY_ADMIN: "Society Admin",
  OPERATOR: "Operator",
  ADMIN: "Administrator",
};

export interface ManagedUser {
  id: string;
  name: string | null;
  email: string;
  role: UserRole;
  status: string;
  /** GS-003: other roles the user holds and can switch to. */
  otherRoles?: UserRole[];
}

/**
 * Admin user list (§5). Read-only by design: this used to carry a role
 * `<select>` that saved on `onChange` and a Remove-role button that revoked
 * instantly, so a mis-click was already a committed privilege change. Editing
 * now lives on `/admin/users/[id]` (profile) and `/admin/users/[id]/privileges`
 * (roles), where a draft is held locally and written only when the admin
 * presses Save Changes — and where there is room to confirm the change and
 * show what it will do.
 *
 * `canSetRole` is false for an OPERATOR viewing the same list: they hold
 * USER_VIEW_ANY but neither USER_SET_ROLE nor USER_EDIT_PROFILE, so they see
 * the accounts without the edit links.
 */
export function UserRoleManager({
  users,
  currentUserId,
  canSetRole,
}: {
  users: ManagedUser[];
  currentUserId: string;
  canSetRole: boolean;
}) {
  if (users.length === 0) {
    return <EmptyState title="No users found." />;
  }

  return (
    <Card className="divide-y divide-cream-200">
      {users.map((u) => (
        <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink-900">{u.name ?? u.email}</p>
            <p className="truncate text-xs text-ink-500">
              {u.email}
              {u.id === currentUserId ? " · you" : ""}
            </p>
            {u.otherRoles && u.otherRoles.length > 0 ? (
              <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-ink-500">
                Also holds:
                {u.otherRoles.map((r) => (
                  <Badge key={r}>{ROLE_LABELS[r] ?? r}</Badge>
                ))}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {u.status !== "ACTIVE" ? <Badge tone="danger">{u.status}</Badge> : null}
            <Badge>{ROLE_LABELS[u.role] ?? u.role}</Badge>
            {canSetRole ? (
              <>
                <Link href={`/admin/users/${u.id}`} className="text-sm font-medium text-kesari-700 underline">
                  Edit profile
                </Link>
                <Link
                  href={`/admin/users/${u.id}/privileges`}
                  className="text-sm font-medium text-kesari-700 underline"
                >
                  Manage privileges
                </Link>
              </>
            ) : null}
          </div>
        </div>
      ))}
    </Card>
  );
}
