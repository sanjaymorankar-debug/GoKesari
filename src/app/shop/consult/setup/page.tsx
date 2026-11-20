import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConsultSetup } from "@/components/consult/setup";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { consultEnabled } from "@/server/consult/access";
import { firmForPage } from "@/server/consult/pages";
import { ensureProfile } from "@/server/consult/setup";

export const metadata = { title: "Appointments setup" };
export const dynamic = "force-dynamic";

/**
 * Booking setup (docs/consult-booking-2026-11): profile, policy, team, services, hours and leave. The owner,
 * consult staff, or the operator who onboarded the shop (?shopId=).
 */
export default async function ShopConsultSetupPage({ searchParams }: { searchParams: Promise<{ shopId?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/consult/setup");
  if (!(await consultEnabled())) notFound();
  const sp = await searchParams;
  const firm = await firmForPage(user, sp.shopId);
  if (!firm) redirect("/shop/consult");
  if (!firm.access.canSetup) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Appointments setup" />
        <Alert tone="info">Only the firm&apos;s owner changes the setup. Ask the owner to change your hours or add your leave.</Alert>
      </div>
    );
  }
  await ensureProfile(firm.shopId, user);
  return (
    <div className="mx-auto max-w-5xl">
      <Link href={`/shop/consult?shopId=${firm.shopId}`} className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Appointments
      </Link>
      <PageHeader title="Appointments setup" description={`${firm.shopName} — what customers see, who takes bookings, when, and for how much.`} />
      <ConsultSetup shopId={firm.shopId} />
    </div>
  );
}
