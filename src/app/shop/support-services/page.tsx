import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { SupportServicesPanel } from "@/components/support-services-panel";
import { PageHeader } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { shops as shopsTable } from "@/server/db/schema";
import { listShopsForOwner } from "@/server/services/shops";
import { listShopRequests, listSupportServices, requesterFor, supportServicesOn } from "@/server/services/support-services";
import { eq } from "drizzle-orm";

export const metadata = { title: "Support services" };
export const dynamic = "force-dynamic";

/**
 * Paid support services (docs/dealer-programme, GKS-SP-001): the shop owner
 * — or the shop's own dealer, with ?shopId= — asks for help with product
 * upload, price updates or general support, sees the price first, pays from
 * the shop wallet or online and follows the ticket. Off (flag) → not found.
 */
export default async function SupportServicesPage({ searchParams }: { searchParams: Promise<{ shopId?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const params = await searchParams;
  let shop: { id: string; name: string };
  if (params.shopId && /^[0-9a-f-]{36}$/i.test(params.shopId)) {
    // The dealer the shop is attributed to (or its owner); anyone else: not found.
    await requesterFor(params.shopId, user).catch(() => notFound());
    const [row] = await db.select({ id: shopsTable.id, name: shopsTable.name }).from(shopsTable).where(eq(shopsTable.id, params.shopId));
    shop = row;
  } else {
    const owned = await listShopsForOwner(user.id);
    if (owned.length === 0) redirect(user.role === "DEALER" ? "/dealer" : "/shop");
    shop = await activeShop(owned);
  }
  if (!(await supportServicesOn(shop.id))) notFound();
  const isOwner = (await requesterFor(shop.id, user)).kind === "OWNER";
  const [services, requests] = await Promise.all([listSupportServices(), listShopRequests(shop.id)]);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href={isOwner ? "/shop" : "/dealer"} className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← {isOwner ? "Shop" : "Dealer board"}
      </Link>
      <PageHeader title="Support services" description="Let our team upload your products, update prices or help with anything else. You see the price before you pay; cancel before work starts for a refund." />
      <SupportServicesPanel
        shopId={shop.id}
        shopName={shop.name}
        canUseWallet={isOwner}
        services={services.map((s) => ({
          key: s.key,
          label: s.label,
          description: s.description,
          unitLabel: s.unitLabel,
          charge: s.charge && { chargeModel: s.charge.chargeModel, amountPaise: s.charge.amountPaise, batchSize: s.charge.batchSize, gstApplicable: s.charge.gstApplicable, gstRateBp: s.charge.gstRateBp, freeQuotaPerMonth: s.charge.freeQuotaPerMonth },
        }))}
        requests={requests.map((r) => ({
          id: r.id,
          receiptNumber: r.receiptNumber,
          serviceKey: r.serviceKey,
          quantity: r.quantity,
          description: r.description,
          basePaise: r.basePaise,
          gstPaise: r.gstPaise,
          totalPaise: r.totalPaise,
          freeReason: r.freeReason,
          status: r.status,
          paymentMethod: r.paymentMethod,
          ticketId: r.ticketId,
          ticketNumber: r.ticketNumber,
          ticketStatus: r.ticketStatus,
          refundPaise: r.refundPaise,
          createdAt: r.createdAt.toISOString(),
          paidAt: r.paidAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
