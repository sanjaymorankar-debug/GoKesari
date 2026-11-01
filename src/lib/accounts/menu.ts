/**
 * The Inventory & Accounting tile board (docs/inventory-accounting-2026-10):
 * one screen, approved design "Theme 1 Tile Board" — every function of the
 * module as a large tile in English, Hindi and Marathi, with live counts.
 * Pure data, shared by the hub page, the module's sub-navigation and tests.
 */
import type { IconName } from "@/components/board/icons";
import { L, type Text } from "@/lib/board/i18n";
import type { Tone } from "@/lib/board/menus";

export type AccountsCountKey = "toReview" | "lowStock" | "expiring" | "payables" | "reconIssues";

export interface AccountsTile {
  key: string;
  label: Text;
  /** One line under the label on the tile. */
  hint: Text;
  icon: IconName;
  tone: Tone;
  href: string;
  count?: AccountsCountKey;
  urgent?: boolean;
  /** Shown only while this feature flag is on (billing v2). */
  feature?: string;
}

export const ACCOUNTS_HOME = "/shop/accounts";

export const ACCOUNTS_TILES: readonly AccountsTile[] = [
  { key: "scan", label: L("Scan paper bill", "कागज़ का बिल स्कैन करें", "कागदी बिल स्कॅन करा"), hint: L("Camera, many pages", "कैमरा, कई पेज", "कॅमेरा, अनेक पाने"), icon: "images", tone: "kesari", href: "/shop/accounts/capture?mode=scan" },
  { key: "upload", label: L("Upload bill", "बिल अपलोड करें", "बिल अपलोड करा"), hint: L("PDF, photo, Excel, e-invoice", "PDF, फ़ोटो, Excel, ई-इनवॉइस", "PDF, फोटो, Excel, ई-इनव्हॉइस"), icon: "upload", tone: "kesari", href: "/shop/accounts/capture" },
  { key: "review", label: L("Bills to check", "जाँचने वाले बिल", "तपासायची बिले"), hint: L("Confirm to add stock", "स्टॉक जोड़ने के लिए पुष्टि करें", "साठा जोडण्यासाठी पुष्टी करा"), icon: "clipboard-check", tone: "kesari", href: "/shop/accounts/bills", count: "toReview", urgent: true },
  { key: "purchases", label: L("Purchases", "खरीद", "खरेदी"), hint: L("Bills, corrections", "बिल, सुधार", "बिले, दुरुस्ती"), icon: "receipt", tone: "teal", href: "/shop/accounts/purchases" },
  { key: "stock", label: L("Stock", "स्टॉक", "साठा"), hint: L("Value, low, expiry", "मूल्य, कम, एक्सपायरी", "मूल्य, कमी, मुदत"), icon: "boxes", tone: "teal", href: "/shop/accounts/stock", count: "lowStock" },
  { key: "sales", label: L("Sales invoice", "बिक्री बिल", "विक्री बिल"), hint: L("GST invoice for a customer", "ग्राहक के लिए GST बिल", "ग्राहकासाठी GST बिल"), icon: "file-text", tone: "green", href: "/shop/accounts/sales" },
  { key: "documents", label: L("Notes, vouchers & challans", "नोट, वाउचर और चालान", "नोट, व्हाउचर आणि चलन"), hint: L("Credit/debit note, advance, estimate", "क्रेडिट/डेबिट नोट, अग्रिम, अनुमान", "क्रेडिट/डेबिट नोट, आगाऊ, अंदाज"), icon: "file-text", tone: "green", href: "/shop/accounts/documents", feature: "billing_v2" },
  { key: "parties", label: L("Suppliers & customers", "सप्लायर और ग्राहक", "पुरवठादार आणि ग्राहक"), hint: L("Ledgers, dues", "खाते, बकाया", "खाती, येणे-देणे"), icon: "users", tone: "green", href: "/shop/accounts/parties", count: "payables" },
  { key: "money", label: L("Cash, bank & expenses", "नकद, बैंक और खर्च", "रोख, बँक आणि खर्च"), hint: L("Payments, day book", "भुगतान, रोज़नामचा", "देयके, रोजकीर्द"), icon: "wallet", tone: "green", href: "/shop/accounts/money" },
  { key: "journals", label: L("Journal, contra & stock journal", "जर्नल, कॉन्ट्रा और स्टॉक जर्नल", "जर्नल, कॉन्ट्रा आणि स्टॉक जर्नल"), hint: L("Adjust books, cash ↔ bank, move stock", "बही समायोजन, नकद ↔ बैंक, स्टॉक", "हिशेब समायोजन, रोख ↔ बँक, साठा"), icon: "scroll-text", tone: "green", href: "/shop/accounts/journals", feature: "billing_v2" },
  { key: "gst", label: L("GST payable", "देय GST", "देय GST"), hint: L("Output − input, due dates", "आउटपुट − इनपुट, तारीख़ें", "आउटपुट − इनपुट, तारखा"), icon: "indian-rupee", tone: "violet", href: "/shop/accounts/gst" },
  { key: "reconcile", label: L("Match with GST portal", "GST पोर्टल से मिलान", "GST पोर्टलशी जुळवणी"), hint: L("GSTR-2B / 2A", "GSTR-2B / 2A", "GSTR-2B / 2A"), icon: "scale", tone: "violet", href: "/shop/accounts/gst/reconcile", count: "reconIssues" },
  { key: "statements", label: L("Statements from GoKesari", "GoKesari के विवरण", "GoKesari ची विवरणे"), hint: L("TCS, TDS, wallet, settlement", "TCS, TDS, वॉलेट, सेटलमेंट", "TCS, TDS, वॉलेट, सेटलमेंट"), icon: "landmark", tone: "violet", href: "/shop/accounts/statements", feature: "billing_v2" },
  { key: "sync", label: L("Sync with Tally, Zoho…", "Tally, Zoho… से सिंक", "Tally, Zoho… सोबत सिंक"), hint: L("Send and bring in, both ways", "भेजें और लाएँ, दोनों तरफ़", "पाठवा आणि आणा, दोन्ही बाजूंनी"), icon: "refresh-cw", tone: "blue", href: "/shop/accounts/sync", feature: "billing_v2" },
  { key: "reports", label: L("Reports", "रिपोर्ट", "अहवाल"), hint: L("P&L, Excel, PDF, Tally", "लाभ-हानि, Excel, PDF, Tally", "नफा-तोटा, Excel, PDF, Tally"), icon: "chart-line", tone: "blue", href: "/shop/accounts/reports" },
  { key: "settings", label: L("Settings", "सेटिंग", "सेटिंग्ज"), hint: L("Valuation, GST filing", "मूल्यांकन, GST फ़ाइलिंग", "मूल्यांकन, GST भरणा"), icon: "settings", tone: "blue", href: "/shop/accounts/settings" },
];

/** The module's sub-navigation (every page shows it, current one marked). */
export const ACCOUNTS_NAV: readonly { key: string; label: Text; href: string; icon: IconName }[] = [
  { key: "home", label: L("Accounts", "हिसाब", "हिशेब"), href: ACCOUNTS_HOME, icon: "layout-grid" },
  { key: "capture", label: L("Add bill", "बिल जोड़ें", "बिल जोडा"), href: "/shop/accounts/capture", icon: "upload" },
  { key: "bills", label: L("To check", "जाँचें", "तपासा"), href: "/shop/accounts/bills", icon: "clipboard-check" },
  { key: "purchases", label: L("Purchases", "खरीद", "खरेदी"), href: "/shop/accounts/purchases", icon: "receipt" },
  { key: "stock", label: L("Stock", "स्टॉक", "साठा"), href: "/shop/accounts/stock", icon: "boxes" },
  { key: "sales", label: L("Sales", "बिक्री", "विक्री"), href: "/shop/accounts/sales", icon: "file-text" },
  { key: "parties", label: L("Parties", "पार्टी", "पक्षकार"), href: "/shop/accounts/parties", icon: "users" },
  { key: "money", label: L("Cash & bank", "नकद व बैंक", "रोख व बँक"), href: "/shop/accounts/money", icon: "wallet" },
  { key: "gst", label: L("GST", "GST", "GST"), href: "/shop/accounts/gst", icon: "indian-rupee" },
  { key: "reports", label: L("Reports", "रिपोर्ट", "अहवाल"), href: "/shop/accounts/reports", icon: "chart-line" },
];

export const ACCOUNTS_TEXT = {
  title: L("Inventory & Accounts", "स्टॉक और हिसाब", "साठा आणि हिशेब"),
  gstPayable: L("GST payable (est.)", "देय GST (अनुमान)", "देय GST (अंदाज)"),
  stockValue: L("Stock value", "स्टॉक मूल्य", "साठा मूल्य"),
  youOwe: L("You owe suppliers", "सप्लायर को देना", "पुरवठादारांना देणे"),
  nextDue: L("Next GST due", "अगली GST तारीख़", "पुढील GST तारीख"),
  caNote: L("Estimates — verify with your CA before filing.", "अनुमान — फ़ाइल करने से पहले अपने CA से जाँच लें।", "अंदाज — भरण्यापूर्वी तुमच्या CA कडून तपासा."),
} as const;
