"use client";

/**
 * The consultant's calendar and dashboard (docs/consult-booking-2026-11):
 * today's agenda, earnings, upcoming, pending approvals and utilisation;
 * day view with the team side by side (firm owner), week and month views;
 * colour-coded statuses; a click opens the booking with all its actions.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CONSULT_STATUS_LABELS, CONSULT_STATUS_TONES, displayStatus, type ConsultBookingStatus } from "@/lib/consult/constants";
import { addDays, clock12, dateKeysBetween, formatDateKey, istDateKey, istMinuteOfDay, istWeekday, monthEnd, monthStart, weekStart } from "@/lib/consult/time";
import { Alert, Button } from "@/components/ui";
import { ConsultBookingView } from "./booking-view";
import { api, MODE_ICON, rupees, Tile } from "./common";

interface Card {
  id: string;
  bookingNumber: string;
  status: ConsultBookingStatus;
  rescheduleCount: number;
  startsAt: string;
  endsAt: string;
  mode: string;
  serviceName: string;
  visitorName: string;
  attendees: number;
  members: { id: string; name: string; color: string }[];
  paymentStatus: string;
  arrived: boolean;
}

interface Calendar {
  access: { role: string; memberId: string | null; canSetup: boolean };
  firm: { id: string; name: string; status: string; verification: string };
  members: { id: string; name: string; color: string; hours: { weekday: number; startMinute: number; endMinute: number }[] }[];
  bookings: Card[];
  timeOff: { id: string; memberId: string | null; kind: string; startsAt: string; endsAt: string; reason: string | null }[];
}

interface Dashboard {
  today: Card[];
  upcomingCount: number;
  pendingApproval: number;
  todayEarningsPaise: number;
  weekEarningsPaise: number;
  utilisationPct: number;
  completedThisMonth: number;
  noShowsThisMonth: number;
  ratingAvg: number;
  ratingCount: number;
}

type View = "day" | "week" | "month";
const HOUR_PX = 56;

export function ConsultCalendar({ shopId, initialBooking }: { shopId: string; initialBooking?: string | null }) {
  const today = istDateKey(new Date());
  const [view, setView] = useState<View>("day");
  const [anchor, setAnchor] = useState(today);
  const [member, setMember] = useState<string>("");
  const [cal, setCal] = useState<Calendar | null>(null);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(initialBooking ?? null);

  const range = useMemo(() => {
    if (view === "day") return { from: anchor, to: anchor };
    if (view === "week") {
      const s = weekStart(anchor);
      return { from: s, to: addDays(s, 6) };
    }
    return { from: monthStart(anchor), to: monthEnd(anchor) };
  }, [view, anchor]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const p = new URLSearchParams({ view: "calendar", from: range.from, to: range.to });
      if (member) p.set("member", member);
      const [c, d] = await Promise.all([api<Calendar>(`/api/consult/firm/${shopId}?${p.toString()}`), api<Dashboard>(`/api/consult/firm/${shopId}?view=dashboard`)]);
      setCal(c);
      setDash(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the calendar.");
    }
  }, [shopId, range, member]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the view's inputs change
    void load();
  }, [load]);

  const step = (dir: 1 | -1) => setAnchor(view === "day" ? addDays(anchor, dir) : view === "week" ? addDays(anchor, 7 * dir) : addDays(dir === 1 ? monthEnd(anchor) : monthStart(anchor), dir));

  if (error && !cal) return <Alert tone="danger">{error}</Alert>;
  if (!cal || !dash) return <p className="text-sm text-ink-600">Loading the calendar…</p>;

  const isOwnerView = cal.access.role !== "MEMBER";
  const columns = view === "day" && isOwnerView && !member ? cal.members : null;

  return (
    <div className="flex flex-col gap-3" data-testid="consult-calendar">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Tile label="Today" value={dash.today.filter((b) => b.status !== "CANCELLED" && b.status !== "REJECTED").length} hint="appointments" tone="kesari" />
        <Tile label="Upcoming" value={dash.upcomingCount} tone="teal" />
        <Tile label="To accept" value={dash.pendingApproval} tone={dash.pendingApproval ? "amber" : "ink"} />
        <Tile label="Today's earnings" value={rupees(dash.todayEarningsPaise)} hint={`7 days: ${rupees(dash.weekEarningsPaise)}`} tone="green" />
        <Tile label="Utilisation (7 days)" value={`${dash.utilisationPct}%`} hint={`★ ${dash.ratingAvg.toFixed(1)} (${dash.ratingCount}) · ${dash.completedThisMonth} done, ${dash.noShowsThisMonth} no-show this month`} tone="ink" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => step(-1)} aria-label="Previous">
            ‹
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAnchor(today)}>
            Today
          </Button>
          <Button variant="ghost" size="sm" onClick={() => step(1)} aria-label="Next">
            ›
          </Button>
          <span className="ml-1 text-sm font-extrabold text-ink-900">{view === "month" ? formatDateKey(anchor).slice(8) : view === "week" ? `${formatDateKey(range.from)} – ${formatDateKey(range.to).slice(5)}` : formatDateKey(anchor)}</span>
        </div>
        <div className="flex items-center gap-1" role="tablist" aria-label="Calendar view">
          {(["day", "week", "month"] as View[]).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`min-h-10 rounded-lg px-3 text-sm font-bold ${view === v ? "bg-kesari-600 text-white" : "text-ink-700 hover:bg-cream-100"}`}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
          {isOwnerView && cal.members.length > 1 ? (
            <select className="ml-1 min-h-10 rounded-lg border border-cream-200 px-2 text-sm" value={member} onChange={(e) => setMember(e.target.value)} aria-label="Consultant">
              <option value="">Whole team</option>
              {cal.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>

      <Legend />

      {view === "day" ? (
        <DayGrid day={anchor} cal={cal} columns={columns} onOpen={setOpen} />
      ) : view === "week" ? (
        <WeekList from={range.from} cal={cal} onOpen={setOpen} />
      ) : (
        <MonthGrid from={range.from} to={range.to} cal={cal} onPick={(d) => {
          setAnchor(d);
          setView("day");
        }} />
      )}

      {open ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-modal="true" aria-label="Booking" onClick={() => setOpen(null)}>
          <div className="h-full w-full max-w-xl overflow-y-auto bg-cream-50 p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex justify-end">
              <Button variant="ghost" onClick={() => setOpen(null)}>
                Close ✕
              </Button>
            </div>
            <ConsultBookingView bookingId={open} onChanged={load} compact />
          </div>
        </div>
      ) : null}

      <p className="text-xs text-ink-600">
        Times are India Standard Time. <Link href={`/shop/consult/setup?shopId=${shopId}`} className="font-bold text-kesari-800 underline">Hours, leave and services</Link>
      </p>
    </div>
  );
}

function Legend() {
  const keys: (ConsultBookingStatus | "RESCHEDULED")[] = ["PENDING_APPROVAL", "CONFIRMED", "RESCHEDULED", "COMPLETED", "CANCELLED", "NO_SHOW"];
  return (
    <div className="flex flex-wrap gap-1.5 text-xs" aria-label="Colours">
      {keys.map((k) => (
        <span key={k} className={`rounded-full border px-2 py-0.5 font-bold ${CONSULT_STATUS_TONES[k].bg} ${CONSULT_STATUS_TONES[k].border} ${CONSULT_STATUS_TONES[k].text}`}>
          {CONSULT_STATUS_LABELS[k].en}
        </span>
      ))}
    </div>
  );
}

function BookingChip({ b, onOpen, style }: { b: Card; onOpen: (id: string) => void; style?: React.CSSProperties }) {
  const tone = CONSULT_STATUS_TONES[displayStatus(b)];
  return (
    <button
      type="button"
      onClick={() => onOpen(b.id)}
      style={style}
      data-testid="consult-calendar-booking"
      className={`overflow-hidden rounded-lg border-l-4 px-2 py-1 text-left text-xs ${tone.bg} ${tone.border} ${tone.text} hover:ring-2 hover:ring-kesari-300`}
    >
      <span className="font-bold">
        {clock12(istMinuteOfDay(new Date(b.startsAt)))} {MODE_ICON[b.mode]} {b.visitorName}
        {b.attendees > 1 ? ` +${b.attendees - 1}` : ""}
      </span>
      <span className="block truncate">
        {b.serviceName}
        {b.arrived ? " · arrived" : ""}
      </span>
    </button>
  );
}

function DayGrid({ day, cal, columns, onOpen }: { day: string; cal: Calendar; columns: Calendar["members"] | null; onOpen: (id: string) => void }) {
  const dow = istWeekday(day);
  const dayBookings = cal.bookings.filter((b) => istDateKey(new Date(b.startsAt)) === day);
  const hours = cal.members.flatMap((m) => m.hours.filter((h) => h.weekday === dow));
  const first = Math.min(8 * 60, ...hours.map((h) => h.startMinute), ...dayBookings.map((b) => istMinuteOfDay(new Date(b.startsAt))));
  const last = Math.max(20 * 60, ...hours.map((h) => h.endMinute), ...dayBookings.map((b) => istMinuteOfDay(new Date(b.endsAt))));
  const startH = Math.floor(first / 60);
  const endH = Math.min(24, Math.ceil(last / 60));
  const cols = columns ?? [{ id: "all", name: "", color: "#c2410c", hours: [] }];
  const off = cal.timeOff.filter((t) => istDateKey(new Date(t.startsAt)) <= day && istDateKey(new Date(new Date(t.endsAt).getTime() - 1)) >= day && t.kind !== "EXTRA");

  if (!dayBookings.length && !hours.length) return <Alert tone="info">No working hours and no bookings on {formatDateKey(day)}.</Alert>;
  return (
    <div className="overflow-x-auto rounded-2xl border-2 border-[var(--gk-line)] bg-white" data-testid="consult-day">
      {off.length ? (
        <p className="border-b border-cream-200 bg-stone-50 px-3 py-1 text-xs text-ink-700">
          {off.map((t) => `${t.kind === "HOLIDAY" ? "Holiday" : t.kind === "LEAVE" ? "Leave" : "Blocked"}${t.memberId ? ` (${cal.members.find((m) => m.id === t.memberId)?.name ?? ""})` : ""}${t.reason ? `: ${t.reason}` : ""}`).join(" · ")}
        </p>
      ) : null}
      <div className="grid min-w-[22rem]" style={{ gridTemplateColumns: `3.5rem repeat(${cols.length}, minmax(10rem, 1fr))` }}>
        <div />
        {cols.map((c) => (
          <div key={c.id} className="border-b border-l border-cream-200 px-2 py-1 text-sm font-bold" style={{ color: c.color }}>
            {c.name || "Appointments"}
          </div>
        ))}
        <div className="relative" style={{ height: (endH - startH) * HOUR_PX }}>
          {Array.from({ length: endH - startH }, (_, i) => (
            <span key={i} className="absolute right-1 text-[11px] text-ink-500" style={{ top: i * HOUR_PX }}>
              {clock12((startH + i) * 60).replace(":00", "")}
            </span>
          ))}
        </div>
        {cols.map((c) => {
          const mine = columns ? dayBookings.filter((b) => b.members.some((m) => m.id === c.id)) : dayBookings;
          const workHours = columns ? c.hours.filter((h) => h.weekday === dow) : hours;
          return (
            <div key={c.id} className="relative border-l border-cream-200" style={{ height: (endH - startH) * HOUR_PX }}>
              {Array.from({ length: endH - startH }, (_, i) => (
                <div key={i} className="absolute inset-x-0 border-t border-cream-100" style={{ top: i * HOUR_PX }} />
              ))}
              {workHours.map((h, i) => (
                <div key={i} className="absolute inset-x-0 bg-leaf-50/60" style={{ top: ((h.startMinute - startH * 60) / 60) * HOUR_PX, height: ((h.endMinute - h.startMinute) / 60) * HOUR_PX }} aria-hidden />
              ))}
              {mine.map((b, i) => {
                const s = istMinuteOfDay(new Date(b.startsAt));
                const e = Math.max(s + 15, istMinuteOfDay(new Date(b.endsAt)) || 1440);
                return <BookingChip key={b.id} b={b} onOpen={onOpen} style={{ position: "absolute", top: ((s - startH * 60) / 60) * HOUR_PX, height: Math.max(28, ((e - s) / 60) * HOUR_PX - 2), left: 4 + (i % 2) * 6, right: 4 }} />;
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekList({ from, cal, onOpen }: { from: string; cal: Calendar; onOpen: (id: string) => void }) {
  const days = dateKeysBetween(from, addDays(from, 6));
  return (
    <div className="grid gap-2 sm:grid-cols-7" data-testid="consult-week">
      {days.map((d) => {
        const list = cal.bookings.filter((b) => istDateKey(new Date(b.startsAt)) === d);
        return (
          <div key={d} className="flex min-h-24 flex-col gap-1 rounded-xl border-2 border-[var(--gk-line)] bg-white p-2">
            <p className={`text-xs font-extrabold ${d === istDateKey(new Date()) ? "text-kesari-700" : "text-ink-700"}`}>{formatDateKey(d).slice(0, 10)}</p>
            {list.length ? list.map((b) => <BookingChip key={b.id} b={b} onOpen={onOpen} />) : <span className="text-xs text-ink-400">—</span>}
          </div>
        );
      })}
    </div>
  );
}

function MonthGrid({ from, to, cal, onPick }: { from: string; to: string; cal: Calendar; onPick: (d: string) => void }) {
  const start = weekStart(from);
  const days = dateKeysBetween(start, addDays(weekStart(to), 6));
  return (
    <div className="grid grid-cols-7 gap-1" data-testid="consult-month">
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
        <p key={d} className="text-center text-xs font-bold text-ink-600">
          {d}
        </p>
      ))}
      {days.map((d) => {
        const list = cal.bookings.filter((b) => istDateKey(new Date(b.startsAt)) === d);
        const inMonth = d >= from && d <= to;
        const counts = new Map<string, number>();
        for (const b of list) counts.set(displayStatus(b), (counts.get(displayStatus(b)) ?? 0) + 1);
        return (
          <button key={d} type="button" onClick={() => onPick(d)} className={`flex min-h-16 flex-col items-start gap-0.5 rounded-lg border p-1 text-left ${inMonth ? "border-cream-200 bg-white" : "border-transparent bg-cream-50 text-ink-400"}`}>
            <span className={`text-xs font-bold ${d === istDateKey(new Date()) ? "text-kesari-700" : ""}`}>{Number(d.slice(8))}</span>
            {[...counts.entries()].map(([k, n]) => (
              <span key={k} className={`rounded px-1 text-[10px] font-bold ${CONSULT_STATUS_TONES[k as ConsultBookingStatus].bg} ${CONSULT_STATUS_TONES[k as ConsultBookingStatus].text}`}>
                {n} {CONSULT_STATUS_LABELS[k as ConsultBookingStatus].en.toLowerCase()}
              </span>
            ))}
          </button>
        );
      })}
    </div>
  );
}
