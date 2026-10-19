import Link from "next/link";
import { redirect } from "next/navigation";

import { ListTabs } from "@/components/board/list-tabs";
import { TicketList, toRowView } from "@/components/aftercare/ticket-views";
import { inputClass, LinkButton, PageHeader } from "@/components/ui";
import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_STAFF_LABELS,
  type TicketCategory,
  type TicketStatus,
} from "@/lib/support-ticket-states";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listTicketQueue, queueCounts, type QueueKey } from "@/server/aftercare/support-tickets";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Help desk" };
export const dynamic = "force-dynamic";

const QUEUES: { key: QueueKey; label: string; urgent?: boolean }[] = [
  { key: "open", label: "Open" },
  { key: "unassigned", label: "Unassigned", urgent: true },
  { key: "mine", label: "Mine" },
  { key: "breached", label: "SLA breached", urgent: true },
  { key: "escalated", label: "Escalated", urgent: true },
  { key: "awaiting", label: "Awaiting reply" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "All" },
];

/**
 * The support console (F6.3.3, batch-2026-10 WS-C): queues by status,
 * category and SLA breach, with acknowledge-by / resolve-by countdowns.
 * Operators and admins.
 */
export default async function HelpDeskPage({
  searchParams,
}: {
  searchParams: Promise<{ queue?: string; status?: string; category?: string; q?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SUPPORT_TICKET_MANAGE)) redirect("/");
  const params = await searchParams;
  const queue = (QUEUES.find((q) => q.key === params.queue)?.key ?? "open") as QueueKey;
  const status = TICKET_STATUSES.find((s) => s === params.status) as TicketStatus | undefined;
  const category = TICKET_CATEGORIES.find((c) => c === params.category) as TicketCategory | undefined;
  const [rows, counts, rule] = await Promise.all([
    listTicketQueue(user, { queue, status, category, search: params.q }),
    queueCounts(user),
    getRule("helpdesk"),
  ]);

  return (
    <>
      <PageHeader
        title="Help desk"
        description={`Acknowledge within ${rule.acknowledgeWithinHours} h, resolve within ${rule.resolveWithinDays} days of receipt (Consumer Protection (E-Commerce) Rules, 2020, Rule 4). Breaches are escalated ${rule.escalateOnBreach ? "automatically" : "by hand (automatic escalation is off)"}.`}
        action={
          can(user.role, PERMISSIONS.SUPPORT_CANNED_REPLY_MANAGE) ? (
            <LinkButton href="/admin/support/canned-replies" variant="secondary">
              Canned replies
            </LinkButton>
          ) : null
        }
      />
      <ListTabs
        label="Queues"
        active={queue}
        tabs={QUEUES.map((q) => ({ key: q.key, label: q.label, href: `/admin/support?queue=${q.key}`, count: counts[q.key], urgent: q.urgent }))}
      />
      <form className="mb-4 grid gap-2 sm:grid-cols-4" action="/admin/support">
        <input type="hidden" name="queue" value={queue} />
        <select name="status" defaultValue={status ?? ""} className={inputClass} aria-label="Status">
          <option value="">Any status</option>
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TICKET_STATUS_STAFF_LABELS[s]}
            </option>
          ))}
        </select>
        <select name="category" defaultValue={category ?? ""} className={inputClass} aria-label="Category">
          <option value="">Any category</option>
          {TICKET_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {TICKET_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <input name="q" defaultValue={params.q ?? ""} placeholder="Ticket no., subject, email" className={inputClass} />
        <button type="submit" className="min-h-11 rounded-lg bg-kesari-600 px-4 text-sm font-medium text-white">
          Filter
        </button>
      </form>
      <TicketList rows={rows.map(toRowView)} hrefBase="/admin/support" staff emptyTitle="No tickets in this queue." />
      <p className="mt-4 text-xs text-ink-500">
        Statutory grievances also appear in the{" "}
        <Link href="/admin/console/grievances" className="underline">
          grievance register
        </Link>
        ; a grievance&apos;s linked ticket keeps it up to date.
      </p>
    </>
  );
}
