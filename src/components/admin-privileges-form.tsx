"use client";

/**
 * Screen 2 — admin privileges, with an explicit Save.
 *
 * The role picker on the admin dashboard used to write on `onChange`: one
 * stray click and someone's access had already changed. Here the active role
 * and the held roles are a local draft; nothing is sent until Save, and Save
 * asks "are you sure?" with the staged change spelled out first.
 *
 * Two columns are being edited at once — `users.role` (what every permission
 * check reads) and the ACTIVE rows in `user_role_grants` (what the user may
 * switch to) — so one Save posts both to `PATCH /api/users/{id}/privileges`,
 * which applies them in a single transaction.
 */

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { SaveChangesBar, postJson, useSaveChanges } from "@/components/save-changes-bar";
import { Alert, Badge, Card } from "@/components/ui";
import type { UserRole } from "@/server/db/schema";

/**
 * Order shown to the admin: least to most privileged. Labels are kept local
 * rather than imported from the server authz module, as the other role UIs do
 * (`user-role-manager.tsx`, `growth-actions.tsx`) — client bundles should not
 * reach into `@/server`.
 */
const ROLE_ORDER: readonly UserRole[] = [
  "CUSTOMER",
  "SHOP_OWNER",
  "DELIVERY_PARTNER",
  "SOCIETY_ADMIN",
  "OPERATOR",
  "ADMIN",
];

export interface PrivilegesDraft {
  activeRole: UserRole;
  heldRoles: UserRole[];
}

const ROLE_LABELS: Record<UserRole, string> = {
  CUSTOMER: "Customer",
  SHOP_OWNER: "Shop Owner",
  DELIVERY_PARTNER: "Delivery Partner",
  SOCIETY_ADMIN: "Society Admin",
  OPERATOR: "Operator",
  ADMIN: "Administrator",
};

const label = (role: UserRole) => ROLE_LABELS[role] ?? role;
const sameSet = (a: readonly UserRole[], b: readonly UserRole[]) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

export function AdminPrivilegesForm({
  userId,
  userName,
  isSelf,
  isPermanentAdmin,
  initial,
}: {
  userId: string;
  userName: string;
  isSelf: boolean;
  isPermanentAdmin: boolean;
  initial: PrivilegesDraft;
}) {
  const router = useRouter();
  const [baseline, setBaseline] = useState(initial);
  const [draft, setDraft] = useState(initial);

  const dirty = draft.activeRole !== baseline.activeRole || !sameSet(draft.heldRoles, baseline.heldRoles);

  const granted = useMemo(() => draft.heldRoles.filter((r) => !baseline.heldRoles.includes(r)), [draft, baseline]);
  const revoked = useMemo(() => baseline.heldRoles.filter((r) => !draft.heldRoles.includes(r)), [draft, baseline]);

  // Mirrors the server's checks so the admin sees the problem before saving;
  // updateUserPrivileges() re-checks all of it against the database.
  const clientError = (() => {
    if (!draft.heldRoles.includes(draft.activeRole)) {
      return `The account must hold ${label(draft.activeRole)} to act as it. Tick it under "Roles held".`;
    }
    if (draft.heldRoles.includes("OPERATOR") && draft.heldRoles.includes("ADMIN")) {
      return "An account cannot hold both Operator and Administrator. Choose one.";
    }
    return null;
  })();

  const save = useSaveChanges({
    id: `privileges:${userId}`,
    dirty: dirty && !clientError,
    confirm: () => ({
      title: `Change privileges for ${userName}?`,
      lines: [
        draft.activeRole === baseline.activeRole
          ? `Acting as: ${label(baseline.activeRole)} (unchanged)`
          : `Acting as: ${label(baseline.activeRole)} → ${label(draft.activeRole)}`,
        granted.length || revoked.length
          ? `Roles held: ${[...granted.map((r) => `+ ${label(r)}`), ...revoked.map((r) => `− ${label(r)}`)].join(", ")}`
          : "Roles held: unchanged",
      ],
      body: "This changes what this person can do across the platform. The change is recorded in the audit log.",
      confirmLabel: "Yes, save privileges",
    }),
    onSave: async () => {
      await postJson(`/api/users/${userId}/privileges`, "PATCH", {
        activeRole: draft.activeRole,
        heldRoles: draft.heldRoles,
      });
      setBaseline(draft);
      router.refresh();
      return `Privileges updated for ${userName}`;
    },
  });

  const locked = isSelf || isPermanentAdmin;

  function toggleHeld(role: UserRole, checked: boolean) {
    setDraft((d) => ({
      ...d,
      heldRoles: checked ? [...d.heldRoles, role] : d.heldRoles.filter((r) => r !== role),
    }));
  }

  return (
    <div className="space-y-4" data-testid="admin-privileges-form">
      {isSelf ? (
        <Alert tone="warning" title="This is your own account">
          You cannot change your own privileges, and you cannot remove your own last administrator right. Ask another
          administrator to do it.
        </Alert>
      ) : null}
      {isPermanentAdmin ? (
        <Alert tone="info" title="Permanent administrator">
          This account is listed in <code>PERMANENT_ADMIN_EMAILS</code>, so it is granted ADMIN again on every sign-in.
          Remove it from that list before changing its privileges here.
        </Alert>
      ) : null}

      <Card className="space-y-4 p-4">
        <fieldset disabled={locked} className="space-y-2">
          <legend className="text-sm font-medium text-ink-700">Acting as</legend>
          <p className="text-xs text-ink-500">
            The single role every permission check reads. The account must also hold it.
          </p>
          <div className="grid gap-1 sm:grid-cols-2">
            {ROLE_ORDER.map((role) => (
              <label key={role} className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="radio"
                  name="activeRole"
                  value={role}
                  checked={draft.activeRole === role}
                  onChange={() => setDraft((d) => ({ ...d, activeRole: role }))}
                />
                {label(role)}
                {baseline.activeRole === role ? <Badge>current</Badge> : null}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset disabled={locked} className="space-y-2">
          <legend className="text-sm font-medium text-ink-700">Roles held</legend>
          <p className="text-xs text-ink-500">
            Roles this person can switch between. Customer is kept on every account.
          </p>
          <div className="grid gap-1 sm:grid-cols-2">
            {ROLE_ORDER.map((role) => (
              <label key={role} className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  checked={draft.heldRoles.includes(role)}
                  disabled={role === "CUSTOMER"}
                  onChange={(e) => toggleHeld(role, e.target.checked)}
                  aria-label={`${label(role)} held`}
                />
                {label(role)}
                {role === "CUSTOMER" ? <span className="text-xs text-ink-400">(always)</span> : null}
              </label>
            ))}
          </div>
        </fieldset>
      </Card>

      {clientError ? <Alert tone="danger">{clientError}</Alert> : null}

      {locked ? null : (
        <SaveChangesBar
          state={save}
          label="Save Changes"
          dirtyHint="Unsaved privilege changes — nothing is written yet."
          testId="privileges-save"
        />
      )}
    </div>
  );
}
