/**
 * Wording for the product-discovery home page and its chrome
 * (docs/homepage-uiux-2026-10): header search, account menu and drawer,
 * bottom navigation, hero banners, home sections, empty states and the
 * organised footer — in English, Hindi and Marathi.
 *
 * Pure data, no server imports (shared by server and client components and
 * unit tests). Fixed board wording stays in lib/board/i18n.ts (UI).
 */
import { L } from "@/lib/board/i18n";

export const HOME = {
  // Header search (F2)
  searchPlaceholder: L("Search for milk, bread, or medicines…", "दूध, ब्रेड या दवाइयाँ खोजें…", "दूध, ब्रेड किंवा औषधे शोधा…"),
  searchLabel: L("Search products, shops and categories", "उत्पाद, दुकानें और श्रेणियाँ खोजें", "उत्पादने, दुकाने आणि वर्ग शोधा"),
  products: L("Products", "उत्पाद", "उत्पादने"),
  shops: L("Shops", "दुकानें", "दुकाने"),
  categories: L("Categories", "श्रेणियाँ", "वर्ग"),
  recentSearches: L("Recent searches", "हाल की खोजें", "अलीकडील शोध"),
  trending: L("Trending", "ट्रेंडिंग", "ट्रेंडिंग"),
  clear: L("Clear", "साफ़ करें", "साफ करा"),
  voiceSearch: L("Search by voice", "बोलकर खोजें", "बोलून शोधा"),
  listening: L("Listening… say what you need", "सुन रहे हैं… बोलिए क्या चाहिए", "ऐकत आहे… काय हवे ते सांगा"),
  voiceFailed: L("Couldn't hear that — try again or type", "सुनाई नहीं दिया — फिर बोलें या लिखें", "ऐकू आले नाही — पुन्हा बोला किंवा टाइप करा"),
  searchFor: L("Search for", "खोजें", "शोधा"),
  nearYou: L("near you", "आपके पास", "तुमच्या जवळ"),
  atShops: L("shops", "दुकानें", "दुकाने"),
  atShop: L("shop", "दुकान", "दुकान"),
  submitSearch: L("Search", "खोजें", "शोधा"),
  suggestionsLabel: L("Suggestions", "सुझाव", "सूचना"),

  // Account menu, drawer, bottom navigation (F1, F6)
  account: L("Account", "खाता", "खाते"),
  signInOrCreate: L("Sign in / Create account", "साइन इन / खाता बनाएँ", "साइन इन / खाते तयार करा"),
  signInPitch: L(
    "Sign in to see your orders, subscriptions and wallet.",
    "अपने ऑर्डर, सब्सक्रिप्शन और वॉलेट देखने के लिए साइन इन करें।",
    "तुमच्या ऑर्डर, सदस्यता आणि वॉलेट पाहण्यासाठी साइन इन करा.",
  ),
  openMenu: L("Open menu", "मेनू खोलें", "मेनू उघडा"),
  closeMenu: L("Close menu", "मेनू बंद करें", "मेनू बंद करा"),
  mainNav: L("Main navigation", "मुख्य नेविगेशन", "मुख्य नेव्हिगेशन"),
  home: L("Home", "होम", "होम"),
  compare: L("Compare", "तुलना", "तुलना"),
  orders: L("Orders", "ऑर्डर", "ऑर्डर"),
  explore: L("Explore", "देखें", "पहा"),
  myProfile: L("My profile", "मेरी प्रोफ़ाइल", "माझे प्रोफाइल"),
  cartWithCount: L("Cart", "कार्ट", "कार्ट"),

  // Hero banners (F1)
  offers: L("Offers and news", "ऑफ़र और खबरें", "ऑफर आणि बातम्या"),
  previousSlide: L("Previous banner", "पिछला बैनर", "मागील बॅनर"),
  nextSlide: L("Next banner", "अगला बैनर", "पुढील बॅनर"),
  pauseSlides: L("Pause banners", "बैनर रोकें", "बॅनर थांबवा"),
  playSlides: L("Play banners", "बैनर चलाएँ", "बॅनर सुरू करा"),
  slide: L("Banner", "बैनर", "बॅनर"),
  of: L("of", "में से", "पैकी"),

  // Home sections
  shopByCategory: L("Shop by category", "श्रेणी से खरीदें", "वर्गानुसार खरेदी"),
  allCategories: L("All categories", "सभी श्रेणियाँ", "सर्व वर्ग"),
  shopsNearYou: L("Shops near you", "आपके पास की दुकानें", "तुमच्या जवळची दुकाने"),
  shopsOnGoKesari: L("Shops on GoKesari", "GoKesari पर दुकानें", "GoKesari वरील दुकाने"),
  seeAll: L("See all", "सभी देखें", "सर्व पहा"),
  setLocationPrompt: L(
    "Set your location to see shops that deliver to you.",
    "अपनी लोकेशन चुनें और देखें कौन-सी दुकानें आप तक डिलीवर करती हैं।",
    "तुमचे ठिकाण निवडा आणि तुमच्यापर्यंत डिलिव्हरी करणारी दुकाने पाहा.",
  ),
  setLocation: L("Set location", "लोकेशन चुनें", "ठिकाण निवडा"),
  noShopsNearby: L(
    "No shops near this location yet. Try another PIN code, or see every shop.",
    "इस जगह के पास अभी कोई दुकान नहीं। दूसरा पिन कोड आज़माएँ या सभी दुकानें देखें।",
    "या ठिकाणाजवळ अजून दुकान नाही. दुसरा पिन कोड वापरा किंवा सर्व दुकाने पाहा.",
  ),
  smartTool: L("Smart tool", "स्मार्ट टूल", "स्मार्ट टूल"),
  shopFilters: L("Shop filters", "दुकान फ़िल्टर", "दुकान फिल्टर"),
  popularInArea: L("Popular in your area", "आपके इलाके में लोकप्रिय", "तुमच्या भागात लोकप्रिय"),
  popularInCity: L("Popular in your city", "आपके शहर में लोकप्रिय", "तुमच्या शहरात लोकप्रिय"),
  popularOnGoKesari: L("Popular on GoKesari", "GoKesari पर लोकप्रिय", "GoKesari वर लोकप्रिय"),
  freshPicks: L("Fresh picks near you", "आपके पास ताज़ा चीज़ें", "तुमच्या जवळ ताज्या वस्तू"),
  popularEmpty: L(
    "Popular items appear here once shops near you start selling online.",
    "आपके पास की दुकानें ऑनलाइन बेचना शुरू करेंगी तो लोकप्रिय चीज़ें यहाँ दिखेंगी।",
    "जवळची दुकाने ऑनलाइन विक्री सुरू करतील तेव्हा लोकप्रिय वस्तू इथे दिसतील.",
  ),
  comparePricesN: L("Compare {n} prices", "{n} दाम मिलाएँ", "{n} दर तुलना करा"),
  boughtTimes: L("ordered {n}×", "{n}× ऑर्डर", "{n}× ऑर्डर"),
  sellTitle: L("Sell on GoKesari", "GoKesari पर बेचें", "GoKesari वर विका"),
  sellText: L(
    "Take your shop online and reach customers nearby — orders, payments and delivery in one place.",
    "अपनी दुकान ऑनलाइन लाएँ और पास के ग्राहकों तक पहुँचें — ऑर्डर, भुगतान और डिलीवरी एक जगह।",
    "तुमचे दुकान ऑनलाइन आणा आणि जवळच्या ग्राहकांपर्यंत पोहोचा — ऑर्डर, पेमेंट आणि डिलिव्हरी एकाच ठिकाणी.",
  ),
  deliverTitle: L("Become a Delivery Partner", "डिलीवरी पार्टनर बनें", "डिलिव्हरी पार्टनर व्हा"),
  deliverText: L(
    "Earn on your own time, delivering in your own area.",
    "अपने समय पर, अपने इलाके में डिलीवरी करके कमाएँ।",
    "तुमच्या वेळेत, तुमच्या भागात डिलिव्हरी करून कमवा.",
  ),
  getStarted: L("Get started", "शुरू करें", "सुरू करा"),
  applyNow: L("Apply now", "अभी आवेदन करें", "आता अर्ज करा"),

  // Empty states (F3)
  cartEmptyTitle: L("Your cart is empty", "आपका कार्ट खाली है", "तुमचे कार्ट रिकामे आहे"),
  cartEmptyText: L(
    "Fresh milk, bread and daily needs from shops near you are a tap away.",
    "पास की दुकानों से ताज़ा दूध, ब्रेड और रोज़ की ज़रूरतें बस एक टैप दूर।",
    "जवळच्या दुकानांतून ताजे दूध, ब्रेड आणि रोजच्या गरजा फक्त एका टॅपवर.",
  ),
  startShopping: L("Start shopping", "खरीदारी शुरू करें", "खरेदी सुरू करा"),
  exploreBestsellers: L("Explore bestsellers", "बेस्टसेलर देखें", "बेस्टसेलर पहा"),
  ordersEmptyTitle: L("No orders yet", "अभी कोई ऑर्डर नहीं", "अजून ऑर्डर नाही"),
  ordersEmptyText: L(
    "Your orders, their live tracking and delivery codes will show here.",
    "आपके ऑर्डर, लाइव ट्रैकिंग और डिलीवरी कोड यहाँ दिखेंगे।",
    "तुमच्या ऑर्डर, लाइव्ह ट्रॅकिंग आणि डिलिव्हरी कोड इथे दिसतील.",
  ),
  subscriptionsEmptyTitle: L("No subscriptions yet", "अभी कोई सब्सक्रिप्शन नहीं", "अजून सदस्यता नाही"),
  subscriptionsEmptyText: L(
    "Get milk and daily needs delivered every morning — pause or change any day.",
    "दूध और रोज़ की चीज़ें हर सुबह घर पर पाएँ — किसी भी दिन रोकें या बदलें।",
    "दूध आणि रोजच्या वस्तू दररोज सकाळी घरपोच मिळवा — कोणत्याही दिवशी थांबवा किंवा बदला.",
  ),
  findDairy: L("Find a dairy", "डेयरी खोजें", "डेअरी शोधा"),
  walletEmptyTitle: L("No wallet activity yet", "अभी वॉलेट में कोई लेन-देन नहीं", "अजून वॉलेटमध्ये व्यवहार नाही"),
  walletEmptyText: L(
    "Add money once and pay for orders and subscriptions in one tap.",
    "एक बार पैसे जोड़ें और ऑर्डर व सब्सक्रिप्शन का भुगतान एक टैप में करें।",
    "एकदा पैसे भरा आणि ऑर्डर व सदस्यतेचे पेमेंट एका टॅपमध्ये करा.",
  ),
  addMoney: L("Add money", "पैसे जोड़ें", "पैसे भरा"),
  searchEmptyTitle: L("Nothing found for", "इसके लिए कुछ नहीं मिला:", "यासाठी काही सापडले नाही:"),
  searchEmptyText: L(
    "Try another word, a shop name or a PIN code — or browse what's near you.",
    "कोई दूसरा शब्द, दुकान का नाम या पिन कोड आज़माएँ — या पास की चीज़ें देखें।",
    "दुसरा शब्द, दुकानाचे नाव किंवा पिन कोड वापरा — किंवा जवळचे पाहा.",
  ),
  browseCategories: L("Browse categories", "श्रेणियाँ देखें", "वर्ग पहा"),
  seeShopsNearYou: L("See shops near you", "पास की दुकानें देखें", "जवळची दुकाने पहा"),
  searchStartTitle: L("What are you looking for?", "आप क्या खोज रहे हैं?", "तुम्ही काय शोधत आहात?"),
  searchStartText: L(
    "Search for a product, a shop, an area or a PIN code.",
    "कोई उत्पाद, दुकान, इलाका या पिन कोड खोजें।",
    "उत्पादन, दुकान, भाग किंवा पिन कोड शोधा.",
  ),

  // Compare (F4)
  bestPrice: L("Best price", "सबसे अच्छा दाम", "सर्वोत्तम दर"),
  saveVsHighest: L("Save {amount} vs the highest price", "सबसे ऊँचे दाम से {amount} बचाएँ", "सर्वात जास्त दरापेक्षा {amount} वाचवा"),
  comparePageTitle: L("Compare prices near you", "आपके पास के दाम मिलाएँ", "तुमच्या जवळचे दर तुलना करा"),
  comparePageText: L(
    "The same product at different shops near your delivery location.",
    "आपकी डिलीवरी लोकेशन के पास की अलग-अलग दुकानों पर एक ही उत्पाद।",
    "तुमच्या डिलिव्हरी ठिकाणाजवळच्या वेगवेगळ्या दुकानांतील तेच उत्पादन.",
  ),
  compareAllProducts: L("Compare more products", "और उत्पादों की तुलना", "अधिक उत्पादनांची तुलना"),

  // "Deliver to" bottom sheet (F6)
  deliverTo: L("Deliver to", "डिलीवरी", "डिलिव्हरी"),
  chooseDeliveryLocation: L("Choose a delivery location", "डिलीवरी की जगह चुनें", "डिलिव्हरीचे ठिकाण निवडा"),
  useCurrentLocation: L("Use my current location", "मेरी अभी की लोकेशन लें", "माझे सध्याचे ठिकाण वापरा"),
  locating: L("Finding you…", "आपकी लोकेशन ढूँढ रहे हैं…", "तुमचे ठिकाण शोधत आहे…"),
  savedAddresses: L("Saved addresses", "सहेजे गए पते", "जतन केलेले पत्ते"),
  enterPincode: L("Enter a PIN code", "पिन कोड डालें", "पिन कोड टाका"),
  usePincode: L("Use PIN", "पिन लगाएँ", "पिन वापरा"),
  pincode: L("PIN code", "पिन कोड", "पिन कोड"),
  close: L("Close", "बंद करें", "बंद करा"),
  clearLocation: L("Clear location", "लोकेशन हटाएँ", "ठिकाण काढा"),
  manageAddresses: L("Manage addresses", "पते संभालें", "पत्ते व्यवस्थापित करा"),
  noGeolocation: L(
    "This device can't share its location — enter a PIN code instead.",
    "यह डिवाइस लोकेशन नहीं दे सकता — पिन कोड डालें।",
    "हे डिव्हाइस ठिकाण देऊ शकत नाही — पिन कोड टाका.",
  ),
  locationDenied: L(
    "Location permission was not given — enter a PIN code instead.",
    "लोकेशन की अनुमति नहीं मिली — पिन कोड डालें।",
    "ठिकाणाची परवानगी मिळाली नाही — पिन कोड टाका.",
  ),
  locationFailed: L("That location could not be used.", "यह लोकेशन इस्तेमाल नहीं हो सकी।", "हे ठिकाण वापरता आले नाही."),

  // Footer (F5)
  footerCompany: L("Company", "कंपनी", "कंपनी"),
  footerMakeMoney: L("Make Money", "कमाई करें", "कमाई करा"),
  footerSupport: L("Support", "सहायता", "मदत"),
  footerLegal: L("Legal", "कानूनी", "कायदेशीर"),
  aboutUs: L("About Us", "हमारे बारे में", "आमच्याबद्दल"),
  contactUs: L("Contact Us", "संपर्क करें", "संपर्क करा"),
  sellOnGoKesari: L("Sell on GoKesari", "GoKesari पर बेचें", "GoKesari वर विका"),
  becomeDeliveryPartner: L("Become a Delivery Partner", "डिलीवरी पार्टनर बनें", "डिलिव्हरी पार्टनर व्हा"),
  sellerTerms: L("Seller Terms", "विक्रेता शर्तें", "विक्रेता अटी"),
  help: L("Help", "मदद", "मदत"),
  fileComplaint: L("File a Complaint", "शिकायत दर्ज करें", "तक्रार नोंदवा"),
  grievanceRedressal: L("Grievance Redressal", "शिकायत निवारण", "तक्रार निवारण"),
  privacyPolicy: L("Privacy Policy", "गोपनीयता नीति", "गोपनीयता धोरण"),
  terms: L("Terms & Conditions", "नियम और शर्तें", "नियम व अटी"),
  refundPolicy: L("Refund & Cancellation Policy", "रिफ़ंड और रद्दीकरण नीति", "परतावा व रद्द करण्याचे धोरण"),
  shippingPolicy: L("Shipping & Delivery", "शिपिंग और डिलीवरी", "शिपिंग व डिलिव्हरी"),
  cookiePolicy: L("Cookie Policy", "कुकी नीति", "कुकी धोरण"),
  subscriptionTerms: L("Subscription Terms", "सब्सक्रिप्शन शर्तें", "सदस्यता अटी"),
  walletTerms: L("Wallet Terms", "वॉलेट शर्तें", "वॉलेट अटी"),
  voucherTerms: L("Voucher Terms", "वाउचर शर्तें", "व्हाउचर अटी"),
} as const;

/** Fills "{n}" / "{amount}" placeholders. */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}
