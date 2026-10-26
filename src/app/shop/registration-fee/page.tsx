import Link from "next/link";
import { redirect } from "next/navigation";

import { RegistrationFeePayButton } from "@/components/registration-fee-pay-button";
import { Alert, Badge, Card, LinkButton, Money, PageHeader } from "@/components/ui";
import { formatRupeesIndian } from "@/lib/registration-fee";
import { getCurrentUser } from "@/server/authz/guards";
import {
  checkRegistrationFeePayment,
  latestRegistrationFeeAttempt,
  registrationFeeDue,
} from "@/server/services/registration-fee-payment";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Registration fee" };
export const dynamic = "force-dynamic";

/**
 * Add my shop → step 2: the one-time registration fee, paid online. Reached
 * straight after Submit, from the "pay the fee" link while the registration
 * waits, and back from the gateway (`?intent=`), when the payment is checked.
 * Step 3 is the documents upload.
 */
export default async function RegistrationFeePage({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string; intent?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const params = await searchParams;

  let shopId = typeof params.shop === "string" && /^[0-9a-f-]{36}$/i.test(params.shop) ? params.shop : null;
  if (!shopId) {
    // No shop named: the owner's registration that still owes its fee, if any.
    const owing = (await listShopsForOwner(user.id)).find((s) => registrationFeeDue(s) > 0);
    if (!owing) redirect("/shop");
    shopId = owing.id;
  }

  const shop = await checkRegistrationFeePayment(shopId, params.intent ?? null, user.id).catch(() => null);
  if (!shop) redirect("/shop");
  const due = registrationFeeDue(shop);
  const fee = shop.registrationFeePaise ?? 0;
  const attempt = due > 0 ? await latestRegistrationFeeAttempt(shop.id, user.id) : null;
  const returned = typeof params.intent === "string";
  const documentsHref = `/shop/documents?shop=${shop.id}`;

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title="Registration fee"
        description="A one-time fee to register on GoKesari. Pay it online now — the review of your shop goes ahead once it is paid."
      />

      <ol className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Registration steps">
        <li className="text-ink-500">✓ Shop details</li>
        <li className="font-semibold">2. Registration fee</li>
        <li className="text-ink-500">3. Documents</li>
      </ol>

      <Card className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-semibold text-ink-900">{shop.name}</p>
            {shop.annualTurnoverRupees !== null ? (
              <p className="text-sm text-ink-500">
                Declared annual turnover: {formatRupeesIndian(shop.annualTurnoverRupees)}
              </p>
            ) : null}
          </div>
          {due === 0 ? (
            <Badge tone="success">{fee === 0 ? "No fee" : "Paid"}</Badge>
          ) : (
            <Badge tone="warning">{shop.feePaymentStatus === "PARTIALLY_PAID" ? "Partly paid" : "Payment pending"}</Badge>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-ink-500">One-time registration fee</dt>
          <dd className="text-right font-medium text-ink-900">
            <Money paise={fee} />
          </dd>
          {shop.amountPaidPaise > 0 ? (
            <>
              <dt className="text-ink-500">Paid</dt>
              <dd className="text-right text-ink-900">
                <Money paise={shop.amountPaidPaise} />
              </dd>
            </>
          ) : null}
          {due > 0 ? (
            <>
              <dt className="font-semibold text-ink-700">To pay now</dt>
              <dd className="text-right text-lg font-semibold text-ink-900">
                <Money paise={due} />
              </dd>
            </>
          ) : null}
        </dl>

        {due === 0 ? (
          <>
            <Alert tone="success" title={fee === 0 ? "Nothing to pay" : "Payment received"}>
              {shop.status === "APPROVED"
                ? "Your shop is approved and live."
                : "Your registration is with our team for review. Next, upload your documents."}
            </Alert>
            <LinkButton href={shop.status === "APPROVED" ? "/shop" : documentsHref} className="w-full">
              {shop.status === "APPROVED" ? "Go to my shop" : "Next: upload documents"}
            </LinkButton>
          </>
        ) : (
          <>
            {attempt && (attempt.status === "FAILED" || attempt.status === "EXPIRED") ? (
              <Alert tone="danger" title="Your last payment did not go through">
                No money was taken for it. You can try again below.
              </Alert>
            ) : null}
            {returned && attempt?.live ? (
              <Alert tone="info" title="Checking your payment…">
                If you completed the payment, it shows here within a minute.{" "}
                <Link href={`/shop/registration-fee?shop=${shop.id}`} className="underline">
                  Refresh
                </Link>
              </Alert>
            ) : null}
            <RegistrationFeePayButton shopId={shop.id} amountPaise={due} />
            <p className="text-center text-sm text-ink-500">
              <Link href={documentsHref} className="underline">
                Pay later and upload documents first
              </Link>
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
