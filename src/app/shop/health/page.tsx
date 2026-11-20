import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/ui";
import { ComingSoon } from "@/components/health/page-shell";
import { TodayBoard } from "@/components/health/doctor";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { clinicContext } from "@/server/health/doctor-pages";

export const metadata = { title: "Clinic — Today" };
export const dynamic = "force-dynamic";

/** Doctor dashboard / clinic reception: who is coming and when, live; queue, check-in, walk-ins, consult. */
export default async function ClinicTodayPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/health");
  if (!(await healthEnabled())) return <ComingSoon title="Clinic — Today" />;
  const sp = await searchParams;
  const ctx = await clinicContext(user);
  if (!ctx.shops.length) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Clinic — Today" />
        <p className="text-sm text-ink-700">
          Set up your practice first: register your clinic as a shop (type Doctor / Clinic), then open{" "}
          <Link className="font-bold text-kesari-800 underline" href="/shop/consult/setup">
            Appointments → Setup
          </Link>{" "}
          to add your team, services and hours.
        </p>
      </div>
    );
  }
  const shopId = ctx.shops.find((s) => s.id === sp.shop)?.id ?? ctx.shops[0].id;
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Clinic — Today"
        description="Appointments, check-in, queue and consultations. Updates arrive live. Times in IST."
        action={
          <span className="flex flex-wrap gap-2">
            <Link className="inline-flex min-h-11 items-center rounded-xl border-2 border-[var(--gk-line)] bg-white px-3 text-sm font-extrabold" href="/shop/consult">
              Calendar
            </Link>
            <Link className="inline-flex min-h-11 items-center rounded-xl border-2 border-[var(--gk-line)] bg-white px-3 text-sm font-extrabold" href="/shop/health/settings">
              Doctor &amp; print settings
            </Link>
          </span>
        }
      />
      <TodayBoard seats={ctx.seats} shops={ctx.shops} initialShopId={shopId} canConsult={ctx.canConsult} />
    </div>
  );
}
