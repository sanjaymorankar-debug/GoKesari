"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Money, StatusBadge } from "@/components/ui";
import { FulfilmentPlanner, type PlannerPlan, type PlannerStaff } from "@/components/fulfilment-planner";
import type { SlotDay } from "@/lib/fulfilment-options";
import { formatQuantity } from "@/lib/money";
import { SHOP_REMOVE_LINE_REASON } from "@/lib/order-line-removal";
import { paymentMethodLabel } from "@/lib/payment-methods";
import { formatScheduledSlot } from "@/lib/scheduled-slots";
import { ConfirmButton } from "@/components/confirm-button";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";

/** Module 6: Hindi / Marathi for the shop's order queue (English unchanged). */
const T = {
  outOwn: L("Out for delivery (own delivery)", "डिलीवरी के लिए निकला (अपनी डिलीवरी)", "डिलिव्हरीसाठी निघाली (स्वतःची डिलिव्हरी)"),
  handed: L("Handed to customer", "ग्राहक को सौंपा", "ग्राहकाला दिली"),
  markDelivered: L("Mark delivered", "डिलीवर हुआ मार्क करें", "पोहोचली म्हणून नोंदवा"),
  markReturned: L("Mark returned to shop", "दुकान पर वापस आया मार्क करें", "दुकानात परत आली म्हणून नोंदवा"),
  retryDelivery: L("Retry delivery", "फिर से डिलीवरी करें", "पुन्हा डिलिव्हरी करा"),
  dOffered: L("Offer sent to rider", "राइडर को ऑफ़र भेजा", "रायडरला ऑफर पाठवली"),
  dAccepted: L("Rider on the way to you", "राइडर आपकी ओर आ रहा है", "रायडर तुमच्याकडे येत आहे"),
  dPicked: L("Picked up by rider", "राइडर ने उठा लिया", "रायडरने उचलली"),
  dDelivered: L("Delivered by rider", "राइडर ने डिलीवर किया", "रायडरने पोहोचवली"),
  dRejected: L("Looking for another rider", "दूसरा राइडर खोज रहे हैं", "दुसरा रायडर शोधत आहोत"),
  dCancelled: L("Assignment cancelled", "असाइनमेंट रद्द", "नेमणूक रद्द"),
  dFailed: L("Delivery failed", "डिलीवरी असफल", "डिलिव्हरी अयशस्वी"),
  iPicked: L("picked", "उठाया", "घेतले"),
  iProposed: L("waiting for customer", "ग्राहक का इंतज़ार", "ग्राहकाची वाट"),
  iSubstituted: L("substituted", "बदला गया", "बदलले"),
  iRemoved: L("removed · refunded", "हटाया · रिफंड हुआ", "काढले · परतावा दिला"),
  errOrder: L("Could not update the order.", "ऑर्डर अपडेट नहीं हो सका।", "ऑर्डर अपडेट करता आली नाही."),
  errStatus: L("Could not update status.", "स्टेटस अपडेट नहीं हो सका।", "स्थिती अपडेट करता आली नाही."),
  errRider: L("No delivery partner is available right now.", "अभी कोई डिलीवरी पार्टनर उपलब्ध नहीं है।", "सध्या कोणताही डिलिव्हरी पार्टनर उपलब्ध नाही."),
  errStop: L("Could not stop the search.", "खोज रोकी नहीं जा सकी।", "शोध थांबवता आला नाही."),
  completed: L("completed", "पूरा हुआ", "पूर्ण"),
  business: L("business order", "बिज़नेस ऑर्डर", "व्यावसायिक ऑर्डर"),
  cashCollected: L("cash collected", "नकद मिल गया", "रोख मिळाली"),
  cod: L("cash on delivery", "कैश ऑन डिलीवरी", "कॅश ऑन डिलिव्हरी"),
  payment: L("Payment:", "भुगतान:", "पेमेंट:"),
  deliver: L("Deliver", "डिलीवरी", "डिलिव्हरी"),
  acceptBy: L("Accept by", "इतने बजे तक स्वीकारें:", "या वेळेपर्यंत स्वीकारा:"),
  partner: L("Delivery partner:", "डिलीवरी पार्टनर:", "डिलिव्हरी पार्टनर:"),
  call: L("Call", "कॉल करें", "कॉल करा"),
  note: L("Note from the customer:", "ग्राहक का संदेश:", "ग्राहकाची सूचना:"),
  invoice: L("Invoice", "इनवॉइस", "इनव्हॉइस"),
  photo: L("Photo at delivery", "डिलीवरी के समय की फ़ोटो", "डिलिव्हरीच्या वेळचा फोटो"),
  help: L("Get help with this order", "इस ऑर्डर के लिए मदद लें", "या ऑर्डरसाठी मदत घ्या"),
  pickupCode: L("Pickup code for the rider:", "राइडर के लिए पिकअप कोड:", "रायडरसाठी पिकअप कोड:"),
  qrTitle: L("Pickup QR — the rider scans it at handover", "पिकअप QR — सौंपते समय राइडर इसे स्कैन करेगा", "पिकअप QR — देताना रायडर हा स्कॅन करेल"),
  qrHint: L("Works once. The pickup code still works if the scan fails.", "एक बार ही चलेगा। स्कैन न हो तो पिकअप कोड काम करेगा।", "एकदाच चालतो. स्कॅन न झाल्यास पिकअप कोड चालेल."),
  printSlip: L("Print packing slip", "पैकिंग स्लिप प्रिंट करें", "पॅकिंग स्लिप प्रिंट करा"),
  accept: L("Accept order", "ऑर्डर स्वीकारें", "ऑर्डर स्वीकारा"),
  reject: L("Reject", "अस्वीकार करें", "नाकारा"),
  startPicking: L("Start picking", "सामान निकालना शुरू करें", "माल काढायला सुरुवात करा"),
  packedReady: L("Packed — mark ready", "पैक हुआ — तैयार मार्क करें", "पॅक झाले — तयार म्हणून नोंदवा"),
  tryAgainRider: L("Try finding a rider again", "फिर से राइडर खोजें", "पुन्हा रायडर शोधा"),
  findRider: L("Find rider now", "अभी राइडर खोजें", "आता रायडर शोधा"),
  stopSearching: L("Stop searching", "खोज बंद करें", "शोध थांबवा"),
  yesCancel: L("Yes, cancel and refund", "हाँ, रद्द करें और रिफंड दें", "होय, रद्द करा आणि परतावा द्या"),
  cancelQ: L("Cancel and refund the customer?", "ऑर्डर रद्द करके ग्राहक को रिफंड दें?", "ऑर्डर रद्द करून ग्राहकाला परतावा द्यायचा?"),
  cancelRefund: L("Cancel & refund customer", "रद्द करें और ग्राहक को रिफंड दें", "रद्द करा आणि ग्राहकाला परतावा द्या"),
  addressPending: L(
    "Waiting for the customer's delivery location. Pack the order and mark it ready — the delivery starts once the location is set.",
    "ग्राहक के डिलीवरी लोकेशन का इंतज़ार है। ऑर्डर पैक करके तैयार करें — लोकेशन मिलते ही डिलीवरी शुरू होगी।",
    "ग्राहकाच्या डिलिव्हरी लोकेशनची वाट पाहत आहोत. ऑर्डर पॅक करून तयार करा — लोकेशन मिळताच डिलिव्हरी सुरू होईल.",
  ),
  waitingSub: L("Waiting for the customer to approve or reject a substitute.", "ग्राहक के बदले हुए सामान को मंज़ूर या मना करने का इंतज़ार है।", "बदली वस्तू ग्राहक मंजूर करतो की नाकारतो याची वाट पाहत आहोत."),
  reasonPh: L("Reason, shown to the customer", "कारण (ग्राहक को दिखेगा)", "कारण (ग्राहकाला दिसेल)"),
  reasonAria: L("Reason for rejecting the order", "ऑर्डर अस्वीकार करने का कारण", "ऑर्डर नाकारण्याचे कारण"),
  rejectRefund: L("Reject & refund", "अस्वीकार करें और रिफंड दें", "नाकारा आणि परतावा द्या"),
  substitute: L("Substitute:", "बदले में:", "बदली वस्तू:"),
  pickedTick: L("Picked ✓", "निकाल लिया ✓", "काढले ✓"),
  offerSub: L("Offer substitute", "बदले में दूसरा सामान दें", "बदली वस्तू सुचवा"),
  unavailable: L("Unavailable — remove & refund", "उपलब्ध नहीं — हटाएँ और रिफंड दें", "उपलब्ध नाही — काढा आणि परतावा द्या"),
  subAria: L("Substitute product", "बदले का उत्पाद", "बदली उत्पादन"),
  chooseSub: L("Choose a substitute…", "बदले का सामान चुनें…", "बदली वस्तू निवडा…"),
  sendCustomer: L("Send to customer", "ग्राहक को भेजें", "ग्राहकाला पाठवा"),
} as const satisfies Record<string, Text>;

/**
 * Manual status steps that stay available for shops delivering themselves or
 * handing over in store (READY/OUT_FOR_DELIVERY/FAILED). Accept → pick →
 * pack → ready now goes through the fulfilment actions below.
 */
const MANUAL_STEPS: Record<string, { to: string; label: Text }[]> = {
  READY: [
    { to: "OUT_FOR_DELIVERY", label: T.outOwn },
    { to: "DELIVERED", label: T.handed },
  ],
  OUT_FOR_DELIVERY: [{ to: "DELIVERED", label: T.markDelivered }],
  FAILED: [
    { to: "RETURNED", label: T.markReturned },
    { to: "OUT_FOR_DELIVERY", label: T.retryDelivery },
  ],
};

const DELIVERY_STATUS_LABEL: Record<string, Text> = {
  OFFERED: T.dOffered,
  ACCEPTED: T.dAccepted,
  PICKED_UP: T.dPicked,
  DELIVERED: T.dDelivered,
  REJECTED: T.dRejected,
  CANCELLED: T.dCancelled,
  FAILED: T.dFailed,
};

const ITEM_STATUS_LABEL: Record<string, Text> = {
  PICKED: T.iPicked,
  SUBSTITUTION_PROPOSED: T.iProposed,
  SUBSTITUTED: T.iSubstituted,
  REMOVED: T.iRemoved,
};

export interface ShopOrderItem {
  id: string;
  productNameSnapshot: string;
  unitSnapshot: string;
  quantityMilli: number;
  /** TC-SPI-008: the price per unit at sale. */
  unitPricePaise?: number;
  lineTotalPaise: number;
  fulfilmentStatus: string;
  substituteNameSnapshot: string | null;
  substituteUnitSnapshot: string | null;
  substituteQuantityMilli: number | null;
  substituteLineTotalPaise: number | null;
}

export interface ShopOrderRow {
  id: string;
  orderNumber: string;
  status: string;
  totalPaise: number;
  createdAt: string;
  items: ShopOrderItem[];
  deliveryStatus: string | null;
  /** Read this to the rider at handover (only while a rider is assigned). */
  pickupCode: string | null;
  /** Progress of the automatic rider search, for READY orders of a delivering shop. */
  riderSearch?: {
    state: string;
    message: string;
    attempts: number;
    maxAttempts: number;
    canRetry: boolean;
  } | null;
  orderType?: string;
  /** GS-030: COD orders are paid in cash at the door (by the rider, or to you if you deliver). */
  paymentMethod?: string;
  cashCollected?: boolean;
  /** GS-027: the delivery time the customer chose. */
  scheduledSlot?: { start: string; end: string } | null;
  /** NEW-007: accept by this time or the order is cancelled automatically. */
  acceptByAt?: string | null;
  /** NEW-007: links for a delivered order. */
  invoiceUrl?: string | null;
  /** QA D-121: "Tax invoice", "Bill of supply" or "Invoice" (not issued yet), from orderInvoiceLabel. */
  invoiceLabel?: string;
  proofPhotoUrl?: string | null;
  /** Module 4: the customer's signature at the door and when it was taken (ISO). */
  signatureUrl?: string | null;
  signatureAt?: string | null;
  /** Fulfilment options (docs/four-features-2026-10): the order's pickup / delivery plan. */
  fulfilmentPlan?: PlannerPlan | null;
  /** The order has a delivery address (own delivery and GoKesari need one). */
  hasAddress?: boolean;
  /** Onboarding v2 (QA D-166): a paid delivery order still waiting for the customer's delivery location. */
  addressPending?: boolean;
  /** The customer's delivery fee still on the order (pickup gives it back). */
  deliveryFeePaise?: number;
  /** batch-2026-10 WS-B (rule pickupQr): the signed single-use pickup QR for a packed order (SVG markup from the server). */
  pickupQr?: { svg: string; expiresAt: string } | null;
  /** batch-2026-10 WS-B: printable packing slip with the QR. */
  packingSlipUrl?: string | null;
  /** The customer's note for the shop, from checkout (TC-CART-017). */
  notes?: string | null;
  /**
   * Gig worker flow (feature 8): the GoKesari partner on the order as the server lets the shop see
   * them — null partner with "Partner pending assignment" when hidden or not yet assigned.
   */
  deliveryPartner?: {
    label: string;
    partner: { name: string; riderId: string; photoUrl: string | null; mobile: string | null; vehicleType: string } | null;
  } | null;
  /** Gig worker flow (feature 11): the delivered order was confirmed complete. */
  completedAt?: string | null;
}

/** Fulfilment options switched on: the slots and delivery people the planner offers. */
export interface ShopFulfilmentSettings {
  /** Rule fulfilmentOptions on: a PREPARING order is marked ready through the planner. */
  enabled: boolean;
  days: SlotDay[];
  staff: PlannerStaff[];
  /** Rule fulfilmentOptions.refundDeliveryFeeOnPickup. */
  refundDeliveryFeeOnPickup?: boolean;
}

export interface SubstituteOption {
  shopProductId: string;
  label: string;
}

/** Shop-owner order queue: accept → pick → pack → ready → rider handover (Slices 3–4). */
export function ShopOrderManager({
  orders,
  deliveryAvailable,
  substitutes = [],
  fulfilment = null,
  lang = "en",
}: {
  orders: ShopOrderRow[];
  deliveryAvailable: boolean;
  /** This shop's online-buyable products, for proposing a substitute. */
  substitutes?: SubstituteOption[];
  /** Fulfilment options (rule fulfilmentOptions); null while the rule is off. */
  fulfilment?: ShopFulfilmentSettings | null;
  /** Module 6: the board language (English by default). */
  lang?: Lang;
}) {
  const router = useRouter();

  return (
    <div className="space-y-3">
      {orders.map((order) => (
        <OrderRow
          key={order.id}
          order={order}
          deliveryAvailable={deliveryAvailable}
          substitutes={substitutes}
          fulfilment={fulfilment}
          lang={lang}
          onChanged={() => router.refresh()}
        />
      ))}
    </div>
  );
}

function OrderRow({
  order,
  deliveryAvailable,
  substitutes,
  fulfilment,
  lang,
  onChanged,
}: {
  order: ShopOrderRow;
  deliveryAvailable: boolean;
  substitutes: SubstituteOption[];
  fulfilment: ShopFulfilmentSettings | null;
  lang: Lang;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  async function call(url: string, method: string, body: unknown, fallback: string) {
    setBusy(true);
    setError(null);
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(errorText(payload?.error?.message ?? fallback, lang, payload?.error?.code));
      return false;
    }
    onChanged();
    return true;
  }

  const fulfil = (body: Record<string, unknown>) =>
    call(`/api/orders/${order.id}/fulfilment`, "POST", body, tr(T.errOrder, lang));
  const advance = (to: string) =>
    call(`/api/orders/${order.id}/status`, "PATCH", { status: to }, tr(T.errStatus, lang));
  const findRider = () =>
    call(`/api/orders/${order.id}/assign`, "POST", {}, tr(T.errRider, lang));
  const stopSearch = () =>
    call(`/api/orders/${order.id}/assign`, "POST", { stop: true }, tr(T.errStop, lang));

  const working = order.status === "ACCEPTED" || order.status === "PREPARING";
  const waitingOnCustomer = order.items.some((i) => i.fulfilmentStatus === "SUBSTITUTION_PROPOSED");
  // A rider is actively on this order (a declined/expired/cancelled offer
  // does not count — the shop can retry or deliver itself).
  const riderActive = ["OFFERED", "ACCEPTED", "PICKED_UP"].includes(order.deliveryStatus ?? "");
  // Fulfilment options: a planned order is handed over from its plan; riders only for a GoKesari plan.
  const plan = order.fulfilmentPlan ?? null;
  const riderPlan = !plan || plan.option === "GOKESARI_PARTNER";
  const plannerShown = Boolean(fulfilment && ((fulfilment.enabled && order.status === "PREPARING") || plan));

  return (
    <Card className="p-4" data-testid="shop-order">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={order.status} />
          {order.completedAt ? (
            <Badge tone="success" data-testid="order-completed">
              {tr(T.completed, lang)}
            </Badge>
          ) : null}
          {order.orderType === "B2B" ? <Badge tone="info">{tr(T.business, lang)}</Badge> : null}
          {order.paymentMethod === "COD" ? (
            <Badge tone="warning">{order.cashCollected ? tr(T.cashCollected, lang) : tr(T.cod, lang)}</Badge>
          ) : null}
          {order.deliveryStatus ? (
            <Badge tone="info">{DELIVERY_STATUS_LABEL[order.deliveryStatus] ? tr(DELIVERY_STATUS_LABEL[order.deliveryStatus], lang) : order.deliveryStatus}</Badge>
          ) : null}
          <span className="text-sm text-ink-500">{order.orderNumber}</span>
          {/* TC-SPI-008: how the customer pays, for every method (cash on delivery also has its badge). */}
          {paymentMethodLabel(order.paymentMethod) ? (
            <span className="text-xs text-ink-500" data-testid="shop-order-payment">
              {tr(T.payment, lang)} {paymentMethodLabel(order.paymentMethod)}
            </span>
          ) : null}
          {order.scheduledSlot ? (
            <Badge tone="warning">{tr(T.deliver, lang)} {formatScheduledSlot(order.scheduledSlot.start, order.scheduledSlot.end)}</Badge>
          ) : null}
          {order.acceptByAt && order.status === "CONFIRMED" ? (
            <Badge tone="danger">
              {tr(T.acceptBy, lang)}{" "}
              {new Date(order.acceptByAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}
            </Badge>
          ) : null}
        </div>
        <span className="font-semibold text-ink-900">
          <Money paise={order.totalPaise} />
        </span>
      </div>

      {order.deliveryPartner ? (
        <div className="mt-2 flex items-center gap-3 rounded-lg bg-cream-100 px-3 py-2 text-sm" data-testid="shop-order-partner">
          {order.deliveryPartner.partner?.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- access-checked /api/images link
            <img src={order.deliveryPartner.partner.photoUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
          ) : null}
          <div>
            <p className="font-medium text-ink-900">
              {tr(T.partner, lang)} {order.deliveryPartner.label}
              {order.deliveryPartner.partner ? <span className="ml-1 text-xs text-ink-500">({order.deliveryPartner.partner.riderId})</span> : null}
            </p>
            {order.deliveryPartner.partner?.mobile ? (
              <a href={`tel:+91${order.deliveryPartner.partner.mobile}`} className="text-xs font-medium text-kesari-700 hover:underline">
                {tr(T.call, lang)} {order.deliveryPartner.partner.mobile}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      {order.notes ? (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-ink-800" data-testid="shop-order-notes">
          <span className="font-medium">{tr(T.note, lang)}</span> {order.notes}
        </p>
      ) : null}

      {order.invoiceUrl || order.proofPhotoUrl || order.signatureUrl ? (
        <p className="mt-2 flex flex-wrap gap-3 text-xs">
          {order.invoiceUrl ? (
            <a href={order.invoiceUrl} className="font-medium text-kesari-700 hover:underline">
              {order.invoiceLabel ?? tr(T.invoice, lang)}
            </a>
          ) : null}
          {order.proofPhotoUrl ? (
            <a href={order.proofPhotoUrl} target="_blank" rel="noreferrer" className="font-medium text-kesari-700 hover:underline">
              {tr(T.photo, lang)}
            </a>
          ) : null}
          {order.signatureUrl ? (
            <a href={order.signatureUrl} target="_blank" rel="noreferrer" className="font-medium text-kesari-700 hover:underline" data-testid="shop-order-signature">
              Signature at delivery
              {order.signatureAt
                ? ` · ${new Date(order.signatureAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}`
                : ""}
            </a>
          ) : null}
        </p>
      ) : null}
      {/* batch-2026-10 WS-C: raise a help desk ticket about this order. */}
      <p className="mt-2 text-xs">
        <a href={`/shop/support?orderId=${order.id}#new`} className="font-medium text-kesari-700 hover:underline">
          {tr(T.help, lang)}
        </a>
      </p>
      {order.pickupCode && order.status === "ASSIGNED" ? (
        <p className="mt-2 rounded-lg bg-kesari-50 px-3 py-2 text-sm text-kesari-800" data-testid="pickup-code">
          {tr(T.pickupCode, lang)} <span className="font-mono text-lg font-bold tracking-widest">{order.pickupCode}</span>
        </p>
      ) : null}

      {order.pickupQr ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-cream-100 px-3 py-2" data-testid="pickup-qr">
          {/* Server-rendered by the qrcode library from our own signed payload — no user input. */}
          <div className="h-32 w-32 shrink-0 bg-white" dangerouslySetInnerHTML={{ __html: order.pickupQr.svg }} />
          <div className="text-sm text-ink-700">
            <p className="font-medium">{tr(T.qrTitle, lang)}</p>
            <p className="text-xs text-ink-500">{tr(T.qrHint, lang)}</p>
            {order.packingSlipUrl ? (
              <a href={order.packingSlipUrl} className="mt-1 inline-block font-medium text-kesari-700 underline">
                {tr(T.printSlip, lang)}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      {order.status === "READY" && deliveryAvailable && order.riderSearch && riderPlan ? (
        <p
          className="mt-2 rounded-lg bg-cream-100 px-3 py-2 text-sm text-ink-700"
          data-testid="rider-search-status"
        >
          {order.riderSearch.message}
        </p>
      ) : null}

      <ul className="mt-2 divide-y divide-cream-100 text-sm text-ink-600">
        {order.items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            editable={working && !busy}
            substitutes={substitutes}
            lang={lang}
            onPick={() => fulfil({ action: "pick", itemId: item.id })}
            onRemove={() => fulfil({ action: "remove", itemId: item.id, reason: SHOP_REMOVE_LINE_REASON })}
            onSubstitute={(substituteShopProductId) =>
              fulfil({ action: "substitute", itemId: item.id, substituteShopProductId })
            }
          />
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap gap-2">
        {order.status === "CONFIRMED" ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => fulfil({ action: "accept" })}>
              {tr(T.accept, lang)}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRejecting((v) => !v)}>
              {tr(T.reject, lang)}
            </Button>
          </>
        ) : null}
        {order.status === "ACCEPTED" ? (
          <Button size="sm" disabled={busy} onClick={() => fulfil({ action: "start" })}>
            {tr(T.startPicking, lang)}
          </Button>
        ) : null}
        {order.status === "PREPARING" && !fulfilment?.enabled ? (
          <Button size="sm" disabled={busy || waitingOnCustomer} onClick={() => fulfil({ action: "ready" })}>
            {tr(T.packedReady, lang)}
          </Button>
        ) : null}
        {order.status === "READY" && deliveryAvailable && !riderActive && riderPlan ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={findRider}>
            {order.riderSearch?.state === "STOPPED" ? tr(T.tryAgainRider, lang) : tr(T.findRider, lang)}
          </Button>
        ) : null}
        {order.status === "READY" && deliveryAvailable && !riderActive && riderPlan && order.riderSearch?.state === "SEARCHING" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={stopSearch}>
            {tr(T.stopSearching, lang)}
          </Button>
        ) : null}
        {(MANUAL_STEPS[order.status] ?? [])
          // While a rider holds the order only the rider (with the customer's
          // delivery code) or operations can complete it — the server refuses too.
          .filter(() => !((order.status === "READY" || order.status === "OUT_FOR_DELIVERY") && riderActive))
          // A planned order goes out / is handed over from its plan (with the customer's code).
          .filter(() => !((order.status === "READY" || order.status === "OUT_FOR_DELIVERY") && plan))
          .map((step) => (
            <Button key={step.to} size="sm" variant="secondary" disabled={busy} onClick={() => advance(step.to)}>
              {tr(step.label, lang)}
            </Button>
          ))}
        {order.status === "RETURNED" ? (
          <ConfirmButton disabled={busy} onConfirm={() => advance("CANCELLED")} confirmLabel={tr(T.yesCancel, lang)} question={tr(T.cancelQ, lang)}>
            {tr(T.cancelRefund, lang)}
          </ConfirmButton>
        ) : null}
      </div>

      {fulfilment && plannerShown ? (
        <FulfilmentPlanner
          orderId={order.id}
          status={order.status}
          plan={plan}
          days={fulfilment.days}
          staff={fulfilment.staff}
          hasAddress={order.hasAddress ?? true}
          addressPending={order.addressPending ?? false}
          shopDelivers={deliveryAvailable}
          cashOnDelivery={order.paymentMethod === "COD" && !order.cashCollected}
          pickupRefundPaise={fulfilment.refundDeliveryFeeOnPickup ? (order.deliveryFeePaise ?? 0) : 0}
          waitingOnCustomer={waitingOnCustomer}
          onChanged={onChanged}
        />
      ) : null}

      {order.addressPending && !plannerShown && !["CANCELLED", "REFUND_PENDING", "REFUNDED", "REJECTED"].includes(order.status) ? (
        <p className="mt-2 text-xs font-medium text-kesari-800" data-testid="address-pending-note">
          {tr(T.addressPending, lang)}
        </p>
      ) : null}

      {waitingOnCustomer ? (
        <p className="mt-2 text-xs text-ink-500">{tr(T.waitingSub, lang)}</p>
      ) : null}

      {rejecting ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-sm"
            placeholder={tr(T.reasonPh, lang)}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            aria-label={tr(T.reasonAria, lang)}
          />
          <Button
            size="sm"
            variant="danger"
            disabled={busy || rejectReason.trim().length < 3}
            onClick={() => fulfil({ action: "reject", reason: rejectReason })}
          >
            {tr(T.rejectRefund, lang)}
          </Button>
        </div>
      ) : null}

      {error ? (
        <div className="mt-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}

function ItemRow({
  item,
  editable,
  substitutes,
  lang,
  onPick,
  onRemove,
  onSubstitute,
}: {
  item: ShopOrderItem;
  editable: boolean;
  substitutes: SubstituteOption[];
  lang: Lang;
  onPick: () => void;
  onRemove: () => void;
  onSubstitute: (substituteShopProductId: string) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [choice, setChoice] = useState("");
  const open = item.fulfilmentStatus === "PENDING" || item.fulfilmentStatus === "PICKED";

  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={item.fulfilmentStatus === "REMOVED" ? "line-through" : undefined}>
          {item.productNameSnapshot} · {formatQuantity(item.quantityMilli, item.unitSnapshot)}
          {item.unitPricePaise != null ? (
            <span className="ml-1 text-xs text-ink-500">
              @ <Money paise={item.unitPricePaise} /> / {item.unitSnapshot}
            </span>
          ) : null}
          {ITEM_STATUS_LABEL[item.fulfilmentStatus] ? (
            <span className="ml-2 text-xs text-ink-500">({tr(ITEM_STATUS_LABEL[item.fulfilmentStatus], lang)})</span>
          ) : null}
        </span>
        <Money paise={item.lineTotalPaise} />
      </div>
      {item.substituteNameSnapshot && item.fulfilmentStatus !== "REMOVED" ? (
        <p className="text-xs text-ink-500">
          {tr(T.substitute, lang)} {item.substituteNameSnapshot}
          {item.substituteQuantityMilli && item.substituteUnitSnapshot
            ? ` · ${formatQuantity(item.substituteQuantityMilli, item.substituteUnitSnapshot)}`
            : ""}
          {item.substituteLineTotalPaise != null ? (
            <>
              {" "}
              · <Money paise={item.substituteLineTotalPaise} />
            </>
          ) : null}
        </p>
      ) : null}

      {editable && open ? (
        <div className="mt-1 flex flex-wrap gap-2">
          {item.fulfilmentStatus === "PENDING" ? (
            <Button size="sm" variant="ghost" onClick={onPick}>
              {tr(T.pickedTick, lang)}
            </Button>
          ) : null}
          {substitutes.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setChoosing((v) => !v)}>
              {tr(T.offerSub, lang)}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onRemove}>
            {tr(T.unavailable, lang)}
          </Button>
        </div>
      ) : null}

      {choosing ? (
        <div className="mt-1 flex flex-wrap gap-2">
          <select
            className="min-w-0 flex-1 rounded-lg border border-cream-200 px-2 py-1.5 text-sm"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            aria-label={tr(T.subAria, lang)}
          >
            <option value="">{tr(T.chooseSub, lang)}</option>
            {substitutes.map((s) => (
              <option key={s.shopProductId} value={s.shopProductId}>
                {s.label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={!choice}
            onClick={() => {
              onSubstitute(choice);
              setChoosing(false);
            }}
          >
            {tr(T.sendCustomer, lang)}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
