import { notFound, redirect } from "next/navigation";

import { PrintButton } from "@/components/print-button";
import { Card } from "@/components/ui";
import { getEnv } from "@/lib/env";
import { formatPaise } from "@/lib/money";
import { formatGstRate } from "@/lib/registration-fee";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { membershipReceipt } from "@/server/services/shop-membership-renewal";

export const metadata = { title: "Membership receipt" };
export const dynamic = "force-dynamic";

/**
 * A printable receipt for one membership period — a renewal or the registration that started it
 * (docs/shop-membership-renewal-2026-11). The owner's own shop, or any shop for staff who may view
 * payments. GST is shown as it was charged (the GST tax invoice itself is issued by GoKesari finance).
 */
export default async function MembershipReceiptPage({ params }: { params: Promise<{ periodId: string }> }) {
  const user = await getCurrentUser();
  const { periodId } = await params;
  if (!user) redirect(`/signin?callbackUrl=/shop/membership/receipt/${periodId}`);
  if (!/^[0-9a-f-]{36}$/i.test(periodId)) notFound();
  const receipt = await membershipReceipt(periodId, { id: user.id, canViewAny: can(user.role, PERMISSIONS.PAYMENT_VIEW_ANY) }).catch(() => null);
  if (!receipt) notFound();
  const { period, shop, payment } = receipt;
  const day = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: getEnv().APP_TIMEZONE });
  const hasGst = period.basePaise != null && period.gstPaise != null && period.gstRateBp != null && period.gstPaise > 0;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <Card className="space-y-3 p-6 print:shadow-none">
        <h1 className="text-xl font-bold text-ink-900">
          Payment receipt — GoKesari shop membership {period.kind === "RENEWAL" ? "renewal" : "(registration)"}
        </h1>
        <p className="text-sm text-ink-700">ASMY Global Trading and Consulting India Private Limited (AGTCI) · gokesari.com</p>
        <p className="text-sm text-ink-700">
          Received from <strong>{shop.ownerName}</strong> for <strong>{shop.name}</strong> (shop no. {shop.registrationNumber})
          {shop.gstin ? ` · GSTIN ${shop.gstin}` : ""}
          <br />
          {[shop.addressLine1, shop.city, shop.pincode].filter(Boolean).join(", ")}
        </p>
        {period.voidedAt ? <p className="text-sm font-semibold text-red-700">This period was taken back on {day(period.voidedAt)} ({period.voidReason}).</p> : null}
        <table className="min-w-full text-sm">
          <tbody>
            <tr className="border-b border-cream-100">
              <td className="py-1 pr-2">Membership period</td>
              <td className="py-1 text-right">
                {day(period.periodStart)} – {day(period.periodEnd)}
              </td>
            </tr>
            {hasGst ? (
              <>
                <tr>
                  <td className="py-1 pr-2">Membership fee</td>
                  <td className="py-1 text-right">{formatPaise(period.basePaise!)}</td>
                </tr>
                <tr>
                  <td className="py-1 pr-2">GST {formatGstRate(period.gstRateBp!)}</td>
                  <td className="py-1 text-right">{formatPaise(period.gstPaise!)}</td>
                </tr>
              </>
            ) : null}
            <tr className="font-bold">
              <td className="py-1 pr-2">Total{hasGst ? "" : " (GST included where applicable)"}</td>
              <td className="py-1 text-right">{formatPaise(period.feePaise)}</td>
            </tr>
          </tbody>
        </table>
        <p className="text-xs text-ink-500">
          {payment
            ? `Receipt ${payment.reference} · paid ${day(payment.paidAt)} · ${payment.method.replace(/_/g, " ")}${payment.transactionId ? ` · ref ${payment.transactionId}` : ""}. `
            : ""}
          The GST tax invoice is issued by GoKesari finance.
        </p>
        <div className="print:hidden">
          <PrintButton label="Print or save as PDF" />
        </div>
      </Card>
    </div>
  );
}
