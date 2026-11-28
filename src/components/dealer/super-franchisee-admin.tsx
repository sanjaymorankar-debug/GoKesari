"use client";

/**
 * Admin → Dealers → one dealer: super franchisee (owner, 27-Nov-2026; docs/super-franchisee/README.md).
 * Only an admin makes a dealer a super franchisee, sets his own rates, and assigns, moves or removes the dealers
 * (free or paid franchisees) in his team. Every change asks for a reason and is audited. Operators see it read-only.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { pct, toBp } from "@/components/dealer/commission-admin";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import type { SuperFranchiseeView } from "@/server/dealers/super-franchisee";

export interface SuperFranchiseeAdminProps {
  dealerId: string;
  dealerName: string;
  isAdmin: boolean;
  view: SuperFranchiseeView;
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export function SuperFranchiseeAdmin({ dealerId, dealerName, isAdmin, view: initial }: SuperFranchiseeAdminProps) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fee, setFee] = useState(view.self?.feeShareBp == null ? "" : String(view.self.feeShareBp / 100));
  const [order, setOrder] = useState(view.self?.orderShareBp == null ? "" : String(view.self.orderShareBp / 100));
  const [member, setMember] = useState("");
  const [backdate, setBackdate] = useState("0");
  const [joinSuper, setJoinSuper] = useState("");
  const [reasonText, setReasonText] = useState("");

  const isSuper = view.self?.status === "ACTIVE";

  async function send(body: Record<string, unknown>, done: string, ask = true) {
    // Owner, 28-Nov-2026: the reason is typed on the page (a browser pop-up is blocked in some browsers and apps).
    const reason = ask ? reasonText.trim() : "";
    if (ask && reason.length < 5) {
      setError("Type the reason (at least 5 characters) in the Reason box first. It is kept in the audit log.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/super-franchisees", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, reason }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      if (payload?.view && (body.action !== "assign" || body.superDealerId === dealerId)) setView(payload.view as SuperFranchiseeView);
      setNotice(done);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const ruleLine = `Default rates: ${pct(view.ruleFeeShareBp)} of fees and ${pct(view.ruleOrderShareBp)} of GoKesari's order commission (Admin → Settings → superFranchisee).`;

  return (
    <Card className="space-y-3 p-4" data-testid="super-franchisee">
      <h2 className="text-base font-bold text-ink-900">Super franchisee</h2>
      {!view.enabled ? <Alert tone="info">Switched off (rule superFranchisee): teams can be set up, but nothing is earned until an admin switches it on.</Alert> : null}
      {error ? <Alert tone="danger" title="Could not save">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {isAdmin ? (
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink-700">Reason (kept in the audit log; needed for every change here)</span>
          <input className="w-full rounded-lg border border-cream-200 bg-white px-3 py-2 text-sm" value={reasonText} onChange={(e) => setReasonText(e.target.value)} maxLength={300} aria-label="Reason" data-testid="super-franchisee-reason" />
        </label>
      ) : null}

      {isSuper && view.self ? (
        <div className="space-y-3" data-testid="super-franchisee-self">
          <p className="text-sm text-ink-700">
            {dealerName} is a super franchisee since {date(view.self.since)}. GoKesari pays him extra, on his own team only: <strong>{pct(view.self.effectiveFeeShareBp)}</strong> of every fee paid in his team and{" "}
            <strong>{pct(view.self.effectiveOrderShareBp)}</strong> of GoKesari&apos;s order commission on his team&apos;s shops (monthly). Earned so far: {rupees(view.earnedPaise.fees)} from fees, {rupees(view.earnedPaise.orders)} from orders.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="His share of fees (%)" hint={`Empty = the default, ${pct(view.ruleFeeShareBp)}.`}>
              <input className={inputClass} inputMode="decimal" value={fee} placeholder={String(view.ruleFeeShareBp / 100)} onChange={(e) => setFee(e.target.value)} disabled={!isAdmin || busy} />
            </Field>
            <Field label="His share of order commission (%)" hint={`Empty = the default, ${pct(view.ruleOrderShareBp)}.`}>
              <input className={inputClass} inputMode="decimal" value={order} placeholder={String(view.ruleOrderShareBp / 100)} onChange={(e) => setOrder(e.target.value)} disabled={!isAdmin || busy} />
            </Field>
          </div>
          {isAdmin ? (
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => send({ action: "setRates", dealerId, feeShareBp: toBp(fee), orderShareBp: toBp(order) }, "Rates saved. They apply to what is earned from now on.")}>
                Save his rates
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => send({ action: "remove", dealerId }, "Removed. His team is released; what he earned stays.")}>
                Remove as super franchisee
              </Button>
            </div>
          ) : null}

          <h3 className="pt-2 text-sm font-bold text-ink-900">His team ({view.team.length})</h3>
          {view.team.length ? (
            <ul className="divide-y divide-ink-100 text-sm" data-testid="super-franchisee-team">
              {view.team.map((t) => (
                <li key={t.dealerId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <a className="font-semibold underline" href={`/admin/dealers/${t.dealerId}`}>{t.name}</a> · {t.status.toLowerCase().replace(/_/g, " ")} · since {date(t.since)}
                  </span>
                  {isAdmin ? (
                    <Button variant="secondary" disabled={busy} onClick={() => send({ action: "unassign", memberDealerId: t.dealerId }, `${t.name} taken out of the team.`).then(() => fetch(`/api/admin/super-franchisees?dealerId=${dealerId}`).then((r) => r.json()).then((p) => p?.view && setView(p.view)))}>
                      Take out
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-700">No dealer in his team yet.</p>
          )}
          {isAdmin ? (
            <div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
              <Field label="Add or move a dealer into his team" hint="A dealer in another team is moved from it (that link ends now).">
                <select className={inputClass} value={member} onChange={(e) => setMember(e.target.value)} disabled={busy} data-testid="super-franchisee-member">
                  <option value="">Choose a dealer…</option>
                  {view.assignable.map((d) => (
                    <option key={d.dealerId} value={d.dealerId}>
                      {d.name}
                      {d.currentSuper ? ` (now in ${d.currentSuper}'s team)` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Credit fees paid in the last … days" hint="0 = only fees paid from now.">
                <input className={inputClass} inputMode="numeric" value={backdate} onChange={(e) => setBackdate(e.target.value)} disabled={busy} />
              </Field>
              <Button
                disabled={busy || !member}
                onClick={() => {
                  const days = Number(backdate || "0");
                  if (!Number.isInteger(days) || days < 0 || days > 365) {
                    setError("Days to credit back: a whole number from 0 to 365.");
                    return;
                  }
                  void send({ action: "assign", superDealerId: dealerId, memberDealerId: member, backdateDays: days }, "Dealer added to the team.").then(() => setMember(""));
                }}
              >
                Add to team
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          {view.memberOf ? (
            <p className="text-sm text-ink-700" data-testid="super-franchisee-member-of">
              In the team of <a className="font-semibold underline" href={`/admin/dealers/${view.memberOf.dealerId}`}>{view.memberOf.name}</a> since {date(view.memberOf.since)}.
            </p>
          ) : (
            <p className="text-sm text-ink-700">Not in any super franchisee&apos;s team.</p>
          )}
          {isAdmin ? (
            <div className="flex flex-wrap items-end gap-2">
              {view.memberOf ? (
                <Button variant="secondary" disabled={busy} onClick={() => send({ action: "unassign", memberDealerId: dealerId }, "Taken out of the team.")}>
                  Take out of the team
                </Button>
              ) : null}
              {view.supers.length ? (
                <>
                  <Field label={view.memberOf ? "Move to another super franchisee" : "Put in a super franchisee's team"}>
                    <select className={inputClass} value={joinSuper} onChange={(e) => setJoinSuper(e.target.value)} disabled={busy}>
                      <option value="">Choose…</option>
                      {view.supers.filter((s) => s.dealerId !== view.memberOf?.dealerId).map((s) => (
                        <option key={s.dealerId} value={s.dealerId}>{s.name}</option>
                      ))}
                    </select>
                  </Field>
                  <Button disabled={busy || !joinSuper} onClick={() => send({ action: "assign", superDealerId: joinSuper, memberDealerId: dealerId, backdateDays: 0 }, "Saved.").then(() => fetch(`/api/admin/super-franchisees?dealerId=${dealerId}`).then((r) => r.json()).then((p) => p?.view && setView(p.view)))}>
                    {view.memberOf ? "Move" : "Add"}
                  </Button>
                </>
              ) : null}
              {!view.memberOf ? (
                <Button disabled={busy} onClick={() => send({ action: "promote", dealerId }, `${dealerName} is now a super franchisee. Add the dealers of his team below.`)} data-testid="super-franchisee-promote">
                  Make super franchisee
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      <p className="text-xs text-ink-600">{ruleLine}</p>
      {view.history.length ? (
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer font-semibold text-kesari-800">Team history ({view.history.length})</summary>
          <ul className="mt-1 space-y-1">
            {view.history.map((h) => (
              <li key={`${h.superDealerId}-${h.startsAt}`}>
                {h.superName}: {date(h.startsAt)}
                {h.endsAt ? ` to ${date(h.endsAt)}` : " (current)"} · {h.endReason ?? h.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}
