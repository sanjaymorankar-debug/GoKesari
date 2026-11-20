import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConsultCalendar } from "@/components/consult/calendar";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { consultEnabled } from "@/server/consult/access";
import { firmForPage } from "@/server/consult/pages";
import { profileForShop } from "@/server/consult/setup";

export const metadata = { title: "Appointments" };
export const dynamic = "force-dynamic";

/**
 * The consultant's appointments (docs/consult-booking-2026-11): dashboard, day / week / month calendar with
 * the team side by side, and every booking action. Owners, team members and consult staff (?shopId=).
 */
export default async function ShopConsultPage({ searchParams }: { searchParams: Promise<{ shopId?: string; booking?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/consult");
  if (!(await consultEnabled())) notFound();
  const sp = await searchParams;
  const firm = await firmForPage(user, sp.shopId);
  if (!firm) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Appointments" />
        <Alert tone="info">
          Appointments are for registered consultants and professional firms. <Link href="/shop/register" className="font-bold underline">Register your practice</Link> (choose “Consultant / Professional Firm”), then set up your booking profile here.
        </Alert>
      </div>
    );
  }
  const profile = await profileForShop(firm.shopId);
  if (!profile || (profile.status === "DRAFT" && firm.access.canSetup)) redirect(`/shop/consult/setup?shopId=${firm.shopId}`);
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Appointments"
        description={`${profile.displayName} · times in IST`}
        action={
          <div className="flex flex-wrap gap-2">
            <Link href={`/consult/${encodeURIComponent(firm.shopSlug)}`} className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 bg-white px-4 text-sm font-bold text-ink-800">
              My public page
            </Link>
            {firm.access.canSetup ? (
              <Link href={`/shop/consult/setup?shopId=${firm.shopId}`} className="inline-flex min-h-11 items-center rounded-lg bg-kesari-600 px-4 text-sm font-bold text-white">
                Setup
              </Link>
            ) : null}
          </div>
        }
      />
      {profile.status !== "LIVE" ? (
        <div className="mb-3">
          <Alert tone="warning">Your profile is {profile.status.toLowerCase()}: customers cannot book you. Publish it from Setup.</Alert>
        </div>
      ) : null}
      <ConsultCalendar shopId={firm.shopId} initialBooking={sp.booking ?? null} />
    </div>
  );
}
