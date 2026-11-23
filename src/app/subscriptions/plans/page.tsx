import Link from "next/link";
import { redirect } from "next/navigation";

import { PlanCard } from "@/components/plan-cards";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { PLAN_KINDS, PLAN_KIND_LABELS, PLAN_SLOTS, PLAN_SLOT_LABELS, type PlanKind, type PlanSlot } from "@/lib/subscription-plans";
import { getCurrentUser } from "@/server/authz/guards";
import { locationFromAddress } from "@/server/location";
import { listAddresses } from "@/server/services/addresses";
import { findPlansNear } from "@/server/services/subscription-plans";

export const metadata = { title: "Subscription plans near you" };
export const dynamic = "force-dynamic";

/**
 * Plans of the shops that deliver to the customer's address
 * (docs/subscription-plans-2026-11): meals and tiffin, newspapers, milk,
 * bakery, flowers, water… filtered by kind and slot.
 */
export default async function SubscriptionPlansPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; slot?: string; address?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/subscriptions/plans");
  const query = await searchParams;
  const kind = PLAN_KINDS.includes(query.kind as PlanKind) ? (query.kind as PlanKind) : undefined;
  const slot = PLAN_SLOTS.includes(query.slot as PlanSlot) ? (query.slot as PlanSlot) : undefined;
  const addresses = await listAddresses(user.id);
  const address = addresses.find((a) => a.id === query.address) ?? addresses[0] ?? null;
  const plans = address ? await findPlansNear(locationFromAddress(address), { kind, slot }) : [];

  const href = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const next = { kind, slot, address: address?.id, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    return `/subscriptions/plans?${p.toString()}`;
  };
  const chip = (on: boolean) =>
    `inline-flex min-h-9 items-center rounded-full border px-3 text-sm font-medium ${on ? "border-kesari-500 bg-kesari-50 text-kesari-700" : "border-cream-200 bg-white text-ink-600"}`;

  return (
    <>
      <PageHeader
        title="Subscription plans near you"
        description="Daily meals and tiffin, newspapers, milk, bread, flowers, water and more — from shops that deliver to you."
        action={<LinkButton href="/subscriptions" variant="secondary">My subscriptions</LinkButton>}
      />

      {addresses.length === 0 ? (
        <EmptyState
          title="Add a delivery address first"
          description="Plans are shown from shops that deliver to your address."
          action={<LinkButton href="/profile/addresses">Add an address</LinkButton>}
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ink-600">Deliver to:</span>
            {addresses.map((a) => (
              <Link key={a.id} href={href({ address: a.id })} className={chip(a.id === address?.id)} prefetch={false}>
                {a.label || a.area || a.line1}, {a.pincode}
              </Link>
            ))}
          </div>
          <nav className="mb-3 flex flex-wrap gap-2" aria-label="Kind of plan">
            <Link href={href({ kind: undefined })} className={chip(!kind)} prefetch={false}>
              All
            </Link>
            {PLAN_KINDS.map((k) => (
              <Link key={k} href={href({ kind: k })} className={chip(kind === k)} prefetch={false}>
                {PLAN_KIND_LABELS[k]}
              </Link>
            ))}
          </nav>
          <nav className="mb-6 flex flex-wrap gap-2" aria-label="Delivery slot">
            <Link href={href({ slot: undefined })} className={chip(!slot)} prefetch={false}>
              Any slot
            </Link>
            {PLAN_SLOTS.filter((s) => s !== "ANYTIME").map((s) => (
              <Link key={s} href={href({ slot: s })} className={chip(slot === s)} prefetch={false}>
                {PLAN_SLOT_LABELS[s].label}
              </Link>
            ))}
          </nav>

          {plans.length === 0 ? (
            <EmptyState
              title="No plans here yet"
              description="No shop that delivers to this address offers a plan of this kind yet. Try another kind or slot, or check again soon."
              testId="plans-empty"
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="plans-near">
              {plans.map((p) => (
                <PlanCard key={p.id} plan={p} showShop distanceKm={p.distanceKm} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
