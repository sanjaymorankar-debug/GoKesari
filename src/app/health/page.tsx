import clsx from "clsx";
import Link from "next/link";

import { Icon, type IconName } from "@/components/board/icons";
import { TONE_CHIP } from "@/components/board/tiles";
import { PageHeader } from "@/components/ui";
import { patientPage } from "@/components/health/page-shell";
import { PersonSwitcher, SuggestionList, type SuggestionCard } from "@/components/health/patient";
import { LiveRefresh } from "@/components/health/live";
import { TIMELINE_KIND_LABELS, type TimelineKind } from "@/lib/health/constants";
import type { Tone } from "@/lib/board/menus";
import { formatIst } from "@/lib/consult/time";
import { patientSuggestions, recordMedicines, recordTimeline } from "@/server/health/records";

export const metadata = { title: "My Health" };
export const dynamic = "force-dynamic";

interface HubTile {
  key: string;
  label: string;
  hint: string;
  href: string;
  icon: IconName;
  tone: Tone;
}

/**
 * My Health (Theme 1 Tile Board): every patient feature on one screen — for me and each family member.
 */
export default async function MyHealthPage({ searchParams }: { searchParams: Promise<{ patient?: string }> }) {
  const sp = await searchParams;
  const page = await patientPage("/health", "My Health", sp.patient);
  if (page.kind === "render") return page.node;
  const p = page.current;
  const q = `patient=${p.id}`;
  const [timeline, meds, suggestions] = await Promise.all([recordTimeline(p.id, page.user), recordMedicines(p.id, page.user), patientSuggestions(p.id, page.user)]);
  const open = suggestions.filter((s) => s.s.status === "OPEN").slice(0, 4);
  const current = meds.filter((m) => m.current);
  const tiles: HubTile[] = [
    { key: "doctors", label: "Find a doctor", hint: "Nearby, video, today", href: `/health/doctors?${q}`, icon: "search", tone: "kesari" },
    { key: "appointments", label: "Appointments", hint: "Upcoming, queue, check-in QR", href: `/health/appointments?${q}`, icon: "calendar-clock", tone: "teal" },
    { key: "records", label: "Health records", hint: `${timeline.length} items`, href: `/health/records?${q}`, icon: "file-text", tone: "blue" },
    { key: "prescriptions", label: "Prescriptions", hint: "Print, share, get medicines", href: `/health/prescriptions?${q}`, icon: "scroll-text", tone: "violet" },
    { key: "medicines", label: "Medicine orders", hint: "Pickup or home delivery", href: `/health/medicines?${q}`, icon: "package", tone: "green" },
    { key: "care", label: "Home care", hint: "Nurse, physio, attendant", href: `/health/care?${q}`, icon: "house", tone: "pink" },
    { key: "equipment", label: "Medical equipment", hint: "Buy or rent", href: `/health/equipment?${q}`, icon: "boxes", tone: "amber" },
    { key: "family", label: "Family", hint: `${page.people.length} ${page.people.length === 1 ? "person" : "people"}`, href: "/health/family", icon: "users", tone: "teal" },
    { key: "profile", label: "Health profile", hint: "Allergies, conditions, blood group", href: `/health/profile?${q}`, icon: "user-check", tone: "blue" },
    { key: "privacy", label: "Privacy", hint: "Who sees what, access log", href: `/health/privacy?${q}`, icon: "shield-check", tone: "violet" },
    { key: "refer", label: "Refer a friend", hint: "Invite with your code", href: "/refer", icon: "gift", tone: "kesari" },
  ];
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="My Health" description={`${p.fullName}'s record since ${formatIst(p.recordStartAt)}.`} action={<LiveRefresh names={["prescription.", "suggestion.", "appointment.", "record.", "order.", "rx.", "care_booking.", "rental."]} />} />
      <PersonSwitcher people={page.lite} current={p.id} basePath="/health" />
      {p.allergies.length ? (
        <p className="mb-3 rounded-xl border-2 border-red-300 bg-red-50 px-3 py-2 text-sm font-extrabold text-red-800" data-testid="health-allergies-banner">
          Allergies: {p.allergies.join(", ")}
        </p>
      ) : null}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="health-tiles">
        {tiles.map((t) => (
          <li key={t.key}>
            <Link href={t.href} className="flex min-h-28 flex-col gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 hover:border-kesari-400" data-testid={`health-tile-${t.key}`}>
              <span className={clsx("inline-flex h-10 w-10 items-center justify-center rounded-xl", TONE_CHIP[t.tone])}>
                <Icon name={t.icon} size={22} />
              </span>
              <span className="text-base font-extrabold leading-tight text-ink-900">{t.label}</span>
              <span className="text-xs text-ink-600">{t.hint}</span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section>
          <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">Your doctors suggested</h2>
          {open.length ? (
            <SuggestionList
              followUpMemberId={open[0].s.memberId}
              items={open.map((s) => ({ id: s.s.id, type: s.s.type, status: s.s.status, text: String((s.s.details as { text?: string }).text ?? ""), targetMemberId: s.s.targetMemberId, details: { ...s.s.details, memberId: s.s.memberId }, linkedBookingId: s.s.linkedBookingId, linkedRxOrderId: s.s.linkedRxOrderId, linkedRentalId: s.s.linkedRentalId }) satisfies SuggestionCard)}
            />
          ) : (
            <p className="text-sm text-ink-600">Nothing open.</p>
          )}
          <h2 className="mb-2 mt-4 text-sm font-extrabold uppercase tracking-wide text-ink-600">Current medicines</h2>
          {current.length ? (
            <ul className="flex flex-col gap-1">
              {current.slice(0, 6).map((m) => (
                <li key={m.itemId} className="text-sm text-ink-800">
                  <span className="font-bold">{m.name} {m.strength}</span> — {m.dose}, {m.frequency}, until {m.end}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-600">None from GoKesari prescriptions.</p>
          )}
        </section>
        <section>
          <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">Latest in the record</h2>
          {timeline.length ? (
            <ul className="flex flex-col gap-2">
              {timeline.slice(0, 6).map((t) => (
                <li key={t.id} className="rounded-xl border-2 border-[var(--gk-line)] bg-white p-2 text-sm">
                  <span className="text-xs font-extrabold text-kesari-900">{TIMELINE_KIND_LABELS[t.kind as TimelineKind] ?? t.kind}</span> · <span className="text-xs text-ink-600">{formatIst(t.occurredAt)}</span>
                  <span className="block font-bold text-ink-900">{t.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-600">Your record starts today. Book a doctor or upload an old report.</p>
          )}
          <Link href={`/health/records?${q}`} className="mt-2 inline-flex min-h-11 items-center text-sm font-extrabold text-kesari-800 underline">
            Open all records →
          </Link>
        </section>
      </div>
    </div>
  );
}
