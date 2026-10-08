import { redirect } from "next/navigation";

import { ShopRegisterForm } from "@/components/shop-register-form";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopsForOwner } from "@/server/services/shops";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Add my shop" };
export const dynamic = "force-dynamic";

export default async function RegisterShopPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  // Only the signed-in owner's own shops — nothing about anyone else's.
  const ownShops = await listShopsForOwner(user.id);
  const pending = ownShops.filter((s) => s.status === "PENDING_APPROVAL");
  const rejected = ownShops.find((s) => s.status === "REJECTED");
  // docs/four-features-2026-10, feature 4: the referral code is mandatory while this rule is on.
  const referralRule = await getRule("shopReferral");

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Add my shop"
        description="Tell us about your dairy or bakery. An operator reviews every registration."
      />
      {pending.length > 0 ? (
        <div className="mb-4">
          <Alert
            tone="warning"
            title={`Already waiting for approval: ${pending.map((s) => s.name).join(", ")}`}
          >
            You&apos;ll be notified once it&apos;s reviewed, and you don&apos;t need to submit it
            again. Use this form only to add a different shop.
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
      <div className="mb-4">
        <Alert tone="info">
          Your shop starts as <strong>pending approval</strong>. Kesari/Green
          classification is assigned by an operator at approval — it cannot be
          chosen here.
        </Alert>
      </div>
      <ShopRegisterForm referralRequired={referralRule.required} />
    </div>
  );
}
