import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";

import { OnboardingWizard, type WizardState } from "@/components/registration/onboarding-wizard";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getUnfinishedRegistration, openRegistrationForStaff } from "@/server/registration/unfinished";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { isReferralRequired } from "@/server/services/referral-settings";
import { listShopCategories } from "@/server/services/shop-categories";
import { getWizardDraft } from "@/server/services/shop-registration-wizard";

export const metadata = { title: "Continue a shop registration" };
export const dynamic = "force-dynamic";

/** Owner, 25-Nov-2026: staff continue an owner's registration from the step it stopped on. */
export default async function StaffRegistrationPage({ params }: { params: Promise<{ draftId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_REGISTRATION_MANAGE)) redirect("/");
  const { draftId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(draftId)) notFound();
  const reg = await getUnfinishedRegistration(draftId);
  if (!reg) notFound();
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  await openRegistrationForStaff(draftId, user, ip);
  const [draft, referralRequired, categories, dealerProgramme] = await Promise.all([
    getWizardDraft({ id: reg.ownerId }),
    isReferralRequired("shop"),
    listShopCategories({ activeOnly: true, withShopCounts: false }).catch(() => undefined),
    isFeatureEnabled("dealer_programme_enabled"),
  ]);
  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <Link href="/admin/shop-registrations/unfinished" className="inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Unfinished registrations
      </Link>
      <PageHeader title="Continue a shop registration" description={`For ${reg.ownerName ?? reg.ownerEmail} (${reg.ownerEmail}).`} />
      <Alert tone="info">
        You are filling in this owner&apos;s registration. Every step you save is recorded under your name. Tick the GST / PAN consent only when the
        owner has agreed to it; the owner pays the fee from their own account.
      </Alert>
      {draft && draft.status !== "OPEN" && !draft.shop ? (
        <Alert tone="warning">This registration is no longer open.</Alert>
      ) : (
        <OnboardingWizard
          staffDraft={draftId}
          referralRequired={referralRequired}
          initial={draft ? (JSON.parse(JSON.stringify(draft)) as WizardState) : null}
          initialCategories={categories?.map((c) => ({ id: c.id, name: c.name, status: c.status, groupName: c.groupName }))}
          dealerProgramme={dealerProgramme}
        />
      )}
    </div>
  );
}
