import { redirect } from "next/navigation";

import { CommissionTdsAdmin } from "@/components/admin/commission-tds-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getRule } from "@/server/services/settings";
import { listCommissionTdsRates, listTdsCertificates, listTdsChallans, tdsExceptions } from "@/server/tax/commission-tds";

export const metadata = { title: "TDS on commission" };
export const dynamic = "force-dynamic";

/** Admin → TDS on commission (gap report Part D): ADMIN and the CA. */
export default async function TdsCommissionPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.COMMISSION_TDS_MANAGE)) redirect("/");
  const actor = { id: user.id, role: user.role };
  const [rates, certificates, challans, exceptions, rule] = await Promise.all([listCommissionTdsRates(), listTdsCertificates(), listTdsChallans(), tdsExceptions(actor), getRule("dealerPayoutTds")]);
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <PageHeader
        title="TDS on commission"
        description="Dated TDS rows for dealer and team-member commission (confirmed by the CA), lower / nil certificates, challans, the 26Q data, Form 16A and the exceptions. Sections changed under the Income-tax Act 2025: the CA gives the section as free text."
      />
      <CommissionTdsAdmin role={user.role} tdsOn={rule.enabled} rates={plain(rates)} certificates={plain(certificates)} challans={plain(challans)} exceptions={plain(exceptions)} />
    </div>
  );
}
