/**
 * Inventory & Accounting module (docs/inventory-accounting-2026-10): the fixed
 * vocabularies its tables and screens share. Pure data — imported by the
 * schema, the services and client components alike.
 */

/** Every way stock moves. Inbound types add, outbound types take away. */
export const STOCK_MOVEMENT_TYPES = [
  "OPENING",
  "PURCHASE",
  "PURCHASE_RETURN",
  "SALE",
  "SALE_RETURN",
  "WRITE_OFF_DAMAGE",
  "WRITE_OFF_EXPIRY",
  "ADJUSTMENT",
  /** Undoes an earlier entry exactly (a corrected or cancelled document). */
  "REVERSAL",
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/** Where a stock entry came from. */
export const STOCK_SOURCE_TYPES = [
  /** inventory_movements written by the existing order / catalogue code (DB trigger). */
  "ORDER",
  "CATALOGUE",
  "PURCHASE_INVOICE",
  "SALES_INVOICE",
  "MANUAL",
  "MIGRATION",
  /** Billing v2: a shop document (credit note bringing goods back, delivery challan). */
  "SHOP_DOCUMENT",
] as const;
export type StockSourceType = (typeof STOCK_SOURCE_TYPES)[number];

export const STOCK_MOVEMENT_LABELS: Record<StockMovementType, string> = {
  OPENING: "Opening stock",
  PURCHASE: "Purchase",
  PURCHASE_RETURN: "Purchase return",
  SALE: "Sale",
  SALE_RETURN: "Sale return",
  WRITE_OFF_DAMAGE: "Damaged (written off)",
  WRITE_OFF_EXPIRY: "Expired (written off)",
  ADJUSTMENT: "Adjustment",
  REVERSAL: "Reversal",
};

export const VALUATION_METHODS = ["FIFO", "WAVG"] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];

export const PARTY_KINDS = ["SUPPLIER", "CUSTOMER", "BOTH"] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export const PAYMENT_MODES = ["CASH", "BANK", "UPI", "CARD", "CREDIT"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/**
 * Chart of accounts. Each book entry is one leg of a balanced voucher; PARTY
 * legs also carry a party id (supplier payable / customer receivable).
 */
export const BOOK_ACCOUNTS = [
  "CASH",
  "BANK",
  "PARTY",
  "PURCHASES",
  "SALES",
  "GST_INPUT_CGST",
  "GST_INPUT_SGST",
  "GST_INPUT_IGST",
  "GST_INPUT_CESS",
  "GST_OUTPUT_CGST",
  "GST_OUTPUT_SGST",
  "GST_OUTPUT_IGST",
  "GST_OUTPUT_CESS",
  "EXPENSE",
  "STOCK_WRITE_OFF",
  "ROUND_OFF",
  "CAPITAL",
  /* Billing v2 (docs/billing §6.1): */
  /** Advances received from customers (receipt vouchers) until the supply is invoiced. */
  "ADVANCES_RECEIVED",
  /** GST TCS GoKesari collected (s.52) — the shop claims it in its electronic cash ledger. */
  "TCS_RECEIVABLE",
  /** Income-tax TDS GoKesari deducted (s.393) — the shop claims it in its return. */
  "TDS_RECEIVABLE",
  /** GoKesari's commission and fees. */
  "COMMISSION_EXPENSE",
  /** Delivery charges paid to GoKesari. */
  "DELIVERY_EXPENSE",
  /** Money GoKesari holds for the shop (unsettled payouts, the prepaid shop wallet). */
  "GOKESARI_ACCOUNT",
] as const;
export type BookAccount = (typeof BOOK_ACCOUNTS)[number];

export const BOOK_ACCOUNT_LABELS: Record<BookAccount, string> = {
  CASH: "Cash",
  BANK: "Bank / UPI",
  PARTY: "Party",
  PURCHASES: "Purchases",
  SALES: "Sales",
  GST_INPUT_CGST: "Input CGST",
  GST_INPUT_SGST: "Input SGST",
  GST_INPUT_IGST: "Input IGST",
  GST_INPUT_CESS: "Input cess",
  GST_OUTPUT_CGST: "Output CGST",
  GST_OUTPUT_SGST: "Output SGST",
  GST_OUTPUT_IGST: "Output IGST",
  GST_OUTPUT_CESS: "Output cess",
  EXPENSE: "Expense",
  STOCK_WRITE_OFF: "Stock written off",
  ROUND_OFF: "Round off",
  CAPITAL: "Capital / opening balance",
  ADVANCES_RECEIVED: "Advances from customers",
  TCS_RECEIVABLE: "GST TCS receivable",
  TDS_RECEIVABLE: "Income-tax TDS receivable",
  COMMISSION_EXPENSE: "GoKesari commission & fees",
  DELIVERY_EXPENSE: "Delivery charges",
  GOKESARI_ACCOUNT: "GoKesari account (payouts & wallet)",
};

export const VOUCHER_TYPES = [
  "PURCHASE",
  "SALE",
  "PAYMENT",
  "RECEIPT",
  "EXPENSE",
  "WRITE_OFF",
  "OPENING",
  "REVERSAL",
  /* Billing v2 (docs/billing §6.1): the Tally-style types. */
  "SALES_RETURN",
  "PURCHASE_RETURN",
  "DEBIT_NOTE",
  "CONTRA",
  "JOURNAL",
  "STOCK_JOURNAL",
] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

export const EXPENSE_CATEGORIES = [
  "RENT",
  "ELECTRICITY",
  "SALARY",
  "TRANSPORT",
  "PACKAGING",
  "REPAIRS",
  "TELEPHONE_INTERNET",
  "BANK_CHARGES",
  "GOKESARI_FEES",
  "OTHER",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  RENT: "Rent",
  ELECTRICITY: "Electricity",
  SALARY: "Salary & wages",
  TRANSPORT: "Transport & fuel",
  PACKAGING: "Packaging",
  REPAIRS: "Repairs & maintenance",
  TELEPHONE_INTERNET: "Phone & internet",
  BANK_CHARGES: "Bank charges",
  GOKESARI_FEES: "GoKesari fees & commission",
  OTHER: "Other",
};

/** A supplier bill's journey from upload to the books. */
export const CAPTURE_STATUSES = ["QUEUED", "PROCESSING", "READY_FOR_REVIEW", "CONFIRMED", "FAILED", "DISCARDED"] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/** How the bill reached the app. */
export const CAPTURE_SOURCES = ["UPLOAD", "CAMERA", "SHARE", "EMAIL"] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

/** SOFT: a file (PDF, Excel, e-invoice JSON, photo of a screen). HARD: a scanned paper bill. */
export const CAPTURE_KINDS = ["SOFT", "HARD"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/** Which engine produced the draft the owner reviews. */
export const EXTRACTION_ENGINES = ["EINVOICE_JSON", "EINVOICE_QR", "EXCEL", "AI", "PDF_TEXT", "OCR", "MANUAL"] as const;
export type ExtractionEngine = (typeof EXTRACTION_ENGINES)[number];

export const PORTAL_RETURN_TYPES = ["GSTR2B", "GSTR2A", "GSTR1"] as const;
export type PortalReturnTypeKey = (typeof PORTAL_RETURN_TYPES)[number];

export const PORTAL_IMPORT_SOURCES = ["API", "UPLOAD_JSON", "UPLOAD_EXCEL"] as const;
export type PortalImportSource = (typeof PORTAL_IMPORT_SOURCES)[number];

export const GST_LINK_STATUSES = ["OTP_SENT", "LINKED", "EXPIRED", "REVOKED"] as const;
export type GstLinkStatus = (typeof GST_LINK_STATUSES)[number];

/** Reconciliation outcome for one invoice (portal side, books side or both). */
export const RECON_STATUSES = ["MATCHED", "AMOUNT_MISMATCH", "MISSING_IN_BOOKS", "MISSING_ON_PORTAL"] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];

export const RECON_STATUS_LABELS: Record<ReconStatus, string> = {
  MATCHED: "Matched",
  AMOUNT_MISMATCH: "Amount mismatch",
  MISSING_IN_BOOKS: "On portal, missing in books",
  MISSING_ON_PORTAL: "In books, missing on portal",
};

/** ITC record state: eligible ITC counts towards the liability only once MATCHED with the portal. */
export const ITC_STATUSES = ["PENDING_RECON", "MATCHED", "MISMATCH", "NOT_ON_PORTAL", "INELIGIBLE", "REVERSED"] as const;
export type ItcStatus = (typeof ITC_STATUSES)[number];

export const FILING_FREQUENCIES = ["MONTHLY", "QUARTERLY"] as const;
export type FilingFrequency = (typeof FILING_FREQUENCIES)[number];

/** Shown next to every computed GST figure. */
export const CA_NOTE = "These are computed estimates from your books — verify with your CA before filing. GoKesari does not file returns.";
