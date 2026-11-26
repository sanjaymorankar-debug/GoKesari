"use client";

/**
 * Admin → user page (docs/onboarding-v2-2026-11): the account's marketplace roles, team place and role history
 * (IST), and an override of the team role with a reason (recorded as OVERRIDE). Talks to
 * /api/users/<id>/marketplace-roles.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { TEAM_ROLE_LABEL } from "@/lib/onboarding-v2/team";

const ROLE_LABEL: Record<string, string> = {
  customer: "Customer",
  shop_owner: "Shop owner",
  dealer_free: "Free dealer",
  franchisee_paid: "Paid franchisee",
  team_lead: "Team lead",
  agent: "Agent",
  admin: "Admin",
  operator: "Operator",
};

export interface AdminMarketplaceRolesData {
  roles: string[];
  team: { memberId: string; dealerName: string; role: "TEAM_LEAD" | "AGENT"; parentName: string; activeAgents: number } | null;
  leads: { id: string; name: string }[];
  history: { id: string; role: string; action: string; fromValue: string | null; toValue: string | null; reason: string | null; by: string; atIst: string }[];
}

export function AdminMarketplaceRoles({ userId, data }: { userId: string; data: AdminMarketplaceRolesData }) {
  const router = useRouter();
  const [to, setTo] = useState<"TEAM_LEAD" | "AGENT" | "REMOVE" | "">("");
  const [parentId, setParentId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch(`/api/users/${userId}/marketplace-roles`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to, parentId: to === "AGENT" && parentId ? parentId : null, reason }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setDone("Saved. The change is in the role history as an admin override.");
      setReason("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4" data-testid="admin-marketplace-roles">
      <h2 className="text-base font-semibold text-ink-900">Marketplace roles</h2>
      <div className="flex flex-wrap gap-2">
        {data.roles.map((r) => (
          <Badge key={r} tone={r === "customer" ? "neutral" : "info"}>{ROLE_LABEL[r] ?? r}</Badge>
        ))}
      </div>
      {data.team ? (
        <p className="text-sm text-ink-700">
          {TEAM_ROLE_LABEL[data.team.role]} in {data.team.dealerName}&apos;s team, reporting to {data.team.parentName}
          {data.team.role === "TEAM_LEAD" ? ` · ${data.team.activeAgents} active agent(s)` : ""}.
        </p>
      ) : (
        <p className="text-sm text-ink-600">No team role.</p>
      )}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {done ? <Alert tone="success">{done}</Alert> : null}
      {data.team ? (
        <div className="space-y-2 rounded-lg border border-cream-200 p-3">
          <p className="text-sm font-medium text-ink-800">Override the team role</p>
          <select aria-label="New team role" className={inputClass} value={to} onChange={(e) => setTo(e.target.value as typeof to)}>
            <option value="">Choose…</option>
            {data.team.role === "AGENT" ? <option value="TEAM_LEAD">Make team lead</option> : null}
            <option value="AGENT">{data.team.role === "AGENT" ? "Move agent (choose the lead)" : "Change to agent"}</option>
            <option value="REMOVE">Remove team role (customer only)</option>
          </select>
          {to === "AGENT" ? (
            <select aria-label="Reports to" className={inputClass} value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">The dealer directly</option>
              {data.leads.map((l) => (
                <option key={l.id} value={l.id}>Team lead {l.name}</option>
              ))}
            </select>
          ) : null}
          <Field label="Reason (required, kept in the history)">
            <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </Field>
          <Button disabled={busy || !to || reason.trim().length < 5} onClick={save}>Save override</Button>
        </div>
      ) : null}
      <div>
        <p className="text-sm font-medium text-ink-800">Role history (IST)</p>
        {data.history.length === 0 ? <p className="text-sm text-ink-600">No changes recorded.</p> : null}
        <ul className="mt-1 space-y-1 text-sm">
          {data.history.map((h) => (
            <li key={h.id}>
              <span className="text-ink-500">{h.atIst}</span> — {ROLE_LABEL[h.role] ?? h.role}: {h.action.toLowerCase()}
              {h.fromValue || h.toValue ? ` (${h.fromValue ?? "—"} → ${h.toValue ?? "—"})` : ""} by {h.by}
              {h.reason ? <span className="text-ink-500"> · {h.reason}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
