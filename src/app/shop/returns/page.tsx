import { redirect } from "next/navigation";

import { ReturnCase } from "@/components/return-case";
import { EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getReturnDetail, listReturnsForShop } from "@/server/services/returns";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Shop returns" };
export const dynamic = "force-dynamic";

/** The shop's return queue: review, approve, receive, inspect and refund. */
export default async function ShopReturnsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];

  const list = await listReturnsForShop(shop.id);
  const details = await Promise.all(list.slice(0, 50).map((r) => getReturnDetail(r.id, user)));
  // Open work first: anything not finished.
  const finished = ["REJECTED", "REFUND_COMPLETED", "RETURN_CANCELLED"];
  details.sort((a, b) => Number(finished.includes(a.ret.status)) - Number(finished.includes(b.ret.status)));

  return (
    <>
      <PageHeader title="Returns" description={`${shop.name} — customer return requests.`} />
      {details.length === 0 ? (
        <EmptyState title="No returns." description="Customer return requests appear here." />
      ) : (
        <div className="space-y-4">
          {details.map((detail) => (
            <ReturnCase key={detail.ret.id} detail={detail} />
          ))}
        </div>
      )}
    </>
  );
}
