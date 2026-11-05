"use client";

import { useEffect, useState } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";
import { NETWORK_ROLE_LABELS, formatBp, type NetworkRole } from "@/lib/dealer-tiers";

type PeriodKind = "MONTH" | "DAY" | "WEEK";

interface Row {
  memberId: string | null;
  name: string;
  employeeId: string | null;
  role: NetworkRole;
  level: number;
  parentName: string | null;
  status: string;
  started: number;
  registered: number;
  teamRegistered: number;
  commissionPaise: number;
  totalShops: number;
  totalCommissionPaise: number;
  paidPaise: number;
  target: {
    shops: number;
    next: { minShops: number; bonusBp: number; bonusPaise: number; toGo: number } | null;
    reached: { minShops: number; bonusBp: number; bonusPaise: number; bonusSoFarPaise: number } | null;
  };
}
interface Report {
  dealer: { name: string };
  period: { kind: PeriodKind; label: string };
  rows: Row[];
  totals: { started: number; registered: number; commissionPaise: number };
  generatedAt: string;
}

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const PERIODS: { kind: PeriodKind; label: string }[] = [
  { kind: "MONTH", label: "This month" },
  { kind: "DAY", label: "Yesterday" },
  { kind: "WEEK", label: "Last week" },
];
/** This month's figures refresh on their own: every shop that pays and is approved shows within a minute. */
const REFRESH_MS = 30_000;

const bonusWords = (t: { bonusBp: number; bonusPaise: number }) =>
  [t.bonusBp > 0 ? `${formatBp(t.bonusBp)} of your month's commission` : null, t.bonusPaise > 0 ? rs(t.bonusPaise) : null].filter(Boolean).join(" + ");

/**
 * Team performance (owner, 5 Nov 2026): what I earned this month so far — live —
 * and each person's shops and commission side by side, grouped main dealer →
 * team lead → agent, with progress towards the monthly target. `endpoint` is the
 * dealer portal's (/api/dealer/team?view=performance) or the admin's.
 * `mine`: the first row is the signed-in person (portal); false on the admin screen.
 */
export function TeamPerformance({ endpoint, mine = true }: { endpoint: string; mine?: boolean }) {
  const [kind, setKind] = useState<PeriodKind>("MONTH");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `${endpoint}${endpoint.includes("?") ? "&" : "?"}period=${kind}`;

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(url, { cache: "no-store" })
        .then(async (res) => {
          const payload = await res.json().catch(() => null);
          if (!res.ok) throw new Error(payload?.error?.message ?? "Could not load the figures.");
          if (live) {
            setReport(payload?.report ?? null);
            setError(null);
          }
        })
        .catch((caught) => {
          if (live) setError(caught instanceof Error ? caught.message : "Could not load the figures.");
        });
    void load();
    const timer = kind === "MONTH" ? setInterval(() => void load(), REFRESH_MS) : null;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [url, kind]);

  const me = mine ? report?.rows[0] : null;
  const team = report ? (mine ? report.rows.length > 1 : true) : false;

  return (
    <Card className="space-y-4 p-4" data-testid="team-performance" id="team-performance">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-ink-900">{mine ? "Your earnings and team performance" : "Team performance"}</h2>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <Button key={p.kind} size="sm" variant={kind === p.kind ? "primary" : "secondary"} aria-pressed={kind === p.kind} onClick={() => setKind(p.kind)}>
              {p.label}
            </Button>
          ))}
        </div>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!report && !error ? <p className="text-sm text-ink-600">Loading…</p> : null}

      {report ? (
        <>
          <p className="text-xs text-ink-600">
            {report.period.label}
            {kind === "MONTH" ? " · updates by itself as shops are registered" : ""} · as of{" "}
            {new Date(report.generatedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST
          </p>

          {me ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="my-earnings">
              <Stat label={kind === "MONTH" ? "Earned this month" : "Earned"} value={rs(me.commissionPaise)} strong />
              <Stat label={me.role === "AGENT" ? "Shops registered" : "Shops registered (team)"} value={String(me.role === "AGENT" ? me.registered : me.teamRegistered)} />
              <Stat label="Earned all time" value={rs(me.totalCommissionPaise)} />
              <Stat label="Paid out" value={rs(me.paidPaise)} />
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3" data-testid="team-totals">
              <Stat label="Registrations started" value={String(report.totals.started)} />
              <Stat label="Shops registered" value={String(report.totals.registered)} />
              <Stat label="Commission earned" value={rs(report.totals.commissionPaise)} strong />
            </div>
          )}

          {me ? <TargetLine row={me} /> : null}

          {team ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm" data-testid="team-performance-table">
                <thead className="text-xs text-ink-600">
                  <tr>
                    <th className="py-1 pr-2">Person</th>
                    <th className="py-1 pr-2 text-right">Started</th>
                    <th className="py-1 pr-2 text-right">Registered</th>
                    <th className="py-1 pr-2 text-right">Team</th>
                    <th className="py-1 pr-2 text-right">Commission</th>
                    <th className="py-1 pr-2">Month target</th>
                    <th className="py-1 text-right">All time</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.memberId ?? "main"} className="border-t border-cream-200 align-top">
                      <td className={`py-1 pr-2 ${r.level === 3 ? "pl-6" : r.level === 2 ? "pl-3" : ""}`}>
                        <span className="font-semibold">{r.name}</span>
                        <span className="block text-xs text-ink-600">
                          {NETWORK_ROLE_LABELS[r.role]}
                          {r.employeeId ? ` · ${r.employeeId}` : ""}
                          {r.status !== "ACTIVE" && r.status !== "APPROVED" ? ` · ${r.status.toLowerCase()}` : ""}
                        </span>
                      </td>
                      <td className="py-1 pr-2 text-right">{r.started}</td>
                      <td className="py-1 pr-2 text-right">{r.registered}</td>
                      <td className="py-1 pr-2 text-right">{r.role === "AGENT" ? "—" : r.teamRegistered}</td>
                      <td className="py-1 pr-2 text-right font-semibold">{rs(r.commissionPaise)}</td>
                      <td className="py-1 pr-2 text-xs">
                        {r.target.reached ? (
                          <Badge tone="success">reached · {rs(r.target.reached.bonusSoFarPaise)}</Badge>
                        ) : r.target.next ? (
                          `${r.target.shops}/${r.target.next.minShops}`
                        ) : (
                          r.target.shops
                        )}
                      </td>
                      <td className="py-1 text-right text-xs">
                        {r.totalShops} shops
                        <br />
                        {rs(r.totalCommissionPaise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <p className="flex flex-wrap gap-3 text-sm">
            <a className="font-semibold text-kesari-800 underline" href={`${url}&format=csv`}>
              Download (Excel / CSV)
            </a>
            <span className="text-xs text-ink-600">
              Started = registrations begun with the person&apos;s code; registered = paid and approved. Commission includes renewals and bonuses, less reversals.
            </span>
          </p>
        </>
      ) : null}
    </Card>
  );
}

function Stat({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-xl border border-cream-200 p-2">
      <p className="text-xs text-ink-600">{label}</p>
      <p className={strong ? "text-lg font-bold text-kesari-800" : "text-base font-semibold text-ink-900"}>{value}</p>
    </div>
  );
}

function TargetLine({ row }: { row: Row }) {
  const { shops, next, reached } = row.target;
  if (!next && !reached) return null;
  const counted = row.role === "AGENT" ? "shops you signed" : row.role === "TEAM_LEAD" ? "shops your team signed" : "shops your network signed";
  return (
    <div className="space-y-1" data-testid="target-progress">
      {next ? (
        <>
          <p className="text-sm text-ink-800">
            Monthly target: <strong>{shops}</strong> of {next.minShops} {counted} — {next.toGo} to go for a bonus of {bonusWords(next)}.
          </p>
          <div className="h-2 w-full rounded-full bg-cream-200" aria-hidden>
            <div className="h-2 rounded-full bg-kesari-600" style={{ width: `${Math.min(100, Math.round((shops / next.minShops) * 100))}%` }} />
          </div>
        </>
      ) : null}
      {reached ? (
        <p className="text-sm text-ink-800">
          Target of {reached.minShops} reached this month ({shops} {counted}): bonus so far <strong>{rs(reached.bonusSoFarPaise)}</strong> ({bonusWords(reached)}), paid with the month&apos;s payout. It
          starts again from zero next month.
        </p>
      ) : null}
    </div>
  );
}
