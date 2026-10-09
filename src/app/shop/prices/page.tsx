import { redirect } from "next/navigation";

import { SubmenuStrip } from "@/components/board/submenu-strip";
import { ExcelPriceUpload } from "@/components/excel-price-upload";
import { PendingPriceApprovals } from "@/components/pending-price-approvals";
import { Badge, Card, EmptyState, Money, PageHeader, Section } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import {
  listDecidedForShop,
  listPendingForShop,
} from "@/server/services/price-requests";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Price Updates" };
export const dynamic = "force-dynamic";

/**
 * Shop owner's price-update screen (§2.2, §2.3, §2.4).
 *
 * Separated from the main shop dashboard because approving operator proposals
 * and uploading a price sheet are a distinct job from running the day's orders.
 */
export default async function ShopPricesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];

  const [pending, decided, lang] = await Promise.all([
    listPendingForShop(shop.id),
    listDecidedForShop(shop.id, 50),
    getBoardLang(),
  ]);

  return (
    <>
      <PageHeader
        title="Price updates"
        description={`${shop.name} — approve proposed changes and upload price lists.`}
      />
      <SubmenuStrip board="shop" menuKey="prices" role={user.role} lang={lang} current="edit" counts={{ shopPriceRequests: pending.length }} />

      <Section id="price-requests" title={`Pending your approval (${pending.length})`}>
        <PendingPriceApprovals
          rows={pending.map((r) => ({
            id: r.id,
            productName: r.productName,
            productCode: r.productCode,
            unit: r.unit,
            priceType: r.priceType,
            previousPricePaise: r.previousPricePaise,
            proposedPricePaise: r.proposedPricePaise,
            source: r.source,
            createdAt: r.createdAt.toISOString(),
          }))}
        />
      </Section>

      <div id="excel-upload" className="scroll-mt-20" />
      <Section title="Upload a product list">
        <ExcelPriceUpload shopId={shop.id} appliesImmediately uploadType="GOODS" />
      </Section>

      <Section title="Upload a price list">
        <ExcelPriceUpload shopId={shop.id} appliesImmediately uploadType="PRICES" />
      </Section>

      <Section title={`Decision history (${decided.length})`}>
        {decided.length === 0 ? (
          <EmptyState title="No price updates have been decided yet." />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-cream-100 text-xs uppercase text-ink-500">
                <tr>
                  <th className="px-4 py-2">Decided</th>
                  <th className="px-4 py-2">Product</th>
                  <th className="px-4 py-2">From</th>
                  <th className="px-4 py-2">To</th>
                  <th className="px-4 py-2">Outcome</th>
                  <th className="px-4 py-2">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {decided.map((row) => (
                  <tr key={row.request.id}>
                    <td className="px-4 py-2 text-ink-500">
                      {row.request.decidedAt
                        ? new Date(row.request.decidedAt).toLocaleDateString("en-IN")
                        : "—"}
                    </td>
                    <td className="px-4 py-2 text-ink-900">
                      {row.productName}{" "}
                      <span className="text-xs text-ink-500">({row.unit})</span>
                    </td>
                    <td className="px-4 py-2">
                      {row.request.previousPricePaise != null ? (
                        <Money paise={row.request.previousPricePaise} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <Money paise={row.request.proposedPricePaise} />
                    </td>
                    <td className="px-4 py-2">
                      <Badge>{row.request.status}</Badge>
                    </td>
                    <td className="px-4 py-2 text-ink-500">
                      {row.request.rejectionReason ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>
    </>
  );
}
