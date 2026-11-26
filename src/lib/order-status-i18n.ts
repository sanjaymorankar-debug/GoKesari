/**
 * docs/hindi-marathi-2026-11 (staging E2E 25-Nov-2026): customer-facing words that were still English on
 * My orders — order status badges, the delivery way and slot line, the order card's codes and "Report a
 * problem". Client-safe (no server imports).
 */
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";

/** Order statuses as the customer reads them. Unknown statuses fall back to the old lower-case text. */
export const ORDER_STATUS_TEXT: Record<string, Text> = {
  PENDING: L("pending", "लंबित", "प्रलंबित"),
  CONFIRMED: L("confirmed", "पक्का हुआ", "निश्चित"),
  ACCEPTED: L("accepted", "स्वीकार हुआ", "स्वीकारली"),
  PREPARING: L("preparing", "तैयार हो रहा है", "तयार होत आहे"),
  PICKED: L("packed", "पैक हुआ", "पॅक झाली"),
  READY: L("ready", "तैयार", "तयार"),
  ASSIGNED: L("rider assigned", "राइडर तय हुआ", "रायडर ठरला"),
  PICKED_UP: L("picked up", "उठा लिया", "उचलली"),
  OUT_FOR_DELIVERY: L("out for delivery", "डिलीवरी के लिए निकला", "डिलिव्हरीसाठी निघाली"),
  DELIVERED: L("delivered", "डिलीवर हुआ", "पोहोचली"),
  CANCELLED: L("cancelled", "रद्द", "रद्द"),
  PAYMENT_FAILED: L("payment failed", "भुगतान असफल", "पेमेंट अयशस्वी"),
  WALLET_INSUFFICIENT: L("wallet balance too low", "वॉलेट में पैसे कम", "वॉलेटमध्ये रक्कम कमी"),
  REFUND_PENDING: L("refund pending", "रिफ़ंड बाकी", "परतावा प्रलंबित"),
  REFUNDED: L("refunded", "रिफ़ंड हुआ", "परतावा झाला"),
  FAILED: L("failed", "असफल", "अयशस्वी"),
  RETURNED: L("returned", "लौटाया गया", "परत केली"),
  DISPUTED: L("disputed", "विवाद में", "वादात"),
  SUBSTITUTION_PROPOSED: L("replacement suggested", "बदला हुआ सामान सुझाया", "बदली सुचवली"),
};

export function orderStatusText(status: string, lang: Lang): string {
  const text = ORDER_STATUS_TEXT[status];
  return text ? tr(text, lang) : status.replace(/_/g, " ").toLowerCase();
}

/** How the order arrives (lib/fulfilment-options FULFILMENT_OPTION_LABELS, in three languages). */
export const FULFILMENT_OPTION_TEXT: Record<"PICKUP" | "SHOP_DELIVERY" | "GOKESARI_PARTNER", Text> = {
  PICKUP: L("Pickup from the shop", "दुकान से लें", "दुकानातून घ्या"),
  SHOP_DELIVERY: L("Shop's own delivery", "दुकान की अपनी डिलीवरी", "दुकानाची स्वतःची डिलिव्हरी"),
  GOKESARI_PARTNER: L("GoKesari delivery partner", "GoKesari डिलीवरी पार्टनर", "GoKesari डिलिव्हरी पार्टनर"),
};

const WEEKDAY_TEXT: Record<string, Text> = {
  Sun: L("Sun", "रवि", "रवि"),
  Mon: L("Mon", "सोम", "सोम"),
  Tue: L("Tue", "मंगल", "मंगळ"),
  Wed: L("Wed", "बुध", "बुध"),
  Thu: L("Thu", "गुरु", "गुरु"),
  Fri: L("Fri", "शुक्र", "शुक्र"),
  Sat: L("Sat", "शनि", "शनि"),
};
const MONTH_TEXT: Record<string, Text> = {
  Jan: L("Jan", "जन॰", "जाने."),
  Feb: L("Feb", "फ़र॰", "फेब्रु."),
  Mar: L("Mar", "मार्च", "मार्च"),
  Apr: L("Apr", "अप्रैल", "एप्रिल"),
  May: L("May", "मई", "मे"),
  Jun: L("Jun", "जून", "जून"),
  Jul: L("Jul", "जुलाई", "जुलै"),
  Aug: L("Aug", "अग॰", "ऑग."),
  Sep: L("Sep", "सित॰", "सप्टें."),
  Oct: L("Oct", "अक्तू॰", "ऑक्टो."),
  Nov: L("Nov", "नव॰", "नोव्हें."),
  Dec: L("Dec", "दिस॰", "डिसें."),
};
const AM = L("am", "सुबह", "सकाळी");
const PM = L("pm", "शाम", "दुपारनंतर");

/**
 * A slot line made by lib/scheduled-slots formatScheduledSlot ("Wed 25 Nov, 3–4 pm") in the reader's
 * language. English is returned unchanged; other text passes through untouched.
 */
export function localizeSlotText(text: string, lang: Lang): string {
  if (lang === "en" || !text) return text;
  return text.replace(/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|am|pm)\b/g, (word) => {
    if (word === "am") return tr(AM, lang);
    if (word === "pm") return tr(PM, lang);
    return tr(WEEKDAY_TEXT[word] ?? MONTH_TEXT[word], lang);
  });
}

/** Order card (components/order-fulfilment-card) and Report a problem (components/rating-actions). */
export const ORDER_CARD = {
  updated: L("(updated)", "(बदला गया)", "(बदलले)"),
  collectFrom: L("Collect from:", "यहाँ से लें:", "येथून घ्या:"),
  feeBackA: L("No delivery for this order: your", "इस ऑर्डर की डिलीवरी नहीं होगी: आपकी", "या ऑर्डरची डिलिव्हरी नाही: तुमची"),
  feeBackB: L("delivery fee was given back.", "डिलीवरी फ़ीस लौटा दी गई।", "डिलिव्हरी फी परत दिली."),
  pickupCode: L("Pickup code:", "पिकअप कोड:", "पिकअप कोड:"),
  pickupHint: L(
    "Show this at the shop when you collect your order — not before.",
    "ऑर्डर लेते समय ही दुकान पर यह दिखाएँ — पहले नहीं।",
    "ऑर्डर घेताना दुकानात हा दाखवा — आधी नाही.",
  ),
  locked: L(
    "Too many wrong delivery codes were entered, so this delivery is on hold. Our support team will contact you.",
    "बहुत बार ग़लत डिलीवरी कोड डाला गया, इसलिए यह डिलीवरी रोकी गई है। हमारी सपोर्ट टीम आपसे संपर्क करेगी।",
    "खूप वेळा चुकीचा डिलिव्हरी कोड टाकला गेला, म्हणून ही डिलिव्हरी थांबवली आहे. आमची सपोर्ट टीम तुमच्याशी संपर्क करेल.",
  ),
  newCodeA: L("Delivery code:", "डिलीवरी कोड:", "डिलिव्हरी कोड:"),
  newCodeB: L(
    "— give it to the delivery person only when you receive your order. Your earlier code no longer works.",
    "— ऑर्डर मिलने पर ही डिलीवरी करने वाले को दें। पुराना कोड अब काम नहीं करेगा।",
    "— ऑर्डर मिळाल्यावरच डिलिव्हरी करणाऱ्याला द्या. आधीचा कोड आता चालणार नाही.",
  ),
  emailedA: L("Your delivery code was emailed to", "आपका डिलीवरी कोड ई-मेल किया गया:", "तुमचा डिलिव्हरी कोड ई-मेल केला:"),
  emailedB: L(
    "Give it to the delivery person only when you receive your order.",
    "ऑर्डर मिलने पर ही डिलीवरी करने वाले को दें।",
    "ऑर्डर मिळाल्यावरच डिलिव्हरी करणाऱ्याला द्या.",
  ),
  sending: L("Sending…", "भेज रहे हैं…", "पाठवत आहोत…"),
  another: L("Get another code", "एक और कोड लें", "आणखी एक कोड घ्या"),
  newCode: L("Get a new code", "नया कोड लें", "नवीन कोड घ्या"),
  codeFailed: L("Could not get a new code.", "नया कोड नहीं मिल सका।", "नवीन कोड मिळाला नाही."),
  report: L("Report a problem", "समस्या बताएँ", "समस्या कळवा"),
  problemType: L("Problem type", "समस्या का प्रकार", "समस्येचा प्रकार"),
  product: L("Wrong / damaged / missing item", "ग़लत / टूटा / कम सामान", "चुकीची / खराब / कमी वस्तू"),
  delivery: L("Delivery problem", "डिलीवरी की समस्या", "डिलिव्हरीची समस्या"),
  payment: L("Payment or refund", "भुगतान या रिफ़ंड", "पेमेंट किंवा परतावा"),
  describe: L("Describe the problem", "समस्या बताएँ", "समस्या सांगा"),
  placeholder: L("What went wrong? (at least 10 characters)", "क्या गड़बड़ हुई? (कम से कम 10 अक्षर)", "काय चुकले? (किमान 10 अक्षरे)"),
  send: L("Send", "भेजें", "पाठवा"),
  cancel: L("Cancel", "रद्द करें", "रद्द करा"),
  sendFailed: L("Could not send your report.", "आपकी शिकायत नहीं भेजी जा सकी।", "तुमची तक्रार पाठवता आली नाही."),
  reportedA: L("Reported — ticket", "शिकायत दर्ज — टिकट", "तक्रार नोंदवली — तिकीट"),
  reportedB: L("We will get back to you.", "हम आपसे संपर्क करेंगे।", "आम्ही तुमच्याशी संपर्क करू."),
} as const;
