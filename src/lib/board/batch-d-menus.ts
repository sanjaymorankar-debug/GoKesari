/**
 * Tile Board menus of the batch-2026-10 WS-D areas (pure data, like menus.ts):
 *   - the Operator-Limited home `/operator` (F8.4.2);
 *   - the manufacturer portal `/manufacturer` (F9.1.2);
 *   - the product browser `/admin/product-browser` (F9.1.4).
 * Entries name the permission the page they open checks; pages keep their own checks.
 */
import { PERMISSIONS } from "@/server/authz/permissions";

import { L } from "./i18n";
import type { BoardMenu } from "./menus";

export const OPERATOR_LIMITED_MENUS: readonly BoardMenu[] = [
  {
    key: "onboard", label: L("Onboard a shop", "दुकान जोड़ें", "दुकान जोडा"), icon: "user-plus", tone: "kesari", href: "/operator/onboard",
    permission: PERMISSIONS.OPERATOR_LIMITED_ONBOARD,
    items: [
      { key: "start", label: L("Owner code", "मालिक कोड", "मालक कोड"), icon: "key-round", href: "/operator/onboard", permission: PERMISSIONS.OPERATOR_LIMITED_ONBOARD },
      { key: "resume", label: L("Resume", "जारी रखें", "पुढे चालू"), icon: "history", href: "/operator/onboard#open", permission: PERMISSIONS.OPERATOR_LIMITED_ONBOARD },
    ],
  },
  {
    key: "myShops", label: L("My shops", "मेरी दुकानें", "माझी दुकाने"), icon: "store", tone: "teal", href: "/operator/shops",
    permission: PERMISSIONS.OPERATOR_LIMITED_ONBOARD,
    items: [
      { key: "all", label: L("All", "सभी", "सर्व"), icon: "store", href: "/operator/shops", permission: PERMISSIONS.OPERATOR_LIMITED_ONBOARD },
      { key: "pending", label: L("Pending", "लंबित", "प्रलंबित"), icon: "timer", href: "/operator/shops?status=PENDING_APPROVAL", permission: PERMISSIONS.OPERATOR_LIMITED_ONBOARD },
    ],
  },
  {
    key: "documents", label: L("Documents to verify", "जाँच के दस्तावेज़", "तपासायचे दस्तऐवज"), short: L("Documents", "दस्तावेज़", "दस्तऐवज"), icon: "file-check", tone: "violet", href: "/operator/documents",
    permission: PERMISSIONS.OPERATOR_LIMITED_VERIFY_DOCS,
    items: [
      { key: "queue", label: L("To verify", "जाँचें", "तपासा"), icon: "clipboard-check", href: "/operator/documents", permission: PERMISSIONS.OPERATOR_LIMITED_VERIFY_DOCS },
    ],
  },
  {
    key: "payments", label: L("Payment links", "भुगतान लिंक", "पेमेंट लिंक"), icon: "credit-card", tone: "green", href: "/operator/payments",
    permission: PERMISSIONS.OPERATOR_LIMITED_ONBOARD,
    items: [
      { key: "pending", label: L("Waiting", "प्रतीक्षा", "प्रतीक्षा"), icon: "clock", href: "/operator/payments", permission: PERMISSIONS.OPERATOR_LIMITED_ONBOARD },
      { key: "failed", label: L("Failed", "असफल", "अयशस्वी"), icon: "triangle-alert", href: "/operator/payments?status=FAILED", permission: PERMISSIONS.OPERATOR_LIMITED_ONBOARD },
    ],
  },
];

/** Manufacturer portal: membership of a manufacturer account is the access (no permission names). */
export const MANUFACTURER_MENUS: readonly BoardMenu[] = [
  {
    key: "upload", label: L("Upload catalogue", "कैटलॉग अपलोड", "कॅटलॉग अपलोड"), short: L("Upload", "अपलोड", "अपलोड"), icon: "upload", tone: "kesari", href: "/manufacturer/upload",
    items: [
      { key: "file", label: L("CSV / Excel", "CSV / एक्सेल", "CSV / एक्सेल"), icon: "file-spreadsheet", href: "/manufacturer/upload" },
      { key: "template", label: L("Template", "टेम्पलेट", "नमुना"), icon: "file-text", href: "/api/pmd/manufacturer/template?format=xlsx" },
    ],
  },
  {
    key: "jobs", label: L("My imports", "मेरे इम्पोर्ट", "माझे इम्पोर्ट"), icon: "history", tone: "teal", href: "/manufacturer/jobs",
    items: [{ key: "list", label: L("Progress", "प्रगति", "प्रगती"), icon: "timer", href: "/manufacturer/jobs" }],
  },
  {
    key: "keys", label: L("API keys", "API कुंजी", "API की"), icon: "key-round", tone: "violet", href: "/manufacturer/keys",
    items: [{ key: "manage", label: L("Issue / revoke", "बनाएँ / रद्द", "तयार / रद्द"), icon: "lock", href: "/manufacturer/keys" }],
  },
];

export const PRODUCT_BROWSER_MENUS: readonly BoardMenu[] = [
  {
    key: "browse", label: L("Browse products", "उत्पाद देखें", "उत्पादने पहा"), short: L("Browse", "देखें", "पहा"), icon: "search", tone: "teal", href: "/admin/product-browser/search",
    permission: PERMISSIONS.PMD_VIEW,
    items: [
      { key: "staging", label: L("Staging", "स्टेजिंग", "स्टेजिंग"), icon: "database", href: "/admin/product-browser/search?scope=staging", permission: PERMISSIONS.PMD_VIEW },
      { key: "master", label: L("Master", "मास्टर", "मास्टर"), icon: "badge-check", href: "/admin/product-browser/search?scope=master", permission: PERMISSIONS.PMD_VIEW },
    ],
  },
  {
    key: "duplicates", label: L("Duplicates", "डुप्लिकेट", "डुप्लिकेट"), icon: "boxes", tone: "amber", href: "/admin/product-browser/duplicates",
    permission: PERMISSIONS.PMD_REVIEW,
    items: [{ key: "merge", label: L("Compare & merge", "तुलना व मर्ज", "तुलना व मर्ज"), icon: "boxes", href: "/admin/product-browser/duplicates", permission: PERMISSIONS.PMD_REVIEW }],
  },
  {
    key: "jobs", label: L("Imports", "इम्पोर्ट", "इम्पोर्ट"), icon: "upload", tone: "kesari", href: "/admin/product-browser/jobs",
    permission: PERMISSIONS.PMD_IMPORT,
    items: [{ key: "progress", label: L("Progress", "प्रगति", "प्रगती"), icon: "timer", href: "/admin/product-browser/jobs", permission: PERMISSIONS.PMD_IMPORT }],
  },
  {
    key: "sources", label: L("GS1 / Open Food Facts", "GS1 / ओपन फ़ूड फ़ैक्ट्स", "GS1 / ओपन फूड फॅक्ट्स"), short: L("Sources", "स्रोत", "स्रोत"), icon: "database", tone: "blue", href: "/admin/product-browser/sources",
    permission: PERMISSIONS.PMD_IMPORT,
    items: [{ key: "lookup", label: L("Barcode look-up", "बारकोड खोज", "बारकोड शोध"), icon: "search", href: "/admin/product-browser/sources", permission: PERMISSIONS.PMD_IMPORT }],
  },
  {
    key: "manufacturers", label: L("Manufacturers", "निर्माता", "उत्पादक"), icon: "users", tone: "violet", href: "/admin/product-browser/manufacturers",
    permission: PERMISSIONS.PMD_MANUFACTURER_MANAGE,
    items: [{ key: "accounts", label: L("Accounts", "खाते", "खाती"), icon: "user-cog", href: "/admin/product-browser/manufacturers", permission: PERMISSIONS.PMD_MANUFACTURER_MANAGE }],
  },
];
