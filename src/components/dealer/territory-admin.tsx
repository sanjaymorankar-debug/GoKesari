"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { TERRITORY_STATUS_LABELS, parsePincodes, type TerritoryStatus } from "@/lib/territory-dealers";
import type { TerritoryView } from "@/server/dealers/territory";

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const pct = (bp: number) => `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
const day = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - 1).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—");
const toPaise = (rupees: string) => Math.round(Number(rupees.replace(/[,₹\s]/g, "")) * 100);

const TONES: Record<TerritoryStatus, "success" | "warning" | "danger" | "neutral"> = { ACTIVE: "success", AWAITING_FEE: "warning", EXPIRED: "danger", CANCELLED: "neutral" };

export interface TerritoryRuleView {
  enabled: boolean;
  baseShareBp: number;
  stepBp: number;
  maxShareBp: number;
  productWeightBp: number;
  liveMinProducts: number;
  termMonths: number;
  graceDays: number;
}

/** Admin → Dealers → Territories (docs/dealer-programme/TERRITORY_DEALER.md). Admins change; operators read. */
export function TerritoryAdmin({ isAdmin, rule, territories, dealers }: { isAdmin: boolean; rule: TerritoryRuleView; territories: TerritoryView[]; dealers: { id: string; legalName: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ dealerId: "", name: "", pincodes: "", fee: "" });

  async function post(body: Record<string, unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/dealer-territories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setNotice(done);
      router.refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const parsed = parsePincodes(form.pincodes);
  return (
    <div className="space-y-4">
      <Card className="space-y-1 p-4" data-testid="territory-rule">
        <p className="text-sm text-ink-700">
          Rule <code>territoryDealer</code>: {rule.enabled ? <Badge tone="success">on</Badge> : <Badge tone="warning">off — no territory can be given or paid</Badge>}
        </p>
        <p className="text-sm text-ink-700">
          Share of GoKesari&apos;s commission on each order in the territory: {pct(rule.baseShareBp)} at rating 5, +{pct(rule.stepBp)} a point, at most {pct(rule.maxShareBp)}. Rating:{" "}
          {pct(10_000 - rule.productWeightBp)} from shop onboarding, {pct(rule.productWeightBp)} from product upload (shops with at least {rule.liveMinProducts} active products). Each fee
          paid covers {rule.termMonths} months; an unpaid territory keeps its pincodes {rule.graceDays} days.{" "}
          <Link href="/admin/settings" className="font-semibold text-kesari-800 underline">
            Settings
          </Link>
        </p>
      </Card>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {isAdmin ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-bold text-ink-900">Give a dealer a territory</h2>
          <p className="text-sm text-ink-700">Only an approved dealer on the TIERED model. A pincode another territory holds is refused. The dealer pays the yearly fee on his dealer page (or you record it below); he earns from the day it is paid.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Dealer">
              <select className={inputClass} value={form.dealerId} onChange={(e) => setForm({ ...form, dealerId: e.target.value })}>
                <option value="">Choose a TIERED dealer…</option>
                {dealers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.legalName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Territory name">
              <input className={inputClass} value={form.name} maxLength={120} placeholder="e.g. Pune — Kothrud" onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Pincodes" hint={`${parsed.pincodes.length} pincode${parsed.pincodes.length === 1 ? "" : "s"}${parsed.invalid.length ? ` · not valid: ${parsed.invalid.join(", ")}` : ""}`}>
              <textarea className={inputClass} rows={3} value={form.pincodes} placeholder="411038, 411029, 411052" onChange={(e) => setForm({ ...form, pincodes: e.target.value })} />
            </Field>
            <Field label="Yearly fee (₹, GST included)">
              <input className={inputClass} inputMode="decimal" value={form.fee} placeholder="50000" onChange={(e) => setForm({ ...form, fee: e.target.value })} />
            </Field>
          </div>
          <Button
            disabled={busy || !form.dealerId || form.name.trim().length < 2 || parsed.pincodes.length === 0 || parsed.invalid.length > 0 || !(toPaise(form.fee) >= 100)}
            onClick={async () => {
              const done = await post({ action: "create", dealerId: form.dealerId, name: form.name, pincodes: parsed.pincodes, feePaise: toPaise(form.fee) }, `${form.name} was given to the dealer; he can now pay the fee.`);
              if (done) setForm({ dealerId: "", name: "", pincodes: "", fee: "" });
            }}
          >
            Give territory
          </Button>
        </Card>
      ) : null}

      {territories.length === 0 ? <p className="text-sm text-ink-500">No territories yet.</p> : null}
      {territories.map((t) => (
        <TerritoryCard key={t.id} t={t} isAdmin={isAdmin} busy={busy} post={post} />
      ))}
    </div>
  );
}

function TerritoryCard({ t, isAdmin, busy, post }: { t: TerritoryView; isAdmin: boolean; busy: boolean; post: (body: Record<string, unknown>, done: string) => Promise<boolean> }) {
  const [reference, setReference] = useState("");
  const [fee, setFee] = useState("");
  const [add, setAdd] = useState("");
  const [remove, setRemove] = useState("");
  const [reason, setReason] = useState("");
  const live = t.status !== "CANCELLED";
  return (
    <Card className="space-y-3 p-4" data-testid="territory-card">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-bold text-ink-900">{t.name}</h3>
        <Badge tone={TONES[t.status]}>{TERRITORY_STATUS_LABELS[t.status]}</Badge>
        <span className="text-sm text-ink-700">{t.dealerName}</span>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm text-ink-700 sm:grid-cols-2">
        <div>
          <dt className="inline font-medium">Pincodes: </dt>
          <dd className="inline">{t.pincodes.length ? t.pincodes.join(", ") : "released"}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Yearly fee: </dt>
          <dd className="inline">
            {rs(t.feePaise)} · paid up to {day(t.paidUntil)}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">Rating: </dt>
          <dd className="inline">
            {t.rating.toFixed(1)} → share {pct(t.shareBp)}
            {t.latestRating ? ` (onboarding +${t.latestRating.onboardingPoints}, product upload +${t.latestRating.productPoints}: ${t.latestRating.shopsLive} of ${t.latestRating.shopsTotal} shops live)` : " (not rated yet)"}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">This month so far: </dt>
          <dd className="inline">
            {t.monthSoFar.orders} orders · {rs(t.monthSoFar.commissionKeptPaise)} commission · {rs(t.monthSoFar.incomePaise)} to the dealer
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">Order income worked out: </dt>
          <dd className="inline">{rs(t.earnedPaise)} (all closed months)</dd>
        </div>
        {t.endReason ? (
          <div>
            <dt className="inline font-medium">Ended: </dt>
            <dd className="inline">{t.endReason}</dd>
          </div>
        ) : null}
      </dl>
      {t.fees.length ? (
        <details className="text-sm text-ink-700">
          <summary className="cursor-pointer font-medium">Fees ({t.fees.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {t.fees.map((f) => (
              <li key={f.id}>
                {rs(f.amountPaise)} — {f.status === "PAID" ? `paid ${f.method === "OFFLINE" ? `offline (${f.reference})` : "online"}, ${day(f.periodStart ? new Date(new Date(f.periodStart).getTime() + 1).toISOString() : null)} to ${day(f.periodEnd)}` : f.status === "AWAITING_PAYMENT" ? "waiting for payment" : "cancelled"}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {isAdmin && live ? (
        <div className="grid gap-3 border-t border-cream-200 pt-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Field label="Record a fee paid offline" hint={t.openFee ? `${rs(t.openFee.amountPaise)} due` : `next fee ${rs(t.feePaise)}`}>
              <input className={inputClass} value={reference} maxLength={120} placeholder="UTR / cheque number" onChange={(e) => setReference(e.target.value)} />
            </Field>
            <Button size="sm" variant="secondary" disabled={busy || reference.trim().length < 3} onClick={async () => (await post({ action: "recordPayment", territoryId: t.id, reference }, "Fee recorded; the territory is paid up.")) && setReference("")}>
              Record payment
            </Button>
          </div>
          <div className="space-y-2">
            <Field label="Reason (for changes below)">
              <input className={inputClass} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <input className={`${inputClass} max-w-32`} aria-label="New yearly fee in rupees" inputMode="decimal" value={fee} placeholder="New fee ₹" onChange={(e) => setFee(e.target.value)} />
              <Button size="sm" variant="secondary" disabled={busy || reason.trim().length < 5 || !(toPaise(fee) >= 100)} onClick={async () => (await post({ action: "fee", territoryId: t.id, feePaise: toPaise(fee), reason }, "Fee changed for the next payment.")) && setFee("")}>
                Change fee
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <input className={`${inputClass} max-w-40`} aria-label="Pincodes to add" value={add} placeholder="Add pincodes" onChange={(e) => setAdd(e.target.value)} />
              <input className={`${inputClass} max-w-40`} aria-label="Pincodes to release" value={remove} placeholder="Release pincodes" onChange={(e) => setRemove(e.target.value)} />
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || reason.trim().length < 5 || (!add.trim() && !remove.trim())}
                onClick={async () => {
                  const ok = await post({ action: "pincodes", territoryId: t.id, add: parsePincodes(add).pincodes, remove: parsePincodes(remove).pincodes, reason }, "Pincodes changed.");
                  if (ok) {
                    setAdd("");
                    setRemove("");
                  }
                }}
              >
                Change pincodes
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" disabled={busy || t.status !== "ACTIVE"} onClick={() => post({ action: "rate", territoryId: t.id }, "Rating worked out again.")}>
                Rate now
              </Button>
              <Button size="sm" variant="danger" disabled={busy || reason.trim().length < 5} onClick={() => post({ action: "cancel", territoryId: t.id, reason }, `${t.name} was cancelled and its pincodes released.`)}>
                Cancel territory
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
