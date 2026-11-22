/**
 * RBAC v2 staff board (docs/rbac): one Tile Board at /staff for the CA, Accountant, Support
 * Manager, Support User, Operations Manager and Operations User. Each entry names the permission
 * the page it opens checks (pages keep their own checks), so every role sees only its own tiles.
 * Entries of an area that is not built or not switched on carry `feature` and stay hidden while
 * that rbac_v2_* flag is off.
 */
import { PERMISSIONS } from "@/server/authz/permissions";

import { L } from "./i18n";
import type { BoardMenu } from "./menus";

export const STAFF_MENUS: readonly BoardMenu[] = [
  /* ------------------------------------------------ CA and Accountant */
  {
    key: "finance", label: L("Finance", "वित्त", "वित्त"), icon: "indian-rupee", tone: "green", href: "/admin/finance",
    permission: PERMISSIONS.FINANCE_VIEW,
    items: [
      { key: "overview", label: L("Overview", "सारांश", "सारांश"), icon: "chart-line", href: "/admin/finance", permission: PERMISSIONS.FINANCE_VIEW },
      { key: "payments", label: L("Gateway payments", "गेटवे भुगतान", "गेटवे पेमेंट"), short: L("Payments", "भुगतान", "पेमेंट"), icon: "credit-card", href: "/admin/payments/cashfree", permission: PERMISSIONS.FINANCE_VIEW },
      { key: "riderPayouts", label: L("Rider payouts", "राइडर भुगतान", "रायडर पेमेंट"), icon: "bike", href: "/admin/rider-payouts", permission: PERMISSIONS.FINANCE_VIEW },
      { key: "refunds", label: L("Bank refunds", "बैंक रिफंड", "बँक परतावा"), short: L("Refunds", "रिफंड", "परतावा"), icon: "refresh-cw", href: "/admin/bank-refunds", permission: PERMISSIONS.FINANCE_VIEW },
    ],
  },
  {
    key: "statutory", label: L("Tax and statutory", "कर और वैधानिक", "कर व वैधानिक"), short: L("Tax", "कर", "कर"), icon: "landmark", tone: "violet", href: "/admin/statutory",
    permission: [PERMISSIONS.STATUTORY_MANAGE, PERMISSIONS.COMMISSION_TDS_MANAGE],
    items: [
      { key: "rates", label: L("Statutory rates", "वैधानिक दरें", "वैधानिक दर"), short: L("Rates", "दरें", "दर"), icon: "scale", href: "/admin/statutory", permission: PERMISSIONS.STATUTORY_MANAGE },
      { key: "tds", label: L("Commission TDS", "कमीशन TDS", "कमिशन TDS"), short: L("TDS", "TDS", "TDS"), icon: "receipt", href: "/admin/tds-commission", permission: PERMISSIONS.COMMISSION_TDS_MANAGE },
    ],
  },
  {
    key: "accounting", label: L("Accounting", "लेखा", "लेखा"), icon: "file-spreadsheet", tone: "blue", href: "/staff/accounting",
    permission: [PERMISSIONS.JOURNAL_PREPARE, PERMISSIONS.JOURNAL_APPROVE],
    feature: "rbac_v2_accounting",
    items: [
      { key: "journals", label: L("Journal entries", "जर्नल प्रविष्टियाँ", "जर्नल नोंदी"), short: L("Journals", "जर्नल", "जर्नल"), icon: "scroll-text", href: "/staff/accounting?tab=journals", permission: [PERMISSIONS.JOURNAL_PREPARE, PERMISSIONS.JOURNAL_APPROVE], feature: "rbac_v2_accounting" },
      { key: "periods", label: L("Periods", "अवधि", "कालावधी"), icon: "calendar-days", href: "/staff/accounting?tab=periods", permission: [PERMISSIONS.FIN_PERIOD_CLOSE, PERMISSIONS.JOURNAL_PREPARE], feature: "rbac_v2_accounting" },
      { key: "approve", label: L("To approve", "स्वीकृति हेतु", "मंजुरीसाठी"), icon: "badge-check", href: "/staff/accounting?tab=approvals", permission: PERMISSIONS.JOURNAL_APPROVE, feature: "rbac_v2_accounting" },
      { key: "tb", label: L("Trial balance", "ट्रायल बैलेंस", "ट्रायल बॅलन्स"), short: L("Trial bal.", "ट्रायल", "ट्रायल"), icon: "file-chart-column", href: "/staff/accounting?tab=tb", permission: [PERMISSIONS.JOURNAL_PREPARE, PERMISSIONS.JOURNAL_APPROVE], feature: "rbac_v2_accounting" },
      { key: "rates", label: L("Rate changes", "दर परिवर्तन", "दर बदल"), short: L("Rates", "दरें", "दर"), icon: "badge-percent", href: "/staff/accounting?tab=rates", permission: [PERMISSIONS.RATE_PROPOSE, PERMISSIONS.RATE_APPROVE], feature: "rbac_v2_accounting" },
    ],
  },
  /* ------------------------------------------------------------- Support */
  {
    key: "support", label: L("Support queue", "सहायता कतार", "सहाय्य रांग"), short: L("Support", "सहायता", "सहाय्य"), icon: "headset", tone: "teal", href: "/admin/support",
    permission: PERMISSIONS.SUPPORT_TICKET_MANAGE,
    items: [
      { key: "tickets", label: L("All tickets", "सभी टिकट", "सर्व तिकिटे"), short: L("Tickets", "टिकट", "तिकिटे"), icon: "ticket", href: "/admin/support", permission: PERMISSIONS.SUPPORT_TICKET_MANAGE },
      { key: "disputes", label: L("Disputes", "विवाद", "वाद"), icon: "scale", href: "/admin/disputes", permission: PERMISSIONS.DISPUTE_MANAGE },
      { key: "team", label: L("Team workload", "टीम कार्यभार", "टीम कामभार"), short: L("Team", "टीम", "टीम"), icon: "users", href: "/staff/support/team", permission: PERMISSIONS.SUPPORT_QUEUE_MANAGE, feature: "rbac_v2_support" },
    ],
  },
  {
    key: "myWork", label: L("My work", "मेरा काम", "माझे काम"), icon: "clipboard-check", tone: "teal", href: "/staff/support/mine",
    permission: PERMISSIONS.SUPPORT_TICKET_WORK_ASSIGNED,
    feature: "rbac_v2_support",
    items: [
      { key: "tickets", label: L("My tickets", "मेरे टिकट", "माझी तिकिटे"), short: L("Tickets", "टिकट", "तिकिटे"), icon: "ticket", href: "/staff/support/mine", permission: PERMISSIONS.SUPPORT_TICKET_WORK_ASSIGNED, feature: "rbac_v2_support" },
      { key: "changes", label: L("Changes sent to owners", "मालिकों को भेजे बदलाव", "मालकांना पाठवलेले बदल"), short: L("Changes", "बदलाव", "बदल"), icon: "history", href: "/staff/support/changes", permission: PERMISSIONS.SHOP_CHANGE_PROPOSE, feature: "rbac_v2_shop_change_requests" },
    ],
  },
  /* ---------------------------------------------------------- Operations */
  {
    key: "onboard", label: L("Onboard a shop", "दुकान जोड़ें", "दुकान जोडा"), icon: "user-plus", tone: "kesari", href: "/operator",
    permission: PERMISSIONS.OPERATOR_LIMITED_ONBOARD,
    items: [
      { key: "start", label: L("Onboard", "जोड़ें", "जोडा"), icon: "user-plus", href: "/operator/onboard", permission: PERMISSIONS.OPERATOR_LIMITED_ONBOARD },
      { key: "shops", label: L("My shops", "मेरी दुकानें", "माझी दुकाने"), icon: "store", href: "/operator/shops", permission: PERMISSIONS.OPERATOR_LIMITED_ONBOARD },
      { key: "documents", label: L("Documents", "दस्तावेज़", "दस्तऐवज"), icon: "file-check", href: "/operator/documents", permission: PERMISSIONS.OPERATOR_LIMITED_VERIFY_DOCS },
    ],
  },
  {
    key: "ops", label: L("Operations team", "ऑपरेशंस टीम", "ऑपरेशन्स टीम"), short: L("Operations", "ऑपरेशंस", "ऑपरेशन्स"), icon: "map", tone: "amber", href: "/staff/ops",
    permission: [PERMISSIONS.OPS_TEAM_MANAGE, PERMISSIONS.OPS_TASK_WORK_OWN],
    feature: "rbac_v2_operations",
    items: [
      { key: "tasks", label: L("Tasks", "कार्य", "कामे"), icon: "clipboard-check", href: "/staff/ops/tasks", permission: [PERMISSIONS.OPS_TEAM_MANAGE, PERMISSIONS.OPS_TASK_WORK_OWN], feature: "rbac_v2_operations" },
      { key: "reports", label: L("Onboarding reports", "ऑनबोर्डिंग रिपोर्ट", "ऑनबोर्डिंग अहवाल"), short: L("Reports", "रिपोर्ट", "अहवाल"), icon: "file-chart-column", href: "/staff/ops/reports", permission: PERMISSIONS.OPS_REPORT_VIEW, feature: "rbac_v2_operations" },
    ],
  },
  {
    key: "help", label: L("Raise a ticket", "टिकट बनाएँ", "तिकीट करा"), short: L("Help", "सहायता", "मदत"), icon: "life-buoy", tone: "pink", href: "/support",
    permission: PERMISSIONS.SUPPORT_TICKET_RAISE,
    items: [{ key: "raise", label: L("My tickets", "मेरे टिकट", "माझी तिकिटे"), icon: "ticket", href: "/support", permission: PERMISSIONS.SUPPORT_TICKET_RAISE }],
  },
];
