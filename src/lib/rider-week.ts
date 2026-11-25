/**
 * Rider App v2 — earnings week maths (pure: no server or database imports).
 *
 * A rider's week runs Monday to Sunday in IST (APP_TIMEZONE). Dates are plain
 * `YYYY-MM-DD` keys in that time zone; the database groups by the same keys
 * (`(created_at AT TIME ZONE tz)::date`), so no offset arithmetic happens here.
 * Used by src/server/services/rider-earnings-week.ts; tested in
 * tests/unit/rider-earnings-week.test.ts.
 */

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` key that is a real calendar date, or null. */
export function parseDateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = DATE_KEY.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return null;
  }
  return value.trim();
}

const toDate = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const toKey = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(key: string, days: number): string {
  const d = toDate(key);
  d.setUTCDate(d.getUTCDate() + days);
  return toKey(d);
}

/** The Monday on or before `key`. */
export function mondayOf(key: string): string {
  const weekday = toDate(key).getUTCDay(); // 0 = Sunday
  return addDays(key, -((weekday + 6) % 7));
}

export interface WeekWindow {
  /** Monday. */
  start: string;
  /** Sunday. */
  end: string;
  /** The seven date keys, Monday first. */
  days: string[];
  prevStart: string;
  /** Null when the next week has not started yet. */
  nextStart: string | null;
  isCurrent: boolean;
}

/**
 * The week to show: the one containing `requested` (any day of it), or the
 * current week when nothing valid is asked for or the date lies in the future.
 */
export function weekWindow(requested: string | null | undefined, todayKey: string): WeekWindow {
  const currentStart = mondayOf(todayKey);
  const asked = parseDateKey(requested);
  let start = asked ? mondayOf(asked) : currentStart;
  if (start > currentStart) start = currentStart;
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const next = addDays(start, 7);
  return {
    start,
    end: days[6],
    days,
    prevStart: addDays(start, -7),
    nextStart: next <= currentStart ? next : null,
    isCurrent: start === currentStart,
  };
}

/* ------------------------------------------------------------ summary */

export type LedgerComponent =
  | "BASE"
  | "DISTANCE"
  | "ORDER_COMPONENT"
  | "SLOT_INCENTIVE"
  | "MIN_TOP_UP"
  | "ORDER_INCENTIVE"
  | "OTHER_INCENTIVE"
  | "DEDUCTION";

/** One credited earning in the week, as read from delivery_partner_earnings. */
export interface WeekEarningRow {
  id: string;
  dateKey: string;
  createdAt: Date;
  orderNumber: string | null;
  /** Return-pickup earnings have no delivery order. */
  isReturnPickup: boolean;
  basePaise: number;
  distancePaise: number;
  orderComponentPaise: number;
  slotIncentivePaise: number;
  minTopUpPaise: number;
  orderIncentivePaise: number;
  otherIncentivePaise: number;
  deductionsPaise: number;
  totalPaise: number;
  quotePaise: number | null;
  payoutStatus: string | null;
}

export interface WeekLedgerLine {
  earningId: string;
  component: LedgerComponent;
  amountPaise: number;
  description: string;
}

export interface WeekDay {
  date: string;
  /** 0 = Monday … 6 = Sunday. */
  index: number;
  totalPaise: number;
  trips: number;
}

export interface WeekOrder {
  earningId: string;
  orderNumber: string | null;
  isReturnPickup: boolean;
  date: string;
  at: string;
  totalPaise: number;
  /** The quote locked when the rider accepted (pay plans); null = flat rate. */
  quotePaise: number | null;
  payoutStatus: string;
  lines: { component: LedgerComponent; amountPaise: number; description: string }[];
}

export interface WeekSummary {
  totalPaise: number;
  trips: number;
  days: WeekDay[];
  chips: {
    tripPaise: number;
    incentivesPaise: number;
    /** Tipping is not built yet: always 0. */
    tipsPaise: number;
    /** Zero or negative. */
    deductionsPaise: number;
  };
  orders: WeekOrder[];
}

/** Lines for an earning: its ledger lines, or (older rows without lines) its stored breakdown. */
function linesFor(row: WeekEarningRow, ledger: readonly WeekLedgerLine[]): WeekOrder["lines"] {
  const own = ledger.filter((l) => l.earningId === row.id);
  if (own.length > 0) return own.map((l) => ({ component: l.component, amountPaise: l.amountPaise, description: l.description }));
  const fromColumns: [LedgerComponent, number][] = [
    ["BASE", row.basePaise],
    ["DISTANCE", row.distancePaise],
    ["ORDER_COMPONENT", row.orderComponentPaise],
    ["SLOT_INCENTIVE", row.slotIncentivePaise],
    ["MIN_TOP_UP", row.minTopUpPaise],
    ["ORDER_INCENTIVE", row.orderIncentivePaise],
    ["OTHER_INCENTIVE", row.otherIncentivePaise],
    ["DEDUCTION", -Math.abs(row.deductionsPaise)],
  ];
  return fromColumns.filter(([, amount]) => amount !== 0).map(([component, amountPaise]) => ({ component, amountPaise, description: "" }));
}

/** Weekly total, seven day bars, the four chips and the per-order list (newest first). */
export function summariseWeek(window: Pick<WeekWindow, "days">, rows: readonly WeekEarningRow[], ledger: readonly WeekLedgerLine[]): WeekSummary {
  const days: WeekDay[] = window.days.map((date, index) => ({ date, index, totalPaise: 0, trips: 0 }));
  const byDate = new Map(days.map((d) => [d.date, d]));
  const chips = { tripPaise: 0, incentivesPaise: 0, tipsPaise: 0, deductionsPaise: 0 };
  let totalPaise = 0;
  let trips = 0;
  for (const row of rows) {
    const day = byDate.get(row.dateKey);
    if (!day) continue;
    day.totalPaise += row.totalPaise;
    day.trips += 1;
    totalPaise += row.totalPaise;
    trips += 1;
    chips.tripPaise += row.basePaise + row.distancePaise + row.orderComponentPaise + row.minTopUpPaise;
    chips.incentivesPaise += row.slotIncentivePaise + row.orderIncentivePaise + row.otherIncentivePaise;
    chips.deductionsPaise -= Math.abs(row.deductionsPaise);
  }
  const orders: WeekOrder[] = rows
    .filter((r) => byDate.has(r.dateKey))
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((r) => ({
      earningId: r.id,
      orderNumber: r.orderNumber,
      isReturnPickup: r.isReturnPickup,
      date: r.dateKey,
      at: r.createdAt.toISOString(),
      totalPaise: r.totalPaise,
      quotePaise: r.quotePaise,
      payoutStatus: r.payoutStatus ?? "UNPAID",
      lines: linesFor(r, ledger),
    }));
  return { totalPaise, trips, days, chips, orders };
}
