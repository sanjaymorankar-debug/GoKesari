import Link from "next/link";
import { redirect } from "next/navigation";

import { ReferralSettingsPanel, type ReferralChangeRow } from "@/components/referral-settings-panel";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import {
  getReferralSettings,
  listReferralSettingChanges,
  REFERRAL_SETTING_LABELS,
} from "@/server/services/referral-settings";

export const metadata = { title: "Referral settings" };
export const dynamic = "force-dynamic";

const HINTS = {
  referral_required_customer:
    "New customers' first-time setup. Mandatory: a valid code is needed before the first order. Optional: the field is shown as optional; a code that is entered must still be valid.",
  referral_required_shop:
    "Add my shop and shop self-registration (/shop/join). Mandatory: a valid code is needed to register, and for auto-approval with the payment. Optional: registration and auto-approval go ahead without one.",
} as const;

/**
 * Referral settings (docs/nearby-referral-2026-10, feature 2) — admin only.
 * Operators, shop owners and customers are sent home; the API refuses them too.
 */
export default async function ReferralSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  const [settings, changes] = await Promise.all([getReferralSettings(), listReferralSettingChanges({ limit: 20 })]);
  const rows = (["referral_required_customer", "referral_required_shop"] as const).map((key) => ({
    key,
    label: REFERRAL_SETTING_LABELS[key],
    hint: HINTS[key],
    value: settings[key].value,
  }));
  const log: ReferralChangeRow[] = changes.map((c) => ({ ...c, changedAt: c.changedAt.toISOString() }));

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/menu/settings" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Settings
      </Link>
      <PageHeader
        title="Referral settings"
        description="Whether a referral code is mandatory or optional when people register. A change applies at once to new registrations; existing customers and shops are not affected. Every change is logged."
      />
      <ReferralSettingsPanel settings={rows} changes={log} />
      <p className="mt-4 text-sm text-ink-700">
        Codes are issued under <Link className="font-semibold text-kesari-800 underline" href="/admin/console/referral-codes">Referral codes</Link>;
        requests for a code are under <Link className="font-semibold text-kesari-800 underline" href="/admin/referral-requests">Referral requests</Link>.
      </p>
    </div>
  );
}
