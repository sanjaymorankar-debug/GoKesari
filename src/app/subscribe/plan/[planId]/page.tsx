import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { perUnitLabel } from "@/components/plan-cards";
import { PlanSubscribeForm } from "@/components/plan-subscribe-form";
import { Badge, Money, PageHeader } from "@/components/ui";
import { addDays, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { PLAN_KIND_LABELS, serviceDaysLabel, slotLabel } from "@/lib/subscription-plans";
import { getCurrentUser } from "@/server/authz/guards";
import { listAddresses } from "@/server/services/addresses";
import { getPublicPlan } from "@/server/services/subscription-plans";
import { getWalletByUserId } from "@/server/services/wallet";

export const metadata = { title: "Subscribe to a plan" };
export const dynamic = "force-dynamic";

/** Taking one shop's subscription plan (docs/subscription-plans-2026-11). */
export default async function PlanSubscribePage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?next=/subscribe/plan/${planId}`);
  if (!/^[0-9a-f-]{36}$/i.test(planId)) notFound();
  const plan = await getPublicPlan(planId);
  if (!plan) notFound();

  const [wallet, addresses] = await Promise.all([getWalletByUserId(user.id), listAddresses(user.id)]);
  const earliestStart = addDays(todayIn(getEnv().APP_TIMEZONE), plan.leadDays);

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader
        title={plan.name}
        description={
          <>
            From{" "}
            <Link href={`/shops/${plan.shop.slug}`} className="font-medium text-kesari-700 hover:underline">
              {plan.shop.name}
            </Link>{" "}
            · <Money paise={plan.pricePaise} /> {perUnitLabel(plan)}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-1.5">
        <Badge tone="info">{PLAN_KIND_LABELS[plan.kind]}</Badge>
        <Badge>{slotLabel(plan.slot, plan.slotWindow)}</Badge>
        <Badge>{serviceDaysLabel(plan.serviceDays)}</Badge>
      </div>
      {plan.description ? <p className="mb-4 text-sm text-ink-700">{plan.description}</p> : null}
      <PlanSubscribeForm
        plan={plan}
        walletBalancePaise={wallet?.balancePaise ?? 0}
        earliestStart={earliestStart}
        addresses={addresses.map((a) => ({
          id: a.id,
          label: a.label,
          line1: a.line1,
          area: a.area,
          city: a.city,
          pincode: a.pincode,
          isDefault: a.isDefault,
        }))}
      />
    </div>
  );
}
