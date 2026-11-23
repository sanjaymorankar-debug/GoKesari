import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Alert, Card, Money, PageHeader, StatusBadge } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { L, tr } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getOrderGroupForUser } from "@/server/services/order-groups";

export const metadata = { title: "Order" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Order {n}", "ऑर्डर {n}", "ऑर्डर {n}"),
  shop: L("shop", "दुकान", "दुकान"),
  shops: L("shops", "दुकानें", "दुकाने"),
  placed: L("placed", "ऑर्डर किया", "ऑर्डर दिली"),
  placedTitle: L("Order placed", "ऑर्डर हो गया", "ऑर्डर दिली"),
  placedText: L(
    "Your order {n} is confirmed. Each shop prepares and delivers its part separately.",
    "आपका ऑर्डर {n} पक्का हो गया है। हर दुकान अपना हिस्सा अलग से तैयार करके डिलीवर करेगी।",
    "तुमची ऑर्डर {n} निश्चित झाली आहे. प्रत्येक दुकान आपला भाग स्वतंत्रपणे तयार करून पोहोचवेल.",
  ),
  total: L("Total", "कुल", "एकूण"),
  trackEach: L("Track each shop's delivery in My Orders →", "मेरे ऑर्डर में हर दुकान की डिलीवरी ट्रैक करें →", "माझ्या ऑर्डरमध्ये प्रत्येक दुकानाची डिलिव्हरी ट्रॅक करा →"),
} as const;

/** F6: one parent reference over a multi-shop order; each shop's part is its own order. */
export default async function OrderGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<{ placed?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { reference } = await params;
  const [{ placed }, lang] = await Promise.all([searchParams, getBoardLang()]);
  const group = await getOrderGroupForUser(user.id, decodeURIComponent(reference)).catch((error) => {
    if (error instanceof AppError && error.code === "NOT_FOUND") return null;
    throw error;
  });
  if (!group) notFound();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title={tr(T.title, lang).replace("{n}", group.reference)}
        description={`${group.orders.length} ${tr(group.orders.length === 1 ? T.shop : T.shops, lang)} · ${tr(T.placed, lang)} ${group.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}`}
      />
      {placed ? (
        <Alert tone="success" title={tr(T.placedTitle, lang)}>
          {tr(T.placedText, lang).replace("{n}", group.reference)}
        </Alert>
      ) : null}
      <div className="space-y-3">
        {group.orders.map((o) => (
          <Card key={o.id} className="flex items-center justify-between gap-3 p-4" data-testid="sub-order">
            <div>
              <p className="font-medium text-ink-900">{o.shopName}</p>
              <p className="text-xs text-ink-500">{o.orderNumber}</p>
            </div>
            <div className="flex items-center gap-3">
              <StatusBadge status={o.status} />
              <span className="font-semibold text-ink-900">
                <Money paise={o.totalPaise} />
              </span>
            </div>
          </Card>
        ))}
      </div>
      <Card className="flex justify-between p-4 text-base font-semibold text-ink-900">
        <span>{tr(T.total, lang)}</span>
        <Money paise={group.totalPaise} />
      </Card>
      <Link href="/orders" className="text-sm text-kesari-700 hover:underline">
        {tr(T.trackEach, lang)}
      </Link>
    </div>
  );
}
