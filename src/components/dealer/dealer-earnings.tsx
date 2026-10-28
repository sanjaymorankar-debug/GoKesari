"use client";

import { Badge, Card } from "@/components/ui";

interface Rating {
  rating: number;
  bonusBp: number;
  activatedShops: number;
  override: { rating: number; untilShops: number | null } | null;
  next: { minShops: number; rating: number; shopsToGo: number } | null;
  slabs: { minShops: number; rating: number }[];
  history: { oldRating: number; newRating: number; kind: string; reason: string; createdAt: string }[];
}

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const MILESTONE: Record<string, string> = { REGISTERED: "Registration completed", VERIFIED_CATALOGUE: "Verified + catalogue", ACTIVATED: "Activated" };

/**
 * The dealer's rating and commission (docs/dealer-programme, GKS-CM-002/003):
 * rating, bonus, progress to the next slab and the history; totals by status,
 * the rates in force (read only), the latest entries and the statement.
 */
export function DealerEarnings({
  rating,
  summary,
  rates,
  entries,
  bonusOn,
}: {
  rating: Rating;
  summary: Record<"earned" | "pending" | "approved" | "paid" | "reversed" | "onHold", number>;
  rates: { milestone: string; shopScope: string; districtCode: string | null; fixedPaise: number; percentBp: number }[];
  entries: { id: string; shopName: string; milestone: string; kind: string; status: string; amountPaise: number; bonusBp: number; createdAt: string }[];
  bonusOn: boolean;
}) {
  const prevMin = [...rating.slabs].filter((s) => s.minShops <= rating.activatedShops).pop()?.minShops ?? 0;
  const progress = rating.next ? Math.min(100, Math.round(((rating.activatedShops - prevMin) / Math.max(1, rating.next.minShops - prevMin)) * 100)) : 100;
  return (
    <div className="space-y-4" data-testid="dealer-earnings">
      <Card className="space-y-2 p-4" data-testid="dealer-rating">
        <h2 className="text-base font-bold text-ink-900">Your onboarding rating</h2>
        <p className="text-3xl font-bold text-ink-900">
          {rating.rating.toFixed(1)} <span className="text-base font-semibold text-leaf-700">{bonusOn ? `+${(rating.bonusBp / 100).toFixed(1)}% commission` : ""}</span>
        </p>
        <p className="text-sm text-ink-700">{rating.activatedShops} activated shops counted.</p>
        {rating.override ? <p className="text-sm text-amber-800">Set to {rating.override.rating.toFixed(1)} by GoKesari{rating.override.untilShops ? ` until you reach ${rating.override.untilShops} shops` : ""}.</p> : null}
        {rating.next ? (
          <div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-cream-100" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Progress to the next rating">
              <div className="h-full bg-leaf-600" style={{ width: `${progress}%` }} />
            </div>
            <p className="mt-1 text-sm text-ink-700">
              {rating.next.shopsToGo} more activated shops to reach {rating.next.rating.toFixed(1)} (+{Math.max(0, rating.next.rating - 5).toFixed(1)}%).
            </p>
          </div>
        ) : (
          <p className="text-sm text-ink-700">You are on the highest slab.</p>
        )}
        {rating.history.length ? (
          <details className="text-sm">
            <summary className="min-h-11 cursor-pointer py-2">Rating history</summary>
            <ul className="space-y-1 text-ink-600">
              {rating.history.map((h, i) => (
                <li key={i}>
                  {h.createdAt.slice(0, 10)}: {h.oldRating.toFixed(1)} → {h.newRating.toFixed(1)} ({h.kind.toLowerCase()}) — {h.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>

      <Card className="space-y-3 p-4" data-testid="dealer-commission">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-ink-900">Your commission</h2>
          <a href="/api/dealer/commission/statement" className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 px-3 text-sm font-medium text-ink-700 hover:bg-cream-100">
            Download statement (CSV)
          </a>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          {(
            [
              ["Earned", summary.earned],
              ["Waiting (above cap)", summary.pending],
              ["Approved", summary.approved],
              ["Paid", summary.paid],
              ["On hold", summary.onHold],
              ["Reversed", summary.reversed],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="rounded-xl bg-cream-50 p-2">
              <dt className="text-ink-500">{label}</dt>
              <dd className="text-lg font-semibold text-ink-900">{rs(v)}</dd>
            </div>
          ))}
        </dl>
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer py-2">Rates that apply now</summary>
          <ul className="space-y-1 text-ink-700">
            {rates.map((r, i) => (
              <li key={i}>
                {MILESTONE[r.milestone]} · {r.shopScope.toLowerCase()} shops{r.districtCode ? ` in ${r.districtCode}` : ""}: {[r.fixedPaise ? rs(r.fixedPaise) : null, r.percentBp ? `${r.percentBp / 100}% of the fee` : null].filter(Boolean).join(" + ")}
              </li>
            ))}
          </ul>
        </details>
        <ul className="divide-y divide-cream-200 text-sm">
          {entries.slice(0, 20).map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {e.createdAt.slice(0, 10)} · {e.shopName} · {MILESTONE[e.milestone]}
                {e.kind === "REVERSAL" ? " (reversal)" : ""}
              </span>
              <span>
                {rs(e.amountPaise)} <Badge tone={e.status === "PAID" ? "success" : e.status === "REVERSED" ? "danger" : "info"}>{e.status.toLowerCase().replace("_", " ")}</Badge>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
