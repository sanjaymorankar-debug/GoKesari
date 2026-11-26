import { eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";

import { CartView } from "@/components/cart-view";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listAddresses } from "@/server/services/addresses";
import { getCodEligibility } from "@/server/services/cod";
import { getCart } from "@/server/services/cart";
import { db } from "@/server/db";
import { shops, users } from "@/server/db/schema";
import { getCustomerLocation } from "@/server/location";
import { validateCartForLocation } from "@/server/services/cart-validation";
import { listShopsForOwner } from "@/server/services/shops";
import { listOpenOrdersForCheckout } from "@/server/services/orders";
import { getRule } from "@/server/services/settings";
import { getWalletByUserId } from "@/server/services/wallet";
import { BankAccountPrompt } from "@/components/bank-account-prompt";
import { customerBankPrompt } from "@/server/services/bank-accounts";
import Link from "next/link";
import { Alert } from "@/components/ui";
import { needsSignupReferralCode } from "@/server/services/customer-signup-referrals";
import { getBoardLang } from "@/server/board-lang";
import { L, tr } from "@/lib/board/i18n";
import { SaveCartAsList } from "@/components/purchase-lists/save-cart-as-list";
import { listPurchaseLists } from "@/server/services/purchase-lists";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { ScanListTile } from "@/components/smart-list/scan-list-tile";
import { GuestCartView } from "@/components/guest-cart/guest-cart-view";
import { VERIFY_IDENTITY_PATH } from "@/lib/kyc/identity";
import { isIdentityVerificationOn, isIdentityVerified } from "@/server/services/identity-verification";
import { CartShopRecommendation } from "@/components/guest-checkout/cart-shop-recommendation";
import { isGuestCheckoutOn } from "@/server/guest-checkout/tracking";

export const metadata = { title: "Cart" };

/** Module 6 (docs/hindi-marathi-2026-11): the cart page's own wording. */
const T = {
  noCod: L("{shop} does not accept cash on delivery.", "{shop} कैश ऑन डिलीवरी नहीं लेती।", "{shop} कॅश ऑन डिलिव्हरी स्वीकारत नाही."),
  codLimit: L(
    "Cash on delivery is available up to {amount} per shop order.",
    "कैश ऑन डिलीवरी हर दुकान के ऑर्डर पर {amount} तक ही है।",
    "कॅश ऑन डिलिव्हरी प्रत्येक दुकानाच्या ऑर्डरवर {amount} पर्यंतच आहे.",
  ),
  tooManyCod: L(
    "Too many cash-on-delivery orders open — pay from your wallet.",
    "कैश ऑन डिलीवरी के बहुत ऑर्डर खुले हैं — वॉलेट से भुगतान करें।",
    "कॅश ऑन डिलिव्हरीच्या खूप ऑर्डर सुरू आहेत — वॉलेटमधून पैसे द्या.",
  ),
  title: L("Your cart", "आपका कार्ट", "तुमचे कार्ट"),
  description: L(
    "Items are grouped by shop — each shop becomes its own order.",
    "चीज़ें दुकान के हिसाब से रखी गई हैं — हर दुकान का अलग ऑर्डर बनेगा।",
    "वस्तू दुकानानुसार गटात आहेत — प्रत्येक दुकानाची वेगळी ऑर्डर होईल.",
  ),
  referralTitle: L(
    "A referral code is needed for your first order",
    "पहले ऑर्डर के लिए रेफ़रल कोड ज़रूरी है",
    "पहिल्या ऑर्डरसाठी रेफरल कोड आवश्यक आहे",
  ),
  referralText: L(
    "Enter the code you were given — or ask us for one — in",
    "आपको मिला कोड डालें — या हमसे माँगें — यहाँ:",
    "तुम्हाला मिळालेला कोड टाका — किंवा आमच्याकडे मागा — येथे:",
  ),
  myReferralCode: L("My referral code", "मेरा रेफ़रल कोड", "माझा रेफरल कोड"),
} as const;
export const dynamic = "force-dynamic";

export default async function CartPage({ searchParams }: { searchParams?: Promise<{ guest?: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    // docs/guest-cart-2026-11: with guest_cart_enabled on, a guest sees the cart kept in their browser
    // and is asked to sign in only at "Place order". Off: sign in first, as before.
    if (!(await isFeatureEnabled("guest_cart_enabled").catch(() => false))) redirect("/signin");
    // docs/guest-checkout-2026-11: with guest_checkout_enabled on too, the guest can also check out here
    // (contact + one-time code) and sees the best-shop panel. The PIN code comes from the chosen location.
    const guestLocation = (await isGuestCheckoutOn()) ? await getCustomerLocation(null) : undefined;
    const guestCheckout =
      guestLocation === undefined
        ? null
        : {
            prefill: guestLocation
              ? { pincode: guestLocation.pincode ?? null, area: null, latitude: guestLocation.latitude ?? null, longitude: guestLocation.longitude ?? null }
              : null,
          };
    return (
      <>
        <PageHeader title="Your cart" description="Items are grouped by shop — each shop becomes its own order." />
        <GuestCartView lang={await getBoardLang()} guestCheckout={guestCheckout} />
      </>
    );
  }

  const canOrderB2B = can(user.role, PERMISSIONS.ORDER_PLACE_B2B);
  const [cart, wallet, addresses, ownedShops, codEligibility, [account]] = await Promise.all([
    getCart(user.id),
    getWalletByUserId(user.id),
    listAddresses(user.id),
    canOrderB2B ? listShopsForOwner(user.id) : Promise.resolve([]),
    getCodEligibility(user.id),
    db.select({ phoneE164: users.phoneE164 }).from(users).where(eq(users.id, user.id)),
  ]);
  // Cart re-validated against the chosen delivery location: shop eligibility,
  // availability, minimum order and delivery charge, each with a suggested
  // action. Checkout enforces the same rules (GS-026).
  const location = await getCustomerLocation(user.id);
  const cartShopIds = cart.groups.map((g) => g.shop.id);
  const cartShops =
    cartShopIds.length > 0 ? await db.select().from(shops).where(inArray(shops.id, cartShopIds)) : [];
  const validation = await validateCartForLocation(user.id, location);
  // C3: open orders the customer is asked about before paying (rule openOrderCheck).
  const openOrders = cart.groups.length > 0 ? await listOpenOrdersForCheckout(user.id, cartShopIds) : [];
  // GS-030: why cash on delivery is unavailable for this cart, if it is.
  const tooLarge = cart.groups.find((g) => g.totalPaise > codEligibility.maxOrderPaise);
  const noCodShop = cartShops.find((s) => !s.codEnabled || !s.deliveryAvailable);
  const lang = await getBoardLang();
  const codUnavailableReason = !codEligibility.allowed
    ? codEligibility.reason
    : noCodShop
      ? tr(T.noCod, lang).replace("{shop}", noCodShop.name)
      : tooLarge
        ? tr(T.codLimit, lang).replace("{amount}", `₹${(codEligibility.maxOrderPaise / 100).toFixed(0)}`)
        : cart.groups.length > codEligibility.maxOpenOrders - codEligibility.openOrders
          ? tr(T.tooManyCod, lang)
          : null;
  const preferredAddressId =
    location?.addressId && addresses.some((a) => a.id === location.addressId)
      ? location.addressId
      : null;

  // Only an approved shop can buy for its business; checkout re-checks this.
  const buyerShops = ownedShops
    .filter((shop) => shop.status === "APPROVED")
    .map((shop) => ({ id: shop.id, name: shop.name }));

  // Bank accounts (docs/four-features-2026-10): a prompt at the first checkout, never a blocker.
  const bankPrompt = cart.groups.length > 0 ? await customerBankPrompt(user.id, "checkout") : null;
  // Mandatory referral code (rule customerSignupReferral.required): checkout refuses a first order without one.
  const needsReferralCode = cart.groups.length > 0 && (await needsSignupReferralCode(user.id));
  // docs/identity-verification-2026-11 (flag on): checkout refuses a first order until the identity is verified.
  const needsIdentity = cart.groups.length > 0 && (await isIdentityVerificationOn("CUSTOMER")) && !(await isIdentityVerified(user.id));
  // docs/purchase-lists-2026-10: "Save as a list" offers the customer's own lists.
  const purchaseLists = cart.groups.length > 0 ? await listPurchaseLists(user.id) : [];
  // docs/smart-shopping-2026-11: "Scan my shopping list" in the cart too.
  const [scanList, guestCheckoutOn] = await Promise.all([
    isFeatureEnabled("smart_list_scan_enabled").catch(() => false),
    isGuestCheckoutOn(),
  ]);
  // docs/guest-checkout-2026-11: /cart?guest=1 is where a guest lands right after verifying.
  const justVerified = (await searchParams)?.guest === "1";

  return (
    <>
      <PageHeader
        title={tr(T.title, lang)}
        description={tr(T.description, lang)}
      />
      {scanList ? (
        <div className="mb-4">
          <ScanListTile lang={lang} compact />
        </div>
      ) : null}
      {bankPrompt ? <BankAccountPrompt status={bankPrompt} href="/profile/bank-account" purpose="refunds" /> : null}
      {needsReferralCode ? (
        <div className="mb-4" data-testid="cart-referral-needed">
          <Alert tone="warning" title={tr(T.referralTitle, lang)}>
            {tr(T.referralText, lang)}{" "}
            <Link href="/referral" className="font-medium underline">
              {tr(T.myReferralCode, lang)}
            </Link>
            .
          </Alert>
        </div>
      ) : null}
      {needsIdentity ? (
        <div className="mb-4" data-testid="cart-identity-needed">
          <Alert tone="warning" title="Verify your identity before your first order">
            A one-time check with Aadhaar (DigiLocker) or your PAN —{" "}
            <Link href={`${VERIFY_IDENTITY_PATH}?next=/cart`} className="font-medium underline">
              verify now
            </Link>
            . You won&apos;t be asked again.
          </Alert>
        </div>
      ) : null}
      {cart.groups.length > 0 ? (
        <SaveCartAsList lists={purchaseLists.map((l) => ({ id: l.id, name: l.name, kind: l.kind }))} lang={lang} />
      ) : null}
      {guestCheckoutOn && cart.groups.length > 0 ? (
        <CartShopRecommendation lang={lang} cartKey={cart.groups.flatMap((g) => g.lines.map((l) => `${l.cartItemId}:${l.quantity}`)).join(",")} />
      ) : null}
      {guestCheckoutOn && justVerified ? (
        <div className="mb-4">
          <Alert tone="success" title="You are signed in">
            Your address is saved. Choose how to pay below and place your order.
          </Alert>
        </div>
      ) : null}
      <CartView
        cart={cart}
        walletBalancePaise={wallet?.balancePaise ?? 0}
        buyerShops={buyerShops}
        initialChecks={validation.shops}
        preferredAddressId={preferredAddressId}
        codUnavailableReason={codUnavailableReason}
        hasMobile={Boolean(account?.phoneE164)}
        couponsEnabled={(await getRule("coupons")).enabled}
        onlinePaymentsEnabled={(await getRule("onlinePayments")).enabled}
        lang={lang}
        openOrders={openOrders.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          shopName: o.shopName,
          orderType: o.orderType,
          status: o.status,
          statusLabel: o.statusLabel,
          totalPaise: o.totalPaise,
          customerMayCancel: o.customerMayCancel,
        }))}
        addresses={addresses.map((a) => ({
          id: a.id,
          label: a.label,
          line1: a.line1,
          area: a.area,
          city: a.city,
          pincode: a.pincode,
          isDefault: a.isDefault,
        }))}
      />
    </>
  );
}
