import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui";
import { isProductionSite } from "@/lib/env";
import { mockDigilockerSessionExists } from "@/server/kyc/adapters/mock";

import { MockDigilockerButtons } from "./buttons";

export const metadata = { title: "DigiLocker (test)", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * A stand-in for DigiLocker's sign-in and consent screens, for the mock
 * provider (rule riderVerification.digilockerProvider "mock", or
 * KYC_PROVIDER=mock). Never on gokesari.com.
 */
export default async function MockDigilockerPage({ searchParams }: { searchParams: Promise<{ session?: string }> }) {
  if (isProductionSite()) notFound();
  const { session } = await searchParams;
  const known = Boolean(session && mockDigilockerSessionExists(session));
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader
        title="DigiLocker — test page"
        description="This is not DigiLocker. On the real page the partner signs in with an OTP to their Aadhaar-linked mobile and approves sharing their Aadhaar with GoKesari."
      />
      {known ? (
        <MockDigilockerButtons session={session!} />
      ) : (
        <p className="text-sm text-ink-700" data-testid="mock-digilocker-unknown">
          This test session is unknown or was forgotten (the server restarted). Go back and start again.
        </p>
      )}
    </div>
  );
}
