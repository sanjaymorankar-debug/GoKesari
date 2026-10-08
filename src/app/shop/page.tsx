import Link from "next/link";
import { redirect } from "next/navigation";

import { ExcelPriceUpload } from "@/components/excel-price-upload";
import { ShopCategoriesEditor } from "@/components/shop-categories-editor";
import { UnsavedChangesProvider } from "@/components/unsaved-changes-guard";
import { ShopDashboardView } from "@/components/shop-dashboard";
import { PendingPriceApprovals } from "@/components/pending-price-approvals";
import { RegistrationPanel } from "@/components/registration-panel";
import { ShopGstPanForm } from "@/components/shop-gst-pan-form";
import { ShopLocationSettingsForm } from "@/components/shop-location-settings-form";
import { ShopProductManager } from "@/components/shop-product-manager";
import { ShopSettingsForm } from "@/components/shop-settings-form";
import { ShopCustomerContactForm } from "@/components/shop-customer-contact-form";
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
import { addDays, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { formatQuantity } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import {
  listShopProducts,
  suggestProductsForShop,
} from "@/server/services/catalogue";
import { getMaskedPan } from "@/server/services/gst-pan-verification";
import { listOrdersForShop } from "@/server/services/orders";
import { listPendingForShop } from "@/server/services/price-requests";
import { getReferralCodeById } from "@/server/services/referrals";
import { listPaymentsForShop } from "@/server/services/shop-payments";
import { getShopDashboard } from "@/server/services/dashboards";
import { getShopCategories } from "@/server/services/shop-categories";
import { getActiveSuspension } from "@/server/services/shop-suspension";
import { listShopsForOwner } from "@/server/services/shops";
import { getShopOnboarding } from "@/server/services/shop-onboarding";
import { listSubscriptionDeliveries } from "@/server/services/subscription-schedule";
import { getRule } from "@/server/services/settings";
import { missedAcceptances30d } from "@/server/services/shop-acceptance";
import { DeliveryStatusBadge, SubscriptionDeliveryList } from "@/components/subscription-delivery-list";
import {
  ONBOARDING_STAGE_LABELS,
  ONBOARDING_STAGE_TONES,
  ownerNextAction,
  SHOP_ONBOARDING_STAGES,
  type ShopOnboardingStage,
} from "@/lib/shop-onboarding";
import { listSubscriptionOrdersForShop } from "@/server/services/subscriptions";
import { ShopWalletBanner } from "@/components/shop-wallet-banner";
import { LegalDocumentsBanner } from "@/components/legal-documents-banner";
import { getShopLegalStatus } from "@/server/services/legal-documents";
import { BankAccountPrompt } from "@/components/bank-account-prompt";
import { shopBankPrompt } from "@/server/services/bank-accounts";
import { getShopWalletStatus } from "@/server/services/shop-wallet";

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
  const suspension = shop.status === "SUSPENDED" ? await getActiveSuspension(shop.id) : null;
  // SM-002: which onboarding stage the shop is at and what the owner does next.
  const onboarding = shop.status === "PENDING_APPROVAL" ? (await getShopOnboarding([shop.id])).get(shop.id) : undefined;
  const nextStep = onboarding ? ownerNextAction(onboarding) : null;
  const shopCategoryList = await getShopCategories(shop.id);
  // Live figures for the operator's day — only for a shop that trades.
  const dashboard = shop.status === "APPROVED" || shop.status === "SUSPENDED" ? await getShopDashboard(shop.id, user.id) : null;

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
    suggestProductsForShop(shop.id),
    listPendingForShop(shop.id),
    listPaymentsForShop(shop.id),
    shop.referralCodeId ? getReferralCodeById(shop.referralCodeId) : null,
  ]);
  // NEW-007: the acceptance timeout and how often this shop has let it run out.
  const [acceptanceRule, missedAcceptances, wallet] = await Promise.all([
    getRule("shopAcceptance"),
    missedAcceptances30d(shop.id),
    getShopWalletStatus(shop.id),
  ]);
  // Mandatory legal documents (docs/four-features-2026-10): prompt, grace period, expiry reminder.
  const legalStatus = await getShopLegalStatus(shop.id);
  // Bank accounts (docs/four-features-2026-10): payouts need a verified account — a prompt, not a lockout.
  const bankPrompt = await shopBankPrompt(shop.id);
  const upcomingDeliveries = await listSubscriptionDeliveries({
    shopId: shop.id,
    from: addDays(today, 1),
    until: addDays(today, 8),
  });

  const alreadyListed = new Set(products.map((p) => p.productId));
  const availableToAdd = suggestions.filter((p) => !alreadyListed.has(p.id));

  return (
    <>
      <PageHeader
        title={shop.name}
        description={
          <>
            Owner: <span className="font-bold text-ink-900">{shop.ownerName}</span>
            {` · ${[shop.area, shop.city].filter(Boolean).join(", ")} — ${shop.pincode}`}
          </>
        }
        action={
          <Link
            href={`/shops/${shop.slug}`}
            className="text-sm font-medium text-kesari-600 hover:underline"
          >
            View public page →
          </Link>
        }
      />

      {/* Shop wallet: "recharge wallet" while it is low or below the minimum. */}
      <ShopWalletBanner {...wallet} />
      <LegalDocumentsBanner status={legalStatus} />
      {bankPrompt ? <BankAccountPrompt status={bankPrompt} href="/shop/bank-account" purpose="payouts" /> : null}

      <div className="mb-6 flex flex-wrap gap-2">
        {onboarding ? (
          <Badge tone={ONBOARDING_STAGE_TONES[onboarding.stage]}>{ONBOARDING_STAGE_LABELS[onboarding.stage]}</Badge>
        ) : (
          <StatusBadge status={shop.status} />
        )}
        <ClassificationBadge value={shop.classification} />
        <Badge>{shop.shopType}</Badge>
      </div>

      {shop.status === "PENDING_APPROVAL" ? (
        <div className="mb-6" data-testid="onboarding-stage">
          <Alert
            tone={onboarding?.stage === "VERIFIED" ? "success" : "warning"}
            title={onboarding ? `Awaiting approval — ${ONBOARDING_STAGE_LABELS[onboarding.stage].toLowerCase()}` : "Awaiting approval"}
          >
            <OnboardingSteps current={onboarding?.stage ?? "KYC_PENDING"} />
            {nextStep ? (
              <span className="mt-2 block">
                <span className="font-medium">Next: </span>
                {nextStep.text}{" "}
                <Link href={nextStep.href} className="font-medium underline">
                  {nextStep.linkLabel}
                </Link>
              </span>
            ) : null}
            <span className="mt-2 block">
              You can add products now — they go live as soon as the shop is approved.
            </span>
          </Alert>
        </div>
      ) : null}
      {shop.status === "SUSPENDED" ? (
        <div className="mb-6" data-testid="suspension-notice">
          <Alert tone="danger" title="Your shop is suspended">
            <span className="block">
              {suspension
                ? `Since ${suspension.effectiveAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}. Reason: ${suspension.reason}`
                : "Please contact support for details."}
            </span>
            {suspension ? <span className="mt-1 block">What to do: {suspension.expectedAction}</span> : null}
            <span className="mt-1 block">
              New orders are switched off. Orders already on the road should still be completed; any order
              our team is reviewing will be resolved for you.
            </span>
          </Alert>
        </div>
      ) : null}
      {shop.status === "REJECTED" ? (
        <div className="mb-6">
          <Alert tone="danger" title="Registration rejected">
            {shop.rejectionReason ?? "Please contact support for details."}
            <span className="mt-2 block">
              <Link href="/shop/register" className="font-medium underline">
                Correct the details and resubmit
              </Link>{" "}
              — this updates the same registration; it does not create a new one.
            </span>
          </Alert>
        </div>
      ) : null}

      {acceptanceRule.enabled && shop.status === "APPROVED" ? (
        <p className="mb-4 text-sm text-ink-600" data-testid="missed-acceptances">
          New orders must be accepted within {acceptanceRule.acceptMinutes} min or they are cancelled automatically.{" "}
          {missedAcceptances > 0 ? (
            <strong className="text-red-700">{missedAcceptances} missed in the last 30 days.</strong>
          ) : (
            "None missed in the last 30 days."
          )}
        </p>
      ) : null}

      {dashboard ? <ShopDashboardView data={dashboard} /> : null}

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
                  <DeliveryStatusBadge status={row.subscriptionOrder.status} />
                  <Money paise={row.subscriptionOrder.totalPaise} />
                </div>
              </div>
            ))}
          </Card>
        )}
      </section>

      {/* SM-004: what the coming days hold, each delivery with its own status. */}
      {upcomingDeliveries.length > 0 ? (
        <section className="mb-8">
          <SubscriptionDeliveryList
            title={`Upcoming subscription deliveries (${upcomingDeliveries.filter((d) => d.delivery.status === "SCHEDULED").length} scheduled)`}
            description="The next seven days. Skipped days are shown so you can plan stock."
            showCustomer
            rows={upcomingDeliveries.map((d) => ({
              id: d.delivery.id,
              deliveryDate: d.delivery.deliveryDate,
              status: d.delivery.status,
              quantityMilli: d.delivery.quantityMilli,
              reason: d.delivery.reason,
              orderNumber: d.orderNumber,
              customerName: d.customerName,
              productName: `${d.productName}${d.delivery.quantityMilli ? ` · ${formatQuantity(d.delivery.quantityMilli, d.unit)}` : ""}`,
            }))}
          />
        </section>
      ) : null}

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

      <div className="mb-8" id="registration">
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
        <ShopCustomerContactForm
          shopId={shop.id}
          initial={{ contactPhone: shop.contactPhone, whatsappNumber: shop.whatsappNumber }}
        />
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
        <Card className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm" data-testid="verification-link">
          <span>
            <span className="font-medium text-ink-900">Shop verification</span>
            <span className="block text-ink-500">
              PAN, GST, Udyam, FSSAI and Shop Act — checked with the government records.
            </span>
          </span>
          <Link href="/shop/verification" className="font-medium text-kesari-700 underline">
            Verify documents
          </Link>
        </Card>
      </div>

      <div className="mb-8">
        <Card className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm" data-testid="photo-catalogue-link">
          <span>
            <span className="font-medium text-ink-900">Photo catalogue</span>
            <span className="block text-ink-500">
              Every product with its photo and price, as customers see them. Add photos and set prices in one place.
            </span>
          </span>
          <Link href="/shop/catalogue" className="font-medium text-kesari-700 underline">
            Open photo catalogue
          </Link>
        </Card>
      </div>

      <div className="mb-8">
        <Card className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm" data-testid="product-categories-link">
          <span>
            <span className="font-medium text-ink-900">Product categories</span>
            <span className="block text-ink-500">
              Your shop sees every product in the categories it carries when you add products.
            </span>
          </span>
          <Link href="/shop/product-categories" className="font-medium text-kesari-700 underline">
            Manage product categories
          </Link>
        </Card>
      </div>

      <div className="mb-8">
        <UnsavedChangesProvider>
          <ShopCategoriesEditor
            shopId={shop.id}
            shopName={shop.name}
            current={shopCategoryList.map((c) => ({ id: c.id, name: c.name, status: c.status }))}
          />
        </UnsavedChangesProvider>
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
            deliveryPincodes: shop.deliveryPincodes,
            minOrderPaise: shop.minOrderPaise,
            ordersPaused: shop.ordersPaused,
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
          // The photo customers see, as the storefront picks it.
          imageUrl: p.imageUrl ?? p.product.imageUrl,
          onlinePricePaise: p.onlinePricePaise,
          offlinePricePaise: p.offlinePricePaise,
          onlineSaleEnabled: p.onlineSaleEnabled,
          offlineSaleEnabled: p.offlineSaleEnabled,
          onlineStock: p.onlineStock,
          trackInventory: p.trackInventory,
          isActive: p.isActive,
          isAvailable: p.isAvailable,
          paused: p.categoryCarried === false,
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

/** SM-002: the three onboarding steps, the current one highlighted, earlier ones ticked. */
function OnboardingSteps({ current }: { current: ShopOnboardingStage }) {
  const at = SHOP_ONBOARDING_STAGES.indexOf(current);
  const steps = ["Documents verified (KYC)", "Registration fee paid", "Approved by GoKesari"];
  return (
    <ol className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {steps.map((label, i) => (
        <li key={label} className={i === at ? "font-semibold" : "text-ink-500"}>
          {i < at ? "✓ " : `${i + 1}. `}
          {label}
        </li>
      ))}
    </ol>
  );
}
