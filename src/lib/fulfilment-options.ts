/**
 * Fulfilment options (docs/four-features-2026-10, feature 1) — client-safe
 * helpers shared by the shop's planner, the customer's order card and the
 * server, so all three agree on labels and on which time slots exist.
 *
 * A slot is "YYYY-MM-DD@HH:MM" (its IST start, lib/scheduled-slots.ts); its
 * length comes from rule fulfilmentOptions.slotMinutes.
 */
import { formatScheduledSlot, formatSlotDay, istMidnightMs, parseScheduledSlotKey, scheduledSlotKey } from "./scheduled-slots";

export const FULFILMENT_OPTION_KEYS = ["PICKUP", "SHOP_DELIVERY", "GOKESARI_PARTNER"] as const;
export type FulfilmentOptionKey = (typeof FULFILMENT_OPTION_KEYS)[number];

export const FULFILMENT_OPTION_LABELS: Record<FulfilmentOptionKey, string> = {
  PICKUP: "Pickup from the shop",
  SHOP_DELIVERY: "Shop's own delivery",
  GOKESARI_PARTNER: "GoKesari delivery partner",
};

/** One line for the shop's chooser. */
export const FULFILMENT_OPTION_HINTS: Record<FulfilmentOptionKey, string> = {
  PICKUP: "The customer collects from your shop and shows a pickup code.",
  SHOP_DELIVERY: "One of your own delivery people takes it; the customer gives them the delivery code.",
  GOKESARI_PARTNER: "A GoKesari delivery partner picks it up from you.",
};

export interface SlotRules {
  slotMinutes: number;
  firstSlotHour: number;
  lastSlotHour: number;
  maxDaysAhead: number;
}

export interface SlotOption {
  key: string;
  start: string;
  end: string;
  label: string;
}

export interface SlotDay {
  date: string;
  label: string;
  slots: SlotOption[];
}

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

/** Today's IST date ("YYYY-MM-DD"). */
export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The slot's start and end instants. */
export function slotBounds(key: string, slotMinutes: number): { start: Date; end: Date } | null {
  const parsed = parseScheduledSlotKey(key);
  if (!parsed) return null;
  const start = new Date(istMidnightMs(parsed.date) + parsed.startMinutes * 60_000);
  return { start, end: new Date(start.getTime() + slotMinutes * 60_000) };
}

/**
 * Every slot a shop may choose now: today (slots not yet over — the current
 * one included, so "now" is always possible) through maxDaysAhead days ahead.
 */
export function availableSlotDays(rules: SlotRules, now: Date = new Date()): SlotDay[] {
  const today = istToday(now);
  const days: SlotDay[] = [];
  for (let offset = 0; offset <= rules.maxDaysAhead; offset += 1) {
    const date = new Date(istMidnightMs(today) + offset * DAY_MS + IST_OFFSET_MS).toISOString().slice(0, 10);
    const slots: SlotOption[] = [];
    for (let minutes = rules.firstSlotHour * 60; minutes + rules.slotMinutes <= rules.lastSlotHour * 60; minutes += rules.slotMinutes) {
      const key = scheduledSlotKey(date, minutes);
      const bounds = slotBounds(key, rules.slotMinutes)!;
      if (bounds.end.getTime() <= now.getTime()) continue;
      slots.push({ key, start: bounds.start.toISOString(), end: bounds.end.toISOString(), label: formatScheduledSlot(bounds.start, bounds.end).split(", ")[1] });
    }
    if (slots.length > 0) days.push({ date, label: offset === 0 ? `Today (${formatSlotDay(date)})` : formatSlotDay(date), slots });
  }
  return days;
}

/** Whether `key` is one of the slots offered now (the server's check). */
export function isAvailableSlot(key: string, rules: SlotRules, now: Date = new Date()): boolean {
  return availableSlotDays(rules, now).some((d) => d.slots.some((s) => s.key === key));
}

/** "Thu 8 Oct, 5–6 pm". */
export function formatFulfilmentWindow(start: Date | string, end: Date | string): string {
  return formatScheduledSlot(start, end);
}

/** The slot key of a stored window (for pre-selecting the current choice). */
export function slotKeyFor(start: Date | string): string {
  const at = new Date(new Date(start).getTime() + IST_OFFSET_MS);
  return scheduledSlotKey(at.toISOString().slice(0, 10), at.getUTCHours() * 60 + at.getUTCMinutes());
}
