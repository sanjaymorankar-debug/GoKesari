import Link from "next/link";
import { redirect } from "next/navigation";

import { Alert, Card, EmptyState, PageHeader } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { listBookings } from "@/server/delivery/admin";
import { BOOKING_STATUS_LABELS } from "@/server/delivery/bookings";
import { TERMINAL_BOOKING_STATUSES } from "@/server/db/hdms-schema";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Partner deliveries" };
export const dynamic = "force-dynamic";

const time = (d: Date | null) => (d ? d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—");

/** docs/hdms-2026-11: the shop's orders carried by a delivery partner — ongoing first, then history. Own shop only. */
export default async function ShopDeliveriesPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title="Partner deliveries" />
        <EmptyState title="You haven't registered a shop yet" />
      </>
    );
  }
  const shop = await activeShop(shops, (await searchParams).shop);
  const [rows, enabled] = await Promise.all([listBookings({ shopId: shop.id, limit: 100 }), isFeatureEnabled("hdms_enabled", { districtCode: null })]);
  const ongoing = rows.filter((r) => !TERMINAL_BOOKING_STATUSES.includes(r.booking.status));
  const past = rows.filter((r) => TERMINAL_BOOKING_STATUSES.includes(r.booking.status));
  const list = (items: typeof rows) => (
    <Card className="divide-y divide-cream-100">
      {items.map(({ booking: b, orderNumber }) => (
        <div key={b.id} className="flex flex-wrap items-start justify-between gap-2 p-4 text-sm">
          <div>
            <p className="font-medium text-ink-900">
              Order {orderNumber} · {b.providerCode}
            </p>
            <p className="text-ink-600">
              {BOOKING_STATUS_LABELS[b.status]}
              {b.riderName ? ` · ${b.riderName} ${b.riderPhoneMasked ?? ""}` : ""}
              {b.etaAt && !TERMINAL_BOOKING_STATUSES.includes(b.status) ? ` · ETA ${time(b.etaAt)}` : ""}
            </p>
            {b.cancelReason || b.failureReason ? <p className="text-xs text-ink-500">{b.cancelReason ?? b.failureReason}</p> : null}
            {b.pricing && b.pricing.shopPaise > 0 ? <p className="text-xs text-ink-500">Your share of the delivery: ₹{(b.pricing.shopPaise / 100).toFixed(2)} (from your wallet at delivery)</p> : null}
          </div>
          <div className="text-right text-xs text-ink-500">
            <p>Booked {time(b.createdAt)}</p>
            {b.trackingUrl ? (
              <a className="text-kesari-600 hover:underline" href={b.trackingUrl} target="_blank" rel="noopener noreferrer">
                Track
              </a>
            ) : null}
          </div>
        </div>
      ))}
    </Card>
  );
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Partner deliveries"
        description={`${shop.name} — orders GoKesari handed to a delivery partner when no rider was free.`}
        action={
          <Link href="/shop/delivery-staff" className="text-sm font-medium text-kesari-600 hover:underline">
            Your delivery staff →
          </Link>
        }
      />
      {!enabled ? <Alert tone="info">Delivery partners are not switched on yet. Your orders go to your own staff or GoKesari riders as before.</Alert> : null}
      <h2 className="text-base font-semibold">Ongoing</h2>
      {ongoing.length ? list(ongoing) : <p className="text-sm text-ink-500">Nothing on the way right now.</p>}
      <h2 className="text-base font-semibold">History</h2>
      {past.length ? list(past) : <p className="text-sm text-ink-500">No partner deliveries yet.</p>}
    </div>
  );
}
