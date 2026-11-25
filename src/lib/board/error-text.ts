/**
 * Hindi and Marathi for the most common customer-facing error messages
 * (Module 6, docs/hindi-marathi-2026-11/).
 *
 * The server keeps sending English messages and codes — nothing here changes
 * an API. The screen passes the English message it received (and the error
 * code when it has one) through `errorText()` at display time:
 *
 *  1. English  → the message exactly as received.
 *  2. An exact known message → its translation.
 *  3. A known message with a shop name / amount / time in it → translated
 *     with those parts kept as they are.
 *  4. A code whose meaning is the whole story (rate limit, sign-in, server
 *     error…) → a general translated line.
 *  5. Anything else → the English message unchanged (never a wrong guess).
 *
 * No server or database imports: used by client components and unit tests.
 */

import { L, tr, type Lang, type Text } from "./i18n";

/** Exact English messages the API or the screens send, with HI / MR. */
export const ERROR_TEXT: Readonly<Record<string, Text>> = {
  // Cart and checkout
  "Your cart is empty.": L("Your cart is empty.", "आपका कार्ट खाली है।", "तुमचे कार्ट रिकामे आहे."),
  "These items are no longer available online.": L(
    "These items are no longer available online.",
    "ये चीज़ें अब ऑनलाइन उपलब्ध नहीं हैं।",
    "या वस्तू आता ऑनलाइन उपलब्ध नाहीत.",
  ),
  "This product is no longer available.": L(
    "This product is no longer available.",
    "यह उत्पाद अब उपलब्ध नहीं है।",
    "हे उत्पादन आता उपलब्ध नाही.",
  ),
  "This product is currently unavailable online.": L(
    "This product is currently unavailable online.",
    "यह उत्पाद अभी ऑनलाइन उपलब्ध नहीं है।",
    "हे उत्पादन सध्या ऑनलाइन उपलब्ध नाही.",
  ),
  "Currently unavailable online.": L("Currently unavailable online.", "अभी ऑनलाइन उपलब्ध नहीं।", "सध्या ऑनलाइन उपलब्ध नाही."),
  "Available only at the physical shop.": L(
    "Available only at the physical shop.",
    "सिर्फ़ दुकान पर जाकर मिलेगा।",
    "फक्त दुकानात जाऊनच मिळेल.",
  ),
  "Out of stock.": L("Out of stock.", "स्टॉक में नहीं है।", "स्टॉक संपला आहे."),
  "Add a delivery address before placing this order.": L(
    "Add a delivery address before placing this order.",
    "ऑर्डर करने से पहले डिलीवरी का पता जोड़ें।",
    "ऑर्डर देण्यापूर्वी डिलिव्हरीचा पत्ता जोडा.",
  ),
  "Choose a delivery address to pay cash on delivery.": L(
    "Choose a delivery address to pay cash on delivery.",
    "कैश ऑन डिलीवरी के लिए डिलीवरी का पता चुनें।",
    "कॅश ऑन डिलिव्हरीसाठी डिलिव्हरीचा पत्ता निवडा.",
  ),
  "Cash on delivery is not available.": L(
    "Cash on delivery is not available.",
    "कैश ऑन डिलीवरी उपलब्ध नहीं है।",
    "कॅश ऑन डिलिव्हरी उपलब्ध नाही.",
  ),
  "Online payment is not available. Please pay from your wallet or choose cash on delivery.": L(
    "Online payment is not available. Please pay from your wallet or choose cash on delivery.",
    "ऑनलाइन भुगतान उपलब्ध नहीं है। वॉलेट से भुगतान करें या कैश ऑन डिलीवरी चुनें।",
    "ऑनलाइन पेमेंट उपलब्ध नाही. वॉलेटमधून पैसे द्या किंवा कॅश ऑन डिलिव्हरी निवडा.",
  ),
  "Add your mobile number in My Profile before placing an order — the delivery partner needs it to reach you.": L(
    "Add your mobile number in My Profile before placing an order — the delivery partner needs it to reach you.",
    "ऑर्डर से पहले मेरी प्रोफ़ाइल में मोबाइल नंबर जोड़ें — डिलीवरी पार्टनर को आपसे संपर्क करना होता है।",
    "ऑर्डर देण्यापूर्वी माझे प्रोफाइलमध्ये मोबाइल नंबर जोडा — डिलिव्हरी पार्टनरला तुमच्याशी संपर्क करावा लागतो.",
  ),
  "This address does not belong to you.": L(
    "This address does not belong to you.",
    "यह पता आपका नहीं है।",
    "हा पत्ता तुमचा नाही.",
  ),
  "Could not update the cart.": L("Could not update the cart.", "कार्ट अपडेट नहीं हो सका।", "कार्ट अपडेट करता आले नाही."),
  "Checkout failed. Please try again.": L(
    "Checkout failed. Please try again.",
    "ऑर्डर पूरा नहीं हो सका। फिर कोशिश करें।",
    "ऑर्डर पूर्ण झाली नाही. पुन्हा प्रयत्न करा.",
  ),
  "Could not cancel that order.": L("Could not cancel that order.", "वह ऑर्डर रद्द नहीं हो सका।", "ती ऑर्डर रद्द करता आली नाही."),
  "Could not save this address.": L("Could not save this address.", "यह पता सहेजा नहीं जा सका।", "हा पत्ता जतन करता आला नाही."),
  // Coupons
  "That coupon code isn't valid.": L("That coupon code isn't valid.", "यह कूपन कोड सही नहीं है।", "हा कूपन कोड चुकीचा आहे."),
  "That coupon has expired.": L("That coupon has expired.", "इस कूपन की अवधि खत्म हो गई है।", "या कूपनची मुदत संपली आहे."),
  "That coupon isn't active yet.": L("That coupon isn't active yet.", "यह कूपन अभी चालू नहीं हुआ है।", "हा कूपन अजून सुरू झालेला नाही."),
  "This coupon has been fully used.": L("This coupon has been fully used.", "यह कूपन पूरा इस्तेमाल हो चुका है।", "हा कूपन पूर्ण वापरला गेला आहे."),
  "You've already used this coupon.": L("You've already used this coupon.", "आप यह कूपन पहले ही इस्तेमाल कर चुके हैं।", "तुम्ही हा कूपन आधीच वापरला आहे."),
  "That coupon can't be used.": L("That coupon can't be used.", "यह कूपन इस्तेमाल नहीं हो सकता।", "हा कूपन वापरता येणार नाही."),
  "That coupon is no longer available. Remove it and try again.": L(
    "That coupon is no longer available. Remove it and try again.",
    "यह कूपन अब उपलब्ध नहीं है। इसे हटाकर फिर कोशिश करें।",
    "हा कूपन आता उपलब्ध नाही. तो काढून पुन्हा प्रयत्न करा.",
  ),
  "Coupons aren't available right now.": L("Coupons aren't available right now.", "अभी कूपन उपलब्ध नहीं हैं।", "सध्या कूपन उपलब्ध नाहीत."),
  // Wallet and payment
  "Insufficient wallet balance. Please recharge your wallet.": L(
    "Insufficient wallet balance. Please recharge your wallet.",
    "वॉलेट में पर्याप्त बैलेंस नहीं है। कृपया वॉलेट रिचार्ज करें।",
    "वॉलेटमध्ये पुरेशी शिल्लक नाही. कृपया वॉलेट रिचार्ज करा.",
  ),
  "We could not verify this payment.": L(
    "We could not verify this payment.",
    "हम इस भुगतान की पुष्टि नहीं कर सके।",
    "आम्ही हे पेमेंट पडताळू शकलो नाही.",
  ),
  "Payment could not be verified.": L("Payment could not be verified.", "भुगतान की पुष्टि नहीं हो सकी।", "पेमेंट पडताळता आले नाही."),
  "This payment can no longer be completed.": L(
    "This payment can no longer be completed.",
    "यह भुगतान अब पूरा नहीं हो सकता।",
    "हे पेमेंट आता पूर्ण करता येणार नाही.",
  ),
  "Could not start the payment.": L("Could not start the payment.", "भुगतान शुरू नहीं हो सका।", "पेमेंट सुरू करता आले नाही."),
  "Payment failed": L("Payment failed", "भुगतान असफल", "पेमेंट अयशस्वी"),
  // Sign-in and codes
  "Please sign in to continue.": L("Please sign in to continue.", "आगे बढ़ने के लिए साइन इन करें।", "पुढे जाण्यासाठी साइन इन करा."),
  "That code is wrong or has expired. Check the latest email or request a new code.": L(
    "That code is wrong or has expired. Check the latest email or request a new code.",
    "कोड गलत है या उसकी अवधि खत्म हो गई है। नया ईमेल देखें या नया कोड माँगें।",
    "कोड चुकीचा आहे किंवा त्याची मुदत संपली आहे. नवीन ईमेल पहा किंवा नवीन कोड मागवा.",
  ),
  "Could not send a code. Please try again.": L(
    "Could not send a code. Please try again.",
    "कोड नहीं भेजा जा सका। फिर कोशिश करें।",
    "कोड पाठवता आला नाही. पुन्हा प्रयत्न करा.",
  ),
  "Too many codes were requested for this email. Try again later.": L(
    "Too many codes were requested for this email. Try again later.",
    "इस ईमेल के लिए बहुत ज़्यादा कोड माँगे गए। थोड़ी देर बाद कोशिश करें।",
    "या ईमेलसाठी खूप कोड मागवले गेले. थोड्या वेळाने प्रयत्न करा.",
  ),
  "A delivery code is available once your order is on the way.": L(
    "A delivery code is available once your order is on the way.",
    "ऑर्डर रास्ते में होने पर डिलीवरी कोड मिलेगा।",
    "ऑर्डर वाटेत असताना डिलिव्हरी कोड मिळेल.",
  ),
  // General
  "You do not have access to do that.": L("You do not have access to do that.", "आपको यह करने की अनुमति नहीं है।", "तुम्हाला हे करण्याची परवानगी नाही."),
  "Not found.": L("Not found.", "नहीं मिला।", "सापडले नाही."),
  "Something went wrong.": L("Something went wrong.", "कुछ गड़बड़ हो गई।", "काहीतरी चुकले."),
  "Something went wrong. Please try again.": L(
    "Something went wrong. Please try again.",
    "कुछ गड़बड़ हो गई। फिर कोशिश करें।",
    "काहीतरी चुकले. पुन्हा प्रयत्न करा.",
  ),
  "Could not reach the server. Please try again.": L(
    "Could not reach the server. Please try again.",
    "सर्वर से संपर्क नहीं हो सका। फिर कोशिश करें।",
    "सर्व्हरशी संपर्क झाला नाही. पुन्हा प्रयत्न करा.",
  ),
};

/** Messages with a name, amount or time inside. `$1`… are kept from the English. */
const ERROR_PATTERNS: ReadonlyArray<{ re: RegExp; text: Text }> = [
  {
    re: /^(.+) is not open for orders\.$/,
    text: L("$1 is not open for orders.", "$1 अभी ऑर्डर नहीं ले रही है।", "$1 सध्या ऑर्डर घेत नाही."),
  },
  {
    re: /^(.+) is not taking new orders right now\. Try again later or remove its items\.$/,
    text: L(
      "$1 is not taking new orders right now. Try again later or remove its items.",
      "$1 अभी नए ऑर्डर नहीं ले रही है। बाद में कोशिश करें या इसकी चीज़ें हटाएँ।",
      "$1 सध्या नवीन ऑर्डर घेत नाही. नंतर प्रयत्न करा किंवा त्यातील वस्तू काढा.",
    ),
  },
  {
    re: /^(.+?) does not deliver to (.+?)\.(?: .*)?$/,
    text: L("$1 does not deliver to $2.", "$1 $2 पर डिलीवरी नहीं करती।", "$1 $2 येथे डिलिव्हरी करत नाही."),
  },
  {
    re: /^None of the items from (.+) can be ordered right now\.$/,
    text: L(
      "None of the items from $1 can be ordered right now.",
      "$1 की कोई भी चीज़ अभी ऑर्डर नहीं हो सकती।",
      "$1 मधील कोणतीही वस्तू सध्या ऑर्डर करता येत नाही.",
    ),
  },
  {
    re: /^(\d+) items? from (.+) cannot be ordered and will be left out\.$/,
    text: L(
      "$1 item(s) from $2 cannot be ordered and will be left out.",
      "$2 की $1 चीज़ें ऑर्डर नहीं हो सकतीं और छोड़ दी जाएँगी।",
      "$2 मधील $1 वस्तू ऑर्डर करता येत नाहीत आणि वगळल्या जातील.",
    ),
  },
  {
    re: /^(.+) needs a minimum order of (₹[\d,.]+) — add (₹[\d,.]+) more\.$/,
    text: L(
      "$1 needs a minimum order of $2 — add $3 more.",
      "$1 में कम से कम $2 का ऑर्डर ज़रूरी है — $3 और जोड़ें।",
      "$1 साठी किमान $2 ची ऑर्डर आवश्यक आहे — आणखी $3 जोडा.",
    ),
  },
  {
    re: /^(.+?) might be closed right now(?: \(opens (.+?)\))?\. You can still place the order.*$/,
    text: L(
      "$1 might be closed right now. You can still place the order.",
      "$1 अभी बंद हो सकती है। फिर भी आप ऑर्डर कर सकते हैं — दुकान खुलने पर ऑर्डर आगे बढ़ेगा।",
      "$1 सध्या बंद असू शकते. तरीही तुम्ही ऑर्डर देऊ शकता — दुकान उघडल्यावर ऑर्डर पुढे जाईल.",
    ),
  },
  {
    re: /^Please wait (\d+) seconds before requesting another code\.$/,
    text: L(
      "Please wait $1 seconds before requesting another code.",
      "नया कोड माँगने से पहले $1 सेकंड रुकें।",
      "नवीन कोड मागण्यापूर्वी $1 सेकंद थांबा.",
    ),
  },
  {
    re: /^(.+) was not found\.$/,
    text: L("$1 was not found.", "नहीं मिला।", "सापडले नाही."),
  },
];

/** Codes whose meaning is the whole message: a general line when the exact wording is unknown. */
export const ERROR_CODE_TEXT: Readonly<Record<string, Text>> = {
  UNAUTHENTICATED: ERROR_TEXT["Please sign in to continue."],
  FORBIDDEN: ERROR_TEXT["You do not have access to do that."],
  INSUFFICIENT_BALANCE: ERROR_TEXT["Insufficient wallet balance. Please recharge your wallet."],
  OUT_OF_STOCK: ERROR_TEXT["This product is currently unavailable online."],
  PAYMENT_VERIFICATION_FAILED: ERROR_TEXT["We could not verify this payment."],
  RATE_LIMITED: L(
    "Too many tries. Please wait a little and try again.",
    "बहुत ज़्यादा कोशिशें हुईं। थोड़ा रुककर फिर कोशिश करें।",
    "खूप प्रयत्न झाले. थोडे थांबून पुन्हा प्रयत्न करा.",
  ),
  INTERNAL: ERROR_TEXT["Something went wrong. Please try again."],
};

function fill(template: string, groups: readonly (string | undefined)[]): string {
  return template.replace(/\$(\d)/g, (_, n: string) => groups[Number(n)] ?? "");
}

/**
 * The error to show, in the visitor's language. English (or an unknown
 * message with no fallback code) is returned exactly as received.
 */
export function errorText(message: string | null | undefined, lang: Lang, code?: string | null): string {
  const msg = (message ?? "").trim();
  if (lang === "en") return message ?? "";
  const exact = ERROR_TEXT[msg];
  if (exact) return tr(exact, lang);
  for (const { re, text } of ERROR_PATTERNS) {
    const m = re.exec(msg);
    if (m) return fill(tr(text, lang), m);
  }
  const byCode = code ? ERROR_CODE_TEXT[code] : undefined;
  if (byCode) return tr(byCode, lang);
  return message ?? "";
}
