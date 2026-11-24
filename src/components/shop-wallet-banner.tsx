import { Alert, LinkButton, Money } from "@/components/ui";
import { FillText } from "@/components/board/fill-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Module 6: Hindi / Marathi. `{balance}` / `{min}` mark where the amount goes. */
const T = {
  low: L("Shop wallet running low", "दुकान वॉलेट में बैलेंस कम है", "दुकान वॉलेटमधील शिल्लक कमी आहे"),
  recharge: L("Recharge wallet to accept orders", "ऑर्डर स्वीकारने के लिए वॉलेट रिचार्ज करें", "ऑर्डर स्वीकारण्यासाठी वॉलेट रिचार्ज करा"),
  balance: L("Your shop wallet balance is {balance}.", "आपके दुकान वॉलेट का बैलेंस {balance} है।", "तुमच्या दुकान वॉलेटची शिल्लक {balance} आहे."),
  below: L(
    "Below {min} you cannot accept new orders and customers cannot order from your shop.",
    "{min} से कम होने पर आप नए ऑर्डर नहीं ले सकेंगे और ग्राहक आपकी दुकान से ऑर्डर नहीं कर सकेंगे।",
    "{min} पेक्षा कमी झाल्यास तुम्ही नवीन ऑर्डर घेऊ शकणार नाही आणि ग्राहक तुमच्या दुकानातून ऑर्डर करू शकणार नाहीत.",
  ),
  need: L(
    "You need at least {min} to accept new orders. Until then customers see your shop as not taking orders and cannot check out from it. Orders already accepted carry on as usual.",
    "नए ऑर्डर लेने के लिए कम से कम {min} चाहिए। तब तक ग्राहकों को आपकी दुकान ऑर्डर न लेती हुई दिखेगी और वे ऑर्डर नहीं कर सकेंगे। पहले से स्वीकार किए ऑर्डर पहले की तरह चलेंगे।",
    "नवीन ऑर्डर घेण्यासाठी किमान {min} हवेत. तोपर्यंत ग्राहकांना तुमचे दुकान ऑर्डर घेत नसल्याचे दिसेल आणि ते ऑर्डर करू शकणार नाहीत. आधी स्वीकारलेल्या ऑर्डर नेहमीप्रमाणे चालू राहतील.",
  ),
  rechargeButton: L("Recharge wallet", "वॉलेट रिचार्ज करें", "वॉलेट रिचार्ज करा"),
} as const;


/**
 * "Recharge wallet" notice on the shop's pages (rule shopWallet). Purely
 * presentational: the server decides whether the shop may accept orders, and
 * refuses an accept on its own when it may not.
 */
export function ShopWalletBanner({
  enabled,
  balancePaise,
  minBalancePaise,
  canAcceptOrders,
  lowBalance,
  lang = "en",
}: {
  enabled: boolean;
  balancePaise: number;
  minBalancePaise: number;
  canAcceptOrders: boolean;
  lowBalance: boolean;
  /** Module 6: the board language (English by default). */
  lang?: Lang;
}) {
  if (!enabled || (canAcceptOrders && !lowBalance)) return null;
  return (
    <div className="mb-6" data-testid="shop-wallet-banner">
      <Alert tone={canAcceptOrders ? "warning" : "danger"} title={canAcceptOrders ? tr(T.low, lang) : tr(T.recharge, lang)}>
        <p>
          <FillText text={tr(T.balance, lang)} parts={{ balance: <Money paise={balancePaise} /> }} />{" "}
          <FillText text={tr(canAcceptOrders ? T.below : T.need, lang)} parts={{ min: <Money paise={minBalancePaise} /> }} />
        </p>
        <div className="mt-2">
          <LinkButton href="/shop/wallet">{tr(T.rechargeButton, lang)}</LinkButton>
        </div>
      </Alert>
    </div>
  );
}
