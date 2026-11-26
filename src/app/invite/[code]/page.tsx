import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { resolveReferralLink } from "@/server/services/referral-links";

export const metadata = { title: "Referral link" };
export const dynamic = "force-dynamic";

/**
 * docs/referral-sharing-2026-11: where /r/<code> sends a closed, expired or unknown code — the reason in
 * plain words, and the ways on (register a shop or shop without a code when the code is optional).
 * A code that works again (an admin reopened it) shows its usual links.
 */
export default async function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const target = await resolveReferralLink(decodeURIComponent(code));
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader title="Referral link" />
      <Card className="space-y-3 p-4" data-testid="invite-status">
        {target.usable ? (
          <>
            <p className="text-ink-800">
              Code <span className="font-mono font-semibold">{target.code}</span>
              {target.referrerName ? <> from {target.referrerName}</> : null} works.
            </p>
            <Link className="font-semibold text-kesari-700 underline" href={`/r/${encodeURIComponent(target.code)}`}>
              Continue
            </Link>
          </>
        ) : (
          <>
            <p className="font-semibold text-ink-900" data-testid="invite-reason" data-outcome={target.outcome}>
              {target.message}
            </p>
            <p className="text-sm text-ink-600">You can still join GoKesari — enter another code if you have one.</p>
            <div className="flex flex-wrap gap-4 text-sm">
              <Link className="font-semibold text-kesari-700 underline" href="/shop/register">
                Register a shop
              </Link>
              <Link className="font-semibold text-kesari-700 underline" href="/signin">
                Shop on GoKesari
              </Link>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
