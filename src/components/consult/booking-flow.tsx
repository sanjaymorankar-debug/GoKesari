"use client";

/**
 * Booking on a consultant's page (docs/consult-booking-2026-11): service →
 * how to meet → who (or any available) → day and time → visitor details →
 * pay online (the time is held for 10 minutes) or confirm (free / pay at
 * the visit). Benchmarked on Practo / Urban Company / Calendly: one screen,
 * the price and the policy visible before confirming, slots grouped by
 * morning / afternoon / evening.
 */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { CONSULT_CONSENT_TEXT } from "@/lib/consult/constants";
import { addDays, clock12, formatDateKey, istDateKey, istMinuteOfDay } from "@/lib/consult/time";
import { Alert, Button, Field, inputClass } from "@/components/ui";
import { api, Chip, MODE_ICON, modeLabel, rupees } from "./common";

export interface FlowService {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  feeType: "FREE" | "FIXED" | "DEPOSIT";
  feePaise: number;
  depositPaise: number;
  modes: string[];
  bookingKind: "INDIVIDUAL" | "TEAM" | "GROUP";
  capacity: number;
  requiredMembers: number;
  memberIds: string[];
  payOnline: boolean;
  payAtVisit: boolean;
}

export interface FlowMember {
  id: string;
  name: string;
  title: string | null;
}

interface Slot {
  start: string;
  memberIds: string[];
  places: number;
}

interface Props {
  services: FlowService[];
  members: FlowMember[];
  signedIn: boolean;
  bookable: boolean;
  policy: string[];
  me: { name: string | null; phone: string | null; email: string | null } | null;
  preselect?: { serviceId?: string | null; memberId?: string | null };
}

export function ConsultBookingFlow({ services, members, signedIn, bookable, policy, me, preselect }: Props) {
  const router = useRouter();
  const [serviceId, setServiceId] = useState(preselect?.serviceId ?? services[0]?.id ?? "");
  const service = services.find((s) => s.id === serviceId) ?? null;
  const [mode, setMode] = useState(service?.modes[0] ?? "IN_PERSON");
  const offering = useMemo(() => (service ? (service.memberIds.length ? members.filter((m) => service.memberIds.includes(m.id)) : members) : []), [service, members]);
  const [memberId, setMemberId] = useState<string>(preselect?.memberId ?? "");
  const today = istDateKey(new Date());
  const [from, setFrom] = useState(today);
  const [day, setDay] = useState(today);
  const [attendees, setAttendees] = useState(1);
  const [days, setDays] = useState<Record<string, Slot[]>>({});
  const [loading, setLoading] = useState(false);
  const [start, setStart] = useState<string | null>(null);
  const [name, setName] = useState(me?.name ?? "");
  const [phone, setPhone] = useState(me?.phone?.replace(/^\+91/, "") ?? "");
  const [age, setAge] = useState("");
  const [note, setNote] = useState("");
  const [address, setAddress] = useState("");
  const [payment, setPayment] = useState<"ONLINE" | "PAY_AT_VISIT">(() => { const s0 = services.find((s) => s.id === (preselect?.serviceId ?? services[0]?.id)); return s0 && s0.feeType !== "DEPOSIT" && s0.payAtVisit && !s0.payOnline ? "PAY_AT_VISIT" : "ONLINE"; });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickService = (id: string) => {
    const next = services.find((s) => s.id === id);
    setServiceId(id);
    if (!next) return;
    if (!next.modes.includes(mode)) setMode(next.modes[0]);
    const nextOffering = next.memberIds.length ? members.filter((m) => next.memberIds.includes(m.id)) : members;
    if (memberId && !nextOffering.some((m) => m.id === memberId)) setMemberId("");
    setPayment(next.feeType === "DEPOSIT" || !next.payAtVisit ? "ONLINE" : next.payOnline ? "ONLINE" : "PAY_AT_VISIT");
    if (next.bookingKind !== "GROUP") setAttendees(1);
  };

  useEffect(() => {
    if (!serviceId) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the free times (server data) when the choice changes
    setLoading(true);
    setStart(null);
    const p = new URLSearchParams({ serviceId, from, days: "7", attendees: String(attendees) });
    if (memberId) p.set("memberId", memberId);
    api<{ days: Record<string, Slot[]> }>(`/api/consult/availability?${p.toString()}`)
      .then((r) => {
        if (!live) return;
        setDays(r.days);
        const first = Object.keys(r.days).sort().find((d) => r.days[d].length);
        if (first && !(r.days[day]?.length)) setDay(first);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, memberId, from, attendees]);

  if (!services.length) return <Alert tone="info">This consultant has not listed any services yet.</Alert>;

  const daySlots = days[day] ?? [];
  const parts = [
    { label: "Morning", slots: daySlots.filter((s) => istMinuteOfDay(new Date(s.start)) < 720) },
    { label: "Afternoon", slots: daySlots.filter((s) => istMinuteOfDay(new Date(s.start)) >= 720 && istMinuteOfDay(new Date(s.start)) < 1020) },
    { label: "Evening", slots: daySlots.filter((s) => istMinuteOfDay(new Date(s.start)) >= 1020) },
  ];
  const units = service?.bookingKind === "GROUP" ? attendees : 1;
  const total = (service?.feePaise ?? 0) * units;
  const advance = service?.feeType === "DEPOSIT" ? service.depositPaise * units : total;
  const payNow = service?.feeType === "FREE" ? 0 : payment === "ONLINE" ? advance : 0;

  const submit = async () => {
    if (!signedIn) {
      router.push(`/signin?callbackUrl=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    if (!service || !start) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ booking: { id: string }; checkoutUrl: string | null }>("/api/consult/bookings", {
        json: {
          serviceId: service.id,
          memberId: memberId || null,
          mode,
          start,
          attendees,
          visitorName: name,
          visitorPhone: phone || null,
          visitorAge: age ? Number(age) : null,
          note: note || null,
          visitAddress: mode === "HOME_VISIT" ? address : null,
          paymentMode: service.feeType === "FREE" ? null : payment,
          consent: consent ? true : undefined,
        },
      });
      if (r.checkoutUrl) window.location.href = r.checkoutUrl;
      else router.push(`/consult/bookings/${r.booking.id}?new=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not book. Please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="consult-booking-flow">
      {!bookable ? <Alert tone="warning">This consultant is not taking bookings right now.</Alert> : null}
      <section>
        <h3 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">1. Service</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {services.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => pickService(s.id)}
              aria-pressed={s.id === serviceId}
              data-testid="consult-service"
              className={`flex flex-col items-start rounded-xl border-2 p-3 text-left ${s.id === serviceId ? "border-kesari-600 bg-kesari-50" : "border-[var(--gk-line)] bg-white hover:border-kesari-300"}`}
            >
              <span className="font-bold text-ink-900">{s.name}</span>
              <span className="text-sm text-ink-700">
                {s.durationMinutes} min · {s.feeType === "FREE" ? "Free" : s.feeType === "DEPOSIT" ? `${rupees(s.feePaise)} (advance ${rupees(s.depositPaise)})` : rupees(s.feePaise)}
                {s.bookingKind === "GROUP" ? ` per person · up to ${s.capacity}` : s.bookingKind === "TEAM" ? ` · ${s.requiredMembers} consultants together` : ""}
              </span>
              {s.description ? <span className="mt-0.5 line-clamp-2 text-xs text-ink-600">{s.description}</span> : null}
            </button>
          ))}
        </div>
      </section>

      {service ? (
        <section className="grid gap-3 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">2. How to meet</h3>
            <div className="flex flex-wrap gap-1.5">
              {service.modes.map((m) => (
                <Chip key={m} active={mode === m} onClick={() => setMode(m)} testId={`consult-pick-mode-${m}`}>
                  {MODE_ICON[m]} {modeLabel(m)}
                </Chip>
              ))}
            </div>
          </div>
          {service.bookingKind !== "TEAM" && offering.length > 1 ? (
            <div>
              <h3 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">3. With</h3>
              <div className="flex flex-wrap gap-1.5">
                <Chip active={!memberId} onClick={() => setMemberId("")} testId="consult-any-member">
                  Any available
                </Chip>
                {offering.map((m) => (
                  <Chip key={m.id} active={memberId === m.id} onClick={() => setMemberId(m.id)}>
                    {m.name}
                  </Chip>
                ))}
              </div>
            </div>
          ) : null}
          {service.bookingKind === "GROUP" ? (
            <Field label="People attending">
              <input className={`${inputClass} w-28`} type="number" min={1} max={service.capacity} value={attendees} onChange={(e) => setAttendees(Math.max(1, Math.min(service.capacity, Number(e.target.value) || 1)))} />
            </Field>
          ) : null}
        </section>
      ) : null}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-extrabold uppercase tracking-wide text-ink-600">4. Day and time (IST)</h3>
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
                className={`flex min-h-14 min-w-16 flex-col items-center justify-center rounded-xl border-2 px-2 text-xs font-bold ${d === day ? "border-kesari-600 bg-kesari-600 text-white" : days[d].length ? "border-[var(--gk-line)] bg-white text-ink-900" : "border-cream-200 bg-cream-50 text-ink-400"}`}
              >
                <span>{d === today ? "Today" : formatDateKey(d).slice(0, 3)}</span>
                <span className="text-sm">{d.slice(8)}</span>
                <span className="font-normal">{days[d].length ? `${days[d].length} free` : "Full"}</span>
              </button>
            ))}
        </div>
        <div className="mt-2 flex flex-col gap-2" data-testid="consult-slots">
          {loading ? <p className="text-sm text-ink-600">Finding free times…</p> : null}
          {!loading && !daySlots.length ? <p className="text-sm text-ink-600">No free time on {formatDateKey(day)}. Pick another day.</p> : null}
          {parts
            .filter((p) => p.slots.length)
            .map((p) => (
              <div key={p.label}>
                <p className="mb-1 text-xs font-bold text-ink-600">{p.label}</p>
                <div className="flex flex-wrap gap-1.5">
                  {p.slots.map((s) => (
                    <Chip key={s.start} active={start === s.start} onClick={() => setStart(s.start)} testId="consult-slot">
                      {clock12(istMinuteOfDay(new Date(s.start)))}
                      {service?.bookingKind === "GROUP" ? ` · ${s.places} left` : ""}
                    </Chip>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </section>

      {start && service ? (
        <section className="flex flex-col gap-3 rounded-2xl border-2 border-kesari-300 bg-kesari-50 p-3" data-testid="consult-details">
          <h3 className="text-sm font-extrabold uppercase tracking-wide text-ink-700">5. Visitor details</h3>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Name">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" data-testid="consult-visitor-name" />
            </Field>
            <Field label="Mobile">
              <input className={inputClass} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, "").slice(0, 10))} autoComplete="tel-national" placeholder="10 digits" />
            </Field>
            <Field label="Age (optional)">
              <input className={inputClass} inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, "").slice(0, 3))} />
            </Field>
          </div>
          {mode === "HOME_VISIT" ? (
            <Field label="Address for the visit">
              <textarea className={inputClass} rows={2} value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" />
            </Field>
          ) : null}
          <Field label="Notes for the consultant (optional)" hint="Symptoms, case details or questions. Seen only by the consultant and GoKesari support. You can attach files after booking.">
            <textarea className={inputClass} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </Field>
          {service.feeType !== "FREE" && service.feeType !== "DEPOSIT" && service.payOnline && service.payAtVisit ? (
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Payment">
              <Chip active={payment === "ONLINE"} onClick={() => setPayment("ONLINE")} testId="consult-pay-online">
                Pay online now (UPI, card, net banking)
              </Chip>
              <Chip active={payment === "PAY_AT_VISIT"} onClick={() => setPayment("PAY_AT_VISIT")} testId="consult-pay-visit">
                Pay at the visit
              </Chip>
            </div>
          ) : null}
          <div className="rounded-xl bg-white p-3 text-sm">
            <p>
              <strong>{service.name}</strong> · {modeLabel(mode)} · {formatDateKey(istDateKey(new Date(start)))}, {clock12(istMinuteOfDay(new Date(start)))} · {service.durationMinutes} min
            </p>
            <p className="mt-1">
              Fee {service.feeType === "FREE" ? "Free" : rupees(total)}
              {service.feeType === "DEPOSIT" ? ` — ${rupees(advance)} advance now, ${rupees(total - advance)} at the visit` : ""}
              {service.feeType === "FIXED" && payment === "PAY_AT_VISIT" ? " — pay at the visit" : ""}
            </p>
            <ul className="mt-2 list-disc pl-5 text-xs text-ink-700">
              {policy.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <label className="flex items-start gap-2 text-sm text-ink-800">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="consult-consent" />
            <span>{CONSULT_CONSENT_TEXT}</span>
          </label>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button size="lg" onClick={submit} disabled={busy || !bookable || !consent || name.trim().length < 2 || (mode === "HOME_VISIT" && !address.trim())} data-testid="consult-confirm">
            {!signedIn ? "Sign in to book" : busy ? "Please wait…" : payNow > 0 ? `Pay ${rupees(payNow)} and book` : "Confirm booking"}
          </Button>
          {payNow > 0 ? <p className="text-xs text-ink-600">The time is held for you for 10 minutes while you pay.</p> : null}
        </section>
      ) : null}
    </div>
  );
}
