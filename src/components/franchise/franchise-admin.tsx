"use client";
/**
 * Admin → Franchise (final brief 21-Nov-2026 08.06 IST §9): zones, zone status, business data / fees, area master,
 * coupons, franchises, monthly points, expiry, attribution, commission & bonus settings, settings, reports and the
 * send log. Operators see everything; only admins act. Times IST, money ₹ with Indian grouping.
 */
import { useCallback, useEffect, useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";
import { rupees } from "@/lib/franchise";

import { AreasTab } from "./admin/areas-tab";
import { CouponsTab } from "./admin/coupons-tab";
import { FeesTab } from "./admin/fees-tab";
import { SettingsTab } from "./admin/settings-tab";
import { COUPON_XLSX, STATUS_TONE, call, type Act, type AdminZone, type Ask, type Json, type StatusHistoryRow, type Tier } from "./admin/shared";
import { StatusTab } from "./admin/status-tab";
import { TierBadge, ZonesTab } from "./admin/zones-tab";

interface Allocation {
  id: string;
  zoneId: string;
  zoneName: string;
  slotNo: number;
  status: string;
  ownerName: string;
  ownerDealerId: string;
  activatedAtIst: string;
  expiresAtIst: string;
  daysLeft: number | null;
  tailEndAtIst: string;
  feePaise: number;
  launchOffer: boolean;
  launchSeq: number | null;
  renewals: number;
  isTest: boolean;
  bookingId: string;
}
interface Overview {
  me: { role: string };
  config: { version: number; effectiveFrom: string; config: Json };
  versions: { version: number; effectiveFrom: string; reason: string }[];
  offer: { bookingOpen: boolean; allowProvisionalSale: boolean; launch: { open: boolean; placesLeft: number; placesTotal: number; owners: number; areas: number }; closedMessage: string | null };
  zones: AdminZone[];
  areaSummary: { code: string; total: number; zoned: number; unzoned: string[] }[];
  statusHistory: StatusHistoryRow[];
  allocations: Allocation[];
  expiring: { soon: (Allocation & { red: boolean; renewal: string })[]; expired: Allocation[]; alerts: { kind: string; detail: string | null; atIst: string }[] };
  attributions: { shopId: string; shopName: string; zoneId: string; ownerName: string; reason: string | null }[];
  notifications: { id: string; kind: string; channel: string; recipient: string; status: string; sentAtIst: string; dueOn: string }[];
  points: { id: string; month: string; dealer: string; zoneId: string; code: string | null; openingShops: number; baselinePaise: number; newShops: number; actualBusinessPaise: number; regPts: number; bizPts: number; totalPts: number; mainPts: number; bonusBp: number; rateBp: number; rating: number; totalPayoutPaise: number; status: string; lockedAtIst: string; emailedAtIst: string }[];
  configAudit: { atIst: string; actorId: string | null; previous: Json | null; next: Json | null }[];
}

const TABS = ["Overview", "Zones", "Zone status", "Fees", "Areas", "Coupons", "Franchises", "Monthly points", "Expiring", "Attribution", "Commission & bonus", "Settings", "Reports", "Send log"] as const;
type Tab = (typeof TABS)[number];

const TIERS: Tier[] = ["PREMIER", "STANDARD", "EMERGING"];

/** Admin console for franchise zones. Operators see everything; only admins act. */
export function FranchiseAdmin({ isAdmin, initialTab }: { isAdmin: boolean; initialTab?: string }) {
  const [tab, setTab] = useState<Tab>(() => TABS.find((t) => t.toLowerCase().replace(/[^a-z]+/g, "-") === (initialTab ?? "").toLowerCase()) ?? (initialTab === "expiring" ? "Expiring" : "Overview"));
  const [data, setData] = useState<Overview | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const load = useCallback(async () => setData(await call<Overview>("/api/admin/franchise", "GET")), []);
  useEffect(() => {
    let alive = true;
    call<Overview>("/api/admin/franchise", "GET")
      .then((d) => alive && setData(d))
      .catch((e) => alive && setMsg({ tone: "danger", text: String(e.message) }));
    return () => {
      alive = false;
    };
  }, []);
  const act: Act = async (fn, ok) => {
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ tone: "success", text: typeof r === "object" && r && "errors" in r && Array.isArray((r as Json).errors) && ((r as Json).errors as string[]).length ? `${ok} — ${((r as Json).errors as string[]).join(" ")}` : ok });
      await load();
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : String(e) });
    }
  };
  const ask: Ask = (q) => (typeof window === "undefined" ? null : window.prompt(q));
  if (!data) return msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : <p className="text-sm text-ink-600">Loading…</p>;
  const red = data.expiring.soon.filter((s) => s.red).length;
  const real = data.zones.filter((z) => !z.isTest);
  const tierNames = (data.config.config.tierNames as Record<Tier, string>) ?? { PREMIER: "Premier", STANDARD: "Standard", EMERGING: "Emerging" };
  const statuses = [...new Set(real.map((z) => z.status))];
  return (
    <div className="space-y-4" data-testid="franchise-admin">
      <nav className="flex flex-wrap gap-2" aria-label="Franchise admin">
        {TABS.map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`min-h-10 rounded-full border px-3 text-sm ${tab === t ? "border-kesari-600 bg-kesari-600 text-white" : "border-cream-200 bg-white text-ink-700"}`}>
            {t}
            {t === "Expiring" && data.expiring.soon.length ? ` (${data.expiring.soon.length})` : ""}
            {t === "Attribution" && data.attributions.length ? ` (${data.attributions.length})` : ""}
          </button>
        ))}
      </nav>
      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
      {red ? <Alert tone="danger" title="Franchises expiring">{red} franchise(s) expire in 7 days or fewer — see Expiring.</Alert> : null}

      {tab === "Overview" ? (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2">
            <Badge tone={data.offer.bookingOpen ? "success" : "warning"}>{data.offer.bookingOpen ? "Booking open" : (data.offer.closedMessage ?? "Booking closed")}</Badge>
            <Badge tone={data.offer.allowProvisionalSale ? "warning" : "info"}>{data.offer.allowProvisionalSale ? "Provisional fees on sale" : "Provisional fees not on sale"}</Badge>
            <Badge tone="info">
              Launch: {data.offer.launch.owners} dealers · {data.offer.launch.areas} zones · {data.offer.launch.placesLeft} of {data.offer.launch.placesTotal} places left
            </Badge>
            <Badge tone="neutral">Config v{data.config.version}</Badge>
          </div>
          {isAdmin ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => act(() => call("/api/admin/franchise/config", "PUT", { patch: { bookingOpen: !data.config.config.bookingOpen }, reason: ask("Reason for switching booking " + (data.config.config.bookingOpen ? "off" : "on")) ?? "" }), "Saved")}>
                {data.config.config.bookingOpen ? "Close booking" : "Open booking"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => act(() => call("/api/admin/franchise/boundaries", "POST", { action: "test-zone" }), "Hidden test zone T-QA1 ready")}>
                Create hidden test zone
              </Button>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs text-ink-500">
                <tr>
                  <th>Tier</th>
                  <th className="text-right">Zones</th>
                  <th className="text-right">Provisional</th>
                  <th className="text-right">Active franchises</th>
                  <th className="text-right">Fee range</th>
                </tr>
              </thead>
              <tbody>
                {TIERS.map((t) => {
                  const zs = real.filter((z) => z.tier === t);
                  const fees = zs.map((z) => z.feePaise ?? 0).filter(Boolean);
                  return (
                    <tr key={t} className="border-t border-cream-100">
                      <td>{zs[0] ? <TierBadge z={{ ...zs[0], provisional: false }} /> : tierNames[t]}</td>
                      <td className="text-right">{zs.length}</td>
                      <td className="text-right">{zs.filter((z) => z.provisional).length}</td>
                      <td className="text-right">{zs.reduce((s, z) => s + z.active, 0)}</td>
                      <td className="text-right">{fees.length ? `${rupees(Math.min(...fees))} – ${rupees(Math.max(...fees))}` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs text-ink-500">
                <tr>
                  <th>Status</th>
                  <th className="text-right">Zones</th>
                </tr>
              </thead>
              <tbody>
                {statuses.map((st) => (
                  <tr key={st} className="border-t border-cream-100">
                    <td>
                      <Badge tone={STATUS_TONE[st] ?? "neutral"}>{real.find((z) => z.status === st)?.statusLabel ?? st}</Badge>
                    </td>
                    <td className="text-right">{real.filter((z) => z.status === st).length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.areaSummary.map((a) => (
            <p key={a.code} className="text-sm text-ink-700">
              Zone set {a.code}: {a.total} areas, {a.zoned} in a zone, {a.unzoned.length} unzoned{a.unzoned.length ? ` (${a.unzoned.join(", ")})` : ""}.
            </p>
          ))}
        </Card>
      ) : null}

      {tab === "Zones" ? <ZonesTab zones={data.zones} isAdmin={isAdmin} act={act} ask={ask} /> : null}

      {tab === "Zone status" ? <StatusTab zones={data.zones} history={data.statusHistory} isAdmin={isAdmin} act={act} /> : null}

      {tab === "Fees" ? <FeesTab zoneSets={(data.config.config.zoneSetsEnabled as string[]) ?? ["PUN"]} tierNames={tierNames} isAdmin={isAdmin} act={act} /> : null}

      {tab === "Areas" ? <AreasTab zones={data.zones} isAdmin={isAdmin} act={act} ask={ask} /> : null}

      {tab === "Coupons" ? <CouponsTab zones={real} tierNames={tierNames} isAdmin={isAdmin} act={act} /> : null}

      {tab === "Franchises" ? (
        <Card className="overflow-x-auto p-4">
          <AllocationTable rows={data.allocations} isAdmin={isAdmin} act={act} ask={ask} />
        </Card>
      ) : null}

      {tab === "Expiring" ? (
        <Card className="space-y-3 p-4" data-testid="admin-expiring">
          <h2 className="font-bold text-ink-900">Franchises expiring (next 30 days)</h2>
          {!data.expiring.soon.length ? <p className="text-sm text-ink-600">None.</p> : null}
          <table className="min-w-full text-sm">
            <tbody>
              {data.expiring.soon.map((a) => (
                <tr key={a.id} className={`border-t border-cream-100 ${a.red ? "bg-red-50 text-red-900" : ""}`}>
                  <td className="font-semibold">{a.zoneId}</td>
                  <td>{a.ownerName}</td>
                  <td>{a.expiresAtIst}</td>
                  <td>{a.daysLeft} day(s) left</td>
                  <td>{a.renewal}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="font-semibold text-ink-900">Expired in the last 30 days</h3>
          <ul className="text-sm text-ink-700">
            {data.expiring.expired.map((a) => (
              <li key={a.id}>
                {a.zoneId} · {a.ownerName} · expired {a.expiresAtIst} · tail to {a.tailEndAtIst}
              </li>
            ))}
          </ul>
          <h3 className="font-semibold text-ink-900">Alerts</h3>
          <ul className="text-sm text-ink-700">
            {data.expiring.alerts.map((a, i) => (
              <li key={i}>
                {a.atIst} · {a.kind} · {a.detail}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {tab === "Attribution" ? (
        <Card className="space-y-2 p-4">
          <h2 className="font-bold text-ink-900">Held franchise team shops (duplicates, disputes)</h2>
          <p className="text-xs text-ink-600">To move a shop to another zone, correct its area on the Areas tab.</p>
          {!data.attributions.length ? <p className="text-sm text-ink-600">Nothing waiting.</p> : null}
          {data.attributions.map((a) => (
            <div key={a.shopId} className="flex flex-wrap items-center justify-between gap-2 border-t border-cream-100 py-2 text-sm">
              <span>
                {a.shopName} · zone {a.zoneId} · {a.ownerName} — {a.reason}
              </span>
              {isAdmin ? (
                <span className="space-x-1">
                  <Button size="sm" onClick={() => act(() => call(`/api/admin/franchise/attributions/${a.shopId}`, "POST", { decision: "RELEASE", reason: ask("Reason for releasing") ?? "" }), "Released")}>
                    Release
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => act(() => call(`/api/admin/franchise/attributions/${a.shopId}`, "POST", { decision: "REVERSE", reason: ask("Reason for reversing") ?? "" }), "Reversed")}>
                    Reverse
                  </Button>
                </span>
              ) : null}
            </div>
          ))}
        </Card>
      ) : null}

      {tab === "Settings" ? <SettingsTab config={data.config.config} version={data.config.version} versions={data.versions} isAdmin={isAdmin} act={act} /> : null}

      {tab === "Commission & bonus" ? <BonusSettingsForm data={data} isAdmin={isAdmin} act={act} /> : null}

      {tab === "Monthly points" ? <PointsTable rows={data.points} isAdmin={isAdmin} act={act} ask={ask} /> : null}

      {tab === "Reports" ? (
        <Card className="space-y-2 p-4">
          <h2 className="font-bold text-ink-900">Reports (CSV)</h2>
          {(["fees", "occupancy", "owners", "commission"] as const).map((k) => (
            <a key={k} className="block text-sm font-semibold text-kesari-800 underline" href={`/api/admin/franchise/reports?kind=${k}&format=csv`}>
              {k === "fees" ? "Franchise fees collected" : k === "occupancy" ? "Zones: tier, status, slots and fee" : k === "owners" ? "Shops, activation rate and GMV by owner" : "Commissions payable / paid"}
            </a>
          ))}
          <a className="block text-sm font-semibold text-kesari-800 underline" href={COUPON_XLSX}>
            Coupon report (Excel)
          </a>
          {isAdmin ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const month = ask("Run the monthly calculation for month (YYYY-MM)") ?? "";
                if (/^\d{4}-\d{2}$/.test(month)) void act(() => call("/api/admin/franchise/run", "POST", { month, action: "calculate" }), `Month ${month} calculated`);
              }}
            >
              Run a month now
            </Button>
          ) : null}
        </Card>
      ) : null}

      {tab === "Send log" ? (
        <Card className="overflow-x-auto p-4">
          <table className="min-w-full text-xs">
            <tbody>
              {data.notifications.map((n) => (
                <tr key={n.id} className="border-t border-cream-100">
                  <td>{n.sentAtIst}</td>
                  <td>{n.kind}</td>
                  <td>{n.channel}</td>
                  <td>{n.recipient}</td>
                  <td>{n.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}

function AllocationTable({ rows, isAdmin, act, ask }: { rows: Allocation[]; isAdmin: boolean; act: Act; ask: Ask }) {
  return (
    <table className="min-w-full text-sm" data-testid="admin-allocations">
      <thead className="text-left text-xs text-ink-500">
        <tr>
          <th>Zone</th>
          <th>Slot</th>
          <th>Owner</th>
          <th>Status</th>
          <th>Active from</th>
          <th>Valid until</th>
          <th>Fee (locked)</th>
          <th>Launch #</th>
          {isAdmin ? <th /> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.id} className="border-t border-cream-100">
            <td className="font-semibold">
              {a.zoneId}
              {a.isTest ? " (test)" : ""}
            </td>
            <td>{a.slotNo}</td>
            <td>{a.ownerName}</td>
            <td>{a.status}</td>
            <td>{a.activatedAtIst}</td>
            <td>{a.expiresAtIst}</td>
            <td>{rupees(a.feePaise)}</td>
            <td>{a.launchSeq ?? "—"}</td>
            {isAdmin ? (
              <td className="space-x-1 whitespace-nowrap">
                {a.status === "ACTIVE" ? (
                  <Button size="sm" variant="secondary" onClick={() => act(() => call(`/api/admin/franchise/allocations/${a.id}`, "PATCH", { status: "SUSPENDED", reason: ask("Reason") ?? "" }), "Suspended")}>
                    Suspend
                  </Button>
                ) : null}
                {a.status === "SUSPENDED" ? (
                  <Button size="sm" variant="secondary" onClick={() => act(() => call(`/api/admin/franchise/allocations/${a.id}`, "PATCH", { status: "ACTIVE", reason: ask("Reason") ?? "" }), "Resumed")}>
                    Resume
                  </Button>
                ) : null}
                {a.status === "ACTIVE" || a.status === "SUSPENDED" ? (
                  <Button size="sm" variant="danger" onClick={() => act(() => call(`/api/admin/franchise/allocations/${a.id}`, "PATCH", { status: a.isTest ? "CANCELLED" : "TERMINATED", reason: ask("Reason") ?? "" }), a.isTest ? "Voided" : "Terminated")}>
                    {a.isTest ? "Void" : "Terminate"}
                  </Button>
                ) : null}
                {a.status === "ACTIVE" || a.status === "SUSPENDED" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (typeof window !== "undefined" && !window.confirm(`Refund booking ${a.bookingId.slice(0, 8)}…? Every franchise in that booking is voided, its codes closed and its coupon use released. Refund the money itself in the payment gateway.`)) return;
                      const reason = ask("Reason for the refund (logged)") ?? "";
                      if (reason.trim().length >= 5) void act(() => call(`/api/admin/franchise/bookings/${a.bookingId}/refund`, "POST", { reason }), "Booking marked refunded — refund the money in the gateway");
                    }}
                  >
                    Refund booking
                  </Button>
                ) : null}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const BONUS_FIELDS: { key: string; label: string; unit: "paise" | "bp" | "count" }[] = [
  { key: "ownerSelfBp", label: "Franchise owner's own shop (% of registration fee excl. GST)", unit: "bp" },
  { key: "ownerOverrideBp", label: "Franchise owner's override on each team shop (%)", unit: "bp" },
  { key: "recurringBaseBp", label: "Recurring base share (% of GoKesari's commission)", unit: "bp" },
  { key: "gokesariCommissionBp", label: "GoKesari order commission (%)", unit: "bp" },
  { key: "monthlyShopTarget", label: "Monthly shop registration target", unit: "count" },
  { key: "expectedBusinessPerShopPaise", label: "Expected business per shop per month (₹)", unit: "paise" },
  { key: "businessSlotPaise", label: "Business slot size (₹)", unit: "paise" },
  { key: "basePointsPerMainPoint", label: "Base points per main point", unit: "count" },
  { key: "bonusBpPerMainPoint", label: "Bonus per main point (%)", unit: "bp" },
  { key: "bonusMaxBp", label: "Maximum bonus (%)", unit: "bp" },
];

function BonusSettingsForm({ data, isAdmin, act }: { data: Overview; isAdmin: boolean; act: Act }) {
  const show = (key: string, unit: string) => {
    const v = Number(data.config.config[key] ?? 0);
    return unit === "paise" ? String(v / 100) : unit === "bp" ? String(v / 100) : String(v);
  };
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(BONUS_FIELDS.map((f) => [f.key, show(f.key, f.unit)])));
  const [reason, setReason] = useState("");
  const save = () => {
    const patch: Record<string, number> = {};
    for (const f of BONUS_FIELDS) {
      const n = Number(vals[f.key]);
      patch[f.key] = f.unit === "count" ? Math.round(n) : Math.round(n * 100);
    }
    return act(() => call("/api/admin/franchise/config", "PUT", { patch, reason }), "Saved — applies from the 1st of next month (IST)");
  };
  return (
    <Card className="space-y-3 p-4" data-testid="admin-bonus-settings">
      <h2 className="font-bold text-ink-900">Commission and bonus settings</h2>
      <p className="text-xs text-ink-600">Admin only. A change applies from the next calendar month (IST), never to the current one, and is logged with who changed it and the old and new value.</p>
      <p className="text-xs text-ink-600">
        Parity rule: the agent&apos;s direct % and the team lead&apos;s override % are one field each, used by both models (Admin → Settings → rule dealerTieredCommission). The franchise owner&apos;s rates can never be lower than the free dealer&apos;s (own shop 20%, override 4%, second override 3%) — a lower value is refused.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {BONUS_FIELDS.map((f) => (
          <label key={f.key} className="text-sm text-ink-700">
            {f.label}
            <input className={inputClass} value={vals[f.key]} readOnly={!isAdmin} inputMode="decimal" onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
          </label>
        ))}
      </div>
      {isAdmin ? (
        <div className="flex flex-wrap gap-2">
          <input className={inputClass} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button onClick={save}>Save (from next month)</Button>
        </div>
      ) : null}
      <h3 className="pt-2 font-semibold text-ink-900">Change log</h3>
      <ul className="space-y-1 text-xs text-ink-700">
        {data.configAudit.map((a, i) => (
          <li key={i}>
            {a.atIst} · by {a.actorId ?? "system"} · from {JSON.stringify(a.previous)} → {JSON.stringify(a.next)}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PointsTable({ rows, isAdmin, act, ask }: { rows: Overview["points"]; isAdmin: boolean; act: Act; ask: Ask }) {
  const month = (q: string) => {
    const m = ask(q) ?? "";
    return /^\d{4}-\d{2}$/.test(m) ? m : null;
  };
  return (
    <Card className="space-y-3 p-4" data-testid="admin-points">
      <div className="flex flex-wrap gap-2">
        {isAdmin ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => { const m = month("Recalculate month (YYYY-MM)"); if (m) void act(() => call("/api/admin/franchise/run", "POST", { month: m, action: "calculate" }), `Recalculated ${m}`); }}>
              Recalculate a month
            </Button>
            <Button size="sm" onClick={() => { const m = month("Lock month for payout (YYYY-MM) — after this it never changes"); if (m) void act(() => call("/api/admin/franchise/run", "POST", { month: m, action: "lock" }), `Locked ${m}: approve the payouts in Dealers → Commission → Payouts`); }}>
              Approve and lock a month
            </Button>
          </>
        ) : null}
        <a className="inline-flex min-h-10 items-center rounded-lg border border-cream-200 px-3 text-sm" href="/api/admin/franchise/points?format=xlsx">Export to Excel</a>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="text-left text-ink-500">
            <tr>
              <th>Month</th><th>Dealer</th><th>Zone</th><th>Code</th><th>Opening</th><th>Baseline</th><th>New</th><th>Business</th><th>Reg pts</th><th>Biz pts</th><th>Main pts</th><th>Bonus</th><th>Rate</th><th>Rating</th><th>Payout</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-cream-100">
                <td>{r.month}</td><td>{r.dealer}</td><td>{r.zoneId}</td><td className="font-mono">{r.code}</td><td>{r.openingShops}</td><td>{rupees(r.baselinePaise)}</td><td>{r.newShops}</td><td>{rupees(r.actualBusinessPaise)}</td>
                <td>{r.regPts}</td><td>{r.bizPts}</td><td>{r.mainPts.toFixed(1)}</td><td>{(r.bonusBp / 100).toFixed(1)}%</td><td>{(r.rateBp / 100).toFixed(1)}%</td><td>{r.rating.toFixed(2)}</td><td>{rupees(r.totalPayoutPaise)}</td>
                <td>{r.status}{r.status === "LOCKED" ? ` ${r.lockedAtIst}` : ""}</td>
                <td><a className="text-kesari-800 underline" href={`/api/franchise/statements/${r.id}`}>PDF</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
