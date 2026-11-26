/**
 * docs/hindi-marathi-2026-11 (staging E2E 25-Nov-2026): wallet entry types and the stored English
 * descriptions shown in the reader's language. Descriptions are saved in English when the money moves;
 * the known patterns below are translated on display, keeping order numbers, shop names and reasons as
 * they are. Anything else is shown unchanged. Client-safe.
 */
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";

const TYPE_TEXT: Record<string, Text> = {
  TOP_UP: L("top up", "टॉप-अप", "टॉप-अप"),
  PRODUCT_PURCHASE: L("product purchase", "ख़रीदारी", "खरेदी"),
  SUBSCRIPTION_DEDUCTION: L("subscription deduction", "सब्सक्रिप्शन कटौती", "सबस्क्रिप्शन कपात"),
  REFUND: L("refund", "रिफ़ंड", "परतावा"),
  PROMOTIONAL_CREDIT: L("promotional credit", "प्रमोशनल क्रेडिट", "प्रमोशनल क्रेडिट"),
  MANUAL_CREDIT: L("manual credit", "मैन्युअल क्रेडिट", "मॅन्युअल क्रेडिट"),
  MANUAL_DEBIT: L("manual debit", "मैन्युअल कटौती", "मॅन्युअल कपात"),
  REVERSAL: L("reversal", "वापसी", "उलट नोंद"),
};

export function walletTypeText(type: string, lang: Lang): string {
  const text = TYPE_TEXT[type];
  return text ? tr(text, lang) : type.replace(/_/g, " ").toLowerCase();
}

/** Hindi and Marathi for a matched description (English is the stored text itself). */
type Pattern = { re: RegExp; text: (m: RegExpMatchArray) => { hi: string; mr: string } };

const PATTERNS: Pattern[] = [
  {
    re: /^Refund for cancelled order (\S+)$/,
    text: (m) => ({ hi: `रद्द ऑर्डर ${m[1]} का रिफ़ंड`, mr: `रद्द ऑर्डर ${m[1]} चा परतावा` }),
  },
  {
    re: /^Refund for cash order (\S+): ([\s\S]*)$/,
    text: (m) => ({ hi: `कैश ऑर्डर ${m[1]} का रिफ़ंड: ${m[2]}`, mr: `रोख ऑर्डर ${m[1]} चा परतावा: ${m[2]}` }),
  },
  {
    re: /^Refund for order (\S+): ([\s\S]*)$/,
    text: (m) => ({ hi: `ऑर्डर ${m[1]} का रिफ़ंड: ${m[2]}`, mr: `ऑर्डर ${m[1]} चा परतावा: ${m[2]}` }),
  },
  {
    re: /^Delivery fee refund: order (\S+) is collected from the shop$/,
    text: (m) => ({ hi: `डिलीवरी फ़ीस वापस: ऑर्डर ${m[1]} दुकान से लिया गया`, mr: `डिलिव्हरी फी परत: ऑर्डर ${m[1]} दुकानातून घेतली` }),
  },
  {
    re: /^Refund sent to your bank \((.*?)\)([\s\S]*)$/,
    text: (m) => ({ hi: `रिफ़ंड आपके बैंक में भेजा गया (${m[1]})${m[2]}`, mr: `परतावा तुमच्या बँकेत पाठवला (${m[1]})${m[2]}` }),
  },
  { re: /^Voucher bonus \((.*)\)$/, text: (m) => ({ hi: `वाउचर बोनस (${m[1]})`, mr: `व्हाउचर बोनस (${m[1]})` }) },
  { re: /^Wallet top-up([\s\S]*)$/, text: (m) => ({ hi: `वॉलेट टॉप-अप${m[1]}`, mr: `वॉलेट टॉप-अप${m[1]}` }) },
  { re: /^Subscription delivery([\s\S]*)$/, text: (m) => ({ hi: `सब्सक्रिप्शन डिलीवरी${m[1]}`, mr: `सबस्क्रिप्शन डिलिव्हरी${m[1]}` }) },
  { re: /^Order (\S+)( — [\s\S]*)?$/, text: (m) => ({ hi: `ऑर्डर ${m[1]}${m[2] ?? ""}`, mr: `ऑर्डर ${m[1]}${m[2] ?? ""}` }) },
];

export function walletDescriptionText(description: string, lang: Lang): string {
  if (lang === "en" || !description) return description;
  for (const { re, text } of PATTERNS) {
    const m = description.match(re);
    if (m) return text(m)[lang] || description;
  }
  return description;
}
