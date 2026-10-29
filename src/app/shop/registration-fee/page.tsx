import Link from "next/link";
import { redirect } from "next/navigation";

import { DocumentsPromiseForm } from "@/components/documents-promise-form";
import { RegistrationFeePayButton } from "@/components/registration-fee-pay-button";
import { Alert, Badge, Card, LinkButton, Money, PageHeader } from "@/components/ui";
import { SELLER_DOC_LABELS } from "@/lib/kyc/doc-formats";
import { formatGstRate, formatRupeesIndian } from "@/lib/registration-fee";
import { getCurrentUser } from "@/server/authz/guards";
import {
  checkRegistrationFeePayment,
  latestRegistrationFeeAttempt,
  registrationFeeDue,
} from "@/server/services/registration-fee-payment";
import { getRule } from "@/server/services/settings";
import { shopDocumentGate } from "@/server/services/shop-document-gate";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Registration fee" };
export const dynamic = "force-dynamic";

/**
 * Add my shop → the one-time registration fee, paid online. Reached straight
 * after Submit, from the "pay the fee" link while the registration waits, and
 * back from the gateway (`?intent=`), when the payment is checked. Owner
 * decision 29 Oct 2026: the documents come first — the fee is paid once they
 * are verified (at least one), or once the owner promises the rest within 30 days.
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
  // An admin waiver sets the fee to 0 but keeps the quote's base / GST snapshot: show the waiver as a line (D-107).
  const quoted =
    shop.registrationFeeBasePaise !== null && shop.registrationFeeGstRateBp !== null
      ? shop.registrationFeeBasePaise - (shop.registrationFeeDiscountPaise ?? 0) + (shop.registrationFeeGstPaise ?? 0)
      : 0;
  const waived = fee === 0 && quoted > 0;
  const attempt = due > 0 ? await latestRegistrationFeeAttempt(shop.id, user.id) : null;
  const returned = typeof params.intent === "string";
  const documentsHref = `/shop/documents?shop=${shop.id}`;
  const [gate, followUp] = await Promise.all([shopDocumentGate(shop), getRule("shopDocumentFollowUp")]);
  const dateIn = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title="Registration fee"
        description="A one-time fee to register on GoKesari. Your documents are checked first; then pay it online and the review of your shop goes ahead."
      />

      <ol className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Registration steps">
        <li className="text-ink-500">✓ Shop details</li>
        <li className={gate.canPay ? "text-ink-500" : "font-semibold"}>{gate.canPay ? "✓" : "2."} Documents</li>
        <li className={gate.canPay ? "font-semibold" : "text-ink-500"}>3. Registration fee</li>
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
            <Badge tone="success">{waived ? "Fee waived" : fee === 0 ? "No fee" : "Paid"}</Badge>
          ) : (
            <Badge tone="warning">{shop.feePaymentStatus === "PARTIALLY_PAID" ? "Partly paid" : "Payment pending"}</Badge>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-y-1 text-sm">
          {shop.registrationFeeBasePaise !== null && shop.registrationFeeGstRateBp !== null ? (
            <>
              {/* Owner, 27 Oct 2026: base fee, less a coupon, plus GST. */}
              <dt className="text-ink-500">Registration fee</dt>
              <dd className="text-right text-ink-900">
                <Money paise={shop.registrationFeeBasePaise} />
              </dd>
              {(shop.registrationFeeDiscountPaise ?? 0) > 0 ? (
                <>
                  <dt className="text-green-700">Coupon {shop.registrationFeeCouponCode}</dt>
                  <dd className="text-right text-green-700">
                    − <Money paise={shop.registrationFeeDiscountPaise ?? 0} />
                  </dd>
                </>
              ) : null}
              <dt className="text-ink-500">GST ({formatGstRate(shop.registrationFeeGstRateBp)})</dt>
              <dd className="text-right text-ink-900">
                <Money paise={shop.registrationFeeGstPaise ?? 0} />
              </dd>
              {waived ? (
                <>
                  <dt className="text-green-700">Waived by GoKesari</dt>
                  <dd className="text-right text-green-700" data-testid="fee-waived-line">
                    − <Money paise={quoted} />
                  </dd>
                </>
              ) : null}
            </>
          ) : null}
          <dt className="text-ink-500">One-time registration fee{shop.registrationFeeGstRateBp !== null ? " (total)" : ""}</dt>
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
            <Alert tone="success" title={waived ? "Your registration fee was waived" : fee === 0 ? "Nothing to pay" : "Payment received"}>
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
            {gate.canPay ? (
              <>
                {gate.promisedAt && gate.dueAt && gate.missing.length > 0 ? (
                  <Alert tone="info" title={`Documents promised by ${dateIn(gate.dueAt)}`}>
                    Still to provide: {gate.missing.map((d) => SELLER_DOC_LABELS[d]).join(", ")}. Your shop goes live once GoKesari&apos;s team
                    approves it.
                  </Alert>
                ) : null}
                <RegistrationFeePayButton shopId={shop.id} amountPaise={due} />
              </>
            ) : (
              <div className="space-y-3" data-testid="documents-before-fee">
                <Alert tone="warning" title="Documents first">
                  {gate.verified.length === 0
                    ? "Get at least one of your documents verified (for example your PAN) before paying the registration fee."
                    : `Not verified yet: ${gate.missing.map((d) => SELLER_DOC_LABELS[d]).join(", ")}. Verify them, or promise to provide them, before paying.`}
                </Alert>
                {gate.verified.length > 0 ? (
                  <p className="text-sm text-ink-600">Verified: {gate.verified.map((d) => SELLER_DOC_LABELS[d]).join(", ")}</p>
                ) : null}
                <LinkButton href={`/shop/verification?shop=${shop.id}`} className="w-full">
                  Verify my documents
                </LinkButton>
                <p className="text-center text-sm text-ink-500">
                  <Link href={documentsHref} className="underline">
                    Upload document copies
                  </Link>
                </p>
                {gate.canPromise ? <DocumentsPromiseForm shopId={shop.id} promiseDays={followUp.promiseDays} /> : null}
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
