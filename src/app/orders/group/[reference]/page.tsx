import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Alert, Card, Money, PageHeader, StatusBadge } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { getOrderGroupForUser } from "@/server/services/order-groups";

export const metadata = { title: "Order" };
export const dynamic = "force-dynamic";

/** F6: one parent reference over a multi-shop order; each shop's part is its own order. */
export default async function OrderGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<{ placed?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { reference } = await params;
  const { placed } = await searchParams;
  const group = await getOrderGroupForUser(user.id, decodeURIComponent(reference)).catch((error) => {
    if (error instanceof AppError && error.code === "NOT_FOUND") return null;
    throw error;
  });
  if (!group) notFound();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title={`Order ${group.reference}`}
        description={`${group.orders.length} shop${group.orders.length === 1 ? "" : "s"} · placed ${group.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`}
      />
      {placed ? (
        <Alert tone="success" title="Order placed">
          Your order {group.reference} is confirmed. Each shop prepares and delivers its part separately.
        </Alert>
      ) : null}
      <div className="space-y-3">
        {group.orders.map((o) => (
          <Card key={o.id} className="flex items-center justify-between gap-3 p-4" data-testid="sub-order">
            <div>
              <p className="font-medium text-ink-900">{o.shopName}</p>
              <p className="text-xs text-ink-500">{o.orderNumber}</p>
            </div>
            <div className="flex items-center gap-3">
              <StatusBadge status={o.status} />
              <span className="font-semibold text-ink-900">
                <Money paise={o.totalPaise} />
              </span>
            </div>
          </Card>
        ))}
      </div>
      <Card className="flex justify-between p-4 text-base font-semibold text-ink-900">
        <span>Total</span>
        <Money paise={group.totalPaise} />
      </Card>
      <Link href="/orders" className="text-sm text-kesari-700 hover:underline">
        Track each shop&apos;s delivery in My Orders →
      </Link>
    </div>
  );
}
