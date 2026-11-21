"use client";
import { useEffect, useState } from "react";

import { inputClass } from "@/components/ui";

interface AreaOption {
  id: string;
  name: string;
  region: string;
  zoneId: string | null;
  zoneName: string | null;
}

/**
 * The shop's area (franchise brief 21-Nov-2026 §5.1): suggested from the PIN code and map location, confirmed by the
 * user. The area decides the shop's franchise zone; "Unzoned" areas are fine for registration.
 */
export function AreaPicker({ pincode, latitude, longitude, value, onChange }: { pincode?: string | null; latitude?: number | null; longitude?: number | null; value: string | null; onChange: (areaId: string | null) => void }) {
  const [suggestions, setSuggestions] = useState<AreaOption[]>([]);
  const [areas, setAreas] = useState<AreaOption[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const qs = new URLSearchParams();
    if (pincode && /^[1-9][0-9]{5}$/.test(pincode)) qs.set("pincode", pincode);
    if (latitude != null && longitude != null && Number.isFinite(latitude) && Number.isFinite(longitude)) {
      qs.set("lat", String(latitude));
      qs.set("lng", String(longitude));
    }
    let cancelled = false;
    fetch(`/api/franchise/areas?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("areas"))))
      .then((d: { suggestions: AreaOption[]; areas: AreaOption[] }) => {
        if (cancelled) return;
        setSuggestions(d.suggestions ?? []);
        setAreas(d.areas ?? []);
        if (!value && d.suggestions?.[0]) onChange(d.suggestions[0].id);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
    // Only when the PIN / location changes; the parent's value is the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pincode, latitude, longitude]);
  if (failed) return null;
  const label = (a: AreaOption) => `${a.name} — ${a.zoneId ? `${a.zoneName ?? a.zoneId} (${a.zoneId})` : "Unzoned"}`;
  const suggestedIds = new Set(suggestions.map((s) => s.id));
  return (
    <label className="block text-sm text-ink-800">
      <span className="font-semibold">Area</span>
      <select className={`${inputClass} mt-1`} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} data-testid="shop-area">
        <option value="">Choose your shop&apos;s area</option>
        {suggestions.length ? (
          <optgroup label="Suggested from your PIN code and location">
            {suggestions.map((a) => (
              <option key={`s-${a.id}`} value={a.id}>
                {label(a)}
              </option>
            ))}
          </optgroup>
        ) : null}
        <optgroup label="All areas">
          {areas
            .filter((a) => !suggestedIds.has(a.id))
            .map((a) => (
              <option key={a.id} value={a.id}>
                {label(a)}
              </option>
            ))}
        </optgroup>
      </select>
      <span className="mt-1 block text-xs text-ink-500">Please check it: the area decides which GoKesari franchise zone supports your shop.</span>
    </label>
  );
}
