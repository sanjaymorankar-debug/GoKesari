import Link from "next/link";
import { EmptyIllustration } from "@/components/empty-illustrations";
import { HOME } from "@/lib/home-i18n";
import { redirect } from "next/navigation";

import {
  Alert,
  Badge,
  Card,
  EmptyState,
  LinkButton,
  Money,
  PageHeader,
  StatusBadge,
} from "@/components/ui";
import { ListTabs, Pager, paginate } from "@/components/board/list-tabs";
import { CancelOrderButton } from "@/components/cancel-order-button";
import { TrackDeliveryButton } from "@/components/live-tracking-map";
import { RateOrderForm, ReportIssueForm } from "@/components/rating-actions";
import { SubstitutionDecision } from "@/components/substitution-decision";
import { formatQuantity } from "@/lib/money";
import { customerCancellableStatuses } from "@/lib/order-cancellation";
import { DISPUTE_STATUS_LABELS } from "@/lib/dispute-states";
import { isTrackableOrderStatus } from "@/lib/tracking";
import { L, tr, UI } from "@/lib/board/i18n";
import { L, tr, UI, type Text } from "@/lib/board/i18n";
import { CUSTOMER_MENUS } from "@/lib/board/menus";
import { IN_PROGRESS_ORDER_STATUSES, pickTab } from "@/lib/board/status-groups";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getDeliveryOrdersForOrders } from "@/server/services/delivery-assignment";
import { buyerDeliveryCodeView, type BuyerDeliveryCodeView } from "@/server/services/delivery-otp";
import { DeliveryCodePanel } from "@/components/delivery-code-panel";
import { maskEmailAddress } from "@/lib/contact";
import { getLiveDisputesForOrders } from "@/server/services/disputes";
import { referencesForGroups } from "@/server/services/order-groups";
import { invoiceKindsForOrders, orderInvoiceLabel } from "@/server/services/invoices";
import { listOrdersForUser } from "@/server/services/orders";
import { platformInvoiceLabel, platformInvoicesForOrders } from "@/server/tax/delivery-invoice";
import { listMyRatingsByOrder } from "@/server/services/ratings";
import { formatScheduledSlot } from "@/lib/scheduled-slots";
import { proofPhotosForOrders, signaturesForOrders } from "@/server/services/delivery-proofs";
import { getRule } from "@/server/services/settings";
import { getBuyerFulfilmentViews } from "@/server/services/fulfilment-options";
import { OrderFulfilmentCard } from "@/components/order-fulfilment-card";

const FINDING_RIDER = L("Finding a rider", "राइडर ढूँढ रहे हैं", "रायडर शोधत आहोत");
const DELIVERY_STATUS_LABELS: Record<string, Text> = {
  OFFERED: FINDING_RIDER,
  ACCEPTED: L("Rider assigned", "राइडर तय हुआ", "रायडर ठरला"),
  PICKED_UP: L("Picked up — on the way", "उठा लिया — रास्ते में", "उचलली — वाटेत"),
  DELIVERED: L("Delivered", "डिलीवर हुआ", "पोहोचली"),
  FAILED: L("Delivery attempt failed", "डिलीवरी की कोशिश असफल", "डिलिव्हरीचा प्रयत्न अयशस्वी"),
  REJECTED: FINDING_RIDER,
  CANCELLED: FINDING_RIDER,
};

/** Wording on the orders list (Module 6, docs/hindi-marathi-2026-11/). */
const T = {
  title: L("My Orders", "मेरे ऑर्डर", "माझ्या ऑर्डर"),
  description: L("Track everything you've ordered.", "अपने सभी ऑर्डर ट्रैक करें।", "तुम्ही दिलेल्या सर्व ऑर्डर ट्रॅक करा."),
  orderType: L("Order type", "ऑर्डर का प्रकार", "ऑर्डरचा प्रकार"),
  personal: L("Personal orders", "निजी ऑर्डर", "वैयक्तिक ऑर्डर"),
  business: L("Business orders", "बिज़नेस ऑर्डर", "व्यवसाय ऑर्डर"),
  cancelledTitle: L("Order {n} cancelled", "ऑर्डर {n} रद्द हुआ", "ऑर्डर {n} रद्द झाली"),
  cancelledText: L("The full amount has gone back to your wallet.", "पूरी रकम आपके वॉलेट में वापस आ गई है।", "पूर्ण रक्कम तुमच्या वॉलेटमध्ये परत आली आहे."),
  seeWallet: L("See wallet", "वॉलेट देखें", "वॉलेट पहा"),
  placedTitle: L("Order placed", "ऑर्डर हो गया", "ऑर्डर दिली"),
  placedText: L("Your order has been confirmed and paid from your wallet.", "आपका ऑर्डर पक्का हो गया है और वॉलेट से भुगतान हो गया है।", "तुमची ऑर्डर निश्चित झाली असून वॉलेटमधून पेमेंट झाले आहे."),
  active: L("Active", "चालू", "चालू"),
  past: L("Past", "पुराने", "मागील"),
  returns: L("Returns", "रिटर्न", "परतावे"),
  lists: L("My lists", "मेरी सूचियाँ", "माझ्या याद्या"),
  noActiveTitle: L("No order on the way right now", "अभी कोई ऑर्डर रास्ते में नहीं है", "सध्या कोणतीही ऑर्डर वाटेत नाही"),
  noPastTitle: L("No past orders yet", "अभी कोई पुराना ऑर्डर नहीं", "अजून मागील ऑर्डर नाहीत"),
  noActiveText: L("Orders you place appear here until they are delivered.", "आपके ऑर्डर डिलीवर होने तक यहाँ दिखते हैं।", "तुमच्या ऑर्डर पोहोचेपर्यंत इथे दिसतात."),
  noPastText: L("Delivered and cancelled orders appear here.", "डिलीवर और रद्द हुए ऑर्डर यहाँ दिखते हैं।", "पोहोचलेल्या आणि रद्द झालेल्या ऑर्डर इथे दिसतात."),
  seePast: L("See past orders", "पुराने ऑर्डर देखें", "मागील ऑर्डर पहा"),
  startShopping: L("Start shopping", "खरीदारी शुरू करें", "खरेदी सुरू करा"),
  completed: L("completed", "पूरा हुआ", "पूर्ण"),
  subscription: L("subscription", "सब्सक्रिप्शन", "सदस्यता"),
  businessBadge: L("business", "बिज़नेस", "व्यवसाय"),
  paidCash: L("paid in cash", "नकद में भुगतान हुआ", "रोख पैसे दिले"),
  payCash: L("pay cash on delivery", "डिलीवरी पर नकद भुगतान", "डिलिव्हरीवेळी रोख पैसे द्या"),
  saved: L("saved", "बचत", "बचत"),
  partOf: L("Part of {n}", "{n} का हिस्सा", "{n} चा भाग"),
  forDate: L(" · for {n}", " · {n} के लिए", " · {n} साठी"),
  photoAtDelivery: L("Photo at delivery", "डिलीवरी के समय की फ़ोटो", "डिलिव्हरीवेळीचा फोटो"),
  delivery: L("Delivery", "डिलीवरी", "डिलिव्हरी"),
  unavailableRefunded: L("Unavailable — refunded to your wallet", "उपलब्ध नहीं — पैसे वॉलेट में लौटाए गए", "उपलब्ध नाही — पैसे वॉलेटमध्ये परत केले"),
  replacedWith: L("Replaced with ", "इसकी जगह दिया गया: ", "याऐवजी दिले: "),
  shopSuggests: L("Shop suggests ", "दुकान का सुझाव: ", "दुकानाची सूचना: "),
  forAmount: L("for", "कीमत", "किंमत"),
  refundedUnavailable: L("refunded to your wallet for unavailable items.", "उपलब्ध न होने वाली चीज़ों के लिए आपके वॉलेट में लौटाए गए।", "उपलब्ध नसलेल्या वस्तूंसाठी तुमच्या वॉलेटमध्ये परत केले."),
  details: L("Details, refunds & help", "विवरण, रिफंड और मदद", "तपशील, परतावा आणि मदत"),
  getHelp: L("Get help with this order", "इस ऑर्डर के लिए मदद लें", "या ऑर्डरसाठी मदत घ्या"),
  returnItems: L("Return items", "सामान लौटाएँ", "वस्तू परत करा"),
  disputeOnOrder: L("on this order:", "इस ऑर्डर पर:", "या ऑर्डरवर:"),
  dispute: L("Dispute", "विवाद", "वाद"),
  viewCase: L("View the case", "केस देखें", "केस पहा"),
  raiseDispute: L("Raise a dispute", "विवाद दर्ज करें", "वाद नोंदवा"),
  walletInsufficient: L(
    "This delivery could not be paid for. Top up your wallet and retry from the subscription page.",
    "इस डिलीवरी का भुगतान नहीं हो सका। वॉलेट रिचार्ज करें और सब्सक्रिप्शन पेज से फिर कोशिश करें।",
    "या डिलिव्हरीचे पेमेंट होऊ शकले नाही. वॉलेट रिचार्ज करा आणि सदस्यता पानावरून पुन्हा प्रयत्न करा.",
  ),
} as const;

/** An order without a fulfilment plan is a GoKesari delivery; a plan says so explicitly. */
const byGoKesariRider = (plan?: { option: string }) => (plan?.option ?? "GOKESARI_PARTNER") === "GOKESARI_PARTNER";

/** Module 4: the link to the customer's signature at the door, with the time it was taken (IST). */
const SIGNATURE_LINK = L("Signature at delivery", "डिलीवरी पर हस्ताक्षर", "डिलिव्हरीवेळी स्वाक्षरी");
function formatProofTime(at: Date): string {
  return at.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

export const metadata = { title: "My Orders" };
export const dynamic = "force-dynamic";

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ placed?: string; type?: string; tab?: string; page?: string; cancelled?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const params = await searchParams;
  // GAP-014: tabs with their own page (an old link or a typed ?tab=returns) open that page, not the Active list.
  const ownPage = params.tab === "returns" ? "/returns" : params.tab === "lists" ? "/lists" : null;
  if (ownPage) redirect(ownPage);
  // Personal and business (B2B) orders are separate flows, listed apart.
  const showBusiness = can(user.role, PERMISSIONS.ORDER_PLACE_B2B);
  const orderType = showBusiness && params.type === "business" ? "B2B" : "PERSONAL";
  const [allOrders, lang] = await Promise.all([listOrdersForUser(user.id, { limit: 50, orderType }), getBoardLang()]);
  // Tabs = the board's Orders submenus: Active (on its way) and Past, same statuses as the badges.
  const active = allOrders.filter((o) => IN_PROGRESS_ORDER_STATUSES.includes(o.status));
  const past = allOrders.filter((o) => !IN_PROGRESS_ORDER_STATUSES.includes(o.status));
  const tab = pickTab(params.tab, ["active", "past"] as const, active.length > 0 || past.length === 0 ? "active" : "past");
  const page = paginate(tab === "active" ? active : past, params.page, 5);
  const orders = page.rows;
  const typeParam = orderType === "B2B" ? "&type=business" : "";
  const tabLabels = Object.fromEntries((CUSTOMER_MENUS.find((m) => m.key === "orders")?.items ?? []).map((i) => [i.key, tr(i.label, lang)]));
  const [groupRefs, deliveryOrders, myRatings, liveDisputes] = await Promise.all([
    referencesForGroups(orders.map((o) => o.orderGroupId)),
    getDeliveryOrdersForOrders(orders.map((o) => o.id)),
    listMyRatingsByOrder(user.id, orders.map((o) => o.id)),
    getLiveDisputesForOrders(orders.map((o) => o.id)),
  ]);
  // The delivery code (stored hashed): emailed / locked / new-code state for drops under way.
  const deliveryCodes = new Map(
    (
      await Promise.all(
        orders
          .filter((o) => o.status === "OUT_FOR_DELIVERY" && deliveryOrders.has(o.id))
          .map(async (o) => [o.id, await buyerDeliveryCodeView(deliveryOrders.get(o.id)!)] as const),
      )
    ).filter((entry): entry is readonly [string, BuyerDeliveryCodeView] => entry[1] != null && (entry[1].active || entry[1].locked)),
  );
  // Fulfilment options (docs/four-features-2026-10): pickup / own delivery / GoKesari plan and time.
  const fulfilmentPlans = await getBuyerFulfilmentViews(orders.map((o) => o.id), user);
  // NEW-007: delivery photo and invoice links on delivered orders.
  const deliveredIds = orders.filter((o) => o.status === "DELIVERED").map((o) => o.id);
  const [proofPhotos, invoicingRule, cancellationRule, afterPackingRule, invoiceKinds, gokesariInvoices, signatures] = await Promise.all([
    proofPhotosForOrders(deliveredIds),
    getRule("invoicing"),
    getRule("cancellation"),
    getRule("afterPackingCancellation"), // batch-2026-10 WS-C
    // Billing v2 (QA D-112, D-113): the invoice's own kind, and GoKesari's s.9(5) invoices.
    invoiceKindsForOrders(deliveredIds),
    platformInvoicesForOrders(deliveredIds),
    // Module 4: the customer's signature at the door (rule deliveryProof.signatureEnabled).
    signaturesForOrders(deliveredIds),
  ]);
  // TC-ORD-008: the server's own D10 rule (lib/order-cancellation.ts) — before
  // packing by rule `cancellation`, after packing for the fee (WS-C), and after
  // pickup for the goods; the server checks again.
  const cancellable: readonly string[] = customerCancellableStatuses({
    customerMayCancelUntil: cancellationRule.customerMayCancelUntil,
    afterPackingEnabled: afterPackingRule.enabled,
  });

  return (
    <>
      <PageHeader
        title={tr(T.title, lang)}
        description={tr(T.description, lang)}
      />

      {showBusiness ? (
        <nav className="mb-6 flex gap-2" aria-label={tr(T.orderType, lang)}>
          <LinkButton
            href="/orders"
            variant={orderType === "PERSONAL" ? "primary" : "secondary"}
          >
            {tr(T.personal, lang)}
          </LinkButton>
          <LinkButton
            href="/orders?type=business"
            variant={orderType === "B2B" ? "primary" : "secondary"}
          >
            {tr(T.business, lang)}
          </LinkButton>
        </nav>
      ) : null}

      {params.cancelled ? (
        <div className="mb-6" data-testid="order-cancelled">
          <Alert tone="success" title={tr(T.cancelledTitle, lang).replace("{n}", params.cancelled)}>
            {tr(T.cancelledText, lang)}{" "}
            <Link href="/wallet#history" className="font-medium underline">
              {tr(T.seeWallet, lang)}
            </Link>
          </Alert>
        </div>
      ) : null}

      {params.placed ? (
        <div className="mb-6">
          <Alert tone="success" title={tr(T.placedTitle, lang)}>
            {tr(T.placedText, lang)}
          </Alert>
        </div>
      ) : null}

      <ListTabs
        label={tr(UI.orders, lang)}
        active={tab}
        tabs={[
          { key: "active", label: tabLabels.active ?? tr(T.active, lang), href: `/orders?tab=active${typeParam}`, count: active.length, urgent: true },
          { key: "past", label: tabLabels.past ?? tr(T.past, lang), href: `/orders?tab=past${typeParam}`, count: past.length },
          { key: "returns", label: tabLabels.returns ?? tr(T.returns, lang), href: "/returns" },
          // docs/purchase-lists-2026-10: the Orders tile's "Lists" lands here on phones.
          { key: "lists", label: tabLabels.lists ?? tr(T.lists, lang), href: "/lists" },
        ]}
      />

      {orders.length === 0 && allOrders.length > 0 ? (
        <EmptyState
          illustration={<EmptyIllustration name="orders" />}
          title={tr(tab === "active" ? T.noActiveTitle : T.noPastTitle, lang)}
          description={tr(tab === "active" ? T.noActiveText : T.noPastText, lang)}
          action={<LinkButton href={tab === "active" ? "/orders?tab=past" : "/"}>{tr(tab === "active" ? T.seePast : T.startShopping, lang)}</LinkButton>}
        />
      ) : orders.length === 0 ? (
        <EmptyState
          illustration={<EmptyIllustration name="orders" />}
          title={tr(HOME.ordersEmptyTitle, lang)}
          description={tr(HOME.ordersEmptyText, lang)}
          action={<LinkButton href="/">{tr(HOME.startShopping, lang)}</LinkButton>}
          secondaryAction={
            <LinkButton href="/shops" variant="secondary">
              {tr(HOME.seeShopsNearYou, lang)}
            </LinkButton>
          }
          testId="orders-empty"
        />
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <Card key={order.id} id={`order-${order.orderNumber}`} className="p-5" data-testid="order-card">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={order.status} />
                  {/* Gig worker flow (feature 11): the delivered order was confirmed complete. */}
                  {order.completedAt ? <Badge tone="success">{tr(T.completed, lang)}</Badge> : null}
                  {order.source === "SUBSCRIPTION" ? (
                    <Badge tone="info">{tr(T.subscription, lang)}</Badge>
                  ) : null}
                  {order.orderType === "B2B" ? <Badge tone="info">{tr(T.businessBadge, lang)}</Badge> : null}
                  {order.paymentMethod === "COD" ? (
                    <Badge tone="warning">{tr(order.codCollectedAt ? T.paidCash : T.payCash, lang)}</Badge>
                  ) : null}
                  <span className="text-sm text-ink-500">
                    {order.orderNumber}
                  </span>
                  {order.discountPaise > 0 ? (
                    <Badge tone="success">
                      {order.couponCode ? `${order.couponCode} · ` : ""}{tr(T.saved, lang)} <Money paise={order.discountPaise} />
                    </Badge>
                  ) : null}
                  {order.orderGroupId && groupRefs.get(order.orderGroupId) ? (
                    <Link
                      href={`/orders/group/${groupRefs.get(order.orderGroupId)}`}
                      className="text-xs text-kesari-700 hover:underline"
                      data-testid="parent-order-ref"
                    >
                      {tr(T.partOf, lang).replace("{n}", groupRefs.get(order.orderGroupId) ?? "")}
                    </Link>
                  ) : null}
                </div>
                <span className="font-semibold text-ink-900">
                  <Money paise={order.totalPaise} />
                </span>
              </div>

              <p className="text-sm font-medium text-ink-900">{order.shopName}</p>
              <p className="text-xs text-ink-500">
                {new Date(order.createdAt).toLocaleString("en-IN", {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: "Asia/Kolkata",
                })}
                {order.deliveryDate && !order.scheduledSlotStart ? tr(T.forDate, lang).replace("{n}", order.deliveryDate) : ""}
              </p>
              {order.status === "DELIVERED" && (invoicingRule.enabled || proofPhotos.has(order.id) || gokesariInvoices.has(order.id) || signatures.has(order.id)) ? (
                <p className="mt-1 flex flex-wrap gap-3 text-xs" data-testid="order-documents">
                  {invoicingRule.enabled ? (
                    <a href={`/api/orders/${order.id}/invoice`} className="font-medium text-kesari-700 hover:underline">
                      {orderInvoiceLabel(invoiceKinds.get(order.id))}
                    </a>
                  ) : null}
                  {(gokesariInvoices.get(order.id) ?? []).map((g) => (
                    <a key={g.id} href={`/api/delivery-invoices/${g.id}/pdf`} className="font-medium text-kesari-700 hover:underline">
                      {platformInvoiceLabel(g.kind)}
                    </a>
                  ))}
                  {proofPhotos.has(order.id) ? (
                    <a href={proofPhotos.get(order.id)!.url} target="_blank" rel="noreferrer" className="font-medium text-kesari-700 hover:underline">
                      {tr(T.photoAtDelivery, lang)}
                    </a>
                  ) : null}
                  {signatures.has(order.id) ? (
                    <a href={signatures.get(order.id)!.url} target="_blank" rel="noreferrer" className="font-medium text-kesari-700 hover:underline" data-testid="order-signature">
                      {tr(SIGNATURE_LINK, lang)} · {formatProofTime(signatures.get(order.id)!.takenAt)}
                    </a>
                  ) : null}
                </p>
              ) : null}
              {order.scheduledSlotStart && order.scheduledSlotEnd ? (
                <p className="text-xs font-medium text-kesari-700" data-testid="order-scheduled-slot">
                  {tr(T.delivery, lang)} {formatScheduledSlot(order.scheduledSlotStart, order.scheduledSlotEnd)}
                </p>
              ) : null}

              <ul className="mt-3 space-y-1 text-sm text-ink-600">
                {order.items.map((item) => (
                  <li key={item.id}>
                    <div className="flex justify-between gap-3">
                      <span className={item.fulfilmentStatus === "REMOVED" ? "line-through" : undefined}>
                        {item.productNameSnapshot} ·{" "}
                        {formatQuantity(item.quantityMilli, item.unitSnapshot)}
                      </span>
                      <Money paise={item.lineTotalPaise} />
                    </div>
                    {item.fulfilmentStatus === "REMOVED" ? (
                      <p className="text-xs text-ink-500">{tr(T.unavailableRefunded, lang)}</p>
                    ) : null}
                    {item.substituteNameSnapshot &&
                    (item.fulfilmentStatus === "SUBSTITUTION_PROPOSED" || item.fulfilmentStatus === "SUBSTITUTED") ? (
                      <p className="text-xs text-ink-500">
                        {tr(item.fulfilmentStatus === "SUBSTITUTED" ? T.replacedWith : T.shopSuggests, lang)}
                        {item.substituteNameSnapshot}
                        {item.substituteQuantityMilli && item.substituteUnitSnapshot
                          ? ` · ${formatQuantity(item.substituteQuantityMilli, item.substituteUnitSnapshot)}`
                          : ""}
                        {item.substituteLineTotalPaise != null ? (
                          <>
                            {" "}
                            {tr(T.forAmount, lang)} <Money paise={item.substituteLineTotalPaise} />
                          </>
                        ) : null}
                      </p>
                    ) : null}
                    {item.fulfilmentStatus === "SUBSTITUTION_PROPOSED" ? (
                      <SubstitutionDecision orderId={order.id} itemId={item.id} />
                    ) : null}
                  </li>
                ))}
              </ul>

              {/* GAP-018: the delivery fee given back for a pickup is shown on the fulfilment card, not as "unavailable items". */}
              {order.refundedPaise - (fulfilmentPlans.get(order.id)?.deliveryFeeRefundedPaise ?? 0) > 0 ? (
                <p className="mt-2 text-xs text-ink-500">
                  <Money paise={order.refundedPaise - (fulfilmentPlans.get(order.id)?.deliveryFeeRefundedPaise ?? 0)} />{" "}
                  {tr(T.refundedUnavailable, lang)}
                </p>
              ) : null}

              {order.source !== "SUBSCRIPTION" && cancellable.includes(order.status) ? (
                <CancelOrderButton orderId={order.id} orderNumber={order.orderNumber} lang={lang} />
              ) : null}

              {/* batch-2026-10 WS-C: refund timeline, charges and help for this order. */}
              <p className="mt-3 flex flex-wrap gap-3 text-xs">
                <Link href={`/orders/${order.id}`} className="font-medium text-kesari-700 hover:underline" data-testid="order-details-link">
                  {tr(T.details, lang)}
                </Link>
                <Link href={`/support?orderId=${order.id}`} className="font-medium text-kesari-700 hover:underline">
                  {tr(T.getHelp, lang)}
                </Link>
              </p>

              {fulfilmentPlans.has(order.id) &&
              !["CANCELLED", "REFUNDED", "REFUND_PENDING"].includes(order.status) ? (
                <OrderFulfilmentCard orderId={order.id} info={fulfilmentPlans.get(order.id)!} />
              ) : null}

              {order.status === "OUT_FOR_DELIVERY" && deliveryCodes.get(order.id) ? (
                <DeliveryCodePanel
                  orderId={order.id}
                  maskedEmail={maskEmailAddress(user.email)}
                  locked={deliveryCodes.get(order.id)!.locked}
                  ticketNumber={deliveryCodes.get(order.id)!.ticketNumber}
                  resendsLeft={deliveryCodes.get(order.id)!.resendsLeft}
                  lang={lang}
                />
              ) : null}

              {/* GAP-018: no rider line once the shop has changed the order to pickup or its own delivery. */}
              {deliveryOrders.has(order.id) && byGoKesariRider(fulfilmentPlans.get(order.id)) ? (
                <p className="mt-3 border-t border-cream-100 pt-3 text-sm text-ink-600">
                  {DELIVERY_STATUS_LABELS[deliveryOrders.get(order.id)!.status] ? tr(DELIVERY_STATUS_LABELS[deliveryOrders.get(order.id)!.status], lang) : undefined} ·{" "}
                  {deliveryOrders.get(order.id)!.partnerName}
                </p>
              ) : null}

              {/*
                GS-042/NAV-004 + event layer: "Track delivery" for an order that
                has a rider and has not finished. The map and its 5-second poll
                start only when the customer opens it; the panel's own API
                decides what this viewer may see.
              */}
              {deliveryOrders.has(order.id) && byGoKesariRider(fulfilmentPlans.get(order.id)) && isTrackableOrderStatus(order.status) ? (
                <div className="mt-3">
                  <TrackDeliveryButton orderId={order.id} lang={lang} />
                </div>
              ) : null}

              {order.status === "DELIVERED" || order.status === "DISPUTED" ? (
                <RateOrderForm
                  orderId={order.id}
                  canRateShop={myRatings.get(order.id)?.shop == null}
                  canRateRider={
                    myRatings.get(order.id)?.rider == null && deliveryOrders.get(order.id)?.status === "DELIVERED"
                  }
                  shopScore={myRatings.get(order.id)?.shop ?? null}
                  riderScore={myRatings.get(order.id)?.rider ?? null}
                />
              ) : null}

              {order.status === "DELIVERED" && order.orderType === "PERSONAL" ? (
                <div className="mt-3">
                  <LinkButton href={`/orders/${order.id}/return`} variant="secondary">
                    {tr(T.returnItems, lang)}
                  </LinkButton>
                </div>
              ) : null}

              {/*
                GS-058: while a dispute is open on this order, the card says so
                instead of inviting another report — a second case on the same
                order is refused by the service anyway.
              */}
              {liveDisputes.has(order.id) ? (
                <p className="mt-3 rounded-lg bg-cream-50 px-3 py-2 text-sm text-ink-700">
                  {tr(T.dispute, lang)} <span className="font-mono">{liveDisputes.get(order.id)!.caseNumber}</span> {tr(T.disputeOnOrder, lang)}{" "}
                  <span className="font-medium">
                    {DISPUTE_STATUS_LABELS[liveDisputes.get(order.id)!.status].toLowerCase()}
                  </span>
                  .{" "}
                  <Link href={`/disputes/${liveDisputes.get(order.id)!.id}`} className="font-medium underline">
                    {tr(T.viewCase, lang)}
                  </Link>
                </p>
              ) : order.paidAt && order.status !== "PENDING" ? (
                <>
                  {/* Event layer: a delivered order can be disputed directly — case number at once. */}
                  {order.status === "DELIVERED" || order.status === "DISPUTED" ? (
                    <div className="mt-3">
                      <LinkButton href={`/orders/${order.id}/dispute`} variant="secondary">
                        {tr(T.raiseDispute, lang)}
                      </LinkButton>
                    </div>
                  ) : null}
                  <ReportIssueForm orderId={order.id} />
                </>
              ) : null}

              {order.status === "WALLET_INSUFFICIENT" ? (
                <div className="mt-3">
                  <Alert tone="danger">
                    {tr(T.walletInsufficient, lang)}
                  </Alert>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
      <Pager lang={lang} page={page.page} pageCount={page.pageCount} hrefFor={(n) => `/orders?tab=${tab}${typeParam}&page=${n}`} />
    </>
  );
}
