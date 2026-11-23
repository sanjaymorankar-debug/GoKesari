import { notFound, redirect } from "next/navigation";

import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopStaff, listStaffActivity } from "@/server/services/shop-staff";
import { shopStaffRolesEnabled } from "@/server/services/shop-staff-access";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Staff activity" };
export const dynamic = "force-dynamic";

const ACTION_LABELS: Record<string, string> = {
  "shop_staff.action": "Used permission",
  "shop_staff.invite_accepted": "Accepted the invitation",
};

/** Module 10: what one staff member did in the owner's shop (audit log, newest first). */
export default async function StaffActivityPage({ params }: { params: Promise<{ staffId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!(await shopStaffRolesEnabled())) redirect("/shop/staff");
  const { staffId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(staffId)) notFound();
  const shop = await activeShop(await listShopsForOwner(user.id));
  if (!shop) redirect("/shop");
  const member = (await listShopStaff(shop.id, user)).find((m) => m.id === staffId);
  if (!member) notFound();
  const activity = await listStaffActivity(shop.id, staffId, user);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={`Activity — ${member.name ?? member.contact}`}
        description={`What they did in ${shop.name}, newest first.`}
        action={
          <LinkButton href="/shop/staff" variant="secondary">
            Back
          </LinkButton>
        }
      />
      {activity.length === 0 ? (
        <EmptyState title="Nothing yet" description="Changes this person makes in your shop appear here." />
      ) : (
        <Card className="divide-y divide-cream-100">
          {activity.map((a) => {
            const details = a.details as { permission?: string } | null;
            return (
              <div key={a.id} className="flex flex-wrap justify-between gap-2 p-3 text-sm">
                <div>
                  <p className="font-medium text-ink-900">
                    {ACTION_LABELS[a.action] ?? a.action}
                    {details?.permission ? ` · ${details.permission}` : ""}
                  </p>
                  <p className="text-xs text-ink-500">
                    {a.entityType}
                    {a.entityType !== "shop" && a.entityId ? ` ${a.entityId.slice(0, 8)}` : ""}
                  </p>
                </div>
                <time className="text-xs text-ink-500">
                  {new Date(a.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}
                </time>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
