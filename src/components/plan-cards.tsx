import { Badge, Card, LinkButton, Money } from "@/components/ui";
import { PLAN_KIND_LABELS, serviceDaysLabel, slotLabel } from "@/lib/subscription-plans";
import type { PublicPlan } from "@/server/services/subscription-plans";

/** "per piece", "per copy", "per L". */
export function perUnitLabel(plan: Pick<PublicPlan, "unit" | "isPeriodical">): string {
  if (plan.isPeriodical) return "per copy";
  return `per ${plan.unit === "piece" ? "piece" : plan.unit}`;
}

function termsLabel(termDays: number[]): string {
  if (termDays.length === 0) return "Open-ended — stop any time";
  if (termDays.length === 1) return `${termDays[0]}-day plan`;
  return `${termDays.slice(0, -1).join(", ")} or ${termDays[termDays.length - 1]} days`;
}

/**
 * One subscription plan as a customer sees it (docs/subscription-plans-2026-11):
 * what, when, how much, and a Subscribe button. Server-safe (no state).
 */
export function PlanCard({
  plan,
  showShop = false,
  distanceKm = null,
}: {
  plan: PublicPlan;
  showShop?: boolean;
  distanceKm?: number | null;
}) {
  return (
    <Card className="flex h-full flex-col gap-3 p-4" data-testid="plan-card">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="info">{PLAN_KIND_LABELS[plan.kind]}</Badge>
        <Badge>{slotLabel(plan.slot, plan.slotWindow)}</Badge>
      </div>
      <div>
        <h3 className="text-base font-semibold text-ink-900">{plan.name}</h3>
        {showShop ? (
          <p className="text-sm text-ink-600">
            {plan.shop.name}
            {distanceKm != null ? ` · ${distanceKm} km away` : ""}
          </p>
        ) : null}
        {plan.description ? <p className="mt-1 text-sm text-ink-600">{plan.description}</p> : null}
      </div>
      <dl className="space-y-0.5 text-sm text-ink-700">
        <div className="flex justify-between gap-2">
          <dt className="text-ink-500">Price</dt>
          <dd className="font-semibold text-ink-900">
            <Money paise={plan.pricePaise} /> <span className="font-normal text-ink-500">{perUnitLabel(plan)}</span>
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-500">Delivered</dt>
          <dd>{serviceDaysLabel(plan.serviceDays)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-500">Length</dt>
          <dd>{termsLabel(plan.termDays)}</dd>
        </div>
      </dl>
      <div className="mt-auto">
        <LinkButton href={`/subscribe/plan/${plan.id}`} className="w-full">
          Subscribe
        </LinkButton>
      </div>
    </Card>
  );
}
