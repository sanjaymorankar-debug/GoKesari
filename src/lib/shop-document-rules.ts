/**
 * Shop document rules (owner, 22-Nov-2026, DF-09): an admin decides, per document and per shop type,
 * whether a licence or legal document is
 *   MUST_HAVE — on file before the registration fee is paid (the shop cannot go live without it),
 *   PROMISE   — may follow go-live on the owner's promise (reminders, then suspension), or
 *   OPTIONAL  — the owner may upload it; never asked for, never chased;
 * and may add a document the law newly requires. GSTIN or PAN is not part of these rules: it stays a
 * must-have for every shop (DF-08).
 *
 * Client-safe: labels, the built-in documents, scopes and the rule picking shared by the admin
 * screen and the server (src/server/services/shop-document-rules.ts).
 */

export const DOCUMENT_LEVELS = ["MUST_HAVE", "PROMISE", "OPTIONAL"] as const;
export type DocumentLevel = (typeof DOCUMENT_LEVELS)[number];

export const DOCUMENT_LEVEL_LABELS: Record<DocumentLevel, string> = {
  MUST_HAVE: "Must-have before go-live",
  PROMISE: "Upload later, on the owner's promise",
  OPTIONAL: "Optional",
};

export const DOCUMENT_LEVEL_HINTS: Record<DocumentLevel, string> = {
  MUST_HAVE: "The owner cannot pay the registration fee (or go live) until it is uploaded.",
  PROMISE: "The shop may go live once the owner promises to upload it; e-mail reminders, then suspension after the due date.",
  OPTIONAL: "Shown as an optional upload; never chased.",
};

/** Where a document lives once uploaded: seller verification (Shop Act, Udyam, FSSAI) or the legal-documents register. */
export type RuleDocumentKind = "seller" | "legal" | "custom";

export interface BuiltInRuleDocument {
  key: BuiltInRuleDocKey;
  label: string;
  kind: "seller" | "legal";
}

export const BUILT_IN_RULE_DOC_KEYS = [
  "SHOP_ACT",
  "UDYAM",
  "FSSAI",
  "DRUG_LICENCE",
  "MEDICAL_REGISTRATION",
  "TRADE_LICENCE",
  "LEGAL_METROLOGY",
  "FIRE_NOC",
  "AGRI_INPUT_LICENCE",
] as const;
export type BuiltInRuleDocKey = (typeof BUILT_IN_RULE_DOC_KEYS)[number];

export const BUILT_IN_RULE_DOCUMENTS: readonly BuiltInRuleDocument[] = [
  { key: "SHOP_ACT", label: "Shop Act (Shops & Establishments) certificate", kind: "seller" },
  { key: "UDYAM", label: "Udyam registration", kind: "seller" },
  { key: "FSSAI", label: "FSSAI licence / registration", kind: "seller" },
  { key: "DRUG_LICENCE", label: "Drug licence", kind: "legal" },
  { key: "MEDICAL_REGISTRATION", label: "Medical / professional registration", kind: "legal" },
  { key: "TRADE_LICENCE", label: "Trade licence (municipal)", kind: "legal" },
  { key: "LEGAL_METROLOGY", label: "Weights & measures (legal metrology) certificate", kind: "legal" },
  { key: "FIRE_NOC", label: "Fire NOC", kind: "legal" },
  { key: "AGRI_INPUT_LICENCE", label: "Seeds / fertiliser / pesticide licence", kind: "legal" },
];

export function isBuiltInRuleDocKey(key: string): key is BuiltInRuleDocKey {
  return (BUILT_IN_RULE_DOC_KEYS as readonly string[]).includes(key);
}

/**
 * A document an admin added is stored as an "Other licence" in the legal-documents register, keyed
 * `DOC:<NAME>`. An owner's own "Other licence" key never contains ":" (checkLicenceName), so the two
 * never meet.
 */
export const CUSTOM_DOC_PREFIX = "DOC:";

export function isCustomDocKey(key: string): boolean {
  return key.startsWith(CUSTOM_DOC_PREFIX) && key.length > CUSTOM_DOC_PREFIX.length;
}

/** "Pollution control NOC" → "DOC:POLLUTION-CONTROL-NOC". */
export function customDocKeyFromLabel(label: string): string {
  return `${CUSTOM_DOC_PREFIX}${label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}`;
}

/**
 * Who a rule applies to: every shop, every shop that sells food (a food shop type or a food aisle —
 * the test FSSAI has always used), or one shop type. A shop-type rule wins over the food rule, which
 * wins over the all-shops rule.
 */
export type RuleScope = "ALL" | "FOOD" | `TYPE:${string}`;

export function isRuleScope(value: string): value is RuleScope {
  return value === "ALL" || value === "FOOD" || /^TYPE:[A-Z0-9_]{2,60}$/.test(value);
}

export function scopeShopType(scope: string): string | null {
  return scope.startsWith("TYPE:") ? scope.slice(5) : null;
}

export function scopeLabel(scope: string, shopTypeLabels: Record<string, string> = {}): string {
  if (scope === "ALL") return "All shops";
  if (scope === "FOOD") return "Shops that sell food";
  const type = scopeShopType(scope);
  return type ? (shopTypeLabels[type] ?? type) : scope;
}

export interface RuleLike {
  docKey: string;
  scope: string;
  level: DocumentLevel;
}

/** The rule that decides `docKey` for a shop: its shop type's, else the food rule (food shops), else the all-shops rule. */
export function pickRule<T extends RuleLike>(rules: readonly T[], docKey: string, shopType: string, sellsFood: boolean): T | null {
  const forDoc = rules.filter((r) => r.docKey === docKey);
  return (
    forDoc.find((r) => r.scope === `TYPE:${shopType}`) ??
    (sellsFood ? forDoc.find((r) => r.scope === "FOOD") : undefined) ??
    forDoc.find((r) => r.scope === "ALL") ??
    null
  );
}

/** "a, b and c". */
export function listJoin(labels: readonly string[]): string {
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}
