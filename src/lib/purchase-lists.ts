/**
 * Purchase lists (docs/purchase-lists-2026-10): limits, labels and the due
 * date, shared by the service, the API and the pages. No server imports, so
 * client components can use it.
 */
import { addDays, addMonths } from "date-fns";

export type ListKind = "SHOPPING" | "MEDICINE";
export type ListFrequency = "WEEKLY" | "MONTHLY";

export const LIST_LIMITS = {
  /** Lists one customer can keep. */
  listsPerUser: 20,
  /** Products on one list. */
  itemsPerList: 100,
  /** The cart's own cap on one line. */
  maxQuantity: 99,
  nameLength: 60,
  noteLength: 120,
} as const;

export const KIND_LABEL: Record<ListKind, string> = {
  SHOPPING: "Shopping list",
  MEDICINE: "Medicines",
};

export const FREQUENCY_LABEL: Record<ListFrequency, string> = {
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
};

/** When a list is due again: a week or a month after it was last ordered (or created, before its first order). */
export function nextDueAt(list: { frequency: ListFrequency; lastOrderedAt: Date | null; createdAt: Date }): Date {
  const from = list.lastOrderedAt ?? list.createdAt;
  return list.frequency === "WEEKLY" ? addDays(from, 7) : addMonths(from, 1);
}

/** The name as stored: trimmed, inner runs of spaces collapsed. */
export function normaliseListName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** "24 Oct" (this year) or "24 Oct 2027", in India time. */
export function formatListDate(value: Date | string, now: Date = new Date()): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const sameYear =
    new Intl.DateTimeFormat("en-IN", { year: "numeric", timeZone: "Asia/Kolkata" }).format(date) ===
    new Intl.DateTimeFormat("en-IN", { year: "numeric", timeZone: "Asia/Kolkata" }).format(now);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "Asia/Kolkata",
  }).format(date);
}

/** Shops to add products from: pharmacies for a medicines list, every shop otherwise. */
export function browseHrefFor(kind: ListKind): string {
  return kind === "MEDICINE" ? "/shops?type=PHARMACY" : "/shops";
}

export const KIND_EMOJI: Record<ListKind, string> = { SHOPPING: "🛒", MEDICINE: "💊" };
