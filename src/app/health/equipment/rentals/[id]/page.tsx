import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { RentalScreen } from "@/components/health/equipment";
import { ComingSoon } from "@/components/health/page-shell";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { rentalView } from "@/server/health/rentals";

export const metadata = { title: "Equipment rental" };
export const dynamic = "force-dynamic";

/**
 * One rental for the customer: status, delivery code, extend, return pickup, deposit refund. Also the
 * payment return page (?intent=): the rental shows booked once the signed webhook has arrived.
 */
export default async function RentalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ intent?: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=/health/equipment/rentals/${id}`);
  if (!(await healthEnabled())) return <ComingSoon title="Equipment rental" />;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const view = await rentalView(id, user).catch(() => null);
  if (!view) notFound();
  if (view.viewer === "STORE") redirect(`/shop/health/equipment/rentals/${id}`);
  const sp = await searchParams;
  if (sp.intent && /^[0-9a-f-]{36}$/i.test(sp.intent)) {
    // Back from the gateway: ask it once for the latest state (the webhook may still be on its way).
    const { getPaymentStatusForCustomer } = await import("@/server/payments/order-payments");
    await getPaymentStatusForCustomer(user.id, sp.intent).catch(() => null);
  }
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/health/equipment/rentals" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← My rentals
      </Link>
      <RentalScreen rentalId={id} />
    </div>
  );
}
