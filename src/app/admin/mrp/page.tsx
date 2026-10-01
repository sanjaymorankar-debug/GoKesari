import { redirect } from "next/navigation";

import { MrpGovernancePanel } from "@/components/mrp-governance-panel";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listCorrections, listMrpViolations, mrpVerificationSummary } from "@/server/services/mrp-governance";
import { listProductsMissingMrp } from "@/server/services/product-master";

export const metadata = { title: "MRP governance" };
export const dynamic = "force-dynamic";

export default async function MrpGovernancePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PRODUCT_MRP_MANAGE)) redirect("/");

  const [summary, missing, violations, pending] = await Promise.all([
    mrpVerificationSummary(),
    listProductsMissingMrp(100),
    listMrpViolations(100),
    listCorrections("PENDING"),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="MRP governance"
        description="The master MRP is set only here, by operations, with a history. A shop cannot change it — it can raise a correction for you to decide."
      />
      <MrpGovernancePanel
        overview={{
          summary,
          missing: missing.map((p) => ({ id: p.id, code: p.code, name: p.name })),
          violations,
          pending: pending.map((r) => ({
            correction: { id: r.correction.id, claimedMrpPaise: r.correction.claimedMrpPaise, note: r.correction.note, createdAt: r.correction.createdAt },
            productName: r.productName,
            productCode: r.productCode,
            currentMrpPaise: r.currentMrpPaise,
            shopName: r.shopName,
          })),
        }}
      />
    </div>
  );
}
