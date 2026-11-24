import Link from "next/link";

import { Alert } from "@/components/ui";

/**
 * The /dealer banner while a payee cannot be paid: what is missing, how much is waiting and where to add
 * it. The amount is not lost — it is carried to the next payout until the details are added.
 */
export function PayoutHeldBanner({ missing, heldPaise, panHref, bankHref }: { missing: string[]; heldPaise: number; panHref: string; bankHref: string }) {
  const amount = `₹${(heldPaise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const needsPan = missing.includes("PAN");
  const needsBank = missing.includes("verified bank account");
  return (
    <div data-testid="dealer-payout-held">
      <Alert tone="warning" title={heldPaise > 0 ? `${amount} of commission is waiting for your details` : "Add your details to receive commission"}>
        <p>
          Commission is paid only with your PAN and a verified bank account on file. Missing: {missing.join(", ")}.{" "}
          {heldPaise > 0 ? "It is kept for you and paid in the first payout after you add them." : "Add them now so your first payout is not held."}
        </p>
        <p className="mt-2 flex flex-wrap gap-3 font-semibold">
          {needsPan ? (
            <Link className="underline" href={panHref}>
              Add PAN
            </Link>
          ) : null}
          {needsBank ? (
            <Link className="underline" href={bankHref}>
              Verify bank
            </Link>
          ) : null}
        </p>
      </Alert>
    </div>
  );
}
