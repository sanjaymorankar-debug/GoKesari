import Link from "next/link";
import { redirect } from "next/navigation";

import { PayCalculator } from "@/components/admin/rider-pay-plans/calculator";
import { CostTable } from "@/components/admin/rider-pay-plans/cost-table";
import { PlansSection } from "@/components/admin/rider-pay-plans/plans-section";
import { toPlanRow, toSurgeRow } from "@/components/admin/rider-pay-plans/serialize";
import { SurgePanel } from "@/components/admin/rider-pay-plans/surge-panel";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listPlans, listSurges, listZonesForPicker, orderCostView } from "@/server/services/rider-pay-plans";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Rider pay plans" };
export const dynamic = "force-dynamic";

/** Rider App v2 (docs/rider-app-v2-2026-11): versioned per-km pay plans, simulator, publish, surges, calculator, cost view. */
export default async function RiderPayPlansPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE)) redirect("/");

  const [rule, plans, surges, zones, cost] = await Promise.all([
    getRule("riderPayPlans"),
    listPlans(),
    listSurges(),
    listZonesForPicker(),
    orderCostView(50),
  ]);
  const planRows = plans.map((p) => toPlanRow(p, { inForce: p.inForce, words: p.words, label: p.label }));

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader
        title="Rider pay plans"
        description="What a rider earns per delivery: base fee, km slabs, ride to the shop, waiting, extra drops, bonus, minimum and cap. Each change is a new version, tested on past orders and published with a note."
        action={
          <Link className="text-sm font-medium text-kesari-600 hover:underline" href="/admin/rider-earnings">
            Slots and incentives →
          </Link>
        }
      />

      <Alert tone={rule.enabled ? "success" : "warning"} title={`Rule riderPayPlans is ${rule.enabled ? "ON" : "OFF"}`}>
        {rule.enabled
          ? "New offers are priced from the plan in force for the shop's zone, city or the default plan, and riders see the quote before accepting."
          : "Riders are still paid the flat base + per-km rate with slots and incentives. You can prepare, simulate and publish plans now; they price offers once the rule is on."}{" "}
        Rules are switched in{" "}
        <Link className="font-medium underline" href="/admin/settings">
          Admin → Settings
        </Link>
        .
      </Alert>

      <PlansSection plans={planRows} zones={zones} />
      <SurgePanel surges={surges.map(toSurgeRow)} zones={zones} nowIso={new Date().toISOString()} />
      <PayCalculator plans={planRows} zones={zones} />
      <CostTable rows={cost} />

      <p className="text-sm text-ink-500">
        Time slots (peak surge ×, slot booking) and incentives are set in{" "}
        <Link className="font-medium text-kesari-600 hover:underline" href="/admin/rider-earnings">
          Rider earnings rules
        </Link>
        .
      </p>
    </div>
  );
}
