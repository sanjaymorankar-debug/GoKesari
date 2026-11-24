import { notFound, redirect } from "next/navigation";

import { ReturnRequestForm } from "@/components/return-request-form";
import { LinkButton, PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getReturnableOrder } from "@/server/services/returns";

export const metadata = { title: "Return items" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Return items — {n}", "सामान लौटाएँ — {n}", "वस्तू परत करा — {n}"),
  description: L(
    "Tell us what is wrong and we will arrange the return.",
    "बताइए क्या गड़बड़ है, हम रिटर्न की व्यवस्था करेंगे।",
    "काय चुकीचे आहे ते सांगा, आम्ही परत घेण्याची व्यवस्था करू.",
  ),
  myReturns: L("My returns", "मेरे रिटर्न", "माझे परतावे"),
} as const;

export default async function ReturnOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const order = await getReturnableOrder(id, user.id).catch(() => null);
  if (!order) notFound();
  const lang = await getBoardLang();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={tr(T.title, lang).replace("{n}", order.orderNumber)}
        description={tr(T.description, lang)}
        action={<LinkButton href="/returns" variant="secondary">{tr(T.myReturns, lang)}</LinkButton>}
      />
      <ReturnRequestForm order={order} lang={lang} />
    </div>
  );
}
