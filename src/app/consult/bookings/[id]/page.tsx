import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConsultBookingView } from "@/components/consult/booking-view";
import { Alert } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { bookingViewer } from "@/server/consult/access";
import { db } from "@/server/db";
import { consultBookings } from "@/server/db/schema";
import { eq } from "drizzle-orm";

export const metadata = { title: "Appointment" };
export const dynamic = "force-dynamic";

/**
 * One appointment (docs/consult-booking-2026-11). Also the payment return page: the gateway sends the
 * customer back here with ?intent=; the booking shows confirmed once the signed webhook has arrived.
 */
export default async function BookingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ intent?: string; new?: string }> }) {
  const user = await getCurrentUser();
  const { id } = await params;
  if (!user) redirect(`/signin?callbackUrl=/consult/bookings/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, id));
  if (!b) notFound();
  await bookingViewer(b, user).catch(() => notFound());
  const sp = await searchParams;
  if (sp.intent) {
    // Back from the gateway: ask it once for the latest state (the webhook may still be on its way).
    const { getPaymentStatusForCustomer } = await import("@/server/payments/order-payments");
    await getPaymentStatusForCustomer(user.id, sp.intent).catch(() => null);
  }
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/consult/bookings" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← My appointments
      </Link>
      {sp.new ? <div className="mb-3"><Alert tone="success" title="Booked">You will get a reminder 24 hours and 1 hour before.</Alert></div> : null}
      <ConsultBookingView bookingId={id} />
    </div>
  );
}
