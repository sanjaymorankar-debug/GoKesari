"use client";

/**
 * Find a Consultant (docs/consult-booking-2026-11): search by category,
 * service or name, language, mode, fee range and a day with free time;
 * nearest first from the customer's position (Nearby's Haversine), with
 * distance, map, directions, rating and the next free time.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CONSULT_MODES } from "@/lib/consult/constants";
import { formatSlot, istDateKey, addDays, formatDateKey } from "@/lib/consult/time";
import { Alert, Button, inputClass } from "@/components/ui";
import { api, Chip, MODE_ICON, modeLabel, PinMap, rupees, Stars } from "./common";

export interface FinderCategory {
  id: string;
  name: string;
  slug: string;
  groupName: string;
}

export interface FinderCard {
  profileId: string;
  slug: string;
  name: string;
  headline: string | null;
  photoUrl: string | null;
  kind: string;
  verified: boolean;
  categories: string[];
  languages: string[];
  modes: string[];
  feeFromPaise: number | null;
  feeToPaise: number | null;
  rating: number;
  ratingCount: number;
  area: string;
  latitude: number | null;
  longitude: number | null;
  distanceKm: number | null;
  distanceText: string | null;
  directionsUrl: string | null;
  nextSlot: string | null;
  teamSize: number;
}

interface Props {
  categories: FinderCategory[];
  initial: FinderCard[];
  origin: { latitude: number; longitude: number; label: string } | null;
  initialFilters: { category?: string; q?: string };
}

export function ConsultFinder({ categories, initial, origin: initialOrigin, initialFilters }: Props) {
  const [q, setQ] = useState(initialFilters.q ?? "");
  const [category, setCategory] = useState(initialFilters.category ?? "");
  const [language, setLanguage] = useState("");
  const [mode, setMode] = useState("");
  const [minFee, setMinFee] = useState("");
  const [maxFee, setMaxFee] = useState("");
  const [date, setDate] = useState("");
  const [radius, setRadius] = useState(25);
  const [origin, setOrigin] = useState(initialOrigin);
  const [results, setResults] = useState<FinderCard[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapOf, setMapOf] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const req = useRef(0);

  const groups = useMemo(() => {
    const m = new Map<string, FinderCategory[]>();
    for (const c of categories) m.set(c.groupName, [...(m.get(c.groupName) ?? []), c]);
    return [...m.entries()];
  }, [categories]);

  const search = useCallback(async () => {
    const id = ++req.current;
    setBusy(true);
    setError(null);
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (category) p.set("category", category);
    if (language.trim()) p.set("language", language.trim());
    if (mode) p.set("mode", mode);
    if (minFee) p.set("minFee", minFee);
    if (maxFee) p.set("maxFee", maxFee);
    if (date) p.set("date", date);
    if (origin) {
      p.set("lat", origin.latitude.toFixed(6));
      p.set("lng", origin.longitude.toFixed(6));
      p.set("radiusKm", String(radius));
    }
    try {
      const r = await api<{ results: FinderCard[] }>(`/api/consult/search?${p.toString()}`);
      if (id === req.current) setResults(r.results);
    } catch (e) {
      if (id === req.current) setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      if (id === req.current) setBusy(false);
    }
  }, [q, category, language, mode, minFee, maxFee, date, origin, radius]);

  // Filters (not the free-text box) search at once.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the view's inputs change
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, mode, date, origin, radius]);

  const locate = () => {
    if (!navigator.geolocation) return setError("This device cannot share its location. Search by area name instead.");
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => setOrigin({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, label: "Your current location" }),
      () => {
        setBusy(false);
        setError("Location permission was refused. Allow it in the browser, or search without it.");
      },
      { enableHighAccuracy: false, timeout: 12_000, maximumAge: 300_000 },
    );
  };

  const today = istDateKey(new Date());
  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => addDays(today, d));

  return (
    <div className="flex flex-col gap-3" data-testid="consult-finder">
      <form
        className="flex flex-col gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="flex gap-2">
          <input
            className={inputClass}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Doctor, lawyer, CA, service or name…"
            aria-label="Search consultants"
            data-testid="consult-q"
          />
          <Button type="submit" disabled={busy}>
            Search
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className={`${inputClass} max-w-56`} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" data-testid="consult-category">
            <option value="">All categories</option>
            {groups.map(([g, list]) => (
              <optgroup key={g} label={g}>
                {list.map((c) => (
                  <option key={c.id} value={c.slug}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <Button variant="secondary" size="sm" onClick={locate} data-testid="consult-locate">
            📍 {origin ? "Update location" : "Near me"}
          </Button>
          {origin ? (
            <select className={`${inputClass} w-28`} value={radius} onChange={(e) => setRadius(Number(e.target.value))} aria-label="Distance">
              {[3, 5, 10, 25, 50].map((km) => (
                <option key={km} value={km}>
                  {km} km
                </option>
              ))}
            </select>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
            {showFilters ? "Fewer filters" : "More filters"}
          </Button>
        </div>
        {origin ? <p className="text-xs text-ink-600">Nearest first from {origin.label}.</p> : null}
        {showFilters ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex flex-wrap gap-1.5">
              <Chip active={!mode} onClick={() => setMode("")}>
                Any way
              </Chip>
              {CONSULT_MODES.map((m) => (
                <Chip key={m} active={mode === m} onClick={() => setMode(m)} testId={`consult-mode-${m}`}>
                  {MODE_ICON[m]} {modeLabel(m)}
                </Chip>
              ))}
            </div>
            <div className="flex gap-2">
              <input className={inputClass} value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="Language (Marathi, Hindi…)" aria-label="Language" />
              <input className={`${inputClass} w-24`} inputMode="numeric" value={minFee} onChange={(e) => setMinFee(e.target.value.replace(/\D/g, ""))} placeholder="Min ₹" aria-label="Minimum fee" />
              <input className={`${inputClass} w-24`} inputMode="numeric" value={maxFee} onChange={(e) => setMaxFee(e.target.value.replace(/\D/g, ""))} placeholder="Max ₹" aria-label="Maximum fee" />
            </div>
            <div className="flex flex-wrap gap-1.5 sm:col-span-2" aria-label="Free on">
              <Chip active={!date} onClick={() => setDate("")}>
                Any day
              </Chip>
              {days.map((d, i) => (
                <Chip key={d} active={date === d} onClick={() => setDate(d)}>
                  {i === 0 ? "Today" : i === 1 ? "Tomorrow" : formatDateKey(d).slice(0, 10)}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}
      </form>

      {error ? <Alert tone="warning">{error}</Alert> : null}

      <p className="text-sm text-ink-700" aria-live="polite">
        {busy ? "Searching…" : `${results.length} consultant${results.length === 1 ? "" : "s"} found`}
      </p>

      <ul className="grid gap-3 sm:grid-cols-2" data-testid="consult-results">
        {results.map((c) => (
          <li key={c.profileId} className="flex flex-col gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3" data-testid="consult-card">
            <div className="flex items-start gap-3">
              {c.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.photoUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" />
              ) : (
                <span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-kesari-100 text-2xl" aria-hidden>
                  🩺
                </span>
              )}
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-extrabold text-ink-900">
                  <Link href={`/consult/${encodeURIComponent(c.slug)}`} className="hover:underline">
                    {c.name}
                  </Link>
                  {c.verified ? (
                    <span className="ml-1.5 rounded-full bg-leaf-100 px-1.5 py-0.5 align-middle text-[11px] font-bold text-leaf-700" title="Registration checked by GoKesari">
                      ✔ Verified
                    </span>
                  ) : null}
                </h3>
                <p className="truncate text-sm text-ink-700">{c.headline || c.categories.slice(0, 3).join(" · ") || (c.kind === "FIRM" ? `Firm · ${c.teamSize} consultants` : "Consultant")}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-600">
                  <Stars value={c.rating} count={c.ratingCount} />
                  {c.area ? <span>{c.area}</span> : null}
                  {c.languages.length ? <span>🗣 {c.languages.slice(0, 3).join(", ")}</span> : null}
                </div>
              </div>
              {c.distanceText ? <span className="shrink-0 rounded-full bg-[var(--gk-chip)] px-2.5 py-1 text-sm font-bold tabular-nums">{c.distanceText}</span> : null}
            </div>
            <div className="flex flex-wrap gap-1.5 text-xs font-bold">
              {c.modes.map((m) => (
                <span key={m} className="rounded-full bg-cream-100 px-2 py-0.5 text-ink-800">
                  {MODE_ICON[m]} {modeLabel(m)}
                </span>
              ))}
              <span className="rounded-full bg-cream-100 px-2 py-0.5 text-ink-800">
                {c.feeFromPaise === c.feeToPaise ? rupees(c.feeFromPaise) : `${rupees(c.feeFromPaise)} – ${rupees(c.feeToPaise)}`}
              </span>
            </div>
            <p className="text-sm text-ink-800">
              {c.nextSlot ? (
                <>
                  Next free: <strong>{formatSlot(c.nextSlot)}</strong>
                </>
              ) : (
                <span className="text-ink-500">No free time in the next two weeks</span>
              )}
            </p>
            {mapOf === c.profileId && c.latitude != null && c.longitude != null ? <PinMap latitude={c.latitude} longitude={c.longitude} label={c.name} /> : null}
            <div className="mt-auto flex flex-wrap gap-2">
              <Link href={`/consult/${encodeURIComponent(c.slug)}`} className="inline-flex min-h-11 items-center rounded-lg bg-kesari-600 px-4 text-sm font-bold text-white hover:bg-kesari-800" data-testid="consult-book">
                Book
              </Link>
              {c.latitude != null && c.longitude != null ? (
                <Button variant="secondary" onClick={() => setMapOf(mapOf === c.profileId ? null : c.profileId)}>
                  {mapOf === c.profileId ? "Hide map" : "Map"}
                </Button>
              ) : null}
              {c.directionsUrl ? (
                <a href={c.directionsUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 bg-white px-4 text-sm font-medium text-ink-700 hover:bg-cream-100">
                  Directions
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {!busy && results.length === 0 ? (
        <Alert tone="info">No consultant matches yet. Try another category, a wider distance, or fewer filters.</Alert>
      ) : null}
    </div>
  );
}
