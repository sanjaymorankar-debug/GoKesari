"use client";

/**
 * GoKesari Health Prime, the shop's screen (owner): current tier, plans with their features and the
 * Prime terms note, buy / renew (term, coupon, GST shown separately), invoices, virtual number, call log
 * and profile analytics for 7 / 30 / 90 days.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PRIME_TERM_MONTHS, PRIME_TERMS, type PrimeTerm } from "@/lib/health/constants";
import type { PrimeQuote, PrimeShopView } from "@/server/health/prime";
import { Alert, Button, Field, inputClass } from "@/components/ui";
import { LiveRefresh } from "./live";
import { amount, api, Chip, ist, Panel, Tile } from "./api";

const TERM_WORD: Record<PrimeTerm, string> = { MONTHLY: "1 month", QUARTERLY: "3 months", YEARLY: "12 months" };
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 1 : 0)}%`;

export function PrimeShop({ view }: { view: PrimeShopView }) {
  const router = useRouter();
  const buyable = view.plans.filter((p) => p.tier !== "FREE");
  const [planId, setPlanId] = useState(buyable.find((p) => p.tier === (view.tier.tier === "FREE" ? "PRIME" : view.tier.tier))?.id ?? buyable[0]?.id ?? "");
  const [term, setTerm] = useState<PrimeTerm>("YEARLY");
  const [coupon, setCoupon] = useState("");
  const [quote, setQuote] = useState<PrimeQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = buyable.find((p) => p.id === planId) ?? null;
  const owner = view.role === "OWNER";

  const getQuote = async (next: { planId?: string; term?: PrimeTerm; couponCode?: string } = {}) => {
    setError(null);
    try {
      const r = await api<{ quote: PrimeQuote }>("/api/health/prime", { json: { action: "quote", shopId: view.shop.id, planId: next.planId ?? planId, term: next.term ?? term, couponCode: (next.couponCode ?? coupon) || null } });
      setQuote(r.quote);
    } catch (e) {
      setQuote(null);
      setError(e instanceof Error ? e.message : "Could not price this plan.");
    }
  };

  const buy = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ checkoutUrl: string | null }>("/api/health/prime", { json: { action: "buy", shopId: view.shop.id, planId, term, couponCode: coupon || null } });
      if (r.checkoutUrl) window.location.href = r.checkoutUrl;
      else router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the payment.");
    } finally {
      setBusy(false);
    }
  };

  const t = view.tier;
  return (
    <div className="flex flex-col gap-4" data-testid="health-prime-shop">
      <div className="flex justify-end">
        <LiveRefresh names={["prime.", "call.missed"]} shopId={view.shop.id} />
      </div>
      <section className={`rounded-2xl border-2 p-4 ${t.tier === "FREE" ? "border-[var(--gk-line)] bg-white" : "border-amber-300 bg-amber-50"}`} data-testid="health-prime-tier">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-600">Your listing</p>
        <p className="text-2xl font-extrabold text-ink-900">
          {t.tier === "FREE" ? "Free listing" : `★ ${t.label}`} {t.inGrace ? <span className="text-base text-amber-800">(grace days)</span> : null}
        </p>
        {t.included ? (
          <p className="text-sm text-ink-800" data-testid="health-prime-included">
            Every Prime feature is included during the launch — nothing to buy. You pay only the standard registration fee and 2% on order value.
          </p>
        ) : t.tier !== "FREE" ? (
          <p className="text-sm text-ink-800">
            {t.planName} · until {ist(t.endsAt, false)}
            {t.inGrace && t.graceUntil ? ` · Prime stays on until ${ist(t.graceUntil, false)} — renew to keep it` : ""}
          </p>
        ) : (
          <p className="text-sm text-ink-700">Patients can find and call you. {view.payPerBooking.on ? `Each booking by a new patient costs ${amount(view.payPerBooking.feePaise)} (from your payout).` : ""}</p>
        )}
        {view.virtualNumber ? (
          <p className="mt-1 text-sm text-ink-800" data-testid="health-prime-number">
            GoKesari number on your profile: <strong>{view.virtualNumber.number}</strong> (forwards to {view.virtualNumber.forwardTo})
          </p>
        ) : null}
      </section>

      <Panel title="Plans">
        <p className="mb-3 text-xs text-ink-700" data-testid="health-prime-terms-note">
          {view.termsNote}
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {view.plans.map((p) => (
            <div key={p.id} className={`flex flex-col gap-2 rounded-2xl border-2 p-3 ${p.id === planId ? "border-kesari-600 bg-kesari-50" : "border-[var(--gk-line)] bg-white"}`} data-testid="health-prime-plan">
              <p className="text-lg font-extrabold text-ink-900">
                {p.tier === "FREE" ? "" : "★ "}
                {p.name}
              </p>
              {p.tier === "FREE" ? (
                <p className="text-sm font-bold text-ink-700">Free</p>
              ) : (
                <ul className="text-sm text-ink-800">
                  {PRIME_TERMS.filter((x) => p.termPrices[x] != null).map((x) => (
                    <li key={x}>
                      {TERM_WORD[x]}: <strong>{amount(p.termPrices[x])}</strong> + GST
                    </li>
                  ))}
                </ul>
              )}
              {p.description ? <p className="text-xs text-ink-700">{p.description}</p> : null}
              <ul className="list-disc pl-5 text-xs text-ink-700">
                {p.featureList.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {p.tier !== "FREE" && owner && !view.launchIncluded ? (
                <Button
                  variant={p.id === planId ? "primary" : "secondary"}
                  onClick={() => {
                    setPlanId(p.id);
                    void getQuote({ planId: p.id });
                  }}
                  data-testid="health-prime-choose"
                >
                  {t.tier === p.tier ? "Renew" : "Choose"}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
        {owner && plan && !view.launchIncluded ? (
          <div className="mt-4 flex flex-col gap-3 rounded-2xl border-2 border-kesari-300 bg-white p-3" data-testid="health-prime-buy">
            <p className="font-bold text-ink-900">
              {plan.name}
              {t.tier !== "FREE" ? " — a renewal starts when your current plan ends" : ""}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {PRIME_TERMS.filter((x) => plan.termPrices[x] != null).map((x) => (
                <Chip
                  key={x}
                  active={term === x}
                  onClick={() => {
                    setTerm(x);
                    void getQuote({ term: x });
                  }}
                  testId={`health-prime-term-${x}`}
                >
                  {TERM_WORD[x]}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Coupon (optional)">
                <input className={`${inputClass} w-44 uppercase`} value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} data-testid="health-prime-coupon" />
              </Field>
              <Button variant="secondary" onClick={() => getQuote()}>
                {quote ? "Update price" : "See price"}
              </Button>
            </div>
            {quote ? (
              <table className="w-full max-w-sm text-sm" data-testid="health-prime-quote">
                <tbody>
                  <tr>
                    <td>Plan price ({TERM_WORD[quote.term]})</td>
                    <td className="text-right tabular-nums">{amount(quote.pricePaise)}</td>
                  </tr>
                  {quote.termSavingPaise > 0 ? (
                    <tr className="text-leaf-700">
                      <td>You save vs monthly</td>
                      <td className="text-right tabular-nums">{amount(quote.termSavingPaise)}</td>
                    </tr>
                  ) : null}
                  {quote.discountPaise > 0 ? (
                    <tr className="text-leaf-700">
                      <td>
                        Coupon {quote.couponCode} ({quote.couponPercent}%)
                      </td>
                      <td className="text-right tabular-nums">− {amount(quote.discountPaise)}</td>
                    </tr>
                  ) : null}
                  <tr>
                    <td>GST {pct(quote.gstBp)}</td>
                    <td className="text-right tabular-nums">{amount(quote.gstPaise)}</td>
                  </tr>
                  <tr className="font-extrabold">
                    <td>Total</td>
                    <td className="text-right tabular-nums">{amount(quote.totalPaise)}</td>
                  </tr>
                </tbody>
              </table>
            ) : null}
            {error ? <Alert tone="danger">{error}</Alert> : null}
            <Button size="lg" onClick={buy} disabled={busy || !quote} data-testid="health-prime-pay">
              {busy ? "Please wait…" : quote ? (quote.totalPaise > 0 ? `Pay ${amount(quote.totalPaise)}` : "Activate") : "See the price first"}
            </Button>
            <p className="text-xs text-ink-600">
              {PRIME_TERM_MONTHS[term]} month{PRIME_TERM_MONTHS[term] > 1 ? "s" : ""} of Prime. A tax invoice (GST) is issued when the payment is received. After the end date, Prime stays on for {view.graceDays} grace days; bookings already made are never affected.
            </p>
          </div>
        ) : null}
      </Panel>

      <Panel title="Profile analytics">
        <div className="grid gap-3 md:grid-cols-3" data-testid="health-prime-analytics">
          {view.analytics.map((a) => (
            <div key={a.days} className="flex flex-col gap-2">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-600">Last {a.days} days</p>
              <div className="grid grid-cols-2 gap-2">
                <Tile label="Profile views" value={a.views} tone="ink" />
                <Tile label="Bookings" value={a.bookings} tone="green" />
                <Tile label="Calls" value={a.calls} tone="teal" hint={a.missedCalls ? `${a.missedCalls} missed` : undefined} />
                <Tile label="Conversion" value={a.conversionPct == null ? "—" : `${a.conversionPct}%`} tone="kesari" hint="Bookings per 100 views" />
              </div>
            </div>
          ))}
        </div>
      </Panel>

      {view.calls.length ? (
        <Panel title="Calls on your GoKesari number">
          <ul className="flex flex-col divide-y divide-cream-200 text-sm" data-testid="health-prime-calls">
            {view.calls.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {ist(c.startedAt)} · {c.caller}
                </span>
                <span className={c.status === "MISSED" ? "font-bold text-red-700" : "text-ink-700"}>{c.status === "MISSED" ? "Missed — call back" : `${Math.floor(c.durationSeconds / 60)}m ${c.durationSeconds % 60}s`}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="Plans bought and invoices">
        {view.subscriptions.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="health-prime-invoices">
              <thead>
                <tr className="text-left text-xs uppercase text-ink-600">
                  <th className="py-1">Plan</th>
                  <th>Period</th>
                  <th>Status</th>
                  <th className="text-right">Paid</th>
                  <th>Invoice</th>
                </tr>
              </thead>
              <tbody>
                {view.subscriptions.map((s) => (
                  <tr key={s.id} className="border-t border-cream-200">
                    <td className="py-2">
                      {s.planName} · {TERM_WORD[s.term as PrimeTerm] ?? s.term}
                    </td>
                    <td>{s.startsAt ? `${ist(s.startsAt, false)} – ${ist(s.endsAt, false)}` : "—"}</td>
                    <td>{s.status.replace(/_/g, " ").toLowerCase()}</td>
                    <td className="text-right tabular-nums">{amount(s.totalPaise)}</td>
                    <td>
                      {s.invoiceNumber ? (
                        <a href={`/api/health/prime/invoices/${s.id}`} target="_blank" rel="noreferrer" className="font-bold text-kesari-800 underline">
                          {s.invoiceNumber}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-ink-600">No plan bought yet.</p>
        )}
      </Panel>
    </div>
  );
}
