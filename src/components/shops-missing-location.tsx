"use client";

/**
 * Admin → Shops without location (docs/nearby-referral-2026-10, feature 1):
 * shops Nearby leaves out because they have no usable map location, with
 * ways to fix them — fill from the address (Google geocoding, when the server
 * has the key), or type / paste the coordinates from Google Maps.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Icon } from "@/components/board/icons";

export interface MissingShopRow {
  id: string;
  name: string;
  registrationNumber: string;
  status: string;
  problem: "MISSING" | "INVALID";
  addressLine1: string;
  area: string | null;
  city: string;
  pincode: string;
  latitude: string | null;
  longitude: string | null;
}

function parsePair(text: string): { latitude: number; longitude: number } | null {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) return null;
  return { latitude, longitude };
}

export function ShopsMissingLocation({ shops, canEdit, geocoding }: { shops: MissingShopRow[]; canEdit: boolean; geocoding: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, { tone: "ok" | "error"; text: string }>>({});
  const [pairs, setPairs] = useState<Record<string, string>>({});

  const note = (id: string, tone: "ok" | "error", text: string) => setNotes((n) => ({ ...n, [id]: { tone, text } }));

  async function fillFromAddress(ids?: string[]) {
    const key = ids?.[0] ?? "all";
    setBusy(key);
    try {
      const res = await fetch("/api/admin/shops/missing-location", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ids ? { shopIds: ids } : {}),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "Could not fill the location.");
      for (const r of payload.results as { shopId: string; result: string; error?: string }[]) {
        if (r.result === "FILLED") note(r.shopId, "ok", "Filled from the address. Ask the owner to check the pin.");
        else if (r.result === "NOT_FOUND") note(r.shopId, "error", "Google could not place this address in its PIN code — set it by hand.");
        else note(r.shopId, "error", r.error ?? "Could not fill the location.");
      }
      router.refresh();
    } catch (error) {
      note(key, "error", error instanceof Error ? error.message : "Could not fill the location.");
    } finally {
      setBusy(null);
    }
  }

  async function saveCoordinates(id: string) {
    const pair = parsePair(pairs[id] ?? "");
    if (!pair) return note(id, "error", "Paste latitude, longitude — for example 18.55219, 73.94123.");
    setBusy(id);
    try {
      const res = await fetch(`/api/shops/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ latitude: String(pair.latitude), longitude: String(pair.longitude) }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "Could not save.");
      note(id, "ok", "Saved.");
      router.refresh();
    } catch (error) {
      note(id, "error", error instanceof Error ? error.message : "Could not save.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="missing-location">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href="/api/admin/shops/missing-location?format=csv"
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border-2 border-[var(--gk-line)] bg-white px-4 text-sm font-bold text-ink-900 hover:border-kesari-600"
        >
          <Icon name="file-spreadsheet" size={16} /> Download CSV
        </a>
        {canEdit && geocoding && shops.length > 0 ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => fillFromAddress()}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white hover:bg-kesari-800 disabled:opacity-60"
          >
            <Icon name="map-pin" size={16} /> {busy === "all" ? "Filling…" : "Fill all from address"}
          </button>
        ) : null}
        {notes.all ? <p className={`text-sm font-semibold ${notes.all.tone === "ok" ? "text-green-800" : "text-red-700"}`}>{notes.all.text}</p> : null}
      </div>
      {!geocoding ? (
        <p className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-sm text-ink-800">
          Filling from the address needs Google geocoding (GOOGLE_MAPS_SERVER_API_KEY), which this server does not have. Paste the
          coordinates from Google Maps below, or ask the owner to pin the shop in My shop → Location.
        </p>
      ) : null}

      {shops.length === 0 ? (
        <p className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4 text-sm text-ink-700" data-testid="missing-location-empty">
          Every approved and pending shop has a map location. Nothing to fix.
        </p>
      ) : (
        <ul className="grid gap-2 lg:grid-cols-2">
          {shops.map((shop) => (
            <li key={shop.id} className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3" data-testid="missing-location-shop">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-base font-bold text-ink-900">{shop.name}</p>
                  <p className="text-xs text-ink-600">
                    {shop.registrationNumber} · {shop.status === "APPROVED" ? "Live" : "Waiting for approval"}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${shop.problem === "MISSING" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"}`}>
                  {shop.problem === "MISSING" ? "No location" : "Invalid location"}
                </span>
              </div>
              <p className="mt-1 text-sm text-ink-700">
                {[shop.addressLine1, shop.area, shop.city, shop.pincode].filter((p) => p && p.trim()).join(", ") || "No address yet"}
              </p>
              {shop.problem === "INVALID" ? (
                <p className="text-xs text-ink-600">
                  Saved: “{shop.latitude ?? ""}”, “{shop.longitude ?? ""}”
                </p>
              ) : null}
              {canEdit ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    value={pairs[shop.id] ?? ""}
                    onChange={(e) => setPairs((p) => ({ ...p, [shop.id]: e.target.value }))}
                    placeholder="18.55219, 73.94123"
                    aria-label={`Latitude, longitude for ${shop.name}`}
                    className="min-h-11 min-w-0 flex-1 rounded-xl border-2 border-[var(--gk-line)] px-3 text-sm focus:border-kesari-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => saveCoordinates(shop.id)}
                    className="min-h-11 rounded-xl bg-ink-900 px-3 text-sm font-bold text-white disabled:opacity-60"
                  >
                    Save
                  </button>
                  {geocoding && shop.addressLine1.trim() ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => fillFromAddress([shop.id])}
                      className="min-h-11 rounded-xl border-2 border-[var(--gk-line)] px-3 text-sm font-bold text-ink-900 disabled:opacity-60"
                    >
                      {busy === shop.id ? "Filling…" : "From address"}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {notes[shop.id] ? (
                <p className={`mt-1 text-sm font-semibold ${notes[shop.id].tone === "ok" ? "text-green-800" : "text-red-700"}`} role="status">
                  {notes[shop.id].text}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
