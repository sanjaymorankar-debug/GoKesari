import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AccountDeletionFlow } from "@/components/account-deletion-flow";
import { Card, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { ACCOUNT_DELETION_FLAG, deletionPrecheck } from "@/server/services/account-deletion";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Delete my account" };
export const dynamic = "force-dynamic";

/** docs/account-deletion-2026-11: what is deleted and what is kept, the checks, the code and the typed DELETE. */
export default async function DeleteAccountPage() {
  if (!(await isFeatureEnabled(ACCOUNT_DELETION_FLAG))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const precheck = await deletionPrecheck(user.id);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Delete my account"
        description="Deleting your account is permanent. You will be signed out on every device."
        action={
          <Link href="/profile" className="text-sm font-medium text-kesari-600 hover:underline">
            ← My Profile
          </Link>
        }
      />

      <Card className="mb-6 grid gap-4 p-6 text-sm" data-testid="account-deletion-what">
        <div>
          <h2 className="text-base font-semibold text-ink-900">What is deleted</h2>
          <ul className="mt-2 list-disc pl-5 text-ink-700">
            <li>Your name, email address, mobile number and profile photo</li>
            <li>Your saved delivery addresses</li>
            <li>Your saved bank account or UPI ID for refunds</li>
            <li>App notifications to your phones</li>
            <li>Any live subscriptions (cancelled — no further deliveries or charges)</li>
          </ul>
        </div>
        <div>
          <h2 className="text-base font-semibold text-ink-900">What is kept, and why</h2>
          <p className="mt-2 text-ink-700">
            The law requires us to keep business records for a set period (GST and income-tax rules, payment and
            consumer protection rules). These are kept without your name or contact details and are not used for
            anything else:
          </p>
          <ul className="mt-2 list-disc pl-5 text-ink-700">
            <li>Orders, invoices and the delivery address printed on them</li>
            <li>Payments, refunds and wallet transactions</li>
            <li>Returns, disputes and complaints</li>
            <li>Delivery-partner earnings, payouts and tax (TDS) records, if you delivered for GoKesari</li>
            <li>The record of your consents and of this deletion</li>
          </ul>
        </div>
        <p className="text-ink-700">
          You can sign up again later with the same email address; it will be a new, empty account.
        </p>
      </Card>

      <AccountDeletionFlow
        canDelete={precheck.canDelete}
        blockers={precheck.blockers}
        subscriptionsToCancel={precheck.subscriptionsToCancel}
        promotionalForfeit={precheck.promotionalForfeitPaise > 0 ? formatPaise(precheck.promotionalForfeitPaise) : null}
        maskedEmail={precheck.maskedEmail}
      />
    </div>
  );
}
