import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { TicketDetailView } from "@/components/aftercare/ticket-detail-view";
import { PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getTicketDetail, listAssignableStaff, listCannedReplies } from "@/server/aftercare/support-tickets";

export const metadata = { title: "Ticket" };
export const dynamic = "force-dynamic";

/** Support's view of a ticket: internal notes, canned replies, status, assignment, escalation (batch-2026-10 WS-C). */
export default async function HelpDeskTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SUPPORT_TICKET_MANAGE)) redirect("/");
  const { id } = await params;
  const detail = await getTicketDetail(id, user).catch((error) => {
    if (error instanceof AppError) notFound();
    throw error;
  });
  const [canned, staff] = await Promise.all([listCannedReplies(user), listAssignableStaff()]);
  return (
    <>
      <PageHeader title={detail.ticket.subject} description={<Link href="/admin/support" className="underline">← Help desk</Link>} />
      <TicketDetailView detail={detail} cannedReplies={canned.map((c) => ({ id: c.id, title: c.title }))} staffList={staff} />
    </>
  );
}
