"use client";
/**
 * Admin → Franchise → Areas (§5.1): the area master with its zone (or Unzoned), PIN codes and map point; move an area
 * to another zone (audited; shops in it follow from now); edit the suggestion point / PINs; correct one shop's area.
 */
import { useEffect, useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";

import { call, type Act, type AdminZone, type Ask } from "./shared";

interface Area {
  id: string;
  areaNo: number;
  name: string;
  region: string;
  civicBody: string | null;
  zoneId: string | null;
  zoneName: string | null;
  pincodes: string[];
  lat: number | null;
  lng: number | null;
  locationSource: "APPROXIMATE" | "ADMIN";
}

export function AreasTab({ zones, isAdmin, act, ask }: { zones: AdminZone[]; isAdmin: boolean; act: Act; ask: Ask }) {
  const [areas, setAreas] = useState<Area[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [zoneFilter, setZoneFilter] = useState("ALL");
  const [shop, setShop] = useState({ shopId: "", areaId: "", reason: "" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    call<{ areas: Area[] }>("/api/admin/franchise/areas", "GET")
      .then((r) => alive && setAreas(r.areas))
      .catch((e) => alive && setErr(String(e.message)));
    return () => {
      alive = false;
    };
  }, [tick]);
  const reload = () => setTick((t) => t + 1);
  const wrap: Act = async (fn, ok) => {
    await act(fn, ok);
    reload();
  };
  if (!areas) return <Card className="p-4 text-sm text-ink-600">{err ?? "Loading areas…"}</Card>;
  const list = areas.filter((a) => (zoneFilter === "ALL" || (zoneFilter === "UNZONED" ? !a.zoneId : a.zoneId === zoneFilter)) && (!q || `${a.name} ${a.region} ${a.pincodes.join(" ")}`.toLowerCase().includes(q.toLowerCase())));
  const unzoned = areas.filter((a) => !a.zoneId).length;
  return (
    <Card className="space-y-3 p-4" data-testid="admin-areas">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">{areas.length} areas</Badge>
        <Badge tone="success">{areas.length - unzoned} in a zone</Badge>
        <Badge tone="warning">{unzoned} unzoned</Badge>
        <input className={`${inputClass} max-w-xs`} placeholder="Search area, region, PIN" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search areas" />
        <select className={`${inputClass} max-w-xs`} value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} aria-label="Zone filter">
          <option value="ALL">All zones</option>
          <option value="UNZONED">Unzoned only</option>
          {zones.map((z) => (
            <option key={z.zoneId} value={z.zoneId}>
              {z.zoneId} {z.name}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-ink-600">Unzoned areas: free teams may register shops there; no franchise can be bought until an area is added to a zone. Map points and PIN codes marked approximate only drive the registration suggestion, which the user confirms.</p>
      <div className="max-h-[32rem] overflow-auto">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-white text-left text-ink-500">
            <tr>
              <th>#</th>
              <th>Area</th>
              <th>Region</th>
              <th>Civic body</th>
              <th>Zone</th>
              <th>PIN codes</th>
              <th>Map point</th>
              {isAdmin ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id} className="border-t border-cream-100">
                <td>{a.areaNo}</td>
                <td className="font-semibold">{a.name}</td>
                <td>{a.region}</td>
                <td>{a.civicBody ?? "—"}</td>
                <td>{a.zoneId ? `${a.zoneId} ${a.zoneName ?? ""}` : <Badge tone="warning">Unzoned</Badge>}</td>
                <td>{a.pincodes.join(", ") || "—"}</td>
                <td>
                  {a.lat != null && a.lng != null ? `${a.lat.toFixed(4)}, ${a.lng.toFixed(4)}` : "—"}
                  {a.locationSource === "APPROXIMATE" ? " (approx.)" : ""}
                </td>
                {isAdmin ? (
                  <td className="space-x-1 whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const z = (ask(`Move "${a.name}" to which zone? (zone code, or UNZONED)`) ?? "").trim().toUpperCase();
                        if (!z) return;
                        void wrap(() => call("/api/admin/franchise/areas", "PATCH", { action: "remap", areaId: a.id, zoneId: z === "UNZONED" ? null : z, reason: ask("Reason (logged)") ?? "" }), `${a.name} moved`);
                      }}
                    >
                      Zone
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const p = ask(`"${a.name}" map point "lat,lng"`) ?? "";
                        const [lat, lng] = p.split(",").map((s) => Number(s.trim()));
                        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
                        const pins = (ask("PIN codes, comma-separated") ?? a.pincodes.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
                        void wrap(() => call("/api/admin/franchise/areas", "PATCH", { action: "location", areaId: a.id, lat, lng, pincodes: pins }), `${a.name} updated`);
                      }}
                    >
                      Point / PINs
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 rounded-lg border border-cream-200 p-3">
        <p className="text-sm font-semibold text-ink-900">Correct a shop&apos;s area</p>
        <p className="text-xs text-ink-600">Admin or operator. Logged; affects only commission earned after the change.</p>
        <div className="grid gap-2 sm:grid-cols-4">
          <input className={inputClass} placeholder="Shop id (uuid)" value={shop.shopId} onChange={(e) => setShop({ ...shop, shopId: e.target.value })} />
          <select className={inputClass} value={shop.areaId} onChange={(e) => setShop({ ...shop, areaId: e.target.value })} aria-label="Area">
            <option value="">Choose the area…</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} {a.zoneId ? `(${a.zoneId})` : "(Unzoned)"}
              </option>
            ))}
          </select>
          <input className={inputClass} placeholder="Reason (required)" value={shop.reason} onChange={(e) => setShop({ ...shop, reason: e.target.value })} />
          <Button
            disabled={!shop.shopId.trim() || !shop.areaId || shop.reason.trim().length < 5}
            onClick={() =>
              act(
                () =>
                  call(`/api/admin/franchise/shops/${encodeURIComponent(shop.shopId.trim())}/area`, "POST", { areaId: shop.areaId, reason: shop.reason }).then((r) => {
                    setShop({ shopId: "", areaId: "", reason: "" });
                    return r;
                  }),
                "Shop's area corrected",
              )
            }
          >
            Save
          </Button>
        </div>
      </div>
      {err ? <Alert tone="danger">{err}</Alert> : null}
    </Card>
  );
}
