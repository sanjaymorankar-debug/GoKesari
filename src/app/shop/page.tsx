import Link from "next/link";
import { redirect } from "next/navigation";

import { ExcelPriceUpload } from "@/components/excel-price-upload";
import { PendingPriceApprovals } from "@/components/pending-price-approvals";
import { RegistrationPanel } from "@/components/registration-panel";
import { ShopGstPanForm } from "@/components/shop-gst-pan-form";
import { ShopLocationSettingsForm } from "@/components/shop-location-settings-form";
import { ShopProductManager } from "@/components/shop-product-manager";
import { ShopSettingsForm } from "@/components/shop-settings-form";
import {
  Alert,
  Badge,
  Card,
  ClassificationBadge,
  EmptyState,
  LinkButton,
  Money,
  PageHeader,
  StatusBadge,
} from "@/components/ui";
import { todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { formatQuantity } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import {
  listShopProducts,
  suggestProductsForShopType,
} from "@/server/services/catalogue";
import { getMaskedPan } from "@/server/services/gst-pan-verification";
import { listOrdersForShop } from "@/server/services/orders";
import { listPendingForShop } from "@/server/services/price-requests";
import { getReferralCodeById } from "@/server/services/referrals";
import { listPaymentsForShop } from "@/server/services/shop-payments";
import { listShopsForOwner } from "@/server/services/shops";
import { listSubscriptionOrdersForShop } from "@/server/services/subscriptions";

export const metadata = { title: "My Shop" };
export const dynamic = "force-dynamic";

/** Shop owner dashboard (§40, §50). Scoped strictly to the owner's own shop. */
export default async function ShopDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title="My Shop" />
        <EmptyState
          title="You haven't registered a shop yet"
          description="Register your dairy or bakery to start selling online."
          action={<LinkButton href="/shop/register">Add my shop</LinkButton>}
        />
      </>
    );
  }

  const shop = shops[0];
  const today = todayIn(getEnv().APP_TIMEZONE);

  const [
    products,
    directOrders,
    subscriptionOrders,
    suggestions,
    pendingApprovals,
    payments,
    referral,
  ] = await Promise.all([
    listShopProducts(shop.id),
    listOrdersForShop(shop.id, { source: "DIRECT", limit: 20 }),
    listSubscriptionOrdersForShop(shop.id, today),
    suggestProductsForShopType(shop.shopType),
    listPendingForShop(shop.id),
    listPaymentsForShop(shop.id),
    shop.referralCodeId ? getReferralCodeById(shop.referralCodeId) : null,
  ]);

  const alreadyListed = new Set(products.map((p) => p.productId));
  const availableToAdd = suggestions.filter((p) => !alreadyListed.has(p.id));

  return (
    <>
      <PageHeader
        title={shop.name}
        description={`${[shop.area, shop.city].filter(Boolean).join(", ")} — ${shop.pincode}`}
        action={
          <Link
            href={`/shops/${shop.slug}`}
            className="text-sm font-medium text-kesari-600 hover:underline"
          >
            View public page →
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap gap-2">
        <StatusBadge status={shop.status} />
        <ClassificationBadge value={shop.classification} />
        <Badge>{shop.shopType}</Badge>
      </div>

      {shop.status === "PENDING_APPROVAL" ? (
        <div className="mb-6">
          <Alert tone="warning" title="Awaiting approval">
            Your shop is being reviewed by an operator. You can add products now
            — they go live as soon as the shop is approved.
          </Alert>
        </div>
      ) : null}
      {shop.status === "REJECTED" ? (
        <div className="mb-6">
          <Alert tone="danger" title="Registration rejected">
            {shop.rejectionReason ?? "Please contact support for details."}
          </Alert>
        </div>
      ) : null}

      {/* Subscription orders are separated from normal orders per §40. */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-ink-900">
          Today&apos;s subscription deliveries ({subscriptionOrders.length})
        </h2>
        {subscriptionOrders.length === 0 ? (
          <EmptyState title="No subscription deliveries scheduled for today." />
        ) : (
          <Card className="divide-y divide-cream-200">
            {subscriptionOrders.map((row) => (
              <div
                key={row.subscriptionOrder.id}
                className="flex flex-wrap items-center justify-between gap-2 p-4"
              >
                <div>
                  <p className="font-medium text-ink-900">
                    {row.productName} ·{" "}
                    {formatQuantity(
                      row.subscriptionOrder.quantityMilli,
                      row.unit,
                    )}
                  </p>
                  <p className="text-xs text-ink-500">
                    {row.orderNumber ?? "—"} · subscription{" "}
                    {row.subscriptionId.slice(0, 8)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={row.subscriptionOrder.status} />
                  <Money paise={row.subscriptionOrder.totalPaise} />
                </div>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-ink-900">
          Recent orders ({directOrders.length})
        </h2>
        {directOrders.length === 0 ? (
          <EmptyState title="No orders yet." />
        ) : (
          <Card className="divide-y divide-cream-200">
            {directOrders.map((order) => (
              <div key={order.id} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={order.status} />
                    <span className="text-sm text-ink-500">
                      {order.orderNumber}
                    </span>
                  </div>
                  <Money paise={order.totalPaise} className="font-semibold" />
                </div>
                <ul className="mt-2 text-sm text-ink-600">
                  {order.items.map((item) => (
                    <li key={item.id}>
                      {item.productNameSnapshot} ·{" "}
                      {formatQuantity(item.quantityMilli, item.unitSnapshot)}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Card>
        )}
      </section>

      {/* §2.4 — the owner's veto sits above the catalogue, because an operator's
          proposal is the thing most likely to need action on any given visit. */}
      {pendingApprovals.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-ink-900">
            Price updates awaiting your approval ({pendingApprovals.length})
          </h2>
          <PendingPriceApprovals
            rows={pendingApprovals.map((r) => ({
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
        </section>
      ) : null}

      <div className="mb-8">
        <RegistrationPanel
          details={{
            registrationNumber: shop.registrationNumber,
            registrationDate: shop.registrationDate,
            shopName: shop.name,
            ownerName: shop.ownerName,
            phone: shop.phone,
            email: shop.email,
            address: [shop.addressLine1, shop.area, shop.city, shop.pincode]
              .filter(Boolean)
              .join(", "),
            shopType: shop.shopType,
            classification: shop.classification,
            status: shop.status,
            referralCode: referral?.code ?? null,
            registrationFeePaise: shop.registrationFeePaise,
            amountPaidPaise: shop.amountPaidPaise,
            feePaymentStatus: shop.feePaymentStatus,
          }}
          payments={payments.map((p) => ({
            id: p.id,
            reference: p.reference,
            paymentType: p.paymentType,
            amountPaise: p.amountPaise,
            method: p.method,
            transactionId: p.transactionId,
            paidAt: p.paidAt.toISOString(),
            note: p.note,
            receiptUrl: p.receiptUrl,
          }))}
        />
      </div>

      <div className="mb-8">
        <ExcelPriceUpload shopId={shop.id} appliesImmediately />
      </div>

      <div className="mb-8">
        <ShopSettingsForm shopId={shop.id} initialHours={shop.openingHours} />
      </div>

      <div className="mb-8">
        <ShopGstPanForm
          settings={{
            shopId: shop.id,
            gstStatus: shop.gstStatus,
            gstin: shop.gstin,
            panStatus: shop.panStatus,
            panMasked: getMaskedPan(shop),
          }}
        />
      </div>

      <div className="mb-8">
        <ShopLocationSettingsForm
          settings={{
            shopId: shop.id,
            latitude: shop.latitude,
            longitude: shop.longitude,
            locationVerified: shop.locationVerified,
            pickupLatitude: shop.pickupLatitude,
            pickupLongitude: shop.pickupLongitude,
            serviceRadiusKm: shop.serviceRadiusKm,
            pickupInstructions: shop.pickupInstructions,
          }}
        />
      </div>

      <ShopProductManager
        shopId={shop.id}
        department={shop.shopType}
        products={products.map((p) => ({
          id: p.id,
          productName: p.product.name,
          categoryName: p.category.name,
          unit: p.product.unit,
          onlinePricePaise: p.onlinePricePaise,
          offlinePricePaise: p.offlinePricePaise,
          onlineSaleEnabled: p.onlineSaleEnabled,
          offlineSaleEnabled: p.offlineSaleEnabled,
          onlineStock: p.onlineStock,
          trackInventory: p.trackInventory,
          isActive: p.isActive,
          isAvailable: p.isAvailable,
        }))}
        suggestions={availableToAdd.map((p) => ({
          id: p.id,
          name: p.name,
          unit: p.unit,
          categoryName: p.category.name,
          department: p.category.department,
        }))}
      />
    </>
  );
}
