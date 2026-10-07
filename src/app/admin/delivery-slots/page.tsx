import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { DeliverySlotCapacityAdmin } from "@/components/delivery-slot-capacity-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { listSlotCapacities } from "@/server/services/delivery-slots";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Delivery slots" };
export const dynamic = "force-dynamic";

/** F5: maximum orders per delivery slot, per shop or per area (admin only). */
export default async function DeliverySlotsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  const [rows, rule, shopList] = await Promise.all([
    listSlotCapacities(),
    getRule("deliverySlots"),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(eq(shops.status, "APPROVED")).orderBy(asc(shops.name)),
  ]);
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Delivery slots"
        description="Maximum orders per delivery slot. A shop's own limit wins over its area's, which wins over the default in Business rules."
      />
      <DeliverySlotCapacityAdmin
        enabled={rule.enabled}
        shops={shopList}
        rows={rows.map((r) => ({
          id: r.id,
          shopName: r.shopName,
          pincode: r.pincode,
          expressPerHour: r.expressPerHour,
          standardPerHour: r.standardPerHour,
          scheduledPerDay: r.scheduledPerDay,
          scheduledPerSlot: r.scheduledPerSlot,
        }))}
      />
    </div>
  );
}
