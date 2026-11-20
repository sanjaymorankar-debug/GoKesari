/**
 * GoKesari Health home strip: Prime Plus "featured" doctors (labelled), nearest first when the patient's
 * location is known. A server component — drop <FeaturedDoctorsStrip /> into any Health page.
 */
import Link from "next/link";

import { featuredDoctors } from "@/server/health/find-doctor";
import { DoctorCardView } from "./doctor-card";

export async function FeaturedDoctorsStrip({ lat, lng, query = "", limit = 6 }: { lat?: number | null; lng?: number | null; query?: string; limit?: number }) {
  const cards = await featuredDoctors({ lat, lng, limit }).catch(() => []);
  if (!cards.length) return null;
  return (
    <section className="mb-4" data-testid="health-featured-doctors" aria-label="Featured doctors">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-extrabold text-ink-900">Featured doctors</h2>
        <Link href={`/health/doctors${query ? `?${query}` : ""}`} className="text-sm font-bold text-kesari-800 underline">
          All doctors
        </Link>
      </div>
      <p className="mb-2 text-xs text-ink-600">★ Prime Plus listings (paid placement). Every verified doctor is in the full list.</p>
      <div className="flex snap-x gap-3 overflow-x-auto pb-2">
        {cards.map((c) => (
          <div key={c.memberId} className="w-80 shrink-0 snap-start">
            <DoctorCardView card={c} query={query} />
          </div>
        ))}
      </div>
    </section>
  );
}
