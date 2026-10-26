import Link from "next/link";
import { redirect } from "next/navigation";

import { ShopRegisterForm } from "@/components/shop-register-form";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { isReferralRequired } from "@/server/services/referral-settings";
import { listShopCategories } from "@/server/services/shop-categories";
import { listShopsForOwner } from "@/server/services/shops";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Add my shop" };
export const dynamic = "force-dynamic";

export default async function RegisterShopPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  // Every read at once: each one is a round trip to the database, and they
  // used to run one after another on every visit.
  const [ownShops, referralRequired, selfRegistration, feeRule, categories] = await Promise.all([
    // Only the signed-in owner's own shops — nothing about anyone else's.
    listShopsForOwner(user.id),
    // docs/nearby-referral-2026-10: the admin's setting referral_required_shop, read live.
    isReferralRequired("shop"),
    // Module 3: with a referral code a shop can register and pay online, approved on payment.
    getRule("selfRegistration"),
    // The one-time fee by annual turnover, shown on the form before Submit.
    getRule("registrationFeeByTurnover"),
    // The category picker's list, so the form does not fetch it after loading.
    listShopCategories({ activeOnly: true, withShopCounts: false }).catch(() => undefined),
  ]);
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
        feeRule={feeRule}
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
