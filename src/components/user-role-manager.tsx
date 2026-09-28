"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { RevokeRoleButton } from "@/components/growth-actions";
import { Badge, Card, EmptyState } from "@/components/ui";
import type { UserRole } from "@/server/db/schema";

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: "CUSTOMER", label: "Customer" },
  { value: "SHOP_OWNER", label: "Shop Owner" },
  { value: "DELIVERY_PARTNER", label: "Delivery Partner" },
  { value: "OPERATOR", label: "Operator" },
  { value: "ADMIN", label: "Administrator" },
];

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
 * Admin-only user list with a role picker per row (§5). `canSetRole` is false
 * for an OPERATOR viewing the same list — they can see accounts but not
 * reassign roles, since OPERATOR does not hold USER_SET_ROLE.
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
        <UserRow
          key={u.id}
          user={u}
          isSelf={u.id === currentUserId}
          canSetRole={canSetRole}
        />
      ))}
    </Card>
  );
}

function UserRow({
  user,
  isSelf,
  canSetRole,
}: {
  user: ManagedUser;
  isSelf: boolean;
  canSetRole: boolean;
}) {
  const router = useRouter();
  const [role, setRole] = useState<UserRole>(user.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeRole(next: UserRole) {
    if (next === role) return;
    const previous = role;
    setRole(next);
    setBusy(true);
    setError(null);

    const response = await fetch(`/api/users/${user.id}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: next }),
    });
    setBusy(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setRole(previous);
      setError(payload?.error?.message ?? "Could not change this user's role.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink-900">
          {user.name ?? user.email}
        </p>
        <p className="truncate text-xs text-ink-500">{user.email}</p>
        {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
        {user.otherRoles && user.otherRoles.length > 0 ? (
          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-ink-500">
            Also holds:
            {user.otherRoles.map((r) =>
              canSetRole && !isSelf ? (
                <RevokeRoleButton key={r} userId={user.id} role={r} />
              ) : (
                <Badge key={r}>{ROLE_OPTIONS.find((o) => o.value === r)?.label ?? r}</Badge>
              ),
            )}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {user.status !== "ACTIVE" ? <Badge tone="danger">{user.status}</Badge> : null}
        {canSetRole && !isSelf ? (
          <select
            value={role}
            disabled={busy}
            onChange={(e) => changeRole(e.target.value as UserRole)}
            aria-label={`Role for ${user.email}`}
            className="rounded-lg border border-cream-200 px-2 py-1 text-sm disabled:opacity-50"
          >
            {ROLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : (
          <Badge>{ROLE_OPTIONS.find((o) => o.value === role)?.label ?? role}</Badge>
        )}
      </div>
    </div>
  );
}
