import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PrintButton } from "@/components/print-button";
import { Card } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { getPackingSlip } from "@/server/services/packing-slip";

export const metadata = { title: "Packing slip" };
export const dynamic = "force-dynamic";

/** Print only the slip, not Seller Central's frame. */
const PRINT_CSS =
  "@media print { [data-seller-central] > header, [data-seller-central] nav, [data-seller-central] aside { display: none !important; } [data-seller-central] { background: #fff !important; } }";

/**
 * F4.1.3 (batch-2026-10 WS-B): printable packing slip for a packed order —
 * items, quantities, order number, the customer's first name and area only,
 * the short pickup code and the single-use pickup QR (rule pickupQr).
 */
export default async function PackingSlipPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const slip = await getPackingSlip(id, user).catch((error) => {
    if (error instanceof AppError && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")) return null;
    throw error;
  });
  if (!slip) notFound();

  return (
    <div className="mx-auto max-w-xl space-y-4 p-4">
      <style>{PRINT_CSS}</style>
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href="/shop/orders" className="text-sm font-medium text-kesari-700 underline">
          Back to orders
        </Link>
        <PrintButton label="Print packing slip" />
      </div>
      <Card className="space-y-4 p-6 text-sm print:border-0 print:shadow-none" data-testid="packing-slip">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-ink-900">Packing slip</h1>
            <p className="text-ink-600">{slip.shopName}</p>
          </div>
          <div className="text-right">
            <p className="font-mono text-lg font-bold text-ink-900">{slip.orderNumber}</p>
            <p className="text-ink-600">
              {new Date(slip.placedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}
            </p>
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase text-ink-500">For</p>
          <p className="font-medium text-ink-900">{slip.customerFirstName}</p>
          <p className="text-ink-600">{slip.customerArea}</p>
        </div>

        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-cream-200 text-left text-xs uppercase text-ink-500">
              <th className="py-1">Item</th>
              <th className="py-1 text-right">Qty</th>
            </tr>
          </thead>
          <tbody>
            {slip.items.map((item, i) => (
              <tr key={i} className="border-b border-cream-100">
                <td className="py-1.5">
                  {item.name}
                  {item.note ? <span className="text-xs text-ink-500"> ({item.note})</span> : null}
                </td>
                <td className="py-1.5 text-right font-medium">{item.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {slip.paymentNote ? <p className="font-medium text-kesari-800">{slip.paymentNote}</p> : null}

        <div className="flex flex-wrap items-center gap-4 border-t border-cream-200 pt-4">
          {slip.qr ? (
            // Server-rendered QR (qrcode library) of our own signed payload — no user input.
            <div className="h-40 w-40 shrink-0 bg-white" data-testid="packing-slip-qr" dangerouslySetInnerHTML={{ __html: slip.qr.svg }} />
          ) : null}
          <div>
            <p className="text-xs font-semibold uppercase text-ink-500">Rider pickup</p>
            {slip.qr ? <p className="text-ink-700">The rider scans this QR at handover. It works once.</p> : null}
            {slip.pickupCode ? (
              <p className="mt-1 text-ink-700">
                Pickup code: <span className="font-mono text-2xl font-bold tracking-widest">{slip.pickupCode}</span>
              </p>
            ) : (
              <p className="mt-1 text-ink-500">The 4-digit pickup code appears on the order once a rider accepts.</p>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
