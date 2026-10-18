import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { TicketDetailView } from "@/components/aftercare/ticket-detail-view";
import { PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { getTicketDetail } from "@/server/aftercare/support-tickets";

export const metadata = { title: "Support ticket" };
export const dynamic = "force-dynamic";

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
  return (
    <>
      <PageHeader title={detail.ticket.subject} description={<Link href="/shop/support" className="underline">← Support tickets</Link>} />
      <TicketDetailView detail={detail} />
    </>
  );
}
