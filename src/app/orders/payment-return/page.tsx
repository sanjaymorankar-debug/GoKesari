/**
 * Where the payment gateway sends the customer back (batch-2026-10 WS-A):
 *   /orders/payment-return?intent=<payment intent id>
 * Shows paid / failed / still waiting, polling the server until the gateway
 * has answered; "Retry payment" for a failed or expired one reuses the order.
 */
import { notFound, redirect } from "next/navigation";

import { PaymentReturnStatus } from "@/components/payment-return-status";
import { PendingDeliveryLocation } from "@/components/onboarding-v2/pending-delivery-location";
import { Card, PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { L, tr } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getPaymentStatusForCustomer } from "@/server/payments/order-payments";

export const metadata = { title: "Payment" };
export const dynamic = "force-dynamic";

const PAYMENT = L("Payment", "भुगतान", "पेमेंट");

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
  const lang = await getBoardLang();
  return (
    <div className="mx-auto max-w-lg px-4 py-6">
      <PageHeader title={tr(PAYMENT, lang)} />
      <Card className="p-4">
        <PaymentReturnStatus intentId={intent} initial={view} lang={lang} />
      </Card>
      {/* docs/onboarding-v2-2026-11: delivery orders paid before the address — ask for the location right here. */}
      <PendingDeliveryLocation userId={user.id} placed />
    </div>
  );
}
