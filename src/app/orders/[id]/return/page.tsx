import { notFound, redirect } from "next/navigation";

import { ReturnRequestForm } from "@/components/return-request-form";
import { LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getReturnableOrder } from "@/server/services/returns";

export const metadata = { title: "Return items" };
export const dynamic = "force-dynamic";

export default async function ReturnOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const order = await getReturnableOrder(id, user.id).catch(() => null);
  if (!order) notFound();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={`Return items — ${order.orderNumber}`}
        description="Tell us what is wrong and we will arrange the return."
        action={<LinkButton href="/returns" variant="secondary">My returns</LinkButton>}
      />
      <ReturnRequestForm order={order} />
    </div>
  );
}
