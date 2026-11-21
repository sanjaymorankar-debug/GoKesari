/** Small zone display pieces shared by the server pages and the booking client (no client-only code). */
import type { ZoneView } from "@/server/franchise/zones";

export function TierBadge({ name, colour }: { name: string; colour: string | null }) {
  return (
    <span className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold text-white" style={{ background: colour ?? "#475569" }}>
      {name}
    </span>
  );
}

/** "Business index 150 (Pune average ≈ 100) · source: Provisional estimate, as of 21-Nov-2026". */
export function businessText(z: Pick<ZoneView, "metric" | "value" | "source" | "asOf" | "setName">): string {
  if (z.value == null) return "Business figure to be published";
  const figure = z.metric === "ANNUAL_CR" ? `Annual business ₹${z.value.toLocaleString("en-IN")} Cr` : `Business index ${z.value.toLocaleString("en-IN")} (${z.setName} average ≈ 100)`;
  return `${figure} · source: ${z.source ?? "—"}${z.asOf ? `, as of ${asOfDate(z.asOf)}` : ""}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-21" → "21-Nov-2026" (the owner's date format). */
export function asOfDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}-${MONTHS[Number(m) - 1] ?? m}-${y}`;
}
