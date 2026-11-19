"use client";
import { useState } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";
import { TERRITORY_STATUS_LABELS, type TerritoryStatus } from "@/lib/territory-dealers";
import type { TerritoryView } from "@/server/dealers/territory";

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const pct = (bp: number) => `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
const lastDay = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - 1).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—");
const TONES: Record<TerritoryStatus, "success" | "warning" | "danger" | "neutral"> = { ACTIVE: "success", AWAITING_FEE: "warning", EXPIRED: "danger", CANCELLED: "neutral" };

/**
 * The territory dealer's territories on /dealer (docs/dealer-programme/TERRITORY_DEALER.md): pincodes,
 * paid-up date, rating and share, this month's order income so far, and paying the yearly fee online.
 */
export function DealerTerritory({ territories, rule }: { territories: TerritoryView[]; rule: { baseShareBp: number; stepBp: number; maxShareBp: number; liveMinProducts: number } }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pay(territoryId: string) {
    setBusy(territoryId);
    setError(null);
    try {
      const res = await fetch("/api/dealer/territory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ territoryId }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "The payment could not be started.");
      const url: string | null = payload?.checkoutUrl ?? null;
      if (!url) throw new Error("The payment could not be started.");
      window.location.assign(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The payment could not be started.");
      setBusy(null);
    }
  }

  return (
    <Card className="space-y-3 p-4" data-testid="dealer-territory">
      <h2 className="text-base font-bold text-ink-900">Your territory</h2>
      <p className="text-sm text-ink-700">
        You earn your team&apos;s registration commission as usual, plus {pct(rule.baseShareBp)} of GoKesari&apos;s commission on every order delivered by a shop in your territory — up to {pct(rule.maxShareBp)} as your
        rating goes up (+{pct(rule.stepBp)} a point). The rating counts the shops you bring in and how many shops in your territory have at least {rule.liveMinProducts} products live. Paid with your
        monthly commission.
      </p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {territories.map((t) => (
        <div key={t.id} className="space-y-2 rounded-lg border border-cream-200 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-ink-900">{t.name}</h3>
            <Badge tone={TONES[t.status]}>{TERRITORY_STATUS_LABELS[t.status]}</Badge>
          </div>
          <p className="text-sm text-ink-700">Pincodes: {t.pincodes.length ? t.pincodes.join(", ") : "released"}</p>
          {t.status === "ACTIVE" ? <p className="text-sm text-ink-700">Paid up to {lastDay(t.paidUntil)} · yearly fee {rs(t.feePaise)}</p> : null}
          <p className="text-sm text-ink-700">
            Rating <strong>{t.rating.toFixed(1)}</strong> → you get <strong>{pct(t.shareBp)}</strong> of GoKesari&apos;s commission
            {t.latestRating ? ` · ${t.latestRating.shopsLive} of ${t.latestRating.shopsTotal} shops in your territory have products live` : ""}
          </p>
          <p className="text-sm text-ink-700">
            This month so far: {t.monthSoFar.orders} orders · {rs(t.monthSoFar.commissionKeptPaise)} GoKesari commission · <strong>{rs(t.monthSoFar.incomePaise)}</strong> for you
          </p>
          {t.canPay && t.openFee ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy !== null} onClick={() => pay(t.id)}>
                {busy === t.id ? "Opening payment…" : `Pay ${rs(t.openFee.amountPaise)} ${t.status === "ACTIVE" ? "to renew" : "now"}`}
              </Button>
              <span className="text-xs text-ink-500">GST included. Covers 12 months from {t.status === "ACTIVE" ? "the paid-up date" : "the day you pay"}.</span>
            </div>
          ) : t.status === "AWAITING_FEE" || t.status === "EXPIRED" ? (
            <p className="text-sm text-ink-500">Pay the fee to start earning on orders in this territory.</p>
          ) : null}
        </div>
      ))}
    </Card>
  );
}
