/**
 * The sandbox gateway's "hosted checkout" (batch-2026-10 WS-A): what the
 * page /orders/pay/sandbox/<ref> does when the tester presses Pay / Fail / Let it
 * expire. The sandbox moves its own ledger, signs the webhook exactly as a
 * gateway would, and that webhook goes through the same handler as
 * POST /api/webhooks/payments/sandbox (signature check, de-duplication,
 * reconciliation with fetchOrder) — so staging exercises the real path.
 *
 * Refused where the sandbox is not allowed (production, unless
 * PAYMENT_GATEWAY=SANDBOX and onlinePayments.allowSandboxInProduction).
 */
import { eq, or } from "drizzle-orm";

import { forbidden, notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { paymentIntents, type PaymentIntentRow } from "@/server/db/schema";
import { getGatewayByName, sandboxAllowed } from "./gateway/registry";
import { SandboxGateway, type SandboxOutcome } from "./gateway/sandbox";
import type { PaymentMethodKind } from "./gateway/types";
import { actionUrlFor } from "./intent-store";
import { handlePaymentWebhook } from "./processing";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The intent behind a sandbox page: by merchant order id (the URL) or intent id. */
export async function loadSandboxIntent(ref: string, viewerId: string | null): Promise<PaymentIntentRow> {
  if (!(await sandboxAllowed())) throw forbidden("The sandbox payment page is not available on this site.");
  const conditions = [eq(paymentIntents.merchantOrderId, ref)];
  if (UUID_RE.test(ref)) conditions.push(eq(paymentIntents.id, ref));
  const [row] = await db.select().from(paymentIntents).where(or(...conditions)).limit(1);
  if (!row || row.gateway !== "SANDBOX") throw notFound("Payment");
  // A checkout is the payer's own; a payment link (mode LINK) may be opened by whoever has it.
  if (row.mode === "CHECKOUT" && row.userId && row.userId !== viewerId) throw notFound("Payment");
  return row;
}

export async function simulateSandboxCheckout(input: {
  ref: string;
  viewerId: string | null;
  outcome: SandboxOutcome;
  method?: PaymentMethodKind;
}): Promise<{ returnPath: string; webhookStatus: number; outcome: unknown }> {
  const intent = await loadSandboxIntent(input.ref, input.viewerId);
  if (!intent.gatewayOrderId) throw notFound("Payment");
  const sandbox = getGatewayByName("SANDBOX");
  if (!(sandbox instanceof SandboxGateway)) throw new Error("The sandbox gateway is replaced in this process.");
  const webhook = await sandbox.simulate(intent.gatewayOrderId, input.outcome, input.method ?? "UPI");
  const result = await handlePaymentWebhook("sandbox", webhook.rawBody, webhook.headers);
  return { returnPath: actionUrlFor(intent), webhookStatus: result.status, outcome: result.body.outcome ?? null };
}
