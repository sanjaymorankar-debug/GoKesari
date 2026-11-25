import Link from "next/link";
import { L, tr } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";
import { notFound, redirect } from "next/navigation";

import { TicketDetailView } from "@/components/aftercare/ticket-detail-view";
import { PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { getTicketDetail } from "@/server/aftercare/support-tickets";

export const metadata = { title: "Support ticket" };
export const dynamic = "force-dynamic";

const T = { back: L("← Support tickets", "← सहायता टिकट", "← मदत तिकिटे") } as const;

/** A ticket about the shop's order, while support waits for the shop (F6.3.3, batch-2026-10 WS-C). */
export default async function ShopTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  const detail = await getTicketDetail(id, user).catch((error) => {
    if (error instanceof AppError) notFound();
    throw error;
  });
  if (detail.access === "REQUESTER") redirect(`/support/${id}`);
  const lang = await getBoardLang();
  return (
    <>
      <PageHeader title={detail.ticket.subject} description={<Link href="/shop/support" className="underline">{tr(T.back, lang)}</Link>} />
      <TicketDetailView detail={detail} />
    </>
  );
}
