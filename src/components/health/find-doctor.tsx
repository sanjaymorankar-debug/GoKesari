"use client";

/**
 * GoKesari Health "Find a doctor" (patient): search by specialty, symptom, doctor name / clinic and area;
 * nearby from the browser's location (or the saved one); filters for fee, language, in clinic / video,
 * available today / this week and Prime. Results come ranked from /api/health/doctors; Prime cards are
 * labelled, Free listings are always shown.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { SYMPTOM_CHIPS } from "@/lib/health/symptoms";
import type { DoctorCard } from "@/server/health/find-doctor";
import { Alert, Button, Field, inputClass } from "@/components/ui";
import { api, Chip } from "./api";
import { DoctorCardView } from "./doctor-card";

export interface FinderFilters {
  q?: string;
  specialty?: string;
  symptom?: string;
  area?: string;
  minFee?: string;
  maxFee?: string;
  language?: string;
  mode?: "" | "IN_PERSON" | "VIDEO";
  available?: "" | "today" | "week";
  prime?: boolean;
}

interface Props {
  categories: { slug: string; name: string }[];
  initial: DoctorCard[];
  origin: { latitude: number; longitude: number; label?: string | null } | null;
  initialFilters: FinderFilters;
  /** Query kept on every link (patient=…&suggestion=…). */
  carry: string;
}

const LANGUAGES = ["English", "Hindi", "Marathi", "Gujarati", "Kannada", "Tamil", "Telugu", "Bengali", "Urdu"];

export function DoctorFinder({ categories, initial, origin: savedOrigin, initialFilters, carry }: Props) {
  const [f, setF] = useState<FinderFilters>({ mode: "", available: "", prime: false, ...initialFilters });
  const [origin, setOrigin] = useState(savedOrigin);
  const [results, setResults] = useState<DoctorCard[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [more, setMore] = useState(false);
  const first = useRef(true);

  const run = useCallback(
    async (next: FinderFilters, where: typeof origin) => {
      setBusy(true);
      setError(null);
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(next)) {
        if (v === undefined || v === "" || v === false) continue;
        p.set(k, v === true ? "1" : String(v));
      }
      if (where) {
        p.set("lat", String(where.latitude));
        p.set("lng", String(where.longitude));
      }
      try {
        const r = await api<{ results: DoctorCard[] }>(`/api/health/doctors?${p.toString()}`);
        setResults(r.results);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not search. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // Chips and selects search at once; typed text searches on "Search" / Enter.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void run(f, origin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.specialty, f.mode, f.available, f.prime, f.language, origin]);

  const set = (patch: Partial<FinderFilters>) => setF((cur) => ({ ...cur, ...patch }));

  const locate = () => {
    if (!navigator.geolocation) {
      setError("Your browser cannot share its location. Type an area instead.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setOrigin({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, label: "Your location" });
      },
      () => {
        setLocating(false);
        setError("Location is off. Allow it in the browser, or type an area.");
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  };

  return (
    <div className="flex flex-col gap-4" data-testid="health-doctor-finder">
      <form
        className="flex flex-col gap-3 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(f, origin);
        }}
      >
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Field label="Doctor, clinic or symptom">
            <input
              className={inputClass}
              value={f.q ?? f.symptom ?? ""}
              onChange={(e) => set({ q: e.target.value, symptom: undefined })}
              placeholder="e.g. Dr Mehta, fever, toothache"
              data-testid="health-doctor-q"
              enterKeyHint="search"
            />
          </Field>
          <Field label="Area, city or PIN">
            <input className={inputClass} value={f.area ?? ""} onChange={(e) => set({ area: e.target.value })} placeholder="e.g. Kothrud, 411038" data-testid="health-doctor-area" />
          </Field>
          <div className="flex items-end">
            <Button type="submit" size="lg" disabled={busy} data-testid="health-doctor-search">
              {busy ? "Searching…" : "Search"}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button type="button" variant="ghost" size="sm" onClick={locate} disabled={locating} data-testid="health-doctor-nearby">
            📍 {locating ? "Finding you…" : origin ? "Update my location" : "Near me"}
          </Button>
          {origin ? (
            <span className="text-ink-700">
              Nearest first from {origin.label ?? "your location"}{" "}
              <button type="button" className="font-bold text-kesari-800 underline" onClick={() => setOrigin(null)}>
                clear
              </button>
            </span>
          ) : (
            <span className="text-ink-600">Allow your location to see doctors near you first.</span>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-600">Speciality</p>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            <Chip active={!f.specialty} onClick={() => set({ specialty: undefined })}>
              All doctors
            </Chip>
            {categories.map((c) => (
              <Chip key={c.slug} active={f.specialty === c.slug} onClick={() => set({ specialty: c.slug, symptom: undefined })} testId={`health-specialty-${c.slug}`}>
                {c.name}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-600">Common problems</p>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {SYMPTOM_CHIPS.map((s) => (
              <Chip
                key={s}
                active={f.symptom === s}
                onClick={() => {
                  const next = { ...f, symptom: s, q: undefined, specialty: undefined };
                  setF(next);
                  void run(next, origin);
                }}
              >
                {s}
              </Chip>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Chip active={f.mode === "IN_PERSON"} onClick={() => set({ mode: f.mode === "IN_PERSON" ? "" : "IN_PERSON" })} testId="health-filter-clinic">
            🏢 In clinic
          </Chip>
          <Chip active={f.mode === "VIDEO"} onClick={() => set({ mode: f.mode === "VIDEO" ? "" : "VIDEO" })} testId="health-filter-video">
            🎥 Video
          </Chip>
          <Chip active={f.available === "today"} onClick={() => set({ available: f.available === "today" ? "" : "today" })} testId="health-filter-today">
            Available today
          </Chip>
          <Chip active={f.available === "week"} onClick={() => set({ available: f.available === "week" ? "" : "week" })}>
            This week
          </Chip>
          <Chip active={Boolean(f.prime)} onClick={() => set({ prime: !f.prime })} testId="health-filter-prime">
            ★ Prime only
          </Chip>
          <Chip active={more} onClick={() => setMore(!more)}>
            More filters
          </Chip>
        </div>
        {more ? (
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Fee from (₹)">
              <input className={inputClass} inputMode="numeric" value={f.minFee ?? ""} onChange={(e) => set({ minFee: e.target.value.replace(/\D/g, "") })} />
            </Field>
            <Field label="Fee up to (₹)">
              <input className={inputClass} inputMode="numeric" value={f.maxFee ?? ""} onChange={(e) => set({ maxFee: e.target.value.replace(/\D/g, "") })} />
            </Field>
            <Field label="Language">
              <select className={inputClass} value={f.language ?? ""} onChange={(e) => set({ language: e.target.value || undefined })}>
                <option value="">Any</option>
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}
      </form>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      <p className="text-xs text-ink-600">
        Only doctors whose council registration GoKesari has checked are listed. Listings marked ★ Prime are paid placements and are shown higher; every other verified doctor is listed too.
      </p>
      <div className="grid gap-3 md:grid-cols-2" data-testid="health-doctor-results" aria-busy={busy}>
        {results.map((c) => (
          <DoctorCardView key={`${c.memberId}`} card={c} query={carry} />
        ))}
      </div>
      {!busy && !results.length ? (
        <Alert tone="info">No verified doctor matches yet. Try another speciality, a wider area, or clear a filter.</Alert>
      ) : null}
    </div>
  );
}
