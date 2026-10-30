import Link from "next/link";
import { redirect } from "next/navigation";

import { OnboardingWizard, type WizardState } from "@/components/registration/onboarding-wizard";
import { ShopRegisterForm } from "@/components/shop-register-form";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { isReferralRequired } from "@/server/services/referral-settings";
import { baseRegistrationFee, registrationFeeGstRateBp } from "@/server/services/registration-fee-coupons";
import { listShopCategories } from "@/server/services/shop-categories";
import { listShopsForOwner } from "@/server/services/shops";
import { getRule } from "@/server/services/settings";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getWizardDraft, showsWizard } from "@/server/services/shop-registration-wizard";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { ShopSignInCard } from "./sign-in-card";

export const metadata = { title: "Register your shop" };
export const dynamic = "force-dynamic";

export default async function RegisterShopPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string | string[]; code?: string | string[]; wizard?: string | string[]; form?: string | string[] }>;
}) {
  const params = await searchParams;
  // docs/dealer-programme: a dealer's share link (/shop/register?ref=CODE) fills in the referral code;
  // ?code= is a distributor's link, carried over from /shop/join.
  const rawRef = params.ref ?? params.code;
  const ref = typeof rawRef === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(rawRef.trim()) ? rawRef.trim().toUpperCase() : null;
  const user = await getCurrentUser();
  if (!user) {
    // 0120 (FLOW_2026-10-30.md): with the wizard on, the owner signs in here — the code comes by email.
    if (await isFeatureEnabled("shop_onboarding_wizard_enabled")) {
      return (
        <div className="mx-auto max-w-2xl">
          <PageHeader title="Register your shop" description="Sign in, enter your referral code, verify your documents (or add them later), pay the fee and your shop goes live." />
          <ShopSignInCard />
        </div>
      );
    }
    redirect(ref ? `/signin?callbackUrl=${encodeURIComponent(`/shop/register?ref=${ref}`)}` : "/signin");
  }

  // Every read at once: each one is a round trip to the database, and they
  // used to run one after another on every visit.
  const [ownShops, referralRequired, selfRegistration, feeRule, baseFee, gstRateBp, categories, dealerProgramme] = await Promise.all([
    // Only the signed-in owner's own shops — nothing about anyone else's.
    listShopsForOwner(user.id),
    // docs/nearby-referral-2026-10: the admin's setting referral_required_shop, read live.
    isReferralRequired("shop"),
    // Module 3: with a referral code a shop can register and pay online, approved on payment.
    getRule("selfRegistration"),
    // The one-time registration fee, shown on the form before Submit: the base
    // fee (by turnover when that rule is on, otherwise the flat fee) plus GST.
    getRule("registrationFeeByTurnover"),
    baseRegistrationFee(null),
    // No GST rate in force: the form shows no breakdown and Submit reports it.
    registrationFeeGstRateBp().catch(() => null),
    // The category picker's list, so the form does not fetch it after loading.
    listShopCategories({ activeOnly: true, withShopCounts: false }).catch(() => undefined),
    // docs/dealer-programme: the optional Employee ID / name field exists only while the programme is on.
    isFeatureEnabled("dealer_programme_enabled"),
  ]);
  // docs/shop-onboarding-wizard-2026-10: the step-by-step wizard when its flag is on; while it is off only
  // an admin gets it, with ?wizard=1 (testing on staging). ?form=1 keeps the long form reachable for operators.
  if (await showsWizard(user, params)) {
    const draft = await getWizardDraft(user);
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Register your shop" description="A few quick steps. We check your documents with the government records as you go — or you add them after your shop is live." />
        {draft === null || draft.status === "OPEN" ? (
          <p className="mb-3 rounded-lg border border-leaf-300 bg-leaf-50 px-3 py-2 text-sm text-leaf-700" data-testid="registering-as">
            ✓ Signed in{user.email && !isPlaceholderEmail(user.email) ? ` as ${user.email}` : ""} — your shop is added to this account.
          </p>
        ) : null}
        <OnboardingWizard
          initialReferralCode={ref}
          referralRequired={referralRequired}
          initial={draft ? (JSON.parse(JSON.stringify(draft)) as WizardState) : null}
          initialCategories={categories?.map((c) => ({ id: c.id, name: c.name, status: c.status, groupName: c.groupName }))}
          dealerProgramme={dealerProgramme}
        />
      </div>
    );
  }

  const pending = ownShops.filter((s) => s.status === "PENDING_APPROVAL");
  const rejected = ownShops.find((s) => s.status === "REJECTED");
  const selfService = selfRegistration.enabled;
  const waiting = pending[0];

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Add my shop"
        description="Tell us about your shop, clinic or office. An operator reviews every registration."
      />
      {pending.length > 0 ? (
        <div className="mb-4">
          <Alert
            tone="warning"
            title={`Already waiting for approval: ${pending.map((s) => s.name).join(", ")}`}
          >
            You&apos;ll be notified once it&apos;s reviewed, and you don&apos;t need to submit it
            again. You can add another shop after that.
          </Alert>
        </div>
      ) : rejected ? (
        <div className="mb-4">
          <Alert tone="info" title={`Resubmitting ${rejected.name}?`}>
            Correct the details below and submit with the same Shop Act, PAN or Udyam number, or
            the same shop name and PIN code. We&apos;ll update your earlier registration and send
            it for review again instead of creating a new one.
          </Alert>
        </div>
      ) : null}
      {selfService ? (
        <div className="mb-4">
          <Alert tone="success" title="Have a referral code from a GoKesari distributor?">
            <Link href="/shop/join" className="underline">Register with the code and pay the fee online</Link> — your shop goes live as soon as the payment is confirmed.
          </Alert>
        </div>
      ) : null}
      <div className="mb-4">
        <Alert tone="info">
          Your shop starts as <strong>pending approval</strong>. Kesari/Green
          classification is assigned by an operator at approval — it cannot be
          chosen here.
        </Alert>
      </div>
      <ShopRegisterForm
        referralRequired={referralRequired}
        initialReferralCode={ref}
        showEmployeeField={dealerProgramme}
        feeRule={feeRule}
        feeQuote={gstRateBp === null ? null : { basePaise: baseFee.basePaise, gstRateBp }}
        pending={
          waiting
            ? {
                id: waiting.id,
                name: waiting.name,
                feeDue:
                  waiting.feePaymentStatus !== "PAID" &&
                  (waiting.registrationFeePaise ?? 0) > waiting.amountPaidPaise,
              }
            : null
        }
        initialCategories={categories?.map((c) => ({ id: c.id, name: c.name, status: c.status, groupName: c.groupName }))}
      />
    </div>
  );
}
