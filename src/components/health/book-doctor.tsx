"use client";

/**
 * GoKesari Health booking (patient): who it is for (self or a family member) → in clinic / video →
 * time slot, or the day for a token clinic → reason → whether this doctor may see earlier GoKesari
 * records (yes / no / ask me) → pay online or at the clinic → confirm. Times are IST.
 */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { addDays, clock12, formatDateKey, istDateKey, istMinuteOfDay } from "@/lib/consult/time";
import { SHARE_CHOICE_LABELS, SHARE_CHOICES, type ShareChoice } from "@/lib/health/constants";
import type { BookingContext } from "@/server/health/find-doctor-views";
import { Alert, Button, Field, inputClass } from "@/components/ui";
import { api, Chip, MODE_ICON, modeLabel, rupees } from "./api";

interface Slot {
  start: string;
  memberIds: string[];
  places: number;
}

export function BookDoctor({ ctx, preselectPatientId, preselectDate }: { ctx: BookingContext; preselectPatientId: string | null; preselectDate: string | null }) {
  const router = useRouter();
  const s = ctx.service;
  const today = istDateKey(new Date());
  const [patientId, setPatientId] = useState(preselectPatientId ?? ctx.family[0]?.id ?? "");
  const modes = s.modes.filter((m) => m !== "HOME_VISIT");
  const [mode, setMode] = useState(modes[0] ?? "IN_PERSON");
  const startDay = preselectDate && preselectDate >= today ? preselectDate : today;
  const [from, setFrom] = useState(startDay);
  const [day, setDay] = useState(startDay);
  const [days, setDays] = useState<Record<string, Slot[]>>({});
  const [loading, setLoading] = useState(false);
  const [start, setStart] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [share, setShare] = useState<ShareChoice>("OFF");
  const [payment, setPayment] = useState<"ONLINE" | "PAY_AT_VISIT">(s.feeType !== "DEPOSIT" && s.payAtVisit && !s.payOnline ? "PAY_AT_VISIT" : "ONLINE");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the free times when the week changes
    setLoading(true);
    setStart(null);
    const p = new URLSearchParams({ serviceId: s.id, memberId: ctx.doctor.memberId, from, days: "7" });
    api<{ days: Record<string, Slot[]> }>(`/api/consult/availability?${p.toString()}`)
      .then((r) => {
        if (!live) return;
        setDays(r.days);
        const firstFree = Object.keys(r.days).sort().find((d) => r.days[d].length);
        setDay((cur) => (r.days[cur]?.length ? cur : (firstFree ?? cur)));
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [s.id, ctx.doctor.memberId, from]);

  const daySlots = useMemo(() => days[day] ?? [], [days, day]);
  // A token clinic: the day is chosen; the earliest free time that day holds the place, the token orders the queue.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- token clinics book the first free time of the chosen day
    if (ctx.tokenMode) setStart(daySlots[0]?.start ?? null);
  }, [ctx.tokenMode, daySlots]);

  const parts = [
    { label: "Morning", slots: daySlots.filter((x) => istMinuteOfDay(new Date(x.start)) < 720) },
    { label: "Afternoon", slots: daySlots.filter((x) => istMinuteOfDay(new Date(x.start)) >= 720 && istMinuteOfDay(new Date(x.start)) < 1020) },
    { label: "Evening", slots: daySlots.filter((x) => istMinuteOfDay(new Date(x.start)) >= 1020) },
  ];
  const free = s.feeType === "FREE" || s.feePaise === 0;
  const advance = s.feeType === "DEPOSIT" ? s.depositPaise : s.feePaise;
  const payNow = free ? 0 : payment === "ONLINE" ? advance : 0;

  const submit = async () => {
    if (!start || !patientId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ bookingId: string; checkoutUrl: string | null }>("/api/health/bookings", {
        json: {
          patientId,
          serviceId: s.id,
          memberId: ctx.doctor.memberId,
          mode,
          start,
          reason: reason.trim() || null,
          shareRecords: share,
          paymentMode: free ? null : payment,
          suggestionId: ctx.suggestionId,
          consent: consent ? true : undefined,
        },
      });
      if (r.checkoutUrl) window.location.href = r.checkoutUrl;
      else router.push(`/health/appointments/${r.bookingId}?new=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not book. Please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="health-book-doctor">
      <section>
        <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">1. Who is the appointment for?</h2>
        <div className="flex flex-wrap gap-1.5">
          {ctx.family.map((p) => (
            <Chip key={p.id} active={patientId === p.id} onClick={() => setPatientId(p.id)} testId="health-book-patient">
              {p.name} <span className="font-normal">({p.relation})</span>
            </Chip>
          ))}
        </div>
      </section>

      {modes.length > 1 ? (
        <section>
          <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">2. How</h2>
          <div className="flex flex-wrap gap-1.5">
            {modes.map((m) => (
              <Chip key={m} active={mode === m} onClick={() => setMode(m)} testId={`health-book-mode-${m}`}>
                {MODE_ICON[m]} {m === "IN_PERSON" ? "In clinic" : modeLabel(m)}
              </Chip>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink-600">{ctx.tokenMode ? "3. Day (you get a token number)" : "3. Day and time (IST)"}</h2>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" disabled={from <= today} onClick={() => setFrom(addDays(from, -7) < today ? today : addDays(from, -7))} aria-label="Earlier days">
              ‹
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setFrom(addDays(from, 7))} aria-label="Later days">
              ›
            </Button>
          </div>
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Day">
          {Object.keys(days)
            .sort()
            .map((d) => (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={d === day}
                onClick={() => setDay(d)}
                data-testid="health-book-day"
                className={`flex min-h-14 min-w-16 flex-col items-center justify-center rounded-xl border-2 px-2 text-xs font-bold ${d === day ? "border-kesari-600 bg-kesari-600 text-white" : days[d].length ? "border-[var(--gk-line)] bg-white text-ink-900" : "border-cream-200 bg-cream-50 text-ink-400"}`}
              >
                <span>{d === today ? "Today" : formatDateKey(d).slice(0, 3)}</span>
                <span className="text-sm">{d.slice(8)}</span>
                <span className="font-normal">{days[d].length ? (ctx.tokenMode ? "Open" : `${days[d].length} free`) : "Full"}</span>
              </button>
            ))}
        </div>
        <div className="mt-2 flex flex-col gap-2" data-testid="health-book-slots">
          {loading ? <p className="text-sm text-ink-600">Finding free times…</p> : null}
          {!loading && !daySlots.length ? <p className="text-sm text-ink-600">No free time on {formatDateKey(day)}. Pick another day.</p> : null}
          {ctx.tokenMode ? (
            daySlots.length ? <p className="text-sm text-ink-800">You will get a token number for {formatDateKey(day)}. The clinic calls patients in token order; watch your live queue position on the appointment page.</p> : null
          ) : (
            parts
              .filter((p) => p.slots.length)
              .map((p) => (
                <div key={p.label}>
                  <p className="mb-1 text-xs font-bold text-ink-600">{p.label}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {p.slots.map((x) => (
                      <Chip key={x.start} active={start === x.start} onClick={() => setStart(x.start)} testId="health-book-slot">
                        {clock12(istMinuteOfDay(new Date(x.start)))}
                      </Chip>
                    ))}
                  </div>
                </div>
              ))
          )}
        </div>
      </section>

      {start ? (
        <section className="flex flex-col gap-3 rounded-2xl border-2 border-kesari-300 bg-kesari-50 p-3" data-testid="health-book-details">
          <Field label="4. Reason for the visit (optional)" hint="Symptoms or questions — seen only by the doctor and the clinic.">
            <textarea className={inputClass} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} data-testid="health-book-reason" />
          </Field>
          <p className="text-xs text-ink-700">Reports: you can add lab reports or scans to this person&apos;s Health records any time before the visit.</p>
          <fieldset>
            <legend className="mb-1 text-sm font-bold text-ink-800">5. May this doctor see earlier GoKesari health records?</legend>
            <div className="flex flex-col gap-1">
              {SHARE_CHOICES.map((c) => (
                <label key={c} className="flex min-h-10 items-center gap-2 text-sm text-ink-800">
                  <input type="radio" name="share" className="h-5 w-5" checked={share === c} onChange={() => setShare(c)} data-testid={`health-book-share-${c}`} />
                  {SHARE_CHOICE_LABELS[c]}
                </label>
              ))}
            </div>
          </fieldset>
          {!free && s.feeType !== "DEPOSIT" && s.payOnline && s.payAtVisit ? (
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Payment">
              <Chip active={payment === "ONLINE"} onClick={() => setPayment("ONLINE")} testId="health-book-pay-online">
                Pay online now
              </Chip>
              <Chip active={payment === "PAY_AT_VISIT"} onClick={() => setPayment("PAY_AT_VISIT")} testId="health-book-pay-clinic">
                Pay at the clinic
              </Chip>
            </div>
          ) : null}
          <div className="rounded-xl bg-white p-3 text-sm">
            <p>
              <strong>{ctx.doctor.name}</strong> · {ctx.clinic.name}
            </p>
            <p>
              {s.name} · {mode === "IN_PERSON" ? "In clinic" : modeLabel(mode)} · {formatDateKey(istDateKey(new Date(start)))}
              {ctx.tokenMode ? " (token)" : `, ${clock12(istMinuteOfDay(new Date(start)))} IST`}
            </p>
            <p className="mt-1">
              Fee {free ? "Free" : rupees(s.feePaise)}
              {s.feeType === "DEPOSIT" ? ` — ${rupees(advance)} advance now, the rest at the clinic` : ""}
              {!free && s.feeType !== "DEPOSIT" && payment === "PAY_AT_VISIT" ? " — pay at the clinic" : ""}
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm text-ink-800">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="health-book-consent" />
            <span>I agree to share these details with the doctor and the clinic for this appointment.</span>
          </label>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button size="lg" onClick={submit} disabled={busy || !consent || !patientId} data-testid="health-book-confirm">
            {busy ? "Please wait…" : payNow > 0 ? `Pay ${rupees(payNow)} and book` : "Confirm booking"}
          </Button>
          {payNow > 0 ? <p className="text-xs text-ink-600">The time is held for you while you pay.</p> : null}
        </section>
      ) : null}
    </div>
  );
}
