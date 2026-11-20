/**
 * Consultant appointments (docs/consult-booking-2026-11): the pure parts —
 * IST time helpers, free-slot generation (sessions, buffer, leave, holidays,
 * extra hours, notice, window, group capacity, team bookings, multi-person
 * slots), member picking, cancellation / no-show refunds, reschedule rules,
 * GST-inclusive split and settlement amounts.
 */
import { describe, expect, it } from "vitest";

import { cancellationRefund, commissionOnFee, customerMayReschedule, gstInclusiveSplit, noShowRefund, policySummary, settlementFor, DEFAULT_POLICY } from "@/lib/consult/policy";
import { candidateStarts, freeSlots, memberPlacesAt, nextFreeSlot, pickMembers, shareKeyFor, utilisationPct, workingWindows, type MemberCalendar, type ServiceShape } from "@/lib/consult/slots";
import { addDays, clock12, financialYear, formatIst, istAt, istDateKey, istMinuteOfDay, istWeekday, monthEnd, parseClock, weekStart } from "@/lib/consult/time";

const DAY = "2026-11-23"; // a Monday
const at = (hhmm: string, day = DAY) => istAt(day, parseClock(hhmm)!).getTime();
const NOW = new Date(at("06:00", "2026-11-22")); // Sunday morning, IST
const RULES = { now: NOW, minNoticeMinutes: 60, bookingWindowDays: 30 };

function cal(over: Partial<MemberCalendar> = {}): MemberCalendar {
  return {
    memberId: "m1",
    slotMinutes: 30,
    bufferMinutes: 0,
    maxPerSlot: 1,
    // Monday: 10:00–13:00 and 17:00–20:00
    hours: [
      { weekday: 1, startMinute: 600, endMinute: 780 },
      { weekday: 1, startMinute: 1020, endMinute: 1200 },
    ],
    timeOff: [],
    busy: [],
    ...over,
  };
}
const SVC: ServiceShape = { id: "s1", durationMinutes: 30, bookingKind: "INDIVIDUAL", capacity: 1, requiredMembers: 1 };

describe("IST time helpers", () => {
  it("maps IST days and minutes to UTC and back", () => {
    expect(istAt("2026-11-20", 0).toISOString()).toBe("2026-11-19T18:30:00.000Z");
    expect(istDateKey(new Date("2026-11-19T18:30:00Z"))).toBe("2026-11-20");
    expect(istDateKey(new Date("2026-11-19T18:29:59Z"))).toBe("2026-11-19");
    expect(istMinuteOfDay(new Date("2026-11-20T04:30:00Z"))).toBe(600);
    expect(istWeekday("2026-11-23")).toBe(1);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekStart("2026-11-22")).toBe("2026-11-16");
    expect(monthEnd("2026-02-10")).toBe("2026-02-28");
    expect(clock12(1020)).toBe("5:00 PM");
    expect(clock12(0)).toBe("12:00 AM");
    expect(parseClock("25:00")).toBeNull();
    expect(financialYear(new Date("2026-03-31T18:29:00Z"))).toBe("2025-26");
    expect(financialYear(new Date("2026-03-31T18:30:00Z"))).toBe("2026-27");
    expect(formatIst(new Date("2026-11-20T04:07:00Z"))).toBe("20-Nov-2026, 09.37 IST");
  });
});

describe("working windows and candidate starts", () => {
  it("offers every slot step inside each session of the day", () => {
    const starts = candidateStarts(cal(), SVC, DAY);
    expect(starts).toHaveLength(12); // 6 in the morning, 6 in the evening
    expect(starts[0]).toBe(at("10:00"));
    expect(starts[5]).toBe(at("12:30"));
    expect(starts[6]).toBe(at("17:00"));
  });

  it("has no hours on a day without sessions", () => {
    expect(candidateStarts(cal(), SVC, addDays(DAY, 1))).toEqual([]);
  });

  it("removes leave and firm holidays, adds extra hours", () => {
    const leave = cal({ timeOff: [{ kind: "LEAVE", memberId: "m1", startsAt: new Date(at("00:00")), endsAt: new Date(at("13:00")) }] });
    expect(candidateStarts(leave, SVC, DAY)[0]).toBe(at("17:00"));
    const holiday = cal({ timeOff: [{ kind: "HOLIDAY", memberId: null, startsAt: new Date(at("00:00")), endsAt: new Date(at("23:59")) }] });
    expect(candidateStarts(holiday, SVC, DAY)).toEqual([]);
    const otherLeave = cal({ timeOff: [{ kind: "LEAVE", memberId: "m2", startsAt: new Date(at("00:00")), endsAt: new Date(at("23:59")) }] });
    expect(candidateStarts(otherLeave, SVC, DAY)).toHaveLength(12);
    const extra = cal({ timeOff: [{ kind: "EXTRA", memberId: "m1", startsAt: new Date(at("14:00")), endsAt: new Date(at("15:00")) }] });
    expect(workingWindows(extra, DAY)).toHaveLength(3);
    expect(candidateStarts(extra, SVC, DAY)).toContain(at("14:30"));
    const block = cal({ timeOff: [{ kind: "BLOCK", memberId: "m1", startsAt: new Date(at("11:00")), endsAt: new Date(at("11:30")) }] });
    expect(candidateStarts(block, SVC, DAY)).not.toContain(at("11:00"));
    expect(candidateStarts(block, SVC, DAY)).toContain(at("11:30"));
  });

  it("fits the whole appointment inside a session", () => {
    const long = { ...SVC, durationMinutes: 60 };
    const starts = candidateStarts(cal(), long, DAY);
    expect(starts).toContain(at("12:00"));
    expect(starts).not.toContain(at("12:30"));
  });
});

describe("free places", () => {
  it("refuses taken, too-soon and too-far times", () => {
    const busy = cal({ busy: [{ start: at("10:00"), end: at("10:30"), shareKey: "b1", attendees: 1 }] });
    expect(memberPlacesAt(busy, SVC, at("10:00"), RULES)).toBe(0);
    expect(memberPlacesAt(busy, SVC, at("10:30"), RULES)).toBe(1);
    const soon = { ...RULES, now: new Date(at("09:30")) };
    expect(memberPlacesAt(cal(), SVC, at("10:00"), soon)).toBe(0); // inside the 60-minute notice
    expect(memberPlacesAt(cal(), SVC, at("10:30"), soon)).toBe(1);
    expect(memberPlacesAt(cal(), SVC, at("10:00"), { ...RULES, bookingWindowDays: 0 })).toBe(0);
  });

  it("keeps the buffer after each appointment free", () => {
    const buffered = cal({ bufferMinutes: 15, busy: [{ start: at("10:00"), end: at("10:45"), shareKey: "b1", attendees: 1 }] });
    expect(memberPlacesAt(buffered, SVC, at("10:30"), RULES)).toBe(0);
    // A new appointment's own buffer must not run into the next booking either.
    const next = cal({ bufferMinutes: 15, busy: [{ start: at("11:00"), end: at("11:30"), shareKey: "b2", attendees: 1 }] });
    expect(memberPlacesAt(next, SVC, at("10:30"), RULES)).toBe(0);
    expect(memberPlacesAt(next, SVC, at("10:00"), RULES)).toBe(1);
  });

  it("fills a group session up to its capacity and blocks other work meanwhile", () => {
    const group: ServiceShape = { id: "yoga", durationMinutes: 60, bookingKind: "GROUP", capacity: 5, requiredMembers: 1 };
    const key = shareKeyFor(group, { memberId: "m1", maxPerSlot: 1 }, at("10:00"), "x");
    expect(key).toBe(`G:yoga:${at("10:00")}`);
    const c = cal({ busy: [{ start: at("10:00"), end: at("11:00"), shareKey: key, attendees: 3 }] });
    expect(memberPlacesAt(c, group, at("10:00"), RULES)).toBe(2);
    expect(memberPlacesAt(c, SVC, at("10:30"), RULES)).toBe(0);
    expect(memberPlacesAt(c, group, at("10:30"), RULES)).toBe(0); // another session would overlap
    const slots = freeSlots([c], group, RULES, DAY, DAY, { attendees: 3 })[DAY];
    expect(slots.find((s) => s.start === new Date(at("10:00")).toISOString())).toBeUndefined();
    expect(freeSlots([c], group, RULES, DAY, DAY, { attendees: 2 })[DAY][0]).toMatchObject({ start: new Date(at("10:00")).toISOString(), places: 2 });
  });

  it("allows several people per slot when the member takes more than one", () => {
    const multi = cal({ maxPerSlot: 2 });
    const key = shareKeyFor(SVC, multi, at("10:00"), "b1");
    expect(key).toBe(`S:m1:${at("10:00")}`);
    const one = { ...multi, busy: [{ start: at("10:00"), end: at("10:30"), shareKey: key, attendees: 1 }] };
    expect(memberPlacesAt(one, SVC, at("10:00"), RULES)).toBe(1);
    const two = { ...multi, busy: [...one.busy, { start: at("10:00"), end: at("10:30"), shareKey: key, attendees: 1 }] };
    expect(memberPlacesAt(two, SVC, at("10:00"), RULES)).toBe(0);
  });
});

describe("member picking", () => {
  const m1 = cal({ memberId: "m1", busy: [{ start: at("17:00"), end: at("17:30"), shareKey: "b0", attendees: 1 }] });
  const m2 = cal({ memberId: "m2" });
  it("gives 'any member' to the least booked free one", () => {
    expect(pickMembers([m1, m2], SVC, at("10:00"), RULES, {})).toEqual(["m2"]);
    expect(pickMembers([m1, m2], SVC, at("17:00"), RULES, {})).toEqual(["m2"]);
  });
  it("honours a chosen member and refuses when they are busy", () => {
    expect(pickMembers([m1, m2], SVC, at("10:00"), RULES, { memberId: "m1" })).toEqual(["m1"]);
    expect(pickMembers([m1, m2], SVC, at("17:00"), RULES, { memberId: "m1" })).toBeNull();
  });
  it("needs enough members free together for a team appointment", () => {
    const team: ServiceShape = { ...SVC, bookingKind: "TEAM", requiredMembers: 2 };
    expect(pickMembers([m1, m2], team, at("10:00"), RULES, {})?.sort()).toEqual(["m1", "m2"]);
    expect(pickMembers([m1, m2], team, at("17:00"), RULES, {})).toBeNull();
    const slots = freeSlots([m1, m2], team, RULES, DAY, DAY)[DAY];
    expect(slots.some((s) => s.start === new Date(at("17:00")).toISOString())).toBe(false);
    expect(slots[0].memberIds.sort()).toEqual(["m1", "m2"]);
  });
  it("finds the next free time across days", () => {
    expect(nextFreeSlot([m2], SVC, RULES, 7)?.start).toBe(new Date(at("10:00")).toISOString());
  });
  it("works out utilisation over working time", () => {
    expect(utilisationPct([m1], DAY, DAY)).toBe(Math.round((30 / 360) * 100));
  });
});

describe("policy and money", () => {
  const start = new Date("2026-11-25T05:00:00Z");
  it("refunds in full before the free-cancellation time, then the late percentage", () => {
    expect(cancellationRefund(DEFAULT_POLICY, { paidOnlinePaise: 50_000, startsAt: start, now: new Date(start.getTime() - 25 * 3_600_000), by: "CUSTOMER" }).refundPaise).toBe(50_000);
    const late = cancellationRefund(DEFAULT_POLICY, { paidOnlinePaise: 50_001, startsAt: start, now: new Date(start.getTime() - 2 * 3_600_000), by: "CUSTOMER" });
    expect(late).toMatchObject({ refundPaise: 25_000, pct: 50 });
    expect(cancellationRefund(DEFAULT_POLICY, { paidOnlinePaise: 50_000, startsAt: start, now: start, by: "CONSULTANT" }).refundPaise).toBe(50_000);
    expect(cancellationRefund(DEFAULT_POLICY, { paidOnlinePaise: 50_000, refundedPaise: 10_000, startsAt: start, now: start, by: "ADMIN" }).refundPaise).toBe(40_000);
    expect(cancellationRefund(DEFAULT_POLICY, { paidOnlinePaise: 0, startsAt: start, now: start, by: "CUSTOMER" }).refundPaise).toBe(0);
  });
  it("applies the no-show percentage", () => {
    expect(noShowRefund(DEFAULT_POLICY, 40_000).refundPaise).toBe(0);
    expect(noShowRefund({ ...DEFAULT_POLICY, noShowRefundPct: 25 }, 40_000).refundPaise).toBe(10_000);
  });
  it("limits customer reschedules by count and notice", () => {
    expect(customerMayReschedule(DEFAULT_POLICY, { startsAt: start, now: new Date(start.getTime() - 5 * 3_600_000), rescheduleCount: 0 }).ok).toBe(true);
    expect(customerMayReschedule(DEFAULT_POLICY, { startsAt: start, now: new Date(start.getTime() - 3 * 3_600_000), rescheduleCount: 0 }).ok).toBe(false);
    expect(customerMayReschedule(DEFAULT_POLICY, { startsAt: start, now: new Date(start.getTime() - 50 * 3_600_000), rescheduleCount: 2 }).ok).toBe(false);
    expect(policySummary(DEFAULT_POLICY).join(" ")).toContain("24 hours");
  });
  it("splits a GST-inclusive fee into taxable value and CGST + SGST", () => {
    expect(gstInclusiveSplit(118_000, 1800)).toEqual({ taxablePaise: 100_000, cgstPaise: 9_000, sgstPaise: 9_000, totalPaise: 118_000 });
    const odd = gstInclusiveSplit(50_001, 1800);
    expect(odd.taxablePaise + odd.cgstPaise + odd.sgstPaise).toBe(50_001);
    expect(gstInclusiveSplit(50_000, 0)).toMatchObject({ taxablePaise: 50_000, cgstPaise: 0 });
  });
  it("settles what was kept and charges commission on it", () => {
    expect(commissionOnFee(50_000, 200)).toBe(1_000);
    expect(settlementFor({ paidOnlinePaise: 50_000, refundPaise: 25_000, paidOfflinePaise: 0, commissionBp: 200 })).toEqual({ onlineKeptPaise: 25_000, commissionBasePaise: 25_000, commissionPaise: 500 });
    expect(settlementFor({ paidOnlinePaise: 0, refundPaise: 0, paidOfflinePaise: 80_000, commissionBp: 200 }).commissionPaise).toBe(1_600);
  });
});
