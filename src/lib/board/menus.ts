/**
 * Tile Board menus — one definition per role, the single source the four
 * home screens render from (approved design "Theme 1 Tile Board").
 *
 * Every entry names: its label in three languages, its icon, its link, the
 * live figure shown on its badge (if any) and the permission a role needs to
 * see it. Hiding an entry is a convenience; the page it links to keeps its
 * own server-side check.
 *
 * Links may hold `{placeholders}` filled from live data (a shop's slug, the
 * customer's active order). When a value is missing the entry falls back to
 * `fallbackHref`, or is hidden if it has none — never a broken link.
 *
 * Pure data and pure functions: no server or database imports, so unit tests
 * can check every link against the routes under src/app.
 */
import type { IconName } from "@/components/board/icons";
import { PERMISSIONS, can, type Permission } from "@/server/authz/permissions";
import type { UserRole } from "@/server/db/schema";

import { L, type Text } from "./i18n";

export type BoardRole = "customer" | "shop" | "admin" | "operator";

/** Colour family of a tile: the icon chip, accent and badge use it. */
export type Tone = "kesari" | "teal" | "blue" | "green" | "violet" | "pink" | "amber";

/** Live figures the counts service can read (src/server/services/board-counts.ts). */
export const COUNT_KEYS = [
  // customer
  "nearbyShops", "openNowShops", "deliveringShops", "activeOrders", "pastOrders", "openReturns",
  "activeSubscriptions", "shopCategories", "unread",
  // shop owner
  "shopActiveOrders", "shopNew", "shopPacking", "shopReady", "shopOut", "shopOpenReturns",
  "shopReturnRequests", "shopReturnPickups", "shopOpenDisputes", "shopLowStock", "shopPendingPhotos",
  "shopPriceRequests", "shopActiveOffers", "shopRiders",
  // admin & operator
  "pendingShops", "allShops", "sellerReviews", "activeSuspensions", "users", "customers", "owners",
  "riders", "staff", "shopCategoryCount", "productCategories", "products", "pendingProducts",
  "mrpCorrections", "refPricesToVerify", "pendingImages", "bankRefunds", "liveDisputes", "openReturnsAll",
  "openGrievances", "openRisk", "submittedCampaigns", "opsExceptions", "legalDocsToReview",
  "liveOrders", "ridersOnDuty", "riderApplications", "riderChanges", "societies", "societiesApplied",
  "societyMembers", "societyRiders", "activeVouchers", "voucherRedemptions", "openDisputes",
  "escalatedDisputes",
] as const;
export type CountKey = (typeof COUNT_KEYS)[number];
export type Counts = Partial<Record<CountKey, number>>;

/** Green-tick facts: shown only when the record is actually verified. */
export type TickKey = "bankVerified" | "shopVerified";

/** Values for `{placeholders}` in links. */
export type LinkParams = Partial<Record<"shopSlug" | "subscriptionId" | "activeOrderNumber", string>>;

export interface BoardItem {
  key: string;
  label: Text;
  /** Shorter wording for narrow phone tiles, where the full label would be cut off. */
  short?: Partial<Text>;
  icon?: IconName;
  href: string;
  /** Used when a `{placeholder}` in `href` has no value. */
  fallbackHref?: string;
  count?: CountKey;
  /** Red badge (needs action now) rather than the neutral one. */
  urgent?: boolean;
  tick?: TickKey;
  /** The role needs any one of these. */
  permission?: Permission | readonly Permission[];
  /** Customer board: needs an account, so a signed-out visitor goes to sign-in. */
  auth?: boolean;
}

export interface BoardMenu extends BoardItem {
  tone: Tone;
  items: BoardItem[];
}

/* ---------------------------------------------------------------- customer */

/** The eight category tiles under the customer's banners. */
export interface CategoryTile {
  key: string;
  label: Text;
  emoji: string;
  bg: string;
  href: string;
  count?: CountKey;
}

export const CUSTOMER_CATEGORIES: readonly CategoryTile[] = [
  { key: "dairy", label: L("Dairy", "डेयरी", "डेअरी"), emoji: "🥛", bg: "bg-sky-50", href: "/shops?type=DAIRY" },
  { key: "bakery", label: L("Bakery", "बेकरी", "बेकरी"), emoji: "🍞", bg: "bg-amber-50", href: "/shops?type=BAKERY" },
  { key: "grocery", label: L("Grocery", "किराना", "किराणा"), emoji: "🍚", bg: "bg-rose-50", href: "/shops?type=GROCERY_KIRANA" },
  { key: "fruitsVeg", label: L("Fruits & Veg", "फल-सब्ज़ी", "फळे-भाज्या"), emoji: "🥬", bg: "bg-emerald-50", href: "/shops?type=FRUIT_VEGETABLE" },
  { key: "sweets", label: L("Sweets", "मिठाई", "मिठाई"), emoji: "🍬", bg: "bg-pink-50", href: "/shops?type=SWEET_SHOP" },
  { key: "pharmacy", label: L("Pharmacy", "दवाइयाँ", "औषधे"), emoji: "💊", bg: "bg-violet-50", href: "/shops?type=PHARMACY" },
  { key: "household", label: L("Household", "घरेलू", "घरगुती"), emoji: "🧴", bg: "bg-indigo-50", href: "/shops?type=SUPERMARKET" },
  { key: "all", label: L("All", "सभी", "सर्व"), emoji: "🔎", bg: "bg-slate-100", href: "/categories", count: "shopCategories" },
];

export const CUSTOMER_MENUS: readonly BoardMenu[] = [
  {
    key: "shops", label: L("Shops", "दुकानें", "दुकाने"), icon: "store", tone: "kesari", href: "/shops", count: "nearbyShops",
    items: [
      { key: "nearby", label: L("Nearby", "पास में", "जवळची"), icon: "map-pin", href: "/shops", count: "nearbyShops" },
      { key: "openNow", label: L("Open now", "अभी खुली", "आता उघडी"), icon: "clock", href: "/shops?open=1", count: "openNowShops" },
      // Mockup: "Favourites" — no favourites feature exists; nearest real destination.
      { key: "deliversHere", label: L("Delivers here", "यहाँ डिलीवरी", "इथे डिलिव्हरी"), short: { en: "Delivers" }, icon: "truck", href: "/shops?delivery=true", count: "deliveringShops" },
    ],
  },
  {
    key: "orders", label: L("Orders", "ऑर्डर", "ऑर्डर"), icon: "package", tone: "teal", href: "/orders", count: "activeOrders", auth: true,
    items: [
      { key: "active", label: L("Active", "चालू", "चालू"), icon: "package", href: "/orders", count: "activeOrders", urgent: true, auth: true },
      { key: "past", label: L("Past", "पुराने", "जुन्या"), icon: "history", href: "/orders", count: "pastOrders", auth: true },
      { key: "returns", label: L("Returns", "वापसी", "परत"), icon: "undo-2", href: "/returns", count: "openReturns", auth: true },
    ],
  },
  {
    key: "subscriptions", label: L("Subscriptions", "सब्सक्रिप्शन", "सदस्यता"), icon: "calendar-clock", tone: "blue", href: "/subscriptions", count: "activeSubscriptions", auth: true,
    items: [
      { key: "tomorrow", label: L("Tomorrow", "कल", "उद्या"), icon: "sunrise", href: "/subscriptions", auth: true },
      { key: "calendar", label: L("Calendar", "कैलेंडर", "कॅलेंडर"), icon: "calendar-days", href: "/subscriptions/{subscriptionId}", fallbackHref: "/subscriptions", auth: true },
      { key: "pause", label: L("Pause", "रोकें", "थांबवा"), icon: "pause", href: "/subscriptions/{subscriptionId}", fallbackHref: "/subscriptions", auth: true },
    ],
  },
  {
    key: "wallet", label: L("Wallet", "वॉलेट", "वॉलेट"), icon: "wallet", tone: "green", href: "/wallet", auth: true,
    items: [
      { key: "addMoney", label: L("Add money", "पैसे जोड़ें", "पैसे भरा"), short: { en: "Top up" }, icon: "plus", href: "/wallet#add-money", auth: true },
      { key: "history", label: L("History", "इतिहास", "इतिहास"), icon: "receipt", href: "/wallet#history", auth: true },
    ],
  },
  {
    key: "tracking", label: L("Tracking", "ट्रैकिंग", "ट्रॅकिंग"), icon: "navigation", tone: "violet", href: "/orders", auth: true,
    items: [
      { key: "liveMap", label: L("Live map", "लाइव नक्शा", "नकाशा"), icon: "map", href: "/orders#order-{activeOrderNumber}", fallbackHref: "/orders", auth: true },
      // Mockup: "Call rider" — the rider's number is deliberately not shown to customers.
      { key: "deliveryCode", label: L("Delivery code", "डिलीवरी कोड", "डिलिव्हरी कोड"), short: { en: "OTP code" }, icon: "key-round", href: "/orders", auth: true },
    ],
  },
  {
    key: "profile", label: L("Profile", "प्रोफ़ाइल", "प्रोफाइल"), icon: "user", tone: "pink", href: "/profile", auth: true,
    items: [
      { key: "addresses", label: L("Addresses", "पते", "पत्ते"), icon: "map-pin", href: "/profile/addresses", auth: true },
      { key: "society", label: L("Society", "सोसाइटी", "सोसायटी"), icon: "building-2", href: "/society", auth: true },
      { key: "refer", label: L("Refer & earn", "रेफ़र करें", "रेफर करा"), short: { en: "Refer" }, icon: "gift", href: "/refer", auth: true },
      // Mockup: "App theme" — no theme setting exists; nearest real destination.
      { key: "bank", label: L("Bank account", "बैंक खाता", "बँक खाते"), short: { en: "Bank" }, icon: "landmark", href: "/profile/bank-account", auth: true },
      { key: "help", label: L("Help", "मदद", "मदत"), icon: "circle-help", href: "/contact" },
    ],
  },
];

/* -------------------------------------------------------------- shop owner */

export const SHOP_DO_NOW: readonly BoardItem[] = [
  { key: "newOrders", label: L("New orders", "नए ऑर्डर", "नवीन ऑर्डर"), href: "/shop/orders", count: "shopNew", urgent: true },
  { key: "returns", label: L("Returns", "वापसी", "परतावा"), href: "/shop/returns", count: "shopReturnRequests" },
  { key: "lowStock", label: L("Low stock", "कम स्टॉक", "कमी साठा"), href: "/shop/inventory", count: "shopLowStock" },
];

export const SHOP_MENUS: readonly BoardMenu[] = [
  {
    key: "orders", label: L("Orders", "ऑर्डर", "ऑर्डर"), icon: "package", tone: "kesari", href: "/shop/orders", count: "shopActiveOrders", urgent: true,
    items: [
      { key: "new", label: L("New", "नए", "नवीन"), href: "/shop/orders", count: "shopNew", urgent: true },
      { key: "packing", label: L("Packing", "पैकिंग", "पॅकिंग"), href: "/shop/orders", count: "shopPacking" },
      { key: "ready", label: L("Ready", "तैयार", "तयार"), href: "/shop/orders", count: "shopReady" },
      { key: "out", label: L("Out", "रास्ते में", "रवाना"), href: "/shop/orders", count: "shopOut" },
    ],
  },
  {
    key: "returns", label: L("Returns", "वापसी", "परतावा"), icon: "undo-2", tone: "kesari", href: "/shop/returns", count: "shopOpenReturns",
    items: [
      { key: "requests", label: L("Requests", "अनुरोध", "विनंत्या"), href: "/shop/returns", count: "shopReturnRequests" },
      { key: "pickups", label: L("Pickups", "पिकअप", "पिकअप"), href: "/shop/returns", count: "shopReturnPickups" },
    ],
  },
  {
    key: "disputes", label: L("Disputes", "विवाद", "वाद"), icon: "scale", tone: "kesari", href: "/shop/disputes", count: "shopOpenDisputes", urgent: true,
    items: [
      { key: "open", label: L("Open", "खुले", "उघडे"), href: "/shop/disputes", count: "shopOpenDisputes", urgent: true },
      { key: "resolved", label: L("Resolved", "सुलझे", "सुटलेले"), href: "/shop/disputes" },
    ],
  },
  {
    key: "inventory", label: L("Inventory", "स्टॉक", "साठा"), icon: "boxes", tone: "teal", href: "/shop/inventory", count: "shopLowStock",
    items: [
      { key: "stock", label: L("Stock", "स्टॉक", "साठा"), href: "/shop/inventory" },
      { key: "low", label: L("Low", "कम", "कमी"), href: "/shop/inventory", count: "shopLowStock" },
      { key: "onOff", label: L("On/off", "चालू/बंद", "चालू/बंद"), href: "/shop#products" },
    ],
  },
  {
    key: "photos", label: L("Photo catalogue", "फ़ोटो कैटलॉग", "फोटो कॅटलॉग"), icon: "images", tone: "teal", href: "/shop/catalogue",
    items: [
      { key: "add", label: L("Add", "जोड़ें", "जोडा"), href: "/shop/media-import" },
      { key: "pending", label: L("Pending", "लंबित", "प्रलंबित"), href: "/shop/catalogue", count: "shopPendingPhotos" },
    ],
  },
  {
    key: "productCategories", label: L("Product categories", "उत्पाद श्रेणियाँ", "उत्पादन वर्ग"), icon: "list-tree", tone: "teal", href: "/shop/product-categories",
    items: [
      { key: "mine", label: L("Mine", "मेरी", "माझे"), href: "/shop/product-categories" },
      { key: "all", label: L("All", "सभी", "सर्व"), href: "/product-categories", permission: PERMISSIONS.CATALOGUE_BROWSE },
    ],
  },
  {
    key: "prices", label: L("Price updates", "दाम अपडेट", "दर बदल"), icon: "tag", tone: "teal", href: "/shop/prices",
    items: [
      { key: "edit", label: L("Edit", "बदलें", "बदला"), href: "/shop/prices" },
      { key: "excel", label: L("Excel", "एक्सेल", "एक्सेल"), href: "/shop#excel-upload" },
      { key: "requests", label: L("Requests", "अनुरोध", "विनंत्या"), href: "/shop/prices#price-requests", count: "shopPriceRequests", urgent: true },
    ],
  },
  {
    key: "finance", label: L("Finance", "वित्त", "वित्त"), icon: "indian-rupee", tone: "green", href: "/shop/finance", permission: PERMISSIONS.SETTLEMENT_VIEW_OWN,
    items: [
      { key: "settlements", label: L("Settlements", "सेटलमेंट", "सेटलमेंट"), href: "/shop/finance#settlements", permission: PERMISSIONS.SETTLEMENT_VIEW_OWN },
      { key: "invoices", label: L("Invoices", "बिल", "बिले"), href: "/shop/finance#invoices", permission: PERMISSIONS.SETTLEMENT_VIEW_OWN },
      { key: "gst", label: L("GST", "जीएसटी", "जीएसटी"), href: "/shop/gst-returns" },
    ],
  },
  {
    key: "wallet", label: L("Wallet", "वॉलेट", "वॉलेट"), icon: "wallet", tone: "green", href: "/shop/wallet", permission: PERMISSIONS.SETTLEMENT_VIEW_OWN,
    items: [
      { key: "balance", label: L("Balance", "बैलेंस", "शिल्लक"), href: "/shop/wallet", permission: PERMISSIONS.SETTLEMENT_VIEW_OWN },
      { key: "history", label: L("History", "इतिहास", "इतिहास"), href: "/shop/wallet", permission: PERMISSIONS.SETTLEMENT_VIEW_OWN },
    ],
  },
  {
    key: "payout", label: L("Payout bank", "पेआउट बैंक", "पेआउट बँक"), icon: "landmark", tone: "green", href: "/shop/bank-account",
    items: [
      { key: "details", label: L("Details", "विवरण", "तपशील"), href: "/shop/bank-account" },
      { key: "verified", label: L("Verified", "सत्यापित", "पडताळलेले"), href: "/shop/bank-account", tick: "bankVerified" },
    ],
  },
  {
    key: "marketing", label: L("Marketing", "मार्केटिंग", "मार्केटिंग"), icon: "megaphone", tone: "violet", href: "/shop/marketing", permission: PERMISSIONS.MARKETING_MANAGE_OWN,
    items: [
      { key: "campaigns", label: L("Campaigns", "अभियान", "मोहिमा"), href: "/shop/marketing", permission: PERMISSIONS.MARKETING_MANAGE_OWN },
      { key: "share", label: L("Share", "शेयर", "शेअर"), href: "/shops/{shopSlug}" },
    ],
  },
  {
    key: "offers", label: L("Offers", "ऑफ़र", "ऑफर"), icon: "badge-percent", tone: "violet", href: "/shop/offers", count: "shopActiveOffers", permission: PERMISSIONS.MARKETING_MANAGE_OWN,
    items: [
      { key: "active", label: L("Active", "चालू", "चालू"), href: "/shop/offers", count: "shopActiveOffers", permission: PERMISSIONS.MARKETING_MANAGE_OWN },
      { key: "new", label: L("New", "नया", "नवीन"), href: "/shop/offers", permission: PERMISSIONS.MARKETING_MANAGE_OWN },
    ],
  },
  {
    key: "analytics", label: L("Analytics", "विश्लेषण", "विश्लेषण"), icon: "chart-line", tone: "violet", href: "/shop/analytics", permission: PERMISSIONS.REPORT_VIEW_SHOP,
    items: [
      { key: "sales", label: L("Sales", "बिक्री", "विक्री"), href: "/shop/analytics", permission: PERMISSIONS.REPORT_VIEW_SHOP },
      { key: "topItems", label: L("Top items", "टॉप आइटम", "टॉप वस्तू"), href: "/shop/analytics?days=30", permission: PERMISSIONS.REPORT_VIEW_SHOP },
    ],
  },
  {
    key: "myShop", label: L("My Shop", "मेरी दुकान", "माझे दुकान"), icon: "store", tone: "blue", href: "/shop/profile-setup",
    items: [
      { key: "profile", label: L("Profile", "प्रोफ़ाइल", "प्रोफाइल"), href: "/shop/profile-setup" },
      { key: "area", label: L("Area", "क्षेत्र", "क्षेत्र"), href: "/shop#location" },
      // Mockup: "Theme" — no shop theme setting exists; nearest real destination.
      { key: "staff", label: L("Staff", "स्टाफ़", "कर्मचारी"), href: "/shop/staff", permission: PERMISSIONS.SHOP_STAFF_MANAGE_OWN },
      { key: "verified", label: L("Verified", "सत्यापित", "पडताळलेले"), href: "/shop/verification", tick: "shopVerified" },
    ],
  },
  {
    key: "delivery", label: L("Delivery staff", "डिलीवरी स्टाफ़", "डिलिव्हरी कर्मचारी"), icon: "bike", tone: "amber", href: "/shop/delivery-staff", count: "shopRiders",
    items: [
      { key: "riders", label: L("Riders", "राइडर", "रायडर"), href: "/shop/delivery-staff", count: "shopRiders" },
      { key: "assign", label: L("Assign", "सौंपें", "नेमा"), href: "/shop/orders" },
    ],
  },
  {
    key: "legal", label: L("Legal documents", "कानूनी दस्तावेज़", "कायदेशीर कागदपत्रे"), icon: "scroll-text", tone: "blue", href: "/shop/legal-documents",
    items: [
      { key: "licences", label: L("Licences", "लाइसेंस", "परवाने"), href: "/shop/legal-documents" },
      { key: "terms", label: L("Terms", "शर्तें", "अटी"), href: "/legal/seller-terms" },
    ],
  },
];

/* ------------------------------------------------------------------- admin */

/** Pages that check `role === "ADMIN"` themselves; SYSTEM_CONFIG is admin-only. */
const ADMIN_ONLY = PERMISSIONS.SYSTEM_CONFIG;
const REPORTS = [PERMISSIONS.REPORT_VIEW_ALL, PERMISSIONS.REPORT_VIEW_OPERATIONAL] as const;
const AUDIT = [PERMISSIONS.AUDIT_LOG_VIEW, PERMISSIONS.AUDIT_LOG_VIEW_LIMITED] as const;

export const ADMIN_DO_NOW: readonly BoardItem[] = [
  { key: "approvals", label: L("Approvals", "मंज़ूरी", "मंजुरी"), href: "/admin#shop-approvals", count: "pendingShops", permission: PERMISSIONS.SHOP_APPROVE },
  { key: "reviews", label: L("Reviews", "समीक्षा", "पुनरावलोकन"), href: "/admin#product-approvals", count: "pendingProducts", permission: PERMISSIONS.PRODUCT_APPROVE },
  { key: "refunds", label: L("Refunds", "रिफ़ंड", "परतावा"), href: "/admin/bank-refunds", count: "bankRefunds", urgent: true, permission: PERMISSIONS.FINANCE_VIEW },
];

export const ADMIN_MENUS: readonly BoardMenu[] = [
  {
    key: "shops", label: L("Shops", "दुकानें", "दुकाने"), icon: "store", tone: "kesari", href: "/admin/shops", count: "pendingShops", urgent: true,
    items: [
      { key: "approvals", label: L("Approvals", "मंज़ूरी", "मंजुरी"), href: "/admin#shop-approvals", count: "pendingShops", urgent: true, permission: PERMISSIONS.SHOP_APPROVE },
      { key: "all", label: L("All", "सभी", "सर्व"), href: "/admin/shops", count: "allShops", permission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY },
      { key: "verified", label: L("Verification", "सत्यापन", "पडताळणी"), href: "/admin/seller-verification", count: "sellerReviews", permission: PERMISSIONS.SHOP_GST_PAN_VERIFY },
      { key: "suspensions", label: L("Suspensions", "निलंबन", "निलंबन"), href: "/admin/suspensions", count: "activeSuspensions", permission: PERMISSIONS.SHOP_SUSPEND },
      { key: "grade", label: L("Grade", "ग्रेड", "श्रेणी"), href: "/admin#approved-shops", permission: PERMISSIONS.SHOP_SET_CLASSIFICATION },
    ],
  },
  {
    key: "users", label: L("Users", "उपयोगकर्ता", "वापरकर्ते"), icon: "users", tone: "kesari", href: "/admin#users", count: "users", permission: PERMISSIONS.USER_VIEW_ANY,
    items: [
      { key: "customers", label: L("Customers", "ग्राहक", "ग्राहक"), href: "/admin#users", count: "customers", permission: PERMISSIONS.USER_VIEW_ANY },
      { key: "owners", label: L("Owners", "दुकानदार", "दुकानदार"), href: "/admin#users", count: "owners", permission: PERMISSIONS.USER_VIEW_ANY },
      { key: "riders", label: L("Riders", "राइडर", "रायडर"), href: "/admin#delivery-partners", count: "riders", permission: PERMISSIONS.DELIVERY_PARTNER_MANAGE },
      { key: "staff", label: L("Staff", "स्टाफ़", "कर्मचारी"), href: "/admin#users", count: "staff", permission: PERMISSIONS.USER_VIEW_ANY },
    ],
  },
  {
    key: "categories", label: L("Categories", "श्रेणियाँ", "वर्ग"), icon: "list-tree", tone: "kesari", href: "/admin/shop-categories",
    items: [
      { key: "shop", label: L("Shop", "दुकान", "दुकान"), href: "/admin/shop-categories", count: "shopCategoryCount", permission: PERMISSIONS.CATEGORY_MANAGE },
      { key: "product", label: L("Product", "उत्पाद", "उत्पादन"), href: "/product-categories", count: "productCategories", permission: PERMISSIONS.CATALOGUE_BROWSE },
    ],
  },
  {
    key: "productMaster", label: L("Product master", "प्रोडक्ट मास्टर", "उत्पादन मास्टर"), icon: "database", tone: "teal", href: "/admin/product-master", count: "pendingProducts",
    items: [
      { key: "products", label: L("Products", "उत्पाद", "उत्पादने"), href: "/admin/product-master", count: "products", permission: PERMISSIONS.PMD_VIEW },
      { key: "review", label: L("Review", "समीक्षा", "पुनरावलोकन"), href: "/admin#product-approvals", count: "pendingProducts", permission: PERMISSIONS.PRODUCT_APPROVE },
      { key: "mrp", label: L("MRP", "एमआरपी", "एमआरपी"), href: "/admin/mrp", count: "mrpCorrections", permission: PERMISSIONS.PRODUCT_MRP_MANAGE },
      { key: "refPrices", label: L("Ref. prices", "संदर्भ दाम", "संदर्भ दर"), href: "/admin/price-references", count: "refPricesToVerify", permission: PERMISSIONS.PRICE_REFERENCE_MANAGE },
      { key: "images", label: L("Images", "फ़ोटो", "फोटो"), href: "/admin/image-moderation", count: "pendingImages", permission: PERMISSIONS.PRODUCT_MANAGE },
    ],
  },
  {
    key: "privileges", label: L("Privileges", "अधिकार", "अधिकार"), icon: "shield-check", tone: "blue", href: "/admin#users",
    items: [
      { key: "roles", label: L("Roles", "भूमिकाएँ", "भूमिका"), href: "/admin#users", permission: PERMISSIONS.USER_SET_ROLE },
      { key: "perms", label: L("Perms", "अनुमतियाँ", "परवानग्या"), href: "/admin#users", permission: PERMISSIONS.USER_SET_ROLE },
      { key: "audit", label: L("Audit", "ऑडिट", "ऑडिट"), href: "/admin#audit-log", permission: AUDIT },
    ],
  },
  {
    key: "payments", label: L("Payments", "भुगतान", "पेमेंट"), icon: "credit-card", tone: "green", href: "/admin/finance", count: "bankRefunds", urgent: true,
    items: [
      { key: "settlements", label: L("Settlements", "सेटलमेंट", "सेटलमेंट"), href: "/admin/finance", permission: PERMISSIONS.FINANCE_VIEW },
      { key: "refunds", label: L("Refunds", "रिफ़ंड", "परतावा"), href: "/admin/bank-refunds", count: "bankRefunds", urgent: true, permission: PERMISSIONS.FINANCE_VIEW },
      { key: "cod", label: L("COD cash", "COD नकद", "COD रोख"), href: "/admin/cod", permission: PERMISSIONS.COD_CASH_MANAGE },
      { key: "riderPay", label: L("Rider pay", "राइडर भुगतान", "रायडर पगार"), href: "/admin/rider-earnings", permission: PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE },
      { key: "walletAdj", label: L("Wallet adj.", "वॉलेट समायोजन", "वॉलेट बदल"), href: "/admin/shop-wallets", permission: PERMISSIONS.WALLET_ADJUST },
    ],
  },
  {
    key: "disputes", label: L("Disputes", "विवाद", "वाद"), icon: "scale", tone: "pink", href: "/admin/disputes", count: "liveDisputes", urgent: true,
    items: [
      { key: "open", label: L("Open", "खुले", "उघडे"), href: "/admin/disputes", count: "liveDisputes", urgent: true, permission: PERMISSIONS.DISPUTE_MANAGE },
      { key: "returns", label: L("Returns", "वापसी", "परतावा"), href: "/admin/returns", count: "openReturnsAll", permission: PERMISSIONS.ORDER_VIEW_ANY },
      { key: "ratings", label: L("Ratings", "रेटिंग", "रेटिंग"), href: "/admin/ratings", permission: PERMISSIONS.RATING_MODERATE },
      { key: "grievances", label: L("Grievances", "शिकायतें", "तक्रारी"), href: "/admin#grievances", count: "openGrievances", permission: PERMISSIONS.GRIEVANCE_MANAGE },
    ],
  },
  {
    key: "reports", label: L("Reports", "रिपोर्ट", "अहवाल"), icon: "file-chart-column", tone: "pink", href: "/admin/dashboard",
    items: [
      { key: "dashboard", label: L("Dashboard", "डैशबोर्ड", "डॅशबोर्ड"), href: "/admin/dashboard", permission: REPORTS },
      { key: "analytics", label: L("Analytics", "विश्लेषण", "विश्लेषण"), href: "/admin/analytics", permission: REPORTS },
      { key: "orders", label: L("Orders", "ऑर्डर", "ऑर्डर"), href: "/admin/orders", count: "liveOrders", permission: PERMISSIONS.ORDER_VIEW_ANY },
      { key: "history", label: L("History", "इतिहास", "इतिहास"), href: "/admin/status-changes", permission: AUDIT },
      { key: "risk", label: L("Risk", "जोखिम", "धोका"), href: "/admin/risk", count: "openRisk", permission: PERMISSIONS.RISK_REVIEW },
    ],
  },
  {
    key: "settings", label: L("Settings", "सेटिंग्स", "सेटिंग्ज"), icon: "settings", tone: "blue", href: "/admin/settings",
    items: [
      { key: "rules", label: L("Rules", "नियम", "नियम"), href: "/admin/settings", permission: ADMIN_ONLY },
      { key: "slots", label: L("Slots", "स्लॉट", "स्लॉट"), href: "/admin/delivery-slots", permission: ADMIN_ONLY },
      { key: "coupons", label: L("Coupons", "कूपन", "कूपन"), href: "/admin/coupons", permission: ADMIN_ONLY },
      { key: "campaigns", label: L("Campaigns", "अभियान", "मोहिमा"), href: "/admin/campaigns", count: "submittedCampaigns", permission: PERMISSIONS.MARKETING_APPROVE },
      { key: "alerts", label: L("Alerts", "अलर्ट", "सूचना"), href: "/admin/exceptions", count: "opsExceptions", urgent: true, permission: PERMISSIONS.ORDER_VIEW_ANY },
      { key: "consent", label: L("Consent", "सहमति", "संमती"), href: "/admin/consents", permission: PERMISSIONS.CONSENT_VIEW },
    ],
  },
];

/* ---------------------------------------------------------------- operator */

export const OPERATOR_MENUS: readonly BoardMenu[] = [
  {
    key: "onboarding", label: L("Shop onboarding", "दुकान ऑनबोर्डिंग", "दुकान नोंदणी"), icon: "clipboard-check", tone: "kesari", href: "/admin#shop-approvals", count: "pendingShops",
    items: [
      { key: "applications", label: L("Applications", "आवेदन", "अर्ज"), icon: "user-plus", href: "/admin#shop-approvals", count: "pendingShops", permission: PERMISSIONS.SHOP_APPROVE },
      { key: "documents", label: L("Documents", "दस्तावेज़", "कागदपत्रे"), icon: "file-check", href: "/admin/legal-documents", count: "legalDocsToReview", permission: PERMISSIONS.SHOP_GST_PAN_VERIFY },
      { key: "photoChecks", label: L("Photo checks", "फ़ोटो जाँच", "फोटो तपासणी"), icon: "images", href: "/admin/image-moderation", count: "pendingImages", permission: PERMISSIONS.PRODUCT_MANAGE },
      { key: "grade", label: L("Quality grade", "गुणवत्ता ग्रेड", "गुणवत्ता श्रेणी"), icon: "shield-check", href: "/admin#approved-shops", permission: PERMISSIONS.SHOP_SET_CLASSIFICATION },
    ],
  },
  {
    key: "orderSupport", label: L("Order support", "ऑर्डर सहायता", "ऑर्डर मदत"), icon: "headset", tone: "teal", href: "/admin/exceptions", count: "opsExceptions", urgent: true,
    items: [
      { key: "liveOrders", label: L("Live orders", "चालू ऑर्डर", "चालू ऑर्डर"), icon: "package", href: "/admin/orders", count: "liveOrders", permission: PERMISSIONS.ORDER_VIEW_ANY },
      { key: "exceptions", label: L("Exceptions", "अपवाद", "अडचणी"), icon: "triangle-alert", href: "/admin/exceptions", count: "opsExceptions", urgent: true, permission: PERMISSIONS.ORDER_VIEW_ANY },
      { key: "returns", label: L("Returns", "वापसी", "परतावा"), icon: "undo-2", href: "/admin/returns", count: "openReturnsAll", permission: PERMISSIONS.ORDER_VIEW_ANY },
      { key: "cod", label: L("COD cash", "COD नकद", "COD रोख"), icon: "banknote", href: "/admin/cod", permission: PERMISSIONS.COD_CASH_MANAGE },
    ],
  },
  {
    key: "riders", label: L("Riders", "राइडर", "रायडर"), icon: "bike", tone: "kesari", href: "/admin#delivery-partners", count: "ridersOnDuty",
    items: [
      { key: "onDuty", label: L("On duty", "ड्यूटी पर", "ड्युटीवर"), icon: "bike", href: "/admin#delivery-partners", count: "ridersOnDuty", permission: PERMISSIONS.DELIVERY_PARTNER_MANAGE },
      { key: "applications", label: L("Applications", "आवेदन", "अर्ज"), icon: "user-plus", href: "/admin#delivery-partners", count: "riderApplications", permission: PERMISSIONS.DELIVERY_PARTNER_MANAGE },
      { key: "profileChanges", label: L("Profile changes", "प्रोफ़ाइल बदलाव", "प्रोफाइल बदल"), icon: "user-check", href: "/admin/rider-changes", count: "riderChanges", permission: PERMISSIONS.DELIVERY_PARTNER_MANAGE },
      // Rider earnings rules are admin-only; operators work the money exceptions (missing rider earnings among them).
      { key: "earnings", label: L("Pay issues", "भुगतान समस्याएँ", "पेमेंट अडचणी"), icon: "indian-rupee", href: "/admin/finance/exceptions", permission: PERMISSIONS.FINANCE_EXCEPTIONS_VIEW },
    ],
  },
  {
    key: "societies", label: L("Societies", "सोसाइटी", "सोसायट्या"), icon: "building-2", tone: "teal", href: "/admin/societies", count: "societies",
    items: [
      { key: "societies", label: L("Societies", "सोसाइटी", "सोसायट्या"), icon: "building-2", href: "/admin/societies", count: "societiesApplied", permission: PERMISSIONS.SOCIETY_MANAGE_ANY },
      { key: "members", label: L("Members", "सदस्य", "सदस्य"), icon: "users", href: "/admin/societies?status=VERIFIED", count: "societyMembers", permission: PERMISSIONS.SOCIETY_MANAGE_ANY },
      { key: "societyRiders", label: L("Society riders", "सोसाइटी राइडर", "सोसायटी रायडर"), icon: "bike", href: "/admin/societies?status=VERIFIED", count: "societyRiders", permission: PERMISSIONS.SOCIETY_MANAGE_ANY },
    ],
  },
  {
    key: "vouchers", label: L("Vouchers", "वाउचर", "व्हाउचर"), icon: "ticket", tone: "violet", href: "/admin#vouchers", count: "activeVouchers",
    items: [
      { key: "vouchers", label: L("Vouchers", "वाउचर", "व्हाउचर"), icon: "ticket", href: "/admin#vouchers", count: "activeVouchers", permission: PERMISSIONS.VOUCHER_VIEW },
      { key: "bulkUpload", label: L("Bulk upload", "बल्क अपलोड", "एकत्र अपलोड"), icon: "upload", href: "/admin#voucher-upload", permission: PERMISSIONS.VOUCHER_UPLOAD },
      { key: "redemptions", label: L("Redemptions", "रिडेम्पशन", "वापर"), icon: "receipt", href: "/admin#vouchers", count: "voucherRedemptions", permission: PERMISSIONS.VOUCHER_VIEW },
    ],
  },
  {
    key: "tickets", label: L("Tickets", "टिकट", "तिकिटे"), icon: "life-buoy", tone: "violet", href: "/admin/disputes", count: "liveDisputes", urgent: true,
    items: [
      { key: "open", label: L("Open", "खुले", "उघडे"), icon: "circle-alert", href: "/admin/disputes?status=OPEN", count: "openDisputes", urgent: true, permission: PERMISSIONS.DISPUTE_MANAGE },
      { key: "escalated", label: L("Escalated", "एस्केलेटेड", "एस्केलेट"), icon: "triangle-alert", href: "/admin/disputes?status=ESCALATED", count: "escalatedDisputes", urgent: true, permission: PERMISSIONS.DISPUTE_MANAGE },
      { key: "grievances", label: L("Grievances", "शिकायतें", "तक्रारी"), icon: "message-square", href: "/admin#grievances", count: "openGrievances", permission: PERMISSIONS.GRIEVANCE_MANAGE },
      { key: "disputes", label: L("Disputes", "विवाद", "वाद"), icon: "scale", href: "/admin/disputes", count: "liveDisputes", permission: PERMISSIONS.DISPUTE_MANAGE },
    ],
  },
];

export const MENUS: Readonly<Record<BoardRole, readonly BoardMenu[]>> = {
  customer: CUSTOMER_MENUS,
  shop: SHOP_MENUS,
  admin: ADMIN_MENUS,
  operator: OPERATOR_MENUS,
};

/* --------------------------------------------------------------- functions */

/** May this role see this entry? No permission listed means everyone may. */
export function isPermitted(entry: Pick<BoardItem, "permission">, role: UserRole): boolean {
  if (!entry.permission) return true;
  const needed: readonly Permission[] = typeof entry.permission === "string" ? [entry.permission] : entry.permission;
  return needed.some((p) => can(role, p));
}

/**
 * Fills `{placeholders}` in a link. Returns the fallback when a value is
 * missing or empty, and null when there is no fallback either (the entry is
 * then hidden). Values are URL-encoded so a slug or number cannot change the
 * path.
 */
export function resolveHref(href: string, params: LinkParams, fallbackHref?: string): string | null {
  let missing = false;
  const resolved = href.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name as keyof LinkParams];
    if (!value) {
      missing = true;
      return "";
    }
    return encodeURIComponent(value);
  });
  if (!missing) return resolved;
  return fallbackHref ?? null;
}

/** A menu or item ready to render: permitted, with its link resolved. */
export type Resolved<T extends BoardItem> = Omit<T, "href"> & { href: string };
export type ResolvedMenu = Resolved<Omit<BoardMenu, "items">> & { items: Resolved<BoardItem>[] };

/**
 * The menus a role sees: entries it is not permitted to open are dropped, as
 * are entries whose link cannot be resolved. A tile with no submenus left is
 * dropped too. A tile links to its own page only when that page is one of
 * its permitted submenus, or none of its entries needs a permission — so it
 * is never a way round a hidden entry; otherwise it opens its first
 * remaining submenu.
 */
export function visibleMenus(menus: readonly BoardMenu[], role: UserRole, params: LinkParams = {}): ResolvedMenu[] {
  const out: ResolvedMenu[] = [];
  for (const menu of menus) {
    if (menu.permission && !isPermitted(menu, role)) continue;
    const items = visibleItems(menu.items, role, params);
    if (items.length === 0) continue;
    const ownHref = resolveHref(menu.href, params, menu.fallbackHref);
    const page = (href: string) => href.split(/[?#]/)[0];
    // A tile none of whose entries needs a permission (e.g. the customer's Profile) keeps its own page.
    const open = menu.items.every((item) => !item.permission);
    const reachable = ownHref != null && (open || items.some((item) => page(item.href) === page(ownHref)));
    out.push({ ...menu, href: reachable ? ownHref : items[0].href, items });
  }
  return out;
}

/** Permitted, resolvable items (a "Do now" strip or one tile's submenus). */
export function visibleItems(items: readonly BoardItem[], role: UserRole, params: LinkParams = {}): Resolved<BoardItem>[] {
  return items.flatMap((item) => {
    if (!isPermitted(item, role)) return [];
    const href = resolveHref(item.href, params, item.fallbackHref);
    return href ? [{ ...item, href }] : [];
  });
}

/** Every link written in the definitions, placeholders and fallbacks included (for the route test). */
export function allDefinedHrefs(): string[] {
  const items: BoardItem[] = [
    ...Object.values(MENUS).flatMap((menus) => menus.flatMap((m) => [m, ...m.items])),
    ...SHOP_DO_NOW,
    ...ADMIN_DO_NOW,
  ];
  return [
    ...items.flatMap((i) => [i.href, ...(i.fallbackHref ? [i.fallbackHref] : [])]),
    ...CUSTOMER_CATEGORIES.map((c) => c.href),
  ];
}
