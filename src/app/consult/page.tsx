import Link from "next/link";

import { ConsultFinder } from "@/components/consult/finder";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { consultEnabled } from "@/server/consult/access";
import { listActiveCategories, searchConsultants } from "@/server/consult/discovery";
import { getCustomerLocation } from "@/server/location";

export const metadata = { title: "Find a Consultant" };
export const dynamic = "force-dynamic";

/**
 * Find a Consultant (docs/consult-booking-2026-11): doctors, advocates, CAs, IT consultants, salons and
 * home-service experts near the customer, with free times. Off (rule consultBooking) → a "coming soon" note.
 */
export default async function FindConsultantPage({ searchParams }: { searchParams: Promise<{ category?: string; q?: string }> }) {
  const user = await getCurrentUser();
  if (!(await consultEnabled())) {
    // The menus link here before launch: a plain note, not a 404.
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Find a Consultant" />
        <Alert tone="info" title="Coming soon">
          Booking doctors, lawyers, CAs and other professionals on GoKesari opens soon.{" "}
          {user ? (
            <Link href="/consult/bookings" className="font-bold underline">
              My appointments
            </Link>
          ) : null}
        </Alert>
      </div>
    );
  }
  const params = await searchParams;
  const location = await getCustomerLocation(user?.id).catch(() => null);
  const origin = location?.latitude != null && location?.longitude != null ? { latitude: location.latitude, longitude: location.longitude, label: location.label } : null;
  const [categories, initial] = await Promise.all([
    listActiveCategories(),
    searchConsultants({ category: params.category, q: params.q, ...(origin ? { lat: origin.latitude, lng: origin.longitude } : {}) }).catch(() => ({ results: [] })),
  ]);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Find a Consultant"
        description="Book doctors, lawyers, CAs, IT experts, tutors, salons and home-service experts near you — in person, by video, by phone or at home."
        action={
          user ? (
            <Link href="/consult/bookings" className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 bg-white px-4 text-sm font-bold text-ink-800">
              My appointments
            </Link>
          ) : null
        }
      />
      <ConsultFinder
        categories={categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug, groupName: c.groupName }))}
        initial={initial.results}
        origin={origin}
        initialFilters={{ category: params.category, q: params.q }}
      />
    </div>
  );
}
