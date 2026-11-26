"use client";

/**
 * Onboarding v2 "My team" (docs/onboarding-v2-2026-11, Flow 4): search a customer by mobile or e-mail, send a
 * request with a role, share an invite link, and — for the dealer — upgrade, downgrade (after reassigning the
 * lead's agents), reassign and remove. Every time shown is IST. Talks to /api/team.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { TEAM_ROLE_LABEL } from "@/lib/onboarding-v2/team";
import type { CandidateView, InviteResult, TeamOverview } from "@/server/onboarding-v2/team";

type Role = "TEAM_LEAD" | "AGENT";

const STATE_TEXT: Record<string, string> = {
  AVAILABLE: "Registered customer — can be added.",
  NOT_READY: "Registered, but the account is not complete yet. You can still send the request; they accept once it is complete.",
  SELF: "That is your own account.",
  IS_DEALER: "This person is a dealer and cannot join a team.",
  IN_YOUR_TEAM: "Already in your team.",
  IN_ANOTHER_TEAM: "Already in another dealer's team.",
  ALREADY_INVITED: "A request is already waiting for this person.",
};
const CAN_INVITE = new Set(["AVAILABLE", "NOT_READY"]);

const ACTION_TEXT: Record<string, string> = {
  GRANTED: "joined",
  REVOKED: "role removed",
  UPGRADED: "upgraded",
  DOWNGRADED: "downgraded",
  REASSIGNED: "reassigned",
  MIGRATED: "migrated",
  OVERRIDE: "admin override",
};

async function post(body: object) {
  const res = await fetch("/api/team", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
  return payload;
}

export function MyTeam({ data }: { data: TeamOverview }) {
  const router = useRouter();
  const isDealer = data.viewer === "DEALER";
  const [query, setQuery] = useState("");
  const [candidate, setCandidate] = useState<CandidateView | null>(null);
  const [role, setRole] = useState<Role | null>(isDealer ? null : "AGENT");
  const [parentId, setParentId] = useState<string>("");
  const [invite, setInvite] = useState<InviteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [downgrading, setDowngrading] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function run(fn: () => Promise<void>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const search = () =>
    run(async () => {
      setInvite(null);
      setCandidate(await post({ action: "search", query }));
    });

  const send = () =>
    run(async () => {
      const result: InviteResult = await post({ action: "invite", contact: query, role: isDealer ? role : "AGENT", parentId: isDealer && role === "AGENT" && parentId ? parentId : null });
      setInvite(result);
      setCandidate(null);
    }, "Request sent.");

  const active = data.members.filter((m) => m.status === "ACTIVE");
  const agentsOf = (leadId: string) => active.filter((m) => m.parentId === leadId);
  const pending = data.invitations.filter((i) => i.status === "PENDING");
  const canSend = isDealer ? true : data.canAddAgents;

  return (
    <div className="space-y-4" data-testid="my-team-v2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card className="space-y-3 p-4">
        <h2 className="text-base font-semibold text-ink-900">{isDealer ? "Add a team member" : "Add an agent under you"}</h2>
        {!canSend ? (
          <Alert tone="info">Team leads cannot add agents at present. Ask {data.dealer.name}.</Alert>
        ) : (
          <>
            <p className="text-sm text-ink-600">
              Search by the person&apos;s mobile number or e-mail (exact). They must have a GoKesari customer account with a verified e-mail and mobile; anyone else gets an invite link to sign up first. The role is added only when they accept.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label="Mobile number or e-mail">
                  <input className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} inputMode="email" autoComplete="off" placeholder="98765 43210 or name@example.com" />
                </Field>
              </div>
              <Button onClick={search} disabled={busy || !query.trim()}>Search</Button>
            </div>
            {candidate ? (
              <div className="space-y-3 rounded-lg border border-cream-200 p-3" data-testid="team-candidate">
                {candidate.found ? (
                  <p className="text-sm">
                    <span className="font-semibold">{candidate.maskedName}</span> ({candidate.contact}) — {STATE_TEXT[candidate.state]}
                    {candidate.missing.length ? ` Missing: ${candidate.missing.join(", ")}.` : ""}
                  </p>
                ) : (
                  <p className="text-sm">No GoKesari account uses {candidate.contact}. Send an invite link: they sign up, then accept.</p>
                )}
                {!candidate.found || CAN_INVITE.has(candidate.state) ? (
                  <div className="space-y-3">
                    {isDealer ? (
                      <fieldset className="space-y-2">
                        <legend className="text-sm font-medium text-ink-700">Role (required)</legend>
                        {(["TEAM_LEAD", "AGENT"] as Role[]).map((r) => (
                          <label key={r} className="flex items-center gap-2 text-sm">
                            <input type="radio" name="team-role" checked={role === r} onChange={() => setRole(r)} />
                            {r === "TEAM_LEAD" ? "Team lead — reports to you" : "Agent"}
                          </label>
                        ))}
                        {role === "AGENT" ? (
                          <Field label="Agent reports to (required)">
                            <select className={inputClass} value={parentId} onChange={(e) => setParentId(e.target.value)}>
                              <option value="">Me (the dealer) directly</option>
                              {data.leads.map((l) => (
                                <option key={l.id} value={l.id}>Team lead {l.name}</option>
                              ))}
                            </select>
                          </Field>
                        ) : null}
                      </fieldset>
                    ) : (
                      <p className="text-sm text-ink-600">The person joins as an agent reporting to you.</p>
                    )}
                    <Button onClick={send} disabled={busy || !role}>{candidate.found ? "Send request" : "Create invite link"}</Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {invite ? <ShareInvite invite={invite} copied={copied} onCopy={() => navigator.clipboard?.writeText(invite.link).then(() => setCopied(true)).catch(() => setCopied(false))} /> : null}
          </>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-base font-semibold text-ink-900">{isDealer ? "My team" : "My agents"}</h2>
        {data.members.length === 0 ? <p className="text-sm text-ink-600">Nobody yet.</p> : null}
        <ul className="divide-y divide-cream-200">
          {data.members.map((m) => (
            <li key={m.id} className="space-y-2 py-3" data-testid="team-member">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink-900">{m.name}</span>
                <Badge tone={m.role === "TEAM_LEAD" ? "info" : "neutral"}>{TEAM_ROLE_LABEL[m.role]}</Badge>
                {m.status !== "ACTIVE" ? <Badge tone="warning">Removed</Badge> : null}
                <span className="text-xs text-ink-500">
                  {m.employeeId}
                  {m.code ? ` · code ${m.code}` : ""} · reports to {m.parentName ?? "the dealer"} · since {m.joinedIst}
                </span>
              </div>
              {m.status === "ACTIVE" && m.payoutMissing.length ? (
                <p className="text-xs text-amber-800">Before the first payout: {m.payoutMissing.join(", ")} (the member adds these on their dealer page).</p>
              ) : null}
              {isDealer && m.status === "ACTIVE" ? (
                <div className="flex flex-wrap gap-2">
                  {m.role === "AGENT" ? (
                    <>
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => post({ action: "upgrade", memberId: m.id }), `${m.name} is now a team lead.`)}>Make team lead</Button>
                      <select
                        aria-label={`Move ${m.name} under`}
                        className={`${inputClass} w-auto`}
                        value={m.parentId ?? ""}
                        disabled={busy}
                        onChange={(e) => run(() => post({ action: "reassign", memberId: m.id, parentId: e.target.value || null }), `${m.name} moved.`)}
                      >
                        <option value="">Reports to me</option>
                        {data.leads.map((l) => (
                          <option key={l.id} value={l.id}>Reports to {l.name}</option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDowngrading(downgrading === m.id ? null : m.id)}>Change to agent</Button>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Remove ${m.name}'s team role? They stay a customer; commission already earned is not affected.`)) void run(() => post({ action: "remove", memberId: m.id }), `${m.name} is a customer only now.`);
                    }}
                  >
                    Remove role
                  </Button>
                </div>
              ) : null}
              {downgrading === m.id ? <DowngradePanel lead={m} agents={agentsOf(m.id)} leads={data.leads.filter((l) => l.id !== m.id)} busy={busy} run={run} /> : null}
            </li>
          ))}
        </ul>
      </Card>

      {data.invitations.length ? (
        <Card className="space-y-2 p-4">
          <h2 className="text-base font-semibold text-ink-900">Requests ({pending.length} waiting)</h2>
          <ul className="divide-y divide-cream-200 text-sm">
            {data.invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 py-2">
                <span>{i.contact}</span>
                <Badge>{TEAM_ROLE_LABEL[i.role]}{i.parentName ? ` under ${i.parentName}` : ""}</Badge>
                <Badge tone={i.status === "ACCEPTED" ? "success" : i.status === "PENDING" ? "info" : "warning"}>{i.status.toLowerCase()}</Badge>
                <span className="text-xs text-ink-500">sent {i.createdIst}{i.status === "PENDING" ? ` · valid until ${i.expiresIst}` : ""}{i.registered ? "" : " · invite link"}</span>
                {i.status === "PENDING" ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => post({ action: "cancel", invitationId: i.id }), "Request withdrawn.")}>Withdraw</Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {isDealer && data.history.length ? (
        <Card className="space-y-2 p-4">
          <h2 className="text-base font-semibold text-ink-900">Role history (IST)</h2>
          <ul className="space-y-1 text-sm" data-testid="team-role-history">
            {data.history.map((h) => (
              <li key={h.id}>
                <span className="text-ink-500">{h.atIst}</span> — <span className="font-medium">{h.person}</span>: {ACTION_TEXT[h.action] ?? h.action}
                {h.fromValue || h.toValue ? ` (${h.fromValue ?? "—"} → ${h.toValue ?? "—"})` : ""} by {h.by}
                {h.reason ? <span className="text-ink-500"> · {h.reason}</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function ShareInvite({ invite, copied, onCopy }: { invite: InviteResult; copied: boolean; onCopy: () => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-leaf-300 bg-leaf-50 p-3 text-sm" data-testid="team-invite-share">
      <p>
        {invite.notified ? `${invite.maskedName} got the request in the app, by e-mail and SMS.` : "Share this link with the person."} It is valid until {invite.expiresIst}.
      </p>
      <p className="break-all font-mono text-xs">{invite.link}</p>
      <div className="flex flex-wrap gap-2">
        <a className="rounded-lg bg-leaf-700 px-3 py-2 font-medium text-white" href={invite.share.whatsapp} target="_blank" rel="noopener noreferrer">WhatsApp</a>
        <a className="rounded-lg border border-cream-200 bg-white px-3 py-2 font-medium" href={invite.share.sms}>SMS</a>
        <a className="rounded-lg border border-cream-200 bg-white px-3 py-2 font-medium" href={invite.share.email}>Email</a>
        <Button size="sm" variant="secondary" onClick={onCopy}>{copied ? "Copied" : "Copy link"}</Button>
      </div>
    </div>
  );
}

/** Downgrade a lead: first move each of his agents to the dealer or another lead, then change him to an agent. */
function DowngradePanel({
  lead,
  agents,
  leads,
  busy,
  run,
}: {
  lead: { id: string; name: string };
  agents: { id: string; name: string }[];
  leads: { id: string; name: string }[];
  busy: boolean;
  run: (fn: () => Promise<void>, done?: string) => Promise<void>;
}) {
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [newParent, setNewParent] = useState("");
  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm" data-testid="team-downgrade">
      {agents.length ? (
        <>
          <p>{lead.name} leads {agents.length} agent(s). Move each to yourself or another team lead first.</p>
          {agents.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-32">{a.name}</span>
              <select aria-label={`Move ${a.name} to`} className={`${inputClass} w-auto`} value={targets[a.id] ?? ""} onChange={(e) => setTargets({ ...targets, [a.id]: e.target.value })}>
                <option value="">Me (the dealer)</option>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
          ))}
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              run(async () => {
                for (const a of agents) await post({ action: "reassign", memberId: a.id, parentId: targets[a.id] || null });
              }, "Agents moved. Now change the team lead to an agent.")
            }
          >
            Move the agents
          </Button>
        </>
      ) : (
        <>
          <Field label={`${lead.name} will report to`}>
            <select className={inputClass} value={newParent} onChange={(e) => setNewParent(e.target.value)}>
              <option value="">Me (the dealer) directly</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>Team lead {l.name}</option>
              ))}
            </select>
          </Field>
          <Button size="sm" disabled={busy} onClick={() => run(() => post({ action: "downgrade", memberId: lead.id, parentId: newParent || null }), `${lead.name} is now an agent.`)}>
            Change to agent
          </Button>
        </>
      )}
    </div>
  );
}
