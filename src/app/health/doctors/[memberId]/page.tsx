import Link from "next/link";
import { notFound } from "next/navigation";

import { PinMap, Stars } from "@/components/consult/common";
import { CallButtons, ShareProfile } from "@/components/health/doctor-actions";
import { PrimeBadge, slotText, VerifiedBadge } from "@/components/health/doctor-card";
import { ComingSoon } from "@/components/health/page-shell";
import { CONSULT_MODE_LABELS, WEEKDAY_SHORT, type ConsultMode } from "@/lib/consult/constants";
import { clock12, isDateKey } from "@/lib/consult/time";
import { formatPaiseCompact } from "@/lib/money";
import { consultEnabled } from "@/server/consult/access";
import { healthEnabled } from "@/server/health/access";
import { doctorPublicProfile, type ClinicView } from "@/server/health/find-doctor-views";
import { recordProfileView } from "@/server/health/prime";

export const dynamic = "force-dynamic";

type Params = { memberId: string };
type Search = { patient?: string; suggestion?: string; date?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: Promise<Params> }) {
  const { memberId } = await params;
  if (!UUID.test(memberId)) return { title: "Doctor" };
  const d = await doctorPublicProfile(memberId).catch(() => null);
  return { title: d ? `${d.name} — book an appointment` : "Doctor" };
}

function hoursText(c: ClinicView): string[] {
  const byDay = new Map<number, string[]>();
  for (const h of c.hours) byDay.set(h.weekday, [...(byDay.get(h.weekday) ?? []), `${clock12(h.from)}–${clock12(h.to)}`]);
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([d, ranges]) => `${WEEKDAY_SHORT[d]}: ${ranges.join(", ")}`);
}

/**
 * A verified doctor's public profile (GoKesari Health): photo, qualifications, council and registration
 * number, specialities, experience, clinics with map, fees, timings, reviews, Prime / verified badges,
 * call / WhatsApp, share, Book. Each view is counted for the clinic's analytics.
 */
export default async function DoctorPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<Search> }) {
  if (!(await healthEnabled()) || !(await consultEnabled())) return <ComingSoon title="Doctor" />;
  const { memberId } = await params;
  if (!UUID.test(memberId)) notFound();
  const sp = await searchParams;
  const d = await doctorPublicProfile(memberId).catch(() => null);
  if (!d) notFound();
  await recordProfileView(d.clinics[0].shopId);
  const carry = new URLSearchParams();
  if (sp.patient && UUID.test(sp.patient)) carry.set("patient", sp.patient);
  if (sp.suggestion && UUID.test(sp.suggestion)) carry.set("suggestion", sp.suggestion);
  if (sp.date && isDateKey(sp.date)) carry.set("date", sp.date);
  const extra = carry.toString() ? `&${carry.toString()}` : "";
  const path = `/health/doctors/${d.memberId}`;
  return (
    <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-4">
        <Link href={`/health/doctors${carry.toString() ? `?${carry.toString()}` : ""}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
          ← Find a doctor
        </Link>
        <header className="flex items-start gap-3 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4" data-testid="health-doctor-profile">
          {d.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={d.photoUrl} alt="" className="h-24 w-24 rounded-2xl object-cover" />
          ) : (
            <span className="grid h-24 w-24 place-items-center rounded-2xl bg-kesari-100 text-5xl" aria-hidden>
              🩺
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-extrabold text-ink-900">{d.name}</h1>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <VerifiedBadge />
              <PrimeBadge label={d.clinics[0].primeLabel} />
            </div>
            <p className="mt-1 text-ink-800">{d.qualifications}</p>
            <p className="text-sm text-ink-700">{d.specialties.join(" · ")}</p>
            <p className="text-sm text-ink-600">
              {d.experienceYears != null ? `${d.experienceYears} years experience · ` : ""}
              {d.languages.length ? `Speaks ${d.languages.join(", ")}` : ""}
            </p>
            <p className="mt-1 text-xs text-ink-600" data-testid="health-doctor-registration">
              {d.council} · Reg. no. {d.registrationNumber}
              {d.registrationYear ? ` (${d.registrationYear})` : ""}
            </p>
            <p className="mt-1">
              <Stars value={d.rating} count={d.ratingCount} />
            </p>
          </div>
        </header>
        {d.clinics.map((c) => {
          const next = slotText(c.nextSlot);
          return (
            <section key={c.memberId} className="flex flex-col gap-3 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4" data-testid="health-doctor-clinic">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-extrabold text-ink-900">{c.name}</h2>
                <PrimeBadge label={c.primeLabel} />
              </div>
              <p className="text-sm text-ink-700">{c.address}</p>
              {c.tokenMode ? <p className="text-sm font-semibold text-teal-800">Token clinic: you get a token number for the day you choose.</p> : null}
              {next ? <p className="text-sm font-bold text-leaf-700">Next free time: {next}</p> : <p className="text-sm text-ink-600">No free time in the next two weeks.</p>}
              <ul className="flex flex-col gap-2">
                {c.services.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cream-200 p-2">
                    <span className="text-sm">
                      <strong>{s.name}</strong> · {s.feeType === "FREE" || s.feePaise === 0 ? "Free" : formatPaiseCompact(s.feePaise)} · {s.durationMinutes} min ·{" "}
                      {s.modes.map((m) => CONSULT_MODE_LABELS[m as ConsultMode]?.en ?? m).join(", ")}
                    </span>
                    <Link href={`/health/book/${s.id}?member=${c.memberId}${extra}`} className="inline-flex min-h-11 items-center rounded-lg bg-kesari-600 px-4 text-sm font-bold text-white hover:bg-kesari-700" data-testid="health-doctor-book">
                      Book
                    </Link>
                  </li>
                ))}
              </ul>
              {c.hours.length ? (
                <div className="text-sm text-ink-700">
                  <p className="font-bold">Timings (IST)</p>
                  <ul>
                    {hoursText(c).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <CallButtons phone={c.phone} whatsapp={c.whatsapp} tracked={c.virtualNumber} doctor={d.name} />
              {c.latitude != null && c.longitude != null ? (
                <div className="flex flex-col gap-2">
                  <PinMap latitude={c.latitude} longitude={c.longitude} label={c.name} />
                  {c.directionsUrl ? (
                    <a href={c.directionsUrl} target="_blank" rel="noreferrer" className="text-sm font-bold text-kesari-800 underline">
                      Directions
                    </a>
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      <aside className="flex flex-col gap-3">
        <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4 text-sm">
          <h2 className="mb-2 text-base font-extrabold">Share</h2>
          <ShareProfile title={d.name} path={path} />
        </section>
        {d.bio || d.about ? (
          <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4 text-sm">
            <h2 className="mb-1 text-base font-extrabold">About</h2>
            <p className="whitespace-pre-wrap text-ink-800">{d.bio ?? d.about}</p>
          </section>
        ) : null}
        <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4 text-sm" data-testid="health-doctor-reviews">
          <h2 className="mb-2 text-base font-extrabold">Patient reviews</h2>
          {d.reviews.length ? (
            <ul className="flex flex-col gap-2">
              {d.reviews.map((r, i) => (
                <li key={i} className="border-b border-cream-200 pb-2 last:border-0">
                  <p className="font-bold text-amber-700">
                    {"★".repeat(r.rating)}
                    <span className="text-ink-300">{"★".repeat(Math.max(0, 5 - r.rating))}</span> <span className="text-xs font-normal text-ink-500">{r.by}</span>
                  </p>
                  {r.text ? <p className="text-ink-800">{r.text}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-600">No reviews yet.</p>
          )}
        </section>
        {d.clinics[0].primeLabel ? <p className="text-xs text-ink-500">★ Prime is a paid listing that is shown higher in search. It is not a medical rating.</p> : null}
      </aside>
    </div>
  );
}
