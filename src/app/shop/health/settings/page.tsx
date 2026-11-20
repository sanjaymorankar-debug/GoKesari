import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/ui";
import { Panel } from "@/components/consult/common";
import { ComingSoon } from "@/components/health/page-shell";
import { ClinicSettingsForm, DoctorProfileForm, LetterheadSettings } from "@/components/health/doctor";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { clinicContext } from "@/server/health/doctor-pages";
import { clinicSettings } from "@/server/health/doctors";
import { effectiveLetterhead, letterheadView } from "@/server/health/letterheads";

export const metadata = { title: "Doctor & print settings" };
export const dynamic = "force-dynamic";

/** Doctor registration details, signature / stamp, clinic token settings, letterhead and printing per clinic. */
export default async function DoctorSettingsPage({ searchParams }: { searchParams: Promise<{ shop?: string; member?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/health/settings");
  if (!(await healthEnabled())) return <ComingSoon title="Doctor & print settings" />;
  const sp = await searchParams;
  const ctx = await clinicContext(user);
  if (!ctx.shops.length) redirect("/shop/health");
  const shopId = ctx.shops.find((s) => s.id === sp.shop)?.id ?? ctx.shops[0].id;
  const seats = ctx.seats.filter((s) => s.shopId === shopId);
  const memberId = seats.find((s) => s.memberId === sp.member)?.memberId ?? null;
  const lh = letterheadView(await effectiveLetterhead(shopId, memberId));
  const settings = await clinicSettings(shopId);
  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/shop/health" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Today
      </Link>
      <PageHeader title="Doctor & print settings" description={ctx.shops.find((s) => s.id === shopId)?.name} />
      {ctx.shops.length > 1 ? (
        <nav className="mb-3 flex flex-wrap gap-2">
          {ctx.shops.map((s) => (
            <Link key={s.id} href={`/shop/health/settings?shop=${s.id}`} className="min-h-11 rounded-full border-2 border-[var(--gk-line)] px-3 py-2 text-sm font-bold">
              {s.name}
            </Link>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-col gap-4">
        {seats.length ? (
          seats.map((s) => (
            <Panel key={s.memberId} title={`Doctor: ${s.name}`}>
              <DoctorProfileForm seat={JSON.parse(JSON.stringify(s))} />
            </Panel>
          ))
        ) : (
          <Panel title="Doctors">
            <p className="text-sm text-ink-700">
              No doctor in this clinic yet. In{" "}
              <Link className="font-bold underline" href="/shop/consult/setup">
                Appointments → Setup → Team
              </Link>{" "}
              put the doctor in a doctor category (e.g. General Physician) and upload the council certificate.
            </p>
          </Panel>
        )}
        <Panel title="Clinic">
          <ClinicSettingsForm shopId={shopId} initial={{ tokenMode: settings.tokenMode, tokenDailyLimit: settings.tokenDailyLimit, followUpDays: settings.followUpDays, followUpFeePaise: settings.followUpFeePaise, hfrId: settings.hfrId }} />
        </Panel>
        <Panel
          title={`Letterhead and printing — ${memberId ? seats.find((s) => s.memberId === memberId)?.name : "whole clinic"}`}
          action={
            seats.length ? (
              <span className="flex flex-wrap gap-1 text-xs">
                <Link className="font-bold underline" href={`/shop/health/settings?shop=${shopId}`}>
                  Clinic
                </Link>
                {seats.map((s) => (
                  <Link key={s.memberId} className="font-bold underline" href={`/shop/health/settings?shop=${shopId}&member=${s.memberId}`}>
                    {s.name}
                  </Link>
                ))}
              </span>
            ) : undefined
          }
        >
          <LetterheadSettings key={`${shopId}:${memberId}`} shopId={shopId} memberId={memberId} initial={JSON.parse(JSON.stringify(lh))} />
        </Panel>
      </div>
    </div>
  );
}
