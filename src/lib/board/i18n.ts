/**
 * Language for the Tile Board home screens (English, Hindi, Marathi).
 *
 * The choice lives in a plain cookie so the server renders the board in that
 * language on the first paint — no flash of English, no client-side lookup.
 * Only board labels are translated; names from the database (shops,
 * products, places) are shown as entered.
 *
 * No server or database imports: shared by server components, the language
 * switch and unit tests.
 */

export const LANGUAGES = ["en", "hi", "mr"] as const;
export type Lang = (typeof LANGUAGES)[number];

export const DEFAULT_LANG: Lang = "en";

/** Cookie holding the chosen language. */
export const LANG_COOKIE = "gk_lang";
/** One year: a language is a lasting preference, not a session setting. */
export const LANG_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** The switch's own labels — each language named in its own script. */
export const LANG_SWITCH_LABEL: Record<Lang, string> = { en: "EN", hi: "हिं", mr: "मरा" };
export const LANG_NAME: Record<Lang, string> = { en: "English", hi: "हिन्दी", mr: "मराठी" };

/** BCP 47 tag for the `lang` attribute, so screen readers pick the right voice. */
export const LANG_TAG: Record<Lang, string> = { en: "en-IN", hi: "hi-IN", mr: "mr-IN" };

/**
 * Reads a cookie or form value as a language. Anything unknown — missing,
 * empty, a tampered cookie, a different case or a full tag like "mr-IN" that
 * starts with a known code — falls back sensibly rather than throwing.
 */
export function parseLang(value: unknown): Lang {
  if (typeof value !== "string") return DEFAULT_LANG;
  const code = value.trim().toLowerCase().split(/[-_]/)[0];
  return (LANGUAGES as readonly string[]).includes(code) ? (code as Lang) : DEFAULT_LANG;
}

/** A label in all three languages. */
export type Text = Readonly<Record<Lang, string>>;

/** Picks a label's text in the given language; English when a translation is blank. */
export function tr(text: Text, lang: Lang): string {
  return text[lang] || text.en;
}

/** Shorthand for writing a three-language label. */
export const L = (en: string, hi: string, mr: string): Text => ({ en, hi, mr });

/**
 * Fixed wording used by the board chrome (header, banners, cart bar). Menu
 * and submenu labels live with the menus in lib/board/menus.ts. Marathi uses
 * the approved mockup's wording where it has one.
 */
export const UI = {
  deliverTo: L("Deliver to", "डिलीवरी", "डिलिव्हरी"),
  chooseLocation: L("Set location", "लोकेशन चुनें", "ठिकाण निवडा"),
  searchPlaceholder: L("Search milk, bread, medicines or a shop…", "दूध, ब्रेड, दवा या दुकान खोजें…", "दूध, ब्रेड, दुकाने शोधा…"),
  searchShort: L("Search milk, bread, shops…", "दूध, ब्रेड, दुकान खोजें…", "दूध, ब्रेड, दुकाने शोधा…"),
  searchLabel: L("Search products and shops", "उत्पाद और दुकानें खोजें", "उत्पादने आणि दुकाने शोधा"),
  notifications: L("Notifications", "सूचनाएँ", "सूचना"),
  unread: L("unread", "अपठित", "न वाचलेल्या"),
  account: L("Account menu", "खाता मेनू", "खाते मेनू"),
  myProfile: L("My profile", "मेरी प्रोफ़ाइल", "माझे प्रोफाइल"),
  actingAs: L("Acting as", "भूमिका", "भूमिका"),
  signIn: L("Sign in", "साइन इन", "साइन इन"),
  signOut: L("Sign out", "साइन आउट", "साइन आउट"),
  language: L("Language", "भाषा", "भाषा"),
  doNow: L("Do now", "अभी करें", "आता करा"),
  track: L("Track", "ट्रैक करें", "ट्रॅक करा"),
  change: L("Change", "बदलें", "बदला"),
  fix: L("Fix", "ठीक करें", "दुरुस्त करा"),
  open: L("Open", "खोलें", "उघडा"),
  cart: L("Cart", "कार्ट", "कार्ट"),
  items: L("items", "आइटम", "वस्तू"),
  item: L("item", "आइटम", "वस्तू"),
  viewCart: L("View cart", "कार्ट देखें", "कार्ट पहा"),
  cartEmpty: L("Your cart is empty", "आपका कार्ट खाली है", "तुमचे कार्ट रिकामे आहे"),
  fromShops: L("From", "से", "कडून"),
  moreShops: L("shop", "दुकान", "दुकान"),
  buyAgain: L("Buy again", "फिर से खरीदें", "पुन्हा घ्या"),
  buyAgainEmpty: L(
    "Items from your delivered orders will appear here.",
    "आपके डिलीवर हुए ऑर्डर की चीज़ें यहाँ दिखेंगी।",
    "तुमच्या पोहोचलेल्या ऑर्डरमधील वस्तू इथे दिसतील.",
  ),
  add: L("Add", "जोड़ें", "जोडा"),
  added: L("Added", "जुड़ गया", "जोडले"),
  verified: L("Verified", "सत्यापित", "पडताळलेले"),
  notVerified: L("Not verified", "सत्यापित नहीं", "पडताळलेले नाही"),
  tomorrow: L("Tomorrow", "कल", "उद्या"),
  fromWallet: L("from wallet", "वॉलेट से", "वॉलेटमधून"),
  changeBy: L("change by", "बदलें", "पर्यंत बदला"),
  orderLate: L("orders late over 15 min", "ऑर्डर 15 मिनट से ज़्यादा देर", "ऑर्डर 15 मिनिटांपेक्षा उशीर"),
  oldest: L("Oldest", "सबसे पुराना", "सर्वात जुनी"),
  ordersNeedAttention: L("orders need attention", "ऑर्डर पर ध्यान दें", "ऑर्डरकडे लक्ष द्या"),
  escalatedTickets: L("escalated tickets", "एस्केलेटेड टिकट", "एस्केलेट केलेली तिकिटे"),
  escalatedDisputes: L("Escalated disputes and overdue grievances", "एस्केलेटेड विवाद और लंबित शिकायतें", "एस्केलेट वाद आणि थकलेल्या तक्रारी"),
  active: L("active", "सक्रिय", "चालू"),
  onDuty: L("on duty", "ड्यूटी पर", "ड्युटीवर"),
  myShop: L("My shop", "मेरी दुकान", "माझे दुकान"),
  adminConsole: L("Admin console", "एडमिन कंसोल", "ॲडमिन कन्सोल"),
  operatorConsole: L("Operator console", "ऑपरेटर कंसोल", "ऑपरेटर कन्सोल"),
  admin: L("Admin", "एडमिन", "ॲडमिन"),
  operator: L("Operator", "ऑपरेटर", "ऑपरेटर"),
  orderStatus: L("Order", "ऑर्डर", "ऑर्डर"),
  signInToUse: L("Sign in to use", "उपयोग के लिए साइन इन करें", "वापरण्यासाठी साइन इन करा"),
  allCategories: L("All", "सभी", "सर्व"),
  board: L("Home menu", "होम मेनू", "होम मेनू"),
  lastPaid: L("Last paid", "पिछला भुगतान", "मागील पेमेंट"),
  shopsNear: L("shops near you", "आपके पास दुकानें", "तुमच्या जवळची दुकाने"),
  noActiveOrder: L("No order on the way", "कोई ऑर्डर रास्ते में नहीं", "कोणतीही ऑर्डर वाटेत नाही"),
  noSubscriptionTomorrow: L("Nothing scheduled for tomorrow", "कल के लिए कुछ तय नहीं", "उद्यासाठी काही ठरलेले नाही"),
  noAddress: L("No saved address yet", "अभी कोई पता सहेजा नहीं", "अजून पत्ता जतन केलेला नाही"),
  noPayments: L("No payments yet", "अभी कोई भुगतान नहीं", "अजून पेमेंट नाही"),
} as const satisfies Record<string, Text>;

/** Order status words for the banners, in each language. Unknown statuses show as-is. */
export const ORDER_STATUS_TEXT: Readonly<Record<string, Text>> = {
  CONFIRMED: L("confirmed", "पुष्टि हुई", "निश्चित"),
  ACCEPTED: L("accepted by the shop", "दुकान ने स्वीकारा", "दुकानाने स्वीकारली"),
  PREPARING: L("being packed", "पैक हो रहा है", "पॅक होत आहे"),
  READY: L("ready", "तैयार", "तयार"),
  ASSIGNED: L("rider assigned", "राइडर तय", "रायडर ठरला"),
  PICKED_UP: L("picked up", "उठा लिया गया", "उचलली"),
  OUT_FOR_DELIVERY: L("out for delivery", "डिलीवरी के लिए निकला", "डिलिव्हरीसाठी निघाली"),
};
