/**
 * GoKesari Seller Central — how the shop owner's sixteen menus
 * (SHOP_MENUS in src/lib/board/menus.ts, still the single source of every
 * link, label, icon, badge and permission) are grouped in the seller
 * portal's sidebar and on its home page.
 *
 * Grouped the way sellers think about their business (the model Amazon
 * Seller Central uses: Orders, Catalogue, Payments, Growth, Account), so a
 * function is found by the job it does rather than by scanning sixteen tiles.
 *
 * Pure data: no server or database imports, so unit tests can check that
 * every shop menu sits in exactly one group.
 */
import { L, type Text } from "@/lib/board/i18n";
import type { ResolvedMenu } from "@/lib/board/menus";

export interface SellerNavGroup {
  key: string;
  label: Text;
  /** Keys into SHOP_MENUS, in the order they show. */
  menus: readonly string[];
}

export const SELLER_NAV_GROUPS: readonly SellerNavGroup[] = [
  { key: "orders", label: L("Orders", "ऑर्डर", "ऑर्डर"), menus: ["orders", "returns", "disputes", "delivery"] },
  { key: "catalogue", label: L("Catalogue", "कैटलॉग", "कॅटलॉग"), menus: ["inventory", "prices", "photos", "productCategories"] },
  { key: "payments", label: L("Payments", "भुगतान", "पेमेंट"), menus: ["finance", "wallet", "payout"] },
  { key: "growth", label: L("Growth", "बढ़त", "वाढ"), menus: ["marketing", "offers", "analytics"] },
  { key: "account", label: L("Account", "खाता", "खाते"), menus: ["myShop", "legal"] },
];

export interface ResolvedSellerGroup {
  key: string;
  label: Text;
  menus: ResolvedMenu[];
}

/** The groups with the menus this user may see; a group left empty is dropped. */
export function groupSellerMenus(menus: readonly ResolvedMenu[]): ResolvedSellerGroup[] {
  const byKey = new Map(menus.map((m) => [m.key, m]));
  return SELLER_NAV_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    menus: g.menus.map((k) => byKey.get(k)).filter((m): m is ResolvedMenu => m !== undefined),
  })).filter((g) => g.menus.length > 0);
}

/** Seller Central wording, in the three board languages. */
export const SELLER_TEXT = {
  sellerCentral: L("Seller Central", "सेलर सेंट्रल", "सेलर सेंट्रल"),
  home: L("Home", "होम", "होम"),
  openMenu: L("Open menu", "मेनू खोलें", "मेनू उघडा"),
  closeMenu: L("Close menu", "मेनू बंद करें", "मेनू बंद करा"),
  sellerMenu: L("Seller menu", "सेलर मेनू", "सेलर मेनू"),
  findTool: L("Find a tool…", "टूल खोजें…", "साधन शोधा…"),
  findToolLabel: L("Find a Seller Central tool", "सेलर सेंट्रल टूल खोजें", "सेलर सेंट्रल साधन शोधा"),
  noToolFound: L("No tool matches", "कोई टूल नहीं मिला", "कोणतेही साधन सापडले नाही"),
  visitStore: L("View my store", "मेरी दुकान देखें", "माझे दुकान पहा"),
  shopOnGoKesari: L("Shop on GoKesari", "GoKesari पर खरीदें", "GoKesari वर खरेदी करा"),
  help: L("Seller help", "सेलर सहायता", "सेलर मदत"),
  sellerTerms: L("Seller terms", "विक्रेता शर्तें", "विक्रेता अटी"),
  // Shop status pill
  live: L("Live", "चालू", "चालू"),
  pending: L("Pending approval", "मंज़ूरी बाकी", "मंजुरी बाकी"),
  suspended: L("Suspended", "निलंबित", "निलंबित"),
  rejected: L("Rejected", "अस्वीकृत", "नाकारले"),
  inactive: L("Inactive", "निष्क्रिय", "निष्क्रिय"),
  // Home page
  greeting: L("Welcome back", "फिर से स्वागत है", "पुन्हा स्वागत"),
  actionRequired: L("Action required", "ज़रूरी काम", "आवश्यक कृती"),
  allCaughtUp: L("All caught up — nothing needs your attention.", "सब ठीक है — कुछ बाकी नहीं।", "सर्व ठीक — काहीही बाकी नाही."),
  todaysOrders: L("Orders to work on", "काम वाले ऑर्डर", "कामाच्या ऑर्डर"),
  newOrders: L("New", "नए", "नवीन"),
  packing: L("Packing", "पैकिंग", "पॅकिंग"),
  ready: L("Ready", "तैयार", "तयार"),
  out: L("Out for delivery", "रास्ते में", "रवाना"),
  viewAll: L("View all", "सभी देखें", "सर्व पहा"),
  attention: L("Needs a look", "ध्यान दें", "लक्ष द्या"),
  walletBalance: L("Shop wallet", "दुकान वॉलेट", "दुकान वॉलेट"),
  lowStock: L("Low stock", "कम स्टॉक", "कमी साठा"),
  returnRequests: L("Return requests", "वापसी अनुरोध", "परतावा विनंत्या"),
  openDisputes: L("Open disputes", "खुले विवाद", "उघडे वाद"),
  priceRequests: L("Price requests", "दाम अनुरोध", "दर विनंत्या"),
  performance: L("Performance — last 30 days", "प्रदर्शन — पिछले 30 दिन", "कामगिरी — मागील 30 दिवस"),
  sales: L("Sales", "बिक्री", "विक्री"),
  ordersPlaced: L("Orders", "ऑर्डर", "ऑर्डर"),
  delivered: L("Delivered", "डिलीवर", "पोहोचले"),
  fillRate: L("Fill rate", "पूर्ति दर", "पूर्तता दर"),
  onTime: L("On time", "समय पर", "वेळेवर"),
  cancelled: L("Cancelled", "रद्द", "रद्द"),
  repeatCustomers: L("Repeat customers", "दोबारा ग्राहक", "पुन्हा येणारे ग्राहक"),
  fullAnalytics: L("Full analytics", "पूरा विश्लेषण", "संपूर्ण विश्लेषण"),
  accountHealth: L("Account health", "खाते की सेहत", "खात्याचे आरोग्य"),
  shopVerified: L("Shop verification", "दुकान सत्यापन", "दुकान पडताळणी"),
  bankVerified: L("Payout bank", "पेआउट बैंक", "पेआउट बँक"),
  legalDocs: L("Legal documents", "कानूनी दस्तावेज़", "कायदेशीर कागदपत्रे"),
  ok: L("Good", "ठीक", "ठीक"),
  needsAction: L("Needs action", "काम बाकी", "कृती आवश्यक"),
  allTools: L("All seller tools", "सभी सेलर टूल", "सर्व सेलर साधने"),
} as const satisfies Record<string, Text>;

/** Status pill text and colours for the shop's current status. */
export function shopStatusPill(status: string): { label: Text; className: string } {
  switch (status) {
    case "APPROVED":
      return { label: SELLER_TEXT.live, className: "bg-leaf-100 text-leaf-700" };
    case "PENDING_APPROVAL":
      return { label: SELLER_TEXT.pending, className: "bg-amber-100 text-amber-800" };
    case "SUSPENDED":
      return { label: SELLER_TEXT.suspended, className: "bg-red-100 text-red-800" };
    case "REJECTED":
      return { label: SELLER_TEXT.rejected, className: "bg-red-100 text-red-800" };
    default:
      return { label: SELLER_TEXT.inactive, className: "bg-slate-100 text-slate-700" };
  }
}
