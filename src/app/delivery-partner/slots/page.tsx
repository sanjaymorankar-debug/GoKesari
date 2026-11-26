/**
 * My Slots (Rider App v2, rule riderSlotBooking). Off: this page does not exist.
 * Optional booking of the admin's bookable earning slots for the next days.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { SlotBooker } from "@/components/rider-growth/slot-booker";
import { RG } from "@/components/rider-growth/text";
import { Alert, PageHeader } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { listBookableSlots } from "@/server/services/rider-slot-bookings";

export const metadata = { title: "My Slots" };
export const dynamic = "force-dynamic";

export default async function RiderSlotsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/delivery-partner/slots");
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) redirect("/delivery-partner");
  const [view, lang] = await Promise.all([listBookableSlots(partner.id), getBoardLang()]);
  if (!view.enabled) notFound();

  return (
    <div className="mx-auto max-w-2xl" data-testid="rider-slots-page">
      <PageHeader title={tr(RG.slotsTitle, lang)} description={tr(RG.slotsIntro, lang)} />
      {partner.status !== "APPROVED" ? (
        <Alert tone="warning">{tr(RG.notApproved, lang)}</Alert>
      ) : (
        <SlotBooker
          lang={lang}
          cancelCutoffMinutes={view.cancelCutoffMinutes}
          days={view.days.map((d) => ({
            date: d.date,
            slots: d.slots.map((s) => ({
              slotId: s.slotId,
              name: s.name,
              date: s.date,
              startTime: s.startTime,
              endTime: s.endTime,
              boost: s.boost,
              booked: s.booked,
              capacity: s.capacity,
              full: s.full,
              myBookingId: s.myBookingId,
              canBook: s.canBook,
              canCancel: s.canCancel,
            })),
          }))}
        />
      )}
      <Link href="/delivery-partner" className="mt-4 inline-flex min-h-12 items-center text-sm font-semibold text-kesari-700 underline">
        {tr(RG.back, lang)}
      </Link>
    </div>
  );
}
