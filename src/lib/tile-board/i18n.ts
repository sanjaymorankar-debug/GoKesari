/**
 * Languages of the Tile Board screens (the four role home screens).
 *
 * The board's own words — menu names, submenu names, buttons — are available
 * in English, Hindi and Marathi. Names that come from the database (shops,
 * products, places) are shown as they were entered.
 *
 * Pure data and pure functions: safe on the server and in the browser.
 */

export const LANGS = ["en", "hi", "mr"] as const;
export type Lang = (typeof LANGS)[number];

/** Remembers the chosen language for a year; read on the server for each page. */
export const LANG_COOKIE = "gk_lang";
export const LANG_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** What the header's three-way switch shows for each language. */
export const LANG_SHORT: Record<Lang, string> = { en: "EN", hi: "हिं", mr: "मरा" };
export const LANG_NAME: Record<Lang, string> = { en: "English", hi: "हिन्दी", mr: "मराठी" };

export function parseLang(raw: string | undefined | null): Lang {
  return (LANGS as readonly string[]).includes(raw ?? "") ? (raw as Lang) : "en";
}

/** One piece of text in all three languages. */
export type Label = Readonly<Record<Lang, string>>;

export function L(en: string, hi: string, mr: string): Label {
  return { en, hi, mr };
}

/** Fills `{name}` placeholders: fill("Cart · {n} items", { n: 3 }). */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}

/** 17,900 → "17.9k"; 128 → "128". Counts on tiles have very little room. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) {
    const k = Math.floor(n / 100) / 10;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  if (n < 10_000_000) return `${(Math.floor(n / 10_000) / 10).toFixed(1).replace(/\.0$/, "")}L`;
  return `${(Math.floor(n / 1_000_000) / 10).toFixed(1).replace(/\.0$/, "")}Cr`;
}

/** Words used by the board's frame and by more than one role. */
export const WORDS = {
  deliverTo: L("Deliver to", "डिलीवरी", "डिलिव्हरी"),
  chooseLocation: L("Choose location", "जगह चुनें", "ठिकाण निवडा"),
  language: L("Language", "भाषा", "भाषा"),
  notifications: L("Notifications", "सूचनाएँ", "सूचना"),
  account: L("Account", "खाता", "खाते"),
  signIn: L("Sign in", "साइन इन", "साइन इन"),
  signOut: L("Sign out", "साइन आउट", "साइन आउट"),
  actingAs: L("Acting as", "भूमिका", "भूमिका"),
  myProfile: L("My profile", "मेरी प्रोफ़ाइल", "माझी प्रोफाइल"),
  dashboard: L("Dashboard", "डैशबोर्ड", "डॅशबोर्ड"),
  doNow: L("Do now", "अभी करें", "आत्ता करा"),
  allClear: L("Nothing waiting — all clear", "कुछ बाकी नहीं — सब ठीक", "काही बाकी नाही — सर्व ठीक"),
  moreBelow: L("More details", "और जानकारी", "अधिक माहिती"),
  myShop: L("My shop", "मेरी दुकान", "माझे दुकान"),
  admin: L("Admin", "एडमिन", "ॲडमिन"),
  adminConsole: L("Admin console", "एडमिन कंसोल", "ॲडमिन कन्सोल"),
  operator: L("Operator", "ऑपरेटर", "ऑपरेटर"),
  operatorConsole: L("Operator console", "ऑपरेटर कंसोल", "ऑपरेटर कन्सोल"),
  customerHome: L("Home", "होम", "होम"),

  // Customer
  searchPlaceholder: L(
    "Search milk, bread, medicines or a shop…",
    "दूध, ब्रेड, दवाइयाँ या दुकान खोजें…",
    "दूध, ब्रेड, औषधे, दुकाने शोधा…",
  ),
  searchPlaceholderShort: L("Search milk, bread, shops…", "दूध, ब्रेड, दुकानें खोजें…", "दूध, ब्रेड, दुकाने शोधा…"),
  search: L("Search", "खोजें", "शोधा"),
  track: L("Track", "ट्रैक करें", "ट्रॅक करा"),
  change: L("Change", "बदलें", "बदला"),
  view: L("View", "देखें", "पहा"),
  cart: L("Cart", "कार्ट", "कार्ट"),
  cartItems: L("Cart · {n} items", "कार्ट · {n} वस्तुएँ", "कार्ट · {n} वस्तू"),
  cartOneItem: L("Cart · 1 item", "कार्ट · 1 वस्तु", "कार्ट · 1 वस्तू"),
  cartEmpty: L("Your cart is empty", "आपका कार्ट खाली है", "तुमचे कार्ट रिकामे आहे"),
  cartEmptyHint: L("Add items from a shop near you", "पास की दुकान से सामान जोड़ें", "जवळच्या दुकानातून वस्तू जोडा"),
  viewCart: L("View cart", "कार्ट देखें", "कार्ट पहा"),
  browseShops: L("Browse shops", "दुकानें देखें", "दुकाने पहा"),
  fromShops: L("From {shop}", "{shop} से", "{shop} कडून"),
  fromShopsMore: L("From {shop} +{n} shop", "{shop} +{n} दुकान से", "{shop} +{n} दुकान"),
  buyAgain: L("Buy again", "फिर से खरीदें", "पुन्हा खरेदी"),
  shopsNearYou: L("Shops near you", "आपके पास की दुकानें", "तुमच्या जवळची दुकाने"),
  add: L("Add", "जोड़ें", "जोडा"),
  added: L("Added", "जुड़ गया", "जोडले"),
  visit: L("Visit", "देखें", "पहा"),
  tomorrow: L("Tomorrow", "कल", "उद्या"),
  tomorrowLine: L("Tomorrow: {what}", "कल: {what}", "उद्या: {what}"),
  tomorrowMore: L("{what} +{n} more", "{what} +{n} और", "{what} +{n} आणखी"),
  fromWallet: L("{amount} from wallet", "वॉलेट से {amount}", "वॉलेटमधून {amount}"),
  changeBy: L("change by {time}", "{time} तक बदलें", "{time} पर्यंत बदला"),
  skipped: L("skipped", "छोड़ा गया", "वगळले"),
  orderStatusLine: L("{order} · {status}", "{order} · {status}", "{order} · {status}"),
  active: L("active", "चालू", "चालू"),
  allCategories: L("All {n}", "सभी {n}", "सर्व {n}"),
  allCategoriesPlain: L("All", "सभी", "सर्व"),
  signInToSee: L("Sign in to see yours", "अपना देखने के लिए साइन इन करें", "तुमचे पाहण्यासाठी साइन इन करा"),
  openTill: L("open now", "अभी खुली", "आता उघडी"),
  lastPaid: L("Last paid {amount} · {date}", "पिछला भुगतान {amount} · {date}", "शेवटचे पेमेंट {amount} · {date}"),

  // Order statuses, as the customer banner says them
  stPlaced: L("placed", "ऑर्डर मिल गया", "ऑर्डर मिळाली"),
  stAccepted: L("accepted by the shop", "दुकान ने स्वीकार किया", "दुकानाने स्वीकारली"),
  stPreparing: L("being packed", "पैक हो रहा है", "पॅक होत आहे"),
  stReady: L("ready", "तैयार", "तयार"),
  stAssigned: L("rider assigned", "राइडर तय", "रायडर ठरला"),
  stPickedUp: L("picked up", "उठा लिया गया", "उचलली"),
  stOut: L("out for delivery", "डिलीवरी के लिए निकला", "डिलिव्हरीसाठी निघाली"),
  rider: L("Rider {name}", "राइडर {name}", "रायडर {name}"),

  // Operator alerts
  lateOrders: L("{n} orders need attention", "{n} ऑर्डर पर ध्यान दें", "{n} ऑर्डरकडे लक्ष द्या"),
  lateOrdersSub: L("{n} critical · operations exceptions", "{n} गंभीर · ऑपरेशन अपवाद", "{n} गंभीर · ऑपरेशन अपवाद"),
  fix: L("Fix", "ठीक करें", "दुरुस्त करा"),
  escalated: L("{n} escalated disputes", "{n} एस्केलेटेड विवाद", "{n} एस्कलेटेड वाद"),
  escalatedSub: L("Waiting at level 2", "लेवल 2 पर प्रतीक्षा में", "लेव्हल 2 वर प्रतीक्षेत"),
  open: L("Open", "खोलें", "उघडा"),
  onDuty: L("{n} on duty", "{n} ड्यूटी पर", "{n} ड्युटीवर"),
} as const;

export type WordKey = keyof typeof WORDS;
