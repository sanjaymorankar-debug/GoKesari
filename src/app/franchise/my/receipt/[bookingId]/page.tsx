import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { Card } from "@/components/ui";
import { formatIst, rupees } from "@/lib/franchise";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { dealers, franchiseAllocations, franchiseBookings, franchiseZones, paymentIntents } from "@/server/db/schema";

export const metadata = { title: "Franchise receipt" };
export const dynamic = "force-dynamic";

/** A printable payment receipt for a paid franchise booking (the owner's own, or any for an admin). */
export default async function FranchiseReceipt({ params }: { params: Promise<{ bookingId: string }> }) {
  const user = await getCurrentUser();
  const { bookingId } = await params;
  if (!user) redirect(`/signin?callbackUrl=/franchise/my/receipt/${bookingId}`);
  if (!/^[0-9a-f-]{36}$/.test(bookingId)) notFound();
  const [row] = await db.select({ b: franchiseBookings, owner: dealers }).from(franchiseBookings).innerJoin(dealers, eq(dealers.id, franchiseBookings.ownerDealerId)).where(eq(franchiseBookings.id, bookingId));
  if (!row || row.b.status !== "PAID" || (row.owner.userId !== user.id && user.role !== "ADMIN")) notFound();
  const { b, owner } = row;
  const cols = { zoneId: franchiseAllocations.zoneId, name: franchiseZones.name, expiresAt: franchiseAllocations.expiresAt, feePaise: franchiseAllocations.feePaise, discountPaise: franchiseAllocations.discountPaise, tier: franchiseAllocations.tier };
  const rows = b.kind === "RENEWAL"
    ? await db.select(cols).from(franchiseAllocations).innerJoin(franchiseZones, eq(franchiseZones.zoneId, franchiseAllocations.zoneId)).where(eq(franchiseAllocations.id, b.renewalAllocationId!))
    : await db.select(cols).from(franchiseAllocations).innerJoin(franchiseZones, eq(franchiseZones.zoneId, franchiseAllocations.zoneId)).where(and(eq(franchiseAllocations.bookingId, b.id)));
  // A renewal's own amounts are on the booking (the allocation carries the latest term's fee).
  const zones = b.kind === "RENEWAL" ? rows.map((r) => ({ ...r, feePaise: b.listPaise, discountPaise: b.discountPaise })) : rows;
  const tierName = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();
  const [intent] = b.paymentIntentId ? await db.select({ gateway: paymentIntents.gateway, gatewayPaymentId: paymentIntents.gatewayPaymentId }).from(paymentIntents).where(eq(paymentIntents.id, b.paymentIntentId)) : [];
  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <Card className="space-y-3 p-6 print:shadow-none">
        <h1 className="text-xl font-bold text-ink-900">Payment receipt — GoKesari Territory Franchise</h1>
        <p className="text-sm text-ink-700">ASMY Global Trading and Consulting India Private Limited (AGTCI) · gokesari.com</p>
        <p className="text-sm text-ink-700">
          Received from <strong>{owner.legalName}</strong> · {b.kind === "RENEWAL" ? "Renewal (12 months)" : "New franchise zones"} · paid {formatIst(b.paidAt)}
        </p>
        <table className="min-w-full text-sm">
          <tbody>
            {zones.map((z) => (
              <tr key={z.zoneId} className="border-b border-cream-100">
                <td className="py-1 pr-2">
                  <span className="font-semibold">{z.zoneId}</span> {z.name} · {tierName(z.tier)}
                  <div className="text-xs text-ink-500">valid until {formatIst(z.expiresAt)}</div>
                </td>
                <td className="py-1 pr-2 text-right">Zone fee {rupees(z.feePaise)}</td>
                <td className="py-1 text-right">{z.discountPaise ? `− ${rupees(z.discountPaise)}` : ""}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={2} className="py-1 pr-2 text-right">Zone fees</td>
              <td className="py-1 text-right">{rupees(b.listPaise)}</td>
            </tr>
            {b.couponCode ? (
              <tr>
                <td colSpan={2} className="py-1 pr-2 text-right">Coupon {b.couponCode}</td>
                <td className="py-1 text-right">− {rupees(b.discountPaise)}</td>
              </tr>
            ) : null}
            <tr>
              <td colSpan={2} className="py-1 pr-2 text-right">Taxable amount</td>
              <td className="py-1 text-right">{rupees(b.basePaise)}</td>
            </tr>
            <tr>
              <td colSpan={2} className="py-1 pr-2 text-right">GST {b.gstRateBp / 100}%</td>
              <td className="py-1 text-right">{rupees(b.gstPaise)}</td>
            </tr>
            <tr className="font-bold">
              <td colSpan={2} className="py-1 pr-2 text-right">Total paid</td>
              <td className="py-1 text-right">{rupees(b.totalPaise)}</td>
            </tr>
          </tbody>
        </table>
        <p className="text-xs text-ink-500">
          Booking {b.id} · payment {intent?.gatewayPaymentId ?? b.paymentIntentId ?? "—"} ({intent?.gateway ?? "gateway"}). The GST tax invoice is issued by GoKesari finance with the GSTINs (rates as confirmed by AGTCI&apos;s CA). Non-refundable, subject to applicable law.
        </p>
      </Card>
    </div>
  );
}
