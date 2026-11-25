import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { IdentityVerificationForm } from "@/components/identity-verification-form";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getMyIdentityStatus, noteSellerIdentityPrompt } from "@/server/services/identity-verification";

export const metadata = { title: "Verify your identity" };
export const dynamic = "force-dynamic";

/** A same-site path to go back to after verifying (the cart, the seller home); anything else is ignored. */
function safeNext(raw: string | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  return raw.slice(0, 200);
}

/**
 * docs/identity-verification-2026-11: the one-time identity check, for
 * customers (before their first order) and shop owners (before the shop goes
 * live / within the grace period). 404 while neither identity switch applies
 * to the person (unless already verified). Consent screen first; Aadhaar by
 * DigiLocker or PAN.
 */
export default async function VerifyIdentityPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { next } = await searchParams;
  // A shop owner opening the page has been asked: their grace period starts (once).
  await noteSellerIdentityPrompt(user.id).catch(() => null);
  const status = await getMyIdentityStatus(user.id);
  if (!status.enabled && !status.verified) notFound();
  const target = safeNext(next);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Verify your identity"
        description="A one-time check. Once you are verified you will not be asked again."
        action={
          <Link href="/profile" className="text-sm font-medium text-kesari-600 hover:underline">
            ← My Profile
          </Link>
        }
      />
      <IdentityVerificationForm
        current={
          status.current
            ? {
                method: status.current.method,
                status: status.current.status,
                maskedId: status.current.maskedId,
                verifiedName: status.current.verifiedName,
                reason: status.current.reason,
                digilockerOpen: status.current.digilockerOpen,
              }
            : null
        }
        verified={status.verified}
        panOffered={status.methods.pan}
        subject={status.subject}
        seller={{
          required: status.seller.required,
          graceEndsAt: status.seller.graceEndsAt ? status.seller.graceEndsAt.toISOString() : null,
          graceOver: status.seller.graceOver,
        }}
        next={target}
      />
    </div>
  );
}
