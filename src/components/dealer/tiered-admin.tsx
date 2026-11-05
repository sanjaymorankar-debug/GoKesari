"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { COMMISSION_ENTRY_TYPE_LABELS, NETWORK_ROLE_LABELS, TIER_PLAN_STATUS_LABELS, formatBp, type CommissionEntryType, type TierPlanStatus } from "@/lib/dealer-tiers";
import type { TeamTreeView } from "./dealer-team";

interface Rule {
  enabled: boolean;
  directBp: number;
  leadOverrideBp: number;
  mainOverrideBp: number;
  firstPartBp: number;
  tradingOrders: number;
  tradingDays: number;
  renewalEnabled: boolean;
  renewalBp: number;
  promotionMinShops: number;
  developmentBp: number;
  developmentMonths: number;
  developmentMinShopsPerMonth: number;
  targetBonusesEnabled: boolean;
  targets: { role: "MAIN_DEALER" | "TEAM_LEAD" | "AGENT"; minShops: number; bonusPaise: number }[];
}
interface DealerRow {
  id: string;
  legalName: string;
  commissionModel: "STANDARD" | "TIERED";
  tierDirectBp: number | null;
  tierLeadOverrideBp: number | null;
  tierMainOverrideBp: number | null;
}
interface MappingRow {
  memberId: string | null;
  employeeId: string;
  name: string;
  mobileMasked: string | null;
  role: "MAIN_DEALER" | "TEAM_LEAD" | "AGENT";
  level: number;
  leadName: string | null;
  status: string;
  code: string | null;
  registered: number;
  activated: number;
  trading: number;
  active30: number;
  commissionMonthPaise: number;
  commissionAllPaise: number;
}
interface ShopRow {
  shopId: string;
  shopName: string;
  registrationNumber: string | null;
  pincode: string;
  signedBy: string;
  code: string | null;
  registeredOn: string;
  shopStatus: string;
  plan: string | null;
}
interface RequestRow {
  r: { id: string; dealerId: string; employeeId: string; name: string; note: string | null; createdAt: string };
  dealerName: string;
  requester: string;
  requesterRole: string;
}

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const toBp = (text: string) => {
  const n = Number(text.replace(/[%\s]/g, ""));
  return text.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 100);
};

/**
 * Admin → Dealers → Commission → TIERED (docs/dealer-programme/TIERED_COMMISSION.md):
 * the rule's values (edited in Settings), each dealer's model and own rates,
 * the team tree with promotion and placement, member payee details, sub-agent
 * requests, target bonuses and TDS. Only an admin changes anything (the server
 * checks again); every change asks for a reason and is audited.
 */
export function TieredAdmin({
  isAdmin,
  rule,
  tds,
  dealers,
  selected,
  tree,
  earnings,
  trading,
  requests,
  mapping = [],
  history = [],
}: {
  isAdmin: boolean;
  rule: Rule;
  tds: { enabled: boolean; rateBp: number; annualThresholdPaise: number };
  dealers: DealerRow[];
  selected: DealerRow | null;
  tree: TeamTreeView | null;
  earnings: { entryType: CommissionEntryType; level: number | null; earnedPaise: number; paidPaise: number }[];
  trading: { shopId: string; shopName: string; directName: string; status: TierPlanStatus; deliveredOrders: number; tradingOrders: number; daysLeft: number }[];
  requests: RequestRow[];
  /** Gap report A9: the team mapping table and history (server-rendered). */
  mapping?: MappingRow[];
  history?: { memberName: string; role: string; level: number; leadName: string | null; validFrom: string; validTo: string | null; reason: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rates, setRates] = useState({
    direct: selected?.tierDirectBp != null ? String(selected.tierDirectBp / 100) : "",
    lead: selected?.tierLeadOverrideBp != null ? String(selected.tierLeadOverrideBp / 100) : "",
    main: selected?.tierMainOverrideBp != null ? String(selected.tierMainOverrideBp / 100) : "",
  });
  const [member, setMember] = useState({ employeeId: "", name: "", mobile: "", role: "AGENT", parentId: "" });
  const [roleFilter, setRoleFilter] = useState("");
  const [drill, setDrill] = useState<{ name: string; shops: ShopRow[] } | null>(null);

  async function openShops(row: MappingRow) {
    if (!selected) return;
    setError(null);
    const res = await fetch(`/api/admin/dealer-tiers?dealerId=${selected.id}&view=shops&memberId=${row.memberId ?? "main"}`);
    const payload = await res.json().catch(() => null);
    if (!res.ok) return setError(payload?.error?.message ?? "Could not load the shops.");
    setDrill({ name: row.name, shops: payload.shops });
  }

  async function post(body: Record<string, unknown>, done: string, askReason = true) {
    let reason: string | null = null;
    if (askReason) {
      reason = window.prompt("Reason for this change (kept in the audit log):");
      if (!reason) return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/dealer-tiers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, ...(reason ? { reason } : {}) }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setNotice(done);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const leads = tree?.members.filter((m) => m.role === "TEAM_LEAD") ?? [];
  const everyone = tree ? tree.members.flatMap((m) => [m, ...m.agents]) : [];

  return (
    <div className="space-y-4" data-testid="tiered-admin">
      {error ? <Alert tone="danger" title="Could not do that">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!isAdmin ? <Alert tone="info">Read only: only an admin changes the TIERED model, rates, teams or payouts.</Alert> : null}

      <Card className="space-y-2 p-4" data-testid="tiered-rule">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold">TIERED model settings</h2>
          <Badge tone={rule.enabled ? "success" : "neutral"}>{rule.enabled ? "on" : "off"}</Badge>
        </div>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
          <li>
            Direct {formatBp(rule.directBp)}
            {rule.tradingOrders === 0 ? " (all of it when the shop pays and is approved)" : ` (${formatBp(rule.firstPartBp)} of it at activation, the rest at TRADING)`} · team-lead override {formatBp(rule.leadOverrideBp)} · main-dealer override{" "}
            {formatBp(rule.mainOverrideBp)} — at most {formatBp(rule.directBp + rule.leadOverrideBp + rule.mainOverrideBp)} of the fee per shop.
          </li>
          <li>
            {rule.tradingOrders === 0
              ? "No trading condition: everything is earned at activation and paid on the payout day of the next month. No per-shop cap."
              : `TRADING: ${rule.tradingOrders} delivered orders within ${rule.tradingDays} days of activation, otherwise part 2 and the overrides lapse.`}
          </li>
          <li>Renewal commission: {rule.renewalEnabled ? formatBp(rule.renewalBp) : "off"}.</li>
          <li>
            Promotion at {rule.promotionMinShops} activated shops; the former lead earns {formatBp(rule.developmentBp)} on the new team for {rule.developmentMonths} months
            {rule.developmentMinShopsPerMonth > 0 ? `, for each month the new team registers at least ${rule.developmentMinShopsPerMonth} shops` : ""}.
          </li>
          <li data-testid="target-bonuses">
            Monthly target bonuses: {rule.targetBonusesEnabled ? "on" : "off"} —{" "}
            {rule.targets.map((t) => `${NETWORK_ROLE_LABELS[t.role]} ${rs(t.bonusPaise)} at ${t.minShops} shops`).join("; ") || "none"}.
          </li>
          <li data-testid="tds-settings">
            TDS on payouts: {tds.enabled ? `on — ${formatBp(tds.rateBp)} above ${rs(tds.annualThresholdPaise)} a year` : `off (starting values ${formatBp(tds.rateBp)} above ${rs(tds.annualThresholdPaise)} a year, waiting for the CA)`}.
          </li>
        </ul>
        <p className="flex flex-wrap gap-3 text-sm">
          <Link className="font-semibold text-kesari-800 underline" href="/admin/settings?rule=dealerTieredCommission">
            Edit TIERED settings
          </Link>
          <Link className="font-semibold text-kesari-800 underline" href="/admin/settings?rule=dealerPayoutTds">
            Edit TDS settings
          </Link>
        </p>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-base font-bold">Dealer</h2>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <Field label="Choose a dealer">
            <select name="dealerId" defaultValue={selected?.id ?? ""} className={inputClass}>
              <option value="">—</option>
              {dealers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.legalName} · {d.commissionModel === "TIERED" ? "TIERED" : "standard"}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="secondary">
            Open
          </Button>
        </form>
        {selected ? (
          <div className="space-y-3">
            <p className="text-sm">
              Model: <Badge tone={selected.commissionModel === "TIERED" ? "info" : "neutral"}>{selected.commissionModel === "TIERED" ? "TIERED" : "standard (BASE_PERCENT)"}</Badge> Commission already earned is never recalculated; a
              change applies to shops activated from now on.
            </p>
            {isAdmin ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => post({ action: "setModel", dealerId: selected.id, model: selected.commissionModel === "TIERED" ? "STANDARD" : "TIERED" }, "Model changed.")}
              >
                {selected.commissionModel === "TIERED" ? "Move back to the standard model" : "Move this dealer to TIERED"}
              </Button>
            ) : null}
            {selected.commissionModel === "TIERED" ? (
              <div className="grid gap-2 sm:grid-cols-4" data-testid="dealer-tier-rates">
                <Field label="Direct %" hint={`default ${formatBp(rule.directBp)}`}>
                  <input className={inputClass} value={rates.direct} onChange={(e) => setRates({ ...rates, direct: e.target.value })} placeholder="default" />
                </Field>
                <Field label="Team-lead override %" hint={`default ${formatBp(rule.leadOverrideBp)}`}>
                  <input className={inputClass} value={rates.lead} onChange={(e) => setRates({ ...rates, lead: e.target.value })} placeholder="default" />
                </Field>
                <Field label="Main-dealer override %" hint={`default ${formatBp(rule.mainOverrideBp)}`}>
                  <input className={inputClass} value={rates.main} onChange={(e) => setRates({ ...rates, main: e.target.value })} placeholder="default" />
                </Field>
                {isAdmin ? (
                  <div className="flex items-end">
                    <Button
                      disabled={busy}
                      onClick={() => post({ action: "setRates", dealerId: selected.id, directBp: toBp(rates.direct), leadOverrideBp: toBp(rates.lead), mainOverrideBp: toBp(rates.main) }, "Rates saved.")}
                    >
                      Save rates
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      {tree ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-bold">Team tree — {tree.dealer.name}</h2>
          <p className="text-sm text-ink-700">
            Main dealer (level 1) · {tree.dealer.activatedShops} activated shops in the network {tree.dealer.agreementAccepted ? <Badge tone="success">agreement accepted</Badge> : <Badge tone="warning">agreement pending</Badge>}
          </p>
          <ul className="space-y-2 text-sm" data-testid="admin-team-tree">
            {everyone.map((m) => (
              <li key={m.id} className={`rounded-xl border border-cream-200 p-2 ${m.level === 3 ? "ml-6" : ""}`}>
                <p>
                  <span className="font-semibold">{m.name}</span> ({m.employeeId}) · {NETWORK_ROLE_LABELS[m.role]} · level {m.level} · {m.activatedShops} shops · PAN {m.panOnFile ? "on file" : "missing"} · bank{" "}
                  {m.bankStatus.toLowerCase().replace("_", " ")} {m.agreementAccepted ? null : <Badge tone="warning">agreement pending</Badge>}
                </p>
                {isAdmin ? (
                  <div className="mt-1 flex flex-wrap gap-2">
                    {m.role === "AGENT" ? (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => post({ action: "promote", memberId: m.id }, `${m.name} is now a team lead.`)}>
                        Promote to team lead
                      </Button>
                    ) : null}
                    {m.role === "AGENT" && m.activatedShops < rule.promotionMinShops ? (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => post({ action: "promote", memberId: m.id, override: true }, `${m.name} is now a team lead (override).`)}>
                        Promote anyway (override)
                      </Button>
                    ) : null}
                    {m.role === "AGENT" ? (
                      <select
                        aria-label={`Move ${m.name}`}
                        className={`${inputClass} w-auto`}
                        defaultValue=""
                        onChange={(e) => {
                          if (e.target.value) post({ action: "placeMember", memberId: m.id, role: "AGENT", parentId: e.target.value === "main" ? null : e.target.value }, `${m.name} was moved.`);
                        }}
                      >
                        <option value="">Move to…</option>
                        <option value="main">Main dealer</option>
                        {leads.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {m.bankStatus === "PENDING" || m.bankStatus === "FAILED" ? (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => post({ action: "verifyBank", memberId: m.id, verified: true }, "Bank account verified.")}>
                        Mark bank verified
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        const email = window.prompt(`Email of ${m.name}'s GoKesari account:`);
                        if (email) post({ action: "linkAccount", memberId: m.id, email }, "Account linked: they can now sign in to the dealer portal.", false);
                      }}
                    >
                      Link account
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {isAdmin ? (
            <div className="space-y-2 border-t border-cream-200 pt-3">
              <h3 className="text-sm font-bold">Add a member</h3>
              <div className="grid gap-2 sm:grid-cols-5">
                <input className={inputClass} placeholder="Employee ID" value={member.employeeId} onChange={(e) => setMember({ ...member, employeeId: e.target.value })} />
                <input className={inputClass} placeholder="Name" value={member.name} onChange={(e) => setMember({ ...member, name: e.target.value })} />
                <input className={inputClass} placeholder="Mobile" value={member.mobile} onChange={(e) => setMember({ ...member, mobile: e.target.value })} />
                <select className={inputClass} value={member.role} onChange={(e) => setMember({ ...member, role: e.target.value, parentId: "" })}>
                  <option value="AGENT">Agent</option>
                  <option value="TEAM_LEAD">Team lead</option>
                </select>
                <select className={inputClass} value={member.parentId} disabled={member.role === "TEAM_LEAD"} onChange={(e) => setMember({ ...member, parentId: e.target.value })}>
                  <option value="">Reports to the main dealer</option>
                  {leads.map((l) => (
                    <option key={l.id} value={l.id}>
                      Reports to {l.name}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                disabled={busy || !member.employeeId || !member.name || !selected}
                onClick={() =>
                  post({ action: "addMember", dealerId: selected!.id, employeeId: member.employeeId, name: member.name, mobile: member.mobile || null, role: member.role, parentId: member.parentId || null }, `${member.name} added.`, false)
                }
              >
                Add member
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {tree ? (
        <Card className="space-y-2 p-4">
          <h2 className="text-base font-bold">Earnings by type and level</h2>
          <table className="w-full text-sm" data-testid="admin-earnings">
            <tbody>
              {earnings.map((e) => (
                <tr key={`${e.entryType}-${e.level}`} className="border-t border-cream-200">
                  <td className="py-1">{COMMISSION_ENTRY_TYPE_LABELS[e.entryType]}</td>
                  <td>{e.level ? `level ${e.level}` : "—"}</td>
                  <td className="text-right">{rs(e.earnedPaise)}</td>
                  <td className="text-right text-ink-500">paid {rs(e.paidPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 className="pt-2 text-base font-bold">TRADING progress</h2>
          <ul className="divide-y divide-cream-200 text-sm" data-testid="admin-trading">
            {trading.map((t) => (
              <li key={t.shopId} className="flex flex-wrap justify-between gap-2 py-1">
                <span>
                  {t.shopName} · by {t.directName}
                </span>
                <span>
                  {t.deliveredOrders}/{t.tradingOrders} · {TIER_PLAN_STATUS_LABELS[t.status]}
                  {t.status === "PENDING" ? ` · ${t.daysLeft} days left` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {selected && mapping.length ? (
        <Card className="space-y-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-bold">Team mapping</h2>
            <span className="flex flex-wrap items-center gap-2">
              <select aria-label="Filter by role" className={`${inputClass} w-auto`} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
                <option value="">Every role</option>
                <option value="MAIN_DEALER">Main dealer</option>
                <option value="TEAM_LEAD">Team leads</option>
                <option value="AGENT">Agents</option>
              </select>
              <a
                className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 px-3 text-sm font-medium text-ink-700 hover:bg-cream-100"
                href={`/api/admin/dealer-tiers?dealerId=${selected.id}&view=mapping&format=csv${roleFilter ? `&role=${roleFilter}` : ""}`}
              >
                Download CSV
              </a>
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="team-mapping">
              <thead>
                <tr className="text-left text-xs text-ink-500">
                  <th className="py-1">Person</th>
                  <th>Role</th>
                  <th>Lead</th>
                  <th className="text-right">Registered</th>
                  <th className="text-right">Activated</th>
                  <th className="text-right">Trading</th>
                  <th className="text-right">Active 30 d</th>
                  <th className="text-right">This month</th>
                  <th className="text-right">All time</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mapping
                  .filter((r) => !roleFilter || r.role === roleFilter)
                  .map((r) => (
                    <tr key={r.memberId ?? "main"} className="border-t border-cream-200">
                      <td className="py-1">
                        {r.name} <span className="text-xs text-ink-500">{[r.employeeId, r.mobileMasked, r.code].filter(Boolean).join(" · ")}</span>
                      </td>
                      <td>
                        {NETWORK_ROLE_LABELS[r.role]} (L{r.level})
                      </td>
                      <td>{r.leadName ?? "—"}</td>
                      <td className="text-right">{r.registered}</td>
                      <td className="text-right">{r.activated}</td>
                      <td className="text-right">{r.trading}</td>
                      <td className="text-right">{r.active30}</td>
                      <td className="text-right">{rs(r.commissionMonthPaise)}</td>
                      <td className="text-right">{rs(r.commissionAllPaise)}</td>
                      <td>
                        <Button size="sm" variant="ghost" onClick={() => openShops(r)}>
                          Shops
                        </Button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {drill ? (
            <div className="space-y-1 border-t border-cream-200 pt-2" data-testid="member-shops">
              <h3 className="text-sm font-bold">Shops signed by {drill.name}</h3>
              {drill.shops.length === 0 ? <p className="text-sm text-ink-500">None yet.</p> : null}
              <ul className="space-y-1 text-sm">
                {drill.shops.map((sh) => (
                  <li key={sh.shopId}>
                    {sh.registeredOn} · {sh.shopName}
                    {sh.registrationNumber ? ` (${sh.registrationNumber})` : ""} · PIN {sh.pincode} · by {sh.signedBy}
                    {sh.code ? ` · code ${sh.code}` : ""} · {sh.shopStatus.toLowerCase().replace("_", " ")}
                    {sh.plan ? ` · ${TIER_PLAN_STATUS_LABELS[sh.plan as TierPlanStatus]}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {history.length ? (
            <details>
              <summary className="min-h-11 cursor-pointer text-sm font-semibold">Mapping history ({history.length})</summary>
              <ul className="space-y-1 text-sm" data-testid="mapping-history">
                {history.map((h, i) => (
                  <li key={i}>
                    {h.validFrom.slice(0, 10)}
                    {h.validTo ? ` → ${h.validTo.slice(0, 10)}` : " → now"} · {h.memberName}: {NETWORK_ROLE_LABELS[h.role as "AGENT"]} (L{h.level}){h.leadName ? ` under ${h.leadName}` : ""} — {h.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Card>
      ) : null}

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold">Sub-agent requests</h2>
        {requests.length === 0 ? <p className="text-sm text-ink-500">No open requests.</p> : null}
        <ul className="divide-y divide-cream-200 text-sm" data-testid="team-requests">
          {requests.map(({ r, dealerName, requester, requesterRole }) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {r.name} ({r.employeeId}) for {dealerName}, asked by {requester} ({NETWORK_ROLE_LABELS[requesterRole as "AGENT"]}){r.note ? ` — ${r.note}` : ""}
              </span>
              {isAdmin ? (
                <span className="flex gap-2">
                  <Button size="sm" disabled={busy} onClick={() => post({ action: "decideRequest", requestId: r.id, approve: true }, "Approved: the agent was added.", false)}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      const note = window.prompt("Why not? (sent to the requester)");
                      if (note) post({ action: "decideRequest", requestId: r.id, approve: false, note }, "Request declined.", false);
                    }}
                  >
                    Decline
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
