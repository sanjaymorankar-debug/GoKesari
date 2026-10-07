import { redirect } from "next/navigation";

import { CouponAdmin } from "@/components/coupon-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listCoupons } from "@/server/services/coupons";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Coupons" };
export const dynamic = "force-dynamic";

/** F7: order-level coupon codes (admin only). */
export default async function CouponsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  const [rows, rule] = await Promise.all([listCoupons(), getRule("coupons")]);
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Coupons"
        description="Codes customers enter at checkout for money off the whole order. Platform-funded: shops are paid on full goods value."
      />
      <CouponAdmin
        enabled={rule.enabled}
        rows={rows.map((r) => ({
          ...r,
          startsAt: r.startsAt?.toISOString() ?? null,
          expiresAt: r.expiresAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
