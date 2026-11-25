/**
 * Wording for brand search, barcode search and favourites (docs/search-brand-barcode-favourites-2026-11),
 * in English, Hindi and Marathi. Pure data, shared by server and client components.
 */
import { L } from "@/lib/board/i18n";

export const BBF = {
  // Search box: brands group and barcode scan
  brands: L("Brands", "ब्रांड", "ब्रँड"),
  brandProducts: L("products", "उत्पाद", "उत्पादने"),
  scanBarcode: L("Scan a barcode", "बारकोड स्कैन करें", "बारकोड स्कॅन करा"),
  scanTitle: L("Find a product by its barcode", "बारकोड से उत्पाद खोजें", "बारकोडने उत्पादन शोधा"),
  scanHelp: L(
    "Point the camera at the barcode on the pack, or type the number printed under it.",
    "पैक पर बने बारकोड पर कैमरा रखें, या उसके नीचे छपा नंबर लिखें।",
    "पाकिटावरील बारकोडवर कॅमेरा धरा, किंवा त्याखाली छापलेला क्रमांक टाइप करा.",
  ),
  looking: L("Looking it up…", "खोज रहे हैं…", "शोधत आहे…"),
  noMatch: L(
    "No product with this barcode is on GoKesari yet. Try searching by name.",
    "इस बारकोड वाला कोई उत्पाद अभी GoKesari पर नहीं है। नाम से खोजें।",
    "या बारकोडचे उत्पादन अजून GoKesari वर नाही. नावाने शोधा.",
  ),
  severalMatches: L("Several products share this barcode — pick yours.", "इस बारकोड के कई उत्पाद हैं — अपना चुनें।", "या बारकोडची अनेक उत्पादने आहेत — तुमचे निवडा."),
  scanAgain: L("Scan another", "दूसरा स्कैन करें", "दुसरा स्कॅन करा"),
  close: L("Close", "बंद करें", "बंद करा"),
  mrp: L("MRP", "एमआरपी", "एमआरपी"),
  from: L("from", "से", "पासून"),
  shopsNearYou: L("shops near you", "आपके पास की दुकानें", "तुमच्या जवळची दुकाने"),
  notNearYou: L("Not sold near you yet", "अभी आपके पास नहीं बिकता", "अजून तुमच्या जवळ विकले जात नाही"),
  notSold: L("Not sold on GoKesari yet", "अभी GoKesari पर नहीं बिकता", "अजून GoKesari वर विकले जात नाही"),
  viewProduct: L("See prices", "दाम देखें", "दर पाहा"),
  lookupFailed: L("Could not look that up. Check your connection and try again.", "खोज नहीं पाए। इंटरनेट जाँचें और फिर कोशिश करें।", "शोधता आले नाही. इंटरनेट तपासा आणि पुन्हा प्रयत्न करा."),

  // Favourites
  favourites: L("Favourites", "पसंदीदा", "आवडती"),
  addFavourite: L("Add to favourites", "पसंदीदा में जोड़ें", "आवडत्यांमध्ये जोडा"),
  removeFavourite: L("Remove from favourites", "पसंदीदा से हटाएँ", "आवडत्यांमधून काढा"),
  favouritesIntro: L(
    "Products you saved with the heart, with the lowest price near you.",
    "दिल से सहेजे गए उत्पाद, आपके पास के सबसे कम दाम के साथ।",
    "हृदयाने जतन केलेली उत्पादने, तुमच्या जवळच्या सर्वात कमी दरासह.",
  ),
  favouritesEmptyTitle: L("No favourites yet", "अभी कोई पसंदीदा नहीं", "अजून आवडती नाहीत"),
  favouritesEmptyText: L(
    "Tap the heart on any product to keep it here.",
    "किसी भी उत्पाद पर दिल दबाएँ, वह यहाँ रहेगा।",
    "कोणत्याही उत्पादनावरील हृदयावर टॅप करा, ते इथे राहील.",
  ),
  guestNote: L(
    "Saved in this browser. Sign in to keep them on your account.",
    "इस ब्राउज़र में सहेजे गए। खाते में रखने के लिए साइन इन करें।",
    "या ब्राउझरमध्ये जतन. खात्यात ठेवण्यासाठी साइन इन करा.",
  ),
  lowestNearYou: L("Lowest near you", "आपके पास सबसे कम", "तुमच्या जवळ सर्वात कमी"),
  lowestPrice: L("Lowest price", "सबसे कम दाम", "सर्वात कमी दर"),
  shops: L("shops", "दुकानें", "दुकाने"),
  outOfStock: L("Out of stock everywhere now", "अभी हर जगह खत्म", "सध्या सगळीकडे संपले"),
  inShopOnly: L("In-shop price only", "केवल दुकान में", "फक्त दुकानात"),
  goneText: L("No longer sold", "अब नहीं बिकता", "आता विकले जात नाही"),
  addToCart: L("Add to cart", "कार्ट में डालें", "कार्टमध्ये टाका"),
  added: L("Added", "जोड़ा गया", "जोडले"),
  remove: L("Remove", "हटाएँ", "काढा"),
  browse: L("Browse products", "उत्पाद देखें", "उत्पादने पाहा"),

  // Brand page and filter
  brandProductsTitle: L("Products of this brand", "इस ब्रांड के उत्पाद", "या ब्रँडची उत्पादने"),
  brandEmpty: L("No shop near you sells this brand right now.", "अभी आपके पास कोई दुकान यह ब्रांड नहीं बेचती।", "सध्या तुमच्या जवळ कोणतेही दुकान हा ब्रँड विकत नाही."),
  onlyBrand: L("Only", "केवल", "फक्त"),
  allBrands: L("All brands", "सभी ब्रांड", "सर्व ब्रँड"),
  brandPage: L("Brand page", "ब्रांड पेज", "ब्रँड पान"),
} as const;
