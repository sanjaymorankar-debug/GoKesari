/**
 * Payment page for gateways whose checkout opens from their JS SDK with a
 * session token (Cashfree) — batch-2026-10 WS-A. Only the payer can open it.
 */
import { notFound, redirect } from "next/navigation";

import { GatewaySessionLauncher } from "@/components/gateway-session-launcher";
import { Card, Money, PageHeader } from "@/components/ui";
import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/server/authz/guards";
import { getPaymentIntentRow, isLive } from "@/server/payments/intents";
import { actionUrlFor } from "@/server/payments/intent-store";

export const metadata = { title: "Pay online" };
export const dynamic = "force-dynamic";

export default async function GatewaySessionPage({ params }: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const intent = /^[0-9a-f-]{36}$/i.test(intentId) ? await getPaymentIntentRow(intentId) : null;
  if (!intent || intent.userId !== user.id) notFound();
  const returnPath = actionUrlFor(intent);
  if (!isLive(intent) || intent.checkoutKind !== "SDK_SESSION" || !intent.checkoutToken) redirect(returnPath);

  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <PageHeader title="Pay online" description={intent.description} />
      <Card className="space-y-4 p-4">
        <p className="text-2xl font-semibold text-ink-900">
          <Money paise={intent.amountPaise} />
        </p>
        <GatewaySessionLauncher
          gateway={intent.gateway}
          sessionToken={intent.checkoutToken}
          mode={getEnv().CASHFREE_ENV}
          returnPath={returnPath}
        />
      </Card>
    </div>
  );
}
