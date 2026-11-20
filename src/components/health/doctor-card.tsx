/**
 * GoKesari Health "Find a doctor": one doctor at one clinic (search results, the Health home strip).
 * Prime listings carry a visible "Prime" / "Prime Plus" label — the boost is never hidden.
 */
import Link from "next/link";

import { clock12, formatDateKey, istDateKey, istMinuteOfDay } from "@/lib/consult/time";
import { formatPaiseCompact } from "@/lib/money";
import type { DoctorCard } from "@/server/health/find-doctor";

const MODE_WORD: Record<string, string> = { IN_PERSON: "In clinic", VIDEO: "Video", PHONE: "Phone", HOME_VISIT: "Home visit" };

export function slotText(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const day = istDateKey(d);
  const today = istDateKey(now);
  const when = day === today ? "Today" : formatDateKey(day);
  return `${when}, ${clock12(istMinuteOfDay(d))}`;
}

function fees(c: Pick<DoctorCard, "feeFromPaise" | "feeToPaise">): string {
  if (c.feeFromPaise == null) return "Fee on request";
  const f = (p: number) => (p === 0 ? "Free" : formatPaiseCompact(p));
  return c.feeFromPaise === c.feeToPaise ? f(c.feeFromPaise) : `${f(c.feeFromPaise)} – ${f(c.feeToPaise ?? c.feeFromPaise)}`;
}

export function PrimeBadge({ label, featured = false }: { label: string | null; featured?: boolean }) {
  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-extrabold text-amber-800" data-testid="health-prime-label" title="Prime listing: shown higher in results. Free listings are always shown too.">
      ★ {featured ? `${label} · Featured` : label}
    </span>
  );
}

export function VerifiedBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-leaf-100 px-2 py-0.5 text-xs font-bold text-leaf-700" title="Council registration and practice checked by GoKesari">
      ✔ Verified
    </span>
  );
}

export function DoctorCardView({ card, query = "" }: { card: DoctorCard; query?: string }) {
  const href = `/health/doctors/${card.memberId}${query ? `?${query}` : ""}`;
  const next = slotText(card.nextSlot);
  return (
    <article className="flex flex-col gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3" data-testid="health-doctor-card" data-member={card.memberId} data-tier={card.tier}>
      <div className="flex items-start gap-3">
        {card.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.photoUrl} alt="" className="h-16 w-16 shrink-0 rounded-2xl object-cover" />
        ) : (
          <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-kesari-100 text-3xl" aria-hidden>
            🩺
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={href} className="text-base font-extrabold text-ink-900 hover:underline">
              {card.name}
            </Link>
            <VerifiedBadge />
            <PrimeBadge label={card.primeLabel} featured={card.featured} />
          </div>
          <p className="text-sm text-ink-700">{[card.qualifications, card.specialties.slice(0, 2).join(", ")].filter(Boolean).join(" · ")}</p>
          <p className="text-xs text-ink-600">
            {card.experienceYears != null ? `${card.experienceYears} yrs experience · ` : ""}
            {card.languages.length ? `🗣 ${card.languages.join(", ")}` : ""}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-800">
        <span className="font-bold">{card.clinicName}</span>
        <span className="text-ink-600">{card.area}</span>
        {card.distanceText ? <span className="font-semibold text-teal-800">📍 {card.distanceText}</span> : null}
        {card.ratingCount ? (
          <span className="font-bold text-amber-700">
            ★ {card.rating.toFixed(1)} <span className="font-normal text-ink-500">({card.ratingCount})</span>
          </span>
        ) : (
          <span className="text-xs text-ink-500">New</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-bold text-ink-900">{fees(card)}</span>
        <span className="text-ink-600">{card.modes.map((m) => MODE_WORD[m] ?? m).join(" · ")}</span>
        {next ? <span className={card.availableToday ? "font-bold text-leaf-700" : "text-ink-700"}>Next: {next}</span> : <span className="text-ink-500">No free time in the next 2 weeks</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {card.serviceId ? (
          <Link
            href={`/health/book/${card.serviceId}?member=${card.memberId}${query ? `&${query}` : ""}`}
            className="inline-flex min-h-11 items-center rounded-lg bg-kesari-600 px-4 text-sm font-bold text-white hover:bg-kesari-700"
            data-testid="health-doctor-book"
          >
            Book
          </Link>
        ) : null}
        <Link href={href} className="inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] bg-white px-4 text-sm font-bold text-ink-800">
          Profile
        </Link>
        {card.directionsUrl ? (
          <a href={card.directionsUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] bg-white px-4 text-sm font-bold text-ink-800">
            Map
          </a>
        ) : null}
      </div>
    </article>
  );
}
