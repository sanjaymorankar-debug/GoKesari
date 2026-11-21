"use client";
/** Admin → Franchise → Zones: the zone master (§9) — tier, fee, business, status, slots; max franchises; map shapes. */
import { useState } from "react";

import { Badge, Button, Card, inputClass } from "@/components/ui";
import { rupees } from "@/lib/franchise";

import { STATUS_TONE, call, type Act, type AdminZone, type Ask } from "./shared";

export function TierBadge({ z }: { z: Pick<AdminZone, "tierName" | "tierColour" | "provisional" | "tier"> }) {
  if (!z.tier) return <span className="text-xs text-ink-500">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold text-white" style={{ backgroundColor: z.tierColour ?? "#64748b" }}>
        {z.tierName}
      </span>
      {z.provisional ? <Badge tone="warning">Provisional</Badge> : null}
    </span>
  );
}

export function ZonesTab({ zones, isAdmin, act, ask }: { zones: AdminZone[]; isAdmin: boolean; act: Act; ask: Ask }) {
  const [q, setQ] = useState("");
  const [showTest, setShowTest] = useState(false);
  const list = zones.filter((z) => (showTest || !z.isTest) && (!q || `${z.zoneId} ${z.name} ${z.region} ${z.areas.join(" ")}`.toLowerCase().includes(q.toLowerCase())));
  const url = (id: string) => `/api/admin/franchise/zones/${encodeURIComponent(id)}`;
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputClass} max-w-xs`} placeholder="Search zone, name, area" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search zones" />
        <label className="inline-flex items-center gap-1 text-sm text-ink-700">
          <input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} /> Show test zone
        </label>
        {isAdmin ? (
          <label className="inline-flex min-h-10 cursor-pointer items-center rounded-lg border border-cream-200 px-3 text-sm">
            Import map shapes (GeoJSON)
            <input
              type="file"
              accept=".json,.geojson,application/geo+json,application/json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const geojson = JSON.parse(await f.text());
                await act(() => call("/api/admin/franchise/boundaries", "POST", { action: "import", geojson }), "Imported as draft shapes (approve each zone)");
              }}
            />
          </label>
        ) : null}
      </div>
      <p className="text-xs text-ink-600">A shop&apos;s zone comes from its area, never from a map shape; shapes only draw the booking map. Fees are locked for an active franchise&apos;s term.</p>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm" data-testid="admin-zones">
          <thead className="text-left text-xs text-ink-500">
            <tr>
              <th>Zone</th>
              <th>Name</th>
              <th>Region</th>
              <th>Civic body</th>
              <th>Tier</th>
              <th className="text-right">Annual fee</th>
              <th>vs avg</th>
              <th>Business</th>
              <th>Status</th>
              <th>Franchises</th>
              {isAdmin ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {list.map((z) => (
              <tr key={z.zoneId} className="border-t border-cream-100 align-top">
                <td className="whitespace-nowrap font-semibold">
                  {z.zoneId}
                  {z.isTest ? " (test)" : ""}
                </td>
                <td>
                  {z.name}
                  <div className="text-xs text-ink-500">{z.areas.length} areas</div>
                </td>
                <td>{z.region}</td>
                <td className="text-xs">{z.civicBody ?? "—"}</td>
                <td>
                  <TierBadge z={z} />
                </td>
                <td className="whitespace-nowrap text-right">{z.feePaise != null ? rupees(z.feePaise) : "—"}</td>
                <td>{z.vsAverage}</td>
                <td className="text-xs">
                  {z.value != null ? (z.metric === "ANNUAL_CR" ? `₹${z.value.toLocaleString("en-IN")} Cr` : `Index ${z.value}`) : "—"}
                  {z.source ? <div className="text-ink-500">{z.source}{z.asOf ? ` · ${z.asOf}` : ""}</div> : null}
                </td>
                <td>
                  <Badge tone={STATUS_TONE[z.status] ?? "neutral"}>{z.statusLabel}</Badge>
                  {z.statusReason ? <div className="text-xs text-ink-500">{z.statusReason}</div> : null}
                </td>
                <td className="whitespace-nowrap text-xs">
                  {z.active} active · {z.occupied - z.active} held · max {z.maxOwners} · {z.slotsFree} free
                </td>
                {isAdmin ? (
                  <td className="space-x-1 whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const n = Number(ask(`Zone ${z.zoneId}: maximum franchises (1 or 2; now ${z.maxOwners})`) ?? "");
                        if (n !== 1 && n !== 2) return;
                        void act(() => call(url(z.zoneId), "PATCH", { action: "maxOwners", maxOwners: n, reason: ask("Reason (logged)") ?? "" }), `Zone ${z.zoneId}: max ${n}`);
                      }}
                    >
                      Max
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const ref = ask(`Zone ${z.zoneId} map shape: centre "lat,lng"`) ?? "";
                        const [lat, lng] = ref.split(",").map((s) => Number(s.trim()));
                        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
                        const shape = (ask("Circle radius in metres (e.g. 2500), or paste a polygon as [[lat,lng],…]") ?? "").trim();
                        if (!shape) return;
                        const body = shape.startsWith("[") ? { action: "boundary", ref: { lat, lng, label: "admin" }, shape: "POLYGON", polygon: JSON.parse(shape) } : { action: "boundary", ref: { lat, lng, label: "admin" }, shape: "CIRCLE", radiusM: Number(shape) };
                        void act(() => call(url(z.zoneId), "PATCH", body), "Draft shape saved");
                      }}
                    >
                      Shape
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        act(
                          () =>
                            call<{ approved: boolean; errors: string[] }>(url(z.zoneId), "PATCH", { action: "approve" }).then((r) => {
                              if (!r.approved) throw new Error(r.errors.join(" "));
                              return r;
                            }),
                          `Zone ${z.zoneId}: shape approved`,
                        )
                      }
                    >
                      Approve shape
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
