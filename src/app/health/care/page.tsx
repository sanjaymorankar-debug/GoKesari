import Link from "next/link";

import { CareSearch } from "@/components/health/care";
import { ComingSoon } from "@/components/health/page-shell";
import { PageHeader } from "@/components/ui";
import { healthEnabled } from "@/server/health/access";
import { careCategories } from "@/server/health/care";

export const metadata = { title: "Home care" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * GoKesari Health → Home care (owner brief §2.6): nurse, physiotherapist, massage therapist, caretaker /
 * attendant, baby care / japa, home sample collection — nearby verified providers only. Also the target of
 * "Book now" on a doctor's suggestion (?category=&suggestion=), and of the My Health tile (?patient=).
 */
export default async function CareSearchPage({ searchParams }: { searchParams: Promise<{ category?: string; patient?: string; suggestion?: string }> }) {
  if (!(await healthEnabled())) return <ComingSoon title="Home care" />;
  const sp = await searchParams;
  const cats = await careCategories();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Home care"
        description="Verified nurses, physiotherapists, attendants and more — at home or at their centre. Every provider shows a photo ID card; you give a code at check-in and check-out."
        action={
          <Link href="/health/care/visits" className="inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] bg-white px-4 text-sm font-bold" data-testid="care-my-visits">
            My home-care visits
          </Link>
        }
      />
      <CareSearch
        categories={cats.map((c) => ({ slug: c.slug, name: c.name }))}
        initial={{
          category: cats.some((c) => c.slug === sp.category) ? sp.category : undefined,
          patientId: sp.patient && UUID.test(sp.patient) ? sp.patient : undefined,
          suggestionId: sp.suggestion && UUID.test(sp.suggestion) ? sp.suggestion : undefined,
        }}
      />
    </div>
  );
}
