"use client";

/** GoKesari Health screens: the same fetch helper and formatters as consultant appointments. */
export { api, rupees, amount, Panel, Tile, Chip, StatusPill, modeLabel, MODE_ICON } from "@/components/consult/common";

/** "20-Nov-2026 10.51 AM IST" — every time shown in Health is IST. */
export function ist(at: string | Date | null | undefined, withTime = true): string {
  if (!at) return "—";
  const d = new Date(new Date(at).getTime() + 330 * 60_000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = `${String(d.getUTCDate()).padStart(2, "0")}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
  if (!withTime) return date;
  const h = d.getUTCHours();
  return `${date} ${h % 12 === 0 ? 12 : h % 12}.${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} IST`;
}
