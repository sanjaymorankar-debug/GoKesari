"use client";

/**
 * docs/dealer-platform phase 6 (brief §13): the dealer's own scheme on his portal — terms, validity, what the scheme
 * paid him (one-time / team / monthly), and other schemes he may move to by accepting their terms (and paying the
 * joining charge where there is one). Shows only the parts his scheme has.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SchemeTermsPanel } from "@/components/dealer/scheme-terms";
import { Alert, Badge, Button, Card } from "@/components/ui";
import type { SchemeTerms } from "@/lib/dealer-schemes";

const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export interface DealerSchemeCardProps {
  scheme: { name: string; version: number; terms: SchemeTerms; validUntil: string | null; category: string };
  earnings: { label: string; monthPaise: number; totalPaise: number }[];
  options: { code: string; name: string; versionId: string; termsHash: string; terms: SchemeTerms; totalPaise: number }[];
}

export function DealerSchemeCard({ scheme, earnings, options }: DealerSchemeCardProps) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hasMonthly = scheme.terms.components.some((c) => c.frequency !== "ONCE");

  async function change(o: DealerSchemeCardProps["options"][number]) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dealer/scheme/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionId: o.versionId, termsHash: o.termsHash }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "Could not change the scheme.");
      if (payload.payment?.checkoutUrl) window.location.assign(payload.payment.checkoutUrl);
      else {
        setNotice(payload.applied ? `You are now on ${o.name}.` : "Payment started.");
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the scheme.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4" data-testid="dealer-scheme-card">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-ink-900">Your scheme</h2>
        <Badge tone="info">{scheme.name}</Badge>
        <span className="text-sm text-ink-600">version {scheme.version}{scheme.validUntil ? ` · valid until ${scheme.validUntil}` : ""}</span>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer font-semibold text-kesari-800">Your terms</summary>
        <div className="mt-2"><SchemeTermsPanel terms={scheme.terms} /></div>
      </details>
      {earnings.length ? (
        <table className="w-full text-sm" data-testid="dealer-scheme-earnings">
          <thead><tr><th className="text-left">From your scheme</th><th className="text-right">This month</th><th className="text-right">In total</th></tr></thead>
          <tbody>
            {earnings.map((e) => (
              <tr key={e.label} className="border-t border-cream-200"><td className="py-1">{e.label}</td><td className="py-1 text-right">{rupees(e.monthPaise)}</td><td className="py-1 text-right">{rupees(e.totalPaise)}</td></tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-ink-600">{hasMonthly ? "Your one-time and monthly commission will show here." : "Your commission shows under Earnings below."}</p>
      )}
      {options.length && scheme.category !== "FRANCHISE" ? (
        <details className="text-sm" data-testid="dealer-scheme-options">
          <summary className="min-h-11 cursor-pointer font-semibold text-kesari-800">Change your scheme</summary>
          <p className="mt-1 text-ink-700">Your current terms stay until you accept new ones. Commission already earned is not changed.</p>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            {options.map((o) => (
              <div key={o.versionId} className="rounded-lg border border-cream-200 p-3">
                <div className="flex items-center gap-2"><h3 className="font-semibold">{o.name}</h3><span className="ml-auto font-semibold">{o.totalPaise ? rupees(o.totalPaise) : "Free"}</span></div>
                <SchemeTermsPanel terms={o.terms} />
                {open === o.versionId ? (
                  <div className="mt-2 space-y-2">
                    <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> I have read and accept the terms of {o.name}.</label>
                    <Button disabled={!accept || busy} onClick={() => change(o)}>{busy ? "Working…" : o.totalPaise ? `Accept and pay ${rupees(o.totalPaise)}` : "Accept and move"}</Button>
                  </div>
                ) : (
                  <Button className="mt-2" variant="secondary" onClick={() => { setOpen(o.versionId); setAccept(false); }}>Move to {o.name}</Button>
                )}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </Card>
  );
}
