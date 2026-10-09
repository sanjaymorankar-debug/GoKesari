import { SectionTabs } from "@/components/board/section-tabs";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { BankAccountPrompt } from "@/components/bank-account-prompt";
import { LegalDocumentsBanner } from "@/components/legal-documents-banner";
import { RegistrationPanel } from "@/components/registration-panel";
import { ShopCategoriesEditor } from "@/components/shop-categories-editor";
import { ShopCustomerContactForm } from "@/components/shop-customer-contact-form";
import { ShopDashboardView } from "@/components/shop-dashboard";
import { ShopGstPanForm } from "@/components/shop-gst-pan-form";
import { ShopLocationSettingsForm } from "@/components/shop-location-settings-form";
import { ShopProductManager } from "@/components/shop-product-manager";
import { ShopSettingsForm } from "@/components/shop-settings-form";
import { ShopWalletBanner } from "@/components/shop-wallet-banner";
import { DeliveryStatusBadge, SubscriptionDeliveryList } from "@/components/subscription-delivery-list";
import { UnsavedChangesProvider } from "@/components/unsaved-changes-guard";
import {
  Alert,
  Badge,
  Card,
  ClassificationBadge,
  EmptyState,
  Money,
  PageHeader,
  StatusBadge,
} from "@/components/ui";
import { addDays, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { formatQuantity } from "@/lib/money";
import {
  ONBOARDING_STAGE_LABELS,
  ONBOARDING_STAGE_TONES,
  ownerNextAction,
  SHOP_ONBOARDING_STAGES,
  type ShopOnboardingStage,
} from "@/lib/shop-onboarding";
import { getCurrentUser } from "@/server/authz/guards";
import { shopBankPrompt } from "@/server/services/bank-accounts";
import { listShopProducts, suggestProductsForShop } from "@/server/services/catalogue";
import { getShopDashboard } from "@/server/services/dashboards";
import { getMaskedPan } from "@/server/services/gst-pan-verification";
import { getShopLegalStatus } from "@/server/services/legal-documents";
import { listOrdersForShop } from "@/server/services/orders";
import { getReferralCodeById } from "@/server/services/referrals";
import { getRule } from "@/server/services/settings";
import { missedAcceptances30d } from "@/server/services/shop-acceptance";
import { getShopCategories } from "@/server/services/shop-categories";
import { getShopOnboarding } from "@/server/services/shop-onboarding";
import { listPaymentsForShop } from "@/server/services/shop-payments";
import { getActiveSuspension } from "@/server/services/shop-suspension";
import { getShopWalletStatus } from "@/server/services/shop-wallet";
import { listShopsForOwner } from "@/server/services/shops";
import { listSubscriptionDeliveries } from "@/server/services/subscription-schedule";
import { listSubscriptionOrdersForShop } from "@/server/services/subscriptions";

export const dynamic = "force-dynamic";

/**
 * The parts of the old one-page shop dashboard, each on its own page and
 * reached from the board (Tile Board: no page longer than one screen of
 * menus; each page loads only its own data). Same forms, same data, same
 * owner-only scope as before.
 */
const SECTIONS = {
  today: "Today's work",
  products: "Products — on/off and stock",
  location: "Delivery area and location",
  hours: "Opening hours and contact",
  "gst-pan": "GST and PAN",
  "shop-types": "Shop types I sell",
  registration: "Registration and fee",
} as const;

type SectionKey = keyof typeof SECTIONS;

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  return { title: SECTIONS[section as SectionKey] ?? "My Shop" };
}

export default async function ShopManagePage({ params }: { params: Promise<{ section: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { section } = await params;
  if (!(section in SECTIONS)) notFound();
  const key = section as SectionKey;

  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];
  const header = (
    <PageHeader
      title={SECTIONS[key]}
      description={shop.name}
      action={
        <Link href={`/shops/${shop.slug}`} className="inline-flex min-h-11 items-center text-sm font-medium text-kesari-700 hover:underline">
          View public page →
        </Link>
      }
    />
  );

  switch (key) {
    case "today": {
      const today = todayIn(getEnv().APP_TIMEZONE);
      const trading = shop.status === "APPROVED" || shop.status === "SUSPENDED";
      const [suspension, onboardingMap, dashboard, directOrders, subscriptionOrders, acceptanceRule, missedAcceptances, wallet, legalStatus, bankPrompt, upcomingDeliveries] =
        await Promise.all([
          shop.status === "SUSPENDED" ? getActiveSuspension(shop.id) : Promise.resolve(null),
          shop.status === "PENDING_APPROVAL" ? getShopOnboarding([shop.id]) : Promise.resolve(null),
          trading ? getShopDashboard(shop.id, user.id) : Promise.resolve(null),
          listOrdersForShop(shop.id, { source: "DIRECT", limit: 10 }),
          listSubscriptionOrdersForShop(shop.id, today),
          getRule("shopAcceptance"),
          missedAcceptances30d(shop.id),
          getShopWalletStatus(shop.id),
          getShopLegalStatus(shop.id),
          shopBankPrompt(shop.id),
          listSubscriptionDeliveries({ shopId: shop.id, from: addDays(today, 1), until: addDays(today, 8) }),
        ]);
      const onboarding = onboardingMap?.get(shop.id);
      const nextStep = onboarding ? ownerNextAction(onboarding) : null;
      return (
        <>
          {header}
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
                <span className="mt-2 block">You can add products now — they go live as soon as the shop is approved.</span>
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
                  New orders are switched off. Orders already on the road should still be completed; any order our team is
                  reviewing will be resolved for you.
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
            <p className="mb-4 text-sm text-ink-700" data-testid="missed-acceptances">
              New orders must be accepted within {acceptanceRule.acceptMinutes} min or they are cancelled automatically.{" "}
              {missedAcceptances > 0 ? (
                <strong className="text-red-700">{missedAcceptances} missed in the last 30 days.</strong>
              ) : (
                "None missed in the last 30 days."
              )}
            </p>
          ) : null}

          <SectionTabs
            label="Today"
            labels={[
              ...(dashboard ? ["Overview"] : []),
              `Subscriptions today (${subscriptionOrders.length})`,
              ...(upcomingDeliveries.length > 0 ? ["Coming days"] : []),
              `Recent orders (${directOrders.length})`,
            ]}
          >
            {dashboard ? <ShopDashboardView data={dashboard} /> : null}

            {/* Subscription orders are separated from normal orders per §40. */}
            <section className="mb-8" id="subscription-deliveries">
              <h2 className="mb-3 text-lg font-semibold text-ink-900">Today&apos;s subscription deliveries ({subscriptionOrders.length})</h2>
              {subscriptionOrders.length === 0 ? (
                <EmptyState title="No subscription deliveries scheduled for today." />
              ) : (
                <Card className="divide-y divide-cream-200">
                  {subscriptionOrders.map((row) => (
                    <div key={row.subscriptionOrder.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
                      <div>
                        <p className="font-medium text-ink-900">
                          {row.productName} · {formatQuantity(row.subscriptionOrder.quantityMilli, row.unit)}
                        </p>
                        <p className="text-sm text-ink-600">
                          {row.orderNumber ?? "—"} · subscription {row.subscriptionId.slice(0, 8)}
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
              <h2 className="mb-3 flex items-baseline justify-between gap-2 text-lg font-semibold text-ink-900">
                Recent orders ({directOrders.length})
                <Link href="/shop/orders?status=all" className="text-sm font-medium text-kesari-700 hover:underline">
                  All orders →
                </Link>
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
                          <span className="text-sm text-ink-600">{order.orderNumber}</span>
                        </div>
                        <Money paise={order.totalPaise} className="font-semibold" />
                      </div>
                      <ul className="mt-2 text-sm text-ink-700">
                        {order.items.map((item) => (
                          <li key={item.id}>
                            {item.productNameSnapshot} · {formatQuantity(item.quantityMilli, item.unitSnapshot)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </Card>
              )}
            </section>
          </SectionTabs>
        </>
      );
    }

    case "products": {
      const [products, suggestions] = await Promise.all([listShopProducts(shop.id), suggestProductsForShop(shop.id)]);
      const alreadyListed = new Set(products.map((p) => p.productId));
      const availableToAdd = suggestions.filter((p) => !alreadyListed.has(p.id));
      return (
        <>
          {header}
          <div id="products">
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
          </div>
        </>
      );
    }

    case "location":
      return (
        <>
          {header}
          <div id="location">
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
        </>
      );

    case "hours":
      return (
        <>
          {header}
          <div className="mb-8">
            <ShopSettingsForm shopId={shop.id} initialHours={shop.openingHours} />
          </div>
          <div className="mb-8">
            <ShopCustomerContactForm shopId={shop.id} initial={{ contactPhone: shop.contactPhone, whatsappNumber: shop.whatsappNumber }} />
          </div>
        </>
      );

    case "gst-pan":
      return (
        <>
          {header}
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
          <Card className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm" data-testid="verification-link">
            <span>
              <span className="font-medium text-ink-900">Shop verification</span>
              <span className="block text-ink-600">PAN, GST, Udyam, FSSAI and Shop Act — checked with the government records.</span>
            </span>
            <Link href="/shop/verification" className="font-medium text-kesari-700 underline">
              Open verification →
            </Link>
          </Card>
        </>
      );

    case "shop-types": {
      const list = await getShopCategories(shop.id);
      return (
        <>
          {header}
          <UnsavedChangesProvider>
            <ShopCategoriesEditor shopId={shop.id} shopName={shop.name} current={list.map((c) => ({ id: c.id, name: c.name, status: c.status }))} />
          </UnsavedChangesProvider>
        </>
      );
    }

    case "registration": {
      const [payments, referral] = await Promise.all([
        listPaymentsForShop(shop.id),
        shop.referralCodeId ? getReferralCodeById(shop.referralCodeId) : null,
      ]);
      return (
        <>
          {header}
          <div id="registration">
            <RegistrationPanel
              details={{
                registrationNumber: shop.registrationNumber,
                registrationDate: shop.registrationDate,
                shopName: shop.name,
                ownerName: shop.ownerName,
                phone: shop.phone,
                email: shop.email,
                address: [shop.addressLine1, shop.area, shop.city, shop.pincode].filter(Boolean).join(", "),
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
        </>
      );
    }
  }
}

/** SM-002: the three onboarding steps, the current one highlighted, earlier ones ticked. */
function OnboardingSteps({ current }: { current: ShopOnboardingStage }) {
  const at = SHOP_ONBOARDING_STAGES.indexOf(current);
  const steps = ["Documents verified (KYC)", "Registration fee paid", "Approved by GoKesari"];
  return (
    <ol className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {steps.map((label, i) => (
        <li key={label} className={i === at ? "font-semibold" : "text-ink-600"}>
          {i < at ? "✓ " : `${i + 1}. `}
          {label}
        </li>
      ))}
    </ol>
  );
}
