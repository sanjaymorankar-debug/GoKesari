"use client";

import clsx from "clsx";
import { useState } from "react";

import { Icon, type IconName } from "@/components/board/icons";
import { Badge, Card } from "@/components/ui";

interface Point {
  label: string;
  registered: number;
  activated: number;
}

export interface BoardData {
  totals: { registered: number; activated: number; pending: number; instant: number; duplicates: number };
  shops: {
    shopId: string;
    name: string;
    area: string;
    district: string | null;
    stage: string;
    stageLabel: string;
    approval: "INSTANT" | "ADMIN" | null;
    employee: string | null;
    matchKind: string;
    attributedAt: string;
    commissionPaise: number;
  }[];
  pending: { kind: "OWNER_CODE" | "SHOP"; id: string; title: string; detail: string; since: string }[];
  daily: Point[];
  weekly: Point[];
  monthly: Point[];
  employees: { id: string; name: string; employeeId: string; status: string; registered: number; activated: number; activationRate: number; openLeads: number; convertedLeads: number }[];
  areas: { areaCode: string; areaName: string; district: string | null; registered: number; activated: number; pending: number }[];
}

interface TileSpec {
  key: string;
  label: string;
  value: string;
  sub?: string;
  icon: IconName;
  href: string;
  tone: string;
}

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

const STAGE_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  ACTIVE: "success",
  VERIFIED: "info",
  KYC_PENDING: "warning",
  PAYMENT_PENDING: "warning",
  SUSPENDED: "danger",
  REJECTED: "danger",
  PAUSED: "neutral",
  CLOSED: "neutral",
};

/**
 * The dealer's board (docs/dealer-programme, GKS-DB-001): Tile Board tiles
 * with the counts that matter, each opening its section below; pending
 * registrations; onboarding by day, week or month; every shop with its stage
 * and how it was approved; employees' and areas' results. Own data only.
 */
export function DealerBoard({
  data,
  ratingText,
  bonusText,
  earnedPaise,
  openLeads,
  openClaims,
  activeEmployees,
}: {
  data: BoardData;
  ratingText: string;
  bonusText: string;
  earnedPaise: number;
  openLeads: number;
  openClaims: number;
  activeEmployees: number;
}) {
  const [period, setPeriod] = useState<"daily" | "weekly" | "monthly">("weekly");
  const points = data[period];
  const max = Math.max(1, ...points.map((p) => Math.max(p.registered, p.activated)));
  const tiles: TileSpec[] = [
    { key: "shops", label: "Shops registered", value: String(data.totals.registered), sub: `${data.totals.activated} live`, icon: "store", href: "#dealer-shops", tone: "border-l-kesari-600" },
    { key: "pending", label: "Pending", value: String(data.totals.pending), sub: "registrations to finish", icon: "timer", href: "#dealer-pending", tone: "border-l-amber-500" },
    { key: "rating", label: "Rating", value: ratingText, sub: bonusText, icon: "star", href: "#dealer-rating", tone: "border-l-leaf-600" },
    { key: "commission", label: "Commission", value: rs(earnedPaise), sub: "earned so far", icon: "indian-rupee", href: "#dealer-commission", tone: "border-l-leaf-600" },
    { key: "register", label: "Register a shop", value: "+", sub: "owner confirms by code", icon: "plus", href: "#dealer-register-shop", tone: "border-l-kesari-600" },
    { key: "leads", label: "Open leads", value: String(openLeads), sub: "reserved for you", icon: "map-pin", href: "#dealer-leads", tone: "border-l-sky-600" },
    { key: "employees", label: "Employees", value: String(activeEmployees), sub: "active", icon: "users", href: "#dealer-employees", tone: "border-l-sky-600" },
    { key: "claims", label: "Claims", value: String(openClaims), sub: "waiting for GoKesari", icon: "message-square", href: "#dealer-claims", tone: "border-l-ink-400" },
  ];

  return (
    <div className="space-y-4" data-testid="dealer-board">
      <nav className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Dealer board">
        {tiles.map((t) => (
          <a
            key={t.key}
            href={t.href}
            className={clsx("flex min-h-24 flex-col justify-between rounded-2xl border-2 border-l-4 border-[var(--gk-line)] bg-white p-3 hover:bg-cream-50", t.tone)}
            data-testid={`dealer-tile-${t.key}`}
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-ink-700">
              <Icon name={t.icon} size={18} />
              {t.label}
            </span>
            <span className="text-2xl font-bold text-ink-900">{t.value}</span>
            {t.sub ? <span className="text-xs text-ink-500">{t.sub}</span> : null}
          </a>
        ))}
      </nav>

      <Card className="space-y-2 p-4" id="dealer-pending" data-testid="dealer-pending">
        <h2 className="text-base font-bold text-ink-900">Pending registrations ({data.pending.length})</h2>
        {data.pending.length === 0 ? <p className="text-sm text-ink-500">Nothing waiting.</p> : null}
        <ul className="divide-y divide-cream-200 text-sm">
          {data.pending.map((p) => (
            <li key={`${p.kind}-${p.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-semibold">{p.title}</span> <span className="text-ink-600">— {p.detail}</span>
              </span>
              <span className="text-xs text-ink-500">since {p.since.slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-3 p-4" data-testid="dealer-performance">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-ink-900">Performance</h2>
          <div className="flex gap-1" role="group" aria-label="Period">
            {(["daily", "weekly", "monthly"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                aria-pressed={period === p}
                className={clsx("min-h-11 rounded-full border px-3 text-sm", period === p ? "border-kesari-700 bg-kesari-700 text-white" : "border-cream-200 bg-white text-ink-700")}
              >
                {{ daily: "Days", weekly: "Weeks", monthly: "Months" }[p]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-end gap-1 overflow-x-auto pb-1" aria-label={`Shops registered and activated by ${period.replace("ly", "")}`} role="img">
          {points.map((p) => (
            <div key={p.label} className="flex min-w-7 flex-1 flex-col items-center gap-1" title={`${p.label}: ${p.registered} registered, ${p.activated} live`}>
              <div className="flex h-28 items-end gap-0.5">
                <span className="w-2.5 rounded-t bg-kesari-500" style={{ height: `${(p.registered / max) * 100}%` }} />
                <span className="w-2.5 rounded-t bg-leaf-600" style={{ height: `${(p.activated / max) * 100}%` }} />
              </div>
              <span className="whitespace-nowrap text-[10px] text-ink-500">{p.label}</span>
            </div>
          ))}
        </div>
        <p className="flex gap-4 text-xs text-ink-600">
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded bg-kesari-500" />
            registered
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded bg-leaf-600" />
            live
          </span>
          <span>{data.totals.instant} approved instantly</span>
        </p>
      </Card>

      <Card className="space-y-2 p-4" id="dealer-shops" data-testid="dealer-shops">
        <h2 className="text-base font-bold text-ink-900">Your shops ({data.shops.length})</h2>
        {data.shops.length === 0 ? <p className="text-sm text-ink-500">No shops yet.</p> : null}
        <ul className="divide-y divide-cream-200 text-sm">
          {data.shops.map((s) => (
            <li key={s.shopId} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-ink-900">{s.name}</span>
                <span className="flex flex-wrap gap-1">
                  <Badge tone={STAGE_TONE[s.stage] ?? "neutral"}>{s.stageLabel}</Badge>
                  {s.approval ? <Badge tone="info">{s.approval === "INSTANT" ? "approved instantly" : "approved by admin"}</Badge> : null}
                  {s.matchKind !== "NONE" ? <Badge tone="warning">{s.matchKind === "BRANCH" ? "branch" : "possible duplicate"}</Badge> : null}
                </span>
              </div>
              <span className="block text-xs text-ink-500">
                {s.area}
                {s.district ? ` · ${s.district}` : ""} · {s.attributedAt.slice(0, 10)}
                {s.employee ? ` · ${s.employee}` : ""} · commission {rs(s.commissionPaise)}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-2 p-4" data-testid="dealer-employee-performance">
          <h2 className="text-base font-bold text-ink-900">Employees&apos; results</h2>
          {data.employees.length === 0 ? <p className="text-sm text-ink-500">Add employees to see their results.</p> : null}
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-ink-500">
                  <th className="p-1">Employee</th>
                  <th className="p-1">Shops</th>
                  <th className="p-1">Live</th>
                  <th className="p-1">Rate</th>
                  <th className="p-1">Leads</th>
                </tr>
              </thead>
              <tbody>
                {data.employees.map((e) => (
                  <tr key={e.id} className="border-t border-cream-200">
                    <td className="p-1">
                      {e.name} <span className="text-xs text-ink-500">{e.employeeId}</span>
                      {e.status !== "ACTIVE" ? <span className="text-xs text-ink-500"> · inactive</span> : null}
                    </td>
                    <td className="p-1">{e.registered}</td>
                    <td className="p-1">{e.activated}</td>
                    <td className="p-1">{e.activationRate}%</td>
                    <td className="p-1">
                      {e.openLeads} open · {e.convertedLeads} won
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="space-y-2 p-4" data-testid="dealer-territory">
          <h2 className="text-base font-bold text-ink-900">Your areas</h2>
          {data.areas.length === 0 ? <p className="text-sm text-ink-500">No shops yet.</p> : null}
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-ink-500">
                  <th className="p-1">Area</th>
                  <th className="p-1">Shops</th>
                  <th className="p-1">Live</th>
                  <th className="p-1">Pending</th>
                </tr>
              </thead>
              <tbody>
                {data.areas.map((a) => (
                  <tr key={a.areaCode} className="border-t border-cream-200">
                    <td className="p-1">
                      {a.areaName}
                      {a.district && a.district !== a.areaName ? <span className="text-xs text-ink-500"> · {a.district}</span> : null}
                    </td>
                    <td className="p-1">{a.registered}</td>
                    <td className="p-1">{a.activated}</td>
                    <td className="p-1">{a.pending}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
