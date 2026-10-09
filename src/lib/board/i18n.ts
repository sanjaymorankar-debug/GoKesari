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
  more: L("More", "और", "अधिक"),
  // Site header on every other page
  home: L("Home", "होम", "होम"),
  myBoard: L("My board", "मेरा बोर्ड", "माझा बोर्ड"),
  shopBoard: L("Shop board", "दुकान बोर्ड", "दुकान बोर्ड"),
  adminBoard: L("Admin board", "एडमिन बोर्ड", "ॲडमिन बोर्ड"),
  operatorBoard: L("Operator board", "ऑपरेटर बोर्ड", "ऑपरेटर बोर्ड"),
  riderHome: L("My deliveries", "मेरी डिलीवरी", "माझ्या डिलिव्हऱ्या"),
  shops: L("Shops", "दुकानें", "दुकाने"),
  orders: L("Orders", "ऑर्डर", "ऑर्डर"),
  subscriptions: L("Subscriptions", "सब्सक्रिप्शन", "सदस्यता"),
  wallet: L("Wallet", "वॉलेट", "वॉलेट"),
  search: L("Search", "खोजें", "शोधा"),
  back: L("Back", "वापस", "मागे"),
  shopsIHelp: L("Shops I help with", "जिन दुकानों में मदद करता हूँ", "मी मदत करतो ती दुकाने"),
  myReferralCode: L("My referral code", "मेरा रेफ़रल कोड", "माझा रेफरल कोड"),
  inviteFriends: L("Invite friends", "दोस्तों को बुलाएँ", "मित्रांना बोलवा"),
  walletBalance: L("Wallet balance", "वॉलेट बैलेंस", "वॉलेट शिल्लक"),
  // Menu pages (hubs)
  onYourBoard: L("On your board", "आपके बोर्ड पर", "तुमच्या बोर्डवर"),
  moreHere: L("More in this menu", "इस मेनू में और", "या मेनूमध्ये अधिक"),
  backToBoard: L("Back to board", "बोर्ड पर वापस", "बोर्डवर परत"),
  // Customer "Do now" on phones
  trackOrder: L("Track order", "ऑर्डर ट्रैक करें", "ऑर्डर ट्रॅक करा"),
  noOrderOnWay: L("No order on the way", "कोई ऑर्डर रास्ते में नहीं", "कोणतीही ऑर्डर वाटेत नाही"),
  tomorrowsDelivery: L("Tomorrow's delivery", "कल की डिलीवरी", "उद्याची डिलिव्हरी"),
  nothingTomorrow: L("Nothing tomorrow", "कल कुछ नहीं", "उद्या काही नाही"),
  applyInvite: L("Apply invite code", "आमंत्रण कोड लगाएँ", "आमंत्रण कोड लावा"),
  // Signed-out visitors
  runAShop: L("Sell on GoKesari", "GoKesari पर बेचें", "GoKesari वर विका"),
  deliverForUs: L("Deliver with us", "हमारे साथ डिलीवरी करें", "आमच्यासोबत डिलिव्हरी करा"),
  join: L("Join", "जुड़ें", "सामील व्हा"),
  // Shop owner account alerts
  shopSuspended: L("Shop suspended — new orders are off", "दुकान निलंबित — नए ऑर्डर बंद", "दुकान निलंबित — नवीन ऑर्डर बंद"),
  awaitingApproval: L("Awaiting approval", "मंज़ूरी बाकी", "मंजुरी बाकी"),
  registrationRejected: L("Registration rejected", "पंजीकरण अस्वीकृत", "नोंदणी नाकारली"),
  details: L("Details", "विवरण", "तपशील"),
  next: L("Next", "आगे", "पुढे"),
  fixNow: L("Fix now", "अभी ठीक करें", "आता दुरुस्त करा"),
  rechargeWallet: L("Shop wallet is low — recharge", "दुकान वॉलेट कम है — रिचार्ज करें", "दुकान वॉलेट कमी आहे — रिचार्ज करा"),
  legalDocsDue: L("Legal documents needed", "कानूनी दस्तावेज़ ज़रूरी", "कायदेशीर कागदपत्रे आवश्यक"),
  addPayoutBank: L("Add a verified payout bank account", "सत्यापित पेआउट बैंक खाता जोड़ें", "पडताळलेले पेआउट बँक खाते जोडा"),
  upload: L("Upload", "अपलोड", "अपलोड"),
  recharge: L("Recharge", "रिचार्ज", "रिचार्ज"),
  // Lists, pages and states
  all: L("All", "सभी", "सर्व"),
  done: L("Done", "पूरे", "पूर्ण"),
  page: L("Page", "पेज", "पान"),
  of: L("of", "में से", "पैकी"),
  previous: L("Previous", "पिछला", "मागील"),
  nextPage: L("Next", "अगला", "पुढील"),
  loading: L("Loading…", "लोड हो रहा है…", "लोड होत आहे…"),
  offline: L("You are offline. We will reconnect when the network is back.", "आप ऑफ़लाइन हैं। नेटवर्क आते ही फिर जुड़ेंगे।", "तुम्ही ऑफलाइन आहात. नेटवर्क आल्यावर पुन्हा जोडले जाईल."),
  backOnline: L("Back online", "फिर से ऑनलाइन", "पुन्हा ऑनलाइन"),
  errorTitle: L("Something went wrong on our side", "हमारी तरफ़ से कुछ गड़बड़ हुई", "आमच्याकडून काहीतरी चुकले"),
  errorText: L("Nothing you entered was lost. Try again, or go back to your board.", "आपकी भरी जानकारी सुरक्षित है। फिर कोशिश करें या बोर्ड पर लौटें।", "तुम्ही भरलेली माहिती सुरक्षित आहे. पुन्हा प्रयत्न करा किंवा बोर्डवर परत जा."),
  tryAgain: L("Try again", "फिर कोशिश करें", "पुन्हा प्रयत्न करा"),
  notFoundTitle: L("This page does not exist", "यह पेज मौजूद नहीं है", "हे पान अस्तित्वात नाही"),
  notFoundText: L("The link may be old. Your board has every function.", "लिंक पुराना हो सकता है। आपके बोर्ड पर हर काम है।", "लिंक जुनी असू शकते. तुमच्या बोर्डवर प्रत्येक काम आहे."),
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
