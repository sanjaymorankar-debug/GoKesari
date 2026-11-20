/**
 * Consultant appointments: which start times are free. Pure — the server
 * loads hours, time off and booked time and calls these; the booking service
 * calls the same check again inside its transaction (never trusting a slot a
 * browser sends), and the database's exclusion constraint is the last guard.
 */
import { addDays, dateKeysBetween, istAt, istDateKey, istWeekday } from "./time";

export interface Interval {
  start: number; // epoch ms
  end: number; // epoch ms, exclusive
}

export interface WeeklyHour {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface TimeOffRow {
  kind: "LEAVE" | "HOLIDAY" | "BLOCK" | "EXTRA";
  /** null: the whole firm. */
  memberId: string | null;
  startsAt: Date;
  endsAt: Date;
}

/** Time already taken on a member's calendar. */
export interface BusyRow {
  start: number;
  /** Appointment end plus buffer. */
  end: number;
  shareKey: string;
  attendees: number;
}

export interface MemberCalendar {
  memberId: string;
  slotMinutes: number;
  bufferMinutes: number;
  maxPerSlot: number;
  hours: readonly WeeklyHour[];
  timeOff: readonly TimeOffRow[];
  busy: readonly BusyRow[];
}

export interface SlotRules {
  now: Date;
  minNoticeMinutes: number;
  bookingWindowDays: number;
}

export interface ServiceShape {
  id: string;
  durationMinutes: number;
  bookingKind: "INDIVIDUAL" | "TEAM" | "GROUP";
  capacity: number;
  requiredMembers: number;
}

const MIN = 60_000;

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Working windows of one member on one IST day: weekly hours plus EXTRA, minus leave, blocks and holidays. */
export function workingWindows(cal: Pick<MemberCalendar, "memberId" | "hours" | "timeOff">, dateKey: string): Interval[] {
  const dayStart = istAt(dateKey, 0).getTime();
  const dayEnd = istAt(addDays(dateKey, 1), 0).getTime();
  const weekday = istWeekday(dateKey);
  const open: Interval[] = cal.hours
    .filter((h) => h.weekday === weekday && h.startMinute < h.endMinute)
    .map((h) => ({ start: istAt(dateKey, h.startMinute).getTime(), end: istAt(dateKey, h.endMinute).getTime() }));
  for (const t of cal.timeOff) {
    if (t.kind !== "EXTRA" || t.memberId !== cal.memberId) continue;
    const s = Math.max(t.startsAt.getTime(), dayStart);
    const e = Math.min(t.endsAt.getTime(), dayEnd);
    if (s < e) open.push({ start: s, end: e });
  }
  let windows = mergeIntervals(open);
  for (const t of cal.timeOff) {
    if (t.kind === "EXTRA") continue;
    if (t.memberId !== null && t.memberId !== cal.memberId) continue;
    windows = subtract(windows, { start: t.startsAt.getTime(), end: t.endsAt.getTime() });
  }
  return windows;
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

function subtract(windows: Interval[], cut: Interval): Interval[] {
  const out: Interval[] = [];
  for (const w of windows) {
    if (!overlaps(w, cut)) {
      out.push(w);
      continue;
    }
    if (w.start < cut.start) out.push({ start: w.start, end: cut.start });
    if (cut.end < w.end) out.push({ start: cut.end, end: w.end });
  }
  return out;
}

/** The key that lets bookings share a member's time: one group session, or one multi-person slot. */
export function shareKeyFor(service: Pick<ServiceShape, "id" | "bookingKind">, member: Pick<MemberCalendar, "memberId" | "maxPerSlot">, startMs: number, bookingId: string): string {
  if (service.bookingKind === "GROUP") return `G:${service.id}:${startMs}`;
  if (member.maxPerSlot > 1 && service.bookingKind === "INDIVIDUAL") return `S:${member.memberId}:${startMs}`;
  return bookingId;
}

/** Places left for a booking at `startMs` with this member, or 0 when the time is not free. */
export function memberPlacesAt(
  cal: MemberCalendar,
  service: ServiceShape,
  startMs: number,
  rules: SlotRules,
  options: { ignoreRules?: boolean } = {},
): number {
  const durMs = service.durationMinutes * MIN;
  const appt: Interval = { start: startMs, end: startMs + durMs };
  const blocked: Interval = { start: startMs, end: startMs + durMs + cal.bufferMinutes * MIN };
  if (!options.ignoreRules) {
    if (startMs < rules.now.getTime() + rules.minNoticeMinutes * MIN) return 0;
    if (startMs > rules.now.getTime() + rules.bookingWindowDays * 86_400_000) return 0;
  }
  const windows = workingWindows(cal, istDateKey(new Date(startMs)));
  if (!windows.some((w) => w.start <= appt.start && appt.end <= w.end)) return 0;
  const sharedKey = shareKeyFor(service, cal, startMs, "__probe__");
  const shared = sharedKey !== "__probe__";
  let taken = 0;
  for (const b of cal.busy) {
    if (!overlaps(blocked, { start: b.start, end: b.end })) continue;
    if (shared && b.shareKey === sharedKey) {
      taken += service.bookingKind === "GROUP" ? b.attendees : 1;
      continue;
    }
    return 0;
  }
  const capacity = service.bookingKind === "GROUP" ? service.capacity : shared ? cal.maxPerSlot : 1;
  return Math.max(0, capacity - taken);
}

/** Candidate start times of one member on one day (every slotMinutes step inside a window). */
export function candidateStarts(cal: MemberCalendar, service: ServiceShape, dateKey: string): number[] {
  const durMs = service.durationMinutes * MIN;
  const stepMs = Math.max(5, cal.slotMinutes) * MIN;
  const out: number[] = [];
  for (const w of workingWindows(cal, dateKey)) {
    for (let t = w.start; t + durMs <= w.end; t += stepMs) out.push(t);
  }
  return out;
}

export interface FreeSlot {
  /** ISO start. */
  start: string;
  /** Members free at that time (enough of them for a team service). */
  memberIds: string[];
  /** Places left (group sessions; 1 for a private slot). */
  places: number;
}

/**
 * Free start times on each day for a service, across the members who offer
 * it. `memberId` set: only that member. A TEAM service needs
 * `requiredMembers` members free together.
 */
export function freeSlots(
  calendars: readonly MemberCalendar[],
  service: ServiceShape,
  rules: SlotRules,
  fromKey: string,
  toKey: string,
  options: { memberId?: string | null; attendees?: number; limitPerDay?: number } = {},
): Record<string, FreeSlot[]> {
  const cals = options.memberId ? calendars.filter((c) => c.memberId === options.memberId) : calendars;
  const need = service.bookingKind === "TEAM" ? Math.max(1, service.requiredMembers) : 1;
  const attendees = Math.max(1, options.attendees ?? 1);
  const out: Record<string, FreeSlot[]> = {};
  for (const day of dateKeysBetween(fromKey, toKey, 62)) {
    const byStart = new Map<number, { members: string[]; places: number }>();
    for (const cal of cals) {
      for (const start of candidateStarts(cal, service, day)) {
        const places = memberPlacesAt(cal, service, start, rules);
        if (places < (service.bookingKind === "GROUP" ? attendees : 1)) continue;
        const entry = byStart.get(start) ?? { members: [], places: 0 };
        entry.members.push(cal.memberId);
        entry.places = Math.max(entry.places, places);
        byStart.set(start, entry);
      }
    }
    const slots = [...byStart.entries()]
      .filter(([, v]) => v.members.length >= need)
      .sort((a, b) => a[0] - b[0])
      .map(([start, v]) => ({ start: new Date(start).toISOString(), memberIds: v.members, places: v.places }));
    out[day] = options.limitPerDay ? slots.slice(0, options.limitPerDay) : slots;
  }
  return out;
}

/** The first free start from `fromKey`, looking ahead up to `days` days. */
export function nextFreeSlot(calendars: readonly MemberCalendar[], service: ServiceShape, rules: SlotRules, days: number): FreeSlot | null {
  const from = istDateKey(rules.now);
  const to = addDays(from, Math.max(0, Math.min(days, rules.bookingWindowDays)));
  const all = freeSlots(calendars, service, rules, from, to, { limitPerDay: 1 });
  for (const day of Object.keys(all).sort()) if (all[day].length) return all[day][0];
  return null;
}

/**
 * Picks the members for a booking at `startMs`: the requested one, or (any
 * member / team) the least-booked free members that day.
 */
export function pickMembers(
  calendars: readonly MemberCalendar[],
  service: ServiceShape,
  startMs: number,
  rules: SlotRules,
  options: { memberId?: string | null; attendees?: number; ignoreRules?: boolean },
): string[] | null {
  const need = service.bookingKind === "TEAM" ? Math.max(1, service.requiredMembers) : 1;
  const attendees = Math.max(1, options.attendees ?? 1);
  const enough = (cal: MemberCalendar) => memberPlacesAt(cal, service, startMs, rules, { ignoreRules: options.ignoreRules }) >= (service.bookingKind === "GROUP" ? attendees : 1);
  if (options.memberId) {
    const cal = calendars.find((c) => c.memberId === options.memberId);
    if (!cal || !enough(cal)) return null;
    if (need === 1) return [cal.memberId];
    const others = calendars.filter((c) => c.memberId !== cal.memberId && enough(c));
    if (others.length < need - 1) return null;
    return [cal.memberId, ...rankByLoad(others, startMs).slice(0, need - 1).map((c) => c.memberId)];
  }
  // A group session already running at this time keeps its member.
  if (service.bookingKind === "GROUP") {
    const joined = calendars.find((c) => enough(c) && c.busy.some((b) => b.shareKey === `G:${service.id}:${startMs}`));
    if (joined) return [joined.memberId];
  }
  const free = calendars.filter(enough);
  if (free.length < need) return null;
  return rankByLoad(free, startMs).slice(0, need).map((c) => c.memberId);
}

function rankByLoad(cals: readonly MemberCalendar[], startMs: number): MemberCalendar[] {
  const day = istDateKey(new Date(startMs));
  const load = (c: MemberCalendar) => c.busy.filter((b) => istDateKey(new Date(b.start)) === day).length;
  return [...cals].sort((a, b) => load(a) - load(b) || a.memberId.localeCompare(b.memberId));
}

/** Booked minutes over working minutes on a day range (utilisation, 0–100). */
export function utilisationPct(cals: readonly MemberCalendar[], fromKey: string, toKey: string): number {
  let open = 0;
  let booked = 0;
  for (const day of dateKeysBetween(fromKey, toKey, 62)) {
    for (const cal of cals) {
      const windows = workingWindows(cal, day);
      for (const w of windows) {
        open += w.end - w.start;
        const seen = new Set<string>();
        for (const b of cal.busy) {
          if (seen.has(b.shareKey)) continue;
          const s = Math.max(w.start, b.start);
          const e = Math.min(w.end, b.end);
          if (s < e) {
            booked += e - s;
            seen.add(b.shareKey);
          }
        }
      }
    }
  }
  return open > 0 ? Math.min(100, Math.round((booked / open) * 100)) : 0;
}
