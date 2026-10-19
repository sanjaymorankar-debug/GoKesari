import { redirect } from "next/navigation";

import { TicketForm } from "@/components/aftercare/ticket-form";
import { TicketList, toRowView } from "@/components/aftercare/ticket-views";
import { PageHeader } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { assertOrderViewer } from "@/server/aftercare/order-view";
import { listMyTickets, listShopTickets } from "@/server/aftercare/support-tickets";
import { getRule } from "@/server/services/settings";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Support tickets" };
export const dynamic = "force-dynamic";

/**
 * The shop owner's help desk (F6.3.3, batch-2026-10 WS-C): tickets about the
 * shop's orders where support is waiting for the shop's reply, the shop's
 * own tickets, and raising a new one.
 */
export default async function ShopSupportPage({ searchParams }: { searchParams: Promise<{ orderId?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = await activeShop(shops);
  const [awaiting, mine, rule, params] = await Promise.all([listShopTickets(user), listMyTickets(user), getRule("helpdesk"), searchParams]);
  // Raised from the shop's order screen: only an order of one of this owner's shops.
  const order =
    params.orderId && /^[0-9a-f-]{36}$/i.test(params.orderId)
      ? await assertOrderViewer(params.orderId, user).catch(() => null)
      : null;
  const ownOrder = order && shops.some((s) => s.id === order.shopId) ? order : null;

  return (
    <>
      <PageHeader title="Support tickets" description={`${shop.name} — reply when support needs your input; raise a ticket about an order, a payout or anything else.`} />
      <section className="mb-6">
        <h2 className="mb-3 text-lg font-semibold text-ink-900">Waiting for your reply</h2>
        <TicketList
          rows={awaiting.map(toRowView)}
          hrefBase="/shop/support"
          emptyTitle="Nothing is waiting for you."
          emptyDescription="When support needs the shop's side of a customer's ticket, it appears here and you are notified."
        />
      </section>
      <section className="mb-6">
        <h2 className="mb-3 text-lg font-semibold text-ink-900">Tickets you raised</h2>
        <TicketList rows={mine.map(toRowView)} hrefBase="/support" emptyTitle="No tickets yet." />
      </section>
      {rule.enabled && can(user.role, PERMISSIONS.SUPPORT_TICKET_RAISE) ? (
        <section id="new">
          <h2 className="mb-3 text-lg font-semibold text-ink-900">Raise a ticket</h2>
          <TicketForm
            categories={["SHOP_PAYOUT", "ORDER", "DELIVERY", "CANCELLATION", "REFUND_PAYMENT", "ACCOUNT", "OTHER"]}
            orderId={ownOrder?.id ?? null}
            orderLabel={ownOrder?.orderNumber ?? null}
            shopId={ownOrder ? null : shop.id}
            detailBase="/support"
          />
        </section>
      ) : null}
    </>
  );
}
