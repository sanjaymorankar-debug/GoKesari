/**
 * Help desk lists and headers (F6.3.3, batch-2026-10 WS-C). Presentational:
 * renders what the tickets service returned.
 */
import Link from "next/link";

import { Badge, Card, EmptyState } from "@/components/ui";
import {
  TICKET_CATEGORY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_STAFF_LABELS,
  type TicketCategory,
  type TicketStatus,
} from "@/lib/support-ticket-states";
import { SlaCountdown } from "./sla-countdown";

export interface TicketRowView {
  id: string;
  ticketNumber: string;
  subject: string;
  category: string;
  status: TicketStatus;
  priority: string;
  requesterLabel: string | null;
  orderNumber: string | null;
  assigneeName: string | null;
  updatedAt: string;
  escalationLevel: number;
  sla: { acknowledgeBy: string; resolveBy: string; acknowledged: boolean; resolved: boolean; ackBreached: boolean; resolveBreached: boolean };
}

const TONE: Partial<Record<TicketStatus, "neutral" | "success" | "warning" | "danger" | "info">> = {
  OPEN: "info",
  ACKNOWLEDGED: "info",
  IN_PROGRESS: "info",
  AWAITING_CUSTOMER: "warning",
  AWAITING_SHOP: "warning",
  ESCALATED: "danger",
  REOPENED: "warning",
  RESOLVED: "success",
  CLOSED: "neutral",
};

export function TicketStatusBadge({ status, staff = false }: { status: TicketStatus; staff?: boolean }) {
  return <Badge tone={TONE[status] ?? "neutral"}>{(staff ? TICKET_STATUS_STAFF_LABELS : TICKET_STATUS_LABELS)[status] ?? status}</Badge>;
}

export function TicketList({
  rows,
  hrefBase,
  staff = false,
  emptyTitle,
  emptyDescription,
}: {
  rows: TicketRowView[];
  hrefBase: string;
  staff?: boolean;
  emptyTitle: string;
  emptyDescription?: string;
}) {
  if (rows.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} />;
  return (
    <div className="space-y-3" data-testid="ticket-list">
      {rows.map((t) => {
        const live = !["RESOLVED", "CLOSED"].includes(t.status);
        return (
          <Card key={t.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={`${hrefBase}/${t.id}`} className="font-mono text-sm font-medium text-ink-900 underline">
                  {t.ticketNumber}
                </Link>
                <p className="truncate text-sm text-ink-900">{t.subject}</p>
                <p className="text-xs text-ink-500">
                  {TICKET_CATEGORY_LABELS[t.category as TicketCategory] ?? t.category}
                  {t.orderNumber ? ` · order ${t.orderNumber}` : ""}
                  {staff && t.requesterLabel ? ` · ${t.requesterLabel}` : ""}
                  {staff ? ` · ${t.assigneeName ?? "unassigned"}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <TicketStatusBadge status={t.status} staff={staff} />
                {t.escalationLevel > 0 && staff ? <Badge tone="danger">L{t.escalationLevel + 1}</Badge> : null}
              </div>
            </div>
            {live ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <SlaCountdown label="Acknowledge" dueAt={t.sla.acknowledgeBy} done={t.sla.acknowledged} />
                <SlaCountdown label="Resolve" dueAt={t.sla.resolveBy} done={t.sla.resolved} />
              </div>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

/** Dates → strings for client components and lists. */
export function toRowView(row: {
  id: string;
  ticketNumber: string;
  subject: string;
  category: string;
  status: TicketStatus;
  priority: string;
  requesterLabel: string | null;
  orderNumber: string | null;
  assigneeName: string | null;
  updatedAt: Date;
  escalationLevel: number;
  sla: { acknowledgeBy: Date; resolveBy: Date; acknowledged: boolean; resolved: boolean; ackBreached: boolean; resolveBreached: boolean };
}): TicketRowView {
  return {
    ...row,
    updatedAt: row.updatedAt.toISOString(),
    sla: { ...row.sla, acknowledgeBy: row.sla.acknowledgeBy.toISOString(), resolveBy: row.sla.resolveBy.toISOString() },
  };
}
