/**
 * Sandbox hosted checkout (batch-2026-10 WS-A) — STAGING / TESTS ONLY.
 * Stands in for a gateway's payment page: "Pay (success)", "Fail" and "Let it
 * expire" each produce the signed webhook a real gateway would send, which
 * runs through our webhook handler; then the customer is sent back to the
 * return page. No card or UPI details are ever asked for or handled here.
 * Refused in production unless PAYMENT_GATEWAY=SANDBOX and the rule allows it.
 */
import { notFound, redirect } from "next/navigation";

import { Alert, Button, Card, Money, PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { loadSandboxIntent, simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import type { SandboxOutcome } from "@/server/payments/gateway/sandbox";
import type { PaymentMethodKind } from "@/server/payments/gateway/types";

export const metadata = { title: "Sandbox payment" };
export const dynamic = "force-dynamic";

const METHODS: { value: PaymentMethodKind; label: string }[] = [
  { value: "UPI", label: "UPI" },
  { value: "CARD", label: "Card" },
  { value: "NETBANKING", label: "Netbanking" },
];

export default async function SandboxPaymentPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const user = await getCurrentUser();
  let intent;
  try {
    intent = await loadSandboxIntent(decodeURIComponent(ref), user?.id ?? null);
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") {
      return (
        <div className="mx-auto max-w-md px-4 py-8">
          <Alert tone="warning" title="Not available">
            The sandbox payment page only runs on the test site.
          </Alert>
        </div>
      );
    }
    notFound();
  }

  async function act(formData: FormData) {
    "use server";
    const viewer = await getCurrentUser();
    const outcome = String(formData.get("outcome")) as SandboxOutcome;
    const method = String(formData.get("method") ?? "UPI") as PaymentMethodKind;
    if (!["SUCCESS", "FAILURE", "EXPIRE"].includes(outcome)) return;
    const result = await simulateSandboxCheckout({
      ref: decodeURIComponent(ref),
      viewerId: viewer?.id ?? null,
      outcome,
      method: METHODS.some((m) => m.value === method) ? method : "UPI",
    });
    redirect(result.returnPath);
  }

  const open = intent.status === "CREATED" || intent.status === "PENDING" || intent.status === "AUTHORIZED";

  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <PageHeader title="Sandbox payment" description="Test payment page — no money moves." />
      <Card className="space-y-4 p-4" data-testid="sandbox-checkout">
        <Alert tone="warning" title="Test site only">
          This page stands in for the payment gateway on the test site. Never enter real card, UPI or bank details anywhere on
          the test site.
        </Alert>
        <div>
          <p className="text-sm text-ink-600">{intent.description}</p>
          <p className="mt-1 text-2xl font-semibold text-ink-900">
            <Money paise={intent.amountPaise} />
          </p>
        </div>
        {open ? (
          <form action={act} className="space-y-3">
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-ink-700">Method</legend>
              <div className="flex flex-wrap gap-3 text-sm">
                {METHODS.map((m, i) => (
                  <label key={m.value} className="flex min-h-11 items-center gap-2">
                    <input type="radio" name="method" value={m.value} defaultChecked={i === 0} />
                    {m.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" name="outcome" value="SUCCESS" data-testid="sandbox-pay">
                Pay (success)
              </Button>
              <Button type="submit" name="outcome" value="FAILURE" variant="danger" data-testid="sandbox-fail">
                Fail
              </Button>
              <Button type="submit" name="outcome" value="EXPIRE" variant="secondary" data-testid="sandbox-expire">
                Let it expire
              </Button>
            </div>
          </form>
        ) : (
          <Alert tone="info">This payment is already {intent.status.toLowerCase().replace("_", " ")}.</Alert>
        )}
      </Card>
    </div>
  );
}
