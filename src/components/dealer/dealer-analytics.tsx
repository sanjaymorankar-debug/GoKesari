"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";

import { Alert, Badge, Button } from "@/components/ui";
import type { ActivationRow, CoverageRow, CoverageStatus, ScoreRow } from "@/server/dealers/analytics";

const STATUS: Record<CoverageStatus, { label: string; tone: "danger" | "warning" | "success" | "neutral"; fill: string }> = {
  NO_DEALER: { label: "No dealer", tone: "danger", fill: "#b91c1c" },
  UNDER_TARGET: { label: "Under target", tone: "warning", fill: "#d97706" },
  NOT_OPERATIONAL: { label: "Not operational", tone: "warning", fill: "#a16207" },
  COVERED: { label: "Covered", tone: "success", fill: "#15803d" },
  NO_TARGET: { label: "No target set", tone: "neutral", fill: "#64748b" },
};
const rs = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
const SIZE = 320;

/**
 * A drawn map of the areas under the chosen one (no streets, nothing
 * fetched): each area at the average position of its shops, its circle sized
 * by shops and coloured by coverage status — the same approach as Nearby's
 * map without a Maps key. Areas without located shops are listed below it.
 */
function CoverageMap({ areas }: { areas: CoverageRow[] }) {
  const placed = areas.filter((a) => a.latitude != null && a.longitude != null);
  if (placed.length === 0) return <p className="text-sm text-ink-500">No shop in these areas has a map location yet, so there is nothing to draw. The table below has every area.</p>;
  const lats = placed.map((a) => a.latitude!);
  const lngs = placed.map((a) => a.longitude!);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const span = Math.max(maxLat - minLat, maxLng - minLng, 0.01);
  const pad = 30;
  // Centred, so one area (or areas close together) sits in the middle, not in a corner.
  const [midLat, midLng] = [(minLat + maxLat) / 2, (minLng + maxLng) / 2];
  const x = (lng: number) => SIZE / 2 + ((lng - midLng) / span) * (SIZE - 2 * pad);
  const y = (lat: number) => SIZE / 2 - ((lat - midLat) / span) * (SIZE - 2 * pad);
  const maxShops = Math.max(1, ...placed.map((a) => a.shops));
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-auto w-full max-w-md rounded-2xl border border-cream-200 bg-cream-50" role="img" aria-label={`Coverage map of ${placed.length} areas`}>
      {placed.map((a) => {
        const r = 6 + 16 * Math.sqrt(a.shops / maxShops);
        return (
          <g key={a.code}>
            <title>{`${a.name}: ${a.shops} shops, ${a.activeDealers} dealers — ${STATUS[a.status].label}`}</title>
            <circle cx={x(a.longitude!)} cy={y(a.latitude!)} r={r} fill={STATUS[a.status].fill} fillOpacity={0.7} stroke="#fff" strokeWidth={1.5} />
            <text x={x(a.longitude!)} y={y(a.latitude!) + r + 11} textAnchor="middle" fontSize={10} fill="#334155">
              {a.name.length > 16 ? `${a.name.slice(0, 15)}…` : a.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function DealerAnalytics({
  isAdmin,
  root,
  trail,
  areas,
  scores,
  weights,
  activation,
}: {
  isAdmin: boolean;
  root: CoverageRow | null;
  trail: { code: string; name: string }[];
  areas: CoverageRow[];
  scores: ScoreRow[];
  weights: { activatedShops: number; registrationQuality: number; activity30: number; costPerActivatedShop: number; coverage: number };
  activation: ActivationRow[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"coverage" | "score" | "activation">("coverage");

  async function setTarget(a: CoverageRow) {
    const value = window.prompt(`Target number of shops for ${a.name} (empty to remove):`, a.target == null ? "" : String(a.target));
    if (value === null) return;
    const targetShops = value.trim() === "" ? null : Number(value);
    if (targetShops != null && (!Number.isInteger(targetShops) || targetShops < 0)) return setError("Enter a whole number of shops.");
    const res = await fetch("/api/admin/dealer-analytics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ areaCode: a.code, targetShops, note: "" }) });
    const p = await res.json().catch(() => null);
    if (!res.ok) return setError(p?.error?.message ?? "That did not work.");
    setError(null);
    setNotice(targetShops == null ? `Target removed for ${a.name}.` : `Target for ${a.name}: ${targetShops} shops.`);
    router.refresh();
  }

  const gaps = areas.filter((a) => a.status === "NO_DEALER" || a.status === "UNDER_TARGET");
  const groups = [...new Set(scores.map((s) => s.peerGroup))];

  return (
    <div className="space-y-4" data-testid="dealer-analytics">
      {error ? <Alert tone="danger" title="Could not do that">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <div className="flex flex-wrap gap-2" role="tablist">
        {(
          [
            ["coverage", "Coverage"],
            ["score", "Performance score"],
            ["activation", "Activation & 30-day activity"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={clsx("min-h-11 rounded-full border px-4 text-sm font-semibold", tab === k ? "border-kesari-700 bg-kesari-700 text-white" : "border-cream-200 bg-white text-ink-700")}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "coverage" ? (
        <section className="space-y-3">
          <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Area">
            {trail.map((t, i) => (
              <span key={t.code}>
                {i > 0 ? " › " : ""}
                <Link className="font-semibold text-kesari-800 underline" href={`/admin/dealers/analytics?area=${t.code}`}>
                  {t.name}
                </Link>
              </span>
            ))}
          </nav>
          {root ? (
            <p className="text-sm text-ink-700">
              {root.name}: {root.shops} shops ({root.dealerShops} through dealers), {root.operational} operational, {root.activeDealers} active dealers
              {root.target != null ? `, target ${root.target}` : ""}. {gaps.length} of {areas.length} areas below are under-covered.
            </p>
          ) : null}
          <CoverageMap areas={areas} />
          <div className="flex flex-wrap gap-2 text-xs">
            {Object.values(STATUS).map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded-full" style={{ background: s.fill }} /> {s.label}
              </span>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-ink-600">
                <tr>
                  <th className="py-1">Area</th>
                  <th>Dealers</th>
                  <th>Shops</th>
                  <th>Target</th>
                  <th>Not operational</th>
                  <th>Status</th>
                  {isAdmin ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {areas.map((a) => (
                  <tr key={a.code} className="border-t border-cream-200">
                    <td className="py-1">
                      {a.level === "LOCALITY" ? (
                        a.name
                      ) : (
                        <Link className="font-semibold text-kesari-800 underline" href={`/admin/dealers/analytics?area=${a.code}`}>
                          {a.name}
                        </Link>
                      )}
                    </td>
                    <td>{a.activeDealers}</td>
                    <td>
                      {a.shops}
                      {a.dealerShops ? <span className="text-ink-500"> ({a.dealerShops} dealer)</span> : null}
                    </td>
                    <td>{a.target ?? "—"}</td>
                    <td>{a.notOperational}</td>
                    <td>
                      <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
                    </td>
                    {isAdmin ? (
                      <td>
                        <Button size="sm" variant="ghost" onClick={() => setTarget(a)}>
                          Set target
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-500">Not operational: registered but not live, or live with no order in the last 30 days. A dealer covers an area when its territory is the area, above it or inside it.</p>
        </section>
      ) : null}

      {tab === "score" ? (
        <section className="space-y-3">
          <p className="text-sm text-ink-700">
            Weights: activated shops {weights.activatedShops}%, registration quality {weights.registrationQuality}%, 30-day activity {weights.activity30}%, cost per activated shop {weights.costPerActivatedShop}%, coverage {weights.coverage}%.
            {isAdmin ? (
              <>
                {" "}
                <Link className="font-semibold text-kesari-800 underline" href="/admin/settings?rule=dealerPerformanceScore">
                  Change weights
                </Link>
              </>
            ) : null}{" "}
            For analysis and ranking only — the onboarding rating decides commission.
          </p>
          {scores.length === 0 ? <p className="text-sm text-ink-500">No approved dealers yet.</p> : null}
          {groups.map((g) => (
            <div key={g} className="space-y-1">
              <h3 className="font-bold text-ink-900">{g}</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="text-ink-600">
                    <tr>
                      <th className="py-1">Rank</th>
                      <th>Dealer</th>
                      <th>Score</th>
                      <th>Live shops</th>
                      <th>Quality</th>
                      <th>Active 30d</th>
                      <th>Cost / live shop</th>
                      <th>Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scores
                      .filter((s) => s.peerGroup === g)
                      .map((s) => (
                        <tr key={s.dealerId} className="border-t border-cream-200">
                          <td className="py-1">
                            {s.rank} / {s.peers}
                          </td>
                          <td>
                            <Link className="font-semibold text-kesari-800 underline" href={`/admin/dealers/${s.dealerId}`}>
                              {s.dealerName}
                            </Link>
                          </td>
                          <td className="font-bold">{s.score}</td>
                          <td>{s.facts.activated}</td>
                          <td>{s.facts.registered ? `${s.facts.registered - s.facts.poorRegistrations}/${s.facts.registered}` : "—"}</td>
                          <td>{s.facts.activated ? `${s.facts.active30}/${s.facts.activated}` : "—"}</td>
                          <td>{s.facts.costPerActivatedPaise == null ? "—" : rs(s.facts.costPerActivatedPaise)}</td>
                          <td>{s.facts.territoryAreas ? `${s.facts.areasWithShops}/${s.facts.territoryAreas} areas` : "no territory"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {tab === "activation" ? (
        <section className="space-y-2">
          {activation.length === 0 ? <p className="text-sm text-ink-500">No shops brought by dealers yet.</p> : null}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-ink-600">
                <tr>
                  <th className="py-1">Dealer / employee</th>
                  <th>Registered</th>
                  <th>Live</th>
                  <th>Activation</th>
                  <th>Ordering (30 days)</th>
                  <th>Orders (30 days)</th>
                  <th>Days to go live</th>
                </tr>
              </thead>
              <tbody>
                {activation.map((r) => (
                  <tr key={`${r.dealerId}:${r.salespersonId ?? ""}`} className={clsx("border-t border-cream-200", r.salespersonId === null && "bg-cream-50 font-semibold")}>
                    <td className={clsx("py-1", r.salespersonId !== null && "pl-4")}>{r.salespersonId === null ? r.dealerName : r.salespersonName}</td>
                    <td>{r.registered}</td>
                    <td>{r.activated}</td>
                    <td>{r.activationRate}%</td>
                    <td>
                      {r.active30} ({r.activityRate}%)
                    </td>
                    <td>{r.orders30}</td>
                    <td>{r.avgDaysToActivate ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
