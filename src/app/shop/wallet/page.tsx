import { redirect } from "next/navigation";

import { ShopWalletBanner } from "@/components/shop-wallet-banner";
import { ShopWalletTopUp } from "@/components/shop-wallet-topup";
import { Alert, Badge, Card, EmptyState, Money, PageHeader, Section } from "@/components/ui";
import { FillText } from "@/components/board/fill-text";
import { L, tr, type Text } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getShopWalletView } from "@/server/services/shop-wallet";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Shop Wallet" };
export const dynamic = "force-dynamic";

const ENTRY_LABELS: Record<string, Text> = {
  TOP_UP: L("Recharge", "रिचार्ज", "रिचार्ज"),
  COMMISSION: L("Commission", "कमीशन", "कमिशन"),
  DELIVERY_CHARGE: L("Delivery charge", "डिलीवरी शुल्क", "डिलिव्हरी शुल्क"),
  MANUAL_CREDIT: L("Credit by GoKesari", "GoKesari द्वारा जमा", "GoKesari कडून जमा"),
  MANUAL_DEBIT: L("Debit by GoKesari", "GoKesari द्वारा कटौती", "GoKesari कडून वजा"),
  COMMISSION_REFUND: L("Commission returned", "कमीशन वापस", "कमिशन परत"),
};

/** Module 6: Hindi / Marathi for this page (English unchanged). */
const T = {
  title: L("Wallet", "वॉलेट", "वॉलेट"),
  description: L(
    "{shop} — GoKesari's commission and delivery charge are deducted from this prepaid balance when an order is delivered.",
    "{shop} — ऑर्डर डिलीवर होने पर GoKesari का कमीशन और डिलीवरी शुल्क इस प्रीपेड बैलेंस से कटता है।",
    "{shop} — ऑर्डर पोहोचल्यावर GoKesari चे कमिशन आणि डिलिव्हरी शुल्क या प्रीपेड शिल्लकेतून वजा होते.",
  ),
  notOn: L("Not switched on yet", "अभी चालू नहीं", "अजून सुरू नाही"),
  notOnText: L(
    "Prepaid shop wallets are not in use yet. Commission is still taken from your weekly settlement, as shown on Finance.",
    "प्रीपेड दुकान वॉलेट अभी उपयोग में नहीं हैं। कमीशन अब भी आपके साप्ताहिक सेटलमेंट से लिया जाता है, जैसा फ़ाइनेंस में दिखता है।",
    "प्रीपेड दुकान वॉलेट अजून वापरात नाहीत. कमिशन अजूनही तुमच्या साप्ताहिक सेटलमेंटमधून घेतले जाते, फायनान्समध्ये दाखवल्याप्रमाणे.",
  ),
  balance: L("Balance", "बैलेंस", "शिल्लक"),
  accepting: L("accepting orders", "ऑर्डर ले रहे हैं", "ऑर्डर घेत आहे"),
  rechargeToAccept: L("recharge to accept orders", "ऑर्डर लेने के लिए रिचार्ज करें", "ऑर्डर घेण्यासाठी रिचार्ज करा"),
  minimum: L("Minimum to accept orders", "ऑर्डर लेने के लिए न्यूनतम", "ऑर्डर घेण्यासाठी किमान"),
  reminderBelow: L("reminder below {amount}", "{amount} से कम होने पर याद दिलाएँगे", "{amount} पेक्षा कमी झाल्यावर आठवण"),
  commission: L("Commission per delivered order", "हर डिलीवर ऑर्डर पर कमीशन", "प्रत्येक पोहोचलेल्या ऑर्डरवर कमिशन"),
  ofGoods: L("of the goods value", "सामान के मूल्य का", "मालाच्या किमतीच्या"),
  deliveryCharge: L("Delivery charge", "डिलीवरी शुल्क", "डिलिव्हरी शुल्क"),
  perKm: L("per km", "प्रति किमी", "प्रति किमी"),
  plusPerOrder: L("plus {amount} per order,", "साथ में प्रति ऑर्डर {amount},", "आणि प्रति ऑर्डर {amount},"),
  shopToCustomer: L(
    "shop to customer, for orders a GoKesari rider delivers ({amount} if the distance is not known)",
    "दुकान से ग्राहक तक, GoKesari राइडर द्वारा डिलीवर ऑर्डर के लिए (दूरी पता न हो तो {amount})",
    "दुकानापासून ग्राहकापर्यंत, GoKesari रायडरने पोहोचवलेल्या ऑर्डरसाठी (अंतर माहीत नसल्यास {amount})",
  ),
  history: L("Wallet history", "वॉलेट इतिहास", "वॉलेट इतिहास"),
  noEntries: L("No wallet entries yet.", "अभी वॉलेट में कोई एंट्री नहीं।", "अजून वॉलेटमध्ये नोंदी नाहीत."),
  when: L("When", "कब", "केव्हा"),
  entry: L("Entry", "एंट्री", "नोंद"),
  order: L("Order", "ऑर्डर", "ऑर्डर"),
  reason: L("Reason", "कारण", "कारण"),
  amount: L("Amount", "रकम", "रक्कम"),
  balanceAfter: L("Balance after", "बाद का बैलेंस", "नंतरची शिल्लक"),
} as const;

const dateTime = (d: Date) =>
  d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * The shop's prepaid wallet (docs/shop-wallet-delivery-otp-2026-10): balance,
 * the levels that matter, recharge, and every ledger entry with the order it
 * belongs to and the balance after it.
 */
export default async function ShopWalletPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SETTLEMENT_VIEW_OWN)) redirect("/");

  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = await activeShop(shops);
  const [wallet, lang] = await Promise.all([getShopWalletView(shop.id, { limit: 100 }), getBoardLang()]);

  return (
    <>
      <PageHeader
        title={tr(T.title, lang)}
        description={tr(T.description, lang).replace("{shop}", shop.name)}
      />

      {!wallet.enabled ? (
        <div className="mb-6">
          <Alert tone="info" title={tr(T.notOn, lang)}>
            {tr(T.notOnText, lang)}
          </Alert>
        </div>
      ) : (
        <ShopWalletBanner {...wallet} lang={lang} />
      )}

      <section className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs text-ink-500">{tr(T.balance, lang)}</p>
          <p className={`mt-1 text-xl font-bold ${wallet.balancePaise < 0 ? "text-red-700" : "text-ink-900"}`} data-testid="shop-wallet-balance">
            <Money paise={wallet.balancePaise} />
          </p>
          <p className="mt-1">
            {wallet.canAcceptOrders ? <Badge tone="success">{tr(T.accepting, lang)}</Badge> : <Badge tone="danger">{tr(T.rechargeToAccept, lang)}</Badge>}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">{tr(T.minimum, lang)}</p>
          <p className="mt-1 text-xl font-bold text-ink-900"><Money paise={wallet.minBalancePaise} /></p>
          <p className="text-xs text-ink-500">
            <FillText text={tr(T.reminderBelow, lang)} parts={{ amount: <Money paise={wallet.lowBalanceThresholdPaise} /> }} />
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">{tr(T.commission, lang)}</p>
          <p className="mt-1 text-xl font-bold text-ink-900">{(wallet.commissionRateBp / 100).toFixed(2)}%</p>
          <p className="text-xs text-ink-500">{tr(T.ofGoods, lang)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">{tr(T.deliveryCharge, lang)}</p>
          <p className="mt-1 text-xl font-bold text-ink-900">
            <Money paise={wallet.deliveryChargePerKmPaise} /> <span className="text-sm font-medium text-ink-500">{tr(T.perKm, lang)}</span>
          </p>
          <p className="text-xs text-ink-500">
            {wallet.deliveryChargePaise > 0 ? (
              <>
                <FillText text={tr(T.plusPerOrder, lang)} parts={{ amount: <Money paise={wallet.deliveryChargePaise} /> }} />{" "}
              </>
            ) : null}
            <FillText text={tr(T.shopToCustomer, lang)} parts={{ amount: <Money paise={wallet.deliveryChargeUnknownDistancePaise} /> }} />
          </p>
        </Card>
      </section>

      {wallet.enabled ? (
        <div className="mb-8">
          <ShopWalletTopUp shopId={shop.id} minPaise={wallet.topupMinPaise} maxPaise={wallet.topupMaxPaise} lang={lang} />
        </div>
      ) : null}

      <Section id="history" title={tr(T.history, lang)}>
        {wallet.transactions.length === 0 ? (
          <EmptyState title={tr(T.noEntries, lang)} />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="shop-wallet-ledger">
              <thead className="bg-cream-50 text-left text-xs text-ink-500">
                <tr>
                  <th className="px-3 py-2">{tr(T.when, lang)}</th>
                  <th className="px-3 py-2">{tr(T.entry, lang)}</th>
                  <th className="px-3 py-2">{tr(T.order, lang)}</th>
                  <th className="px-3 py-2">{tr(T.reason, lang)}</th>
                  <th className="px-3 py-2 text-right">{tr(T.amount, lang)}</th>
                  <th className="px-3 py-2 text-right">{tr(T.balanceAfter, lang)}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-100">
                {wallet.transactions.map((t) => (
                  <tr key={t.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-500">{dateTime(t.createdAt)}</td>
                    <td className="px-3 py-2">{ENTRY_LABELS[t.type] ? tr(ENTRY_LABELS[t.type], lang) : t.type}</td>
                    <td className="px-3 py-2">{t.orderNumber ?? "—"}</td>
                    <td className="px-3 py-2 text-ink-600">{t.reason}</td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right font-medium ${t.direction === "CREDIT" ? "text-leaf-700" : "text-red-700"}`}>
                      {t.direction === "CREDIT" ? "+" : "−"}
                      <Money paise={t.amountPaise} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <Money paise={t.balanceAfterPaise} />
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
