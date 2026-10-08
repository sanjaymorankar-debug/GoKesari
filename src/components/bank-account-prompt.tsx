import Link from "next/link";

import { Alert } from "@/components/ui";

/**
 * Bank accounts (docs/four-features-2026-10, feature 3): a prompt, never a
 * lockout, for an account that has no verified bank account yet.
 */
export function BankAccountPrompt({ status, href, purpose }: { status: "PENDING" | "VERIFIED" | "FAILED" | "NONE"; href: string; purpose: "refunds" | "payouts" }) {
  if (status === "VERIFIED") return null;
  const title =
    status === "NONE"
      ? purpose === "payouts"
        ? "Add your bank account to receive payouts"
        : "Add a bank account for refunds"
      : status === "FAILED"
        ? "Your bank account could not be verified"
        : "Verify your bank account";
  return (
    <div className="mb-4" data-testid="bank-account-prompt">
      <Alert tone="info" title={title}>
        {purpose === "payouts"
          ? "Settlements are paid to a verified bank account. "
          : "Refunds normally go to your wallet; a verified bank account lets us refund to your bank when needed. "}
        Verification is a ₹1 payment, refunded straight away.{" "}
        <Link href={href} className="font-medium underline">
          {status === "NONE" ? "Add it" : "Verify now"}
        </Link>
      </Alert>
    </div>
  );
}
