import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { DisputeOpenForm } from "@/components/dispute-case";
import { LinkButton, PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { db } from "@/server/db";
import { orders } from "@/server/db/schema";
import { getLiveDisputesForOrders } from "@/server/services/disputes";

export const metadata = { title: "Raise a dispute" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Raise a dispute — {n}", "विवाद दर्ज करें — {n}", "वाद नोंदवा — {n}"),
  description: L(
    "Tell us what went wrong. You get a case number straight away, and the shop and our support team are told.",
    "बताइए क्या गलत हुआ। आपको तुरंत केस नंबर मिलेगा, और दुकान व हमारी सपोर्ट टीम को सूचना दी जाएगी।",
    "काय चुकले ते सांगा. तुम्हाला लगेच केस नंबर मिळेल, आणि दुकान व आमच्या सपोर्ट टीमला कळवले जाईल.",
  ),
  myOrders: L("My orders", "मेरे ऑर्डर", "माझ्या ऑर्डर"),
} as const;

/** Event layer: the customer opens a dispute on a delivered order and gets a case number at once. */
export default async function RaiseDisputePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, id),
    columns: { id: true, userId: true, orderNumber: true, status: true, totalPaise: true },
  });
  if (!order || order.userId !== user.id) notFound();
  // One live case per order: go to it instead of opening another.
  const live = (await getLiveDisputesForOrders([order.id])).get(order.id);
  if (live) redirect(`/disputes/${live.id}`);
  if (order.status !== "DELIVERED" && order.status !== "DISPUTED") redirect("/orders");
  const lang = await getBoardLang();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={tr(T.title, lang).replace("{n}", order.orderNumber)}
        description={tr(T.description, lang)}
        action={<LinkButton href="/orders" variant="secondary">{tr(T.myOrders, lang)}</LinkButton>}
      />
      <DisputeOpenForm orderId={order.id} orderTotalPaise={order.totalPaise} />
    </div>
  );
}
