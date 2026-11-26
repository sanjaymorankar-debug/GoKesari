/**
 * docs/guest-checkout-2026-11: find an order without signing in — the order reference plus the
 * last 4 digits of the mobile number, or the e-mail and a one-time code. Leads to /track/<token>.
 * 404 unless guest_cart_enabled and guest_checkout_enabled are both on.
 */
import { notFound } from "next/navigation";

import { TrackLookupForm } from "@/components/guest-checkout/track-lookup-form";
import { PageHeader } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { GC } from "@/lib/guest-checkout-i18n";
import { getBoardLang } from "@/server/board-lang";
import { isGuestCheckoutOn } from "@/server/guest-checkout/tracking";

export const metadata = { title: "Track order", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function TrackLookupPage() {
  if (!(await isGuestCheckoutOn())) notFound();
  const lang = await getBoardLang();
  return (
    <div className="mx-auto max-w-md space-y-4">
      <PageHeader title={tr(GC.trackTitle, lang)} description={tr(GC.trackIntro, lang)} />
      <TrackLookupForm lang={lang} />
    </div>
  );
}
