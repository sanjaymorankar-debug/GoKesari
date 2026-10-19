/**
 * Where the payment gateway sends the customer back (batch-2026-10 WS-A):
 *   /orders/payment-return?intent=<payment intent id>
 * Shows paid / failed / still waiting, polling the server until the gateway
 * has answered; "Retry payment" for a failed or expired one reuses the order.
 */
import { notFound, redirect } from "next/navigation";

import { PaymentReturnStatus } from "@/components/payment-return-status";
import { Card, PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { getPaymentStatusForCustomer } from "@/server/payments/order-payments";

export const metadata = { title: "Payment" };
export const dynamic = "force-dynamic";

export default async function PaymentReturnPage({ searchParams }: { searchParams: Promise<{ intent?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { intent } = await searchParams;
  if (!intent || !/^[0-9a-f-]{36}$/i.test(intent)) notFound();
  let view;
  try {
    view = await getPaymentStatusForCustomer(user.id, intent);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  return (
    <div className="mx-auto max-w-lg px-4 py-6">
      <PageHeader title="Payment" />
      <Card className="p-4">
        <PaymentReturnStatus intentId={intent} initial={view} />
      </Card>
    </div>
  );
}
