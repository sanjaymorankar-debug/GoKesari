import Link from "next/link";

import { DoctorFinder, type FinderFilters } from "@/components/health/find-doctor";
import { FeaturedDoctorsStrip } from "@/components/health/featured-doctors";
import { ComingSoon } from "@/components/health/page-shell";
import { PageHeader } from "@/components/ui";
import { isDateKey } from "@/lib/consult/time";
import { getCurrentUser } from "@/server/authz/guards";
import { consultEnabled } from "@/server/consult/access";
import { healthEnabled } from "@/server/health/access";
import { doctorCategories, searchDoctors } from "@/server/health/find-doctor";
import { getCustomerLocation } from "@/server/location";

export const metadata = { title: "Find a doctor" };
export const dynamic = "force-dynamic";

type Search = { q?: string; specialty?: string; group?: string; symptom?: string; area?: string; mode?: string; available?: string; prime?: string; patient?: string; suggestion?: string; date?: string };

/**
 * GoKesari Health "Find a doctor" (owner brief §2.2): verified doctors only, nearest first when the
 * location is known, Prime listings labelled. Links from a prescription's "Book now" carry
 * ?specialty=…&suggestion=… through to the booking.
 */
export default async function FindDoctorPage({ searchParams }: { searchParams: Promise<Search> }) {
  if (!(await healthEnabled()) || !(await consultEnabled())) return <ComingSoon title="Find a doctor" />;
  const sp = await searchParams;
  const user = await getCurrentUser();
  const location = await getCustomerLocation(user?.id).catch(() => null);
  const origin = location?.latitude != null && location?.longitude != null ? { latitude: location.latitude, longitude: location.longitude, label: location.label ?? null } : null;
  const carry = new URLSearchParams();
  if (sp.patient && /^[0-9a-f-]{36}$/i.test(sp.patient)) carry.set("patient", sp.patient);
  if (sp.suggestion && /^[0-9a-f-]{36}$/i.test(sp.suggestion)) carry.set("suggestion", sp.suggestion);
  if (sp.date && isDateKey(sp.date)) carry.set("date", sp.date);
  const filters: FinderFilters = {
    q: sp.q || undefined,
    specialty: sp.specialty || undefined,
    group: sp.group && /^[a-z-]{1,40}$/.test(sp.group) ? sp.group : undefined,
    symptom: sp.symptom || undefined,
    area: sp.area || undefined,
    mode: sp.mode === "VIDEO" || sp.mode === "IN_PERSON" ? sp.mode : "",
    available: sp.available === "today" || sp.available === "week" ? sp.available : "",
    prime: sp.prime === "1",
  };
  const query = { ...filters, mode: filters.mode || undefined, available: filters.available || undefined, prime: filters.prime ? "1" : undefined };
  const [categories, nearby] = await Promise.all([doctorCategories(), searchDoctors({ ...query, ...(origin ? { lat: origin.latitude, lng: origin.longitude } : {}) }).catch(() => ({ results: [] }))]);
  // Nobody within the radius of the saved location: show the rest rather than an empty page.
  const initial = nearby.results.length || !origin ? nearby.results : (await searchDoctors(query).catch(() => ({ results: [] }))).results;
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Find a doctor"
        description="Verified doctors near you — book a clinic visit or a video consultation, for yourself or your family."
        action={
          user ? (
            <Link href="/health/appointments" className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 bg-white px-4 text-sm font-bold text-ink-800">
              My appointments
            </Link>
          ) : null
        }
      />
      {!filters.q && !filters.specialty && !filters.group && !filters.symptom ? <FeaturedDoctorsStrip lat={origin?.latitude} lng={origin?.longitude} query={carry.toString()} /> : null}
      <DoctorFinder categories={categories} initial={initial} origin={nearby.results.length ? origin : null} initialFilters={filters} carry={carry.toString()} />
    </div>
  );
}
