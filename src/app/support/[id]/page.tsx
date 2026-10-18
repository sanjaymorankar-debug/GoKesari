import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { TicketDetailView } from "@/components/aftercare/ticket-detail-view";
import { PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { getTicketDetail } from "@/server/aftercare/support-tickets";

export const metadata = { title: "Support ticket" };
export const dynamic = "force-dynamic";

/** A ticket as its requester sees it (F6.3.3, batch-2026-10 WS-C): no internal notes. */
export default async function SupportTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/support");
  const { id } = await params;
  const query = await searchParams;
  const detail = await getTicketDetail(id, user).catch((error) => {
    if (error instanceof AppError) notFound();
    throw error;
  });
  // Support works tickets in the console.
  if (detail.access === "STAFF" && detail.ticket.requesterId !== user.id) redirect(`/admin/support/${id}`);
  if (detail.access === "SHOP") redirect(`/shop/support/${id}`);
  return (
    <>
      <PageHeader title={detail.ticket.subject} description={<Link href="/support" className="underline">← My tickets</Link>} />
      <TicketDetailView detail={detail} created={query.created === "1"} />
    </>
  );
}
