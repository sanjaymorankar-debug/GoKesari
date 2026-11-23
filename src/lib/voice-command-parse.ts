/**
 * A shop owner's spoken (or typed) price / offer command → what to change
 * (docs/smart-shopping-2026-11/FEATURE4_VOICE_PRICE_OFFERS.md):
 *
 *   "Amul Taaza 1 litre price 58 rupees"          → product "amul taaza 1 litre", price ₹58
 *   "अमूल ताजा किंमत अठ्ठावन्न रुपये करा"           → price ₹58
 *   "साखर 10 टक्के सूट रविवार पर्यंत"                → 10% off until Sunday
 *   "Parle G 2 rupees off for 3 days"              → ₹2 off each, 3 days
 *   "तेल 150 रुपये और 5 प्रतिशत छूट एक हफ्ता"        → price ₹150 and 5% off for a week
 *   "हो" / "हाँ" / "yes"                            → confirm
 *
 * Deterministic and client-safe, built on lib/price-stock-parse (regional digits, Marathi/Hindi
 * number words). The server asks AI (VOICE_COMMAND) only when this reader finds no change or no
 * product words. Pack sizes stay part of the product ("1 litre", "500 g"); a number next to a rupee
 * word, a price word or alone is money.
 */
import { numbersInTokens, RUPEE_WORDS, sellingUnitFromWord, tokenizeSpoken, type NumberAt } from "@/lib/price-stock-parse";

export type OfferUntil =
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "days"; days: number }
  | { kind: "weekday"; weekday: number }; // 0 = Sunday

export type SpokenOffer = { type: "PERCENT"; percent: number } | { type: "FLAT"; flatPaise: number };

export interface VoiceCommand {
  /** The words that name the product, pack size included ("amul taaza 1 litre"), or null. */
  productText: string | null;
  newPricePaise: number | null;
  offer: SpokenOffer | null;
  /** When the offer ends, as said; null = the default length. */
  until: OfferUntil | null;
  /** "buy 1 get 1", "free": offers of that kind are not supported (percent or rupees off only). */
  buyGetFree: boolean;
  /** A bare yes / no (the confirmation step). */
  confirm: "YES" | "NO" | null;
  /** A change was found (price, offer or a buy-get-free request to explain). */
  hasChange: boolean;
}

/* ------------------------------------------------------------ vocabulary */

const PERCENT_WORDS = new Set(["%", "percent", "percentage", "pc", "टक्के", "टक्का", "टक्क्यांनी", "टक्केवारी", "प्रतिशत", "परसेंट", "पर्सेंट", "फीसदी", "फ़ीसदी", "फीसद"]);
const DISCOUNT_WORDS = new Set([
  "off", "discount", "discounts", "less", "offer", "sale", "ऑफ", "ऑफर", "सूट", "सुट", "सवलत", "सवलतीत", "सवलतीने",
  "छूट", "छुट", "डिस्काउंट", "डिस्काऊंट", "डिस्कॉउंट", "कमी", "कम",
]);
const PRICE_WORDS = new Set(["kimat", "keemat", "bhav", "daam", "price", "rate", "selling", "किंमत", "किंमती", "किमत", "कीमत", "भाव", "दाम", "दर", "रेट", "प्राइस", "प्राईस", "विक्री"]);
const SET_WORDS = new Set([
  "करा", "करो", "कर", "करून", "करना", "कीजिए", "कीजिये", "करें", "करे", "करिए", "दो", "दे", "द्या", "ठेवा", "रखो", "रखें", "रख",
  "make", "set", "change", "update", "put", "keep", "to", "now", "अब", "आता", "नवीन", "नवी", "नई", "नया", "new", "से", "ते",
  "please", "प्लीज", "कृपया", "जी", "बदला", "बदलो", "बदल", "it", "its", "is", "be", "करायची", "करायचा",
  // Hindi / Marathi typed or recognised in Latin letters.
  "kar", "karo", "kardo", "karna", "karein", "kijiye", "do", "de", "dijiye", "ab", "aata", "naya", "nayi", "rakho", "kara",
]);
const UNTIL_WORDS = new Set(["till", "until", "upto", "up", "पर्यंत", "पर्यन्त", "पर्यंतच", "तक", "तोपर्यंत", "लागू", "for", "साठी", "के", "लिए", "लिये", "भर"]);
const GLUE_WORDS = new Set([
  ",", "and", "और", "आणि", "व", "of", "the", "on", "a", "an", "per", "each", "है", "हैं", "आहे", "आहेत", "का", "की", "ची", "चा", "चे", "ला", "पर", "वर", "में", "मध्ये",
  "with", "सोबत", "साथ", "only", "फक्त", "सिर्फ", "just", "ka", "ki", "ke", "cha", "chi", "che", "la", "hai", "aahe",
]);
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, रविवार: 0, इतवार: 0, रविवारी: 0,
  monday: 1, mon: 1, सोमवार: 1, सोमवारी: 1,
  tuesday: 2, tue: 2, मंगळवार: 2, मंगलवार: 2, मंगळवारी: 2,
  wednesday: 3, wed: 3, बुधवार: 3, बुधवारी: 3,
  thursday: 4, thu: 4, गुरुवार: 4, गुरूवार: 4, बृहस्पतिवार: 4, गुरुवारी: 4,
  friday: 5, fri: 5, शुक्रवार: 5, शुक्रवारी: 5,
  saturday: 6, sat: 6, शनिवार: 6, शनिवारी: 6,
};
const TODAY_WORDS = new Set(["today", "tonight", "आज", "आजच", "आजपर्यंत"]);
const TOMORROW_WORDS = new Set(["tomorrow", "उद्या", "उद्यापर्यंत", "कल"]);
const DAY_WORDS = new Set(["day", "days", "दिवस", "दिवसांसाठी", "दिवसांची", "दिवसासाठी", "दिन", "दिनों", "दिनो"]);
const WEEK_WORDS = new Set(["week", "weeks", "आठवडा", "आठवडे", "आठवड्यासाठी", "आठवडाभर", "हफ्ता", "हफ़्ता", "हफ्ते", "हफ़्ते", "सप्ताह", "वीक"]);
const MONTH_WORDS = new Set(["month", "months", "महिना", "महिने", "महिनाभर", "महिन्यासाठी", "महीना", "महीने", "मंथ"]);
const FREE_WORDS = new Set(["free", "फ्री", "फ़्री", "मुफ्त", "मुफ़्त", "मोफत", "bogo"]);
const YES_WORDS = new Set([
  "yes", "yeah", "yep", "ya", "haan", "han", "ha", "haa", "हाँ", "हां", "हा", "हो", "होय", "हौ", "ठीक", "ठिक", "ok", "okay", "okk", "ओके", "ओक",
  "confirm", "correct", "right", "बरोबर", "सही", "publish", "चालेल", "चलेगा", "chalega", "done", "जी", "ji", "आहे", "है", "बिलकुल", "बिल्कुल", "sure",
]);
const NO_WORDS = new Set(["no", "nope", "नहीं", "नही", "नाही", "नको", "cancel", "रद्द", "wrong", "गलत", "चुकीचे", "चुकीचं", "चूक", "mat", "मत", "थांबा", "रुको"]);

/** Marathi / Hindi case endings glued to the last product word: "ताजाची", "साखरेला", "तेलाचा". */
const PRODUCT_SUFFIXES = ["ची", "चा", "चे", "ला", "वर"];

function stripSuffix(word: string): string {
  if (!/[ऀ-ॿ]/.test(word)) return word;
  for (const s of PRODUCT_SUFFIXES) {
    if (word.length > s.length + 2 && word.endsWith(s)) return word.slice(0, -s.length);
  }
  return word;
}

const near = (tokens: string[], from: number, to: number, words: Set<string>) => {
  for (let k = Math.max(0, from); k < Math.min(tokens.length, to); k++) if (words.has(tokens[k])) return k;
  return -1;
};

/** Is the whole utterance a yes or a no? ("हो", "हो करा", "हाँ ठीक है", "no cancel") */
export function yesOrNo(text: string): "YES" | "NO" | null {
  const tokens = tokenizeSpoken(text).filter((t) => t !== "," && !SET_WORDS.has(t) && t !== "please");
  if (tokens.length === 0 || tokens.length > 4) return null;
  if (tokens.some((t) => NO_WORDS.has(t))) return tokens.every((t) => NO_WORDS.has(t) || YES_WORDS.has(t) || GLUE_WORDS.has(t)) ? "NO" : null;
  return tokens.every((t) => YES_WORDS.has(t) || GLUE_WORDS.has(t)) ? "YES" : null;
}

/* ------------------------------------------------------------ parse */

export function parseVoiceCommand(text: string): VoiceCommand {
  const clean = text.trim().slice(0, 500);
  const confirm = yesOrNo(clean);
  if (confirm) return { productText: null, newPricePaise: null, offer: null, until: null, buyGetFree: false, confirm, hasChange: false };

  const tokens = tokenizeSpoken(clean);
  const used = new Set<number>();
  const mark = (from: number, to: number) => {
    for (let k = from; k < to; k++) used.add(k);
  };
  let newPricePaise: number | null = null;
  let offer: SpokenOffer | null = null;
  let until: OfferUntil | null = null;

  const buyGetFree = tokens.some((t) => FREE_WORDS.has(t)) || (tokens.includes("buy") && tokens.includes("get"));
  const BOGO_BEFORE = new Set(["buy", "get", "खरीदें", "खरीदो", "घ्या", "लो", "ले", "पर", "वर", "on"]);
  const BOGO_AFTER = new Set([...FREE_WORDS, "पर", "वर", "on", "get"]);
  const nums: NumberAt[] = numbersInTokens(tokens);
  const money: NumberAt[] = [];
  for (const n of nums) {
    const next = tokens[n.end];
    const after2 = tokens[n.end + 1];
    // 10 % · 10 टक्के · 10 per cent
    if (next !== undefined && (PERCENT_WORDS.has(next) || (next === "per" && after2 === "cent"))) {
      if (!offer && n.value >= 1 && n.value <= 100) offer = { type: "PERCENT", percent: Math.round(n.value) };
      mark(n.start, n.end + (next === "per" ? 2 : 1));
      continue;
    }
    // 3 days · 2 हफ्ते · 1 महिना
    if (next !== undefined && (DAY_WORDS.has(next) || WEEK_WORDS.has(next) || MONTH_WORDS.has(next))) {
      const per = DAY_WORDS.has(next) ? 1 : WEEK_WORDS.has(next) ? 7 : 30;
      if (!until && n.value >= 1) until = { kind: "days", days: Math.min(365, Math.round(n.value * per)) };
      mark(n.start, n.end + 1);
      continue;
    }
    const rupeeBefore = n.start > 0 && RUPEE_WORDS.has(tokens[n.start - 1]);
    const rupeeAfter = next !== undefined && RUPEE_WORDS.has(next);
    // "buy 1 get 1 free", "1 पर 1 फ्री": counts, not money.
    if (buyGetFree && !rupeeBefore && !rupeeAfter && (BOGO_BEFORE.has(tokens[n.start - 1]) || (next !== undefined && BOGO_AFTER.has(next)))) {
      mark(n.start, n.end);
      continue;
    }
    // A pack size ("1 litre", "500 g", "5 kg") is part of the product, unless a rupee word says it is money.
    if (!rupeeBefore && !rupeeAfter && next !== undefined && sellingUnitFromWord(next)) continue;
    money.push(n);
  }

  for (const n of money) {
    const rupeeBefore = n.start > 0 && RUPEE_WORDS.has(tokens[n.start - 1]);
    const rupeeAfter = n.end < tokens.length && RUPEE_WORDS.has(tokens[n.end]);
    let end = n.end + (rupeeAfter ? 1 : 0);
    // "58 rupees per litre" / "58 रुपये किलो": the selling unit after the price belongs to the price.
    if (tokens[end] === "per" || tokens[end] === "प्रति") end++;
    if (end < tokens.length && sellingUnitFromWord(tokens[end]) && (rupeeAfter || rupeeBefore)) end++;
    const start = n.start - (rupeeBefore ? 1 : 0);
    const discountAt = near(tokens, end, end + 3, DISCOUNT_WORDS);
    const discountBefore = near(tokens, start - 2, start, DISCOUNT_WORDS);
    const paise = Math.round(n.value * 100);
    if ((discountAt !== -1 || discountBefore !== -1) && !offer) {
      if (paise > 0) offer = { type: "FLAT", flatPaise: paise };
      mark(start, end);
      if (discountAt !== -1) used.add(discountAt);
      continue;
    }
    if (newPricePaise === null && paise > 0) {
      newPricePaise = paise;
      mark(start, end);
    }
  }

  // Weekday / today / tomorrow / "a week" without a number.
  tokens.forEach((t, k) => {
    if (used.has(k)) return;
    if (WEEKDAYS[t] !== undefined) {
      if (!until) until = { kind: "weekday", weekday: WEEKDAYS[t] };
      used.add(k);
    } else if (TODAY_WORDS.has(t)) {
      if (!until) until = { kind: "today" };
      used.add(k);
    } else if (TOMORROW_WORDS.has(t)) {
      if (!until) until = { kind: "tomorrow" };
      used.add(k);
    } else if (WEEK_WORDS.has(t) || MONTH_WORDS.has(t)) {
      if (!until) until = { kind: "days", days: WEEK_WORDS.has(t) ? 7 : 30 };
      used.add(k);
    }
  });

  const productWords = tokens
    .filter(
      (t, k) =>
        !used.has(k) &&
        !RUPEE_WORDS.has(t) &&
        !PERCENT_WORDS.has(t) &&
        !DISCOUNT_WORDS.has(t) &&
        !PRICE_WORDS.has(t) &&
        !SET_WORDS.has(t) &&
        !UNTIL_WORDS.has(t) &&
        !GLUE_WORDS.has(t) &&
        !FREE_WORDS.has(t) &&
        !DAY_WORDS.has(t) &&
        t !== "buy" &&
        t !== "get",
    )
    .map(stripSuffix)
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
  const productText = productWords.length ? productWords.join(" ") : null;

  return {
    productText,
    newPricePaise,
    offer,
    until: offer ? until : null,
    buyGetFree,
    confirm: null,
    hasChange: newPricePaise !== null || offer !== null || buyGetFree,
  };
}

/* ------------------------------------------------------------ dates (IST) */

const IST_MS = 330 * 60_000;

/** The last millisecond of the IST calendar day `addDays` after `now`'s IST day. */
export function endOfIstDay(now: Date, addDays = 0): Date {
  const ist = new Date(now.getTime() + IST_MS);
  const end = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + addDays, 23, 59, 59, 999);
  return new Date(end - IST_MS);
}

/** When a spoken offer ends: the end of that IST day. Nothing said → `defaultDays` (today counts as day 1). */
export function offerEndsAt(until: OfferUntil | null, now: Date, defaultDays: number): Date {
  if (!until) return endOfIstDay(now, Math.max(1, defaultDays) - 1);
  switch (until.kind) {
    case "today":
      return endOfIstDay(now, 0);
    case "tomorrow":
      return endOfIstDay(now, 1);
    case "days":
      return endOfIstDay(now, Math.max(1, until.days) - 1);
    case "weekday": {
      const today = new Date(now.getTime() + IST_MS).getUTCDay();
      return endOfIstDay(now, (until.weekday - today + 7) % 7);
    }
  }
}
