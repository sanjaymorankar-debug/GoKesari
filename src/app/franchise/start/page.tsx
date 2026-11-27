import { and, eq, isNull, ne } from "drizzle-orm";
import { redirect } from "next/navigation";

import { FranchiseStart } from "@/components/franchise/franchise-start";
import { Alert, LinkButton, PageHeader } from "@/components/ui";
import { franchiseAgreementFor, rupees } from "@/lib/franchise";
import { planPriceLabel } from "@/lib/franchise-plans";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { KYC_DAYS_AFTER_PAYMENT, offerView, ownerStatusForUser, pendingPlanBookings } from "@/server/franchise/booking";
import { FranchiseActions } from "@/components/franchise/franchise-actions";
import { HoldCountdown } from "@/components/franchise/hold-countdown";
import { flow4On } from "@/server/flows/wave4";
import { franchiseConfig, oneTimeRates } from "@/server/franchise/config";
import { zoneFacets, zoneViews } from "@/server/franchise/zones";
import { FRANCHISE_START_PATH, SHOP_REGISTER_FOR_FRANCHISE, franchiseStartState, listPlans } from "@/server/onboarding-v2/franchise";
import { onboardingV2Enabled } from "@/server/onboarding-v2/roles";

export const metadata = { title: "Become a GoKesari franchisee" };
export const dynamic = "force-dynamic";

/**
 * Onboarding v2 — Flow 3 (docs/onboarding-v2-2026-11). Signed in, with a live registered shop (else shop
 * registration first, coming back here): choose free dealer (live at once, GKD code) or paid franchise (zones +
 * subscription plan + coupon, pay online, live at payment with a GKF code). Flag off: today's zone booking page.
 */
export default async function FranchiseStartPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const user = await getCurrentUser();
  const query = new URLSearchParams(Object.entries({ model: one(sp.model), zones: one(sp.zones) }).filter(([, v]) => v)).toString();
  const self = `${FRANCHISE_START_PATH}${query ? `?${query}` : ""}`;
  // Sign-in first, then the flag: a guest is always sent to sign-in (guest QA); flag off → the existing booking page.
  if (!user) redirect(`/signin?callbackUrl=${encodeURIComponent(self)}`);
  if (!(await onboardingV2Enabled())) redirect("/franchise/book");

  const state = await franchiseStartState(user.id);
  if (!state.shop) {
    // A registration still waiting to go live: say so rather than sending him round the registration again.
    const [waiting] = await db.select({ id: shops.id, name: shops.name, status: shops.status }).from(shops).where(and(eq(shops.ownerId, user.id), isNull(shops.deletedAt), ne(shops.status, "REJECTED"))).limit(1);
    if (!waiting) redirect(SHOP_REGISTER_FOR_FRANCHISE);
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6" data-testid="franchise-start-shop-waiting">
        <PageHeader title="Become a franchisee" description="A live GoKesari shop is needed first." />
        <Alert tone="info" title={`${waiting.name} is not live yet`}>
          Your shop registration is {waiting.status === "PENDING_APPROVAL" ? "waiting to go live" : waiting.status.toLowerCase().replace(/_/g, " ")}. Come back here once it is live — your shop&apos;s details are reused, nothing is asked twice.
        </Alert>
        <LinkButton href="/shop">My shop</LinkButton>
      </div>
    );
  }

  // QA D-169: an open (unpaid) booking is shown with Continue payment / Cancel, after lapsed ones are released.
  const pending = await pendingPlanBookings(user.id);
  // docs/flows-v3/wave4.md F21 (flag flow_f21): live countdown on a hold, "on hold" on zones another buyer is paying for.
  const holdLabels = await flow4On("flow_f21");
  const [zones, launchOffer, owner, { config }, allPlans] = await Promise.all([zoneViews(), offerView(), ownerStatusForUser(user.id, undefined, { v2: true }), franchiseConfig(), listPlans({ activeOnly: true })]);
  // A launch-offer plan is on sale only while the launch offer is open; any other plan whenever bookings are open.
  const plans = allPlans.filter((p) => !p.isLaunchOffer || launchOffer.launch.open);
  const open = config.bookingOpen && plans.length > 0;
  const offer = { ...launchOffer, bookingOpen: open, closedMessage: open ? null : !config.bookingOpen ? "Bookings open soon." : "No subscription plan is on offer right now – new terms coming soon." };
  const r = await oneTimeRates(config);
  const known = new Set(zones.map((z) => z.zoneId));
  const initialZones = one(sp.zones)
    .split(",")
    .map((z) => z.trim().toUpperCase())
    .filter((z) => known.has(z))
    .slice(0, 20);
  const model = one(sp.model);
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <PageHeader title="Become a franchisee" description={`Using your shop ${state.shop.name} and your verified account details. Free dealer: live at once. Paid franchise: own up to ${offer.maxOwnersPerZone === 1 ? "the only slot" : `one of ${offer.maxOwnersPerZone} slots`} in a zone, live as soon as you pay. All times IST.`} />
      {pending.length ? (
        <div className="mb-4 space-y-2 rounded-lg border border-kesari-200 bg-kesari-50 p-4" data-testid="franchise-pending-bookings">
          <h2 className="text-base font-bold text-ink-900">Your booking is waiting for payment</h2>
          {pending.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cream-200 bg-white p-2 text-sm" data-testid={`franchise-pending-${b.id}`}>
              <span>
                {b.zones.join(", ")} · {rupees(b.totalPaise)} · held until {b.heldUntilIst}
                {holdLabels ? (
                  <>
                    {" · "}
                    <HoldCountdown until={b.heldUntil} />
                  </>
                ) : null}
              </span>
              <FranchiseActions kind="pay" id={b.id} label={b.status === "PAYMENT_PENDING" ? "Continue payment" : "Pay now"} cancel />
            </div>
          ))}
          <p className="text-xs text-ink-600">Not paid by then, the zone is released and can be reserved again.</p>
        </div>
      ) : null}
      <FranchiseStart
        state={state}
        initialModel={model === "free" || model === "paid" ? model : initialZones.length ? "paid" : null}
        booking={{
          zones,
          facets: zoneFacets(zones),
          offer,
          dealerId: owner.dealer?.id ?? null,
          owner: { missing: owner.missing, kycMissing: owner.kycMissing, agreementAccepted: owner.agreementAccepted, hasDealer: !!owner.dealer, hasPan: !!owner.dealer?.panHash },
          agreement: franchiseAgreementFor(true),
          rates: { freeSelfBp: r.dealerSelfBp, freeOverrideBp: r.dealerOverrideBp, freeSecondBp: r.dealerSecondOverrideBp, ownerSelfBp: r.ownerSelfBp, ownerOverrideBp: r.ownerOverrideBp, ownerSecondBp: r.ownerSecondOverrideBp, recurringBp: config.recurringBaseBp },
          kycDays: KYC_DAYS_AFTER_PAYMENT,
          initialZones,
          holdLabels,
          plans: plans.map((p) => ({ id: p.id, name: p.name, description: p.description, label: planPriceLabel(p, rupees), durationMonths: p.durationMonths, isLaunchOffer: p.isLaunchOffer })),
        }}
      />
    </div>
  );
}
