"use client";
/**
 * Admin → Franchise → Fees (§5.2–§5.3): import actual annual business per zone (CSV: zone code, ₹ Cr, source, as-of
 * date) → preview old vs new (value, % vs average, tier, fee) → publish with a reason, or discard. "Recalculate"
 * previews the published figures under the current tier settings. Active franchises keep the fee they paid.
 */
import { useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";
import { rupees } from "@/lib/franchise";

import { call, type Act, type Tier } from "./shared";

interface PreviewRow {
  zoneId: string;
  name: string;
  oldMetric: string | null;
  oldValue: number | null;
  oldTier: Tier | null;
  oldFeePaise: number | null;
  oldProvisional: boolean;
  newMetric: string;
  newValue: number;
  source: string;
  asOf: string;
  newDiffBp: number;
  vsAverage: string;
  newTier: Tier;
  newFeePaise: number;
  changed: boolean;
}
interface Preview {
  batchId: string | null;
  zoneSetCode: string;
  average: number;
  rows: PreviewRow[];
  counts: Record<Tier, number>;
}

const fmt = (metric: string | null, v: number | null) => (v == null ? "—" : metric === "ANNUAL_CR" ? `₹${v.toLocaleString("en-IN")} Cr` : `Index ${v}`);

export function FeesTab({ zoneSets, tierNames, isAdmin, act }: { zoneSets: string[]; tierNames: Record<Tier, string>; isAdmin: boolean; act: Act }) {
  const [csv, setCsv] = useState("zone_code,annual_business_cr,source,as_of\n");
  const [set, setSet] = useState(zoneSets[0] ?? "PUN");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<Preview>) => {
    setErr(null);
    try {
      setPreview(await fn());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  if (!isAdmin) return <Card className="p-4 text-sm text-ink-600">Only an admin imports business data and publishes fees. The current tiers and fees are on the Zones tab.</Card>;
  return (
    <Card className="space-y-3 p-4" data-testid="admin-fees">
      <h2 className="font-bold text-ink-900">Zone business data, tiers and fees</h2>
      <p className="text-xs text-ink-600">
        Tier by business only: more than 10% above the zone-set average → {tierNames.PREMIER}; within ±10% (exactly ±10% included) → {tierNames.STANDARD} at the standard fee; more than 10% below → {tierNames.EMERGING}. Premier / Emerging fee = standard fee × (1 + difference), to the nearest ₹1,000; GST extra. The import must cover every active zone of the set.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm text-ink-700">
          CSV (zone code, annual business ₹ Cr, source, as-of date YYYY-MM-DD)
          <textarea className={`${inputClass} h-40 font-mono text-xs`} value={csv} onChange={(e) => setCsv(e.target.value)} />
        </label>
        <div className="space-y-2">
          <label className="inline-flex min-h-10 cursor-pointer items-center rounded-lg border border-cream-200 px-3 text-sm">
            Load a CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setCsv(await f.text());
              }}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => run(() => call<Preview>("/api/admin/franchise/fees", "POST", { action: "import", csv }))}>
              Import and preview
            </Button>
            <select className={`${inputClass} max-w-[8rem]`} value={set} onChange={(e) => setSet(e.target.value)} aria-label="Zone set">
              {zoneSets.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <Button size="sm" variant="secondary" onClick={() => run(() => call<Preview>("/api/admin/franchise/fees", "POST", { action: "preview", zoneSetCode: set }))}>
              Recalculate with current settings
            </Button>
          </div>
        </div>
      </div>
      {err ? <Alert tone="danger">{err}</Alert> : null}
      {preview ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Badge tone="info">{preview.batchId ? "Import preview" : "Recalculation preview"} · set {preview.zoneSetCode}</Badge>
            <Badge tone="neutral">Average {preview.average.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</Badge>
            {(["PREMIER", "STANDARD", "EMERGING"] as Tier[]).map((t) => (
              <Badge key={t} tone="neutral">
                {tierNames[t]}: {preview.counts[t]}
              </Badge>
            ))}
            <Badge tone="warning">{preview.rows.filter((r) => r.changed).length} change(s)</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="text-left text-ink-500">
                <tr>
                  <th>Zone</th>
                  <th>Old figure</th>
                  <th>Old tier / fee</th>
                  <th>New figure</th>
                  <th>vs avg</th>
                  <th>New tier</th>
                  <th className="text-right">New fee</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.zoneId} className={`border-t border-cream-100 ${r.changed ? "bg-amber-50" : ""}`}>
                    <td className="whitespace-nowrap font-semibold">
                      {r.zoneId} <span className="font-normal">{r.name}</span>
                    </td>
                    <td>{fmt(r.oldMetric, r.oldValue)}</td>
                    <td>
                      {r.oldTier ? tierNames[r.oldTier] : "—"} · {r.oldFeePaise != null ? rupees(r.oldFeePaise) : "—"}
                      {r.oldProvisional ? " (provisional)" : ""}
                    </td>
                    <td>{fmt(r.newMetric, r.newValue)}</td>
                    <td>{r.vsAverage}</td>
                    <td>{tierNames[r.newTier]}</td>
                    <td className="text-right">{rupees(r.newFeePaise)}</td>
                    <td>
                      {r.source} · {r.asOf}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <input className={`${inputClass} max-w-md`} placeholder="Reason for publishing (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button
              disabled={reason.trim().length < 5}
              onClick={() =>
                act(
                  () =>
                    call("/api/admin/franchise/fees", "POST", { action: "publish", zoneSetCode: preview.zoneSetCode, batchId: preview.batchId, reason }).then((r) => {
                      setPreview(null);
                      return r;
                    }),
                  "Published: new bookings and renewals use these fees; active franchises keep theirs",
                )
              }
            >
              Publish
            </Button>
            {preview.batchId ? (
              <Button
                variant="ghost"
                onClick={() =>
                  act(
                    () =>
                      call("/api/admin/franchise/fees", "POST", { action: "discard", batchId: preview.batchId }).then((r) => {
                        setPreview(null);
                        return r;
                      }),
                    "Import discarded",
                  )
                }
              >
                Discard
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
