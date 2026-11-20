"use client";

/**
 * GoKesari Health — doctor and clinic reception screens: Today (live, with sound), queue, check-in, walk-ins,
 * the consultation pad and e-prescription, letterhead / print settings, doctor profile and templates.
 */
import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  autoQuantity,
  DRUG_FORMS,
  LETTERHEAD_MODE_LABELS,
  LETTERHEAD_MODES,
  LOCAL_LANGUAGE_LABELS,
  LOCAL_LANGUAGES,
  MEDICAL_COUNCILS,
  NMC_ETHICS_NOTE,
  PAPER_SIZES,
  PRACTITIONER_TYPES,
  RX_FREQUENCIES,
  RX_FREQUENCY_LABELS,
  RX_SECTION_LABELS,
  RX_SECTIONS,
  RX_TIMINGS,
  RX_TIMING_LABELS,
  SUGGESTION_TYPE_LABELS,
  SUGGESTION_TYPES,
  TELE_LIST_LABELS,
  bmiOf,
  type SuggestionType,
  type TeleList,
} from "@/lib/health/constants";
import { api, ist, Panel } from "./api";
import { chime, useHealthLive } from "./live";

const inputCls = "min-h-11 w-full rounded-xl border-2 border-[var(--gk-line)] bg-white px-3 py-2 text-base text-ink-900 focus:border-kesari-500 focus:outline-none";
const smallInput = "min-h-10 w-full rounded-lg border-2 border-[var(--gk-line)] bg-white px-2 py-1 text-sm text-ink-900 focus:border-kesari-500 focus:outline-none";
const btn = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-extrabold disabled:opacity-60";
const PRIMARY = `${btn} bg-kesari-700 text-white hover:bg-kesari-800`;
const SECONDARY = `${btn} border-2 border-[var(--gk-line)] bg-white text-ink-900 hover:border-kesari-400`;
const DANGER = `${btn} border-2 border-red-300 bg-white text-red-800 hover:bg-red-50`;

function Err({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="rounded-xl border-2 border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
      {error}
    </p>
  ) : null;
}

export interface Seat {
  memberId: string;
  shopId: string;
  shopName: string;
  name: string;
  verified: boolean;
  reasons: string[];
  profile: null | { fullName: string; qualifications: string; specialties: string[]; council: string; registrationNumber: string; registrationYear: number | null; hprId: string | null; practitionerType: string; hasSignature: boolean; hasStamp: boolean };
}

/* ------------------------------------------------------------ Today */

interface TodayRow {
  bookingId: string;
  bookingNumber: string;
  startsAt: string;
  status: string;
  mode: string;
  patientId: string | null;
  patientName: string;
  age: string | null;
  gender: string | null;
  visitType: string;
  reason: string | null;
  paymentStatus: string;
  paymentMode: string;
  feePaise: number;
  arrivedAt: string | null;
  calledAt: string | null;
  tokenNumber: number | null;
  memberId: string;
  memberName: string;
  walkIn: boolean;
  consultationId: string | null;
  consultationStatus: string | null;
  prescriptionId: string | null;
  referralNote: string | null;
  meetingUrl: string | null;
}

const istTime = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
const todayKey = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function TodayBoard({ seats, shops, initialShopId, canConsult }: { seats: Seat[]; shops: { id: string; name: string }[]; initialShopId: string; canConsult: boolean }) {
  const router = useRouter();
  const [shopId, setShopId] = useState(initialShopId);
  const [date, setDate] = useState(todayKey());
  const [rows, setRows] = useState<TodayRow[] | null>(null);
  /** When the list was last loaded: "No-show" shows for appointments that had started by then. */
  const [loadedAt, setLoadedAt] = useState(0);
  const [tokenMode, setTokenMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [showWalkIn, setShowWalkIn] = useState(false);
  const [sound, setSound] = useState(true);
  const seatsHere = seats.filter((s) => s.shopId === shopId);
  const load = useCallback(async () => {
    try {
      const r = await api<{ rows: TodayRow[]; settings: { tokenMode: boolean } }>(`/api/health/clinic/${shopId}?date=${date}`);
      setRows(r.rows);
      setLoadedAt(Date.now());
      setTokenMode(r.settings.tokenMode);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [shopId, date]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the clinic or day changes
    void load();
  }, [load]);
  const live = useHealthLive(
    (e) => e.shopId === shopId && (e.name.startsWith("appointment.") || e.name === "queue.updated" || e.name.startsWith("prescription.") || e.name === "consultation.started"),
    (e) => {
      const k = String(e.payload.kind ?? "");
      if (sound && (e.name === "appointment.booked" || ["BOOKED", "CONFIRMED", "CANCELLED", "CHECKED_IN"].includes(k) || e.name === "appointment.checked_in")) chime();
      setFlash(e.name === "appointment.checked_in" || k === "CHECKED_IN" ? "A patient checked in" : k === "CANCELLED" ? "A booking was cancelled" : e.name === "appointment.booked" || k === "BOOKED" || k === "CONFIRMED" ? "New booking" : null);
      void load();
    },
  );
  const act = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      await api(`/api/health/clinic/${shopId}`, { json: body });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const consultAction = async (bookingId: string, action: string) => {
    setError(null);
    try {
      await api(`/api/consult/bookings/${bookingId}`, { json: { action } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const start = async (r: TodayRow) => {
    setError(null);
    try {
      const { consultation } = await api<{ consultation: { id: string } }>("/api/health/consultations", { json: { memberId: r.memberId, bookingId: r.bookingId } });
      router.push(`/shop/health/consult/${consultation.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const move = (idx: number, dir: -1 | 1) => {
    if (!rows) return;
    const list = rows.filter((r) => r.status === "CONFIRMED");
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((r) => r.bookingId);
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    void act({ action: "reorder", bookingIds: ids });
  };
  const waiting = (rows ?? []).filter((r) => r.status === "CONFIRMED" && !r.consultationStatus);
  const next = waiting.find((r) => r.arrivedAt && !r.calledAt) ?? waiting.find((r) => r.arrivedAt);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        {shops.length > 1 ? (
          <label className="text-xs font-bold text-ink-700">
            Clinic
            <select className={inputCls} value={shopId} onChange={(e) => setShopId(e.target.value)}>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="text-xs font-bold text-ink-700">
          Day
          <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} data-testid="today-date" />
        </label>
        <button type="button" className={SECONDARY} onClick={() => setShowWalkIn((v) => !v)} data-testid="today-walkin-open">
          + Walk-in / book for a patient
        </button>
        {next ? (
          <button type="button" className={PRIMARY} onClick={() => act({ action: "call", bookingId: next.bookingId })} data-testid="today-call-next">
            Call next: {next.tokenNumber ? `#${next.tokenNumber} ` : ""}
            {next.patientName}
          </button>
        ) : null}
        <label className="flex min-h-11 items-center gap-2 text-xs font-bold text-ink-700">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Sound
        </label>
        <span className="ml-auto text-xs font-bold" data-testid="health-live" data-status={live}>
          {live === "live" ? <span className="text-leaf-800">● Live</span> : <span className="text-amber-700">○ Connecting…</span>}
        </span>
      </div>
      {flash ? (
        <p className="rounded-xl border-2 border-teal-300 bg-teal-50 px-3 py-2 text-sm font-extrabold text-teal-900" role="status">
          {flash}
        </p>
      ) : null}
      {seatsHere.some((s) => !s.verified) ? (
        <p className="rounded-xl border-2 border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Not verified yet: {seatsHere.filter((s) => !s.verified).map((s) => `${s.name} — ${s.reasons.join(" ")}`).join(" ")} Bookings through Health and prescriptions open after verification.{" "}
          <Link href="/shop/health/settings" className="font-bold underline">
            Complete the doctor profile
          </Link>
        </p>
      ) : null}
      {showWalkIn ? <WalkInForm shopId={shopId} seats={seatsHere} onDone={() => (setShowWalkIn(false), void load())} /> : null}
      <Err error={error} />
      {codeFor ? (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border-2 border-kesari-300 bg-kesari-50 p-3">
          <label className="text-sm font-bold text-ink-900">
            Patient&apos;s 4-digit code or scanned QR
            <input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} autoFocus data-testid="today-checkin-code" />
          </label>
          <button type="button" className={PRIMARY} onClick={() => act({ action: "checkin", bookingId: codeFor, code }).then(() => (setCodeFor(null), setCode("")))} data-testid="today-checkin-submit">
            Check in
          </button>
          <button type="button" className={SECONDARY} onClick={() => act({ action: "checkin", bookingId: codeFor, code: null }).then(() => setCodeFor(null))}>
            Arrived (no code)
          </button>
          <button type="button" className={SECONDARY} onClick={() => setCodeFor(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      {rows == null ? (
        <p className="text-sm text-ink-600">Loading…</p>
      ) : rows.length ? (
        <ol className="flex flex-col gap-2" data-testid="today-list">
          {rows.map((r) => {
            const idx = waiting.findIndex((w) => w.bookingId === r.bookingId);
            return (
              <li
                key={r.bookingId}
                data-testid="today-row"
                data-status={r.status}
                className={clsx(
                  "rounded-2xl border-2 p-3",
                  r.status === "CANCELLED" || r.status === "NO_SHOW" ? "border-stone-300 bg-stone-50 opacity-70" : r.consultationStatus === "COMPLETED" || r.status === "COMPLETED" ? "border-leaf-300 bg-leaf-50" : r.arrivedAt ? "border-teal-400 bg-teal-50" : "border-[var(--gk-line)] bg-white",
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-extrabold text-ink-900">
                      {tokenMode && r.tokenNumber ? <span className="mr-2 rounded-lg bg-ink-900 px-2 py-0.5 text-white">#{r.tokenNumber}</span> : null}
                      {istTime(r.startsAt)} · {r.patientName}
                      {r.age || r.gender ? <span className="font-semibold text-ink-700"> ({[r.age, r.gender?.charAt(0)].filter(Boolean).join(", ")})</span> : null}
                    </p>
                    <p className="text-xs text-ink-700">
                      <span className={clsx("mr-1 rounded-full px-2 py-0.5 font-bold", r.visitType === "NEW" ? "bg-violet-100 text-violet-900" : "bg-blue-100 text-blue-900")}>{r.visitType === "NEW" ? "New" : "Follow-up"}</span>
                      {r.mode === "VIDEO" ? "🎥 Video" : r.mode === "HOME_VISIT" ? "🏠 Home" : "🏢 Clinic"} · {r.memberName}
                      {r.walkIn ? " · walk-in" : ""} · {r.paymentStatus === "PAID" ? "Paid online" : r.paymentStatus === "DUE" ? "Pay at clinic" : r.paymentStatus === "NOT_REQUIRED" ? "Free" : r.paymentStatus}
                      {r.arrivedAt ? ` · arrived ${istTime(r.arrivedAt)}` : ""}
                      {r.calledAt ? " · called" : ""}
                    </p>
                    {r.reason ? <p className="text-xs text-ink-700">Reason: {r.reason}</p> : null}
                    {r.referralNote ? <p className="text-xs font-bold text-teal-900">Referral note: {r.referralNote}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {r.status === "CONFIRMED" && !r.arrivedAt ? (
                      <button type="button" className={SECONDARY} onClick={() => setCodeFor(r.bookingId)} data-testid="today-checkin">
                        Check in
                      </button>
                    ) : null}
                    {r.status === "CONFIRMED" && idx >= 0 ? (
                      <>
                        <button type="button" className={SECONDARY} aria-label="Move up" onClick={() => move(idx, -1)}>
                          ↑
                        </button>
                        <button type="button" className={SECONDARY} aria-label="Move down" onClick={() => move(idx, 1)}>
                          ↓
                        </button>
                        <button type="button" className={SECONDARY} onClick={() => act({ action: "call", bookingId: r.bookingId })}>
                          Call
                        </button>
                      </>
                    ) : null}
                    {canConsult && (r.status === "CONFIRMED" || r.status === "COMPLETED") && !r.prescriptionId ? (
                      <button type="button" className={PRIMARY} onClick={() => start(r)} data-testid="today-consult">
                        {r.consultationId ? "Continue" : "Consult"}
                      </button>
                    ) : null}
                    {r.prescriptionId ? (
                      <>
                        <Link className={SECONDARY} href={`/health/prescriptions/${r.prescriptionId}`}>
                          Prescription
                        </Link>
                        <a className={SECONDARY} href={`/health/prescriptions/${r.prescriptionId}/print`} target="_blank" rel="noreferrer">
                          Print
                        </a>
                      </>
                    ) : null}
                    {r.mode === "VIDEO" && r.meetingUrl && r.status === "CONFIRMED" ? (
                      <a className={SECONDARY} href={r.meetingUrl} target="_blank" rel="noreferrer">
                        Join video
                      </a>
                    ) : null}
                    {r.status === "CONFIRMED" && new Date(r.startsAt).getTime() < loadedAt ? (
                      <button type="button" className={DANGER} onClick={() => consultAction(r.bookingId, "no-show")}>
                        No-show
                      </button>
                    ) : null}
                    {r.paymentStatus === "DUE" && r.status !== "CANCELLED" ? (
                      <Link className={SECONDARY} href={`/shop/consult?booking=${r.bookingId}`}>
                        Take payment
                      </Link>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-ink-600">No appointments on this day.</p>
      )}
    </div>
  );
}

function WalkInForm({ shopId, seats, onDone }: { shopId: string; seats: Seat[]; onDone: () => void }) {
  const [services, setServices] = useState<{ id: string; name: string; memberIds: string[] }[]>([]);
  const [memberId, setMemberId] = useState(seats[0]?.memberId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ services?: { id: string; name: string; memberIds: string[]; status: string }[] }>(`/api/consult/firm/${shopId}?view=setup`)
      .then((r) => setServices((r.services ?? []).filter((s) => s.status === "ACTIVE")))
      .catch(() => setServices([]));
  }, [shopId]);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api(`/api/health/clinic/${shopId}`, { json: { action: "walkin", memberId, serviceId: f.get("serviceId"), contact: f.get("contact"), patientName: f.get("patientName"), dateOfBirth: f.get("dateOfBirth") || null, reason: f.get("reason") || null } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const list = services.filter((s) => !s.memberIds?.length || s.memberIds.includes(memberId));
  return (
    <form onSubmit={submit} className="grid gap-2 rounded-2xl border-2 border-kesari-200 bg-kesari-50 p-3 sm:grid-cols-3" data-testid="walkin-form">
      <label className="text-xs font-bold text-ink-700">
        Doctor
        <select className={inputCls} value={memberId} onChange={(e) => setMemberId(e.target.value)}>
          {seats.map((s) => (
            <option key={s.memberId} value={s.memberId}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-bold text-ink-700">
        Service
        <select name="serviceId" className={inputCls} required>
          {list.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-bold text-ink-700">
        Patient&apos;s GoKesari mobile / e-mail
        <input name="contact" required className={inputCls} />
      </label>
      <label className="text-xs font-bold text-ink-700">
        Patient name
        <input name="patientName" required className={inputCls} />
      </label>
      <label className="text-xs font-bold text-ink-700">
        Date of birth
        <input name="dateOfBirth" type="date" className={inputCls} />
      </label>
      <label className="text-xs font-bold text-ink-700">
        Reason
        <input name="reason" className={inputCls} />
      </label>
      <div className="sm:col-span-3">
        <Err error={error} />
        <button className={PRIMARY} disabled={busy} data-testid="walkin-submit">
          {busy ? "Adding…" : "Add to today (next free time, token given)"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------ the pad */

interface Drug {
  id: string;
  genericName: string;
  brandName: string | null;
  strength: string | null;
  form: string;
  teleList: string;
  schedule: string;
}
interface Item {
  drugId: string | null;
  genericName: string;
  brandName: string | null;
  strength: string | null;
  form: string;
  dose: string;
  frequency: string;
  timing: string;
  durationDays: number;
  quantity: number | null;
  instructions: string;
  instructionsLocal: string;
  teleList?: string | null;
}
interface Sugg {
  type: SuggestionType;
  urgency: "ROUTINE" | "SOON" | "URGENT";
  printOnRx: boolean;
  specialty?: string;
  targetMemberId?: string | null;
  targetLabel?: string;
  note?: string;
  careCategory?: string;
  serviceType?: string;
  frequency?: string;
  durationDays?: number | null;
  startDate?: string;
  equipment?: string;
  buyOrRent?: "BUY" | "RENT";
  tests?: string;
  homeCollection?: boolean;
  followUpDate?: string;
}
interface Summary {
  patient: { id: string; fullName: string; dateOfBirth: string | null; gender: string | null; bloodGroup: string | null; allergies: string[]; conditions: string[]; currentMedicines: string | null; abhaNumber: string | null };
  age: string | null;
  ownVisits: { id: string; date: string; diagnoses: string; rxNumber: string | null; prescriptionId: string | null }[];
  currentMedicines: { name: string; dose: string; until: string; doctor: string }[];
  consent: { allowed: boolean; mode: string };
  others: { id: string; at: string; kind: string; title: string; summary: string | null; provider: string | null }[] | null;
  documents: { id: string; title: string; kind: string; source: string; date: string | null }[] | null;
}
interface Consultation {
  id: string;
  bookingId: string | null;
  shopId: string;
  memberId: string;
  patientId: string;
  mode: string;
  visitType: string;
  status: string;
  vitals: Record<string, number | null | undefined>;
  chiefComplaints: string | null;
  history: string | null;
  examination: string | null;
  diagnoses: { code?: string | null; text: string }[];
  investigations: { name: string; note?: string | null }[];
  advice: string | null;
  followUpDate: string | null;
}
interface Warning {
  line: number;
  kind: string;
  message: string;
}

const EMPTY_ITEM: Item = { drugId: null, genericName: "", brandName: null, strength: null, form: "TABLET", dose: "1 tablet", frequency: "1-0-1", timing: "AFTER_FOOD", durationDays: 5, quantity: null, instructions: "", instructionsLocal: "" };

function DrugSearch({ onPick }: { onPick: (d: Drug) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<Drug[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the suggestions when the search box is emptied
      setList([]);
      return;
    }
    const t = setTimeout(() => void api<{ drugs: Drug[] }>(`/api/health/drugs?q=${encodeURIComponent(q)}`).then((r) => setList(r.drugs)).catch(() => setList([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="relative">
      <input className={inputCls} placeholder="Add medicine: type brand or generic" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search medicines" data-testid="pad-drug-search" />
      {list.length ? (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border-2 border-[var(--gk-line)] bg-white shadow-lg">
          {list.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-kesari-50"
                onClick={() => {
                  onPick(d);
                  setQ("");
                  setList([]);
                }}
                data-testid="pad-drug-option"
              >
                <span className="font-bold">{d.brandName ? `${d.brandName} (${d.genericName})` : d.genericName}</span> {d.strength} {d.form.toLowerCase()}
                <span className={clsx("ml-2 rounded px-1 text-xs font-bold", d.teleList === "PROHIBITED" ? "bg-red-100 text-red-800" : d.teleList === "B" ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-ink-700")}>{d.teleList === "PROHIBITED" ? "No tele" : `List ${d.teleList}`}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function IcdSearch({ onPick }: { onPick: (c: { code: string; title: string }) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<{ code: string; title: string }[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the suggestions when the search box is emptied
      setList([]);
      return;
    }
    const t = setTimeout(() => void api<{ codes: { code: string; title: string }[] }>(`/api/health/drugs?icd=1&q=${encodeURIComponent(q)}`).then((r) => setList(r.codes)).catch(() => setList([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="relative">
      <input
        className={inputCls}
        placeholder="Diagnosis: type and press Enter, or pick an ICD-10 code"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && q.trim().length >= 2) {
            e.preventDefault();
            onPick({ code: "", title: q.trim() });
            setQ("");
          }
        }}
        aria-label="Diagnosis"
        data-testid="pad-diagnosis"
      />
      {list.length ? (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-xl border-2 border-[var(--gk-line)] bg-white shadow-lg">
          {list.map((c) => (
            <li key={c.code}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-kesari-50"
                onClick={() => {
                  onPick(c);
                  setQ("");
                  setList([]);
                }}
              >
                <span className="font-mono font-bold">{c.code}</span> {c.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ConsultationPad({ consultation: initial, summary, letterheadAutoPrint, localLanguage, careCategories }: { consultation: Consultation; summary: Summary; letterheadAutoPrint: boolean; localLanguage: string; careCategories: { slug: string; name: string }[] }) {
  const router = useRouter();
  const [c, setC] = useState(initial);
  const [items, setItems] = useState<Item[]>([]);
  const [sugg, setSugg] = useState<Sugg[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ id: string; rxNumber: string; bookingCompleted: boolean } | null>(null);
  const [templates, setTemplates] = useState<{ id: string; kind: string; name: string; content: { items?: Item[]; advice?: string; investigations?: { name: string }[]; diagnoses?: { code?: string | null; text: string }[] } }[]>([]);
  const [requested, setRequested] = useState(false);
  const firstLoad = useRef(true);
  const readOnly = c.status !== "IN_PROGRESS";
  const remote = c.mode === "VIDEO" || c.mode === "PHONE";

  useEffect(() => {
    void api<{ templates: typeof templates }>(`/api/health/doctor/${c.memberId}`).then((r) => setTemplates(r.templates)).catch(() => undefined);
  }, [c.memberId]);

  // Autosave the draft a moment after typing stops.
  const draftBody = useMemo(
    () => ({ action: "draft", vitals: c.vitals, chiefComplaints: c.chiefComplaints, history: c.history, examination: c.examination, diagnoses: c.diagnoses, investigations: c.investigations, advice: c.advice, followUpDate: c.followUpDate }),
    [c.vitals, c.chiefComplaints, c.history, c.examination, c.diagnoses, c.investigations, c.advice, c.followUpDate],
  );
  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    if (readOnly) return;
    const t = setTimeout(() => {
      void api(`/api/health/consultations/${c.id}`, { json: cleanDraft(draftBody) })
        .then(() => setSaved(`Saved ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })}`))
        .catch((e) => setError((e as Error).message));
    }, 1500);
    return () => clearTimeout(t);
  }, [draftBody, c.id, readOnly]);

  // Live check of medicines (telemedicine lists, allergies, duplicates).
  const itemsPayload = useMemo(() => items.filter((i) => i.genericName.trim()).map(itemPayload), [items]);
  useEffect(() => {
    if (readOnly) return;
    const t = setTimeout(() => {
      void api<{ errors: string[]; warnings: Warning[]; quantities: number[] }>(`/api/health/consultations/${c.id}`, { json: { action: "check", items: itemsPayload } })
        .then((r) => {
          setErrors(r.errors);
          setWarnings(r.warnings);
        })
        .catch(() => undefined);
    }, 500);
    return () => clearTimeout(t);
  }, [itemsPayload, c.id, readOnly]);

  const vit = (k: string) => (c.vitals[k] ?? "") as number | "";
  const setVit = (k: string, v: string) => setC({ ...c, vitals: { ...c.vitals, [k]: v === "" ? null : Number(v) } });
  const bmi = bmiOf(c.vitals.weightKg ?? null, c.vitals.heightCm ?? null);
  const addDrug = (d: Drug) => setItems([...items, { ...EMPTY_ITEM, drugId: d.id, genericName: d.genericName, brandName: d.brandName, strength: d.strength, form: d.form, dose: d.form === "TABLET" ? "1 tablet" : d.form === "CAPSULE" ? "1 capsule" : d.form === "SYRUP" || d.form === "SUSPENSION" ? "5 ml" : "Apply", teleList: d.teleList }]);
  const setItem = (i: number, patch: Partial<Item>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const issueBody = () => ({ items: itemsPayload, suggestions: sugg.map(suggPayload), acknowledgeWarnings: ack });

  const preview = async () => {
    setError(null);
    try {
      const res = await fetch(`/api/health/consultations/${c.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "preview", ...issueBody() }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? "Preview failed.");
      const url = URL.createObjectURL(await res.blob());
      window.open(url, "_blank", "noopener");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/health/consultations/${c.id}`, { json: cleanDraft(draftBody) });
      const r = await api<{ prescription: { id: string; rxNumber: string }; bookingCompleted: boolean }>(`/api/health/consultations/${c.id}`, { json: { action: "issue", ...issueBody() } });
      setIssued({ id: r.prescription.id, rxNumber: r.prescription.rxNumber, bookingCompleted: r.bookingCompleted });
      setC({ ...c, status: "COMPLETED" });
      // Print step: the print view opens at once (auto-print mode prints without asking on a kiosk-printing PC).
      window.open(`/health/prescriptions/${r.prescription.id}/print${letterheadAutoPrint ? "" : "?auto=1"}`, "_blank", "noopener");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const repeat = async () => {
    try {
      const r = await api<{ items: Item[] }>(`/api/health/consultations/${c.id}`, { json: { action: "repeat" } });
      if (!r.items.length) setError("No earlier prescription from you for this patient.");
      setItems([...items, ...r.items.map((i) => ({ ...EMPTY_ITEM, ...i, instructions: i.instructions ?? "", instructionsLocal: i.instructionsLocal ?? "" }))]);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const applyTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setItems([...items, ...(t.content.items ?? []).map((i) => ({ ...EMPTY_ITEM, ...i, instructions: i.instructions ?? "", instructionsLocal: i.instructionsLocal ?? "" }))]);
    setC({ ...c, advice: [c.advice, t.content.advice].filter(Boolean).join("\n") || null, investigations: [...c.investigations, ...(t.content.investigations ?? [])], diagnoses: [...c.diagnoses, ...(t.content.diagnoses ?? [])] });
  };
  const saveTemplate = async () => {
    const name = prompt("Template name");
    if (!name) return;
    try {
      await api(`/api/health/doctor/${c.memberId}`, { json: { action: "template", kind: "TEMPLATE", name, content: { items: itemsPayload, advice: c.advice, investigations: c.investigations, diagnoses: c.diagnoses } } });
      const r = await api<{ templates: typeof templates }>(`/api/health/doctor/${c.memberId}`);
      setTemplates(r.templates);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const askAccess = async () => {
    try {
      await api(`/api/health/clinic/${c.shopId}`, { json: { action: "request-access", patientId: c.patientId, memberId: c.memberId, bookingId: c.bookingId } });
      setRequested(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const p = summary.patient;

  if (issued) {
    return (
      <Panel title={`Prescription ${issued.rxNumber} issued`}>
        <p className="text-sm text-ink-800" data-testid="pad-issued">
          Saved to {p.fullName}&apos;s record, e-mailed with the PDF, and sent by app / SMS / WhatsApp. {issued.bookingCompleted ? "The appointment is marked completed." : "Complete the appointment from the booking when the patient pays / gives the code."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a className={PRIMARY} href={`/health/prescriptions/${issued.id}/print`} target="_blank" rel="noreferrer">
            Print again
          </a>
          <a className={SECONDARY} href={`/api/health/prescriptions/${issued.id}/pdf`} target="_blank" rel="noreferrer">
            PDF
          </a>
          <Link className={SECONDARY} href={`/health/prescriptions/${issued.id}`}>
            Open / amend
          </Link>
          <button type="button" className={SECONDARY} onClick={() => router.push("/shop/health")}>
            Back to Today
          </button>
        </div>
      </Panel>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex flex-col gap-4">
        {readOnly ? <p className="rounded-xl border-2 border-amber-300 bg-amber-50 px-3 py-2 text-sm font-bold">This consultation is closed. Open the prescription to amend it.</p> : null}
        <Panel title="Vitals" action={<span className="text-xs text-ink-600">{saved}</span>}>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {[
              ["bpSystolic", "BP sys"],
              ["bpDiastolic", "BP dia"],
              ["pulse", "Pulse"],
              ["temperatureC", "Temp °C"],
              ["spo2", "SpO₂ %"],
              ["weightKg", "Weight kg"],
              ["heightCm", "Height cm"],
              ["respiratoryRate", "Resp /min"],
              ["bloodSugar", "Sugar mg/dL"],
            ].map(([k, label]) => (
              <label key={k} className="text-xs font-bold text-ink-700">
                {label}
                <input className={smallInput} inputMode="decimal" value={vit(k)} onChange={(e) => setVit(k, e.target.value)} disabled={readOnly} data-testid={`pad-vital-${k}`} />
              </label>
            ))}
            <div className="text-xs font-bold text-ink-700">
              BMI
              <p className="min-h-10 py-2 text-base font-extrabold text-ink-900">{bmi ?? "—"}</p>
            </div>
          </div>
        </Panel>
        <Panel title="Consultation">
          <div className="grid gap-2">
            <label className="text-xs font-bold text-ink-700">
              Chief complaints
              <textarea className={inputCls} rows={2} value={c.chiefComplaints ?? ""} onChange={(e) => setC({ ...c, chiefComplaints: e.target.value })} disabled={readOnly} data-testid="pad-complaints" />
            </label>
            <label className="text-xs font-bold text-ink-700">
              History
              <textarea className={inputCls} rows={2} value={c.history ?? ""} onChange={(e) => setC({ ...c, history: e.target.value })} disabled={readOnly} />
            </label>
            <label className="text-xs font-bold text-ink-700">
              Examination findings
              <textarea className={inputCls} rows={2} value={c.examination ?? ""} onChange={(e) => setC({ ...c, examination: e.target.value })} disabled={readOnly} />
            </label>
            <div>
              <p className="text-xs font-bold text-ink-700">Diagnosis</p>
              <ul className="mb-2 flex flex-wrap gap-2">
                {c.diagnoses.map((d, i) => (
                  <li key={i} className="flex items-center gap-1 rounded-full bg-kesari-100 px-3 py-1 text-sm font-bold text-kesari-900">
                    {d.text}
                    {d.code ? <span className="font-mono text-xs">({d.code})</span> : null}
                    {!readOnly ? (
                      <button type="button" aria-label={`Remove ${d.text}`} onClick={() => setC({ ...c, diagnoses: c.diagnoses.filter((_, j) => j !== i) })}>
                        ✕
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {!readOnly ? <IcdSearch onPick={(x) => setC({ ...c, diagnoses: [...c.diagnoses, { code: x.code || null, text: x.title }] })} /> : null}
            </div>
            <label className="text-xs font-bold text-ink-700">
              Tests advised (comma separated)
              <input
                className={inputCls}
                value={c.investigations.map((i) => i.name).join(", ")}
                onChange={(e) => setC({ ...c, investigations: e.target.value.split(",").map((s) => s.trim()).filter((s) => s.length >= 2).map((name) => ({ name })) })}
                disabled={readOnly}
                data-testid="pad-tests"
              />
            </label>
          </div>
        </Panel>
        <Panel
          title="Medicines"
          action={
            !readOnly ? (
              <span className="flex flex-wrap gap-1">
                <button type="button" className={SECONDARY} onClick={repeat} data-testid="pad-repeat">
                  Repeat last
                </button>
                {templates.length ? (
                  <select className={smallInput} defaultValue="" onChange={(e) => (applyTemplate(e.target.value), (e.target.value = ""))} aria-label="Use a template">
                    <option value="">Template…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.kind === "FAVOURITE" ? "★ " : ""}
                        {t.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button type="button" className={SECONDARY} onClick={saveTemplate}>
                  Save as template
                </button>
              </span>
            ) : null
          }
        >
          {remote ? <p className="mb-2 text-xs font-bold text-amber-900">{c.mode === "VIDEO" ? "Video" : "Phone"} consultation: prohibited medicines are blocked; List B only as a follow-up of an in-person visit (Telemedicine Practice Guidelines 2020).</p> : null}
          <ol className="flex flex-col gap-2" data-testid="pad-items">
            {items.map((it, i) => (
              <li key={i} className={clsx("rounded-xl border-2 p-2", warnings.some((w) => w.line === i + 1 && w.kind === "ALLERGY") ? "border-red-400 bg-red-50" : "border-[var(--gk-line)]")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-extrabold text-ink-900">
                    {i + 1}. {it.brandName ? `${it.brandName} (${it.genericName})` : it.genericName || "New medicine"} {it.strength}
                    {it.teleList ? <span className="ml-2 text-xs font-bold text-ink-600">{TELE_LIST_LABELS[it.teleList as TeleList]?.split(" — ")[0]}</span> : null}
                  </p>
                  {!readOnly ? (
                    <button type="button" className="text-sm font-bold text-red-800" onClick={() => setItems(items.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  ) : null}
                </div>
                {!it.drugId ? (
                  <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <input className={smallInput} placeholder="Generic name" value={it.genericName} onChange={(e) => setItem(i, { genericName: e.target.value })} />
                    <input className={smallInput} placeholder="Strength" value={it.strength ?? ""} onChange={(e) => setItem(i, { strength: e.target.value || null })} />
                    <select className={smallInput} value={it.form} onChange={(e) => setItem(i, { form: e.target.value })}>
                      {DRUG_FORMS.map((f) => (
                        <option key={f}>{f}</option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <input className={smallInput} aria-label="Dose" value={it.dose} onChange={(e) => setItem(i, { dose: e.target.value })} disabled={readOnly} />
                  <select className={smallInput} aria-label="Frequency" value={it.frequency} onChange={(e) => setItem(i, { frequency: e.target.value })} disabled={readOnly}>
                    {RX_FREQUENCIES.map((f) => (
                      <option key={f} value={f}>
                        {f} {RX_FREQUENCY_LABELS[f] ? `· ${RX_FREQUENCY_LABELS[f].en}` : ""}
                      </option>
                    ))}
                  </select>
                  <select className={smallInput} aria-label="When" value={it.timing} onChange={(e) => setItem(i, { timing: e.target.value })} disabled={readOnly}>
                    {RX_TIMINGS.map((t) => (
                      <option key={t} value={t}>
                        {RX_TIMING_LABELS[t].en}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-xs font-bold text-ink-700">
                    Days
                    <input className={smallInput} inputMode="numeric" value={it.durationDays} onChange={(e) => setItem(i, { durationDays: Number(e.target.value.replace(/\D/g, "") || 0) })} disabled={readOnly} />
                  </label>
                  <label className="flex items-center gap-1 text-xs font-bold text-ink-700">
                    Qty
                    <input
                      className={smallInput}
                      inputMode="numeric"
                      placeholder={String(autoQuantity({ form: it.form, dose: it.dose, frequency: it.frequency, durationDays: it.durationDays }))}
                      value={it.quantity ?? ""}
                      onChange={(e) => setItem(i, { quantity: e.target.value ? Number(e.target.value.replace(/\D/g, "")) : null })}
                      disabled={readOnly}
                    />
                  </label>
                </div>
                <div className="mt-1 grid gap-2 sm:grid-cols-2">
                  <input className={smallInput} placeholder="Instructions (English)" value={it.instructions} onChange={(e) => setItem(i, { instructions: e.target.value })} disabled={readOnly} />
                  {localLanguage !== "NONE" ? (
                    <input className={smallInput} placeholder={localLanguage === "HI" ? "निर्देश (हिंदी)" : "सूचना (मराठी)"} value={it.instructionsLocal} onChange={(e) => setItem(i, { instructionsLocal: e.target.value })} disabled={readOnly} />
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          {!readOnly ? (
            <div className="mt-2 flex flex-col gap-2">
              <DrugSearch onPick={addDrug} />
              <button type="button" className={SECONDARY} onClick={() => setItems([...items, { ...EMPTY_ITEM }])}>
                + Medicine not in the list
              </button>
            </div>
          ) : null}
        </Panel>
        <Panel title="Advice and follow-up">
          <textarea className={inputCls} rows={3} value={c.advice ?? ""} onChange={(e) => setC({ ...c, advice: e.target.value })} disabled={readOnly} data-testid="pad-advice" />
          <label className="mt-2 block text-xs font-bold text-ink-700">
            Follow-up date
            <input type="date" className={inputCls} value={c.followUpDate ?? ""} onChange={(e) => setC({ ...c, followUpDate: e.target.value || null })} disabled={readOnly} />
          </label>
        </Panel>
        <SuggestionsBuilder value={sugg} onChange={setSugg} readOnly={readOnly} careCategories={careCategories} followUpDate={c.followUpDate} />
        {!readOnly ? (
          <div className="sticky bottom-0 z-10 flex flex-col gap-2 rounded-2xl border-2 border-kesari-300 bg-white p-3 shadow-lg">
            {errors.map((e) => (
              <p key={e} className="text-sm font-bold text-red-800">
                ⛔ {e}
              </p>
            ))}
            {warnings.map((w) => (
              <p key={w.message} className="text-sm font-bold text-amber-900">
                ⚠ {w.message}
              </p>
            ))}
            {warnings.length ? (
              <label className="flex min-h-11 items-center gap-2 text-sm font-bold">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="pad-ack" /> I have reviewed these warnings
              </label>
            ) : null}
            <Err error={error} />
            <div className="flex flex-wrap gap-2">
              <button type="button" className={SECONDARY} onClick={preview} data-testid="pad-preview">
                Preview on letterhead
              </button>
              <button type="button" className={PRIMARY} onClick={issue} disabled={busy || errors.length > 0 || (warnings.length > 0 && !ack)} data-testid="pad-issue">
                {busy ? "Issuing…" : "Issue prescription"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <aside className="flex flex-col gap-3">
        <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3" data-testid="pad-summary">
          <p className="text-base font-extrabold text-ink-900">{p.fullName}</p>
          <p className="text-sm text-ink-700">
            {[summary.age, p.gender, p.bloodGroup].filter(Boolean).join(" · ")} · {c.visitType === "NEW" ? "New patient" : "Follow-up"}
          </p>
          {p.allergies.length ? (
            <p className="mt-2 rounded-lg bg-red-600 px-2 py-1 text-sm font-extrabold text-white" data-testid="pad-allergies">
              Allergies: {p.allergies.join(", ")}
            </p>
          ) : (
            <p className="mt-2 text-xs text-ink-600">No allergies recorded.</p>
          )}
          {p.conditions.length ? <p className="mt-1 text-sm text-ink-800">Conditions: {p.conditions.join(", ")}</p> : null}
          {p.currentMedicines ? <p className="mt-1 text-sm text-ink-800">Self-reported medicines: {p.currentMedicines}</p> : null}
          {summary.currentMedicines.length ? (
            <div className="mt-2">
              <p className="text-xs font-extrabold uppercase text-ink-600">Current GoKesari medicines</p>
              <ul className="text-sm">
                {summary.currentMedicines.map((m, i) => (
                  <li key={i}>
                    {m.name} — {m.dose} (to {m.until}, {m.doctor})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
        <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3">
          <p className="text-xs font-extrabold uppercase text-ink-600">Your past visits</p>
          {summary.ownVisits.length ? (
            <ul className="text-sm">
              {summary.ownVisits.map((v) => (
                <li key={v.id} className="py-1">
                  {ist(v.date, false)} — {v.diagnoses || "—"}{" "}
                  {v.prescriptionId ? (
                    <Link className="font-bold text-kesari-800 underline" href={`/health/prescriptions/${v.prescriptionId}`} target="_blank">
                      {v.rxNumber}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-600">First visit with you.</p>
          )}
        </section>
        <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3">
          <p className="text-xs font-extrabold uppercase text-ink-600">Earlier GoKesari records (other providers)</p>
          {summary.consent.allowed ? (
            <>
              <p className="text-xs text-ink-600">Shared by the patient ({summary.consent.mode === "ALWAYS" ? "always" : "this visit"}). Every look is shown to them.</p>
              <ul className="mt-1 max-h-72 overflow-auto text-sm">
                {(summary.others ?? []).map((o) => (
                  <li key={o.id} className="py-1">
                    {ist(o.at, false)} — <span className="font-bold">{o.title}</span>
                    {o.summary ? <span className="block text-xs text-ink-700">{o.summary}</span> : null}
                  </li>
                ))}
              </ul>
              {(summary.documents ?? []).length ? <p className="mt-1 text-xs text-ink-700">{summary.documents!.length} reports in the patient&apos;s record.</p> : null}
            </>
          ) : (
            <>
              <p className="text-sm text-ink-700">Not shared with you.{summary.consent.mode === "ASK" ? " The patient asked to be asked each time." : ""}</p>
              <button type="button" className={clsx(SECONDARY, "mt-2")} onClick={askAccess} disabled={requested} data-testid="pad-ask-access">
                {requested ? "Asked — waiting for the patient" : "Ask the patient"}
              </button>
            </>
          )}
        </section>
      </aside>
    </div>
  );
}

function cleanDraft(d: Record<string, unknown>) {
  const v = (d.vitals ?? {}) as Record<string, unknown>;
  const vitals = Object.fromEntries(Object.entries(v).filter(([k, x]) => k !== "bmi" && x !== null && x !== "" && x !== undefined && Number.isFinite(Number(x))));
  return { ...d, vitals, chiefComplaints: d.chiefComplaints || null, history: d.history || null, examination: d.examination || null, advice: d.advice || null, followUpDate: d.followUpDate || null };
}

function itemPayload(i: Item) {
  return {
    drugId: i.drugId,
    genericName: i.genericName.trim(),
    brandName: i.brandName,
    strength: i.strength,
    form: i.form,
    dose: i.dose,
    frequency: i.frequency,
    timing: i.timing,
    durationDays: i.durationDays,
    quantity: i.quantity,
    instructions: i.instructions || null,
    instructionsLocal: i.instructionsLocal || null,
  };
}

function suggPayload(s: Sugg) {
  return {
    type: s.type,
    urgency: s.urgency,
    printOnRx: s.printOnRx,
    specialty: s.specialty || null,
    targetMemberId: s.targetMemberId || null,
    note: s.note || null,
    careCategory: s.careCategory || null,
    serviceType: s.serviceType || null,
    frequency: s.frequency || null,
    durationDays: s.durationDays || null,
    startDate: s.startDate || null,
    equipment: s.equipment || null,
    buyOrRent: s.buyOrRent || null,
    tests: s.tests ? s.tests.split(",").map((t) => t.trim()).filter((t) => t.length >= 2) : null,
    homeCollection: s.homeCollection ?? null,
    followUpDate: s.followUpDate || null,
  };
}

function SuggestionsBuilder({ value, onChange, readOnly, careCategories, followUpDate }: { value: Sugg[]; onChange: (v: Sugg[]) => void; readOnly: boolean; careCategories: { slug: string; name: string }[]; followUpDate: string | null }) {
  const set = (i: number, patch: Partial<Sugg>) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <Panel title="Refer and suggest (optional)">
      <p className="mb-2 text-xs text-ink-600">{NMC_ETHICS_NOTE}</p>
      <ol className="flex flex-col gap-2">
        {value.map((s, i) => (
          <li key={i} className="rounded-xl border-2 border-teal-200 bg-teal-50 p-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-extrabold text-teal-900">{SUGGESTION_TYPE_LABELS[s.type]}</p>
              {!readOnly ? (
                <button type="button" className="text-sm font-bold text-red-800" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                  Remove
                </button>
              ) : null}
            </div>
            <div className="mt-1 grid gap-2 sm:grid-cols-2">
              {s.type === "DOCTOR_REFERRAL" ? (
                <>
                  <input className={smallInput} placeholder="Specialty (e.g. Cardiologist)" value={s.specialty ?? ""} onChange={(e) => set(i, { specialty: e.target.value })} />
                  <select className={smallInput} value={s.urgency} onChange={(e) => set(i, { urgency: e.target.value as Sugg["urgency"] })}>
                    <option value="ROUTINE">Routine</option>
                    <option value="SOON">Soon</option>
                    <option value="URGENT">Urgent</option>
                  </select>
                  <textarea className={clsx(smallInput, "sm:col-span-2")} placeholder="Referral note for the specialist" value={s.note ?? ""} onChange={(e) => set(i, { note: e.target.value })} />
                </>
              ) : null}
              {s.type === "CARE_STAFF" ? (
                <>
                  <select className={smallInput} value={s.careCategory ?? ""} onChange={(e) => set(i, { careCategory: e.target.value })}>
                    <option value="">Who?</option>
                    {careCategories.map((c) => (
                      <option key={c.slug} value={c.slug}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <input className={smallInput} placeholder="Service (e.g. dressing, IV, post-op care)" value={s.serviceType ?? ""} onChange={(e) => set(i, { serviceType: e.target.value })} />
                  <input className={smallInput} placeholder="Frequency (e.g. daily, twice a week)" value={s.frequency ?? ""} onChange={(e) => set(i, { frequency: e.target.value })} />
                  <input className={smallInput} inputMode="numeric" placeholder="For how many days" value={s.durationDays ?? ""} onChange={(e) => set(i, { durationDays: e.target.value ? Number(e.target.value) : null })} />
                  <input className={smallInput} type="date" value={s.startDate ?? ""} onChange={(e) => set(i, { startDate: e.target.value })} aria-label="Start date" />
                  <input className={smallInput} placeholder="Notes" value={s.note ?? ""} onChange={(e) => set(i, { note: e.target.value })} />
                </>
              ) : null}
              {s.type === "EQUIPMENT" ? (
                <>
                  <input className={smallInput} placeholder="Equipment (e.g. Oxygen concentrator)" value={s.equipment ?? ""} onChange={(e) => set(i, { equipment: e.target.value })} />
                  <select className={smallInput} value={s.buyOrRent ?? "RENT"} onChange={(e) => set(i, { buyOrRent: e.target.value as "BUY" | "RENT" })}>
                    <option value="RENT">Rent</option>
                    <option value="BUY">Buy</option>
                  </select>
                  <input className={smallInput} inputMode="numeric" placeholder="Days" value={s.durationDays ?? ""} onChange={(e) => set(i, { durationDays: e.target.value ? Number(e.target.value) : null })} />
                </>
              ) : null}
              {s.type === "LAB_TEST" ? (
                <>
                  <input className={clsx(smallInput, "sm:col-span-2")} placeholder="Tests, comma separated (e.g. CBC, HbA1c)" value={s.tests ?? ""} onChange={(e) => set(i, { tests: e.target.value })} />
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={Boolean(s.homeCollection)} onChange={(e) => set(i, { homeCollection: e.target.checked })} /> Home sample collection is fine
                  </label>
                </>
              ) : null}
              {s.type === "FOLLOW_UP" ? <input className={smallInput} type="date" value={s.followUpDate ?? followUpDate ?? ""} onChange={(e) => set(i, { followUpDate: e.target.value })} aria-label="Follow-up date" /> : null}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={s.printOnRx} onChange={(e) => set(i, { printOnRx: e.target.checked })} /> Print on the prescription
              </label>
            </div>
          </li>
        ))}
      </ol>
      {!readOnly ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {SUGGESTION_TYPES.map((t) => (
            <button key={t} type="button" className={SECONDARY} onClick={() => onChange([...value, { type: t, urgency: "ROUTINE", printOnRx: true, followUpDate: t === "FOLLOW_UP" ? (followUpDate ?? undefined) : undefined }])} data-testid={`pad-suggest-${t}`}>
              + {SUGGESTION_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

/* ------------------------------------------------------------ settings */

interface LetterheadView {
  mode: string;
  paper: string;
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  headerHeightMm: number;
  footerHeightMm: number;
  fontSizePt: number;
  sections: Record<string, boolean>;
  localLanguage: string;
  showSignature: boolean;
  autoPrint: boolean;
  printerName: string | null;
  hasHeader: boolean;
  hasFooter: boolean;
  hasBackground: boolean;
}

export function DoctorProfileForm({ seat }: { seat: Seat }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const p = seat.profile;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    setMsg(null);
    try {
      await api(`/api/health/doctor/${seat.memberId}`, {
        json: {
          action: "profile",
          practitionerType: f.get("practitionerType"),
          fullName: f.get("fullName"),
          qualifications: f.get("qualifications"),
          specialties: String(f.get("specialties") ?? "").split(",").map((s) => s.trim()).filter((s) => s.length >= 2),
          council: f.get("council"),
          registrationNumber: f.get("registrationNumber"),
          registrationYear: f.get("registrationYear") ? Number(f.get("registrationYear")) : null,
          hprId: f.get("hprId") || null,
        },
      });
      setMsg("Saved. GoKesari verifies the registration before bookings and prescriptions open.");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const upload = async (which: "signature" | "stamp", file: File | undefined) => {
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    fd.set("which", which);
    const res = await fetch(`/api/health/doctor/${seat.memberId}/image`, { method: "POST", body: fd });
    if (!res.ok) setError((await res.json().catch(() => null))?.error?.message ?? "Upload failed.");
    else {
      setMsg(`${which === "signature" ? "Signature" : "Stamp"} saved.`);
      router.refresh();
    }
  };
  return (
    <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2" data-testid="doctor-profile-form">
      <p className="text-sm sm:col-span-2">
        Status:{" "}
        {seat.verified ? <span className="font-extrabold text-leaf-800">Verified</span> : <span className="font-extrabold text-amber-800">Not verified — {seat.reasons.join(" ")}</span>}
      </p>
      <label className="text-xs font-bold text-ink-700">
        Full name as registered
        <input name="fullName" required defaultValue={p?.fullName ?? seat.name.replace(/^dr\.?\s+/i, "")} className={inputCls} />
      </label>
      <label className="text-xs font-bold text-ink-700">
        Type
        <select name="practitionerType" defaultValue={p?.practitionerType ?? "DOCTOR"} className={inputCls}>
          {PRACTITIONER_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <label className="text-xs font-bold text-ink-700">
        Qualifications
        <input name="qualifications" required defaultValue={p?.qualifications ?? ""} placeholder="MBBS, MD" className={inputCls} />
      </label>
      <label className="text-xs font-bold text-ink-700">
        Specialties (comma separated)
        <input name="specialties" defaultValue={p?.specialties.join(", ") ?? ""} className={inputCls} />
      </label>
      <label className="text-xs font-bold text-ink-700 sm:col-span-2">
        Council
        <select name="council" required defaultValue={p?.council ?? ""} className={inputCls}>
          <option value="" disabled>
            Choose the council
          </option>
          {MEDICAL_COUNCILS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="text-xs font-bold text-ink-700">
        Registration number
        <input name="registrationNumber" required defaultValue={p?.registrationNumber ?? ""} className={inputCls} />
      </label>
      <label className="text-xs font-bold text-ink-700">
        Year of registration
        <input name="registrationYear" inputMode="numeric" defaultValue={p?.registrationYear ?? ""} className={inputCls} />
      </label>
      <label className="text-xs font-bold text-ink-700">
        HPR id (ABDM, optional)
        <input name="hprId" defaultValue={p?.hprId ?? ""} className={inputCls} />
      </label>
      <div className="flex flex-wrap gap-3 sm:col-span-2">
        <label className="text-xs font-bold text-ink-700">
          Signature image {p?.hasSignature ? "✔" : ""}
          <input type="file" accept="image/png,image/jpeg" onChange={(e) => upload("signature", e.target.files?.[0])} className="block text-sm" disabled={!p} />
        </label>
        <label className="text-xs font-bold text-ink-700">
          Stamp image {p?.hasStamp ? "✔" : ""}
          <input type="file" accept="image/png,image/jpeg" onChange={(e) => upload("stamp", e.target.files?.[0])} className="block text-sm" disabled={!p} />
        </label>
      </div>
      <div className="sm:col-span-2">
        <Err error={error} />
        {msg ? <p className="text-sm font-bold text-leaf-800">{msg}</p> : null}
        <button className={PRIMARY} data-testid="doctor-profile-save">
          Save doctor details
        </button>
        <p className="mt-1 text-xs text-ink-600">Upload the council certificate in Appointments → Setup → Team (it is verified by GoKesari).</p>
      </div>
    </form>
  );
}

export function LetterheadSettings({ shopId, memberId, initial }: { shopId: string; memberId: string | null; initial: LetterheadView }) {
  const [lh, setLh] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const q = memberId ? `?member=${memberId}` : "";
  const save = async () => {
    setError(null);
    setMsg(null);
    try {
      const r = await api<{ letterhead: LetterheadView }>(`/api/health/letterhead/${shopId}`, {
        json: {
          memberId,
          mode: lh.mode,
          paper: lh.paper,
          marginTopMm: Number(lh.marginTopMm),
          marginBottomMm: Number(lh.marginBottomMm),
          marginLeftMm: Number(lh.marginLeftMm),
          marginRightMm: Number(lh.marginRightMm),
          headerHeightMm: Number(lh.headerHeightMm),
          footerHeightMm: Number(lh.footerHeightMm),
          fontSizePt: Number(lh.fontSizePt),
          sections: lh.sections,
          localLanguage: lh.localLanguage,
          showSignature: lh.showSignature,
          autoPrint: lh.autoPrint,
          printerName: lh.printerName,
        },
      });
      setLh(r.letterhead);
      setMsg("Saved.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const upload = async (which: "header" | "footer" | "background", file: File | undefined, remove = false) => {
    const fd = new FormData();
    if (file) fd.set("file", file);
    fd.set("which", which);
    if (memberId) fd.set("member", memberId);
    const res = await fetch(`/api/health/letterhead/${shopId}/image`, { method: "POST", body: fd });
    if (!res.ok) setError((await res.json().catch(() => null))?.error?.message ?? "Upload failed.");
    else {
      setLh({ ...lh, ...(which === "header" ? { hasHeader: !remove } : which === "footer" ? { hasFooter: !remove } : { hasBackground: !remove }) });
      setMsg("Image saved.");
    }
  };
  const num = (k: keyof LetterheadView) => (
    <label className="text-xs font-bold text-ink-700">
      {String(k).replace(/Mm$/, " (mm)").replace(/([A-Z])/g, " $1").toLowerCase()}
      <input className={smallInput} inputMode="decimal" value={String(lh[k] ?? "")} onChange={(e) => setLh({ ...lh, [k]: e.target.value })} data-testid={`lh-${String(k)}`} />
    </label>
  );
  return (
    <div className="flex flex-col gap-3" data-testid="letterhead-settings">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-extrabold text-ink-900">How do you print?</legend>
        {LETTERHEAD_MODES.map((m) => (
          <label key={m} className="flex min-h-11 items-center gap-2 text-sm">
            <input type="radio" checked={lh.mode === m} onChange={() => setLh({ ...lh, mode: m })} data-testid={`lh-mode-${m}`} /> {LETTERHEAD_MODE_LABELS[m]}
          </label>
        ))}
      </fieldset>
      {lh.mode === "DIGITAL" ? (
        <div className="grid gap-2 sm:grid-cols-3">
          {(["header", "footer", "background"] as const).map((w) => (
            <label key={w} className="text-xs font-bold text-ink-700">
              {w === "background" ? "Full-page background" : `${w[0].toUpperCase()}${w.slice(1)} image`} {(w === "header" ? lh.hasHeader : w === "footer" ? lh.hasFooter : lh.hasBackground) ? "✔" : ""}
              <input type="file" accept="image/png,image/jpeg" className="block text-sm" onChange={(e) => upload(w, e.target.files?.[0])} />
              {(w === "header" ? lh.hasHeader : w === "footer" ? lh.hasFooter : lh.hasBackground) ? (
                <button type="button" className="text-xs font-bold text-red-800 underline" onClick={() => upload(w, undefined, true)}>
                  Remove
                </button>
              ) : null}
            </label>
          ))}
        </div>
      ) : null}
      {lh.mode === "PREPRINTED" ? (
        <p className="rounded-xl border-2 border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
          Print the calibration sheet on one of your letterhead pages at 100% (no &quot;fit to page&quot;), read on the millimetre grid where your printed header ends and footer starts, and enter them as the top and bottom margins. The e-mailed PDF still has a full header (your digital images if uploaded, otherwise the GoKesari standard header).
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="text-xs font-bold text-ink-700">
          Paper
          <select className={smallInput} value={lh.paper} onChange={(e) => setLh({ ...lh, paper: e.target.value })}>
            {PAPER_SIZES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        {num("marginTopMm")}
        {num("marginBottomMm")}
        {num("marginLeftMm")}
        {num("marginRightMm")}
        {lh.mode === "DIGITAL" ? num("headerHeightMm") : null}
        {lh.mode === "DIGITAL" ? num("footerHeightMm") : null}
        {num("fontSizePt")}
        <label className="text-xs font-bold text-ink-700">
          Local language lines
          <select className={smallInput} value={lh.localLanguage} onChange={(e) => setLh({ ...lh, localLanguage: e.target.value })}>
            {LOCAL_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {LOCAL_LANGUAGE_LABELS[l]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="grid grid-cols-2 gap-1 sm:grid-cols-3">
        <legend className="text-sm font-extrabold text-ink-900">Sections to print</legend>
        {RX_SECTIONS.map((s) => (
          <label key={s} className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" checked={lh.sections[s] ?? !["history", "examination"].includes(s)} onChange={(e) => setLh({ ...lh, sections: { ...lh.sections, [s]: e.target.checked } })} /> {RX_SECTION_LABELS[s]}
          </label>
        ))}
      </fieldset>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={lh.showSignature} onChange={(e) => setLh({ ...lh, showSignature: e.target.checked })} /> Print my signature
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={lh.autoPrint} onChange={(e) => setLh({ ...lh, autoPrint: e.target.checked })} data-testid="lh-autoprint" /> Print automatically when I issue (best with Chrome kiosk printing on the reception PC — see the Doctor guide)
      </label>
      <Err error={error} />
      {msg ? <p className="text-sm font-bold text-leaf-800">{msg}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={PRIMARY} onClick={save} data-testid="lh-save">
          Save print settings
        </button>
        <a className={SECONDARY} href={`/api/health/letterhead/${shopId}${q}${q ? "&" : "?"}calibration=1`} target="_blank" rel="noreferrer" data-testid="lh-calibration">
          Calibration test print (mm grid)
        </a>
      </div>
    </div>
  );
}

export function ClinicSettingsForm({ shopId, initial }: { shopId: string; initial: { tokenMode: boolean; tokenDailyLimit: number; followUpDays: number; followUpFeePaise: number | null; hfrId: string | null } }) {
  const [s, setS] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      await api(`/api/health/clinic/${shopId}`, { json: { action: "settings", tokenMode: s.tokenMode, tokenDailyLimit: Number(s.tokenDailyLimit), followUpDays: Number(s.followUpDays), followUpFeeRupees: s.followUpFeePaise == null ? null : s.followUpFeePaise / 100, hfrId: s.hfrId } });
      setMsg("Saved.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="clinic-settings">
      <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={s.tokenMode} onChange={(e) => setS({ ...s, tokenMode: e.target.checked })} /> Token clinic (patients get token numbers; set minimum notice to 0 in Appointments → Setup for same-hour walk-ins)
      </label>
      <label className="text-xs font-bold text-ink-700">
        Tokens per day
        <input className={smallInput} inputMode="numeric" value={s.tokenDailyLimit} onChange={(e) => setS({ ...s, tokenDailyLimit: Number(e.target.value || 0) })} />
      </label>
      <label className="text-xs font-bold text-ink-700">
        Follow-up within (days)
        <input className={smallInput} inputMode="numeric" value={s.followUpDays} onChange={(e) => setS({ ...s, followUpDays: Number(e.target.value || 0) })} />
      </label>
      <label className="text-xs font-bold text-ink-700">
        Follow-up fee (₹, blank = normal fee)
        <input className={smallInput} inputMode="decimal" value={s.followUpFeePaise == null ? "" : s.followUpFeePaise / 100} onChange={(e) => setS({ ...s, followUpFeePaise: e.target.value === "" ? null : Math.round(Number(e.target.value) * 100) })} />
      </label>
      <label className="text-xs font-bold text-ink-700">
        HFR id (ABDM, optional)
        <input className={smallInput} value={s.hfrId ?? ""} onChange={(e) => setS({ ...s, hfrId: e.target.value || null })} />
      </label>
      <div className="sm:col-span-2">
        <Err error={error} />
        {msg ? <p className="text-sm font-bold text-leaf-800">{msg}</p> : null}
        <button type="button" className={PRIMARY} onClick={save}>
          Save clinic settings
        </button>
      </div>
    </div>
  );
}
