/** Rider growth pages (Refer & Earn, tier, My Slots, My Zone): English, Hindi, Marathi. */
import { L } from "@/lib/board/i18n";

export const RG = {
  notApproved: L(
    "This opens once your delivery partner account is approved.",
    "डिलीवरी पार्टनर खाता मंज़ूर होने के बाद यह खुलेगा।",
    "डिलिव्हरी पार्टनर खाते मंजूर झाल्यावर हे सुरू होईल.",
  ),
  off: L("This is not switched on yet.", "यह अभी चालू नहीं है।", "हे अजून सुरू नाही."),
  back: L("Back to my deliveries", "मेरी डिलीवरी पर वापस", "माझ्या डिलिव्हऱ्यांवर परत"),

  /* Refer & Earn */
  referTitle: L("Refer & Earn", "रेफ़र करें और कमाएँ", "रेफर करा आणि कमवा"),
  referIntro: L(
    "Invite friends to deliver with GoKesari. You earn a reward when they finish their first deliveries.",
    "दोस्तों को GoKesari के साथ डिलीवरी के लिए बुलाएँ। उनकी शुरुआती डिलीवरी पूरी होने पर आपको इनाम मिलेगा।",
    "मित्रांना GoKesari सोबत डिलिव्हरीसाठी बोलवा. त्यांच्या सुरुवातीच्या डिलिव्हऱ्या पूर्ण झाल्यावर तुम्हाला बक्षीस मिळेल.",
  ),
  yourCode: L("Your code", "आपका कोड", "तुमचा कोड"),
  copyLink: L("Copy link", "लिंक कॉपी करें", "लिंक कॉपी करा"),
  copied: L("Copied", "कॉपी हो गया", "कॉपी झाले"),
  shareWhatsApp: L("Share on WhatsApp", "WhatsApp पर भेजें", "WhatsApp वर पाठवा"),
  shareMessage: L(
    "Deliver with GoKesari and earn on your own time. Sign up with my code {code}: {link}",
    "GoKesari के साथ डिलीवरी करें और अपने समय पर कमाएँ। मेरे कोड {code} से साइन अप करें: {link}",
    "GoKesari सोबत डिलिव्हरी करा आणि तुमच्या वेळेनुसार कमवा. माझा कोड {code} वापरून नोंदणी करा: {link}",
  ),
  howItWorks: L("How it works", "यह कैसे काम करता है", "हे कसे चालते"),
  step1: L("Share your code or link with a friend.", "अपना कोड या लिंक दोस्त को भेजें।", "तुमचा कोड किंवा लिंक मित्राला पाठवा."),
  step2: L(
    "They register as a delivery partner with your code and get approved.",
    "वे आपके कोड से डिलीवरी पार्टनर के रूप में पंजीकरण करें और मंज़ूर हों।",
    "ते तुमचा कोड वापरून डिलिव्हरी पार्टनर म्हणून नोंदणी करतात आणि मंजूर होतात.",
  ),
  step3: L(
    "When they complete {n} deliveries within {d} days of approval, you get {amount} with your next payout.",
    "मंज़ूरी के {d} दिनों के भीतर {n} डिलीवरी पूरी होने पर आपको अगले भुगतान में {amount} मिलेंगे।",
    "मंजुरीनंतर {d} दिवसांत {n} डिलिव्हऱ्या पूर्ण झाल्या की पुढच्या पेमेंटमध्ये तुम्हाला {amount} मिळतील.",
  ),
  termsFixed: L(
    "The terms shown when your friend signs up stay fixed for that referral.",
    "दोस्त के साइन अप के समय की शर्तें उस रेफ़रल के लिए तय रहती हैं।",
    "मित्राने नोंदणी केली तेव्हाच्या अटी त्या रेफरलसाठी कायम राहतात.",
  ),
  myReferrals: L("My referrals", "मेरे रेफ़रल", "माझे रेफरल"),
  noReferrals: L("No referrals yet. Share your code to start.", "अभी कोई रेफ़रल नहीं। शुरू करने के लिए अपना कोड भेजें।", "अजून रेफरल नाहीत. सुरुवात करण्यासाठी तुमचा कोड पाठवा."),
  earned: L("Earned so far", "अब तक कमाया", "आतापर्यंत कमावले"),
  deliveries: L("deliveries", "डिलीवरी", "डिलिव्हऱ्या"),
  daysLeft: L("days left", "दिन बाकी", "दिवस बाकी"),
  reward: L("Reward", "इनाम", "बक्षीस"),
  statusPending: L("In progress", "जारी", "चालू"),
  statusWaiting: L("Waiting for approval", "मंज़ूरी का इंतज़ार", "मंजुरीची प्रतीक्षा"),
  statusQualified: L("Reward earned", "इनाम मिला", "बक्षीस मिळाले"),
  statusExpired: L("Time ran out", "समय समाप्त", "वेळ संपली"),

  /* Tier */
  tierTitle: L("My tier", "मेरा टियर", "माझा टियर"),
  tierIntro: L(
    "Your tier is worked out from your last 7 days. Keep delivering on time to move up.",
    "आपका टियर पिछले 7 दिनों से तय होता है। ऊपर जाने के लिए समय पर डिलीवरी करते रहें।",
    "तुमचा टियर मागील 7 दिवसांवरून ठरतो. वर जाण्यासाठी वेळेवर डिलिव्हरी करत राहा.",
  ),
  noTier: L("No tier yet", "अभी कोई टियर नहीं", "अजून टियर नाही"),
  extraIncentive: L("extra incentive", "अतिरिक्त प्रोत्साहन", "अतिरिक्त प्रोत्साहन"),
  priorityPerk: L("Gets orders first", "ऑर्डर पहले मिलते हैं", "ऑर्डर आधी मिळतात"),
  last7: L("Last 7 days", "पिछले 7 दिन", "मागील 7 दिवस"),
  mDeliveries: L("Deliveries", "डिलीवरी", "डिलिव्हऱ्या"),
  mRating: L("Rating", "रेटिंग", "रेटिंग"),
  mAcceptance: L("Acceptance", "स्वीकृति", "स्वीकार"),
  mOnTime: L("On time", "समय पर", "वेळेवर"),
  nextTier: L("To reach {name}", "{name} तक पहुँचने के लिए", "{name} गाठण्यासाठी"),
  nextReady: L("You meet every minimum for {name}.", "आप {name} की हर शर्त पूरी करते हैं।", "तुम्ही {name} च्या सर्व अटी पूर्ण करता."),
  topTier: L("You are on the top tier. Well done!", "आप सबसे ऊँचे टियर पर हैं। बहुत बढ़िया!", "तुम्ही सर्वोच्च टियरवर आहात. छान!"),
  allTiers: L("All tiers", "सभी टियर", "सर्व टियर"),
  noData: L("No offers yet — counts as 100%", "अभी कोई ऑफ़र नहीं — 100% गिना जाता है", "अजून ऑफर नाही — 100% धरले जाते"),
  more: L("more", "और", "अजून"),

  /* Slots */
  slotsTitle: L("My Slots", "मेरे स्लॉट", "माझे स्लॉट"),
  slotsIntro: L(
    "Optional — booked and online riders get orders first in that slot. You can still go online any time.",
    "वैकल्पिक — बुक करके ऑनलाइन रहने वाले राइडर को उस स्लॉट में ऑर्डर पहले मिलते हैं। आप कभी भी ऑनलाइन हो सकते हैं।",
    "ऐच्छिक — बुक करून ऑनलाइन असलेल्या रायडरना त्या स्लॉटमध्ये ऑर्डर आधी मिळतात. तुम्ही कधीही ऑनलाइन येऊ शकता.",
  ),
  cancelRule: L(
    "You can cancel up to {m} minutes before a slot starts.",
    "स्लॉट शुरू होने से {m} मिनट पहले तक रद्द कर सकते हैं।",
    "स्लॉट सुरू होण्याच्या {m} मिनिटे आधीपर्यंत रद्द करता येते.",
  ),
  book: L("Book", "बुक करें", "बुक करा"),
  booking: L("Booking…", "बुक हो रहा है…", "बुक होत आहे…"),
  cancel: L("Cancel", "रद्द करें", "रद्द करा"),
  cancelling: L("Cancelling…", "रद्द हो रहा है…", "रद्द होत आहे…"),
  booked: L("Booked", "बुक है", "बुक केले"),
  full: L("Full", "भरा हुआ", "भरले"),
  spots: L("booked", "बुक", "बुक"),
  noSlots: L("No slots to book this day.", "इस दिन बुक करने के लिए कोई स्लॉट नहीं।", "या दिवशी बुक करण्यासाठी स्लॉट नाही."),
  normalPay: L("Normal pay", "सामान्य भुगतान", "नेहमीचे पेमेंट"),
  today: L("Today", "आज", "आज"),
  tomorrow: L("Tomorrow", "कल", "उद्या"),
  tooLateToCancel: L("Too late to cancel", "रद्द करने में देर हो गई", "रद्द करायला उशीर झाला"),

  /* Zone */
  zoneTitle: L("My Zone", "मेरा ज़ोन", "माझा झोन"),
  zoneIntro: L(
    "Where you work, the societies that list you and where orders are coming from right now.",
    "आप कहाँ काम करते हैं, कौन सी सोसाइटी आपको सूची में रखती हैं और अभी ऑर्डर कहाँ से आ रहे हैं।",
    "तुम्ही कुठे काम करता, कोणत्या सोसायट्या तुम्हाला यादीत ठेवतात आणि आत्ता ऑर्डर कुठून येत आहेत.",
  ),
  radius: L("Working radius", "काम का दायरा", "कामाची त्रिज्या"),
  centreLive: L("around your live location", "आपकी लाइव लोकेशन के आसपास", "तुमच्या लाइव्ह ठिकाणाभोवती"),
  centreRegistered: L("around your registered location", "आपकी पंजीकृत लोकेशन के आसपास", "तुमच्या नोंदणीकृत ठिकाणाभोवती"),
  noLocation: L(
    "We don't have your location yet. Go online once to share it.",
    "हमारे पास अभी आपकी लोकेशन नहीं है। साझा करने के लिए एक बार ऑनलाइन हों।",
    "आमच्याकडे अजून तुमचे ठिकाण नाही. ते शेअर करण्यासाठी एकदा ऑनलाइन या.",
  ),
  surgeNow: L("Surge now", "अभी सर्ज", "आत्ता सर्ज"),
  until: L("until", "तक", "पर्यंत"),
  hotspots: L("Busy areas (last {m} min)", "व्यस्त इलाके (पिछले {m} मिनट)", "गर्दीचे भाग (मागील {m} मिनिटे)"),
  noHotspots: L("No orders near you in the last hour.", "पिछले एक घंटे में आपके पास कोई ऑर्डर नहीं।", "मागील तासात तुमच्या जवळ ऑर्डर नाहीत."),
  orders: L("orders", "ऑर्डर", "ऑर्डर"),
  mySocieties: L("My societies", "मेरी सोसाइटी", "माझ्या सोसायट्या"),
  noSocieties: L("No society has listed you yet.", "अभी किसी सोसाइटी ने आपको सूची में नहीं रखा।", "अजून कोणत्याही सोसायटीने तुम्हाला यादीत ठेवलेले नाही."),
  km: L("km", "कि.मी.", "कि.मी."),
  mapNote: L(
    "Orange ring: your radius. Green: your societies. Red: busy areas (counts only).",
    "नारंगी घेरा: आपका दायरा। हरा: आपकी सोसाइटी। लाल: व्यस्त इलाके (केवल गिनती)।",
    "केशरी वर्तुळ: तुमची त्रिज्या. हिरवे: तुमच्या सोसायट्या. लाल: गर्दीचे भाग (फक्त संख्या).",
  ),
} as const;

/** Fills {placeholders}. */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
