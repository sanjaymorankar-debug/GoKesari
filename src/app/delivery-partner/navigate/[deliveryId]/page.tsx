import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { RiderNavigation } from "@/components/rider-navigation";
import { Alert, PageHeader } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr } from "@/lib/board/i18n";
import { AppError } from "@/lib/errors";
import { getBoardLang } from "@/server/board-lang";
import { getCurrentUser } from "@/server/authz/guards";
import { PERMISSIONS, can } from "@/server/authz/permissions";
import { getDeliveryNavigation, getNavigationTrip, isRiderNavigationEnabled } from "@/server/services/rider-navigation";

export const metadata = { title: "Navigation" };
export const dynamic = "force-dynamic";

/** Module 6 (docs/hindi-marathi-2026-11/). */
const T = {
  title: L("Navigation", "रास्ता", "मार्ग"),
  switchRole: L(
    "Switch to your Delivery Partner role to navigate.",
    "रास्ता देखने के लिए डिलीवरी पार्टनर भूमिका चुनें।",
    "मार्ग पाहण्यासाठी डिलिव्हरी पार्टनर भूमिका निवडा.",
  ),
  loadFailed: L("Navigation could not be loaded.", "रास्ता लोड नहीं हो सका।", "मार्ग लोड करता आला नाही."),
  back: L("Back to my delivery", "मेरी डिलीवरी पर वापस", "माझ्या डिलिव्हरीवर परत"),
} as const;

/**
 * F4.2.2 (batch-2026-10 WS-B): in-app turn-by-turn navigation for the rider's
 * delivery — to the shop, then to the customer. Rule riderNavigation; not
 * found while it is off. Only the rider holding the delivery.
 */
export default async function RiderNavigationPage({ params }: { params: Promise<{ deliveryId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const lang = await getBoardLang();
  if (!(await isRiderNavigationEnabled())) notFound();
  const { deliveryId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(deliveryId)) notFound();
  if (!can(user.role, PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN)) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title={tr(T.title, lang)} />
        <Alert tone="warning">{tr(T.switchRole, lang)}</Alert>
      </div>
    );
  }

  let nav;
  let nextStopId: string | null = null;
  try {
    nav = await getDeliveryNavigation(deliveryId, user.id);
  } catch (error) {
    if (error instanceof AppError && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")) notFound();
    // Module 4 (rule riderNavigation.multiStop): this stop is done — go on to the trip's next stop.
    if (error instanceof AppError && error.code === "CONFLICT") {
      const trip = await getNavigationTrip(user.id);
      if (trip?.nextStop && trip.nextStop.deliveryOrderId !== deliveryId) nextStopId = trip.nextStop.deliveryOrderId;
    }
    if (nextStopId) redirect(`/delivery-partner/navigate/${nextStopId}`);
    const message = error instanceof AppError ? error.message : "Navigation could not be loaded.";
    const message = error instanceof AppError ? errorText(error.message, lang, error.code) : tr(T.loadFailed, lang);
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <PageHeader title={tr(T.title, lang)} />
        <Alert tone="warning">{message}</Alert>
        <Link href="/delivery-partner" className="text-sm font-medium text-kesari-700 underline">
          {tr(T.back, lang)}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={tr(T.title, lang)} />
      <RiderNavigation initial={nav} lang={lang} />
    </div>
  );
}
