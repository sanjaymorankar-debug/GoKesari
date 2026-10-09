/**
 * The Tile Board menus — every menu and submenu of the four role home screens
 * (customer, shop owner, admin, operator), as approved in "Theme 1 Tile Board".
 *
 * One list per role is the single source for the screen: what is shown, where
 * it goes, which live count sits on it and who may see it. Every destination
 * is an existing page; the page itself re-checks access, so hiding an entry
 * here is a courtesy, not the security boundary.
 *
 * Pure data: no database or server-only imports.
 */
import { PERMISSIONS, type Permission } from "@/server/authz/permissions";

import type { IconName } from "./icons";
import { L, type Label } from "./i18n";

/** Colour family of a tile's icon. */
export type Tint = "kesari" | "teal" | "blue" | "green" | "violet" | "pink" | "amber";

/** How a count is drawn: needs action now, worth a look, or just a total. */
export type CountTone = "alert" | "warn" | "plain";

export interface BoardItem {
  id: string;
  label: Label;
  /** May hold `{name}` placeholders filled from the board's data (e.g. the shop's slug). */
  href: string;
  icon?: IconName;
  /** Key into the board's live counts. */
  count?: string;
  countTone?: CountTone;
  /** Key into the board's yes/no facts; draws a green tick when true. */
  check?: string;
  /** Shown only to roles holding at least one of these. */
  perm?: readonly Permission[];
  adminOnly?: boolean;
}

export interface BoardMenu {
  id: string;
  label: Label;
  icon: IconName;
  tint: Tint;
  href: string;
  count?: string;
  countTone?: CountTone;
  perm?: readonly Permission[];
  adminOnly?: boolean;
  items: readonly BoardItem[];
}

const P = PERMISSIONS;

/* ------------------------------------------------------------------ customer */

/** The eight category tiles under the customer's search box. */
export const CUSTOMER_CATEGORIES: readonly { id: string; label: Label; emoji: string; href: string }[] = [
  { id: "dairy", label: L("Dairy", "डेयरी", "डेअरी"), emoji: "🥛", href: "/category/DAIRY" },
  { id: "bakery", label: L("Bakery", "बेकरी", "बेकरी"), emoji: "🍞", href: "/category/BAKERY" },
  { id: "grocery", label: L("Grocery", "किराना", "किराणा"), emoji: "🍚", href: "/category/GROCERY_KIRANA" },
  { id: "fruit-veg", label: L("Fruits & Veg", "फल-सब्ज़ी", "फळे-भाज्या"), emoji: "🥬", href: "/category/FRUIT_VEGETABLE" },
  { id: "sweets", label: L("Sweets", "मिठाई", "मिठाई"), emoji: "🍬", href: "/category/SWEET_SHOP" },
  { id: "pharmacy", label: L("Pharmacy", "दवाइयाँ", "औषधे"), emoji: "💊", href: "/category/PHARMACY" },
  { id: "household", label: L("Household", "घरेलू", "घरगुती"), emoji: "🧴", href: "/search?q=household" },
];

export const CUSTOMER_MENUS: readonly BoardMenu[] = [
  {
    id: "shops",
    label: L("Shops", "दुकानें", "दुकाने"),
    icon: "store",
    tint: "kesari",
    href: "/shops",
    count: "shopsNearby",
    items: [
      { id: "nearby", label: L("Nearby", "पास की", "जवळची"), icon: "map-pin", href: "/shops", count: "shopsNearby" },
      { id: "open", label: L("Open now", "अभी खुली", "आता उघडी"), icon: "clock", href: "/shops?open=1", count: "shopsOpen" },
      { id: "delivers", label: L("Delivers here", "यहाँ डिलीवरी", "इथे डिलिव्हरी"), icon: "truck", href: "/shops?delivery=true", count: "shopsDeliver" },
    ],
  },
  {
    id: "orders",
    label: L("Orders", "ऑर्डर", "ऑर्डर"),
    icon: "package",
    tint: "teal",
    href: "/orders",
    count: "ordersActive",
    countTone: "alert",
    items: [
      { id: "active", label: L("Active", "चालू", "चालू"), icon: "package", href: "/orders", count: "ordersActive", countTone: "alert" },
      { id: "past", label: L("Past", "पुराने", "जुन्या"), icon: "history", href: "/orders", count: "ordersPast" },
      { id: "returns", label: L("Returns", "वापसी", "परत"), icon: "undo-2", href: "/returns", count: "returnsOpen" },
    ],
  },
  {
    id: "subscriptions",
    label: L("Subscriptions", "सदस्यता", "सदस्यता"),
    icon: "calendar-clock",
    tint: "blue",
    href: "/subscriptions",
    count: "subscriptionsActive",
    items: [
      { id: "tomorrow", label: L("Tomorrow", "कल", "उद्या"), icon: "sunrise", href: "{tomorrowHref}" },
      { id: "calendar", label: L("Calendar", "कैलेंडर", "कॅलेंडर"), icon: "calendar-days", href: "{subscriptionHref}" },
      { id: "pause", label: L("Pause", "रोकें", "थांबवा"), icon: "pause", href: "{subscriptionHref}" },
    ],
  },
  {
    id: "wallet",
    label: L("Wallet", "वॉलेट", "वॉलेट"),
    icon: "wallet",
    tint: "green",
    href: "/wallet",
    items: [
      { id: "add", label: L("Add money", "पैसे डालें", "पैसे भरा"), icon: "plus", href: "/wallet" },
      { id: "history", label: L("History", "इतिहास", "इतिहास"), icon: "receipt-indian-rupee", href: "/wallet#wallet-history" },
    ],
  },
  {
    id: "tracking",
    label: L("Tracking", "ट्रैकिंग", "ट्रॅकिंग"),
    icon: "navigation",
    tint: "violet",
    href: "/orders",
    items: [
      { id: "map", label: L("Live map", "लाइव नक्शा", "नकाशा"), icon: "map", href: "/orders" },
      { id: "code", label: L("Delivery code", "डिलीवरी कोड", "डिलिव्हरी कोड"), icon: "lock", href: "/orders" },
    ],
  },
  {
    id: "profile",
    label: L("Profile", "प्रोफ़ाइल", "प्रोफाइल"),
    icon: "user",
    tint: "pink",
    href: "/profile",
    items: [
      { id: "addresses", label: L("Addresses", "पते", "पत्ते"), icon: "map-pin", href: "/profile/addresses" },
      { id: "society", label: L("Society", "सोसायटी", "सोसायटी"), icon: "building-2", href: "/society" },
      { id: "refer", label: L("Refer & earn", "रेफ़र करें", "रेफर करा"), icon: "gift", href: "/refer" },
      { id: "bank", label: L("Bank account", "बैंक खाता", "बँक खाते"), icon: "landmark", href: "/profile/bank-account" },
      { id: "help", label: L("Help", "मदद", "मदत"), icon: "circle-help", href: "/grievance" },
    ],
  },
];

/* ---------------------------------------------------------------- shop owner */

export const SHOP_MENUS: readonly BoardMenu[] = [
  {
    id: "orders",
    label: L("Orders", "ऑर्डर", "ऑर्डर"),
    icon: "package",
    tint: "kesari",
    href: "/shop/orders",
    count: "ordersOpen",
    countTone: "alert",
    items: [
      { id: "new", label: L("New", "नए", "नवीन"), href: "/shop/orders", count: "ordersNew", countTone: "alert" },
      { id: "packing", label: L("Packing", "पैकिंग", "पॅकिंग"), href: "/shop/orders", count: "ordersPacking" },
      { id: "ready", label: L("Ready", "तैयार", "तयार"), href: "/shop/orders", count: "ordersReady" },
      { id: "out", label: L("Out", "निकले", "निघाल्या"), href: "/shop/orders", count: "ordersOut" },
    ],
  },
  {
    id: "returns",
    label: L("Returns", "वापसी", "परत"),
    icon: "undo-2",
    tint: "kesari",
    href: "/shop/returns",
    count: "returnsOpen",
    countTone: "warn",
    items: [
      { id: "requests", label: L("Requests", "अनुरोध", "विनंत्या"), href: "/shop/returns", count: "returnsReview", countTone: "warn" },
      { id: "pickups", label: L("Pickups", "पिकअप", "पिकअप"), href: "/shop/returns", count: "returnsPickup" },
    ],
  },
  {
    id: "disputes",
    label: L("Disputes", "विवाद", "वाद"),
    icon: "scale",
    tint: "kesari",
    href: "/shop/disputes",
    count: "disputesOpen",
    countTone: "alert",
    items: [
      { id: "open", label: L("Open", "खुले", "खुले"), href: "/shop/disputes", count: "disputesOpen", countTone: "alert" },
      { id: "resolved", label: L("Resolved", "सुलझे", "सुटले"), href: "/shop/disputes" },
    ],
  },
  {
    id: "inventory",
    label: L("Inventory", "स्टॉक", "साठा"),
    icon: "boxes",
    tint: "teal",
    href: "/shop/inventory",
    count: "stockLow",
    countTone: "warn",
    items: [
      { id: "stock", label: L("Stock", "स्टॉक", "साठा"), href: "/shop/inventory" },
      { id: "low", label: L("Low", "कम", "कमी"), href: "/shop/inventory", count: "stockLow", countTone: "warn" },
      { id: "onoff", label: L("On/off", "चालू/बंद", "चालू/बंद"), href: "/shop#shop-products" },
    ],
  },
  {
    id: "catalogue",
    label: L("Photo catalogue", "फोटो कैटलॉग", "फोटो कॅटलॉग"),
    icon: "images",
    tint: "teal",
    href: "/shop/catalogue",
    items: [
      { id: "add", label: L("Add", "जोड़ें", "जोडा"), href: "/shop/catalogue" },
      { id: "bulk", label: L("Bulk upload", "बल्क अपलोड", "बल्क अपलोड"), href: "/shop/media-import" },
    ],
  },
  {
    id: "product-categories",
    label: L("Product categories", "प्रोडक्ट श्रेणियाँ", "उत्पादन श्रेणी"),
    icon: "folder-tree",
    tint: "teal",
    href: "/shop/product-categories",
    items: [
      { id: "mine", label: L("Mine", "मेरी", "माझ्या"), href: "/shop/product-categories", count: "categoriesMine" },
      { id: "all", label: L("All", "सभी", "सर्व"), href: "/product-categories" },
    ],
  },
  {
    id: "prices",
    label: L("Price updates", "दाम अपडेट", "किंमत अपडेट"),
    icon: "tag",
    tint: "teal",
    href: "/shop/prices",
    count: "priceRequests",
    countTone: "warn",
    items: [
      { id: "edit", label: L("Edit", "बदलें", "बदला"), href: "/shop/catalogue" },
      { id: "excel", label: L("Excel", "एक्सेल", "एक्सेल"), href: "/shop/prices" },
      { id: "requests", label: L("Requests", "अनुरोध", "विनंत्या"), href: "/shop/prices", count: "priceRequests", countTone: "warn" },
    ],
  },
  {
    id: "finance",
    label: L("Finance", "हिसाब", "हिशेब"),
    icon: "indian-rupee",
    tint: "green",
    href: "/shop/finance",
    items: [
      { id: "settlements", label: L("Settlements", "सेटलमेंट", "सेटलमेंट"), href: "/shop/finance" },
      { id: "invoices", label: L("Invoices", "बिल", "बिले"), href: "/shop/finance" },
      { id: "gst", label: L("GST", "GST", "GST"), href: "/shop/gst-returns" },
    ],
  },
  {
    id: "wallet",
    label: L("Wallet", "वॉलेट", "वॉलेट"),
    icon: "wallet",
    tint: "green",
    href: "/shop/wallet",
    items: [
      { id: "balance", label: L("Balance", "बैलेंस", "शिल्लक"), href: "/shop/wallet" },
      { id: "history", label: L("History", "इतिहास", "इतिहास"), href: "/shop/wallet" },
    ],
  },
  {
    id: "bank",
    label: L("Payout bank", "पेआउट बैंक", "पेआउट बँक"),
    icon: "landmark",
    tint: "green",
    href: "/shop/bank-account",
    items: [
      { id: "details", label: L("Details", "विवरण", "तपशील"), href: "/shop/bank-account" },
      { id: "verified", label: L("Verified", "सत्यापित", "पडताळले"), href: "/shop/bank-account", check: "bankVerified" },
    ],
  },
  {
    id: "marketing",
    label: L("Marketing", "मार्केटिंग", "मार्केटिंग"),
    icon: "megaphone",
    tint: "violet",
    href: "/shop/marketing",
    items: [
      { id: "campaigns", label: L("Campaigns", "कैंपेन", "मोहिमा"), href: "/shop/marketing", count: "campaigns" },
      { id: "share", label: L("Share shop", "दुकान शेयर", "दुकान शेअर"), href: "/shops/{slug}" },
    ],
  },
  {
    id: "offers",
    label: L("Offers", "ऑफ़र", "ऑफर"),
    icon: "badge-percent",
    tint: "violet",
    href: "/shop/offers",
    count: "offersActive",
    items: [
      { id: "active", label: L("Active", "चालू", "चालू"), href: "/shop/offers", count: "offersActive" },
      { id: "new", label: L("New", "नया", "नवीन"), href: "/shop/offers" },
    ],
  },
  {
    id: "analytics",
    label: L("Analytics", "एनालिटिक्स", "विश्लेषण"),
    icon: "chart-line",
    tint: "violet",
    href: "/shop/analytics",
    items: [
      { id: "sales", label: L("Sales", "बिक्री", "विक्री"), href: "/shop/analytics" },
      { id: "top", label: L("Top items", "टॉप आइटम", "टॉप वस्तू"), href: "/shop/analytics" },
    ],
  },
  {
    id: "my-shop",
    label: L("My Shop", "मेरी दुकान", "माझे दुकान"),
    icon: "store",
    tint: "blue",
    href: "/shops/{slug}",
    items: [
      { id: "profile", label: L("Profile", "प्रोफ़ाइल", "प्रोफाइल"), href: "/shop#registration" },
      { id: "area", label: L("Area", "इलाका", "परिसर"), href: "/shop#shop-location" },
      { id: "staff", label: L("Staff", "स्टाफ़", "कर्मचारी"), href: "/shop/staff" },
      { id: "verified", label: L("Verified", "सत्यापित", "पडताळले"), href: "/shop/verification", check: "shopVerified" },
    ],
  },
  {
    id: "delivery-staff",
    label: L("Delivery staff", "डिलीवरी स्टाफ़", "डिलिव्हरी कर्मचारी"),
    icon: "bike",
    tint: "kesari",
    href: "/shop/delivery-staff",
    count: "deliveryStaff",
    items: [
      { id: "riders", label: L("Riders", "राइडर", "रायडर"), href: "/shop/delivery-staff", count: "deliveryStaff" },
      { id: "assign", label: L("Assign", "सौंपें", "नेमा"), href: "/shop/orders" },
    ],
  },
  {
    id: "legal",
    label: L("Legal documents", "कानूनी दस्तावेज़", "कायदेशीर कागदपत्रे"),
    icon: "scroll-text",
    tint: "blue",
    href: "/shop/legal-documents",
    count: "legalPending",
    countTone: "warn",
    items: [
      { id: "licences", label: L("Licences", "लाइसेंस", "परवाने"), href: "/shop/legal-documents", count: "legalPending", countTone: "warn" },
      { id: "terms", label: L("Terms", "शर्तें", "अटी"), href: "/legal/seller-terms" },
    ],
  },
];

/** The shop owner's "Do now" strip: the three things that cost money when left waiting. */
export const SHOP_DO_NOW: readonly BoardItem[] = [
  { id: "new-orders", label: L("New orders", "नए ऑर्डर", "नवीन ऑर्डर"), href: "/shop/orders", count: "ordersNew", countTone: "alert" },
  { id: "returns", label: L("Returns", "वापसी", "परत"), href: "/shop/returns", count: "returnsOpen", countTone: "warn" },
  { id: "low-stock", label: L("Low stock", "कम स्टॉक", "कमी साठा"), href: "/shop/inventory", count: "stockLow", countTone: "warn" },
];

/* --------------------------------------------------------------------- admin */

export const ADMIN_MENUS: readonly BoardMenu[] = [
  {
    id: "shops",
    label: L("Shops", "दुकानें", "दुकाने"),
    icon: "store",
    tint: "kesari",
    href: "/admin/shops",
    count: "shopsPending",
    countTone: "warn",
    items: [
      { id: "approvals", label: L("Approvals", "मंज़ूरी", "मंजुरी"), href: "/admin#shop-approvals", count: "shopsPending", countTone: "warn" },
      { id: "all", label: L("All", "सभी", "सर्व"), href: "/admin/shops", count: "shopsAll", perm: [P.SHOP_PRODUCT_MANAGE_ANY] },
      { id: "verified", label: L("Verified", "सत्यापित", "पडताळले"), href: "/admin/seller-verification", count: "sellerDocsReview", perm: [P.SHOP_GST_PAN_VERIFY] },
      { id: "suspensions", label: L("Suspensions", "निलंबन", "निलंबन"), href: "/admin/suspensions", count: "shopsSuspended", perm: [P.SHOP_SUSPEND] },
      { id: "grade", label: L("Grade", "ग्रेड", "श्रेणी"), href: "/admin#shop-approvals" },
    ],
  },
  {
    id: "users",
    label: L("Users", "यूज़र", "वापरकर्ते"),
    icon: "users",
    tint: "kesari",
    href: "/admin#users",
    count: "usersAll",
    perm: [P.USER_VIEW_ANY],
    items: [
      { id: "customers", label: L("Customers", "ग्राहक", "ग्राहक"), href: "/admin#users", count: "usersCustomers" },
      { id: "owners", label: L("Owners", "दुकानदार", "दुकानदार"), href: "/admin#users", count: "usersOwners" },
      { id: "riders", label: L("Riders", "राइडर", "रायडर"), href: "/admin#delivery-partners", count: "usersRiders", perm: [P.DELIVERY_PARTNER_MANAGE] },
      { id: "staff", label: L("Staff", "स्टाफ़", "कर्मचारी"), href: "/admin#users", count: "usersStaff" },
    ],
  },
  {
    id: "categories",
    label: L("Categories", "श्रेणियाँ", "श्रेणी"),
    icon: "list-tree",
    tint: "kesari",
    href: "/admin/shop-categories",
    items: [
      { id: "shop", label: L("Shop", "दुकान", "दुकान"), href: "/admin/shop-categories", count: "shopCategories" },
      { id: "product", label: L("Product", "प्रोडक्ट", "उत्पादन"), href: "/product-categories", count: "productCategories", perm: [P.CATALOGUE_BROWSE] },
    ],
  },
  {
    id: "product-master",
    label: L("Product master", "प्रोडक्ट मास्टर", "उत्पादन मास्टर"),
    icon: "database",
    tint: "teal",
    href: "/admin/product-master",
    count: "productsReview",
    countTone: "warn",
    perm: [P.PMD_VIEW],
    items: [
      { id: "products", label: L("Products", "प्रोडक्ट", "उत्पादने"), href: "/admin/product-master", count: "productsAll" },
      { id: "review", label: L("Review", "समीक्षा", "तपासणी"), href: "/admin#product-approvals", count: "productsReview", countTone: "warn", perm: [P.PRODUCT_APPROVE] },
      { id: "mrp", label: L("MRP", "MRP", "MRP"), href: "/admin/mrp", perm: [P.PRODUCT_MRP_MANAGE] },
      { id: "ref-prices", label: L("Ref. prices", "संदर्भ दाम", "संदर्भ किंमत"), href: "/admin/price-references", perm: [P.PRICE_REFERENCE_MANAGE] },
      { id: "images", label: L("Images", "फोटो", "फोटो"), href: "/admin/image-moderation", count: "imagesPending", perm: [P.PRODUCT_MANAGE] },
    ],
  },
  {
    id: "privileges",
    label: L("Privileges", "अधिकार", "अधिकार"),
    icon: "shield-check",
    tint: "blue",
    href: "/admin#users",
    perm: [P.USER_VIEW_ANY],
    items: [
      { id: "roles", label: L("Roles", "भूमिकाएँ", "भूमिका"), href: "/admin#users" },
      { id: "perms", label: L("Perms", "अनुमतियाँ", "परवानग्या"), href: "/admin#users", adminOnly: true },
      { id: "audit", label: L("Audit", "ऑडिट", "ऑडिट"), href: "/admin#audit-log", perm: [P.AUDIT_LOG_VIEW, P.AUDIT_LOG_VIEW_LIMITED] },
    ],
  },
  {
    id: "payments",
    label: L("Payments", "भुगतान", "पेमेंट"),
    icon: "credit-card",
    tint: "green",
    href: "/admin/finance",
    count: "refundsPending",
    countTone: "alert",
    perm: [P.FINANCE_VIEW, P.FINANCE_EXCEPTIONS_VIEW, P.COD_CASH_MANAGE],
    items: [
      { id: "settlements", label: L("Settlements", "सेटलमेंट", "सेटलमेंट"), href: "/admin/finance", perm: [P.FINANCE_VIEW] },
      { id: "refunds", label: L("Refunds", "रिफ़ंड", "परतावा"), href: "/admin/bank-refunds", count: "refundsPending", countTone: "alert", perm: [P.FINANCE_VIEW] },
      { id: "cod", label: L("COD cash", "COD नकद", "COD रोख"), href: "/admin/cod", perm: [P.COD_CASH_MANAGE] },
      { id: "rider-pay", label: L("Rider pay", "राइडर भुगतान", "रायडर पेमेंट"), href: "/admin/rider-earnings", perm: [P.DELIVERY_EARNINGS_CONFIG_MANAGE] },
      { id: "wallet-adj", label: L("Wallet adj.", "वॉलेट समायोजन", "वॉलेट समायोजन"), href: "/admin/shop-wallets", perm: [P.WALLET_ADJUST] },
    ],
  },
  {
    id: "disputes",
    label: L("Disputes", "विवाद", "वाद"),
    icon: "scale",
    tint: "pink",
    href: "/admin/disputes",
    count: "disputesOpen",
    countTone: "alert",
    items: [
      { id: "open", label: L("Open", "खुले", "खुले"), href: "/admin/disputes", count: "disputesOpen", countTone: "alert", perm: [P.DISPUTE_MANAGE] },
      { id: "returns", label: L("Returns", "वापसी", "परत"), href: "/admin/returns", count: "returnsOpen" },
      { id: "ratings", label: L("Ratings", "रेटिंग", "रेटिंग"), href: "/admin/ratings", perm: [P.RATING_MODERATE] },
      { id: "grievances", label: L("Grievances", "शिकायतें", "तक्रारी"), href: "/admin#grievances", count: "grievancesOpen", perm: [P.GRIEVANCE_MANAGE] },
    ],
  },
  {
    id: "reports",
    label: L("Reports", "रिपोर्ट", "अहवाल"),
    icon: "file-chart-column",
    tint: "pink",
    href: "/admin/dashboard",
    items: [
      { id: "dashboard", label: L("Dashboard", "डैशबोर्ड", "डॅशबोर्ड"), href: "/admin/dashboard", perm: [P.REPORT_VIEW_ALL, P.REPORT_VIEW_OPERATIONAL] },
      { id: "analytics", label: L("Analytics", "एनालिटिक्स", "विश्लेषण"), href: "/admin/analytics", perm: [P.REPORT_VIEW_ALL, P.REPORT_VIEW_OPERATIONAL] },
      { id: "orders", label: L("Orders", "ऑर्डर", "ऑर्डर"), href: "/admin/orders", perm: [P.ORDER_VIEW_ANY] },
      { id: "history", label: L("History", "इतिहास", "इतिहास"), href: "/admin/status-changes", perm: [P.AUDIT_LOG_VIEW, P.AUDIT_LOG_VIEW_LIMITED] },
      { id: "risk", label: L("Risk", "जोखिम", "जोखीम"), href: "/admin/risk", count: "riskOpen", perm: [P.RISK_REVIEW] },
    ],
  },
  {
    id: "settings",
    label: L("Settings", "सेटिंग", "सेटिंग्ज"),
    icon: "settings",
    tint: "blue",
    href: "/admin/settings",
    items: [
      { id: "rules", label: L("Rules", "नियम", "नियम"), href: "/admin/settings", adminOnly: true },
      { id: "slots", label: L("Slots", "स्लॉट", "स्लॉट"), href: "/admin/delivery-slots", adminOnly: true },
      { id: "coupons", label: L("Coupons", "कूपन", "कूपन"), href: "/admin/coupons", adminOnly: true },
      { id: "campaigns", label: L("Campaigns", "कैंपेन", "मोहिमा"), href: "/admin/campaigns", count: "campaignsSubmitted", perm: [P.MARKETING_APPROVE] },
      { id: "alerts", label: L("Alerts", "अलर्ट", "अलर्ट"), href: "/admin/exceptions", perm: [P.ORDER_VIEW_ANY] },
      { id: "consent", label: L("Consent", "सहमति", "संमती"), href: "/admin/consents", perm: [P.CONSENT_VIEW] },
    ],
  },
];

export const ADMIN_DO_NOW: readonly BoardItem[] = [
  { id: "approvals", label: L("Approvals", "मंज़ूरी", "मंजुरी"), href: "/admin#shop-approvals", count: "shopsPending", countTone: "warn" },
  { id: "reviews", label: L("Reviews", "समीक्षा", "तपासणी"), href: "/admin#product-approvals", count: "productsReview", countTone: "warn" },
  { id: "refunds", label: L("Refunds", "रिफ़ंड", "परतावा"), href: "/admin/bank-refunds", count: "refundsPending", countTone: "alert" },
];

/* ------------------------------------------------------------------ operator */

export const OPERATOR_MENUS: readonly BoardMenu[] = [
  {
    id: "onboarding",
    label: L("Shop onboarding", "दुकान ऑनबोर्डिंग", "दुकान नोंदणी"),
    icon: "clipboard-check",
    tint: "kesari",
    href: "/admin#shop-approvals",
    count: "shopsPending",
    countTone: "warn",
    items: [
      { id: "applications", label: L("Applications", "आवेदन", "अर्ज"), icon: "user-plus", href: "/admin#shop-approvals", count: "shopsPending", countTone: "warn" },
      { id: "documents", label: L("Documents", "दस्तावेज़", "कागदपत्रे"), icon: "file-check", href: "/admin/legal-documents", count: "legalDocsReview", perm: [P.SHOP_GST_PAN_VERIFY] },
      { id: "photos", label: L("Photo checks", "फोटो जाँच", "फोटो तपासणी"), icon: "images", href: "/admin/image-moderation", count: "imagesPending", perm: [P.PRODUCT_MANAGE] },
      { id: "grade", label: L("Quality grade", "क्वालिटी ग्रेड", "गुणवत्ता श्रेणी"), icon: "shield-check", href: "/admin#shop-approvals", perm: [P.SHOP_SET_CLASSIFICATION] },
    ],
  },
  {
    id: "order-support",
    label: L("Order support", "ऑर्डर सहायता", "ऑर्डर मदत"),
    icon: "headset",
    tint: "teal",
    href: "/admin/orders",
    count: "exceptions",
    countTone: "alert",
    perm: [P.ORDER_VIEW_ANY],
    items: [
      { id: "live", label: L("Live orders", "लाइव ऑर्डर", "चालू ऑर्डर"), icon: "package", href: "/admin/orders", count: "ordersLive" },
      { id: "exceptions", label: L("Exceptions", "अपवाद", "अपवाद"), icon: "triangle-alert", href: "/admin/exceptions", count: "exceptions", countTone: "alert" },
      { id: "returns", label: L("Returns", "वापसी", "परत"), icon: "undo-2", href: "/admin/returns", count: "returnsOpen" },
      { id: "cod", label: L("COD cash", "COD नकद", "COD रोख"), icon: "banknote", href: "/admin/cod", perm: [P.COD_CASH_MANAGE] },
    ],
  },
  {
    id: "riders",
    label: L("Riders", "राइडर", "रायडर"),
    icon: "bike",
    tint: "kesari",
    href: "/admin#delivery-partners",
    perm: [P.DELIVERY_PARTNER_MANAGE],
    items: [
      { id: "on-duty", label: L("On duty", "ड्यूटी पर", "ड्युटीवर"), icon: "bike", href: "/admin/dashboard", count: "ridersOnline", perm: [P.REPORT_VIEW_ALL, P.REPORT_VIEW_OPERATIONAL] },
      { id: "applications", label: L("Applications", "आवेदन", "अर्ज"), icon: "user-plus", href: "/admin#delivery-partners", count: "ridersPending", countTone: "warn" },
      { id: "changes", label: L("Profile changes", "प्रोफ़ाइल बदलाव", "प्रोफाइल बदल"), icon: "user-check", href: "/admin/rider-changes", count: "riderChanges", countTone: "warn" },
      { id: "earnings", label: L("Earnings", "कमाई", "कमाई"), icon: "indian-rupee", href: "/admin/rider-earnings", perm: [P.DELIVERY_EARNINGS_CONFIG_MANAGE] },
    ],
  },
  {
    id: "societies",
    label: L("Societies", "सोसायटी", "सोसायट्या"),
    icon: "building-2",
    tint: "teal",
    href: "/admin/societies",
    count: "societies",
    perm: [P.SOCIETY_MANAGE_ANY],
    items: [
      { id: "societies", label: L("Societies", "सोसायटी", "सोसायट्या"), icon: "building-2", href: "/admin/societies", count: "societies" },
      { id: "applied", label: L("To verify", "जाँच बाकी", "पडताळणी बाकी"), icon: "users", href: "/admin/societies?status=APPLIED", count: "societiesApplied", countTone: "warn" },
      { id: "riders", label: L("Society riders", "सोसायटी राइडर", "सोसायटी रायडर"), icon: "bike", href: "/admin/societies", count: "societyRiders" },
    ],
  },
  {
    id: "vouchers",
    label: L("Vouchers", "वाउचर", "व्हाउचर"),
    icon: "ticket",
    tint: "violet",
    href: "/admin#vouchers",
    perm: [P.VOUCHER_VIEW],
    items: [
      { id: "vouchers", label: L("Vouchers", "वाउचर", "व्हाउचर"), icon: "ticket", href: "/admin#vouchers", count: "vouchersActive" },
      { id: "upload", label: L("Bulk upload", "बल्क अपलोड", "बल्क अपलोड"), icon: "upload", href: "/admin#vouchers", perm: [P.VOUCHER_UPLOAD] },
      { id: "redemptions", label: L("Redemptions", "रिडेम्पशन", "वापर"), icon: "receipt-indian-rupee", href: "/admin#vouchers" },
    ],
  },
  {
    id: "tickets",
    label: L("Tickets", "टिकट", "तिकिटे"),
    icon: "life-buoy",
    tint: "violet",
    href: "/admin#grievances",
    count: "ticketsOpen",
    countTone: "warn",
    items: [
      { id: "open", label: L("Open", "खुले", "खुली"), icon: "circle-alert", href: "/admin#grievances", count: "grievancesOpen", countTone: "warn", perm: [P.GRIEVANCE_MANAGE] },
      { id: "escalated", label: L("Escalated", "एस्केलेटेड", "एस्कलेटेड"), icon: "triangle-alert", href: "/admin/disputes?level=L2", count: "disputesEscalated", countTone: "alert", perm: [P.DISPUTE_MANAGE] },
      { id: "grievances", label: L("Grievances", "शिकायतें", "तक्रारी"), icon: "message-square", href: "/admin#grievances", count: "grievancesOpen", perm: [P.GRIEVANCE_MANAGE] },
      { id: "disputes", label: L("Disputes", "विवाद", "वाद"), icon: "scale", href: "/admin/disputes", count: "disputesOpen", perm: [P.DISPUTE_MANAGE] },
    ],
  },
];

/* ------------------------------------------------------------------- helpers */

/** Whether a role may see an entry. An entry with no rule is open to everyone on that board. */
export function allowed(
  entry: { perm?: readonly Permission[]; adminOnly?: boolean },
  role: string,
  can: (permission: Permission) => boolean,
): boolean {
  if (entry.adminOnly && role !== "ADMIN") return false;
  if (entry.perm && !entry.perm.some((permission) => can(permission))) return false;
  return true;
}

/**
 * The menus a role actually gets: entries it may not open are left out, and a
 * menu with nothing left in it goes too.
 */
export function menusFor(
  menus: readonly BoardMenu[],
  role: string,
  can: (permission: Permission) => boolean,
): BoardMenu[] {
  return menus
    .filter((menu) => allowed(menu, role, can))
    .map((menu) => ({ ...menu, items: menu.items.filter((item) => allowed(item, role, can)) }))
    .filter((menu) => menu.items.length > 0);
}

/** Fills `{name}` in a link; a link whose value is missing falls back to `fallback`. */
export function resolveHref(href: string, vars: Record<string, string | undefined>, fallback: string): string {
  let missing = false;
  const out = href.replace(/\{(\w+)\}/g, (_whole, key: string) => {
    const value = vars[key];
    if (!value) missing = true;
    return value ?? "";
  });
  return missing ? fallback : out;
}

/** Menus and submenus on a screen — what the design calls "N menus + M submenus". */
export function countEntries(menus: readonly BoardMenu[]): { menus: number; submenus: number } {
  return { menus: menus.length, submenus: menus.reduce((n, menu) => n + menu.items.length, 0) };
}
