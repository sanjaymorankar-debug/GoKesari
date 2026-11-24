"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  ClassificationBadge,
  EmptyState,
  Field,
  LinkButton,
  Money,
  inputClass,
} from "@/components/ui";
import { EmptyIllustration } from "@/components/empty-illustrations";
import { SafeImage } from "@/components/safe-image";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";
import { payButtonLabel } from "@/lib/checkout-payment";
import { HOME } from "@/lib/home-i18n";
import { formatQuantity } from "@/lib/money";
import { quantityToMilli, roundStock } from "@/lib/stock-quantity";
import { formatShopTime, isShopOpenNow, nextOpeningAt } from "@/lib/shop-hours";
import type { CartSummary } from "@/server/services/cart";
import type { CartIssue, ShopCartCheck } from "@/server/services/cart-validation";
import { ConfirmButton } from "@/components/confirm-button";

type DeliveryWindowKey = "EXPRESS_30" | "STANDARD_60" | "SCHEDULED";

interface Feasibility {
  EXPRESS_30: boolean;
  STANDARD_60: boolean;
  SCHEDULED: boolean;
  /** F5: windows whose current slot is full (slot capacity on). */
  full?: Partial<Record<DeliveryWindowKey, boolean>>;
}

/** GS-027: a delivery time the customer can choose for a scheduled delivery. */
interface SlotOption {
  key: string;
  date: string;
  start: string;
  end: string;
  label: string;
  remaining: number | null;
}

const WINDOW_LABEL: Record<DeliveryWindowKey, Text> = {
  EXPRESS_30: L("Express (30 min)", "एक्सप्रेस (30 मिनट)", "एक्सप्रेस (30 मिनिटे)"),
  STANDARD_60: L("Standard (60 min)", "सामान्य (60 मिनट)", "साधारण (60 मिनिटे)"),
  SCHEDULED: L("Scheduled", "तय समय पर", "ठरलेल्या वेळी"),
};

/** Module 6 (docs/hindi-marathi-2026-11): the cart and checkout wording. */
const T = {
  changeAddress: L("Change address", "पता बदलें", "पत्ता बदला"),
  removeTheseItems: L("Remove these items", "ये चीज़ें हटाएँ", "या वस्तू काढा"),
  removeUnavailable: L("Remove unavailable items", "न मिलने वाली चीज़ें हटाएँ", "उपलब्ध नसलेल्या वस्तू काढा"),
  addItems: L("Add items", "चीज़ें जोड़ें", "वस्तू जोडा"),
  perUnit: L("per unit", "प्रति यूनिट", "प्रति युनिट"),
  decrease: L("Decrease {name}", "{name} कम करें", "{name} कमी करा"),
  increase: L("Increase {name}", "{name} बढ़ाएँ", "{name} वाढवा"),
  subtotal: L("Subtotal", "उप-योग", "उप-एकूण"),
  delivery: L("Delivery", "डिलीवरी", "डिलिव्हरी"),
  taxes: L("Taxes", "टैक्स", "कर"),
  free: L("Free", "मुफ़्त", "मोफत"),
  deliveryTime: L("Delivery time", "डिलीवरी का समय", "डिलिव्हरीची वेळ"),
  full: L("Full", "भर गया", "भरले"),
  orderSummary: L("Order summary", "ऑर्डर सारांश", "ऑर्डर सारांश"),
  coupon: L("Coupon", "कूपन", "कूपन"),
  grandTotal: L("Grand total", "कुल योग", "एकूण रक्कम"),
  couponCode: L("Coupon code", "कूपन कोड", "कूपन कोड"),
  remove: L("Remove", "हटाएँ", "काढा"),
  apply: L("Apply", "लगाएँ", "लावा"),
  walletBalance: L("Wallet balance", "वॉलेट बैलेंस", "वॉलेट शिल्लक"),
  noAddress: L("No saved delivery address.", "कोई डिलीवरी पता सहेजा नहीं है।", "डिलिव्हरीचा पत्ता जतन केलेला नाही."),
  addOne: L("Add one", "एक जोड़ें", "एक जोडा"),
  beforeCheckout: L("before checking out.", "ऑर्डर करने से पहले।", "ऑर्डर देण्यापूर्वी."),
  deliverTo: L("Deliver to", "डिलीवरी का पता", "डिलिव्हरीचा पत्ता"),
  orderingFor: L("Ordering for", "किसके लिए ऑर्डर", "कोणासाठी ऑर्डर"),
  myself: L("Myself (personal order)", "खुद के लिए (निजी ऑर्डर)", "स्वतःसाठी (वैयक्तिक ऑर्डर)"),
  businessOrder: L("(business order)", "(व्यापार ऑर्डर)", "(व्यवसाय ऑर्डर)"),
  businessSeparate: L(
    "Business orders are kept separate from your personal orders.",
    "व्यापार ऑर्डर आपके निजी ऑर्डर से अलग रखे जाते हैं।",
    "व्यवसाय ऑर्डर तुमच्या वैयक्तिक ऑर्डरपासून वेगळ्या ठेवल्या जातात.",
  ),
  payWith: L("Pay with", "भुगतान का तरीका", "पेमेंटची पद्धत"),
  wallet: L("Wallet", "वॉलेट", "वॉलेट"),
  cod: L("Cash on delivery", "कैश ऑन डिलीवरी", "कॅश ऑन डिलिव्हरी"),
  payOnline: L("Pay online (UPI / card / netbanking)", "ऑनलाइन भुगतान (UPI / कार्ड / नेटबैंकिंग)", "ऑनलाइन पेमेंट (UPI / कार्ड / नेटबँकिंग)"),
  businessWallet: L("Business orders are paid from the wallet.", "व्यापार ऑर्डर का भुगतान वॉलेट से होता है।", "व्यवसाय ऑर्डरचे पेमेंट वॉलेटमधून होते."),
  chooseAddressCod: L(
    "Choose a delivery address for cash on delivery.",
    "कैश ऑन डिलीवरी के लिए डिलीवरी का पता चुनें।",
    "कॅश ऑन डिलिव्हरीसाठी डिलिव्हरीचा पत्ता निवडा.",
  ),
  noteForShop: L("Note for the shop (optional)", "दुकान के लिए संदेश (वैकल्पिक)", "दुकानासाठी सूचना (ऐच्छिक)"),
  notePlaceholder: L(
    "e.g. ring the bell twice, leave at the gate",
    "जैसे: घंटी दो बार बजाएँ, गेट पर छोड़ दें",
    "उदा. बेल दोनदा वाजवा, गेटवर ठेवा",
  ),
  someUnavailable: L(
    "Some items cannot be ordered online and will not be charged.",
    "कुछ चीज़ें ऑनलाइन ऑर्डर नहीं हो सकतीं; उनका पैसा नहीं लिया जाएगा।",
    "काही वस्तू ऑनलाइन ऑर्डर करता येत नाहीत; त्यांचे पैसे घेतले जाणार नाहीत.",
  ),
  insufficient: L("Insufficient wallet balance", "वॉलेट में पर्याप्त बैलेंस नहीं", "वॉलेटमध्ये पुरेशी शिल्लक नाही"),
  addAtLeast: L("Add at least", "कम से कम", "किमान"),
  toPlace: L("to place this order.", "जोड़ें, तभी यह ऑर्डर होगा।", "भरा, तरच ही ऑर्डर होईल."),
  openOrderTitle: L("You already have an open order", "आपका एक ऑर्डर पहले से चालू है", "तुमची एक ऑर्डर आधीच सुरू आहे"),
  yesCancel: L("Yes, cancel it", "हाँ, रद्द करें", "हो, रद्द करा"),
  keepOrder: L("Keep order", "ऑर्डर रखें", "ऑर्डर ठेवा"),
  cancelling: L("Cancelling…", "रद्द हो रहा है…", "रद्द होत आहे…"),
  cancelThis: L("Cancel this order", "यह ऑर्डर रद्द करें", "ही ऑर्डर रद्द करा"),
  beingPrepared: L(
    "Being prepared — contact the shop to cancel it.",
    "तैयार हो रहा है — रद्द करने के लिए दुकान से संपर्क करें।",
    "तयार होत आहे — रद्द करण्यासाठी दुकानाशी संपर्क करा.",
  ),
  onItsWay: L(
    "Already on its way: cancelling refunds the goods, not the delivery fee.",
    "ऑर्डर रास्ते में है: रद्द करने पर सामान का पैसा लौटेगा, डिलीवरी शुल्क नहीं।",
    "ऑर्डर वाटेत आहे: रद्द केल्यास वस्तूंचे पैसे परत मिळतील, डिलिव्हरी शुल्क नाही.",
  ),
  ignoreContinue: L("Ignore and continue", "अनदेखा कर आगे बढ़ें", "दुर्लक्ष करून पुढे जा"),
  goBack: L("Go back", "वापस जाएँ", "मागे जा"),
  opens: L("opens", "खुलेगी", "उघडेल"),
  closedNow: L(
    "might be closed now. Your order may be processed once the shop opens. The shop is alerted immediately and again when it opens. Do you want to continue?",
    "अभी बंद हो सकती है। दुकान खुलने पर आपका ऑर्डर आगे बढ़ेगा। दुकान को अभी और खुलने पर फिर सूचना दी जाएगी। क्या आप आगे बढ़ना चाहते हैं?",
    "सध्या बंद असू शकते. दुकान उघडल्यावर तुमची ऑर्डर पुढे जाईल. दुकानाला आत्ता आणि उघडल्यावर पुन्हा सूचना दिली जाईल. तुम्हाला पुढे जायचे आहे का?",
  ),
  yesContinue: L("Yes, continue", "हाँ, आगे बढ़ें", "हो, पुढे जा"),
  noGoBack: L("No, go back", "नहीं, वापस जाएँ", "नाही, मागे जा"),
  addMobileFirst: L(
    "Add your mobile number before ordering — the delivery partner needs it to reach you.",
    "ऑर्डर से पहले अपना मोबाइल नंबर जोड़ें — डिलीवरी पार्टनर को आपसे संपर्क करना होता है।",
    "ऑर्डर देण्यापूर्वी तुमचा मोबाइल नंबर जोडा — डिलिव्हरी पार्टनरला तुमच्याशी संपर्क करावा लागतो.",
  ),
  addMobile: L("Add mobile number", "मोबाइल नंबर जोड़ें", "मोबाइल नंबर जोडा"),
  addAddressFirst: L("Add a delivery address before ordering.", "ऑर्डर से पहले डिलीवरी का पता जोड़ें।", "ऑर्डर देण्यापूर्वी डिलिव्हरीचा पत्ता जोडा."),
  addAddress: L("Add address", "पता जोड़ें", "पत्ता जोडा"),
  chooseTimeTitle: L(
    "Choose a delivery time for your scheduled delivery",
    "तय डिलीवरी के लिए समय चुनें",
    "ठरलेल्या डिलिव्हरीसाठी वेळ निवडा",
  ),
  addMoneyWallet: L("Add money to wallet", "वॉलेट में पैसे जोड़ें", "वॉलेटमध्ये पैसे भरा"),
  continueShopping: L("Continue shopping", "खरीदारी जारी रखें", "खरेदी सुरू ठेवा"),
  noSlots: L(
    "No delivery times are left in the coming days — choose another delivery option.",
    "आने वाले दिनों में डिलीवरी का कोई समय खाली नहीं है — दूसरा डिलीवरी विकल्प चुनें।",
    "पुढील दिवसांत डिलिव्हरीची वेळ उपलब्ध नाही — दुसरा डिलिव्हरी पर्याय निवडा.",
  ),
  chooseDay: L("Choose a day", "दिन चुनें", "दिवस निवडा"),
  chooseTime: L("Choose a time", "समय चुनें", "वेळ निवडा"),
  left: L("left", "बाकी", "शिल्लक"),
  pickTime: L("Pick a delivery time to place the order.", "ऑर्डर के लिए डिलीवरी का समय चुनें।", "ऑर्डरसाठी डिलिव्हरीची वेळ निवडा."),
  orderCancelled: L(
    "Order {n} cancelled. Any refund goes to your wallet.",
    "ऑर्डर {n} रद्द हो गया। रिफंड आपके वॉलेट में जाएगा।",
    "ऑर्डर {n} रद्द झाली. परतावा तुमच्या वॉलेटमध्ये जाईल.",
  ),
  placing: L("Placing order…", "ऑर्डर हो रहा है…", "ऑर्डर देत आहे…"),
} as const;

/** The pay button's words (lib/checkout-payment.ts) in each language. */
const PAY_LABEL: Record<"WALLET" | "COD" | "ONLINE", Text> = {
  WALLET: L("Pay from wallet", "वॉलेट से भुगतान करें", "वॉलेटमधून पैसे द्या"),
  COD: L("Place order — pay cash on delivery", "ऑर्डर करें — डिलीवरी पर नकद दें", "ऑर्डर द्या — डिलिव्हरीवेळी रोख द्या"),
  ONLINE: L("Pay online", "ऑनलाइन भुगतान करें", "ऑनलाइन पेमेंट करा"),
};

/** C3: an open order shown before paying for a new one (rule openOrderCheck). */
export interface OpenOrderNotice {
  id: string;
  orderNumber: string;
  shopName: string;
  orderType: "PERSONAL" | "B2B";
  status: string;
  statusLabel: string;
  totalPaise: number;
  customerMayCancel: boolean;
}

export interface CheckoutAddress {
  id: string;
  label: string | null;
  line1: string;
  area: string | null;
  city: string;
  pincode: string;
  isDefault: boolean;
}

/**
 * Cart and checkout (§17, §22, §23).
 *
 * The checkout request id is generated once per mount, so a double-click or a
 * retry after a network blip reuses the same id and cannot place two orders.
 */
export function CartView({
  cart,
  walletBalancePaise,
  addresses,
  buyerShops = [],
  initialChecks = [],
  preferredAddressId = null,
  codUnavailableReason = null,
  hasMobile = true,
  couponsEnabled = false,
  openOrders = [],
  onlinePaymentsEnabled = false,
  lang = "en",
}: {
  cart: CartSummary;
  walletBalancePaise: number;
  addresses: CheckoutAddress[];
  /** Approved shops the user may buy for (B2B). Empty = personal orders only. */
  buyerShops?: { id: string; name: string }[];
  /** Per-shop validation of the cart against the chosen delivery location. */
  initialChecks?: ShopCartCheck[];
  /** The saved address the customer picked as their location, if any. */
  preferredAddressId?: string | null;
  /** GS-030: null when cash on delivery is available for this cart; otherwise why not. */
  codUnavailableReason?: string | null;
  /** Orders need a mobile number on the account so the delivery partner can call. */
  hasMobile?: boolean;
  /** F7: show the coupon box (rule "coupons"). */
  couponsEnabled?: boolean;
  /** C3: the customer's open orders; empty when rule openOrderCheck is off. */
  openOrders?: OpenOrderNotice[];
  /** batch-2026-10 WS-A: offer "Pay online" (rule onlinePayments). */
  onlinePaymentsEnabled?: boolean;
  /** docs/homepage-uiux-2026-10: the empty cart's wording. */
  lang?: Lang;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const [addressId, setAddressId] = useState<string | null>(
    preferredAddressId ?? addresses.find((a) => a.isDefault)?.id ?? addresses[0]?.id ?? null,
  );
  // "" = a personal order; otherwise the id of the shop buying for its business.
  const [buyerShopId, setBuyerShopId] = useState("");
  const [feasibility, setFeasibility] = useState<Record<string, Feasibility>>({});
  const [deliveryWindows, setDeliveryWindows] = useState<Record<string, DeliveryWindowKey>>({});
  // GS-027: delivery times offered per shop (null until loaded / when the feature is off) and the one chosen.
  const [slotOptions, setSlotOptions] = useState<Record<string, SlotOption[] | null>>({});
  const [scheduledSlots, setScheduledSlots] = useState<Record<string, string>>({});
  const [slotDay, setSlotDay] = useState<Record<string, string>>({});
  const [paymentMethod, setPaymentMethod] = useState<"WALLET" | "COD" | "ONLINE">("WALLET");
  // F7: an applied coupon is a server-priced preview; checkout re-validates it.
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<{ code: string; discountPaise: number; forTotal: number } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  // TC-CART-017: an optional note for the shop (gate code, "ring twice"); the checkout API takes up to 500 characters.
  const [notes, setNotes] = useState("");

  const [checks, setChecks] = useState<ShopCartCheck[]>(initialChecks);
  // Adopt fresh server data when the prop changes (render-time sync, not an effect).
  const [prevInitialChecks, setPrevInitialChecks] = useState(initialChecks);
  if (prevInitialChecks !== initialChecks) {
    setPrevInitialChecks(initialChecks);
    setChecks(initialChecks);
  }
  // Changing the delivery address re-validates the whole cart against it.
  useEffect(() => {
    if (!addressId) return;
    let cancelled = false;
    fetch(`/api/cart/validate?addressId=${addressId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { shops: ShopCartCheck[] } | null) => {
        if (!cancelled && data) setChecks(data.shops);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [addressId, cart]);
  const checkFor = (shopId: string) => checks.find((c) => c.shopId === shopId);
  // Shops that look closed right now: the customer must confirm before ordering from them.
  const closedGroups = cart.groups.filter(
    (g) => g.lines.some((l) => l.purchasable) && !isShopOpenNow(g.shop),
  );
  const [confirmingClosed, setConfirmingClosed] = useState(false);
  // C3: an existing open order must be acknowledged (or cancelled) before paying.
  const relevantOpenOrders = openOrders.filter((o) => o.orderType === (buyerShopId ? "B2B" : "PERSONAL"));
  const [confirmingOpenOrders, setConfirmingOpenOrders] = useState(false);
  const [openOrdersAcknowledged, setOpenOrdersAcknowledged] = useState(false);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [openOrderMessage, setOpenOrderMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const hasBlockingIssue = checks.some((c) => c.issues.some((i) => i.blocking));
  // Checkout enforces both server-side; shown here so the customer can fix them first.
  const needsAddress = !buyerShopId && !addressId && cart.groups.some((g) => g.shop.deliveryAvailable);
  const missingDetails = !hasMobile || needsAddress;

  async function removeShop(shopId: string) {
    setBusy(true);
    await fetch(`/api/cart/validate?shopId=${shopId}`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  function runAction(issue: CartIssue, group: CartSummary["groups"][number]) {
    if (issue.action === "CHANGE_ADDRESS") {
      document.getElementById("deliver-to")?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (issue.action === "REMOVE_SHOP_ITEMS") {
      void removeShop(group.shop.id);
    } else if (issue.action === "REMOVE_UNAVAILABLE_ITEMS") {
      group.lines.filter((l) => !l.purchasable).forEach((l) => void updateQuantity(l.cartItemId, 0));
    } else if (issue.action === "ADD_ITEMS") {
      router.push(`/shops/${group.shop.slug}`);
    }
  }

  const shopIds = cart.groups.map((g) => g.shop.id).join(",");
  useEffect(() => {
    let cancelled = false;
    for (const shopId of shopIds ? shopIds.split(",") : []) {
      fetch(`/api/checkout/delivery-windows?shopId=${shopId}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: Feasibility | null) => {
          if (cancelled || !data) return;
          setFeasibility((prev) => ({ ...prev, [shopId]: data }));
          setDeliveryWindows((prev) => {
            if (prev[shopId]) return prev;
            if (data.EXPRESS_30) return { ...prev, [shopId]: "EXPRESS_30" };
            if (data.STANDARD_60) return { ...prev, [shopId]: "STANDARD_60" };
            if (data.SCHEDULED) return { ...prev, [shopId]: "SCHEDULED" };
            return prev;
          });
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [shopIds]);

  // GS-027: load the delivery times of a shop the first time "Scheduled" is picked for it.
  const scheduledShops = Object.entries(deliveryWindows)
    .filter(([, w]) => w === "SCHEDULED")
    .map(([id]) => id)
    .join(",");
  useEffect(() => {
    let cancelled = false;
    for (const shopId of scheduledShops ? scheduledShops.split(",") : []) {
      fetch(`/api/checkout/scheduled-slots?shopId=${shopId}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { enabled: boolean; slots: SlotOption[] } | null) => {
          if (cancelled || !data) return;
          setSlotOptions((prev) => ({ ...prev, [shopId]: data.enabled ? data.slots : null }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [scheduledShops]);
  // A shop on "Scheduled" with delivery times on must have one chosen before paying.
  const missingSlot = Object.entries(deliveryWindows).some(
    ([shopId, w]) => w === "SCHEDULED" && Array.isArray(slotOptions[shopId]) && !scheduledSlots[shopId],
  );

  // Cash on delivery: personal orders to a saved address only.
  const codPossible = codUnavailableReason == null && !buyerShopId && addressId != null;
  const payingCod = paymentMethod === "COD" && codPossible;
  // batch-2026-10 WS-A: personal orders only, like cash on delivery.
  const payingOnline = paymentMethod === "ONLINE" && onlinePaymentsEnabled && !buyerShopId;
  // A coupon priced for a different cart is dropped (the customer re-applies it).
  const couponDiscountPaise = coupon && coupon.forTotal === cart.subtotalPaise ? coupon.discountPaise : 0;
  const payablePaise = cart.grandTotalPaise - couponDiscountPaise;
  const affordable = payingCod || payingOnline || walletBalancePaise >= payablePaise;
  const shortfall = Math.max(0, payablePaise - walletBalancePaise);

  async function updateQuantity(cartItemId: string, quantity: number) {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/cart/items/${cartItemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(errorText(payload?.error?.message ?? "Could not update the cart.", lang, payload?.error?.code));
    }
    setBusy(false);
    router.refresh();
  }

  async function applyCoupon() {
    setCouponError(null);
    const response = await fetch("/api/checkout/coupon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: couponInput, requestId }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setCoupon(null);
      setCouponError(errorText(payload?.error?.message ?? "That coupon can't be used.", lang, payload?.error?.code));
      return;
    }
    setCoupon({ code: payload.code, discountPaise: payload.discountPaise, forTotal: cart.subtotalPaise });
  }

  /** Next step of "Pay": the closed-shop confirmation, or the order itself. */
  function proceedToPay() {
    if (closedGroups.length > 0) setConfirmingClosed(true);
    else void checkout();
  }

  function startPay() {
    if (relevantOpenOrders.length > 0 && !openOrdersAcknowledged) {
      setOpenOrderMessage(null);
      setConfirmingOpenOrders(true);
      return;
    }
    proceedToPay();
  }

  async function cancelOpenOrder(order: OpenOrderNotice) {
    setCancellingOrderId(order.id);
    setOpenOrderMessage(null);
    const response = await fetch(`/api/orders/${order.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "CANCELLED", note: "Cancelled by the customer before placing a new order" }),
    });
    const payload = await response.json().catch(() => null);
    setCancellingOrderId(null);
    if (!response.ok) {
      setOpenOrderMessage({ tone: "danger", text: errorText(payload?.error?.message ?? "Could not cancel that order.", lang, payload?.error?.code) });
      return;
    }
    setOpenOrderMessage({ tone: "success", text: tr(T.orderCancelled, lang).replace("{n}", order.orderNumber) });
    router.refresh();
  }

  async function checkout(acknowledgeClosedShopIds: string[] = []) {
    setConfirmingClosed(false);
    setBusy(true);
    setError(null);
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        addressId,
        deliveryWindows,
        // GS-027: only for shops still on "Scheduled".
        scheduledSlots: Object.fromEntries(
          Object.entries(scheduledSlots).filter(([shopId]) => deliveryWindows[shopId] === "SCHEDULED"),
        ),
        paymentMethod: payingCod ? "COD" : payingOnline ? "ONLINE" : "WALLET",
        acknowledgeClosedShopIds,
        ...(couponDiscountPaise > 0 && coupon ? { couponCode: coupon.code } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(buyerShopId ? { orderType: "B2B", buyerShopId } : { orderType: "PERSONAL" }),
      }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      // docs/identity-verification-2026-11: the one-time identity check first, then back to the cart.
      const verifyUrl = payload?.error?.details?.needsIdentityVerification ? payload.error.details.verifyUrl : null;
      if (typeof verifyUrl === "string" && verifyUrl.startsWith("/")) {
        router.push(verifyUrl);
        return;
      }
      setError(errorText(payload?.error?.message ?? "Checkout failed. Please try again.", lang, payload?.error?.code));
      return;
    }
    // batch-2026-10 WS-A: an online payment continues on the gateway's page (kept in-app by the mobile WebView).
    if (payload?.payment?.redirectUrl) {
      window.location.assign(payload.payment.redirectUrl);
      return;
    }
    if (payload?.payment?.intentId) {
      router.push(`/orders/payment-return?intent=${payload.payment.intentId}`);
      return;
    }
    // F6: a multi-shop order with one parent reference opens that reference.
    router.push(
      payload?.parentReference
        ? `/orders/group/${encodeURIComponent(payload.parentReference)}?placed=1`
        : "/orders?placed=1",
    );
    router.refresh();
  }

  if (cart.groups.length === 0) {
    return (
      <EmptyState
        illustration={<EmptyIllustration name="basket" />}
        title={tr(HOME.cartEmptyTitle, lang)}
        description={tr(HOME.cartEmptyText, lang)}
        action={
          <LinkButton href="/" className="h-12 px-5 text-base font-bold">
            {tr(HOME.startShopping, lang)}
          </LinkButton>
        }
        secondaryAction={
          <LinkButton href="/#popular" variant="secondary" className="h-12 px-5 text-base">
            {tr(HOME.exploreBestsellers, lang)}
          </LinkButton>
        }
        testId="cart-empty"
      />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        {cart.groups.map((group) => (
          <Card key={group.shop.id} className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cream-200 bg-cream-50 px-4 py-3">
              <div className="flex items-center gap-2">
                <Link prefetch={false}
                  href={`/shops/${group.shop.slug}`}
                  className="font-medium text-ink-900 hover:underline"
                >
                  {group.shop.name}
                </Link>
                <ClassificationBadge value={group.shop.classification} />
              </div>
              <span className="text-sm text-ink-500">
                <Money paise={group.totalPaise} />
              </span>
            </div>

            {checkFor(group.shop.id)?.issues.length ? (
              <div className="space-y-2 px-4 pt-3" data-testid="delivery-warning">
                {checkFor(group.shop.id)!.issues.map((issue) => (
                  <Alert key={issue.code} tone={issue.blocking ? "warning" : "info"}>
                    <span>{errorText(issue.message, lang)}</span>
                    {issue.action !== "NONE" ? (
                      <button
                        type="button"
                        className="ml-2 underline"
                        disabled={busy}
                        onClick={() => runAction(issue, group)}
                      >
                        {issue.action === "CHANGE_ADDRESS"
                          ? tr(T.changeAddress, lang)
                          : issue.action === "REMOVE_SHOP_ITEMS"
                            ? tr(T.removeTheseItems, lang)
                            : issue.action === "REMOVE_UNAVAILABLE_ITEMS"
                              ? tr(T.removeUnavailable, lang)
                              : tr(T.addItems, lang)}
                      </button>
                    ) : null}
                  </Alert>
                ))}
              </div>
            ) : null}

            <ul className="divide-y divide-cream-200">
              {group.lines.map((line) => (
                <li key={line.cartItemId} className="flex gap-3 p-4">
                  <SafeImage
                    src={line.imageUrl}
                    alt={line.productName}
                    className="h-14 w-14 shrink-0 rounded-lg bg-cream-100 object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink-900">
                      {line.productName}
                    </p>
                    <p className="text-xs text-ink-500">
                      {line.categoryName} ·{" "}
                      {formatQuantity(line.unitSizeMilli, line.unit)} {tr(T.perUnit, lang)}
                    </p>

                    {line.purchasable ? (
                      <p className="mt-1 text-sm text-ink-600">
                        {line.listUnitPricePaise ? (
                          <span className="mr-1 text-ink-500 line-through">
                            <Money paise={line.listUnitPricePaise} />
                          </span>
                        ) : null}
                        <Money paise={line.unitPricePaise} /> × {lineQuantity(line)}
                        {line.offerTitle ? (
                          <span className="ml-2" data-testid="cart-offer">
                            <Badge tone="success">{line.offerTitle}</Badge>
                          </span>
                        ) : null}
                      </p>
                    ) : (
                      <p className="mt-1">
                        <Badge tone="danger">{errorText(line.unavailableReason, lang)}</Badge>
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col items-end justify-between gap-2">
                    <span className="font-medium text-ink-900">
                      {line.purchasable ? (
                        <Money paise={line.lineTotalPaise} />
                      ) : (
                        <span className="text-sm text-ink-500">—</span>
                      )}
                    </span>

                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        aria-label={tr(T.decrease, lang).replace("{name}", line.productName)}
                        onClick={() =>
                          updateQuantity(line.cartItemId, Math.max(0, roundStock(line.quantity - line.quantityStep)))
                        }
                      >
                        −
                      </Button>
                      <span className={`${line.kind === "LOOSE" ? "min-w-8 px-1" : "w-8"} text-center text-sm tabular-nums`}>
                        {lineQuantity(line)}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        aria-label={tr(T.increase, lang).replace("{name}", line.productName)}
                        onClick={() =>
                          updateQuantity(line.cartItemId, roundStock(line.quantity + line.quantityStep))
                        }
                      >
                        +
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <div className="space-y-1 border-t border-cream-200 px-4 py-3 text-sm">
              <Row label={tr(T.subtotal, lang)} paise={group.subtotalPaise} free={tr(T.free, lang)} />
              <Row label={tr(T.delivery, lang)} paise={group.deliveryFeePaise} free={tr(T.free, lang)} />
              {group.taxPaise > 0 ? (
                <Row label={tr(T.taxes, lang)} paise={group.taxPaise} free={tr(T.free, lang)} />
              ) : null}
            </div>

            {feasibility[group.shop.id] ? (
              <div className="border-t border-cream-200 px-4 py-3">
                <p className="mb-2 text-xs font-medium text-ink-500">{tr(T.deliveryTime, lang)}</p>
                <div className="flex flex-wrap gap-2">
                  {(["EXPRESS_30", "STANDARD_60", "SCHEDULED"] as const)
                    .filter((key) => feasibility[group.shop.id][key] || feasibility[group.shop.id].full?.[key])
                    .map((key) =>
                      feasibility[group.shop.id].full?.[key] ? (
                        <span
                          key={key}
                          aria-disabled="true"
                          data-testid={`slot-full-${key}`}
                          className="cursor-not-allowed rounded-full border border-cream-200 px-3 py-1.5 text-xs font-medium text-ink-500 line-through"
                        >
                          {tr(WINDOW_LABEL[key], lang)} · {tr(T.full, lang)}
                        </span>
                      ) : (
                      <button
                        key={key}
                        type="button"
                        onClick={() =>
                          setDeliveryWindows((prev) => ({ ...prev, [group.shop.id]: key }))
                        }
                        className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                          deliveryWindows[group.shop.id] === key
                            ? "border-kesari-500 bg-kesari-50 text-kesari-700"
                            : "border-cream-200 text-ink-600 hover:border-kesari-300"
                        }`}
                      >
                        {tr(WINDOW_LABEL[key], lang)}
                      </button>
                      ),
                    )}
                </div>
                {deliveryWindows[group.shop.id] === "SCHEDULED" && Array.isArray(slotOptions[group.shop.id]) ? (
                  <SlotPicker
                    slots={slotOptions[group.shop.id]!}
                    day={slotDay[group.shop.id]}
                    chosen={scheduledSlots[group.shop.id]}
                    onDay={(d) => setSlotDay((prev) => ({ ...prev, [group.shop.id]: d }))}
                    onChoose={(key) => setScheduledSlots((prev) => ({ ...prev, [group.shop.id]: key }))}
                    lang={lang}
                  />
                ) : null}
              </div>
            ) : null}
          </Card>
        ))}
      </div>

      <div className="lg:sticky lg:top-24 lg:self-start">
        <Card className="p-4">
          <h2 className="text-base font-semibold text-ink-900">{tr(T.orderSummary, lang)}</h2>

          <div className="mt-3 space-y-1 text-sm">
            <Row label={tr(T.subtotal, lang)} paise={cart.subtotalPaise} free={tr(T.free, lang)} />
            <Row label={tr(T.delivery, lang)} paise={cart.deliveryFeePaise} free={tr(T.free, lang)} />
            {cart.taxPaise > 0 ? <Row label={tr(T.taxes, lang)} paise={cart.taxPaise} free={tr(T.free, lang)} /> : null}
            {couponDiscountPaise > 0 && coupon ? (
              <div className="flex justify-between text-leaf-700" data-testid="coupon-discount">
                <span>{tr(T.coupon, lang)} {coupon.code}</span>
                <span>
                  −<Money paise={couponDiscountPaise} />
                </span>
              </div>
            ) : null}
            <div className="mt-2 flex justify-between border-t border-cream-200 pt-2 text-base font-semibold text-ink-900">
              <span>{tr(T.grandTotal, lang)}</span>
              <Money paise={payablePaise} />
            </div>
          </div>

          {couponsEnabled ? (
            <div className="mt-3 space-y-1">
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  placeholder={tr(T.couponCode, lang)}
                  value={couponInput}
                  onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                  data-testid="coupon-input"
                />
                {couponDiscountPaise > 0 ? (
                  <Button variant="secondary" onClick={() => { setCoupon(null); setCouponInput(""); }}>
                    {tr(T.remove, lang)}
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => void applyCoupon()} disabled={!couponInput.trim()}>
                    {tr(T.apply, lang)}
                  </Button>
                )}
              </div>
              {couponError ? <p className="text-xs text-red-700">{couponError}</p> : null}
            </div>
          ) : null}

          <div className="mt-4 rounded-lg bg-cream-50 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-ink-600">{tr(T.walletBalance, lang)}</span>
              <Money paise={walletBalancePaise} className="font-medium" />
            </div>
          </div>

          <div className="mt-4">
            {addresses.length === 0 ? (
              <Alert tone="info">
                {tr(T.noAddress, lang)}{" "}
                <a href="/profile/addresses" className="underline">
                  {tr(T.addOne, lang)}
                </a>{" "}
                {tr(T.beforeCheckout, lang)}
              </Alert>
            ) : (
              <Field label={tr(T.deliverTo, lang)}>
                <select
                  id="deliver-to"
                  className={inputClass}
                  value={addressId ?? ""}
                  onChange={(e) => setAddressId(e.target.value || null)}
                >
                  {addresses.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label ? `${a.label} — ` : ""}
                      {a.line1}, {[a.area, a.city].filter(Boolean).join(", ")} — {a.pincode}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>

          {buyerShops.length > 0 ? (
            <div className="mt-3">
              <Field label={tr(T.orderingFor, lang)}>
                <select
                  className={inputClass}
                  value={buyerShopId}
                  onChange={(e) => setBuyerShopId(e.target.value)}
                  data-testid="order-for"
                >
                  <option value="">{tr(T.myself, lang)}</option>
                  {buyerShops.map((shop) => (
                    <option key={shop.id} value={shop.id}>
                      {shop.name} {tr(T.businessOrder, lang)}
                    </option>
                  ))}
                </select>
              </Field>
              {buyerShopId ? (
                <p className="mt-1 text-xs text-ink-500">
                  {tr(T.businessSeparate, lang)}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* A fieldset, not a <label>: each radio is named by its own text, not by all three. */}
          <fieldset className="mt-3" data-testid="payment-method">
            <legend className="mb-1 block text-sm font-medium text-ink-700">{tr(T.payWith, lang)}</legend>
            <div className="space-y-1 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="payment-method"
                  checked={!payingCod && !payingOnline}
                  onChange={() => setPaymentMethod("WALLET")}
                />
                {tr(T.wallet, lang)}
              </label>
              <label className={`flex items-center gap-2 ${codPossible ? "" : "text-ink-500"}`}>
                <input
                  type="radio"
                  name="payment-method"
                  disabled={!codPossible}
                  checked={payingCod}
                  onChange={() => setPaymentMethod("COD")}
                />
                {tr(T.cod, lang)}
              </label>
              {onlinePaymentsEnabled && !buyerShopId ? (
                <label className="flex items-center gap-2" data-testid="pay-online-option">
                  <input
                    type="radio"
                    name="payment-method"
                    checked={payingOnline}
                    onChange={() => setPaymentMethod("ONLINE")}
                  />
                  {tr(T.payOnline, lang)}
                </label>
              ) : null}
              {!codPossible ? (
                <p className="text-xs text-ink-500">
                  {codUnavailableReason != null
                    ? errorText(codUnavailableReason, lang)
                    : buyerShopId
                      ? tr(T.businessWallet, lang)
                      : tr(T.chooseAddressCod, lang)}
                </p>
              ) : null}
            </div>
          </fieldset>

          <div className="mt-3">
            <Field label={tr(T.noteForShop, lang)}>
              <textarea
                className={inputClass}
                rows={2}
                maxLength={500}
                placeholder={tr(T.notePlaceholder, lang)}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                data-testid="order-notes"
              />
            </Field>
          </div>

          {cart.hasUnavailableItems ? (
            <div className="mt-3">
              <Alert tone="warning">
                {tr(T.someUnavailable, lang)}
              </Alert>
            </div>
          ) : null}

          {!affordable ? (
            <div className="mt-3">
              <Alert tone="danger" title={tr(T.insufficient, lang)}>
                {tr(T.addAtLeast, lang)} <Money paise={shortfall} /> {tr(T.toPlace, lang)}
              </Alert>
            </div>
          ) : null}

          {error ? (
            <div className="mt-3">
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}

          <div className="mt-4 space-y-2">
            {openOrderMessage && !(confirmingOpenOrders && relevantOpenOrders.length > 0) ? (
              <Alert tone={openOrderMessage.tone}>{openOrderMessage.text}</Alert>
            ) : null}
            {affordable && confirmingOpenOrders && relevantOpenOrders.length > 0 ? (
              <div className="space-y-2" data-testid="open-order-confirm">
                <Alert tone="warning" title={tr(T.openOrderTitle, lang)}>
                  <ul className="mt-1 space-y-2">
                    {relevantOpenOrders.map((o) => (
                      <li key={o.id} className="flex flex-wrap items-center justify-between gap-2" data-testid="open-order">
                        <span>
                          <Link prefetch={false} href="/orders" className="font-medium underline">
                            {o.orderNumber}
                          </Link>{" "}
                          · {o.shopName} — <strong>{o.statusLabel}</strong> · <Money paise={o.totalPaise} />
                        </span>
                        {o.customerMayCancel ? (
                          <ConfirmButton
                            disabled={busy || cancellingOrderId !== null}
                            onConfirm={() => cancelOpenOrder(o)}
                            confirmLabel={tr(T.yesCancel, lang)}
                            keepLabel={tr(T.keepOrder, lang)}
                          >
                            {cancellingOrderId === o.id ? tr(T.cancelling, lang) : tr(T.cancelThis, lang)}
                          </ConfirmButton>
                        ) : (
                          <span className="text-xs">{tr(T.beingPrepared, lang)}</span>
                        )}
                        {o.customerMayCancel && (o.status === "PICKED_UP" || o.status === "OUT_FOR_DELIVERY") ? (
                          <span className="w-full text-xs">
                            {tr(T.onItsWay, lang)}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Alert>
                {openOrderMessage ? <Alert tone={openOrderMessage.tone}>{openOrderMessage.text}</Alert> : null}
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={busy || cancellingOrderId !== null}
                    onClick={() => {
                      setOpenOrdersAcknowledged(true);
                      setConfirmingOpenOrders(false);
                      proceedToPay();
                    }}
                  >
                    {tr(T.ignoreContinue, lang)}
                  </Button>
                  <Button
                    className="flex-1"
                    variant="secondary"
                    disabled={busy || cancellingOrderId !== null}
                    onClick={() => setConfirmingOpenOrders(false)}
                  >
                    {tr(T.goBack, lang)}
                  </Button>
                </div>
              </div>
            ) : affordable && confirmingClosed ? (
              <div className="space-y-2" data-testid="shop-closed-confirm">
                <Alert tone="warning">
                  <span>
                    {closedGroups
                      .map((g) => {
                        const opens = nextOpeningAt(g.shop);
                        return `${g.shop.name}${opens ? ` (${tr(T.opens, lang)} ${formatShopTime(opens)})` : ""}`;
                      })
                      .join(", ")}{" "}
                    {tr(T.closedNow, lang)}
                  </span>
                </Alert>
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={busy}
                    onClick={() => checkout(closedGroups.map((g) => g.shop.id))}
                  >
                    {tr(T.yesContinue, lang)}
                  </Button>
                  <Button className="flex-1" variant="secondary" disabled={busy} onClick={() => setConfirmingClosed(false)}>
                    {tr(T.noGoBack, lang)}
                  </Button>
                </div>
              </div>
            ) : missingDetails ? (
              <div className="grid gap-2" data-testid="checkout-missing-details">
                {!hasMobile ? (
                  <Alert tone="warning">
                    {tr(T.addMobileFirst, lang)}{" "}
                    <a href="/profile" className="font-medium underline">
                      {tr(T.addMobile, lang)}
                    </a>
                  </Alert>
                ) : null}
                {needsAddress ? (
                  <Alert tone="warning">
                    {tr(T.addAddressFirst, lang)}{" "}
                    <a href="/profile/addresses" className="font-medium underline">
                      {tr(T.addAddress, lang)}
                    </a>
                  </Alert>
                ) : null}
              </div>
            ) : affordable ? (
              <Button
                className="w-full"
                size="lg"
                disabled={busy || cart.grandTotalPaise === 0 || hasBlockingIssue || missingSlot}
                title={missingSlot ? tr(T.chooseTimeTitle, lang) : undefined}
                onClick={startPay}
              >
                {lang === "en"
                  ? payButtonLabel(payingCod ? "COD" : payingOnline ? "ONLINE" : "WALLET", busy)
                  : busy
                    ? tr(T.placing, lang)
                    : tr(PAY_LABEL[payingCod ? "COD" : payingOnline ? "ONLINE" : "WALLET"], lang)}
              </Button>
            ) : (
              <LinkButton href="/wallet" className="w-full justify-center">
                {tr(T.addMoneyWallet, lang)}
              </LinkButton>
            )}
            <LinkButton
              href="/"
              variant="secondary"
              className="w-full justify-center"
            >
              {tr(T.continueShopping, lang)}
            </LinkButton>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, paise, free = "Free" }: { label: string; paise: number; free?: string }) {
  return (
    <div className="flex justify-between text-ink-600">
      <span>{label}</span>
      {paise === 0 ? <span>{free}</span> : <Money paise={paise} />}
    </div>
  );
}

/**
 * GS-027: choose a day, then a delivery time on that day. Only times with a
 * place left are listed (the server re-checks when the order is placed).
 */
function SlotPicker({
  slots,
  day,
  chosen,
  onDay,
  onChoose,
  lang = "en",
}: {
  slots: SlotOption[];
  day: string | undefined;
  chosen: string | undefined;
  onDay: (day: string) => void;
  onChoose: (key: string) => void;
  lang?: Lang;
}) {
  if (slots.length === 0) {
    return (
      <p className="mt-2 text-xs text-ink-500" data-testid="no-slots">
        {tr(T.noSlots, lang)}
      </p>
    );
  }
  const days = [...new Set(slots.map((s) => s.date))];
  const activeDay = day && days.includes(day) ? day : (slots.find((s) => s.key === chosen)?.date ?? days[0]);
  const chip = (on: boolean) =>
    `rounded-full border px-3 py-1.5 text-xs font-medium ${
      on ? "border-kesari-500 bg-kesari-50 text-kesari-700" : "border-cream-200 text-ink-600 hover:border-kesari-300"
    }`;
  return (
    <div className="mt-3 space-y-2" data-testid="slot-picker">
      <p className="text-xs font-medium text-ink-500">{tr(T.chooseDay, lang)}</p>
      <div className="flex flex-wrap gap-2">
        {days.map((d) => (
          <button key={d} type="button" className={chip(d === activeDay)} onClick={() => onDay(d)}>
            {slots.find((s) => s.date === d)!.label.split(", ")[0]}
          </button>
        ))}
      </div>
      <p className="text-xs font-medium text-ink-500">{tr(T.chooseTime, lang)}</p>
      <div className="flex flex-wrap gap-2">
        {slots
          .filter((s) => s.date === activeDay)
          .map((s) => (
            <button
              key={s.key}
              type="button"
              data-testid={`slot-${s.key}`}
              className={chip(s.key === chosen)}
              onClick={() => onChoose(s.key)}
            >
              {s.label.split(", ")[1]}
              {s.remaining != null && s.remaining <= 3 ? ` · ${s.remaining} ${tr(T.left, lang)}` : ""}
            </button>
          ))}
      </div>
      {!chosen ? <p className="text-xs text-amber-700">{tr(T.pickTime, lang)}</p> : null}
    </div>
  );
}

/** A cart line's quantity as the customer reads it: "2", or "250 g" / "1.5 kg" of a loose good (D-95). */
function lineQuantity(line: CartSummary["groups"][number]["lines"][number]): string | number {
  return line.kind === "LOOSE" ? formatQuantity(quantityToMilli(line.quantity, line.unitSizeMilli), line.unit) : line.quantity;
}
