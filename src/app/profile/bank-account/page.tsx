import Link from "next/link";
import { redirect } from "next/navigation";

import { BankAccountManager } from "@/components/bank-account-manager";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { bankCheckOffered } from "@/server/services/bank-account-check";
import { getBankAccountView, verificationGatewayMode } from "@/server/services/bank-accounts";

export const metadata = { title: "Bank account for refunds" };
export const dynamic = "force-dynamic";

/** The customer's bank account for refunds (docs/four-features-2026-10, feature 3). */
export default async function ProfileBankAccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const account = await getBankAccountView(user.id, null);
  const bankCheck = await bankCheckOffered();
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Bank account for refunds"
        description="Refunds normally go to your GoKesari wallet. A verified bank account is needed for any refund to your bank."
        action={
          <Link href="/profile" className="text-sm font-medium text-kesari-600 hover:underline">
            ← My Profile
          </Link>
        }
      />
      <BankAccountManager account={account} saveUrl="/api/bank-account" gateway={verificationGatewayMode()} purpose="refunds" bankCheck={bankCheck} />
    </div>
  );
}
