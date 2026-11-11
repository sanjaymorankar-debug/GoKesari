import { redirect } from "next/navigation";

import { OnboardingWizard, type WizardState } from "@/components/registration/onboarding-wizard";
import { Alert, LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { isReferralRequired } from "@/server/services/referral-settings";
import { listShopCategories } from "@/server/services/shop-categories";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { refreshLatestRegistrationFeeAttempt } from "@/server/services/registration-fee-payment";
import { waitingRegistration, waitingRegistrationMessage } from "@/server/services/shop-registration-draft";
import { getWizardDraft } from "@/server/services/shop-registration-wizard";
import { getBoardLang } from "@/server/board-lang";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { ShopSignInCard } from "./sign-in-card";

export const metadata = { title: "Register your shop" };
export const dynamic = "force-dynamic";

export default async function RegisterShopPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string | string[]; code?: string | string[]; new?: string | string[]; form?: string | string[]; wizard?: string | string[] }>;
}) {
  const params = await searchParams;
  // docs/dealer-programme: a dealer's share link (/shop/register?ref=CODE) fills in the referral code;
  // ?code= is a distributor's link, carried over from /shop/join.
  const rawRef = params.ref ?? params.code;
  const ref = typeof rawRef === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(rawRef.trim()) ? rawRef.trim().toUpperCase() : null;
  // The retired long form's addresses land on the one registration, keeping a referral link's code.
  if (params.form !== undefined || params.wizard !== undefined) redirect(ref ? `/shop/register?ref=${ref}` : "/shop/register");
  const user = await getCurrentUser();
  if (!user) {
    // 0120 (FLOW_2026-10-30.md): the owner signs in here — the code comes by email.
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Register your shop" description="Step 1 of 5: sign in with your email. Then your referral code and GST or PAN, your address and map pin, and the fee — and your shop goes live." />
        <ShopSignInCard />
      </div>
    );
  }

  // Every read at once: each one is a round trip to the database.
  const [firstRead, referralRequired, categories, dealerProgramme, lang] = await Promise.all([
    getWizardDraft(user),
    // docs/nearby-referral-2026-10: the admin's setting referral_required_shop, read live.
    isReferralRequired("shop"),
    // The category picker's list, so the wizard does not fetch it after loading.
    listShopCategories({ activeOnly: true, withShopCounts: false }).catch(() => undefined),
    // docs/dealer-programme: the optional Employee ID / name field exists only while the programme is on.
    isFeatureEnabled("dealer_programme_enabled"),
    getBoardLang(),
  ]);
  // Owner brief 08-Nov-2026: the step-by-step wizard is the only way to register a shop (the long
  // form and its flag shop_onboarding_wizard_enabled are retired).
  // Onboarding Phase B (G24): "Register another shop" — an owner whose last registration is
  // submitted starts a new one (a registration still open is always resumed instead).
  // On the payment step: a try that failed or went through shows now, without waiting for the webhook.
  const current =
    firstRead?.nextStep === "PAYMENT" && firstRead.shop && (await refreshLatestRegistrationFeeAttempt(firstRead.shop.id, user.id)) ? await getWizardDraft(user) : firstRead;
  const draft = params.new === "1" && current && current.status !== "OPEN" ? null : current;
  // One registration at a time: said before any screen is filled in, not at "Create my shop and pay".
  const waiting = draft === null || draft.status === "OPEN" ? await waitingRegistration(user.id) : null;
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Register your shop" description="A few quick steps. Your GST or PAN fills in your details." />
      {draft === null || draft.status === "OPEN" ? (
        <p className="mb-3 rounded-lg border border-leaf-300 bg-leaf-50 px-3 py-2 text-sm text-leaf-700" data-testid="registering-as">
          ✓ Signed in{user.email && !isPlaceholderEmail(user.email) ? ` as ${user.email}` : ""} — your shop is added to this account.
        </p>
      ) : null}
      {waiting ? (
        <div className="space-y-3" data-testid="registration-waiting">
          <Alert tone="warning">{waitingRegistrationMessage(waiting)}</Alert>
          <LinkButton href={waiting.feeDuePaise > 0 ? `/shop/registration-fee?shop=${waiting.id}` : "/shop"} className="w-full">
            {waiting.feeDuePaise > 0 ? "Pay the registration fee" : "Go to my shop"}
          </LinkButton>
        </div>
      ) : (
        <OnboardingWizard
          initialReferralCode={ref}
          referralRequired={referralRequired}
          initial={draft ? (JSON.parse(JSON.stringify(draft)) as WizardState) : null}
          initialCategories={categories?.map((c) => ({ id: c.id, name: c.name, status: c.status, groupName: c.groupName }))}
          dealerProgramme={dealerProgramme}
          lang={lang}
        />
      )}
    </div>
  );
}
