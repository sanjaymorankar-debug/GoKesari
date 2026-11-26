import Link from "next/link";

import { Alert } from "@/components/ui";
import { VERIFY_IDENTITY_PATH } from "@/lib/kyc/identity";

/**
 * docs/identity-verification-2026-11: Seller Central's banner while a shop
 * owner has not verified their identity — the grace period's end date, or,
 * once it is over, that the shop takes no new orders.
 */
export function IdentityGraceBanner({ graceEndsAt, graceOver }: { graceEndsAt: Date | null; graceOver: boolean }) {
  const when = graceEndsAt ? graceEndsAt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : null;
  return (
    <div className="mb-4" data-testid="seller-identity-banner">
      <Alert tone={graceOver ? "danger" : "warning"} title={graceOver ? "Your shop is not taking new orders" : "Verify your identity"}>
        {graceOver
          ? "New orders are paused until you verify your identity. Orders you already accepted are not affected. "
          : `A one-time check with Aadhaar (DigiLocker) or your PAN${when ? `, by ${when}` : ""}. After that your shop takes no new orders until you verify. `}
        <Link href={`${VERIFY_IDENTITY_PATH}?next=/shop`} className="font-medium underline">
          Verify now
        </Link>
      </Alert>
    </div>
  );
}
