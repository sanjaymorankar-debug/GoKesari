"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

interface Rule {
  id: string;
  ruleKey: string;
  version: number;
  shopScope: string;
  districtCode: string | null;
  milestone: string;
  fixedPaise: number;
  percentBp: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: string;
  changeReason: string;
}
interface Settings {
  capPaise: number;
  fixedBonusBase: "FEE" | "BASE_AMOUNT";
  catalogueMinProducts: number;
  branchEligible: boolean;
  payoutDayOfMonth: number;
  autoApproveAtMonthEnd: boolean;
}
interface ClosedMonth {
  periodMonth: string;
  closedAt: string;
  closedBy: string | null;
  autoApproved: number;
  payouts: number;
  totalPaise: number;
}
interface Entry {
  id: string;
  dealerId: string;
  dealerName: string;
  shopName: string;
  milestone: string;
  kind: string;
  status: string;
  amountPaise: number;
  bonusBp: number;
  rating: number | null;
  ruleVersion: number | null;
  aboveCap: boolean;
  payoutBatchId: string | null;
  note: string | null;
  createdAt: string;
}
interface Payout {
  id: string;
  dealerId: string;
  status: string;
  totalPaise: number;
  paymentReference: string | null;
  periodMonth?: string | null;
  createdAt: string;
}

const MILESTONE: Record<string, string> = { REGISTERED: "Registration completed", VERIFIED_CATALOGUE: "Verified + catalogue", ACTIVATED: "Activated" };
const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * Admin → Dealers → Commission (docs/dealer-programme, GKS-CM-001…003). Only an
 * admin changes anything (the server refuses everyone else); operators see it
 * read-only. Every change asks for a reason and is audited.
 */
export function CommissionAdmin({
  isAdmin,
  rules,
  settings,
  slabs,
  ledger,
  payouts,
  months = [],
  closableMonth = null,
  districts,
}: {
  isAdmin: boolean;
  rules: Rule[];
  settings: Settings;
  slabs: { minShops: number; rating: number }[];
  ledger: Entry[];
  payouts: Payout[];
  /** Monthly payout (owner, 28 Oct 2026): the months already closed, newest first. */
  months?: ClosedMonth[];
  /** The last month that is over and not yet closed — "close now" offers it. */
  closableMonth?: { month: string; label: string } | null;
  districts: { code: string; name: string }[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"rules" | "settings" | "slabs" | "ledger">("rules");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState({ ruleKey: "", shopScope: "STANDARD", districtCode: "", milestone: "REGISTERED", fixed: "", percent: "", from: new Date().toISOString().slice(0, 10), to: "" });
  const [s, setS] = useState({
    cap: String(settings.capPaise / 100),
    base: settings.fixedBonusBase,
    catalogue: String(settings.catalogueMinProducts),
    branch: settings.branchEligible,
    payoutDay: String(settings.payoutDayOfMonth),
    autoApprove: settings.autoApproveAtMonthEnd,
  });
  const [slab, setSlab] = useState({ minShops: "", rating: "" });
  const [selected, setSelected] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState("");

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
      const res = await fetch("/api/admin/dealer-commission", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, ...(reason ? { reason } : {}) }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setNotice(done);
      setSelected([]);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const current = rules.filter((r) => r.status === "ACTIVE");
  const history = rules.filter((r) => r.status !== "ACTIVE");
  const shown = statusFilter ? ledger.filter((e) => e.status === statusFilter) : ledger;
  const example = useMemo(() => {
    // The worked example the prompt asks for: a ₹1,000 fee at rating 6.0 (+1.0%).
    const fee = 100_000;
    const bonusBp = 100;
    const pct = { base: Math.round((fee * 4000) / 10_000), bonus: Math.round((fee * bonusBp) / 10_000) };
    const fixedBonus = s.base === "FEE" ? Math.round((fee * bonusBp) / 10_000) : Math.round((15_000 * bonusBp) / 10_000);
    return { pct, fixedBonus };
  }, [s.base]);

  return (
    <div className="space-y-4" data-testid="commission-admin">
      {error ? <Alert tone="danger" title="Could not do that">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!isAdmin ? <Alert tone="info">Read only: only an admin changes commission, rating or payouts.</Alert> : null}
      <nav className="flex flex-wrap gap-2" aria-label="Sections">
        {(["rules", "settings", "slabs", "ledger"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`min-h-11 rounded-full border px-4 text-sm ${tab === t ? "border-kesari-700 bg-kesari-700 text-white" : "border-cream-200 bg-white text-ink-700"}`}
          >
            {{ rules: "Rules", settings: "Settings", slabs: "Rating slabs", ledger: "Ledger & payouts" }[t]}
          </button>
        ))}
      </nav>

      {tab === "rules" ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-bold">Commission rules in force</h2>
          <p className="text-sm text-ink-700">A change makes a new version; commission already earned keeps the version it was earned under.</p>
          <ul className="divide-y divide-cream-200 text-sm" data-testid="commission-rules">
            {current.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-semibold">{MILESTONE[r.milestone]}</span> · {r.shopScope.toLowerCase()} shops · {r.districtCode ?? "all of India"} ·{" "}
                  {[r.fixedPaise ? rs(r.fixedPaise) : null, r.percentBp ? `${r.percentBp / 100}% of the fee` : null].filter(Boolean).join(" + ")} · from {r.effectiveFrom}
                  {r.effectiveTo ? ` to ${r.effectiveTo}` : ""} · v{r.version}
                </span>
                {isAdmin ? (
                  <span className="flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setDraft({ ruleKey: r.ruleKey, shopScope: r.shopScope, districtCode: r.districtCode ?? "", milestone: r.milestone, fixed: String(r.fixedPaise / 100), percent: String(r.percentBp / 100), from: new Date().toISOString().slice(0, 10), to: r.effectiveTo ?? "" })
                      }
                    >
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => post({ action: "disableRule", ruleKey: r.ruleKey }, "Rule switched off.")}>
                      Switch off
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {isAdmin ? (
            <div className="space-y-2 border-t border-cream-200 pt-3">
              <h3 className="text-sm font-semibold">{draft.ruleKey ? "Edit rule (new version)" : "Add a rule"}</h3>
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Milestone">
                  <select className={inputClass} value={draft.milestone} onChange={(e) => setDraft((d) => ({ ...d, milestone: e.target.value }))}>
                    {Object.entries(MILESTONE).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Shops">
                  <select className={inputClass} value={draft.shopScope} onChange={(e) => setDraft((d) => ({ ...d, shopScope: e.target.value }))}>
                    <option value="STANDARD">Standard shops</option>
                    <option value="WHOLESALE">Wholesale</option>
                    <option value="ALL">All shops</option>
                  </select>
                </Field>
                <Field label="State or district">
                  <select className={inputClass} value={draft.districtCode} onChange={(e) => setDraft((d) => ({ ...d, districtCode: e.target.value }))}>
                    <option value="">All of India</option>
                    {districts.map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Fixed (₹)">
                  <input className={inputClass} inputMode="decimal" value={draft.fixed} onChange={(e) => setDraft((d) => ({ ...d, fixed: e.target.value }))} />
                </Field>
                <Field label="% of the fee paid">
                  <input className={inputClass} inputMode="decimal" value={draft.percent} onChange={(e) => setDraft((d) => ({ ...d, percent: e.target.value }))} />
                </Field>
                <Field label="Effective from">
                  <input type="date" className={inputClass} value={draft.from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
                </Field>
                <Field label="Effective to (optional)">
                  <input type="date" className={inputClass} value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
                </Field>
              </div>
              <div className="flex gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    post(
                      {
                        action: "saveRule",
                        rule: {
                          ruleKey: draft.ruleKey || null,
                          shopScope: draft.shopScope,
                          districtCode: draft.districtCode || null,
                          milestone: draft.milestone,
                          fixedPaise: Math.round(Number(draft.fixed || 0) * 100),
                          percentBp: Math.round(Number(draft.percent || 0) * 100),
                          effectiveFrom: draft.from,
                          effectiveTo: draft.to || null,
                        },
                      },
                      "Rule saved.",
                    )
                  }
                >
                  Save rule
                </Button>
                {draft.ruleKey ? (
                  <Button variant="ghost" onClick={() => setDraft((d) => ({ ...d, ruleKey: "" }))}>
                    New rule instead
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {history.length ? (
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer py-2">Earlier versions ({history.length})</summary>
              <ul className="space-y-1 text-ink-600">
                {history.map((r) => (
                  <li key={r.id}>
                    v{r.version} {MILESTONE[r.milestone]} · {r.shopScope.toLowerCase()} · {rs(r.fixedPaise)} + {r.percentBp / 100}% · {r.status.toLowerCase()} · {r.changeReason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Card>
      ) : null}

      {tab === "settings" ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-bold">Cap, bonus and catalogue</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Most commission per shop, bonus included (₹)" hint="Above it needs an admin override. Keep it below the registration fee.">
              <input className={inputClass} inputMode="decimal" value={s.cap} onChange={(e) => setS((v) => ({ ...v, cap: e.target.value }))} disabled={!isAdmin} />
            </Field>
            <Field label="Products needed for 'verified + catalogue'">
              <input className={inputClass} inputMode="numeric" value={s.catalogue} onChange={(e) => setS((v) => ({ ...v, catalogue: e.target.value }))} disabled={!isAdmin} />
            </Field>
            <Field label="Rating bonus on a fixed-amount rule is figured on">
              <select className={inputClass} value={s.base} onChange={(e) => setS((v) => ({ ...v, base: e.target.value as "FEE" | "BASE_AMOUNT" }))} disabled={!isAdmin}>
                <option value="FEE">the registration fee paid</option>
                <option value="BASE_AMOUNT">the fixed commission amount</option>
              </select>
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={s.branch} onChange={(e) => setS((v) => ({ ...v, branch: e.target.checked }))} disabled={!isAdmin} />A new branch of an existing shop earns commission
            </label>
            <Field label="Monthly payout day (1–28)" hint="On this day the month before is closed: a draft payout per dealer, and each dealer's statement.">
              <input className={inputClass} inputMode="numeric" value={s.payoutDay} onChange={(e) => setS((v) => ({ ...v, payoutDay: e.target.value }))} disabled={!isAdmin} />
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={s.autoApprove} onChange={(e) => setS((v) => ({ ...v, autoApprove: e.target.checked }))} disabled={!isAdmin} />
              At the month&apos;s close, approve that month&apos;s earned commission automatically (an admin still pays)
            </label>
          </div>
          <div className="rounded-xl bg-cream-50 p-3 text-sm text-ink-700" data-testid="bonus-example">
            <p className="font-semibold">Worked example — fee ₹1,000, dealer rating 6.0 (+1.0%):</p>
            <p>Percentage rule 40%: {rs(example.pct.base)} + {rs(example.pct.bonus)} bonus = {rs(example.pct.base + example.pct.bonus)} (41%).</p>
            <p>
              Fixed rule ₹150: ₹150 + {rs(example.fixedBonus)} bonus ({s.base === "FEE" ? "1% of the ₹1,000 fee" : "1% of ₹150"}) = {rs(15_000 + example.fixedBonus)}.
            </p>
            <p>Every 0.5 of rating above 5.0 adds 0.5%. It applies to commission earned after the change, and the cap still applies.</p>
          </div>
          {isAdmin ? (
            <Button
              disabled={busy}
              onClick={() =>
                post(
                  {
                    action: "settings",
                    patch: {
                      capPaise: Math.round(Number(s.cap) * 100),
                      fixedBonusBase: s.base,
                      catalogueMinProducts: Number(s.catalogue),
                      branchEligible: s.branch,
                      payoutDayOfMonth: Number(s.payoutDay),
                      autoApproveAtMonthEnd: s.autoApprove,
                    },
                  },
                  "Settings saved.",
                )
              }
            >
              Save settings
            </Button>
          ) : null}
        </Card>
      ) : null}

      {tab === "slabs" ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-bold">Rating slabs</h2>
          <p className="text-sm text-ink-700">Activated shops (not duplicates, not reversed) → rating. Each 0.5 above 5.0 adds 0.5% commission. At most 10.0.</p>
          <ul className="divide-y divide-cream-200 text-sm" data-testid="rating-slabs">
            {slabs.map((sl) => (
              <li key={sl.minShops} className="flex items-center justify-between gap-2 py-2">
                <span>
                  {sl.minShops}+ shops → <span className="font-semibold">{sl.rating.toFixed(1)}</span> (+{Math.max(0, sl.rating - 5).toFixed(1)}%)
                </span>
                {isAdmin && sl.minShops !== 0 ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => post({ action: "deleteSlab", minShops: sl.minShops }, "Slab removed.")}>
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {isAdmin ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="From (activated shops)">
                <input className={inputClass} inputMode="numeric" value={slab.minShops} onChange={(e) => setSlab((v) => ({ ...v, minShops: e.target.value }))} />
              </Field>
              <Field label="Rating (0.5 steps)">
                <input className={inputClass} inputMode="decimal" value={slab.rating} onChange={(e) => setSlab((v) => ({ ...v, rating: e.target.value }))} />
              </Field>
              <Button disabled={busy} onClick={() => post({ action: "saveSlab", minShops: Number(slab.minShops), rating: Number(slab.rating) }, "Slab saved.")}>
                Save slab
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {tab === "ledger" ? (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-bold">Ledger</h2>
            <select className={`${inputClass} max-w-xs`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
              <option value="">Every status</option>
              {["EARNED", "PENDING", "APPROVED", "PAID", "REVERSED", "ON_HOLD"].map((st) => (
                <option key={st} value={st}>
                  {st.toLowerCase().replace("_", " ")}
                </option>
              ))}
            </select>
          </div>
          {isAdmin && selected.length ? (
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => post({ action: "approve", ids: selected }, `${selected.length} approved.`, false)}>
                Approve selected
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => post({ action: "approve", ids: selected, capOverride: true }, "Approved above the cap (override logged).")}>
                Approve above cap (override)
              </Button>
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="commission-ledger">
              <thead>
                <tr className="text-left text-ink-500">
                  <th className="p-1" />
                  <th className="p-1">Date</th>
                  <th className="p-1">Dealer</th>
                  <th className="p-1">Shop</th>
                  <th className="p-1">Milestone</th>
                  <th className="p-1">Amount</th>
                  <th className="p-1">Status</th>
                  <th className="p-1" />
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id} className="border-t border-cream-200">
                    <td className="p-1">
                      {isAdmin && (e.status === "EARNED" || e.status === "PENDING") ? (
                        <input
                          type="checkbox"
                          aria-label={`Select ${e.shopName} ${e.milestone}`}
                          checked={selected.includes(e.id)}
                          onChange={(ev) => setSelected((cur) => (ev.target.checked ? [...cur, e.id] : cur.filter((x) => x !== e.id)))}
                        />
                      ) : null}
                    </td>
                    <td className="p-1">{e.createdAt.slice(0, 10)}</td>
                    <td className="p-1">{e.dealerName}</td>
                    <td className="p-1">{e.shopName}</td>
                    <td className="p-1">
                      {MILESTONE[e.milestone]}
                      {e.kind !== "ACCRUAL" ? ` (${e.kind.toLowerCase()})` : ""}
                      {e.aboveCap ? " · above cap" : ""}
                      {e.status === "ON_HOLD" && e.note?.startsWith("held: shop approved without its documents") ? <span className="block text-xs text-ink-500">approved without documents — released when they are verified</span> : null}
                    </td>
                    <td className="p-1">
                      {rs(e.amountPaise)}
                      {e.bonusBp ? <span className="block text-xs text-ink-500">incl. +{e.bonusBp / 100}% (rating {e.rating?.toFixed(1)})</span> : null}
                    </td>
                    <td className="p-1">
                      <Badge tone={e.status === "PAID" ? "success" : e.status === "REVERSED" ? "danger" : e.status === "ON_HOLD" || e.status === "PENDING" ? "warning" : "info"}>{e.status.toLowerCase().replace("_", " ")}</Badge>
                    </td>
                    <td className="p-1">
                      {isAdmin && e.kind === "ACCRUAL" && e.status !== "REVERSED" ? (
                        <button type="button" className="min-h-11 px-1 text-kesari-800 underline" onClick={() => post({ action: "reverse", id: e.id }, "Reversed.")}>
                          Reverse
                        </button>
                      ) : null}
                      {isAdmin && e.status === "ON_HOLD" ? (
                        <button type="button" className="min-h-11 px-1 text-kesari-800 underline" onClick={() => post({ action: "release", id: e.id }, "Released.")}>
                          Release
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="pt-2 text-base font-bold">Monthly payout</h2>
          <p className="text-sm text-ink-700" data-testid="monthly-payout">
            On day {settings.payoutDayOfMonth} of each month the month before is closed automatically: one draft payout per dealer with their approved
            commission up to that month&apos;s end{settings.autoApproveAtMonthEnd ? " (that month's earned commission is approved first)" : " (only what an admin has approved)"},
            and every dealer gets their statement. Then pay each draft below and record the bank reference.
          </p>
          {isAdmin && closableMonth ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Close ${closableMonth.label} now? Draft payouts are made and every dealer is sent the statement. This runs once per month.`)) {
                  void post({ action: "closeMonth", month: closableMonth.month }, `${closableMonth.label} closed.`, false);
                }
              }}
            >
              Close {closableMonth.label} now
            </Button>
          ) : null}
          {months.length ? (
            <ul className="divide-y divide-cream-200 text-sm" data-testid="closed-months">
              {months.map((m) => (
                <li key={m.periodMonth} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>{m.periodMonth}</span>
                  <span>
                    {m.payouts} payouts · {rs(m.totalPaise)} · closed {m.closedAt.slice(0, 10)} {m.closedBy ? "by an admin" : "automatically"}
                    {m.autoApproved ? ` · ${m.autoApproved} entries approved at close` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <h2 className="pt-2 text-base font-bold">Payouts</h2>
          <p className="text-sm text-ink-700">A payout gathers a dealer&apos;s approved commission (less any reversal). Pay it by bank transfer, then record the reference here.</p>
          {isAdmin ? (
            <div className="flex flex-wrap gap-2">
              {[...new Map(ledger.filter((e) => e.status === "APPROVED" && !e.payoutBatchId).map((e) => [e.dealerId, e.dealerName])).entries()].map(([id, name]) => (
                <Button key={id} variant="secondary" size="sm" disabled={busy} onClick={() => post({ action: "createPayout", dealerId: id }, "Payout created.", false)}>
                  Create payout: {name}
                </Button>
              ))}
            </div>
          ) : null}
          <ul className="divide-y divide-cream-200 text-sm" data-testid="payouts">
            {payouts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {ledger.find((e) => e.dealerId === p.dealerId)?.dealerName ?? "Dealer"} · {rs(p.totalPaise)} · {p.periodMonth ? `${p.periodMonth} · ` : ""}
                  {p.createdAt.slice(0, 10)} <Badge tone={p.status === "PAID" ? "success" : "neutral"}>{p.status.toLowerCase()}</Badge>
                  {p.paymentReference ? <span className="text-ink-500"> · ref {p.paymentReference}</span> : null}
                </span>
                {isAdmin && p.status === "DRAFT" ? (
                  <span className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        const ref = window.prompt("Bank / UTR reference of the transfer:");
                        if (ref) void post({ action: "payoutPaid", batchId: p.id, reference: ref }, "Payout recorded as paid.", false);
                      }}
                    >
                      Mark paid
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => post({ action: "cancelPayout", batchId: p.id }, "Payout cancelled.", false)}>
                      Cancel
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
