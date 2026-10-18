import Link from "next/link";
import { redirect } from "next/navigation";

import { TicketForm } from "@/components/aftercare/ticket-form";
import { TicketList, toRowView } from "@/components/aftercare/ticket-views";
import { Alert, Card, PageHeader } from "@/components/ui";
import { TICKET_CATEGORIES } from "@/lib/support-ticket-states";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getGrievanceOfficer } from "@/server/aftercare/grievance-officer";
import { listMyTickets } from "@/server/aftercare/support-tickets";
import { assertOrderViewer } from "@/server/aftercare/order-view";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Help & support" };
export const dynamic = "force-dynamic";

/**
 * The customer grievance portal (F6.3.3, batch-2026-10 WS-C): raise a ticket
 * (about an order when opened from one) and follow "My tickets". Works the
 * same on the website and in the app.
 */
export default async function SupportPortalPage({ searchParams }: { searchParams: Promise<{ orderId?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/support");
  const params = await searchParams;
  const [rule, officer, tickets] = await Promise.all([getRule("helpdesk"), getGrievanceOfficer(), listMyTickets(user)]);
  let orderLabel: string | null = null;
  let orderId: string | null = null;
  if (params.orderId && /^[0-9a-f-]{36}$/i.test(params.orderId)) {
    const order = await assertOrderViewer(params.orderId, user).catch(() => null);
    if (order && order.userId === user.id) {
      orderId = order.id;
      orderLabel = `${order.orderNumber} (${order.shopName})`;
    }
  }
  const categories = TICKET_CATEGORIES.filter((c) => c !== "GRIEVANCE" && c !== "SHOP_PAYOUT");

  return (
    <>
      <PageHeader
        title="Help & support"
        description={`We acknowledge every request within ${rule.acknowledgeWithinHours} hours and aim to resolve it within ${rule.resolveWithinDays} days.`}
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <section>
            <h2 className="mb-3 text-lg font-semibold text-ink-900">My tickets</h2>
            <TicketList
              rows={tickets.map(toRowView)}
              hrefBase="/support"
              emptyTitle="No tickets yet"
              emptyDescription="Tickets you raise appear here with their status."
            />
          </section>
          <section id="new">
            <h2 className="mb-3 text-lg font-semibold text-ink-900">Raise a ticket</h2>
            {rule.enabled && can(user.role, PERMISSIONS.SUPPORT_TICKET_RAISE) ? (
              <TicketForm categories={[...categories]} orderId={orderId} orderLabel={orderLabel} detailBase="/support" />
            ) : (
              <Alert tone="info">
                The help desk is not taking new tickets right now. Please use the{" "}
                <Link href="/grievance" className="underline">
                  complaint form
                </Link>
                .
              </Alert>
            )}
          </section>
        </div>
        <aside>
          <Card className="space-y-2 p-5 text-sm" data-testid="grievance-officer">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Grievance Officer</h2>
            <p className="font-medium text-ink-900">
              {officer.name}, {officer.designation}
            </p>
            <p>
              <a href={`mailto:${officer.email}`} className="underline">
                {officer.email}
              </a>
            </p>
            <p>{officer.phone}</p>
            <p className="text-ink-600">{officer.address}</p>
            {officer.hours ? <p className="text-ink-600">{officer.hours}</p> : null}
            <p className="pt-2">
              <Link href="/grievance" className="font-medium text-kesari-700 hover:underline">
                File a formal complaint →
              </Link>
            </p>
            <p>
              <Link href="/legal/grievance-redressal" className="text-kesari-700 hover:underline">
                Grievance redressal policy
              </Link>
            </p>
          </Card>
        </aside>
      </div>
    </>
  );
}
