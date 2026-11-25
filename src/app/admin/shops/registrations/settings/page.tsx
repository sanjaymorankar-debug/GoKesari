import Link from "next/link";
import { redirect } from "next/navigation";

import { ShopRegistrationSettingsForm } from "@/components/admin/shop-registration-settings-form";
import { PageHeader } from "@/components/ui";
import { SHOP_TYPES } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Registration subscription settings" };
export const dynamic = "force-dynamic";

/** Admin only (0205): validity, grace, reminder schedule, fees per shop type, link validity, CC list, commission on renewals. */
export default async function ShopRegistrationSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/admin/shops/registrations");
  const [membership, subscription, feeRule] = await Promise.all([getRule("shopMembership"), getRule("shopRegistrationSubscription"), getRule("registrationFeeByTurnover").catch(() => null)]);
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/admin/shops/registrations" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Unpaid & expiring registrations
      </Link>
      <PageHeader
        title="Registration subscription settings"
        description="Every change is recorded in the audit log (who, when, old and new value). The registration fee itself is set by turnover slab in Settings → registrationFeeByTurnover."
      />
      <ShopRegistrationSettingsForm
        membership={{
          periodMonths: membership.periodMonths,
          graceDays: membership.graceDays,
          reminderDays: membership.reminderDays,
          remindersEnabled: membership.remindersEnabled,
          renewalCheckoutEnabled: membership.renewalCheckoutEnabled,
          renewalWindowDays: membership.renewalWindowDays,
        }}
        subscription={subscription}
        shopTypes={SHOP_TYPES.map((t) => ({ key: t.key, label: t.label }))}
        feeRuleSummary={feeRule ? JSON.stringify(feeRule).slice(0, 400) : null}
      />
    </div>
  );
}
