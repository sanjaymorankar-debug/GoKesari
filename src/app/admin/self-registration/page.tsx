import Link from "next/link";
import { redirect } from "next/navigation";

import { SelfRegistrationAdmin } from "@/components/registration/self-registration-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listCodesWithUsage, listDistributors, listDistributorTypes, listTiers } from "@/server/registration/admin";
import { registrationCounts } from "@/server/registration/service";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Self-registration" };
export const dynamic = "force-dynamic";

/** Module 3: fee plans, distributors and referral codes for shop self-registration. */
export default async function SelfRegistrationAdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.REFERRAL_MANAGE)) redirect("/");
  const [tiers, types, distributors, codes, counts, rule] = await Promise.all([
    listTiers(),
    listDistributorTypes(),
    listDistributors(),
    listCodesWithUsage(),
    registrationCounts(),
    getRule("selfRegistration"),
  ]);
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Shop self-registration"
        description="Shops register at /shop/join with a referral code and pay online; the payment webhook approves them. Set the fee plans, distributors (commission) and codes here."
      />
      <nav className="mb-4 flex flex-wrap gap-3 text-sm">
        <Link className="text-kesari-600 underline" href="/admin/shops/auto-approved">Auto-approved shops ({counts.APPROVED ?? 0})</Link>
        <Link className="text-kesari-600 underline" href="/admin/shop-registrations">Waiting for payment ({counts.PENDING_PAYMENT ?? 0})</Link>
        <Link className="text-kesari-600 underline" href="/admin/referral-commissions">Commission</Link>
        <Link className="text-kesari-600 underline" href="/admin/test-messages">Test SMS / WhatsApp</Link>
      </nav>
      <SelfRegistrationAdmin
        tiers={plain(tiers)}
        types={plain(types)}
        distributors={plain(distributors)}
        codes={plain(codes)}
        canEditTiers={can(user.role, PERMISSIONS.REGISTRATION_FEE_MANAGE)}
        open={rule.enabled}
      />
    </div>
  );
}
