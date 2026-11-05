"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import {
  AGENT_AGREEMENT_TEXT,
  AGENT_AGREEMENT_VERSION,
  COMMISSION_ENTRY_TYPE_LABELS,
  NETWORK_ROLE_LABELS,
  TIER_PLAN_STATUS_LABELS,
  formatBp,
  type CommissionEntryType,
  type NetworkRole,
  type TierPlanStatus,
} from "@/lib/dealer-tiers";

interface MemberView {
  id: string;
  employeeId: string;
  name: string;
  role: "TEAM_LEAD" | "AGENT";
  level: number;
  status: string;
  agreementAccepted: boolean;
  panOnFile: boolean;
  bankStatus: string;
  activatedShops: number;
  readyAgents?: number;
  mobileMasked?: string | null;
}
export interface TeamTreeView {
  dealer: { id: string; name: string; model: string; agreementAccepted: boolean; activatedShops: number };
  members: (MemberView & { agents: MemberView[] })[];
  pendingRequests: number;
}
interface Earning {
  entryType: CommissionEntryType;
  level: number | null;
  earnedPaise: number;
  paidPaise: number;
  heldPaise: number;
  reversedPaise: number;
}
interface Trading {
  shopId: string;
  shopName: string;
  directName: string;
  status: TierPlanStatus;
  deliveredOrders: number;
  tradingOrders: number;
  tradingDeadline: string;
  daysLeft: number;
  part2Paise: number;
  overridesPaise: number;
}

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const LEVEL = ["", "Level 1 (main dealer)", "Level 2", "Level 3"];

/**
 * The dealer portal's TIERED network (docs/dealer-programme/TIERED_COMMISSION.md):
 * the team tree, earnings by type and level, each shop's TRADING progress, the
 * agent agreement, and (for members) a sub-agent request and payment details.
 * Statements with gross, TDS and net are in Monthly statements below.
 */
export function DealerTeam({
  role,
  agreementAccepted,
  rates,
  tree,
  earnings,
  trading,
  payee,
}: {
  role: NetworkRole;
  agreementAccepted: boolean;
  rates: { directBp: number; leadOverrideBp: number; mainOverrideBp: number; firstPartBp: number; tradingOrders: number; tradingDays: number; renewalBp: number | null; renewalLeadBp: number; renewalMainBp: number; renewalYears: number };
  tree: TeamTreeView | null;
  earnings: Earning[];
  trading: Trading[];
  /** A team member's payment details (masked); null for the main dealer (on the dealer's application). */
  payee: { panLast4: string | null; bankLast4: string | null; bankStatus: string } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [agent, setAgent] = useState({ employeeId: "", name: "", mobile: "", note: "", role: "AGENT", parentId: "" });
  const [bank, setBank] = useState({ pan: "", bankHolderName: "", bankAccount: "", ifsc: "" });

  async function post(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/dealer/team", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

  const total = (pick: (e: Earning) => number) => earnings.reduce((s, e) => s + pick(e), 0);
  const leads = tree?.members.filter((m) => m.role === "TEAM_LEAD") ?? [];

  return (
    <Card className="space-y-4 p-4" data-testid="dealer-team">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-ink-900">Your network — {NETWORK_ROLE_LABELS[role]}</h2>
        <Badge tone="info">TIERED commission</Badge>
      </div>
      {error ? <Alert tone="danger" title="Could not do that">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {!agreementAccepted ? (
        <Alert tone="warning" title="Accept the agent agreement to be paid">
          <ul className="mb-2 list-disc space-y-1 pl-5" data-testid="agent-agreement">
            {AGENT_AGREEMENT_TEXT.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mb-2 text-xs">Version {AGENT_AGREEMENT_VERSION}. Commission you earn before accepting waits on hold and is released when you accept.</p>
          <Button disabled={busy} onClick={() => post({ action: "acceptAgreement", version: AGENT_AGREEMENT_VERSION }, "Agreement accepted. Commission on hold has been released.")}>
            I accept the agent agreement
          </Button>
        </Alert>
      ) : null}

      <p className="text-sm text-ink-700" data-testid="tier-rates">
        On every paid shop registration (fee before GST, after any coupon): {formatBp(rates.directBp)} to whoever signed it
        {rates.tradingOrders === 0
          ? ", "
          : ` — ${formatBp(rates.firstPartBp)} of that when the shop is approved, the rest when it delivers ${rates.tradingOrders} orders within ${rates.tradingDays} days — `}
        plus {formatBp(rates.leadOverrideBp)} to the agent&apos;s team lead and {formatBp(rates.mainOverrideBp)} to the main dealer
        {rates.tradingOrders === 0 ? ", all earned when the shop pays and is approved and paid on the 5th of the next month." : " at the same point."}{rates.renewalBp !== null
          ? ` Renewals (for ${rates.renewalYears} years after the shop is approved, once the renewal is paid): ${formatBp(rates.renewalBp)} to whoever signed it, ${formatBp(rates.renewalLeadBp)} to the team lead and ${formatBp(rates.renewalMainBp)} to the main dealer.`
          : ""} No joining fees, and
        nothing is ever paid for recruiting.
      </p>

      <section aria-label="Earnings" className="space-y-2">
        <h3 className="text-sm font-bold text-ink-900">Earnings by type and level</h3>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-sm">
          {(
            [
              ["Earned", total((e) => e.earnedPaise)],
              ["Paid", total((e) => e.paidPaise)],
              ["On hold", total((e) => e.heldPaise)],
              ["Reversed", total((e) => e.reversedPaise)],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded-xl bg-cream-50 p-2">
              <dt className="text-xs text-ink-500">{label}</dt>
              <dd className="font-semibold text-ink-900">{rs(value)}</dd>
            </div>
          ))}
        </dl>
        {earnings.length ? (
          <table className="w-full text-sm" data-testid="earnings-by-type">
            <thead>
              <tr className="text-left text-xs text-ink-500">
                <th className="py-1">Type</th>
                <th>Level</th>
                <th className="text-right">Earned</th>
                <th className="text-right">Paid</th>
              </tr>
            </thead>
            <tbody>
              {earnings.map((e) => (
                <tr key={`${e.entryType}-${e.level}`} className="border-t border-cream-200">
                  <td className="py-1">{COMMISSION_ENTRY_TYPE_LABELS[e.entryType]}</td>
                  <td>{e.level ? LEVEL[e.level] : "—"}</td>
                  <td className="text-right">{rs(e.earnedPaise)}</td>
                  <td className="text-right">{rs(e.paidPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-ink-500">Nothing earned yet.</p>
        )}
      </section>

      <section aria-label="Trading progress" className="space-y-2">
        <h3 className="text-sm font-bold text-ink-900">Shops on the way to TRADING</h3>
        {trading.length ? (
          <ul className="divide-y divide-cream-200 text-sm" data-testid="trading-progress">
            {trading.map((t) => (
              <li key={t.shopId} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{t.shopName}</span>
                  <Badge tone={t.status === "TRADING" ? "success" : t.status === "PENDING" ? "info" : "neutral"}>{TIER_PLAN_STATUS_LABELS[t.status]}</Badge>
                </div>
                <div className="mt-1 h-2 rounded-full bg-cream-200" role="progressbar" aria-valuemin={0} aria-valuemax={t.tradingOrders} aria-valuenow={Math.min(t.deliveredOrders, t.tradingOrders)}>
                  <div className="h-2 rounded-full bg-kesari-600" style={{ width: `${Math.min(100, (100 * t.deliveredOrders) / Math.max(1, t.tradingOrders))}%` }} />
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  {t.deliveredOrders} of {t.tradingOrders} orders delivered · signed by {t.directName}
                  {t.status === "PENDING" ? ` · ${t.daysLeft} days left · ${rs(t.part2Paise + t.overridesPaise)} to come` : ""}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-500">No activated shops yet.</p>
        )}
      </section>

      {tree ? (
        <section aria-label="Team" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-ink-900">Team</h3>
            {role === "MAIN_DEALER" ? (
              <a className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 px-3 text-sm font-medium text-ink-700 hover:bg-cream-100" href="/api/dealer/team?view=mapping&format=csv">
                Download team (CSV)
              </a>
            ) : null}
          </div>
          <ul className="space-y-2 text-sm" data-testid="team-tree">
            {role === "MAIN_DEALER" ? (
              <li className="font-semibold">
                {tree.dealer.name} · {LEVEL[1]} · {tree.dealer.activatedShops} activated shops in the network
              </li>
            ) : null}
            {tree.members.map((m) => (
              <li key={m.id} className="rounded-xl border border-cream-200 p-2">
                <p>
                  <span className="font-semibold">{m.name}</span> ({m.employeeId}{m.mobileMasked ? ` · ${m.mobileMasked}` : ""}) · {NETWORK_ROLE_LABELS[m.role]} · {LEVEL[m.level]} · {m.activatedShops} shops
                  {!m.agreementAccepted ? <Badge tone="warning">agreement pending</Badge> : null}
                  {m.status !== "ACTIVE" ? <Badge tone="neutral">inactive</Badge> : null}
                </p>
                {m.agents.length ? (
                  <ul className="mt-1 space-y-1 border-l-2 border-cream-200 pl-3">
                    {m.agents.map((a) => (
                      <li key={a.id}>
                        {a.name} ({a.employeeId}{a.mobileMasked ? ` · ${a.mobileMasked}` : ""}) · {NETWORK_ROLE_LABELS[a.role]} · {LEVEL[a.level]} · {a.activatedShops} shops
                        {!a.agreementAccepted ? <Badge tone="warning">agreement pending</Badge> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {role === "MAIN_DEALER" ? (
        <section aria-label="Add a team member" className="space-y-2">
          <h3 className="text-sm font-bold text-ink-900">Add a team member</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Employee ID">
              <input className={inputClass} value={agent.employeeId} onChange={(e) => setAgent({ ...agent, employeeId: e.target.value })} />
            </Field>
            <Field label="Name">
              <input className={inputClass} value={agent.name} onChange={(e) => setAgent({ ...agent, name: e.target.value })} />
            </Field>
            <Field label="Mobile (optional)">
              <input className={inputClass} inputMode="numeric" value={agent.mobile} onChange={(e) => setAgent({ ...agent, mobile: e.target.value })} />
            </Field>
            <Field label="Role">
              <select className={inputClass} value={agent.role} onChange={(e) => setAgent({ ...agent, role: e.target.value, parentId: e.target.value === "TEAM_LEAD" ? "" : agent.parentId })}>
                <option value="AGENT">Agent</option>
                <option value="TEAM_LEAD">Team lead</option>
              </select>
            </Field>
            {agent.role === "AGENT" ? (
              <Field label="Reports to" hint="An agent reports to a team lead or straight to you — never to another agent (at most 3 levels).">
                <select className={inputClass} value={agent.parentId} onChange={(e) => setAgent({ ...agent, parentId: e.target.value })}>
                  <option value="">Me (main dealer)</option>
                  {leads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({l.employeeId})
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>
          <Button
            disabled={busy || !agent.employeeId.trim() || !agent.name.trim()}
            onClick={() =>
              post({ action: "addMember", employeeId: agent.employeeId, name: agent.name, mobile: agent.mobile || null, role: agent.role, parentId: agent.parentId || null }, `${agent.name} was added to your team with their own code.`)
            }
          >
            Add to my team
          </Button>
        </section>
      ) : (
        <section aria-label="Ask for a sub-agent" className="space-y-2">
          <h3 className="text-sm font-bold text-ink-900">Ask for a sub-agent</h3>
          <p className="text-sm text-ink-700">You cannot appoint a sub-agent yourself: GoKesari reviews the request. You earn nothing for recruiting — only on shops that pay their fee.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Their ID">
              <input className={inputClass} value={agent.employeeId} onChange={(e) => setAgent({ ...agent, employeeId: e.target.value })} />
            </Field>
            <Field label="Name">
              <input className={inputClass} value={agent.name} onChange={(e) => setAgent({ ...agent, name: e.target.value })} />
            </Field>
            <Field label="Mobile (optional)">
              <input className={inputClass} inputMode="numeric" value={agent.mobile} onChange={(e) => setAgent({ ...agent, mobile: e.target.value })} />
            </Field>
            <Field label="Note (optional)">
              <input className={inputClass} value={agent.note} onChange={(e) => setAgent({ ...agent, note: e.target.value })} />
            </Field>
          </div>
          <Button
            disabled={busy || !agent.employeeId.trim() || !agent.name.trim()}
            onClick={() => post({ action: "requestSubAgent", employeeId: agent.employeeId, name: agent.name, mobile: agent.mobile || null, note: agent.note || null }, "Request sent. You will hear when it is decided.")}
          >
            Send the request
          </Button>
        </section>
      )}

      {payee ? (
        <section aria-label="Payment details" className="space-y-2">
          <h3 className="text-sm font-bold text-ink-900">Your payment details</h3>
          <p className="text-sm text-ink-700">
            PAN {payee.panLast4 ? `••••${payee.panLast4}` : "not given"} · bank {payee.bankLast4 ? `••••${payee.bankLast4}` : "not given"}{" "}
            <Badge tone={payee.bankStatus === "VERIFIED" ? "success" : "warning"}>{payee.bankStatus.toLowerCase().replace("_", " ")}</Badge>. A payout is paid only with your PAN and a verified
            bank account.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="PAN">
              <input className={inputClass} value={bank.pan} onChange={(e) => setBank({ ...bank, pan: e.target.value.toUpperCase() })} maxLength={10} />
            </Field>
            <Field label="Account holder">
              <input className={inputClass} value={bank.bankHolderName} onChange={(e) => setBank({ ...bank, bankHolderName: e.target.value })} />
            </Field>
            <Field label="Account number">
              <input className={inputClass} inputMode="numeric" value={bank.bankAccount} onChange={(e) => setBank({ ...bank, bankAccount: e.target.value })} />
            </Field>
            <Field label="IFSC">
              <input className={inputClass} value={bank.ifsc} onChange={(e) => setBank({ ...bank, ifsc: e.target.value.toUpperCase() })} maxLength={11} />
            </Field>
          </div>
          <Button
            variant="secondary"
            disabled={busy || (!bank.pan && !bank.bankAccount)}
            onClick={() => post({ action: "payee", pan: bank.pan || null, ...(bank.bankAccount ? { bankHolderName: bank.bankHolderName, bankAccount: bank.bankAccount, ifsc: bank.ifsc } : {}) }, "Saved. The bank account is checked before your first payout.")}
          >
            Save payment details
          </Button>
        </section>
      ) : null}
    </Card>
  );
}
