/** docs/guest-checkout-2026-11: customer-facing words of guest checkout, tracking and the best-shop panel. */
import { L } from "@/lib/board/i18n";

export const GC = {
  title: L("Checkout as a guest", "मेहमान के रूप में चेकआउट", "पाहुणे म्हणून चेकआउट"),
  intro: L(
    "No password and no sign-up form. We send a one-time code to check it is you.",
    "कोई पासवर्ड या साइन-अप फ़ॉर्म नहीं। आपकी पहचान के लिए हम एक बार का कोड भेजते हैं।",
    "पासवर्ड किंवा नोंदणी फॉर्म नाही. तुमची ओळख तपासण्यासाठी आम्ही एकदाच वापरायचा कोड पाठवतो.",
  ),
  name: L("Your name", "आपका नाम", "तुमचे नाव"),
  mobile: L("Mobile number", "मोबाइल नंबर", "मोबाइल नंबर"),
  email: L("Email", "ईमेल", "ईमेल"),
  address: L("Delivery address", "डिलीवरी पता", "डिलिव्हरीचा पत्ता"),
  line1: L("House / flat, street", "मकान / फ्लैट, गली", "घर / फ्लॅट, रस्ता"),
  area: L("Area", "इलाका", "परिसर"),
  city: L("City", "शहर", "शहर"),
  pincode: L("PIN code", "पिन कोड", "पिन कोड"),
  sendCode: L("Send code", "कोड भेजें", "कोड पाठवा"),
  emailCode: L("Code from your email", "ईमेल में आया कोड", "ईमेलमधील कोड"),
  mobileCode: L("Code from SMS", "SMS में आया कोड", "SMS मधील कोड"),
  verify: L("Verify and continue to payment", "पुष्टि करें और भुगतान पर जाएँ", "खात्री करा आणि पेमेंटकडे जा"),
  codeSent: L("We sent a code to", "हमने कोड भेजा है", "आम्ही कोड पाठवला आहे"),
  orSignIn: L("Have an account? Sign in instead", "खाता है? साइन इन करें", "खाते आहे? साइन इन करा"),
  bestShop: L("Best shop for this cart", "इस कार्ट के लिए सबसे अच्छी दुकान", "या कार्टसाठी सर्वोत्तम दुकान"),
  move: L("Move my cart to this shop", "मेरा कार्ट इस दुकान पर ले जाएँ", "माझा कार्ट या दुकानात हलवा"),
  trackTitle: L("Track your order", "अपना ऑर्डर ट्रैक करें", "तुमची ऑर्डर ट्रॅक करा"),
} as const;
