"use client";

/**
 * GoKesari Health — home care screens (owner brief §2.6): find a verified provider, book a visit (or a
 * package of sessions), follow the visit live (photo, ID card, OTP codes, "on the way" distance / ETA, SOS,
 * notes, rating), and the provider's side (inbox, on my way with live location, OTP check-in / check-out
 * with notes and vitals, agency staff assignment, earnings, profile and ID card).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";
import { addDays, clock12, formatDateKey, istDateKey, istMinuteOfDay } from "@/lib/consult/time";
import { CARE_VISIT_STATUS_LABELS, GENDER_LABELS, GENDERS, type CareVisitStatus } from "@/lib/health/constants";
import type { CareInboxRow, CareProviderPage, CareSearchCard, PatientVisitView, ProviderVisitView, CareEarningRow, CareIdCard, CareCategory, CareBadges } from "@/server/health/care";
import type { HealthCareProviderProfile } from "@/server/db/schema";
import { amount, api, Chip, ist, MODE_ICON, modeLabel, Panel, rupees, Tile } from "./api";
import { useHealthLive } from "./live";

const card = "rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4";
const SHARE_LABELS = {
  OFF: "No — only the booking details and my instructions",
  ON: "Yes — this provider may see my health profile and earlier records for this booking",
  ASK: "Ask me each time",
} as const;

function useGeo(): { get: () => Promise<{ latitude: number; longitude: number } | null>; error: string | null } {
  const [error, setError] = useState<string | null>(null);
  const get = useCallback(
    () =>
      new Promise<{ latitude: number; longitude: number } | null>((resolve) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
          setError("Location is not available on this device.");
          resolve(null);
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (p) => {
            setError(null);
            resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude });
          },
          () => {
            setError("Allow location access to use this.");
            resolve(null);
          },
          { enableHighAccuracy: true, timeout: 10_000, maximumAge: 20_000 },
        );
      }),
    [],
  );
  return { get, error };
}

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-bold ${ok ? "border-leaf-300 bg-leaf-50 text-leaf-700" : "border-amber-300 bg-amber-50 text-amber-800"}`}>{ok ? "✓ " : ""}{children}</span>;
}

function Avatar({ url, name, size = 56 }: { url: string | null; name: string; size?: number }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element -- provider photos are external URLs entered at setup
    return <img src={url} alt={`Photo of ${name}`} width={size} height={size} className="shrink-0 rounded-full border-2 border-[var(--gk-line)] object-cover" style={{ width: size, height: size }} />;
  }
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-kesari-100 text-lg font-extrabold text-kesari-800" style={{ width: size, height: size }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/* ------------------------------------------------------------ search */

export function CareSearch({ categories, initial }: { categories: { slug: string; name: string }[]; initial: { category?: string; patientId?: string; suggestionId?: string; q?: string } }) {
  const [category, setCategory] = useState(initial.category ?? "");
  const [gender, setGender] = useState("");
  const [language, setLanguage] = useState("");
  const [setting, setSetting] = useState<"" | "HOME" | "CENTRE">("HOME");
  const [minRating, setMinRating] = useState("");
  const [maxFee, setMaxFee] = useState("");
  const [minExperience, setMinExperience] = useState("");
  const [sort, setSort] = useState("");
  const [origin, setOrigin] = useState<{ latitude: number; longitude: number } | null>(null);
  const [results, setResults] = useState<CareSearchCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const geo = useGeo();

  useEffect(() => {
    let live = true;
    const p = new URLSearchParams();
    if (category) p.set("category", category);
    if (gender) p.set("gender", gender);
    if (language.trim()) p.set("language", language.trim());
    if (setting) p.set("setting", setting);
    if (minRating) p.set("minRating", minRating);
    if (maxFee) p.set("maxFee", maxFee);
    if (minExperience) p.set("minExperience", minExperience);
    if (sort) p.set("sort", sort);
    if (origin) {
      p.set("lat", String(origin.latitude));
      p.set("lng", String(origin.longitude));
    }
    api<{ results: CareSearchCard[] }>(`/api/health/care/search?${p.toString()}`)
      .then((r) => live && (setResults(r.results), setError(null)))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [category, gender, language, setting, minRating, maxFee, minExperience, sort, origin]);

  const carry = new URLSearchParams();
  if (initial.patientId) carry.set("patient", initial.patientId);
  if (initial.suggestionId) carry.set("suggestion", initial.suggestionId);
  if (category) carry.set("category", category);

  return (
    <div className="flex flex-col gap-4" data-testid="care-search">
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Type of care">
        <Chip active={!category} onClick={() => setCategory("")} testId="care-cat-all">
          All home care
        </Chip>
        {categories.map((c) => (
          <Chip key={c.slug} active={category === c.slug} onClick={() => setCategory(c.slug)} testId={`care-cat-${c.slug}`}>
            {c.name}
          </Chip>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Field label="Where">
          <select className={inputClass} value={setting} onChange={(e) => setSetting(e.target.value as typeof setting)}>
            <option value="HOME">At my home</option>
            <option value="CENTRE">At their centre</option>
            <option value="">Either</option>
          </select>
        </Field>
        <Field label="Provider">
          <select className={inputClass} value={gender} onChange={(e) => setGender(e.target.value)} data-testid="care-gender">
            <option value="">Any</option>
            {GENDERS.map((g) => (
              <option key={g} value={g}>
                {GENDER_LABELS[g]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Language">
          <input className={inputClass} value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="Marathi, Hindi…" />
        </Field>
        <Field label="Rating at least">
          <select className={inputClass} value={minRating} onChange={(e) => setMinRating(e.target.value)}>
            <option value="">Any</option>
            <option value="4">4 ★</option>
            <option value="4.5">4.5 ★</option>
          </select>
        </Field>
        <Field label="Experience">
          <select className={inputClass} value={minExperience} onChange={(e) => setMinExperience(e.target.value)}>
            <option value="">Any</option>
            <option value="2">2+ years</option>
            <option value="5">5+ years</option>
            <option value="10">10+ years</option>
          </select>
        </Field>
        <Field label="Fee up to (₹)">
          <input className={inputClass} inputMode="numeric" value={maxFee} onChange={(e) => setMaxFee(e.target.value.replace(/\D/g, "").slice(0, 6))} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={async () => setOrigin(await geo.get())} data-testid="care-near-me">
          📍 {origin ? "Near me (on)" : "Near me"}
        </Button>
        <select className={`${inputClass} w-auto`} value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="">Sort: best match</option>
          <option value="distance">Nearest</option>
          <option value="rating">Rating</option>
          <option value="price">Price</option>
          <option value="experience">Experience</option>
        </select>
        {geo.error ? <span className="text-xs text-red-700">{geo.error}</span> : null}
      </div>
      {initial.suggestionId ? <Alert tone="info">Booking from your doctor&apos;s suggestion. Choose a provider below.</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {results === null ? <p className="text-sm text-ink-600">Finding providers…</p> : null}
      {results && !results.length ? <Alert tone="info">No verified providers match yet. Try another type of care, or turn off some filters.</Alert> : null}
      <div className="grid gap-3 md:grid-cols-2" data-testid="care-results">
        {results?.map((r) => (
          <Link key={r.profileId} href={`/health/care/providers/${encodeURIComponent(r.slug)}?${carry.toString()}`} className={`${card} flex flex-col gap-2 hover:border-kesari-400`} data-testid="care-result">
            <div className="flex items-start gap-3">
              <Avatar url={r.photoUrl ?? r.providers[0]?.photoUrl ?? null} name={r.name} />
              <div className="min-w-0 flex-1">
                <p className="font-extrabold text-ink-900">{r.name}</p>
                <p className="text-sm text-ink-700">{r.categories.join(" · ")}</p>
                <p className="text-xs text-ink-600">
                  {r.ratingCount ? `★ ${r.rating.toFixed(1)} (${r.ratingCount})` : "New"} · {r.distanceText ?? r.area}
                  {r.feeFromPaise != null ? ` · from ${rupees(r.feeFromPaise)}` : ""}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {r.homeVisit ? <Badge ok>Home visits</Badge> : null}
              {r.atCentre ? <Badge ok>At centre</Badge> : null}
              {r.providers.some((p) => p.policeVerified) ? <Badge ok>Police verified</Badge> : null}
              {r.providers.length > 1 ? <span className="text-xs text-ink-600">{r.providers.length} providers</span> : null}
            </div>
            <p className="text-xs text-ink-600">{r.providers.map((p) => `${p.name}${p.gender ? ` (${GENDER_LABELS[p.gender as keyof typeof GENDER_LABELS] ?? p.gender})` : ""}${p.experienceYears ? `, ${p.experienceYears} y` : ""}`).join(" · ")}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ provider page + booking */

interface BookingContext {
  patients: { id: string; name: string; relation: string }[];
  addresses: { id: string; label: string | null; text: string; latitude: string | null; longitude: string | null }[];
  package: { id: string; name: string; patientId: string; serviceId: string | null; sessionsTotal: number; sessionsDone: number; last: { memberId: string | null; serviceId: string; address: string | null; latitude: number | null; longitude: number | null } | null } | null;
  suggestion: { id: string; patientId: string; type: string } | null;
}

interface Slot {
  start: string;
  memberIds: string[];
}

export function CareProviderBooking({ page, context, preselect, signedIn }: { page: CareProviderPage; context: BookingContext | null; preselect: { patientId?: string | null; suggestionId?: string | null; packageId?: string | null }; signedIn: boolean }) {
  const router = useRouter();
  const pkg = context?.package ?? null;
  const [patientId, setPatientId] = useState(pkg?.patientId ?? context?.suggestion?.patientId ?? preselect.patientId ?? context?.patients[0]?.id ?? "");
  const [serviceId, setServiceId] = useState(pkg?.serviceId ?? page.services[0]?.id ?? "");
  const service = page.services.find((s) => s.id === serviceId) ?? null;
  const offering = useMemo(() => (service ? page.providers.filter((p) => !service.memberIds.length || service.memberIds.includes(p.memberId)) : []), [service, page.providers]);
  const [memberId, setMemberId] = useState(pkg?.last?.memberId ?? offering[0]?.memberId ?? "");
  const [mode, setMode] = useState(service?.modes.includes("HOME_VISIT") ? "HOME_VISIT" : (service?.modes[0] ?? "HOME_VISIT"));
  const [sessions, setSessions] = useState(1);
  const today = istDateKey(new Date());
  const [from, setFrom] = useState(today);
  const [day, setDay] = useState(today);
  const [days, setDays] = useState<Record<string, Slot[]>>({});
  const [start, setStart] = useState<string | null>(null);
  const [addressId, setAddressId] = useState(pkg?.last ? "" : (context?.addresses[0]?.id ?? ""));
  const [address, setAddress] = useState(pkg?.last?.address ?? "");
  const [pin, setPin] = useState<{ latitude: number; longitude: number } | null>(pkg?.last?.latitude != null && pkg.last.longitude != null ? { latitude: pkg.last.latitude, longitude: pkg.last.longitude } : null);
  const [instructions, setInstructions] = useState("");
  const [share, setShare] = useState<"OFF" | "ON" | "ASK">("OFF");
  const [payment, setPayment] = useState<"ONLINE" | "PAY_AT_VISIT">("ONLINE");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const geo = useGeo();

  useEffect(() => {
    if (!serviceId || !memberId) return;
    let live = true;
    const p = new URLSearchParams({ serviceId, from, days: "7", memberId });
    api<{ days: Record<string, Slot[]> }>(`/api/consult/availability?${p.toString()}`)
      .then((r) => {
        if (!live) return;
        setDays(r.days);
        setStart(null);
        const first = Object.keys(r.days).sort().find((d) => r.days[d].length);
        if (first) setDay((cur) => (r.days[cur]?.length ? cur : first));
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [serviceId, memberId, from]);

  const submit = async () => {
    if (!signedIn) {
      router.push(`/signin?callbackUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    if (!service || !start) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ booking: { id: string }; checkoutUrl: string | null; visitId: string | null }>("/api/health/care/bookings", {
        json: {
          patientId,
          serviceId: service.id,
          memberId: memberId || null,
          mode,
          start,
          instructions: instructions || null,
          shareRecords: share,
          paymentMode: service.feeType === "FREE" ? null : service.feeType === "DEPOSIT" ? "ONLINE" : payment,
          addressId: mode === "HOME_VISIT" && addressId ? addressId : null,
          visitAddress: mode === "HOME_VISIT" && !addressId ? address : null,
          visitLatitude: mode === "HOME_VISIT" && !addressId ? (pin?.latitude ?? null) : null,
          visitLongitude: mode === "HOME_VISIT" && !addressId ? (pin?.longitude ?? null) : null,
          suggestionId: context?.suggestion?.id ?? null,
          sessions: pkg ? 1 : sessions,
          packageId: pkg?.id ?? null,
          consent: consent ? true : undefined,
        },
      });
      if (r.checkoutUrl) window.location.href = r.checkoutUrl;
      else router.push(r.visitId ? `/health/care/visits/${r.visitId}?new=1` : `/health/appointments`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not book. Please try again.");
      setBusy(false);
    }
  };

  const daySlots = days[day] ?? [];
  return (
    <div className="flex flex-col gap-4">
      <section className={card}>
        <div className="flex items-start gap-3">
          <Avatar url={page.profile.photoUrl} name={page.profile.displayName} size={64} />
          <div>
            <h1 className="text-xl font-extrabold text-ink-900">{page.profile.displayName}</h1>
            {page.profile.headline ? <p className="text-sm text-ink-700">{page.profile.headline}</p> : null}
            <p className="text-xs text-ink-600">
              {page.profile.ratingCount ? `★ ${page.profile.rating.toFixed(1)} from ${page.profile.ratingCount} ratings` : "New on GoKesari"} · {page.shop.address}
            </p>
            <div className="mt-1 flex flex-wrap gap-1">{page.profile.verified ? <Badge ok>Verified by GoKesari</Badge> : null}</div>
          </div>
        </div>
        {page.profile.about ? <p className="mt-3 whitespace-pre-line text-sm text-ink-800">{page.profile.about}</p> : null}
      </section>

      <Panel title="Providers">
        <div className="grid gap-2 sm:grid-cols-2">
          {page.providers.map((p) => (
            <div key={p.memberId} className="flex gap-3 rounded-xl border-2 border-[var(--gk-line)] p-3" data-testid="care-provider">
              <Avatar url={p.photoUrl} name={p.name} />
              <div className="min-w-0 text-sm">
                <p className="font-extrabold text-ink-900">{p.name}</p>
                <p className="text-ink-700">{p.categories.join(", ")}</p>
                <p className="text-xs text-ink-600">
                  {[p.gender ? GENDER_LABELS[p.gender as keyof typeof GENDER_LABELS] : null, p.experienceYears ? `${p.experienceYears} years` : null, p.languages.join(", ") || null].filter(Boolean).join(" · ")}
                </p>
                {p.qualifications ? <p className="text-xs text-ink-700">{p.qualifications}</p> : null}
                {p.registrationNumber ? <p className="text-xs text-ink-700">Reg. {p.registrationNumber}{p.registrationBody ? ` (${p.registrationBody})` : ""}</p> : null}
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge ok>ID {p.idCardNumber}</Badge>
                  {p.documentVerified ? <Badge ok>Certificate verified</Badge> : null}
                  {p.policeVerified ? <Badge ok>Police verified</Badge> : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Services and rates">
        <ul className="flex flex-col gap-1 text-sm">
          {page.services.map((s) => (
            <li key={s.id} className="flex justify-between gap-2 border-b border-cream-200 py-1 last:border-0">
              <span>
                <strong>{s.name}</strong> · {s.durationMinutes >= 120 ? `${Math.round(s.durationMinutes / 60)} h` : `${s.durationMinutes} min`} · {s.modes.map((m) => modeLabel(m)).join(" / ")}
                {s.description ? <span className="block text-xs text-ink-600">{s.description}</span> : null}
              </span>
              <span className="font-bold">{s.feeType === "FREE" ? "Free" : rupees(s.feePaise)}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title={pkg ? `Book the next session — ${pkg.name}` : "Book a visit"}>
        {!page.bookable ? <Alert tone="warning">This provider is not taking bookings right now.</Alert> : null}
        {pkg ? <p className="mb-2 text-sm text-ink-700">Session {pkg.sessionsDone + 1} of {pkg.sessionsTotal}. The details of your last session are filled in.</p> : null}
        {context?.suggestion ? <p className="mb-2 text-sm text-ink-700">From your doctor&apos;s suggestion — it will show as booked in your record.</p> : null}
        <div className="flex flex-col gap-3" data-testid="care-booking">
          {context ? (
            <Field label="For">
              <select className={inputClass} value={patientId} onChange={(e) => setPatientId(e.target.value)} disabled={Boolean(pkg)} data-testid="care-patient">
                {context.patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Service">
              <select className={inputClass} value={serviceId} onChange={(e) => setServiceId(e.target.value)} disabled={Boolean(pkg)} data-testid="care-service">
                {page.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.feeType === "FREE" ? "Free" : rupees(s.feePaise)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Provider">
              <select className={inputClass} value={memberId} onChange={(e) => setMemberId(e.target.value)} data-testid="care-member">
                {offering.map((p) => (
                  <option key={p.memberId} value={p.memberId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {service && service.modes.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {service.modes.map((m) => (
                <Chip key={m} active={mode === m} onClick={() => setMode(m)} testId={`care-mode-${m}`}>
                  {MODE_ICON[m]} {m === "HOME_VISIT" ? "At my home" : "At their centre"}
                </Chip>
              ))}
            </div>
          ) : null}
          {!pkg ? (
            <Field label="Sessions" hint="For a course (e.g. 10 physiotherapy sessions): book the first now; the next ones are one tap from the visit page.">
              <select className={`${inputClass} w-40`} value={sessions} onChange={(e) => setSessions(Number(e.target.value))} data-testid="care-sessions">
                {[1, 3, 5, 7, 10, 12, 15, 20, 30].map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? "Single visit" : `${n} sessions`}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-bold text-ink-700">Day and time (IST)</span>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" disabled={from <= today} onClick={() => setFrom(addDays(from, -7) < today ? today : addDays(from, -7))} aria-label="Earlier days">
                  ‹
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setFrom(addDays(from, 7))} aria-label="Later days">
                  ›
                </Button>
              </div>
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {Object.keys(days)
                .sort()
                .map((d) => (
                  <button key={d} type="button" onClick={() => setDay(d)} aria-pressed={d === day} className={`flex min-h-14 min-w-16 flex-col items-center justify-center rounded-xl border-2 px-2 text-xs font-bold ${d === day ? "border-kesari-600 bg-kesari-600 text-white" : days[d].length ? "border-[var(--gk-line)] bg-white" : "border-cream-200 bg-cream-50 text-ink-400"}`}>
                    <span>{d === today ? "Today" : formatDateKey(d).slice(0, 3)}</span>
                    <span className="text-sm">{d.slice(8)}</span>
                  </button>
                ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid="care-slots">
              {!daySlots.length ? <p className="text-sm text-ink-600">No free time on this day.</p> : null}
              {daySlots.map((s) => (
                <Chip key={s.start} active={start === s.start} onClick={() => setStart(s.start)} testId="care-slot">
                  {clock12(istMinuteOfDay(new Date(s.start)))}
                </Chip>
              ))}
            </div>
          </div>
          {mode === "HOME_VISIT" ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-bold text-ink-700">Address</span>
              {context?.addresses.map((a) => (
                <label key={a.id} className="flex items-start gap-2 text-sm">
                  <input type="radio" name="care-address" className="mt-1 h-5 w-5" checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                  <span>
                    {a.label ? <strong>{a.label}: </strong> : null}
                    {a.text}
                  </span>
                </label>
              ))}
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="care-address" className="mt-1 h-5 w-5" checked={!addressId} onChange={() => setAddressId("")} />
                <span>Another address</span>
              </label>
              {!addressId ? (
                <>
                  <textarea className={inputClass} rows={2} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="House / flat, building, street, area, PIN" data-testid="care-address" />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={async () => setPin(await geo.get())}>
                      📍 {pin ? "Map pin set" : "Pin my current location"}
                    </Button>
                    {pin ? <span className="text-xs text-ink-600">{pin.latitude.toFixed(5)}, {pin.longitude.toFixed(5)}</span> : null}
                    {geo.error ? <span className="text-xs text-red-700">{geo.error}</span> : null}
                  </div>
                </>
              ) : null}
              <Link href="/profile/addresses" className="text-xs font-bold text-kesari-800 underline">
                Manage saved addresses
              </Link>
            </div>
          ) : null}
          <Field label="Instructions for the provider (optional)" hint="What to do, what to bring, access to the house, the patient's routine.">
            <textarea className={inputClass} rows={2} maxLength={1000} value={instructions} onChange={(e) => setInstructions(e.target.value)} data-testid="care-instructions" />
          </Field>
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="mb-1 font-bold text-ink-700">Share my health records with this provider?</legend>
            {(Object.keys(SHARE_LABELS) as (keyof typeof SHARE_LABELS)[]).map((k) => (
              <label key={k} className="flex items-start gap-2">
                <input type="radio" className="mt-1 h-5 w-5" name="care-share" checked={share === k} onChange={() => setShare(k)} />
                <span>{SHARE_LABELS[k]}</span>
              </label>
            ))}
          </fieldset>
          {service && service.feeType === "FIXED" && service.payOnline && service.payAtVisit ? (
            <div className="flex flex-wrap gap-1.5">
              <Chip active={payment === "ONLINE"} onClick={() => setPayment("ONLINE")}>
                Pay online now
              </Chip>
              <Chip active={payment === "PAY_AT_VISIT"} onClick={() => setPayment("PAY_AT_VISIT")}>
                Pay at the visit
              </Chip>
            </div>
          ) : null}
          <label className="flex items-start gap-2 text-sm text-ink-800">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="care-consent" />
            <span>I agree to share the patient&apos;s name, age, address and my instructions with this provider for this visit. Before the visit I will see the provider&apos;s photo and ID card; I give the check-in code only when they arrive.</span>
          </label>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button size="lg" onClick={submit} disabled={busy || !page.bookable || !consent || !start || !patientId || (mode === "HOME_VISIT" && !addressId && address.trim().length < 5)} data-testid="care-confirm">
            {!signedIn ? "Sign in to book" : busy ? "Please wait…" : service && service.feeType !== "FREE" && (payment === "ONLINE" || service.feeType === "DEPOSIT") ? `Pay ${rupees(service.feeType === "DEPOSIT" ? service.depositPaise : service.feePaise)} and book` : "Confirm booking"}
          </Button>
        </div>
      </Panel>

      {page.reviews.length ? (
        <Panel title="Reviews">
          <ul className="flex flex-col gap-2 text-sm">
            {page.reviews.map((r, i) => (
              <li key={i} className="border-b border-cream-200 pb-2 last:border-0">
                <span className="font-bold text-amber-700">{"★".repeat(r.rating)}</span> <span className="text-xs text-ink-600">{r.serviceName} · {ist(r.ratedAt, false)}</span>
                {r.review ? <p className="text-ink-800">{r.review}</p> : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ ID card */

export function IdCardView({ card: c }: { card: CareIdCard }) {
  return (
    <div className="max-w-sm rounded-2xl border-2 border-kesari-300 bg-gradient-to-b from-kesari-50 to-white p-4 print:border-black" data-testid="care-id-card">
      <p className="text-xs font-extrabold uppercase tracking-wide text-kesari-800">GoKesari Health · Care provider ID</p>
      <div className="mt-2 flex gap-3">
        <Avatar url={c.photoUrl} name={c.name} size={72} />
        <div className="min-w-0 text-sm">
          <p className="text-lg font-extrabold text-ink-900">{c.name}</p>
          <p className="text-ink-700">{c.categories.join(", ")}</p>
          <p className="text-xs text-ink-600">{c.shopName}</p>
          <p className="mt-1 font-mono text-sm font-bold">{c.idCardNumber}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <Badge ok={c.badges.verified}>{c.badges.verified ? "Verified" : "Not verified yet"}</Badge>
        <Badge ok={c.badges.policeVerified}>{c.badges.police === "VERIFIED" ? "Police verified" : c.badges.police === "NOT_REQUIRED" ? "Police check not required" : `Police: ${(c.badges.police ?? "pending").toLowerCase().replace("_", " ")}`}</Badge>
        {c.badges.documentRequired ? <Badge ok={c.badges.documentVerified}>Certificate {c.badges.documentVerified ? "verified" : "pending"}</Badge> : null}
      </div>
      {c.registrationNumber ? <p className="mt-1 text-xs text-ink-700">Reg. {c.registrationNumber}{c.registrationBody ? ` · ${c.registrationBody}` : ""}</p> : null}
      <div className="mt-3 flex items-center gap-3">
        {/* Server-rendered by the qrcode library from our own verify URL — no user input. */}
        <div className="h-28 w-28 shrink-0 bg-white" dangerouslySetInnerHTML={{ __html: c.qrSvg }} />
        <p className="text-xs text-ink-600">Scan to check this card on gokesari.com. Never pay a provider who cannot show it.</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ patient: one visit */

export function PatientVisit({ visitId }: { visitId: string }) {
  const [v, setV] = useState<PatientVisitView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rating, setRating] = useState(5);
  const [review, setReview] = useState("");
  const [complaint, setComplaint] = useState("");
  const [showComplaint, setShowComplaint] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const geo = useGeo();
  const load = useCallback(() => api<PatientVisitView>(`/api/health/care/visits/${visitId}`).then(setV).catch((e) => setError(e.message)), [visitId]);
  useEffect(() => {
    void load();
  }, [load]);
  useHealthLive((e) => e.subjectId === visitId || e.name === "appointment.changed", () => void load(), 500);
  const act = async (json: Record<string, unknown>, done?: (r: Record<string, unknown>) => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Record<string, unknown>>(`/api/health/care/visits/${visitId}`, { json });
      done?.(r);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };
  if (!v) return error ? <Alert tone="danger">{error}</Alert> : <p className="text-sm text-ink-600">Loading…</p>;
  const sos = async () => {
    if (!window.confirm("Send SOS? Your emergency contact gets an SMS and GoKesari support calls you. If anyone is in danger, also call 112.")) return;
    const here = await geo.get();
    await act({ action: "sos", ...(here ?? {}) }, (r) => setNotice(`SOS sent.${r.smsSent ? " Your emergency contact got an SMS." : ""}${r.ticketNumber ? ` Support ticket ${r.ticketNumber}.` : ""}`));
  };
  return (
    <div className="flex flex-col gap-4" data-testid="care-visit">
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-bold uppercase text-ink-600">{v.booking.bookingNumber}{v.visit.sessionNo ? ` · session ${v.visit.sessionNo}` : ""}</p>
            <h1 className="text-xl font-extrabold text-ink-900">{v.booking.serviceName}</h1>
            <p className="text-sm text-ink-700">
              For {v.patient.name} · {ist(v.booking.startsAt)} · {modeLabel(v.booking.mode)}
            </p>
          </div>
          <span className="rounded-full border-2 border-kesari-300 bg-kesari-50 px-3 py-1 text-sm font-extrabold text-kesari-800" data-testid="care-visit-status">
            {v.visit.statusLabel}
          </span>
        </div>
        {v.booking.visitAddress ? <p className="mt-1 text-sm text-ink-700">🏠 {v.booking.visitAddress}</p> : null}
        <p className="mt-1 text-xs text-ink-600">
          Fee {rupees(v.booking.feePaise)} · {v.booking.paymentStatus === "PAID" ? "paid" : v.booking.paymentMode === "PAY_AT_VISIT" ? "pay at the visit" : v.booking.paymentStatus.toLowerCase().replace("_", " ")}
        </p>
      </section>

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {v.live ? (
        <section className="rounded-2xl border-2 border-teal-300 bg-teal-50 p-4" data-testid="care-on-the-way">
          <p className="text-lg font-extrabold text-teal-900">🚗 {v.provider.name} is on the way</p>
          <p className="text-sm text-teal-900">
            {v.live.distanceKm != null ? `${v.live.distanceKm} km away · about ${v.live.etaMinutes} min` : "Location not shared yet"}
            {v.live.lastLocationAt ? ` · updated ${ist(v.live.lastLocationAt).split(" ").slice(1).join(" ")}` : ""}
          </p>
        </section>
      ) : null}

      {v.codes.checkIn || v.codes.checkOut ? (
        <section className="rounded-2xl border-2 border-kesari-400 bg-white p-4 text-center" data-testid="care-code">
          <p className="text-sm font-bold text-ink-700">{v.codes.checkIn ? "Check-in code — give it only when the provider is at your door and matches the photo below" : "Check-out code — give it when the visit is over"}</p>
          <p className="mt-1 font-mono text-4xl font-extrabold tracking-[0.4em] text-kesari-800">{v.codes.checkIn ?? v.codes.checkOut}</p>
        </section>
      ) : null}

      <Panel title="Your care provider">
        <div className="flex flex-wrap gap-4">
          {v.provider.idCard ? (
            <IdCardView card={v.provider.idCard} />
          ) : (
            <div className="flex gap-3">
              <Avatar url={v.provider.photoUrl} name={v.provider.name} size={72} />
              <div className="text-sm">
                <p className="font-extrabold">{v.provider.name}</p>
                <p className="text-ink-700">{v.provider.shopName}</p>
              </div>
            </div>
          )}
          <div className="text-sm text-ink-700">
            {v.provider.qualifications ? <p>{v.provider.qualifications}</p> : null}
            {v.provider.experienceYears ? <p>{v.provider.experienceYears} years of experience</p> : null}
            {v.provider.languages.length ? <p>Speaks {v.provider.languages.join(", ")}</p> : null}
            {v.provider.phone ? (
              <a href={`tel:${v.provider.phone}`} className="mt-2 inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] px-3 font-bold">
                📞 Call {v.provider.shopName}
              </a>
            ) : null}
          </div>
        </div>
      </Panel>

      {v.can.sos ? (
        <Button variant="danger" size="lg" onClick={sos} disabled={busy} data-testid="care-sos">
          🆘 SOS — alert my emergency contact and GoKesari
        </Button>
      ) : null}
      {v.can.sos && !v.patient.hasEmergencyContact ? (
        <p className="text-xs text-ink-600">
          No emergency contact on file. <Link href={`/health/profile?patient=${v.patient.id}`} className="font-bold underline">Add one</Link> so SOS can text them.
        </p>
      ) : null}

      {v.visit.status === "COMPLETED" ? (
        <Panel title="Visit notes">
          <p className="text-xs text-ink-600">Checked in {ist(v.visit.checkedInAt)} · checked out {ist(v.visit.checkedOutAt)}</p>
          {Object.keys(v.visit.vitals ?? {}).length ? (
            <ul className="mt-2 flex flex-wrap gap-2 text-sm">
              {Object.entries(v.visit.vitals).map(([k, val]) => (
                <li key={k} className="rounded-lg bg-cream-100 px-2 py-1">
                  {VITAL_NAMES[k] ?? k}: <strong>{String(val)}</strong>
                </li>
              ))}
            </ul>
          ) : null}
          {v.visit.notes ? <p className="mt-2 whitespace-pre-line text-sm text-ink-800">{v.visit.notes}</p> : null}
          {v.documentId ? (
            <a href={`/api/health/care/visits/${visitId}/note`} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] px-3 text-sm font-bold">
              📄 Visit note (PDF)
            </a>
          ) : null}
        </Panel>
      ) : null}

      {v.package ? (
        <Panel title={v.package.name}>
          <p className="text-sm text-ink-700">
            {v.package.sessionsDone} of {v.package.sessionsTotal} sessions done.
          </p>
          {v.package.canBookNext ? (
            <Link href={`/health/care/providers/${encodeURIComponent(v.provider.shopSlug)}?package=${v.package.id}&patient=${v.patient.id}`} className="mt-2 inline-flex min-h-11 items-center rounded-lg bg-kesari-600 px-4 text-sm font-bold text-white" data-testid="care-book-next">
              Book the next session
            </Link>
          ) : null}
        </Panel>
      ) : null}

      {v.can.rate ? (
        <Panel title="Rate this visit">
          <div className="flex gap-1" role="radiogroup" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" aria-pressed={n <= rating} onClick={() => setRating(n)} className={`min-h-11 min-w-11 text-2xl ${n <= rating ? "text-amber-500" : "text-ink-300"}`}>
                ★
              </button>
            ))}
          </div>
          <textarea className={`${inputClass} mt-2`} rows={2} maxLength={1000} value={review} onChange={(e) => setReview(e.target.value)} placeholder="How was the visit? (optional)" />
          <Button className="mt-2" onClick={() => act({ action: "rate", rating, review: review || null }, () => setNotice("Thank you for rating."))} disabled={busy} data-testid="care-rate">
            Submit rating
          </Button>
        </Panel>
      ) : v.booking.rating ? (
        <p className="text-sm text-ink-700">You rated this visit {"★".repeat(v.booking.rating)}.</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {v.can.cancel ? (
          <Button variant="secondary" onClick={() => window.confirm("Cancel this visit? The provider's cancellation policy applies to any refund.") && act({ action: "cancel" })} disabled={busy}>
            Cancel visit
          </Button>
        ) : null}
        {v.can.complain ? (
          <Button variant="secondary" onClick={() => setShowComplaint((x) => !x)}>
            Report a problem
          </Button>
        ) : null}
        {v.ticketNumber ? <span className="text-sm text-ink-700">Complaint ticket {v.ticketNumber}</span> : null}
      </div>
      {showComplaint && v.can.complain ? (
        <div className={card}>
          <Field label="What went wrong?">
            <textarea className={inputClass} rows={3} value={complaint} onChange={(e) => setComplaint(e.target.value)} />
          </Field>
          <Button className="mt-2" disabled={busy || complaint.trim().length < 10} onClick={() => act({ action: "complain", reason: complaint }, (r) => (setNotice(`Complaint sent. Ticket ${String(r.ticketNumber)}.`), setShowComplaint(false)))}>
            Send to GoKesari support
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const VITAL_NAMES: Record<string, string> = { bpSystolic: "BP sys", bpDiastolic: "BP dia", pulse: "Pulse", temperatureC: "Temp °C", spo2: "SpO2 %", weightKg: "Weight kg", respiratoryRate: "Resp. rate", bloodSugar: "Sugar mg/dL" };

/* ------------------------------------------------------------ provider: inbox */

export function CareInbox({ shopId }: { shopId: string }) {
  const [data, setData] = useState<{ rows: CareInboxRow[]; team: { memberId: string; name: string }[]; canAssign: boolean } | null>(null);
  const [tab, setTab] = useState<"visits" | "earnings">("visits");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ rows: CareInboxRow[]; team: { memberId: string; name: string }[]; canAssign: boolean }>(`/api/health/care/provider/visits?shopId=${shopId}`).then(setData).catch((e) => setError(e.message)), [shopId]);
  useEffect(() => {
    void load();
  }, [load]);
  const status = useHealthLive((e) => e.name.startsWith("care_booking.") || e.name === "appointment.changed", () => void load(), 400);
  const act = async (visitId: string, json: Record<string, unknown>) => {
    setError(null);
    try {
      await api(`/api/health/care/provider/visits/${visitId}`, { json });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not do that.");
    }
  };
  const today = istDateKey(new Date());
  const groups = useMemo(() => {
    const rows = data?.rows ?? [];
    return [
      { key: "now", title: "Now and today", rows: rows.filter((r) => r.visitStatus === "ON_THE_WAY" || r.visitStatus === "IN_PROGRESS" || (istDateKey(new Date(r.startsAt)) === today && r.visitStatus === "SCHEDULED")) },
      { key: "next", title: "Upcoming", rows: rows.filter((r) => istDateKey(new Date(r.startsAt)) > today && r.visitStatus === "SCHEDULED") },
      { key: "past", title: "Done and cancelled", rows: rows.filter((r) => r.visitStatus === "COMPLETED" || r.visitStatus === "CANCELLED" || (istDateKey(new Date(r.startsAt)) < today && r.visitStatus === "SCHEDULED")).reverse() },
    ];
  }, [data, today]);
  return (
    <div className="flex flex-col gap-4" data-testid="care-inbox">
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={tab === "visits"} onClick={() => setTab("visits")}>
          Visits
        </Chip>
        <Chip active={tab === "earnings"} onClick={() => setTab("earnings")} testId="care-earnings-tab">
          Earnings
        </Chip>
        <span className="ml-auto text-xs font-semibold text-ink-600" data-testid="health-live" data-status={status}>
          {status === "live" ? "● Live" : status === "connecting" ? "Connecting…" : "Offline"}
        </span>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {tab === "earnings" ? (
        <CareEarnings shopId={shopId} />
      ) : !data ? (
        <p className="text-sm text-ink-600">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="Waiting to accept" value={data.rows.filter((r) => r.bookingStatus === "PENDING_APPROVAL").length} tone="amber" />
            <Tile label="Today" value={groups[0].rows.length} tone="kesari" />
            <Tile label="Upcoming" value={groups[1].rows.length} tone="teal" />
            <Tile label="SOS" value={data.rows.filter((r) => r.sos && r.visitStatus !== "COMPLETED").length} tone="ink" />
          </div>
          {groups.map((g) => (
            <Panel key={g.key} title={g.title}>
              {!g.rows.length ? <p className="text-sm text-ink-600">Nothing here.</p> : null}
              <ul className="flex flex-col gap-2">
                {g.rows.map((r) => (
                  <li key={r.visitId} className={`rounded-xl border-2 p-3 ${r.sos && r.visitStatus !== "COMPLETED" ? "border-red-400 bg-red-50" : "border-[var(--gk-line)]"}`} data-testid="care-inbox-row">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <Link href={`/shop/health/care/visits/${r.visitId}`} className="min-w-0">
                        <p className="font-extrabold text-ink-900">
                          {ist(r.startsAt)} · {r.serviceName}
                        </p>
                        <p className="text-sm text-ink-700">
                          {r.patientName}
                          {r.area ? ` · ${r.area}` : ""}
                          {r.memberName ? ` · ${r.memberName}` : ""}
                          {r.sessionNo ? ` · session ${r.sessionNo}${r.sessionsTotal ? `/${r.sessionsTotal}` : ""}` : ""}
                        </p>
                      </Link>
                      <span className="text-xs font-bold text-ink-700">{r.bookingStatus === "PENDING_APPROVAL" ? "Waiting for you" : r.bookingStatus === "PENDING_PAYMENT" ? "Awaiting payment" : (CARE_VISIT_STATUS_LABELS[r.visitStatus as CareVisitStatus] ?? r.visitStatus)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {r.bookingStatus === "PENDING_APPROVAL" ? (
                        <Button size="sm" onClick={() => act(r.visitId, { action: "accept" })} data-testid="care-accept">
                          Accept
                        </Button>
                      ) : null}
                      <Link href={`/shop/health/care/visits/${r.visitId}`} className="inline-flex min-h-10 items-center rounded-lg border-2 border-[var(--gk-line)] px-3 text-sm font-bold">
                        Open
                      </Link>
                      {data.canAssign && r.visitStatus === "SCHEDULED" && ["CONFIRMED", "PENDING_APPROVAL"].includes(r.bookingStatus) && data.team.length > 1 ? (
                        <select className={`${inputClass} w-auto`} value={r.memberId ?? ""} onChange={(e) => e.target.value && act(r.visitId, { action: "reassign", memberId: e.target.value })} aria-label="Assign to">
                          {data.team.map((m) => (
                            <option key={m.memberId} value={m.memberId}>
                              Assign: {m.name}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </>
      )}
    </div>
  );
}

function CareEarnings({ shopId }: { shopId: string }) {
  const [data, setData] = useState<{ rows: CareEarningRow[]; totals: { visits: number; onlinePaise: number; offlinePaise: number; commissionPaise: number; payoutPaise: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<typeof data>(`/api/health/care/provider/earnings?shopId=${shopId}`).then(setData).catch((e) => setError(e.message));
  }, [shopId]);
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!data) return <p className="text-sm text-ink-600">Loading…</p>;
  return (
    <div className="flex flex-col gap-3" data-testid="care-earnings">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Visits done" value={data.totals.visits} />
        <Tile label="Paid online" value={amount(data.totals.onlinePaise)} tone="teal" />
        <Tile label="Collected at visits" value={amount(data.totals.offlinePaise)} tone="green" />
        <Tile label="GoKesari payout" value={amount(data.totals.payoutPaise)} hint={`after ${amount(data.totals.commissionPaise)} commission`} tone="amber" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs uppercase text-ink-600">
              <th className="p-2">Visit</th>
              <th className="p-2">Status</th>
              <th className="p-2 text-right">Online</th>
              <th className="p-2 text-right">At visit</th>
              <th className="p-2 text-right">Commission</th>
              <th className="p-2 text-right">Payout</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.bookingId} className="border-t border-cream-200">
                <td className="p-2">
                  {ist(r.startsAt, false)} · {r.serviceName}
                  <span className="block text-xs text-ink-600">{r.bookingNumber}{r.memberName ? ` · ${r.memberName}` : ""}</span>
                </td>
                <td className="p-2 text-xs">{r.status.toLowerCase().replace("_", " ")}</td>
                <td className="p-2 text-right tabular-nums">{amount(r.paidOnlinePaise - r.refundPaise)}</td>
                <td className="p-2 text-right tabular-nums">{amount(r.paidOfflinePaise)}</td>
                <td className="p-2 text-right tabular-nums">{amount(r.commissionPaise)}</td>
                <td className="p-2 text-right font-bold tabular-nums">{amount(r.payoutPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-600">Payouts come with your weekly shop payout. Commission is GoKesari&apos;s fee on each visit (online and at-visit money).</p>
    </div>
  );
}

/* ------------------------------------------------------------ provider: one visit */

export function ProviderVisit({ visitId }: { visitId: string }) {
  const [v, setV] = useState<ProviderVisitView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [vitals, setVitals] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<string[]>([]);
  const [photoConsent, setPhotoConsent] = useState(false);
  const [sharing, setSharing] = useState(false);
  const geo = useGeo();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const load = useCallback(() => api<ProviderVisitView>(`/api/health/care/provider/visits/${visitId}`).then(setV).catch((e) => setError(e.message)), [visitId]);
  useEffect(() => {
    void load();
  }, [load]);
  useHealthLive((e) => (e.subjectId === visitId || e.name === "appointment.changed") && !(e.payload as { location?: boolean }).location, () => void load(), 500);

  const act = async (json: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/health/care/provider/visits/${visitId}`, { json });
      setCode("");
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not do that.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  // While "On my way" is open, send the location about every 30 seconds.
  useEffect(() => {
    if (v?.visit.status !== "ON_THE_WAY" || !sharing) return;
    const send = async () => {
      const here = await geo.get();
      if (here) await api(`/api/health/care/provider/visits/${visitId}`, { json: { action: "location", ...here } }).catch(() => null);
    };
    timer.current = setInterval(send, 30_000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [v?.visit.status, sharing, visitId, geo]);

  if (!v) return error ? <Alert tone="danger">{error}</Alert> : <p className="text-sm text-ink-600">Loading…</p>;
  const onMyWay = async () => {
    const here = await geo.get();
    if (await act({ action: "on-the-way", ...(here ?? {}) })) setSharing(true);
  };
  const addPhotos = async (files: FileList | null) => {
    if (!files) return;
    const read = (f: File) => new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(f);
    });
    const next = [...photos];
    for (const f of Array.from(files).slice(0, 3 - photos.length)) {
      if (f.size > 4_000_000) {
        setError("Each photo must be under 4 MB.");
        continue;
      }
      next.push(await read(f));
    }
    setPhotos(next);
  };
  const vitalNum = (k: string) => (vitals[k] ? Number(vitals[k]) : null);
  const checkOut = () =>
    act({
      action: "check-out",
      code,
      notes,
      vitals: { bpSystolic: vitalNum("bpSystolic"), bpDiastolic: vitalNum("bpDiastolic"), pulse: vitalNum("pulse"), temperatureC: vitalNum("temperatureC"), spo2: vitalNum("spo2"), bloodSugar: vitalNum("bloodSugar"), respiratoryRate: vitalNum("respiratoryRate"), weightKg: vitalNum("weightKg") },
      photos,
      photoConsent,
    });
  const b = v.booking;
  return (
    <div className="flex flex-col gap-4" data-testid="care-provider-visit">
      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs font-bold uppercase text-ink-600">{b.bookingNumber}{v.visit.sessionNo ? ` · session ${v.visit.sessionNo}${v.package ? `/${v.package.sessionsTotal}` : ""}` : ""}</p>
            <h1 className="text-xl font-extrabold text-ink-900">{b.serviceName}</h1>
            <p className="text-sm text-ink-700">
              {ist(b.startsAt)} · {modeLabel(b.mode)}
              {v.memberName ? ` · ${v.memberName}` : ""}
            </p>
          </div>
          <span className="rounded-full border-2 border-kesari-300 bg-kesari-50 px-3 py-1 text-sm font-extrabold text-kesari-800" data-testid="care-provider-status">
            {b.status === "PENDING_APPROVAL" ? "Waiting for you to accept" : v.visit.statusLabel}
          </span>
        </div>
        {v.visit.sosAt ? <Alert tone="danger" title="SOS raised by the patient's family">At {ist(v.visit.sosAt)}. GoKesari support has been alerted — call the patient now.</Alert> : null}
      </section>
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Panel title="Patient and address">
        <p className="text-sm">
          <strong>{v.patient.name}</strong>
          {v.patient.age ? `, ${v.patient.age}` : ""}
          {v.patient.gender ? `, ${GENDER_LABELS[v.patient.gender as keyof typeof GENDER_LABELS] ?? v.patient.gender}` : ""}
        </p>
        {b.visitAddress ? <p className="mt-1 text-sm">🏠 {b.visitAddress}</p> : null}
        <div className="mt-2 flex flex-wrap gap-2">
          {b.visitorPhone ? (
            <a href={`tel:${b.visitorPhone}`} className="inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] px-3 text-sm font-bold">
              📞 Call
            </a>
          ) : null}
          {b.visitLatitude != null && b.visitLongitude != null ? (
            <a href={`https://www.google.com/maps/dir/?api=1&destination=${b.visitLatitude},${b.visitLongitude}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] px-3 text-sm font-bold">
              🧭 Directions
            </a>
          ) : null}
        </div>
        {v.instructions ? <p className="mt-2 whitespace-pre-line rounded-lg bg-cream-100 p-2 text-sm">{v.instructions}</p> : null}
        <p className="mt-2 text-xs text-ink-600">
          Fee {rupees(b.feePaise)} · {b.paymentStatus === "PAID" ? "paid" : b.paymentMode === "PAY_AT_VISIT" ? "collect at the visit (record it in Appointments)" : b.paymentStatus.toLowerCase()}
        </p>
      </Panel>

      <Panel title="Shared health records">
        {v.sharedRecords ? (
          <div className="text-sm" data-testid="care-shared-records">
            <p className="text-xs text-ink-600">The patient shared these for this booking. Your look is recorded in their access log.</p>
            {v.sharedRecords.allergies.length ? <p className="mt-1 font-extrabold text-red-800">Allergies: {v.sharedRecords.allergies.join(", ")}</p> : null}
            {v.sharedRecords.conditions.length ? <p>Conditions: {v.sharedRecords.conditions.join(", ")}</p> : null}
            {v.sharedRecords.bloodGroup ? <p>Blood group: {v.sharedRecords.bloodGroup}</p> : null}
            {v.sharedRecords.currentMedicines ? <p>Current medicines: {v.sharedRecords.currentMedicines}</p> : null}
            {v.sharedRecords.prescriptions.length ? <p className="mt-1">Prescriptions: {v.sharedRecords.prescriptions.map((p) => `${p.rxNumber} (${ist(p.issuedAt, false)})`).join(", ")}</p> : null}
            {v.sharedRecords.documents.length ? <p>Reports: {v.sharedRecords.documents.map((d) => d.title).join(", ")}</p> : null}
          </div>
        ) : (
          <p className="text-sm text-ink-600">The patient did not share their records for this booking. Ask them about allergies and medicines before you start.</p>
        )}
      </Panel>

      {v.can.accept && b.status === "PENDING_APPROVAL" ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => act({ action: "accept" })} disabled={busy} data-testid="care-accept">
            Accept
          </Button>
        </div>
      ) : null}
      {v.can.decline ? (
        <details className={card}>
          <summary className="cursor-pointer text-sm font-bold">Decline this visit</summary>
          <Field label="Reason for the patient">
            <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Button variant="danger" className="mt-2" disabled={busy || reason.trim().length < 3} onClick={() => act({ action: "decline", reason })}>
            Decline (any online payment is refunded)
          </Button>
        </details>
      ) : null}

      {v.can.reassign && v.team.length > 1 ? (
        <Field label="Send another team member">
          <select className={inputClass} value={v.visit.memberId ?? ""} onChange={(e) => e.target.value && act({ action: "reassign", memberId: e.target.value })} data-testid="care-reassign">
            {v.team.map((m) => (
              <option key={m.memberId} value={m.memberId}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {v.can.onTheWay ? (
        <section className={card}>
          {v.visit.status === "ON_THE_WAY" ? (
            <p className="text-sm font-bold text-teal-800">
              On the way since {ist(v.visit.onTheWayAt)}. {sharing ? "Your location is shared with the patient every 30 seconds while this page is open." : ""}
            </p>
          ) : null}
          <Button size="lg" variant={v.visit.status === "ON_THE_WAY" ? "secondary" : "primary"} onClick={onMyWay} disabled={busy} data-testid="care-on-my-way">
            {v.visit.status === "ON_THE_WAY" ? (sharing ? "📍 Sharing location" : "📍 Share my location again") : "🚗 On my way"}
          </Button>
          {geo.error ? <p className="mt-1 text-xs text-red-700">{geo.error}</p> : null}
        </section>
      ) : null}

      {v.can.checkIn ? (
        <section className={card}>
          <Field label="Check in: the patient's 4-digit check-in code" hint={`Shown in the patient's My Health. ${v.otpMaxAttempts - v.visit.otpAttempts} tries left.`}>
            <input className={`${inputClass} w-40 font-mono text-2xl tracking-[0.3em]`} inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))} data-testid="care-checkin-code" />
          </Field>
          <Button className="mt-2" size="lg" disabled={busy || code.length !== 4} onClick={() => act({ action: "check-in", code })} data-testid="care-check-in">
            Check in
          </Button>
        </section>
      ) : null}

      {v.can.checkOut ? (
        <section className={`${card} flex flex-col gap-3`} data-testid="care-checkout">
          <h2 className="text-base font-extrabold">Check out</h2>
          <p className="text-xs text-ink-600">Checked in {ist(v.visit.checkedInAt)}. Your notes and vitals go into the patient&apos;s health record as a visit note.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["bpSystolic", "BP systolic"],
              ["bpDiastolic", "BP diastolic"],
              ["pulse", "Pulse /min"],
              ["temperatureC", "Temp °C"],
              ["spo2", "SpO2 %"],
              ["bloodSugar", "Sugar mg/dL"],
              ["respiratoryRate", "Resp. /min"],
              ["weightKg", "Weight kg"],
            ].map(([k, label]) => (
              <Field key={k} label={label}>
                <input className={inputClass} inputMode="decimal" value={vitals[k] ?? ""} onChange={(e) => setVitals({ ...vitals, [k]: e.target.value.replace(/[^\d.]/g, "").slice(0, 6) })} />
              </Field>
            ))}
          </div>
          <Field label="Visit notes">
            <textarea className={inputClass} rows={4} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was done, observations, advice for next time" data-testid="care-notes" />
          </Field>
          <div className="flex flex-col gap-1 text-sm">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1 h-5 w-5" checked={photoConsent} onChange={(e) => setPhotoConsent(e.target.checked)} />
              <span>The patient (or family) agreed to photos for the record (e.g. a wound before / after).</span>
            </label>
            {photoConsent ? <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => void addPhotos(e.target.files)} /> : null}
            {photos.length ? <span className="text-xs text-ink-600">{photos.length} photo(s) added · <button type="button" className="underline" onClick={() => setPhotos([])}>remove</button></span> : null}
          </div>
          <Field label="The patient's 4-digit check-out code" hint={`${v.otpMaxAttempts - v.visit.otpAttempts} tries left.`}>
            <input className={`${inputClass} w-40 font-mono text-2xl tracking-[0.3em]`} inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))} data-testid="care-checkout-code" />
          </Field>
          <Button size="lg" disabled={busy || code.length !== 4 || notes.trim().length < 3} onClick={checkOut} data-testid="care-check-out">
            Check out and save the visit note
          </Button>
        </section>
      ) : null}

      {v.visit.status === "COMPLETED" ? (
        <Panel title="Visit done">
          <p className="text-sm">
            Checked in {ist(v.visit.checkedInAt)} · out {ist(v.visit.checkedOutAt)}
          </p>
          {v.visit.notes ? <p className="mt-1 whitespace-pre-line text-sm">{v.visit.notes}</p> : null}
          {v.documentId ? (
            <a href={`/api/health/care/visits/${visitId}/note`} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] px-3 text-sm font-bold">
              📄 Visit note (PDF)
            </a>
          ) : null}
          {b.rating ? <p className="mt-2 text-sm">Patient rating: {"★".repeat(b.rating)} {b.review ? `— ${b.review}` : ""}</p> : null}
        </Panel>
      ) : null}
      <Link href={`/shop/consult?booking=${b.id}`} className="text-sm font-bold text-kesari-800 underline">
        Payment, reschedule and more in Appointments →
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------ provider: profile + ID card */

interface ProfileMember {
  memberId: string;
  name: string;
  title: string | null;
  photoUrl: string | null;
  userId: string | null;
  categories: CareCategory[];
  profile: HealthCareProviderProfile | null;
  badges: CareBadges | null;
  idCard: CareIdCard | null;
}

export function CareProfileManager({ shopId }: { shopId: string }) {
  const [data, setData] = useState<{ shopName: string; canSetup: boolean; categories: CareCategory[]; members: ProfileMember[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<typeof data>(`/api/health/care/profile?shopId=${shopId}`).then(setData).catch((e) => setError(e.message)), [shopId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!data) return <p className="text-sm text-ink-600">Loading…</p>;
  if (!data.members.length) {
    return (
      <Alert tone="info">
        Nobody in your team is in a home-care category yet. Add the category (nurse, physiotherapist, attendant, baby care, massage therapist or sample collection) to a team member in{" "}
        <Link href={`/shop/consult/setup?shopId=${shopId}`} className="font-bold underline">
          Appointments → Setup
        </Link>
        , then fill the provider profile here.
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {data.members.map((m) => (
        <MemberProfile key={m.memberId} member={m} categories={data.categories} onSaved={load} />
      ))}
    </div>
  );
}

function MemberProfile({ member: m, categories, onSaved }: { member: ProfileMember; categories: CareCategory[]; onSaved: () => void }) {
  const p = m.profile;
  const [kind, setKind] = useState(p?.providerKind ?? "INDIVIDUAL");
  const [gender, setGender] = useState(p?.gender ?? "");
  const [cats, setCats] = useState<string[]>(p?.careCategories.length ? p.careCategories : m.categories.map((c) => c.slug));
  const [body, setBody] = useState(p?.registrationBody ?? "");
  const [number, setNumber] = useState(p?.registrationNumber ?? "");
  const [pins, setPins] = useState((p?.servicePincodes ?? []).join(", "));
  const [radius, setRadius] = useState(p?.serviceRadiusKm ?? 10);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/health/care/profile", {
        json: { memberId: m.memberId, providerKind: kind, gender: gender || null, careCategories: cats, registrationBody: body || null, registrationNumber: number || null, servicePincodes: pins.split(/[\s,]+/).filter(Boolean), serviceRadiusKm: radius },
      });
      setMsg({ tone: "success", text: p ? "Saved." : "Saved. GoKesari will complete the police verification; you appear in Health once it is done." });
      onSaved();
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "Could not save." });
    } finally {
      setBusy(false);
    }
  };
  const allowed = categories.filter((c) => m.categories.some((x) => x.id === c.id));
  return (
    <section className={card} data-testid="care-profile-member">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar url={m.photoUrl} name={m.name} />
          <div>
            <p className="text-lg font-extrabold">{m.name}</p>
            <p className="text-sm text-ink-700">{m.categories.map((c) => c.name).join(", ")}</p>
          </div>
        </div>
        {m.badges ? (
          <div className="flex flex-wrap gap-1">
            <Badge ok={m.badges.verified}>{m.badges.verified ? "Listed in GoKesari Health" : "Not listed yet"}</Badge>
          </div>
        ) : null}
      </div>
      {m.badges && !m.badges.verified ? (
        <ul className="mt-2 list-disc pl-5 text-xs text-amber-800">
          {m.badges.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Works as">
              <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="INDIVIDUAL">Individual</option>
                <option value="AGENCY">Agency staff</option>
              </select>
            </Field>
            <Field label="Gender">
              <select className={inputClass} value={gender} onChange={(e) => setGender(e.target.value)}>
                <option value="">Prefer not to say</option>
                {GENDERS.map((g) => (
                  <option key={g} value={g}>
                    {GENDER_LABELS[g]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <fieldset className="text-sm">
            <legend className="mb-1 font-medium text-ink-700">Care offered</legend>
            {allowed.map((c) => (
              <label key={c.slug} className="mr-3 inline-flex min-h-10 items-center gap-2">
                <input type="checkbox" className="h-5 w-5" checked={cats.includes(c.slug)} onChange={(e) => setCats(e.target.checked ? [...cats, c.slug] : cats.filter((x) => x !== c.slug))} />
                {c.name}
              </label>
            ))}
          </fieldset>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Registration body" hint="e.g. Maharashtra Nursing Council">
              <input className={inputClass} value={body} onChange={(e) => setBody(e.target.value)} />
            </Field>
            <Field label="Registration number">
              <input className={inputClass} value={number} onChange={(e) => setNumber(e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Service PIN codes" hint="Comma-separated; empty = any within the radius">
              <input className={inputClass} value={pins} onChange={(e) => setPins(e.target.value)} />
            </Field>
            <Field label="Travel up to (km)">
              <input className={inputClass} type="number" min={1} max={100} value={radius} onChange={(e) => setRadius(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
            </Field>
          </div>
          {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
          <Button onClick={save} disabled={busy} data-testid="care-profile-save">
            {p ? "Save profile" : "Create profile and ID card"}
          </Button>
          <p className="text-xs text-ink-600">Photo, qualifications, languages and experience come from Appointments → Setup → Team. Police verification is done by GoKesari.</p>
        </div>
        <div>
          {m.idCard ? (
            <>
              <IdCardView card={m.idCard} />
              <Button variant="secondary" className="mt-2" onClick={() => window.print()}>
                Print ID card
              </Button>
            </>
          ) : (
            <p className="text-sm text-ink-600">The ID card appears once the profile is saved.</p>
          )}
        </div>
      </div>
    </section>
  );
}
