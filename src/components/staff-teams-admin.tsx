"use client";

/** RBAC v2: an admin puts Support Users under a Support Manager and Operations Users under an Operations Manager. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, inputClass } from "@/components/ui";

export interface TeamView {
  team: "SUPPORT" | "OPERATIONS";
  managerId: string;
  managerName: string;
  members: { userId: string; name: string }[];
}

export function StaffTeamsAdmin({ teams, candidates }: { teams: TeamView[]; candidates: Record<"SUPPORT" | "OPERATIONS", { id: string; name: string }[]> }) {
  const router = useRouter();
  const [pick, setPick] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  async function call(method: string, url: string, body?: unknown) {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
  }
  async function add(t: TeamView) {
    const memberUserId = pick[`${t.team}:${t.managerId}`];
    if (!memberUserId) return;
    try {
      await call("POST", "/api/staff/teams", { team: t.team, managerUserId: t.managerId, memberUserId });
      setMsg("Added.");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "That did not work.");
    }
  }
  async function remove(team: string, memberId: string) {
    try {
      await call("DELETE", `/api/staff/teams?team=${team}&memberId=${memberId}`);
      setMsg("Removed.");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "That did not work.");
    }
  }
  return (
    <div className="grid gap-3">
      {msg ? <Alert tone="info">{msg}</Alert> : null}
      {teams.length === 0 ? <p className="text-sm text-ink-600">Give someone the Support Manager or Operations Manager role first (Users → privileges).</p> : null}
      {teams.map((t) => (
        <Card key={`${t.team}:${t.managerId}`}>
          <p className="font-semibold">
            {t.team === "SUPPORT" ? "Support" : "Operations"} — {t.managerName}
          </p>
          <ul className="mt-1 text-sm">
            {t.members.map((m) => (
              <li key={m.userId} className="flex items-center gap-2">
                {m.name}
                <Button size="sm" variant="ghost" onClick={() => remove(t.team, m.userId)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            <select className={inputClass} value={pick[`${t.team}:${t.managerId}`] ?? ""} onChange={(e) => setPick((p) => ({ ...p, [`${t.team}:${t.managerId}`]: e.target.value }))} aria-label="Add member">
              <option value="">Add a member…</option>
              {candidates[t.team].map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={() => add(t)}>
              Add
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
