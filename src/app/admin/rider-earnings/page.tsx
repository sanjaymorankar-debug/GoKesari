import { redirect } from "next/navigation";

import { DeliveryEarningsConfigManager } from "@/components/delivery-earnings-config-manager";
import { RiderEarningsRulesManager } from "@/components/rider-earnings-rules-manager";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getActiveEarningsConfig } from "@/server/services/delivery-earnings";
import { listIncentives, listSlots } from "@/server/services/rider-earnings-config";

export const metadata = { title: "Rider earnings rules" };
export const dynamic = "force-dynamic";

/** Default rate, time slots and incentive rules that decide what a delivery earns. */
export default async function RiderEarningsRulesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE)) redirect("/");

  const [config, slots, incentives] = await Promise.all([getActiveEarningsConfig(), listSlots(), listIncentives()]);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <PageHeader
        title="Rider earnings rules"
        description="What a delivery earns: the default rate, time slots with their own rates, and incentives. Changes apply to deliveries completed from now on."
      />
      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">Default rate</h2>
        <DeliveryEarningsConfigManager
          active={{ baseFeePaise: config.baseFeePaise, perKmFeePaise: config.perKmFeePaise, note: config.note }}
        />
      </section>
      <RiderEarningsRulesManager
        slots={slots.map((s) => ({
          id: s.id,
          name: s.name,
          startTime: s.startTime,
          endTime: s.endTime,
          daysOfWeek: s.daysOfWeek,
          baseFeePaise: s.baseFeePaise,
          perKmFeePaise: s.perKmFeePaise,
          minEarningPaise: s.minEarningPaise,
          orderFeePaise: s.orderFeePaise,
          orderPercentBp: s.orderPercentBp,
          peakBonusPaise: s.peakBonusPaise,
          isPeak: s.isPeak,
          priority: s.priority,
          isActive: s.isActive,
        }))}
        incentives={incentives.map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          type: i.type,
          thresholdValue: i.thresholdValue,
          rewardPaise: i.rewardPaise,
          period: i.period,
          startTime: i.startTime,
          endTime: i.endTime,
          validFrom: i.validFrom,
          validTo: i.validTo,
          isActive: i.isActive,
        }))}
      />
    </div>
  );
}
