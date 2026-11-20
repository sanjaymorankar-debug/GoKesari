import Link from "next/link";
import { notFound } from "next/navigation";

import { ConsultBookingFlow } from "@/components/consult/booking-flow";
import { PinMap, Stars } from "@/components/consult/common";
import { CONSULT_MODE_LABELS, type ConsultMode } from "@/lib/consult/constants";
import { policySummary } from "@/lib/consult/policy";
import { WEEKDAY_SHORT } from "@/lib/consult/constants";
import { getCurrentUser } from "@/server/authz/guards";
import { consultEnabled, firmAccessOrNull } from "@/server/consult/access";
import { publicProfileBySlug } from "@/server/consult/discovery";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await publicProfileBySlug(slug).catch(() => null);
  return { title: p ? `${p.profile.displayName} — book an appointment` : "Consultant" };
}

/** A consultant's page and booking (docs/consult-booking-2026-11). Drafts are visible to their own firm and staff only. */
export default async function ConsultantPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ service?: string; member?: string }> }) {
  if (!(await consultEnabled())) notFound();
  const { slug } = await params;
  const sp = await searchParams;
  const user = await getCurrentUser();
  let p = await publicProfileBySlug(slug).catch(() => null);
  if (!p && user) {
    // The firm itself and staff may preview a profile that is not live yet.
    const draft = await publicProfileBySlug(slug, { allowDraft: true }).catch(() => null);
    if (draft && (await firmAccessOrNull(draft.shop.id, user))) p = draft;
  }
  if (!p) notFound();
  const [me] = user ? await db.select({ name: users.name, phone: users.phone, email: users.email }).from(users).where(eq(users.id, user.id)) : [];
  return (
    <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-4">
        <Link href="/consult" className="inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
          ← Find a Consultant
        </Link>
        <header className="flex items-start gap-3 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4">
          {p.profile.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.profile.photoUrl} alt="" className="h-20 w-20 rounded-2xl object-cover" />
          ) : (
            <span className="grid h-20 w-20 place-items-center rounded-2xl bg-kesari-100 text-4xl" aria-hidden>
              🩺
            </span>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-extrabold text-ink-900">
              {p.profile.displayName}{" "}
              {p.profile.verification === "VERIFIED" ? <span className="rounded-full bg-leaf-100 px-2 py-0.5 align-middle text-xs font-bold text-leaf-700">✔ Verified</span> : null}
            </h1>
            {p.profile.headline ? <p className="text-ink-700">{p.profile.headline}</p> : null}
            <p className="mt-1 text-sm text-ink-600">
              <Stars value={p.profile.ratingAvgX100 / 100} count={p.profile.ratingCount} /> · {p.shop.address}
            </p>
            {!p.bookable ? <p className="mt-1 text-sm font-bold text-amber-800">Preview — not published yet.</p> : null}
          </div>
        </header>
        <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4">
          <h2 className="mb-3 text-lg font-extrabold">Book an appointment</h2>
          <ConsultBookingFlow
            services={p.services.map((s) => ({ id: s.id, name: s.name, description: s.description, durationMinutes: s.durationMinutes, feeType: s.feeType, feePaise: s.feePaise, depositPaise: s.depositPaise, modes: s.modes, bookingKind: s.bookingKind, capacity: s.capacity, requiredMembers: s.requiredMembers, memberIds: s.memberIds, payOnline: s.payOnline, payAtVisit: s.payAtVisit }))}
            members={p.members.map((m) => ({ id: m.id, name: m.name, title: m.title }))}
            signedIn={Boolean(user)}
            bookable={p.bookable}
            policy={policySummary(p.profile)}
            me={me ?? null}
            preselect={{ serviceId: sp.service ?? null, memberId: sp.member ?? null }}
          />
        </section>
        {p.profile.about ? (
          <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4">
            <h2 className="mb-1 text-lg font-extrabold">About</h2>
            <p className="whitespace-pre-wrap text-sm text-ink-800">{p.profile.about}</p>
          </section>
        ) : null}
      </div>
      <aside className="flex flex-col gap-3">
        <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4">
          <h2 className="mb-2 text-base font-extrabold">{p.members.length > 1 ? "The team" : "Consultant"}</h2>
          <ul className="flex flex-col gap-3">
            {p.members.map((m) => (
              <li key={m.id} className="text-sm">
                <p className="font-bold" style={{ color: m.color }}>
                  {m.name} {m.docStatus === "VERIFIED" ? <span className="text-xs text-leaf-700">✔ registration checked</span> : null}
                </p>
                <p className="text-ink-700">{[m.title, m.qualifications, m.experienceYears != null ? `${m.experienceYears} years` : null].filter(Boolean).join(" · ")}</p>
                <p className="text-xs text-ink-600">
                  {m.categories.join(", ")}
                  {m.languages.length ? ` · 🗣 ${m.languages.join(", ")}` : ""}
                  {m.days.length ? ` · ${m.days.map((d) => WEEKDAY_SHORT[d]).join(" ")}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4 text-sm">
          <h2 className="mb-2 text-base font-extrabold">Ways to meet</h2>
          <p>{[...new Set(p.services.flatMap((s) => s.modes))].map((m) => CONSULT_MODE_LABELS[m as ConsultMode].en).join(" · ")}</p>
          {p.shop.latitude != null && p.shop.longitude != null ? (
            <div className="mt-2 flex flex-col gap-2">
              <PinMap latitude={p.shop.latitude} longitude={p.shop.longitude} label={p.profile.displayName} />
              <a href={`https://www.google.com/maps/dir/?api=1&destination=${p.shop.latitude},${p.shop.longitude}`} target="_blank" rel="noreferrer" className="font-bold text-kesari-800 underline">
                Directions
              </a>
            </div>
          ) : null}
        </section>
        <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4 text-sm">
          <h2 className="mb-2 text-base font-extrabold">Cancellation policy</h2>
          <ul className="list-disc pl-5 text-ink-700">
            {policySummary(p.profile).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {p.profile.policyNote ? <p className="mt-1 text-ink-700">{p.profile.policyNote}</p> : null}
        </section>
      </aside>
    </div>
  );
}
