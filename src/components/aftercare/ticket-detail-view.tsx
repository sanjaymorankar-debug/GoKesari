/**
 * A ticket page's body, shared by the portal (/support/[id]), the shop
 * (/shop/support/[id]) and the console (/admin/support/[id]). Renders the
 * detail the tickets service returned for this viewer (batch-2026-10 WS-C).
 */
import Link from "next/link";

import { Alert, Card } from "@/components/ui";
import type { TicketDetail } from "@/server/aftercare/support-tickets";
import { SlaCountdown } from "./sla-countdown";
import { TicketStatusBadge } from "./ticket-views";
import { TicketThread } from "./ticket-thread";

const when = (d: Date) => d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export function TicketDetailView({
  detail,
  cannedReplies,
  staffList,
  created,
}: {
  detail: TicketDetail;
  cannedReplies?: { id: string; title: string }[];
  staffList?: { id: string; label: string }[];
  created?: boolean;
}) {
  const { ticket, access } = detail;
  const staff = access === "STAFF";
  const live = !["RESOLVED", "CLOSED"].includes(ticket.status);
  return (
    <div className="space-y-4">
      {created ? (
        <Alert tone="success" title={`Ticket ${ticket.ticketNumber} raised`}>
          We will acknowledge it by {when(ticket.acknowledgeBy)} and aim to resolve it by {when(ticket.resolveBy)}. You are told of every update.
        </Alert>
      ) : null}
      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-ink-600">{ticket.ticketNumber}</span>
          <TicketStatusBadge status={detail.ticket.status as never} staff={staff} />
          {staff ? <span className="text-xs text-ink-500">Priority {ticket.priority.toLowerCase()}</span> : null}
        </div>
        <p className="text-sm text-ink-600">
          {detail.categoryLabel}
          {detail.orderNumber ? ` · order ${detail.orderNumber}` : ""}
          {detail.grievanceNumber ? ` · grievance ${detail.grievanceNumber}` : ""}
          {staff ? ` · ${ticket.requesterName ?? ticket.requesterEmail ?? "anonymous"} (${ticket.requesterRole.toLowerCase().replace("_", " ")})` : ""}
          {staff ? ` · ${detail.assigneeName ?? "unassigned"}` : ""}
        </p>
        {detail.disputeId ? (
          <p className="text-sm">
            <Link href={staff ? `/admin/disputes` : `/disputes/${detail.disputeId}`} className="text-kesari-700 underline">
              This order also has an open dispute
            </Link>{" "}
            — the shop and support handle it there.
          </p>
        ) : null}
        <p className="whitespace-pre-wrap text-sm text-ink-900">{ticket.description}</p>
        {live ? (
          <div className="flex flex-wrap gap-2 pt-1">
            <SlaCountdown label="Acknowledge" dueAt={ticket.acknowledgeBy.toISOString()} done={detail.sla.acknowledged} />
            <SlaCountdown label="Resolve" dueAt={ticket.resolveBy.toISOString()} done={detail.sla.resolved} />
          </div>
        ) : ticket.resolutionNote ? (
          <p className="text-sm text-ink-600">
            <strong>Resolution:</strong> {ticket.resolutionNote}
          </p>
        ) : null}
      </Card>

      <TicketThread
        ticketId={ticket.id}
        access={access}
        messages={detail.messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }))}
        files={detail.attachments.map((f) => ({ id: f.id, fileName: f.fileName, contentType: f.contentType, sizeBytes: f.sizeBytes, internal: f.internal }))}
        can={detail.can}
        csat={detail.csat}
        cannedReplies={cannedReplies}
        staff={staffList}
        assigneeId={ticket.assignedToUserId}
      />

      <Card className="p-4">
        <p className="mb-2 text-sm font-medium text-ink-700">History</p>
        <ol className="space-y-1 border-l-2 border-cream-200 pl-4 text-sm" data-testid="ticket-history">
          {detail.events.map((e, i) => (
            <li key={i}>
              <span className="text-xs text-ink-500">{when(e.createdAt)}</span>{" "}
              <span className="text-ink-900">{e.toStatus && e.kind === "STATUS" ? `→ ${e.toStatus.toLowerCase().replace(/_/g, " ")}` : e.kind.toLowerCase().replace(/_/g, " ")}</span>
              {e.note ? <span className="text-ink-600"> — {e.note}</span> : null}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
