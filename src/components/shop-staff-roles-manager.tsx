"use client";

/**
 * Module 10 (docs/shop-staff-roles-2026-11): the owner invites staff with a
 * role, sees what each role allows (matrix), changes roles, pauses, restores
 * and removes access, and opens each person's activity. Shown only with flag
 * shop_staff_roles_enabled on; the server checks every action again.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import {
  effectivePermissions,
  SHOP_STAFF_ACTIONS,
  SHOP_STAFF_FLAGS,
  SHOP_STAFF_RESOURCE_LABELS,
  SHOP_STAFF_RESOURCES,
  SHOP_STAFF_ROLE_LABELS,
  SHOP_STAFF_ROLES,
  type ShopStaffPermission,
  type ShopStaffRole,
} from "@/lib/shop-staff/permissions";

export interface RolesMember {
  id: string;
  name: string | null;
  contact: string;
  status: "INVITED" | "ACTIVE" | "SUSPENDED" | "REVOKED";
  role: ShopStaffRole;
  permissions: ShopStaffPermission[];
  effective: ShopStaffPermission[];
  addedAt: string;
  revokedAt: string | null;
  inviteExpiresAt: string | null;
}

const FLAG_LABELS: Record<(typeof SHOP_STAFF_FLAGS)[number], string> = {
  financial_visibility: "See money (wallet, payouts, GST, invoices)",
  config_access: "Change shop settings",
};

const STATUS_TONE = { INVITED: "info", ACTIVE: "success", SUSPENDED: "warning", REVOKED: "neutral" } as const;
const STATUS_LABEL = { INVITED: "Invited", ACTIVE: "Active", SUSPENDED: "Paused", REVOKED: "Removed" } as const;

function PermissionPicker({ value, onChange, base }: { value: ShopStaffPermission[]; onChange: (v: ShopStaffPermission[]) => void; base: ShopStaffPermission[] }) {
  const toggle = (p: ShopStaffPermission) => onChange(value.includes(p) ? value.filter((x) => x !== p) : [...value, p]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className="p-1 text-left">Area</th>
            {SHOP_STAFF_ACTIONS.map((a) => (
              <th key={a} className="p-1 capitalize">
                {a}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SHOP_STAFF_RESOURCES.map((r) => (
            <tr key={r} className="border-t border-cream-100">
              <td className="p-1 font-medium text-ink-700">{SHOP_STAFF_RESOURCE_LABELS[r]}</td>
              {SHOP_STAFF_ACTIONS.map((a) => {
                const p = `${r}.${a}` as ShopStaffPermission;
                const fromRole = base.includes(p);
                return (
                  <td key={a} className="p-1 text-center">
                    <input
                      type="checkbox"
                      aria-label={`${SHOP_STAFF_RESOURCE_LABELS[r]} ${a}`}
                      checked={fromRole || value.includes(p)}
                      disabled={fromRole}
                      onChange={() => toggle(p)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 space-y-1">
        {SHOP_STAFF_FLAGS.map((f) => (
          <label key={f} className="flex items-center gap-2 text-xs text-ink-700">
            <input type="checkbox" checked={base.includes(f) || value.includes(f)} disabled={base.includes(f)} onChange={() => toggle(f)} />
            {FLAG_LABELS[f]}
          </label>
        ))}
      </div>
    </div>
  );
}

/** Read-only: what each preset role allows. */
function RoleMatrix() {
  const presets = SHOP_STAFF_ROLES.filter((r) => r !== "CUSTOM");
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className="p-1 text-left">Area</th>
            {presets.map((r) => (
              <th key={r} className="p-1">
                {SHOP_STAFF_ROLE_LABELS[r]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SHOP_STAFF_RESOURCES.map((res) => (
            <tr key={res} className="border-t border-cream-100">
              <td className="p-1 font-medium text-ink-700">{SHOP_STAFF_RESOURCE_LABELS[res]}</td>
              {presets.map((r) => {
                const held = effectivePermissions(r, []).filter((p) => p.startsWith(`${res}.`)).map((p) => p.split(".")[1]);
                return (
                  <td key={r} className="p-1 text-center text-ink-600">
                    {held.length === 0 ? "—" : held.length === SHOP_STAFF_ACTIONS.length ? "all" : held.join(", ")}
                  </td>
                );
              })}
            </tr>
          ))}
          {SHOP_STAFF_FLAGS.map((f) => (
            <tr key={f} className="border-t border-cream-100">
              <td className="p-1 font-medium text-ink-700">{FLAG_LABELS[f]}</td>
              {presets.map((r) => (
                <td key={r} className="p-1 text-center">
                  {effectivePermissions(r, []).includes(f) ? "yes" : "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-ink-500">The owner can do everything. Custom: tick exactly what the person may do.</p>
    </div>
  );
}

export function ShopStaffRolesManager({ shopId, staff, canManageManagers }: { shopId: string; staff: RolesMember[]; canManageManagers: boolean }) {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [role, setRole] = useState<ShopStaffRole>("ORDER_MANAGER");
  const [extra, setExtra] = useState<ShopStaffPermission[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<ShopStaffRole>("ORDER_MANAGER");
  const [editExtra, setEditExtra] = useState<ShopStaffPermission[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const roles = useMemo(() => SHOP_STAFF_ROLES.filter((r) => canManageManagers || r !== "MANAGER"), [canManageManagers]);

  async function call(url: string, init: RequestInit, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(body?.error?.message ?? "That did not work. Try again.");
      return false;
    }
    setNotice(done);
    router.refresh();
    return true;
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    const okay = await call(
      `/api/shops/${shopId}/staff`,
      { method: "POST", body: JSON.stringify({ identifier, role, permissions: extra }) },
      "Invitation sent. They get access once they accept it.",
    );
    if (okay) {
      setIdentifier("");
      setExtra([]);
    }
  }

  const open = staff.filter((m) => m.status !== "REVOKED");
  const past = staff.filter((m) => m.status === "REVOKED");

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Card className="p-4">
        <form onSubmit={invite} className="space-y-3">
          <Field label="Mobile number or email" hint="Someone with a GoKesari account gets the invitation in the app. Anyone else: use their email — they get a link and sign in with the emailed code.">
            <input
              className={inputClass}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="98765 43210 or name@example.com"
              inputMode="email"
              autoComplete="off"
              required
            />
          </Field>
          <Field label="Role">
            <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value as ShopStaffRole)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {SHOP_STAFF_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
          <details className="text-sm" open={role === "CUSTOM"}>
            <summary className="cursor-pointer text-ink-600">{role === "CUSTOM" ? "Permissions" : "Extra permissions (optional)"}</summary>
            <div className="mt-2">
              <PermissionPicker value={extra} onChange={setExtra} base={role === "CUSTOM" ? [] : effectivePermissions(role, [])} />
            </div>
          </details>
          <Button type="submit" disabled={busy || identifier.trim().length < 5 || (role === "CUSTOM" && extra.length === 0)}>
            Send invitation
          </Button>
        </form>
      </Card>

      <Card className="divide-y divide-cream-100">
        {open.length === 0 ? <p className="p-4 text-sm text-ink-500">No staff yet.</p> : null}
        {open.map((m) => (
          <div key={m.id} className="space-y-2 p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium text-ink-900">
                  {m.name ?? m.contact} <Badge tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Badge>
                </p>
                <p className="text-xs text-ink-500">
                  {SHOP_STAFF_ROLE_LABELS[m.role]} · {m.contact}
                  {m.status === "INVITED" && m.inviteExpiresAt
                    ? ` · invitation open until ${new Date(m.inviteExpiresAt).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}`
                    : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setEditing(editing === m.id ? null : m.id);
                    setEditRole(m.role);
                    setEditExtra(m.permissions);
                  }}
                >
                  Change role
                </Button>
                {m.status === "ACTIVE" ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => call(`/api/shops/${shopId}/staff/${m.id}`, { method: "PATCH", body: JSON.stringify({ suspended: true }) }, "Access paused.")}>
                    Pause
                  </Button>
                ) : null}
                {m.status === "SUSPENDED" ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => call(`/api/shops/${shopId}/staff/${m.id}`, { method: "PATCH", body: JSON.stringify({ suspended: false }) }, "Access restored.")}>
                    Restore
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Remove ${m.name ?? m.contact}? Their access ends at once.`)) {
                      void call(`/api/shops/${shopId}/staff/${m.id}`, { method: "DELETE" }, m.status === "INVITED" ? "Invitation cancelled." : "Access removed.");
                    }
                  }}
                >
                  {m.status === "INVITED" ? "Cancel invitation" : "Remove"}
                </Button>
                {m.status !== "INVITED" ? (
                  <Link href={`/shop/staff/${m.id}/activity`} className="px-2 py-1 text-xs font-medium text-kesari-700 underline">
                    Activity
                  </Link>
                ) : null}
              </div>
            </div>
            {editing === m.id ? (
              <div className="space-y-2 rounded-lg border border-cream-200 p-3">
                <select className={inputClass} value={editRole} onChange={(e) => setEditRole(e.target.value as ShopStaffRole)}>
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {SHOP_STAFF_ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
                <PermissionPicker value={editExtra} onChange={setEditExtra} base={editRole === "CUSTOM" ? [] : effectivePermissions(editRole, [])} />
                <Button
                  size="sm"
                  disabled={busy || (editRole === "CUSTOM" && editExtra.length === 0)}
                  onClick={async () => {
                    if (await call(`/api/shops/${shopId}/staff/${m.id}`, { method: "PATCH", body: JSON.stringify({ role: editRole, permissions: editExtra }) }, "Role changed.")) setEditing(null);
                  }}
                >
                  Save role
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </Card>

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-600">What each role can do</summary>
        <Card className="mt-2 p-3">
          <RoleMatrix />
        </Card>
      </details>

      {past.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-600">Former staff ({past.length})</summary>
          <ul className="mt-2 space-y-1">
            {past.map((m) => (
              <li key={m.id} className="text-ink-500">
                {m.name ?? m.contact} <Badge>removed {m.revokedAt ? new Date(m.revokedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }) : ""}</Badge>{" "}
                <Link href={`/shop/staff/${m.id}/activity`} className="text-xs text-kesari-700 underline">
                  Activity
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
