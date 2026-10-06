"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/*
 * GS-003 role switcher. Its own module (not growth-actions.tsx) because the
 * header renders it on every page: importing it from there shipped all of
 * the campaign, COD and risk forms to every visitor.
 */

export const ROLE_LABEL: Record<string, string> = {
  CUSTOMER: "Customer",
  SHOP_OWNER: "Shop owner",
  OPERATOR: "Operator",
  ADMIN: "Admin",
  DELIVERY_PARTNER: "Delivery partner",
  SOCIETY_ADMIN: "Society admin",
};

const ROLE_HOME: Record<string, string> = {
  CUSTOMER: "/",
  SHOP_OWNER: "/shop",
  OPERATOR: "/admin",
  ADMIN: "/admin",
  DELIVERY_PARTNER: "/delivery-partner",
  SOCIETY_ADMIN: "/society",
};

/** Header control to switch the active role; shown only to users holding more than one. */
export function RoleSwitcher({ active, roles }: { active: string; roles: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (roles.length < 2) return null;

  async function change(role: string) {
    setBusy(true);
    const response = await fetch("/api/me/roles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    setBusy(false);
    if (response.ok) {
      router.push(ROLE_HOME[role] ?? "/");
      router.refresh();
    }
  }

  return (
    <select
      aria-label="Acting as"
      title="Acting as"
      className="rounded-lg border border-cream-200 bg-white px-2 py-1.5 text-xs font-medium text-ink-700"
      value={active}
      disabled={busy}
      onChange={(e) => change(e.target.value)}
      data-testid="role-switcher"
    >
      {roles.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABEL[role] ?? role}
        </option>
      ))}
    </select>
  );
}
