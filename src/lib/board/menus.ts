/**
 * Tile Board menus — one definition per role, the single source the four
 * home screens, the menu pages ("hubs") and the site header render from
 * (approved design "Theme 1 Tile Board").
 *
 * Every entry names: its label in three languages, its icon, its link, the
 * live figure shown on its badge (if any) and the permission a role needs to
 * see it. Hiding an entry is a convenience; the page it links to keeps its
 * own server-side check.
 *
 * A tile opens one of two places, where all of its submenus are the first
 * thing on screen:
 *  - "page": one page whose tabs or sections are the submenus (Orders →
 *    /shop/orders with New / Packing / Ready / Out tabs);
 *  - "hub": the tile's menu page (/shop/menu/{key}, /admin/menu/{key}) with
 *    every function of that area as a large tile — the submenus shown on the
 *    board plus `more`, the less-used ones. That keeps each board group to at
 *    most seven entries (Hick's law) while every function stays within two
 *    taps of the home screen.
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
  /** Shown on the board (at most seven). */
  items: BoardItem[];
  /** Hub-only entries: the rest of this area's functions. */
  more?: BoardItem[];
  /** Where the tile itself goes: its own page, or its menu page. */
  opens?: "page" | "hub";
}

/* ---------------------------------------------------------------- customer */

/** The eight category tiles under the customer's banners. */
export interface CategoryTile {
  key: string;
  label: Text;
  /** Narrow phone tiles, where the full label would be cut off. */
  short?: Partial<Text>;
  emoji: string;
  bg: string;
  href: string;
  count?: CountKey;
}

export const CUSTOMER_CATEGORIES: readonly CategoryTile[] = [
  { key: "dairy", label: L("Dairy", "डेयरी", "डेअरी"), emoji: "🥛", bg: "bg-sky-50", href: "/shops?type=DAIRY" },
  { key: "bakery", label: L("Bakery", "बेकरी", "बेकरी"), emoji: "🍞", bg: "bg-amber-50", href: "/shops?type=BAKERY" },
  { key: "grocery", label: L("Grocery", "किराना", "किराणा"), emoji: "🍚", bg: "bg-rose-50", href: "/shops?type=GROCERY_KIRANA" },
  { key: "fruitsVeg", label: L("Fruits & Veg", "फल-सब्ज़ी", "फळे-भाज्या"), short: { en: "Fruit, Veg" }, emoji: "🥬", bg: "bg-emerald-50", href: "/shops?type=FRUIT_VEGETABLE" },
  { key: "sweets", label: L("Sweets", "मिठाई", "मिठाई"), emoji: "🍬", bg: "bg-pink-50", href: "/shops?type=SWEET_SHOP" },
  { key: "pharmacy", label: L("Pharmacy", "दवाइयाँ", "औषधे"), short: { en: "Medicine" }, emoji: "💊", bg: "bg-violet-50", href: "/shops?type=PHARMACY" },
  { key: "household", label: L("Household", "घरेलू", "घरगुती"), short: { en: "Home" }, emoji: "🧴", bg: "bg-indigo-50", href: "/shops?type=SUPERMARKET" },
  { key: "all", label: L("All", "सभी", "सर्व"), emoji: "🔎", bg: "bg-slate-100", href: "/categories", count: "shopCategories" },
];

/** Customer tiles each open their own page; the submenus are that page's tabs or sections. */
export const CUSTOMER_MENUS: readonly BoardMenu[] = [
  {
    key: "shops", label: L("Shops", "दुकानें", "दुकाने"), icon: "store", tone: "kesari", href: "/shops", count: "nearbyShops",
    items: [
      { key: "nearby", label: L("Nearby", "पास में", "जवळची"), icon: "map-pin", href: "/shops", count: "nearbyShops" },
      { key: "openNow", label: L("Open now", "अभी खुली", "आता उघडी"), icon: "clock", href: "/shops?open=1", count: "openNowShops" },
      // Mockup: "Favourites" — no favourites feature exists; nearest real destination.
      { key: "deliversHere", label: L("Delivers here", "यहाँ डिलीवरी", "इथे डिलिव्हरी"), short: { en: "Delivers" }, icon: "truck", href: "/shops?delivery=true", count: "deliveringShops" },
      // Was the "Compare prices near you" section under the old home page.
      { key: "compare", label: L("Compare prices", "दाम तुलना", "दर तुलना"), short: { en: "Compare" }, icon: "scale", href: "/search/compare" },
    ],
  },
  {
    key: "orders", label: L("Orders", "ऑर्डर", "ऑर्डर"), icon: "package", tone: "teal", href: "/orders", count: "activeOrders", auth: true,
    items: [
      { key: "active", label: L("Active", "चालू", "चालू"), icon: "package", href: "/orders?tab=active", count: "activeOrders", urgent: true, auth: true },
      { key: "past", label: L("Past", "पुराने", "जुन्या"), icon: "history", href: "/orders?tab=past", count: "pastOrders", auth: true },
      { key: "returns", label: L("Returns", "वापसी", "परतावा"), icon: "undo-2", href: "/returns", count: "openReturns", auth: true },
    ],
  },
  {
    key: "subscriptions", label: L("Subscriptions", "सब्सक्रिप्शन", "सदस्यता"), short: { en: "Subscription" }, icon: "calendar-clock", tone: "blue", href: "/subscriptions", count: "activeSubscriptions", auth: true,
    items: [
      { key: "tomorrow", label: L("Tomorrow", "कल", "उद्या"), icon: "sunrise", href: "/subscriptions#tomorrow", auth: true },
      { key: "calendar", label: L("Calendar", "कैलेंडर", "कॅलेंडर"), icon: "calendar-days", href: "/subscriptions/{subscriptionId}", fallbackHref: "/subscriptions", auth: true },
      { key: "pause", label: L("Pause", "रोकें", "थांबवा"), icon: "pause", href: "/subscriptions/{subscriptionId}", fallbackHref: "/subscriptions", auth: true },
    ],
  },
  {
    key: "wallet", label: L("Wallet", "वॉलेट", "वॉलेट"), icon: "wallet", tone: "green", href: "/wallet#add-money", auth: true,
    items: [
      { key: "addMoney", label: L("Add money", "पैसे जोड़ें", "पैसे भरा"), short: { en: "Top up" }, icon: "plus", href: "/wallet#add-money", auth: true },
      { key: "history", label: L("History", "इतिहास", "इतिहास"), icon: "receipt", href: "/wallet#history", auth: true },
    ],
  },
  {
    key: "tracking", label: L("Tracking", "ट्रैकिंग", "ट्रॅकिंग"), icon: "navigation", tone: "violet", href: "/orders?tab=active", auth: true,
    items: [
      { key: "liveMap", label: L("Live map", "लाइव नक्शा", "नकाशा"), icon: "map", href: "/orders?tab=active#order-{activeOrderNumber}", fallbackHref: "/orders?tab=active", auth: true },
      // Mockup: "Call rider" — the rider's number is deliberately not shown to customers.
      { key: "deliveryCode", label: L("Delivery code", "डिलीवरी कोड", "डिलिव्हरी कोड"), short: { en: "OTP code" }, icon: "key-round", href: "/orders?tab=active", auth: true },
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
  { key: "newOrders", label: L("New orders", "नए ऑर्डर", "नवीन ऑर्डर"), icon: "package", href: "/shop/orders?status=new", count: "shopNew", urgent: true },
  { key: "returns", label: L("Returns", "वापसी", "परतावा"), icon: "undo-2", href: "/shop/returns?tab=requests", count: "shopReturnRequests" },
  { key: "lowStock", label: L("Low stock", "कम स्टॉक", "कमी साठा"), icon: "boxes", href: "/shop/inventory", count: "shopLowStock" },
];

export const SHOP_MENUS: readonly BoardMenu[] = [
  {
    key: "orders", label: L("Orders", "ऑर्डर", "ऑर्डर"), icon: "package", tone: "kesari", href: "/shop/orders", count: "shopActiveOrders", urgent: true,
    items: [
      { key: "new", label: L("New", "नए", "नवीन"), href: "/shop/orders?status=new", count: "shopNew", urgent: true },
      { key: "packing", label: L("Packing", "पैकिंग", "पॅकिंग"), href: "/shop/orders?status=packing", count: "shopPacking" },
      { key: "ready", label: L("Ready", "तैयार", "तयार"), href: "/shop/orders?status=ready", count: "shopReady" },
      { key: "out", label: L("Out", "रास्ते में", "रवाना"), href: "/shop/orders?status=out", count: "shopOut" },
    ],
  },
  {
    key: "returns", label: L("Returns", "वापसी", "परतावा"), icon: "undo-2", tone: "kesari", href: "/shop/returns", count: "shopOpenReturns",
    items: [
      { key: "requests", label: L("Requests", "अनुरोध", "विनंत्या"), href: "/shop/returns?tab=requests", count: "shopReturnRequests" },
      { key: "pickups", label: L("Pickups", "पिकअप", "पिकअप"), href: "/shop/returns?tab=pickups", count: "shopReturnPickups" },
    ],
  },
  {
    key: "disputes", label: L("Disputes", "विवाद", "वाद"), icon: "scale", tone: "kesari", href: "/shop/disputes", count: "shopOpenDisputes", urgent: true,
    items: [
      { key: "open", label: L("Open", "खुले", "उघडे"), href: "/shop/disputes?tab=open", count: "shopOpenDisputes", urgent: true },
      { key: "resolved", label: L("Resolved", "सुलझे", "सुटलेले"), href: "/shop/disputes?tab=resolved" },
    ],
  },
  {
    key: "inventory", label: L("Inventory", "स्टॉक", "साठा"), icon: "boxes", tone: "teal", href: "/shop/inventory", count: "shopLowStock",
    items: [
      { key: "stock", label: L("Stock", "स्टॉक", "साठा"), icon: "boxes", href: "/shop/inventory" },
      { key: "low", label: L("Low", "कम", "कमी"), icon: "triangle-alert", href: "/shop/inventory#alerts", count: "shopLowStock" },
      { key: "onOff", label: L("On/off", "चालू/बंद", "चालू/बंद"), icon: "toggle-right", href: "/shop/manage/products" },
    ],
  },
  {
    key: "photos", label: L("Photo catalogue", "फ़ोटो कैटलॉग", "फोटो कॅटलॉग"), short: L("Photos", "फ़ोटो", "फोटो"), icon: "images", tone: "teal", href: "/shop/catalogue", opens: "hub",
    items: [
      { key: "add", label: L("Add", "जोड़ें", "जोडा"), icon: "upload", href: "/shop/media-import" },
      { key: "pending", label: L("Pending", "लंबित", "प्रलंबित"), icon: "images", href: "/shop/catalogue", count: "shopPendingPhotos" },
    ],
  },
  {
    key: "productCategories", label: L("Product categories", "उत्पाद श्रेणियाँ", "उत्पादन वर्ग"), short: L("Categories", "श्रेणियाँ", "वर्ग"), icon: "list-tree", tone: "teal", href: "/shop/product-categories", opens: "hub",
    items: [
      { key: "mine", label: L("Mine", "मेरी", "माझे"), icon: "list-tree", href: "/shop/product-categories" },
      { key: "all", label: L("All", "सभी", "सर्व"), icon: "search", href: "/product-categories", permission: PERMISSIONS.CATALOGUE_BROWSE },
    ],
    more: [
      { key: "shopTypes", label: L("Shop types I sell", "मेरी दुकान के प्रकार", "माझ्या दुकानाचे प्रकार"), icon: "store", href: "/shop/manage/shop-types" },
    ],
  },
  {
    key: "prices", label: L("Price updates", "दाम अपडेट", "दर बदल"), short: L("Prices", "दाम", "दर"), icon: "tag", tone: "teal", href: "/shop/prices", count: "shopPriceRequests",
    items: [
      { key: "edit", label: L("Edit", "बदलें", "बदला"), icon: "tag", href: "/shop/prices" },
      { key: "excel", label: L("Excel", "एक्सेल", "एक्सेल"), icon: "file-spreadsheet", href: "/shop/prices#excel-upload" },
      { key: "requests", label: L("Requests", "अनुरोध", "विनंत्या"), icon: "clock", href: "/shop/prices#price-requests", count: "shopPriceRequests", urgent: true },
    ],
  },
  {
    key: "finance", label: L("Finance", "वित्त", "वित्त"), icon: "indian-rupee", tone: "green", href: "/shop/finance", permission: PERMISSIONS.SETTLEMENT_VIEW_OWN, opens: "hub",
    items: [
      { key: "settlements", label: L("Settlements", "सेटलमेंट", "सेटलमेंट"), icon: "indian-rupee", href: "/shop/finance#settlements", permission: PERMISSIONS.SETTLEMENT_VIEW_OWN },
      { key: "invoices", label: L("Invoices", "बिल", "बिले"), icon: "receipt", href: "/shop/finance#invoices", permission: PERMISSIONS.SETTLEMENT_VIEW_OWN },
      { key: "gst", label: L("GST", "जीएसटी", "जीएसटी"), icon: "file-text", href: "/shop/gst-returns" },
    ],
    more: [
      { key: "accounting", label: L("Accounting software", "अकाउंटिंग सॉफ़्टवेयर", "अकाउंटिंग सॉफ्टवेअर"), icon: "database", href: "/shop/settings/integrations" },
      { key: "registrationFee", label: L("Registration fee", "पंजीकरण शुल्क", "नोंदणी शुल्क"), icon: "receipt", href: "/shop/manage/registration" },
    ],
  },
  {
    key: "wallet", label: L("Wallet", "वॉलेट", "वॉलेट"), icon: "wallet", tone: "green", href: "/shop/wallet", permission: PERMISSIONS.SETTLEMENT_VIEW_OWN,
    items: [
      { key: "balance", label: L("Balance", "बैलेंस", "शिल्लक"), href: "/shop/wallet", permission: PERMISSIONS.SETTLEMENT_VIEW_OWN },
      { key: "history", label: L("History", "इतिहास", "इतिहास"), href: "/shop/wallet#history", permission: PERMISSIONS.SETTLEMENT_VIEW_OWN },
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
    key: "marketing", label: L("Marketing", "मार्केटिंग", "मार्केटिंग"), icon: "megaphone", tone: "violet", href: "/shop/marketing", permission: PERMISSIONS.MARKETING_MANAGE_OWN, opens: "hub",
    items: [
      { key: "campaigns", label: L("Campaigns", "अभियान", "मोहिमा"), icon: "megaphone", href: "/shop/marketing", permission: PERMISSIONS.MARKETING_MANAGE_OWN },
      { key: "share", label: L("Share", "शेयर", "शेअर"), icon: "store", href: "/shops/{shopSlug}" },
    ],
  },
  {
    key: "offers", label: L("Offers", "ऑफ़र", "ऑफर"), icon: "badge-percent", tone: "violet", href: "/shop/offers", count: "shopActiveOffers", permission: PERMISSIONS.MARKETING_MANAGE_OWN,
    items: [
      { key: "active", label: L("Active", "चालू", "चालू"), href: "/shop/offers", count: "shopActiveOffers", permission: PERMISSIONS.MARKETING_MANAGE_OWN },
      { key: "new", label: L("New", "नया", "नवीन"), href: "/shop/offers#new-offer", permission: PERMISSIONS.MARKETING_MANAGE_OWN },
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
    key: "myShop", label: L("My Shop", "मेरी दुकान", "माझे दुकान"), icon: "store", tone: "blue", href: "/shop/profile-setup", opens: "hub",
    items: [
      { key: "profile", label: L("Profile", "प्रोफ़ाइल", "प्रोफाइल"), icon: "user", href: "/shop/profile-setup" },
      { key: "area", label: L("Area", "क्षेत्र", "क्षेत्र"), icon: "map-pin", href: "/shop/manage/location" },
      // Mockup: "Theme" — no shop theme setting exists; nearest real destination.
      { key: "staff", label: L("Staff", "स्टाफ़", "कर्मचारी"), icon: "users", href: "/shop/staff", permission: PERMISSIONS.SHOP_STAFF_MANAGE_OWN },
      { key: "verified", label: L("Verified", "सत्यापित", "पडताळलेले"), icon: "badge-check", href: "/shop/verification", tick: "shopVerified" },
    ],
    more: [
      { key: "today", label: L("Today's work", "आज का काम", "आजचे काम"), icon: "sunrise", href: "/shop/manage/today" },
      { key: "hours", label: L("Hours & contact", "समय और संपर्क", "वेळ आणि संपर्क"), icon: "clock", href: "/shop/manage/hours" },
      { key: "gstPan", label: L("GST & PAN", "जीएसटी और पैन", "जीएसटी आणि पॅन"), icon: "file-text", href: "/shop/manage/gst-pan" },
      { key: "publicPage", label: L("Public page", "सार्वजनिक पेज", "सार्वजनिक पान"), icon: "store", href: "/shops/{shopSlug}" },
    ],
  },
  {
    key: "delivery", label: L("Delivery staff", "डिलीवरी स्टाफ़", "डिलिव्हरी कर्मचारी"), short: L("Delivery", "डिलीवरी", "डिलिव्हरी"), icon: "bike", tone: "amber", href: "/shop/delivery-staff", count: "shopRiders", opens: "hub",
    items: [
      { key: "riders", label: L("Riders", "राइडर", "रायडर"), icon: "bike", href: "/shop/delivery-staff", count: "shopRiders" },
      { key: "assign", label: L("Assign", "सौंपें", "नेमा"), icon: "route", href: "/shop/orders?status=packing" },
    ],
    more: [
      { key: "today", label: L("Today's deliveries", "आज की डिलीवरी", "आजच्या डिलिव्हऱ्या"), icon: "sunrise", href: "/shop/manage/today" },
    ],
  },
  {
    key: "legal", label: L("Legal documents", "कानूनी दस्तावेज़", "कायदेशीर कागदपत्रे"), short: L("Legal docs", "दस्तावेज़", "कागदपत्रे"), icon: "scroll-text", tone: "blue", href: "/shop/legal-documents", opens: "hub",
    items: [
      { key: "licences", label: L("Licences", "लाइसेंस", "परवाने"), icon: "file-check", href: "/shop/legal-documents" },
      { key: "terms", label: L("Terms", "शर्तें", "अटी"), icon: "scroll-text", href: "/legal/seller-terms" },
    ],
  },
];

/* ------------------------------------------------------------------- admin */

/** Pages that check `role === "ADMIN"` themselves; SYSTEM_CONFIG is admin-only. */
const ADMIN_ONLY = PERMISSIONS.SYSTEM_CONFIG;
const REPORTS = [PERMISSIONS.REPORT_VIEW_ALL, PERMISSIONS.REPORT_VIEW_OPERATIONAL] as const;
const AUDIT = [PERMISSIONS.AUDIT_LOG_VIEW, PERMISSIONS.AUDIT_LOG_VIEW_LIMITED] as const;
const COMPLIANCE = [PERMISSIONS.COMPLIANCE_DASHBOARD_VIEW, PERMISSIONS.SHOP_COMPLIANCE_MANAGE, PERMISSIONS.SHOP_GST_PAN_VERIFY] as const;
/** Every admin and operator holds it: the console sections shown to all staff. */
const STAFF = PERMISSIONS.ORDER_VIEW_ANY;

export const ADMIN_DO_NOW: readonly BoardItem[] = [
  { key: "approvals", label: L("Approvals", "मंज़ूरी", "मंजुरी"), icon: "store", href: "/admin/console/shops", count: "pendingShops", permission: PERMISSIONS.SHOP_APPROVE },
  { key: "reviews", label: L("Reviews", "समीक्षा", "पुनरावलोकन"), icon: "database", href: "/admin/console/product-approvals", count: "pendingProducts", permission: PERMISSIONS.PRODUCT_APPROVE },
  { key: "refunds", label: L("Refunds", "रिफ़ंड", "परतावा"), icon: "credit-card", href: "/admin/bank-refunds", count: "bankRefunds", urgent: true, permission: PERMISSIONS.FINANCE_VIEW },
  { key: "escalated", label: L("Escalated", "एस्केलेटेड", "एस्केलेट"), icon: "triangle-alert", href: "/admin/disputes?status=ESCALATED", count: "escalatedDisputes", urgent: true, permission: PERMISSIONS.DISPUTE_MANAGE },
];

export const ADMIN_MENUS: readonly BoardMenu[] = [
  {
    key: "shops", label: L("Shops", "दुकानें", "दुकाने"), icon: "store", tone: "kesari", href: "/admin/shops", count: "pendingShops", urgent: true, opens: "hub",
    items: [
      { key: "approvals", label: L("Approvals", "मंज़ूरी", "मंजुरी"), icon: "clipboard-check", href: "/admin/console/shops", count: "pendingShops", urgent: true, permission: PERMISSIONS.SHOP_APPROVE },
      { key: "all", label: L("All", "सभी", "सर्व"), icon: "store", href: "/admin/shops", count: "allShops", permission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY },
      { key: "verified", label: L("Verification", "सत्यापन", "पडताळणी"), icon: "badge-check", href: "/admin/seller-verification", count: "sellerReviews", permission: PERMISSIONS.SHOP_GST_PAN_VERIFY },
      { key: "suspensions", label: L("Suspensions", "निलंबन", "निलंबन"), icon: "lock", href: "/admin/suspensions", count: "activeSuspensions", permission: PERMISSIONS.SHOP_SUSPEND },
      { key: "grade", label: L("Grade", "ग्रेड", "श्रेणी"), icon: "shield-check", href: "/admin/console/shops#approved-shops", permission: PERMISSIONS.SHOP_SET_CLASSIFICATION },
    ],
    more: [
      { key: "documents", label: L("Legal documents", "कानूनी दस्तावेज़", "कायदेशीर कागदपत्रे"), icon: "file-check", href: "/admin/legal-documents", count: "legalDocsToReview", permission: PERMISSIONS.SHOP_GST_PAN_VERIFY },
      { key: "compliance", label: L("Compliance & GST/PAN", "अनुपालन व जीएसटी/पैन", "अनुपालन व जीएसटी/पॅन"), icon: "scroll-text", href: "/admin/console/compliance", permission: COMPLIANCE },
      { key: "registrations", label: L("Registrations", "पंजीकरण", "नोंदण्या"), icon: "user-plus", href: "/admin/shop-registrations", permission: PERMISSIONS.SHOP_REGISTRATION_MANAGE },
      { key: "autoApproved", label: L("Auto-approved", "स्वतः मंज़ूर", "स्वयं मंजूर"), icon: "circle-check", href: "/admin/shops/auto-approved", permission: PERMISSIONS.SHOP_REGISTRATION_MANAGE },
      { key: "selfRegistration", label: L("Self-registration", "स्व-पंजीकरण", "स्व-नोंदणी"), icon: "sliders-horizontal", href: "/admin/self-registration", permission: PERMISSIONS.REFERRAL_MANAGE },
      { key: "fees", label: L("Registration fees", "पंजीकरण शुल्क", "नोंदणी शुल्क"), icon: "receipt", href: "/admin/console/registration-fees", permission: STAFF },
      { key: "referralCodes", label: L("Referral codes", "रेफ़रल कोड", "रेफरल कोड"), icon: "ticket", href: "/admin/console/referral-codes", permission: PERMISSIONS.REFERRAL_MANAGE },
      { key: "referralRequests", label: L("Referral requests", "रेफ़रल अनुरोध", "रेफरल विनंत्या"), icon: "message-square", href: "/admin/referral-requests", permission: PERMISSIONS.REFERRAL_MANAGE },
    ],
  },
  {
    key: "users", label: L("Users", "उपयोगकर्ता", "वापरकर्ते"), icon: "users", tone: "kesari", href: "/admin/console/users", count: "users", permission: PERMISSIONS.USER_VIEW_ANY, opens: "hub",
    items: [
      { key: "customers", label: L("Customers", "ग्राहक", "ग्राहक"), icon: "user", href: "/admin/console/users?role=CUSTOMER", count: "customers", permission: PERMISSIONS.USER_VIEW_ANY },
      { key: "owners", label: L("Owners", "दुकानदार", "दुकानदार"), icon: "store", href: "/admin/console/users?role=SHOP_OWNER", count: "owners", permission: PERMISSIONS.USER_VIEW_ANY },
      { key: "riders", label: L("Riders", "राइडर", "रायडर"), icon: "bike", href: "/admin/console/riders", count: "riders", permission: PERMISSIONS.DELIVERY_PARTNER_MANAGE },
      { key: "staff", label: L("Staff", "स्टाफ़", "कर्मचारी"), icon: "user-cog", href: "/admin/console/users?role=STAFF", count: "staff", permission: PERMISSIONS.USER_VIEW_ANY },
    ],
    more: [
      { key: "releaseMobile", label: L("Release a mobile number", "मोबाइल नंबर मुक्त करें", "मोबाइल नंबर मोकळा करा"), icon: "user-check", href: "/admin/console/users#release-mobile", permission: PERMISSIONS.USER_SUSPEND },
      { key: "riderKyc", label: L("Rider documents", "राइडर दस्तावेज़", "रायडर कागदपत्रे"), icon: "file-check", href: "/admin/rider-kyc", permission: ADMIN_ONLY },
      { key: "riderChanges", label: L("Rider profile changes", "राइडर प्रोफ़ाइल बदलाव", "रायडर प्रोफाइल बदल"), icon: "user-check", href: "/admin/rider-changes", count: "riderChanges", permission: PERMISSIONS.DELIVERY_PARTNER_MANAGE },
      { key: "customerReferrals", label: L("Customer referrals", "ग्राहक रेफ़रल", "ग्राहक रेफरल"), icon: "gift", href: "/admin/customer-referrals", permission: ADMIN_ONLY },
      { key: "societies", label: L("Societies", "सोसाइटी", "सोसायट्या"), icon: "building-2", href: "/admin/societies", count: "societiesApplied", permission: PERMISSIONS.SOCIETY_MANAGE_ANY },
    ],
  },
  {
    key: "categories", label: L("Categories", "श्रेणियाँ", "वर्ग"), icon: "list-tree", tone: "kesari", href: "/admin/shop-categories", opens: "hub",
    items: [
      { key: "shop", label: L("Shop", "दुकान", "दुकान"), icon: "store", href: "/admin/shop-categories", count: "shopCategoryCount", permission: PERMISSIONS.CATEGORY_MANAGE },
      { key: "product", label: L("Product", "उत्पाद", "उत्पादन"), icon: "list-tree", href: "/product-categories", count: "productCategories", permission: PERMISSIONS.CATALOGUE_BROWSE },
    ],
  },
  {
    key: "productMaster", label: L("Product master", "प्रोडक्ट मास्टर", "उत्पादन मास्टर"), icon: "database", tone: "teal", href: "/admin/product-master", count: "pendingProducts", opens: "hub",
    items: [
      { key: "products", label: L("Products", "उत्पाद", "उत्पादने"), icon: "database", href: "/admin/product-master", count: "products", permission: PERMISSIONS.PMD_VIEW },
      { key: "review", label: L("Review", "समीक्षा", "पुनरावलोकन"), icon: "clipboard-check", href: "/admin/console/product-approvals", count: "pendingProducts", permission: PERMISSIONS.PRODUCT_APPROVE },
      { key: "mrp", label: L("MRP", "एमआरपी", "एमआरपी"), icon: "tag", href: "/admin/mrp", count: "mrpCorrections", permission: PERMISSIONS.PRODUCT_MRP_MANAGE },
      { key: "refPrices", label: L("Ref. prices", "संदर्भ दाम", "संदर्भ दर"), icon: "scale", href: "/admin/price-references", count: "refPricesToVerify", permission: PERMISSIONS.PRICE_REFERENCE_MANAGE },
      { key: "images", label: L("Images", "फ़ोटो", "फोटो"), icon: "images", href: "/admin/image-moderation", count: "pendingImages", permission: PERMISSIONS.PRODUCT_MANAGE },
    ],
    more: [
      { key: "priceApprovals", label: L("Price approvals", "दाम मंज़ूरी", "दर मंजुरी"), icon: "badge-check", href: "/admin/console/price-approvals", permission: PERMISSIONS.PRICE_REQUEST_DECIDE_ANY },
    ],
  },
  {
    key: "privileges", label: L("Privileges", "अधिकार", "अधिकार"), icon: "shield-check", tone: "blue", href: "/admin/console/users", opens: "hub",
    items: [
      { key: "roles", label: L("Roles", "भूमिकाएँ", "भूमिका"), icon: "user-cog", href: "/admin/console/users", permission: PERMISSIONS.USER_SET_ROLE },
      { key: "perms", label: L("Perms", "अनुमतियाँ", "परवानग्या"), icon: "lock", href: "/admin/console/users#privileges", permission: PERMISSIONS.USER_SET_ROLE },
      { key: "audit", label: L("Audit", "ऑडिट", "ऑडिट"), icon: "history", href: "/admin/console/audit-log", permission: AUDIT },
    ],
  },
  {
    key: "payments", label: L("Payments", "भुगतान", "पेमेंट"), icon: "credit-card", tone: "green", href: "/admin/finance", count: "bankRefunds", urgent: true, opens: "hub",
    items: [
      { key: "settlements", label: L("Settlements", "सेटलमेंट", "सेटलमेंट"), icon: "indian-rupee", href: "/admin/finance", permission: PERMISSIONS.FINANCE_VIEW },
      { key: "refunds", label: L("Refunds", "रिफ़ंड", "परतावा"), icon: "undo-2", href: "/admin/bank-refunds", count: "bankRefunds", urgent: true, permission: PERMISSIONS.FINANCE_VIEW },
      { key: "cod", label: L("COD cash", "COD नकद", "COD रोख"), icon: "banknote", href: "/admin/cod", permission: PERMISSIONS.COD_CASH_MANAGE },
      { key: "riderPay", label: L("Rider pay", "राइडर भुगतान", "रायडर पगार"), icon: "bike", href: "/admin/rider-earnings", permission: PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE },
      { key: "walletAdj", label: L("Wallet adj.", "वॉलेट समायोजन", "वॉलेट बदल"), icon: "wallet", href: "/admin/shop-wallets", permission: PERMISSIONS.WALLET_ADJUST },
    ],
    more: [
      { key: "payIssues", label: L("Pay issues", "भुगतान समस्याएँ", "पेमेंट अडचणी"), icon: "triangle-alert", href: "/admin/finance/exceptions", permission: [PERMISSIONS.FINANCE_VIEW, PERMISSIONS.FINANCE_EXCEPTIONS_VIEW] },
      { key: "bankAccounts", label: L("Bank accounts", "बैंक खाते", "बँक खाती"), icon: "landmark", href: "/admin/bank-accounts", permission: PERMISSIONS.FINANCE_VIEW },
      { key: "subscriptions", label: L("Subscriptions", "सब्सक्रिप्शन", "सदस्यता"), short: { en: "Subscription" }, icon: "calendar-clock", href: "/admin/subscriptions", permission: PERMISSIONS.SUBSCRIPTION_MANAGE_ANY },
      { key: "commissions", label: L("Referral commissions", "रेफ़रल कमीशन", "रेफरल कमिशन"), icon: "receipt", href: "/admin/referral-commissions", permission: PERMISSIONS.REFERRAL_MANAGE },
    ],
  },
  {
    key: "disputes", label: L("Disputes", "विवाद", "वाद"), icon: "scale", tone: "pink", href: "/admin/disputes", count: "liveDisputes", urgent: true, opens: "hub",
    items: [
      { key: "open", label: L("Open", "खुले", "उघडे"), icon: "circle-alert", href: "/admin/disputes", count: "liveDisputes", urgent: true, permission: PERMISSIONS.DISPUTE_MANAGE },
      { key: "returns", label: L("Returns", "वापसी", "परतावा"), icon: "undo-2", href: "/admin/returns", count: "openReturnsAll", permission: PERMISSIONS.ORDER_VIEW_ANY },
      { key: "ratings", label: L("Ratings", "रेटिंग", "रेटिंग"), icon: "star", href: "/admin/ratings", permission: PERMISSIONS.RATING_MODERATE },
      { key: "grievances", label: L("Grievances", "शिकायतें", "तक्रारी"), icon: "message-square", href: "/admin/console/grievances", count: "openGrievances", permission: PERMISSIONS.GRIEVANCE_MANAGE },
    ],
  },
  {
    key: "reports", label: L("Reports", "रिपोर्ट", "अहवाल"), icon: "file-chart-column", tone: "pink", href: "/admin/dashboard", opens: "hub",
    items: [
      { key: "dashboard", label: L("Dashboard", "डैशबोर्ड", "डॅशबोर्ड"), icon: "chart-line", href: "/admin/dashboard", permission: REPORTS },
      { key: "analytics", label: L("Analytics", "विश्लेषण", "विश्लेषण"), icon: "file-chart-column", href: "/admin/analytics", permission: REPORTS },
      { key: "orders", label: L("Orders", "ऑर्डर", "ऑर्डर"), icon: "package", href: "/admin/orders", count: "liveOrders", permission: PERMISSIONS.ORDER_VIEW_ANY },
      { key: "history", label: L("History", "इतिहास", "इतिहास"), icon: "history", href: "/admin/status-changes", permission: AUDIT },
      { key: "risk", label: L("Risk", "जोखिम", "धोका"), icon: "triangle-alert", href: "/admin/risk", count: "openRisk", permission: PERMISSIONS.RISK_REVIEW },
    ],
    more: [
      { key: "figures", label: L("Key figures", "मुख्य आँकड़े", "मुख्य आकडे"), icon: "chart-line", href: "/admin/console/overview", permission: STAFF },
      { key: "maps", label: L("Maps usage", "मैप उपयोग", "नकाशा वापर"), icon: "map", href: "/admin/console/maps", permission: PERMISSIONS.MAPS_USAGE_VIEW },
    ],
  },
  {
    key: "settings", label: L("Settings", "सेटिंग्स", "सेटिंग्ज"), icon: "settings", tone: "blue", href: "/admin/settings", opens: "hub",
    items: [
      { key: "rules", label: L("Rules", "नियम", "नियम"), icon: "sliders-horizontal", href: "/admin/settings", permission: ADMIN_ONLY },
      { key: "slots", label: L("Slots", "स्लॉट", "स्लॉट"), icon: "clock", href: "/admin/delivery-slots", permission: ADMIN_ONLY },
      { key: "coupons", label: L("Coupons", "कूपन", "कूपन"), icon: "badge-percent", href: "/admin/coupons", permission: ADMIN_ONLY },
      { key: "campaigns", label: L("Campaigns", "अभियान", "मोहिमा"), icon: "megaphone", href: "/admin/campaigns", count: "submittedCampaigns", permission: PERMISSIONS.MARKETING_APPROVE },
      { key: "alerts", label: L("Alerts", "अलर्ट", "सूचना"), icon: "triangle-alert", href: "/admin/exceptions", count: "opsExceptions", urgent: true, permission: PERMISSIONS.ORDER_VIEW_ANY },
      { key: "consent", label: L("Consent", "सहमति", "संमती"), icon: "file-check", href: "/admin/consents", permission: PERMISSIONS.CONSENT_VIEW },
    ],
    more: [
      { key: "vouchers", label: L("Vouchers", "वाउचर", "व्हाउचर"), icon: "ticket", href: "/admin/console/vouchers", count: "activeVouchers", permission: PERMISSIONS.VOUCHER_VIEW },
      { key: "gst", label: L("GST settings", "जीएसटी सेटिंग", "जीएसटी सेटिंग्ज"), icon: "file-text", href: "/admin/gst-config", permission: PERMISSIONS.GST_CONFIG_MANAGE },
      { key: "integrations", label: L("Accounting sync", "अकाउंटिंग सिंक", "अकाउंटिंग सिंक"), icon: "database", href: "/admin/integrations", permission: PERMISSIONS.INTEGRATION_VIEW_ANY },
      { key: "testMessages", label: L("Test messages", "टेस्ट संदेश", "चाचणी संदेश"), icon: "message-square", href: "/admin/test-messages", permission: PERMISSIONS.SHOP_REGISTRATION_MANAGE },
    ],
  },
];

/* ---------------------------------------------------------------- operator */

export const OPERATOR_DO_NOW: readonly BoardItem[] = [
  { key: "exceptions", label: L("Late orders", "देर वाले ऑर्डर", "उशिराच्या ऑर्डर"), icon: "timer", href: "/admin/exceptions", count: "opsExceptions", urgent: true, permission: PERMISSIONS.ORDER_VIEW_ANY },
  { key: "applications", label: L("Shop applications", "दुकान आवेदन", "दुकान अर्ज"), icon: "store", href: "/admin/console/shops", count: "pendingShops", permission: PERMISSIONS.SHOP_APPROVE },
  { key: "tickets", label: L("Open tickets", "खुले टिकट", "उघडी तिकिटे"), icon: "life-buoy", href: "/admin/disputes?status=OPEN", count: "openDisputes", urgent: true, permission: PERMISSIONS.DISPUTE_MANAGE },
  { key: "riderApps", label: L("Rider applications", "राइडर आवेदन", "रायडर अर्ज"), icon: "bike", href: "/admin/console/riders", count: "riderApplications", permission: PERMISSIONS.DELIVERY_PARTNER_MANAGE },
];

export const OPERATOR_MENUS: readonly BoardMenu[] = [
  {
    key: "onboarding", label: L("Shop onboarding", "दुकान ऑनबोर्डिंग", "दुकान नोंदणी"), short: L("Onboarding", "ऑनबोर्डिंग", "नोंदणी"), icon: "clipboard-check", tone: "kesari", href: "/admin/console/shops", count: "pendingShops", opens: "hub",
    items: [
      { key: "applications", label: L("Applications", "आवेदन", "अर्ज"), icon: "user-plus", href: "/admin/console/shops", count: "pendingShops", permission: PERMISSIONS.SHOP_APPROVE },
      { key: "documents", label: L("Documents", "दस्तावेज़", "कागदपत्रे"), icon: "file-check", href: "/admin/legal-documents", count: "legalDocsToReview", permission: PERMISSIONS.SHOP_GST_PAN_VERIFY },
      { key: "photoChecks", label: L("Photo checks", "फ़ोटो जाँच", "फोटो तपासणी"), icon: "images", href: "/admin/image-moderation", count: "pendingImages", permission: PERMISSIONS.PRODUCT_MANAGE },
      { key: "grade", label: L("Quality grade", "गुणवत्ता ग्रेड", "गुणवत्ता श्रेणी"), icon: "shield-check", href: "/admin/console/shops#approved-shops", permission: PERMISSIONS.SHOP_SET_CLASSIFICATION },
    ],
    more: [
      { key: "verification", label: L("Verification", "सत्यापन", "पडताळणी"), icon: "badge-check", href: "/admin/seller-verification", count: "sellerReviews", permission: PERMISSIONS.SHOP_GST_PAN_VERIFY },
      { key: "allShops", label: L("All shops", "सभी दुकानें", "सर्व दुकाने"), icon: "store", href: "/admin/shops", count: "allShops", permission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY },
      { key: "suspensions", label: L("Suspensions", "निलंबन", "निलंबन"), icon: "lock", href: "/admin/suspensions", count: "activeSuspensions", permission: PERMISSIONS.SHOP_SUSPEND },
      { key: "compliance", label: L("Compliance & GST/PAN", "अनुपालन व जीएसटी/पैन", "अनुपालन व जीएसटी/पॅन"), icon: "scroll-text", href: "/admin/console/compliance", permission: COMPLIANCE },
      { key: "registrations", label: L("Registrations", "पंजीकरण", "नोंदण्या"), icon: "user-plus", href: "/admin/shop-registrations", permission: PERMISSIONS.SHOP_REGISTRATION_MANAGE },
      { key: "autoApproved", label: L("Auto-approved", "स्वतः मंज़ूर", "स्वयं मंजूर"), icon: "circle-check", href: "/admin/shops/auto-approved", permission: PERMISSIONS.SHOP_REGISTRATION_MANAGE },
      { key: "selfRegistration", label: L("Self-registration", "स्व-पंजीकरण", "स्व-नोंदणी"), icon: "sliders-horizontal", href: "/admin/self-registration", permission: PERMISSIONS.REFERRAL_MANAGE },
      { key: "fees", label: L("Registration fees", "पंजीकरण शुल्क", "नोंदणी शुल्क"), icon: "receipt", href: "/admin/console/registration-fees", permission: STAFF },
      { key: "referralCodes", label: L("Referral codes", "रेफ़रल कोड", "रेफरल कोड"), icon: "ticket", href: "/admin/console/referral-codes", permission: PERMISSIONS.REFERRAL_MANAGE },
      { key: "referralRequests", label: L("Referral requests", "रेफ़रल अनुरोध", "रेफरल विनंत्या"), icon: "message-square", href: "/admin/referral-requests", permission: PERMISSIONS.REFERRAL_MANAGE },
    ],
  },
  {
    key: "orderSupport", label: L("Order support", "ऑर्डर सहायता", "ऑर्डर मदत"), icon: "headset", tone: "teal", href: "/admin/exceptions", count: "opsExceptions", urgent: true, opens: "hub",
    items: [
      { key: "liveOrders", label: L("Live orders", "चालू ऑर्डर", "चालू ऑर्डर"), icon: "package", href: "/admin/orders", count: "liveOrders", permission: PERMISSIONS.ORDER_VIEW_ANY },
      { key: "exceptions", label: L("Exceptions", "अपवाद", "अडचणी"), icon: "triangle-alert", href: "/admin/exceptions", count: "opsExceptions", urgent: true, permission: PERMISSIONS.ORDER_VIEW_ANY },
      { key: "returns", label: L("Returns", "वापसी", "परतावा"), icon: "undo-2", href: "/admin/returns", count: "openReturnsAll", permission: PERMISSIONS.ORDER_VIEW_ANY },
      { key: "cod", label: L("COD cash", "COD नकद", "COD रोख"), icon: "banknote", href: "/admin/cod", permission: PERMISSIONS.COD_CASH_MANAGE },
    ],
    more: [
      { key: "dashboard", label: L("Dashboard", "डैशबोर्ड", "डॅशबोर्ड"), icon: "chart-line", href: "/admin/dashboard", permission: REPORTS },
      { key: "analytics", label: L("Analytics", "विश्लेषण", "विश्लेषण"), icon: "file-chart-column", href: "/admin/analytics", permission: REPORTS },
      { key: "history", label: L("Status history", "स्थिति इतिहास", "स्थिती इतिहास"), icon: "history", href: "/admin/status-changes", permission: AUDIT },
      { key: "risk", label: L("Risk", "जोखिम", "धोका"), icon: "triangle-alert", href: "/admin/risk", count: "openRisk", permission: PERMISSIONS.RISK_REVIEW },
      { key: "ratings", label: L("Ratings", "रेटिंग", "रेटिंग"), icon: "star", href: "/admin/ratings", permission: PERMISSIONS.RATING_MODERATE },
      { key: "campaigns", label: L("Campaigns", "अभियान", "मोहिमा"), icon: "megaphone", href: "/admin/campaigns", count: "submittedCampaigns", permission: PERMISSIONS.MARKETING_APPROVE },
      { key: "integrations", label: L("Accounting sync", "अकाउंटिंग सिंक", "अकाउंटिंग सिंक"), icon: "database", href: "/admin/integrations", permission: PERMISSIONS.INTEGRATION_VIEW_ANY },
      { key: "testMessages", label: L("Test messages", "टेस्ट संदेश", "चाचणी संदेश"), icon: "message-square", href: "/admin/test-messages", permission: PERMISSIONS.SHOP_REGISTRATION_MANAGE },
      { key: "figures", label: L("Key figures", "मुख्य आँकड़े", "मुख्य आकडे"), icon: "chart-line", href: "/admin/console/overview", permission: STAFF },
    ],
  },
  {
    key: "riders", label: L("Riders", "राइडर", "रायडर"), icon: "bike", tone: "kesari", href: "/admin/console/riders", count: "ridersOnDuty", opens: "hub",
    items: [
      { key: "onDuty", label: L("On duty", "ड्यूटी पर", "ड्युटीवर"), icon: "bike", href: "/admin/console/riders", count: "ridersOnDuty", permission: PERMISSIONS.DELIVERY_PARTNER_MANAGE },
      { key: "applications", label: L("Applications", "आवेदन", "अर्ज"), icon: "user-plus", href: "/admin/console/riders#applications", count: "riderApplications", permission: PERMISSIONS.DELIVERY_PARTNER_MANAGE },
      { key: "profileChanges", label: L("Profile changes", "प्रोफ़ाइल बदलाव", "प्रोफाइल बदल"), icon: "user-check", href: "/admin/rider-changes", count: "riderChanges", permission: PERMISSIONS.DELIVERY_PARTNER_MANAGE },
      // Rider earnings rules are admin-only; operators work the money exceptions (missing rider earnings among them).
      { key: "earnings", label: L("Pay issues", "भुगतान समस्याएँ", "पेमेंट अडचणी"), icon: "indian-rupee", href: "/admin/finance/exceptions", permission: PERMISSIONS.FINANCE_EXCEPTIONS_VIEW },
    ],
  },
  {
    key: "societies", label: L("Societies", "सोसाइटी", "सोसायट्या"), icon: "building-2", tone: "teal", href: "/admin/societies", count: "societies", opens: "hub",
    items: [
      { key: "societies", label: L("Societies", "सोसाइटी", "सोसायट्या"), icon: "building-2", href: "/admin/societies", count: "societiesApplied", permission: PERMISSIONS.SOCIETY_MANAGE_ANY },
      { key: "members", label: L("Members", "सदस्य", "सदस्य"), icon: "users", href: "/admin/societies?status=VERIFIED", count: "societyMembers", permission: PERMISSIONS.SOCIETY_MANAGE_ANY },
      { key: "societyRiders", label: L("Society riders", "सोसाइटी राइडर", "सोसायटी रायडर"), icon: "bike", href: "/admin/societies?status=VERIFIED", count: "societyRiders", permission: PERMISSIONS.SOCIETY_MANAGE_ANY },
    ],
  },
  {
    key: "vouchers", label: L("Vouchers", "वाउचर", "व्हाउचर"), icon: "ticket", tone: "violet", href: "/admin/console/vouchers", count: "activeVouchers", opens: "hub",
    items: [
      { key: "vouchers", label: L("Vouchers", "वाउचर", "व्हाउचर"), icon: "ticket", href: "/admin/console/vouchers", count: "activeVouchers", permission: PERMISSIONS.VOUCHER_VIEW },
      { key: "bulkUpload", label: L("Bulk upload", "बल्क अपलोड", "एकत्र अपलोड"), icon: "upload", href: "/admin/console/vouchers#voucher-upload", permission: PERMISSIONS.VOUCHER_UPLOAD },
      { key: "redemptions", label: L("Redemptions", "रिडेम्पशन", "वापर"), icon: "receipt", href: "/admin/console/vouchers#redemptions", count: "voucherRedemptions", permission: PERMISSIONS.VOUCHER_VIEW },
    ],
  },
  {
    key: "tickets", label: L("Tickets", "टिकट", "तिकिटे"), icon: "life-buoy", tone: "violet", href: "/admin/disputes", count: "liveDisputes", urgent: true, opens: "hub",
    items: [
      { key: "open", label: L("Open", "खुले", "उघडे"), icon: "circle-alert", href: "/admin/disputes?status=OPEN", count: "openDisputes", urgent: true, permission: PERMISSIONS.DISPUTE_MANAGE },
      { key: "escalated", label: L("Escalated", "एस्केलेटेड", "एस्केलेट"), icon: "triangle-alert", href: "/admin/disputes?status=ESCALATED", count: "escalatedDisputes", urgent: true, permission: PERMISSIONS.DISPUTE_MANAGE },
      { key: "grievances", label: L("Grievances", "शिकायतें", "तक्रारी"), icon: "message-square", href: "/admin/console/grievances", count: "openGrievances", permission: PERMISSIONS.GRIEVANCE_MANAGE },
      { key: "disputes", label: L("Disputes", "विवाद", "वाद"), icon: "scale", href: "/admin/disputes", count: "liveDisputes", permission: PERMISSIONS.DISPUTE_MANAGE },
    ],
    more: [
      { key: "consent", label: L("Consent records", "सहमति रिकॉर्ड", "संमती नोंदी"), icon: "file-check", href: "/admin/consents", permission: PERMISSIONS.CONSENT_VIEW },
    ],
  },
  {
    // Not in the six operator menus of the brief: the catalogue tools operators already had in the old menu need one home.
    key: "catalogue", label: L("Catalogue", "कैटलॉग", "कॅटलॉग"), icon: "database", tone: "teal", href: "/admin/product-master", count: "pendingProducts", opens: "hub",
    items: [
      { key: "products", label: L("Products", "उत्पाद", "उत्पादने"), icon: "database", href: "/admin/product-master", count: "products", permission: PERMISSIONS.PMD_VIEW },
      { key: "review", label: L("Review", "समीक्षा", "पुनरावलोकन"), icon: "clipboard-check", href: "/admin/console/product-approvals", count: "pendingProducts", permission: PERMISSIONS.PRODUCT_APPROVE },
      { key: "mrp", label: L("MRP", "एमआरपी", "एमआरपी"), icon: "tag", href: "/admin/mrp", count: "mrpCorrections", permission: PERMISSIONS.PRODUCT_MRP_MANAGE },
      { key: "refPrices", label: L("Ref. prices", "संदर्भ दाम", "संदर्भ दर"), icon: "scale", href: "/admin/price-references", count: "refPricesToVerify", permission: PERMISSIONS.PRICE_REFERENCE_MANAGE },
    ],
    more: [
      { key: "priceApprovals", label: L("Price approvals", "दाम मंज़ूरी", "दर मंजुरी"), icon: "badge-check", href: "/admin/console/price-approvals", permission: PERMISSIONS.PRICE_REQUEST_DECIDE_ANY },
      { key: "shopCategories", label: L("Shop categories", "दुकान श्रेणियाँ", "दुकान वर्ग"), icon: "store", href: "/admin/shop-categories", permission: PERMISSIONS.CATEGORY_MANAGE },
      { key: "productCategories", label: L("Product categories", "उत्पाद श्रेणियाँ", "उत्पादन वर्ग"), icon: "list-tree", href: "/product-categories", permission: PERMISSIONS.CATALOGUE_BROWSE },
    ],
  },
];

export const MENUS: Readonly<Record<BoardRole, readonly BoardMenu[]>> = {
  customer: CUSTOMER_MENUS,
  shop: SHOP_MENUS,
  admin: ADMIN_MENUS,
  operator: OPERATOR_MENUS,
};

export const DO_NOW: Readonly<Record<Exclude<BoardRole, "customer">, readonly BoardItem[]>> = {
  shop: SHOP_DO_NOW,
  admin: ADMIN_DO_NOW,
  operator: OPERATOR_DO_NOW,
};

/** The menu page of a hub tile: /shop/menu/{key} or /admin/menu/{key}. */
export function hubHref(role: BoardRole, key: string): string | null {
  if (role === "shop") return `/shop/menu/${key}`;
  if (role === "admin" || role === "operator") return `/admin/menu/${key}`;
  return null;
}

/** The board a role works from — its home screen. */
export function boardRoleFor(role: UserRole | string | null | undefined): BoardRole {
  if (role === "SHOP_OWNER") return "shop";
  if (role === "ADMIN") return "admin";
  if (role === "OPERATOR") return "operator";
  return "customer";
}

/** Home screen (board) of each role. */
export const BOARD_HOME: Readonly<Record<BoardRole, string>> = {
  customer: "/",
  shop: "/shop",
  admin: "/admin",
  operator: "/admin",
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
export type ResolvedMenu = Resolved<Omit<BoardMenu, "items" | "more">> & { items: Resolved<BoardItem>[]; more: Resolved<BoardItem>[] };

/**
 * The menus a role sees: entries it is not permitted to open are dropped, as
 * are entries whose link cannot be resolved. A tile with no entries left is
 * dropped too.
 *
 * A hub tile opens its menu page when `board` is given (the hub lists only
 * what the role may open). A page tile links to its own page only when that
 * page is one of its permitted submenus, or none of its entries needs a
 * permission — so it is never a way round a hidden entry; otherwise it opens
 * its first remaining submenu.
 */
export function visibleMenus(menus: readonly BoardMenu[], role: UserRole, params: LinkParams = {}, board?: BoardRole): ResolvedMenu[] {
  const out: ResolvedMenu[] = [];
  for (const menu of menus) {
    if (menu.permission && !isPermitted(menu, role)) continue;
    const items = visibleItems(menu.items, role, params);
    const more = visibleItems(menu.more ?? [], role, params);
    if (items.length === 0 && more.length === 0) continue;
    const hub = menu.opens === "hub" && board ? hubHref(board, menu.key) : null;
    const ownHref = resolveHref(menu.href, params, menu.fallbackHref);
    const page = (href: string) => href.split(/[?#]/)[0];
    // A tile none of whose entries needs a permission (e.g. the customer's Profile) keeps its own page.
    const open = [...menu.items, ...(menu.more ?? [])].every((item) => !item.permission);
    const reachable = ownHref != null && (open || [...items, ...more].some((item) => page(item.href) === page(ownHref)));
    const href = hub ?? (reachable ? ownHref : (items[0] ?? more[0]).href);
    const { more: _more, ...rest } = menu;
    void _more;
    out.push({ ...rest, href, items, more });
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
    ...Object.values(MENUS).flatMap((menus) => menus.flatMap((m) => [m, ...m.items, ...(m.more ?? [])])),
    ...Object.values(DO_NOW).flat(),
  ];
  return [
    ...items.flatMap((i) => [i.href, ...(i.fallbackHref ? [i.fallbackHref] : [])]),
    ...CUSTOMER_CATEGORIES.map((c) => c.href),
  ];
}
