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
import { SafeImage } from "@/components/safe-image";
import { formatQuantity } from "@/lib/money";
import { formatShopTime, isShopOpenNow, nextOpeningAt } from "@/lib/shop-hours";
import type { CartSummary } from "@/server/services/cart";
import type { CartIssue, ShopCartCheck } from "@/server/services/cart-validation";

type DeliveryWindowKey = "EXPRESS_30" | "STANDARD_60" | "SCHEDULED";

interface Feasibility {
  EXPRESS_30: boolean;
  STANDARD_60: boolean;
  SCHEDULED: boolean;
  estimatedMinutes: number | null;
  /** F5: windows whose current slot is full (slot capacity on). */
  full?: Partial<Record<DeliveryWindowKey, boolean>>;
}

const WINDOW_LABEL: Record<DeliveryWindowKey, string> = {
  EXPRESS_30: "Express (30 min)",
  STANDARD_60: "Standard (60 min)",
  SCHEDULED: "Scheduled",
};

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
  const [paymentMethod, setPaymentMethod] = useState<"WALLET" | "COD">("WALLET");
  // F7: an applied coupon is a server-priced preview; checkout re-validates it.
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<{ code: string; discountPaise: number; forTotal: number } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);

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

  // Cash on delivery: personal orders to a saved address only.
  const codPossible = codUnavailableReason == null && !buyerShopId && addressId != null;
  const payingCod = paymentMethod === "COD" && codPossible;
  // A coupon priced for a different cart is dropped (the customer re-applies it).
  const couponDiscountPaise = coupon && coupon.forTotal === cart.subtotalPaise ? coupon.discountPaise : 0;
  const payablePaise = cart.grandTotalPaise - couponDiscountPaise;
  const affordable = payingCod || walletBalancePaise >= payablePaise;
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
      setError(payload?.error?.message ?? "Could not update the cart.");
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
      setCouponError(payload?.error?.message ?? "That coupon can't be used.");
      return;
    }
    setCoupon({ code: payload.code, discountPaise: payload.discountPaise, forTotal: cart.subtotalPaise });
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
        paymentMethod: payingCod ? "COD" : "WALLET",
        acknowledgeClosedShopIds,
        ...(couponDiscountPaise > 0 && coupon ? { couponCode: coupon.code } : {}),
        ...(buyerShopId ? { orderType: "B2B", buyerShopId } : { orderType: "PERSONAL" }),
      }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setError(payload?.error?.message ?? "Checkout failed. Please try again.");
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
        title="Your cart is empty"
        description="Browse dairy and bakery products from shops near you."
        action={<LinkButton href="/">Start shopping</LinkButton>}
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
                <Link
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
                    <span>{issue.message}</span>
                    {issue.action !== "NONE" ? (
                      <button
                        type="button"
                        className="ml-2 underline"
                        disabled={busy}
                        onClick={() => runAction(issue, group)}
                      >
                        {issue.action === "CHANGE_ADDRESS"
                          ? "Change address"
                          : issue.action === "REMOVE_SHOP_ITEMS"
                            ? "Remove these items"
                            : issue.action === "REMOVE_UNAVAILABLE_ITEMS"
                              ? "Remove unavailable items"
                              : "Add items"}
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
                      {formatQuantity(line.unitSizeMilli, line.unit)} per unit
                    </p>

                    {line.purchasable ? (
                      <p className="mt-1 text-sm text-ink-600">
                        {line.listUnitPricePaise ? (
                          <span className="mr-1 text-ink-400 line-through">
                            <Money paise={line.listUnitPricePaise} />
                          </span>
                        ) : null}
                        <Money paise={line.unitPricePaise} /> × {line.quantity}
                        {line.offerTitle ? (
                          <span className="ml-2" data-testid="cart-offer">
                            <Badge tone="success">{line.offerTitle}</Badge>
                          </span>
                        ) : null}
                      </p>
                    ) : (
                      <p className="mt-1">
                        <Badge tone="danger">{line.unavailableReason}</Badge>
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col items-end justify-between gap-2">
                    <span className="font-medium text-ink-900">
                      {line.purchasable ? (
                        <Money paise={line.lineTotalPaise} />
                      ) : (
                        <span className="text-sm text-ink-400">—</span>
                      )}
                    </span>

                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        aria-label={`Decrease ${line.productName}`}
                        onClick={() =>
                          updateQuantity(line.cartItemId, line.quantity - 1)
                        }
                      >
                        −
                      </Button>
                      <span className="w-8 text-center text-sm tabular-nums">
                        {line.quantity}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        aria-label={`Increase ${line.productName}`}
                        onClick={() =>
                          updateQuantity(line.cartItemId, line.quantity + 1)
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
              <Row label="Subtotal" paise={group.subtotalPaise} />
              <Row label="Delivery" paise={group.deliveryFeePaise} />
              {group.taxPaise > 0 ? (
                <Row label="Taxes" paise={group.taxPaise} />
              ) : null}
            </div>

            {feasibility[group.shop.id] ? (
              <div className="border-t border-cream-200 px-4 py-3">
                <p className="mb-2 text-xs font-medium text-ink-500">Delivery time</p>
                <div className="flex flex-wrap gap-2">
                  {(["EXPRESS_30", "STANDARD_60", "SCHEDULED"] as const)
                    .filter((key) => feasibility[group.shop.id][key] || feasibility[group.shop.id].full?.[key])
                    .map((key) =>
                      feasibility[group.shop.id].full?.[key] ? (
                        <span
                          key={key}
                          aria-disabled="true"
                          data-testid={`slot-full-${key}`}
                          className="cursor-not-allowed rounded-full border border-cream-200 px-3 py-1.5 text-xs font-medium text-ink-400 line-through"
                        >
                          {WINDOW_LABEL[key]} · Full
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
                        {WINDOW_LABEL[key]}
                      </button>
                      ),
                    )}
                </div>
              </div>
            ) : null}
          </Card>
        ))}
      </div>

      <div className="lg:sticky lg:top-24 lg:self-start">
        <Card className="p-4">
          <h2 className="text-base font-semibold text-ink-900">Order summary</h2>

          <div className="mt-3 space-y-1 text-sm">
            <Row label="Subtotal" paise={cart.subtotalPaise} />
            <Row label="Delivery" paise={cart.deliveryFeePaise} />
            {cart.taxPaise > 0 ? <Row label="Taxes" paise={cart.taxPaise} /> : null}
            {couponDiscountPaise > 0 && coupon ? (
              <div className="flex justify-between text-leaf-700" data-testid="coupon-discount">
                <span>Coupon {coupon.code}</span>
                <span>
                  −<Money paise={couponDiscountPaise} />
                </span>
              </div>
            ) : null}
            <div className="mt-2 flex justify-between border-t border-cream-200 pt-2 text-base font-semibold text-ink-900">
              <span>Grand total</span>
              <Money paise={payablePaise} />
            </div>
          </div>

          {couponsEnabled ? (
            <div className="mt-3 space-y-1">
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  placeholder="Coupon code"
                  value={couponInput}
                  onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                  data-testid="coupon-input"
                />
                {couponDiscountPaise > 0 ? (
                  <Button variant="secondary" onClick={() => { setCoupon(null); setCouponInput(""); }}>
                    Remove
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => void applyCoupon()} disabled={!couponInput.trim()}>
                    Apply
                  </Button>
                )}
              </div>
              {couponError ? <p className="text-xs text-red-700">{couponError}</p> : null}
            </div>
          ) : null}

          <div className="mt-4 rounded-lg bg-cream-50 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-ink-600">Wallet balance</span>
              <Money paise={walletBalancePaise} className="font-medium" />
            </div>
          </div>

          <div className="mt-4">
            {addresses.length === 0 ? (
              <Alert tone="info">
                No saved delivery address.{" "}
                <a href="/profile/addresses" className="underline">
                  Add one
                </a>{" "}
                before checking out.
              </Alert>
            ) : (
              <Field label="Deliver to">
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
              <Field label="Ordering for">
                <select
                  className={inputClass}
                  value={buyerShopId}
                  onChange={(e) => setBuyerShopId(e.target.value)}
                  data-testid="order-for"
                >
                  <option value="">Myself (personal order)</option>
                  {buyerShops.map((shop) => (
                    <option key={shop.id} value={shop.id}>
                      {shop.name} (business order)
                    </option>
                  ))}
                </select>
              </Field>
              {buyerShopId ? (
                <p className="mt-1 text-xs text-ink-500">
                  Business orders are kept separate from your personal orders.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-3" data-testid="payment-method">
            <Field label="Pay with">
              <div className="space-y-1 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="payment-method"
                    checked={!payingCod}
                    onChange={() => setPaymentMethod("WALLET")}
                  />
                  Wallet
                </label>
                <label className={`flex items-center gap-2 ${codPossible ? "" : "text-ink-400"}`}>
                  <input
                    type="radio"
                    name="payment-method"
                    disabled={!codPossible}
                    checked={payingCod}
                    onChange={() => setPaymentMethod("COD")}
                  />
                  Cash on delivery
                </label>
                {!codPossible ? (
                  <p className="text-xs text-ink-500">
                    {codUnavailableReason ??
                      (buyerShopId ? "Business orders are paid from the wallet." : "Choose a delivery address for cash on delivery.")}
                  </p>
                ) : null}
              </div>
            </Field>
          </div>

          {cart.hasUnavailableItems ? (
            <div className="mt-3">
              <Alert tone="warning">
                Some items cannot be ordered online and will not be charged.
              </Alert>
            </div>
          ) : null}

          {!affordable ? (
            <div className="mt-3">
              <Alert tone="danger" title="Insufficient wallet balance">
                Add at least <Money paise={shortfall} /> to place this order.
              </Alert>
            </div>
          ) : null}

          {error ? (
            <div className="mt-3">
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}

          <div className="mt-4 space-y-2">
            {affordable && confirmingClosed ? (
              <div className="space-y-2" data-testid="shop-closed-confirm">
                <Alert tone="warning">
                  <span>
                    {closedGroups
                      .map((g) => {
                        const opens = nextOpeningAt(g.shop);
                        return `${g.shop.name}${opens ? ` (opens ${formatShopTime(opens)})` : ""}`;
                      })
                      .join(", ")}{" "}
                    might be closed now. Your order may be processed once the shop opens. The shop is alerted
                    immediately and again when it opens. Do you want to continue?
                  </span>
                </Alert>
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={busy}
                    onClick={() => checkout(closedGroups.map((g) => g.shop.id))}
                  >
                    Yes, continue
                  </Button>
                  <Button className="flex-1" variant="secondary" disabled={busy} onClick={() => setConfirmingClosed(false)}>
                    No, go back
                  </Button>
                </div>
              </div>
            ) : missingDetails ? (
              <div className="grid gap-2" data-testid="checkout-missing-details">
                {!hasMobile ? (
                  <Alert tone="warning">
                    Add your mobile number before ordering — the delivery partner needs it to reach you.{" "}
                    <a href="/profile" className="font-medium underline">
                      Add mobile number
                    </a>
                  </Alert>
                ) : null}
                {needsAddress ? (
                  <Alert tone="warning">
                    Add a delivery address before ordering.{" "}
                    <a href="/profile/addresses" className="font-medium underline">
                      Add address
                    </a>
                  </Alert>
                ) : null}
              </div>
            ) : affordable ? (
              <Button
                className="w-full"
                size="lg"
                disabled={busy || cart.grandTotalPaise === 0 || hasBlockingIssue}
                onClick={() => (closedGroups.length > 0 ? setConfirmingClosed(true) : checkout())}
              >
                {busy ? "Placing order…" : payingCod ? "Place order — pay cash on delivery" : "Pay from wallet"}
              </Button>
            ) : (
              <LinkButton href="/wallet" className="w-full justify-center">
                Add money to wallet
              </LinkButton>
            )}
            <LinkButton
              href="/"
              variant="secondary"
              className="w-full justify-center"
            >
              Continue shopping
            </LinkButton>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, paise }: { label: string; paise: number }) {
  return (
    <div className="flex justify-between text-ink-600">
      <span>{label}</span>
      {paise === 0 ? <span>Free</span> : <Money paise={paise} />}
    </div>
  );
}
