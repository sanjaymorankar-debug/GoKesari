"use client";
import { useCallback, useEffect, useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";
import { ZONE_BADGE_LABELS, crore, rupees, type ZoneBadge } from "@/lib/franchise";

type Json = Record<string, unknown>;
interface Zone {
  zoneId: string;
  clusterCode: string;
  name: string;
  status: string;
  statusReason: string | null;
  isTest: boolean;
  maxOwners: number;
  occupied: number;
  slotsFree: number;
  badge: ZoneBadge;
  estShops: number;
  annualCrHundredths: number;
  hasApprovedBoundary: boolean;
  reference: { lat: number; lng: number; label: string | null; needsReview: boolean } | null;
}
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
}
interface Overview {
  me: { role: string; superAdmin: boolean };
  config: { version: number; effectiveFrom: string; config: Json };
  versions: { version: number; effectiveFrom: string; reason: string }[];
  offer: { bookingOpen: boolean; launch: { open: boolean; placesLeft: number; placesTotal: number; owners: number; areas: number }; feePerAreaPaise: number | null; closedMessage: string | null };
  zones: Zone[];
  clusters: { clusters: { code: string; name: string; zones: number; bookable: number; slotsFree: number; estShops: number; annualCrHundredths: number }[] };
  allocations: Allocation[];
  expiring: { soon: (Allocation & { red: boolean; renewal: string })[]; expired: Allocation[]; alerts: { kind: string; detail: string | null; atIst: string }[] };
  attributions: { shopId: string; shopName: string; zoneId: string; ownerName: string; reason: string | null }[];
  notifications: { id: string; kind: string; channel: string; recipient: string; status: string; sentAtIst: string; dueOn: string }[];
  formula: { version: number; formula: Json } | null;
}

const TABS = ["Overview", "Zones", "Allocations", "Expiring", "Attribution", "Settings", "Bonus formula", "Reports", "Send log"] as const;
type Tab = (typeof TABS)[number];

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error?.message ?? `${res.status}`);
  return payload;
}

/** Admin console for franchise areas (brief §10). Operators see everything; only admins act. */
export function FranchiseAdmin({ isAdmin, initialTab }: { isAdmin: boolean; initialTab?: string }) {
  const [tab, setTab] = useState<Tab>(initialTab === "expiring" ? "Expiring" : "Overview");
  const [data, setData] = useState<Overview | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const load = useCallback(async () => setData(await call("/api/admin/franchise", "GET")), []);
  useEffect(() => {
    let alive = true;
    call("/api/admin/franchise", "GET")
      .then((d) => alive && setData(d))
      .catch((e) => alive && setMsg({ tone: "danger", text: String(e.message) }));
    return () => {
      alive = false;
    };
  }, []);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ tone: "success", text: typeof r === "object" && r && "errors" in r && Array.isArray((r as Json).errors) && ((r as Json).errors as string[]).length ? `${ok} — ${((r as Json).errors as string[]).join(" ")}` : ok });
      await load();
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : String(e) });
    }
  };
  const ask = (q: string) => (typeof window === "undefined" ? null : window.prompt(q));
  if (!data) return <p className="text-sm text-ink-600">Loading…</p>;
  const red = data.expiring.soon.filter((s) => s.red).length;
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
      {red ? <Alert tone="danger" title="Franchise areas expiring">{red} area(s) expire in 7 days or fewer — see Expiring.</Alert> : null}

      {tab === "Overview" ? (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2">
            <Badge tone={data.offer.bookingOpen ? "success" : "warning"}>{data.offer.bookingOpen ? "Booking open" : data.offer.closedMessage ?? "Booking closed"}</Badge>
            <Badge tone="info">
              Launch: {data.offer.launch.owners} owners · {data.offer.launch.areas} areas · {data.offer.launch.placesLeft} of {data.offer.launch.placesTotal} places left
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
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs text-ink-500">
              <tr>
                <th>Cluster</th>
                <th className="text-right">Zones</th>
                <th className="text-right">Bookable</th>
                <th className="text-right">Slots free</th>
                <th className="text-right">Est. shops</th>
                <th className="text-right">₹ Cr / year</th>
              </tr>
            </thead>
            <tbody>
              {data.clusters.clusters.map((c) => (
                <tr key={c.code} className="border-t border-cream-100">
                  <td>
                    {c.code} · {c.name}
                  </td>
                  <td className="text-right">{c.zones}</td>
                  <td className="text-right">{c.bookable}</td>
                  <td className="text-right">{c.slotsFree}</td>
                  <td className="text-right">{c.estShops.toLocaleString("en-IN")}</td>
                  <td className="text-right">{crore(c.annualCrHundredths)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {tab === "Zones" ? (
        <Card className="space-y-3 p-4">
          {isAdmin ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => act(() => call("/api/admin/franchise/boundaries", "POST", { action: "auto-reference", limit: 100 }), "Reference points seeded (auto – needs review)")}>
                Seed reference points (geocode)
              </Button>
              <label className="inline-flex min-h-10 cursor-pointer items-center rounded-lg border border-cream-200 px-3 text-sm">
                Import GeoJSON
                <input
                  type="file"
                  accept=".json,.geojson,application/geo+json,application/json"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const geojson = JSON.parse(await f.text());
                    await act(() => call("/api/admin/franchise/boundaries", "POST", { action: "import", geojson }), "Imported as drafts (approve each zone)");
                  }}
                />
              </label>
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="admin-zones">
              <thead className="text-left text-xs text-ink-500">
                <tr>
                  <th>Zone</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Slots</th>
                  <th>Reference</th>
                  <th>₹ Cr</th>
                  {isAdmin ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {data.zones.map((z) => (
                  <tr key={z.zoneId} className="border-t border-cream-100 align-top">
                    <td className="font-semibold">
                      {z.zoneId}
                      {z.isTest ? " (test)" : ""}
                    </td>
                    <td>{z.name}</td>
                    <td>
                      <Badge tone={z.badge === "FULL" ? "danger" : z.badge === "ONE_LEFT" ? "warning" : z.badge === "AVAILABLE_2" ? "success" : "neutral"}>{z.status === "BOOKABLE" ? ZONE_BADGE_LABELS[z.badge] : z.status}</Badge>
                      {z.statusReason ? <div className="text-xs text-ink-500">{z.statusReason}</div> : null}
                    </td>
                    <td>
                      {z.occupied}/{z.maxOwners}
                    </td>
                    <td className="text-xs">{z.reference ? `${z.reference.lat.toFixed(4)}, ${z.reference.lng.toFixed(4)}${z.reference.needsReview ? " · auto – needs review" : ""}` : "—"}</td>
                    <td>{crore(z.annualCrHundredths)}</td>
                    {isAdmin ? (
                      <td className="space-x-1 whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            const ref = ask(`Zone ${z.zoneId}: reference point "lat,lng"`, ) ?? "";
                            const [lat, lng] = ref.split(",").map((s) => Number(s.trim()));
                            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
                            const shape = (ask("Circle radius in metres (e.g. 2500), or paste a polygon as [[lat,lng],…]") ?? "").trim();
                            const body = shape.startsWith("[") ? { action: "boundary", ref: { lat, lng, label: "admin" }, shape: "POLYGON", polygon: JSON.parse(shape) } : { action: "boundary", ref: { lat, lng, label: "admin" }, shape: "CIRCLE", radiusM: Number(shape) };
                            void act(() => call(`/api/admin/franchise/zones/${encodeURIComponent(z.zoneId)}`, "PATCH", body), "Draft saved");
                          }}
                        >
                          Boundary
                        </Button>
                        <Button size="sm" onClick={() => act(() => call(`/api/admin/franchise/zones/${encodeURIComponent(z.zoneId)}`, "PATCH", { action: "approve" }).then((r) => { if (!r.approved) throw new Error(r.errors.join(" ")); return r; }), `Zone ${z.zoneId} approved`)}>
                          Approve
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => act(() => call(`/api/admin/franchise/zones/${encodeURIComponent(z.zoneId)}`, "PATCH", { action: "status", status: z.status === "PAUSED" ? "BOOKABLE" : "PAUSED", reason: ask("Reason") ?? "" }), "Saved")}>
                          {z.status === "PAUSED" ? "Resume" : "Pause"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const raw = ask(`Split ${z.zoneId} (${z.estShops} shops): "Name A:shops; Name B:shops"`) ?? "";
                            const parts = raw.split(";").map((p) => p.split(":")).filter((p) => p.length === 2).map(([name, shops]) => ({ name: name.trim(), shops: Number(shops) }));
                            if (parts.length >= 2) void act(() => call(`/api/admin/franchise/zones/${encodeURIComponent(z.zoneId)}`, "PATCH", { action: "split", parts, reason: ask("Reason") ?? "" }), "Split done");
                          }}
                        >
                          Split
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {tab === "Allocations" ? (
        <Card className="overflow-x-auto p-4">
          <AllocationTable rows={data.allocations} isAdmin={isAdmin} act={act} ask={ask} />
        </Card>
      ) : null}

      {tab === "Expiring" ? (
        <Card className="space-y-3 p-4" data-testid="admin-expiring">
          <h2 className="font-bold text-ink-900">Franchise areas expiring (next 30 days)</h2>
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
          <h2 className="font-bold text-ink-900">Held franchise attributions (duplicates, disputes)</h2>
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

      {tab === "Settings" ? <SettingsEditor data={data} isAdmin={isAdmin} act={act} /> : null}

      {tab === "Bonus formula" ? <FormulaEditor current={data.formula} isAdmin={isAdmin} act={act} /> : null}

      {tab === "Reports" ? (
        <Card className="space-y-2 p-4">
          <h2 className="font-bold text-ink-900">Reports (CSV)</h2>
          {(["fees", "occupancy", "owners", "commission"] as const).map((k) => (
            <a key={k} className="block text-sm font-semibold text-kesari-800 underline" href={`/api/admin/franchise/reports?kind=${k}&format=csv`}>
              {k === "fees" ? "Franchise fees collected" : k === "occupancy" ? "Areas booked / available by cluster" : k === "owners" ? "Shops, activation rate and GMV by owner" : "Commissions payable / paid"}
            </a>
          ))}
          {isAdmin ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const month = ask("Run the monthly calculation for month (YYYY-MM)") ?? "";
                if (/^\d{4}-\d{2}$/.test(month)) void act(() => call("/api/admin/franchise/run", "POST", { month, force: true }), `Month ${month} calculated`);
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

function AllocationTable({ rows, isAdmin, act, ask }: { rows: Allocation[]; isAdmin: boolean; act: (fn: () => Promise<unknown>, ok: string) => Promise<void>; ask: (q: string) => string | null }) {
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
          <th>Fee</th>
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
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SettingsEditor({ data, isAdmin, act }: { data: Overview; isAdmin: boolean; act: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [text, setText] = useState(JSON.stringify(data.config.config, null, 2));
  const [reason, setReason] = useState("");
  const [from, setFrom] = useState("");
  return (
    <Card className="space-y-2 p-4">
      <h2 className="font-bold text-ink-900">Commercial settings (version {data.config.version})</h2>
      <p className="text-xs text-ink-600">
        Money in paise (₹1,50,000 = 15000000), percentages in basis points (25% = 2500). maxOwnersPerZone only by a super-admin{data.me.superAdmin ? " (you)" : ""}. postLaunchFeePaise blank (null) keeps booking closed after the launch offer. A new version takes effect at the time you set (default now); bookings and commissions keep the version in force when they were made.
      </p>
      <textarea className={`${inputClass} h-96 font-mono text-xs`} value={text} onChange={(e) => setText(e.target.value)} readOnly={!isAdmin} aria-label="Settings JSON" />
      {isAdmin ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <input className={inputClass} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <input className={inputClass} type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Effective from (IST)" />
          <Button onClick={() => act(() => call("/api/admin/franchise/config", "PUT", { patch: JSON.parse(text), reason, effectiveFrom: from ? new Date(`${from}:00+05:30`).toISOString() : undefined }), "New version saved")}>Save new version</Button>
        </div>
      ) : null}
      <h3 className="pt-2 font-semibold text-ink-900">Versions</h3>
      <ul className="text-xs text-ink-700">
        {data.versions.map((v) => (
          <li key={v.version}>
            v{v.version} · from {new Date(v.effectiveFrom).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST · {v.reason}
          </li>
        ))}
      </ul>
    </Card>
  );
}

const SAMPLE_FORMULA = {
  metrics: [
    { key: "newShopsActivated", weight: 40, target: 20 },
    { key: "activeShops", weight: 30, target: 50 },
    { key: "attributedGmvPaise", weight: 30, target: 500_000_000 },
  ],
  tiers: [
    { minScore: 50, bonusBp: 100 },
    { minScore: 70, bonusBp: 300 },
    { minScore: 90, bonusBp: 500 },
  ],
};

function FormulaEditor({ current, isAdmin, act }: { current: { version: number; formula: Json } | null; isAdmin: boolean; act: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [text, setText] = useState(JSON.stringify(current?.formula ?? SAMPLE_FORMULA, null, 2));
  const [reason, setReason] = useState("");
  return (
    <Card className="space-y-2 p-4">
      <h2 className="font-bold text-ink-900">Performance bonus formula {current ? `(published v${current.version})` : "(none published — bonus is 0%)"}</h2>
      <p className="text-xs text-ink-600">Metrics: newShopsActivated, activeShops, attributedGmvPaise, momGrowthPct, ticketCompliancePct. Score 0–100 → the highest tier reached; the bonus is capped at bonusMaxBp (5 points). Applies from the next monthly run.</p>
      <textarea className={`${inputClass} h-72 font-mono text-xs`} value={text} onChange={(e) => setText(e.target.value)} readOnly={!isAdmin} aria-label="Formula JSON" />
      {isAdmin ? (
        <div className="flex flex-wrap gap-2">
          <input className={inputClass} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button variant="secondary" onClick={() => act(() => call("/api/admin/franchise/rating", "POST", { formula: JSON.parse(text), publish: false, reason }), "Draft saved")}>
            Save draft
          </Button>
          <Button onClick={() => act(() => call("/api/admin/franchise/rating", "POST", { formula: JSON.parse(text), publish: true, reason }), "Published")}>Publish</Button>
        </div>
      ) : null}
    </Card>
  );
}
