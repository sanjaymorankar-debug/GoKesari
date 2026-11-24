import Link from "next/link";
import { L, tr } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";
import { redirect } from "next/navigation";

import { DeliveryStaffManager } from "@/components/delivery-staff-manager";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { listDeliveryStaff, getSlotRules } from "@/server/services/fulfilment-options";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Delivery staff" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Delivery staff", "डिलीवरी स्टाफ", "डिलिव्हरी कर्मचारी"),
  noShop: L("You haven't registered a shop yet", "आपने अभी कोई दुकान रजिस्टर नहीं की है", "तुम्ही अजून दुकान नोंदवलेले नाही"),
  description: L("{shop} — the people who deliver your orders themselves.", "{shop} — वे लोग जो आपके ऑर्डर खुद डिलीवर करते हैं।", "{shop} — तुमच्या ऑर्डर स्वतः पोहोचवणारे लोक."),
  orders: L("Orders →", "ऑर्डर →", "ऑर्डर →"),
  notOn: L(
    "Choosing your own delivery for an order is not switched on yet. You can add your team now.",
    "ऑर्डर के लिए अपनी डिलीवरी चुनना अभी चालू नहीं है। आप अपनी टीम अभी जोड़ सकते हैं।",
    "ऑर्डरसाठी स्वतःची डिलिव्हरी निवडणे अजून सुरू नाही. तुम्ही तुमची टीम आत्ता जोडू शकता.",
  ),
} as const;

/** The shop's own delivery people (docs/four-features-2026-10, feature 1). */
export default async function DeliveryStaffPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const [shops, lang] = await Promise.all([listShopsForOwner(user.id), getBoardLang()]);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title={tr(T.title, lang)} />
        <EmptyState title={tr(T.noShop, lang)} />
      </>
    );
  }
  const params = await searchParams;
  const shop = await activeShop(shops, params.shop);
  const [staff, rules] = await Promise.all([listDeliveryStaff(shop.id), getSlotRules()]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title={tr(T.title, lang)}
        description={tr(T.description, lang).replace("{shop}", shop.name)}
        action={
          <Link href="/shop/orders" className="text-sm font-medium text-kesari-600 hover:underline">
            {tr(T.orders, lang)}
          </Link>
        }
      />
      {!rules.enabled ? (
        <Alert tone="info">{tr(T.notOn, lang)}</Alert>
      ) : null}
      <DeliveryStaffManager shopId={shop.id} staff={staff} lang={lang} />
    </div>
  );
}
