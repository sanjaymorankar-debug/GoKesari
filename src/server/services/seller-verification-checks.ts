/**
 * Seller verification, Part 3: what a vendor result means for this shop.
 *
 * Pure functions — no database, no vendor — so every rule is unit-tested in
 * isolation. The service (seller-verification.ts) feeds them the shop, the
 * vendor's normalised record and the shop's other documents.
 *
 *   PAN      active (vendor) + name matches the owner or business
 *   GSTIN    active + its embedded PAN is the shop's PAN + name + state
 *   UDYAM    active + enterprise or owner name matches (optional document)
 *   FSSAI    active + not expired + premises pincode is the shop's (food shops only)
 *   SHOP_ACT active + name (+ pincode where returned); no vendor → certificate review
 *
 * Any failed check moves a vendor-VERIFIED document to MANUAL_REVIEW with a
 * reason code; nothing here ever turns a failure into a pass.
 */
import { bestNameMatch } from "@/lib/kyc/name-match";
import type { SellerDocType, SellerVerificationStatus } from "@/lib/kyc/doc-formats";
import type { SourceRecord } from "@/server/kyc";

/** GSTIN state code → two-letter state/UT code. */
export const GST_STATE_CODES: Record<string, string> = {
  "01": "JK", "02": "HP", "03": "PB", "04": "CH", "05": "UK", "06": "HR", "07": "DL", "08": "RJ",
  "09": "UP", "10": "BR", "11": "SK", "12": "AR", "13": "NL", "14": "MN", "15": "MZ", "16": "TR",
  "17": "ML", "18": "AS", "19": "WB", "20": "JH", "21": "OD", "22": "CG", "23": "MP", "24": "GJ",
  "25": "DD", "26": "DN", "27": "MH", "28": "AP", "29": "KA", "30": "GA", "31": "LD", "32": "KL",
  "33": "TN", "34": "PY", "35": "AN", "36": "TS", "37": "AP", "38": "LA",
};

/** Normalises a vendor's state field ("27", "MH", "Maharashtra") to a two-letter code. */
export function toStateCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (/^\d{2}$/.test(s)) return GST_STATE_CODES[s] ?? null;
  if (/^[A-Z]{2}$/.test(s)) return s;
  if (s.startsWith("MAHARASHTRA")) return "MH";
  return null;
}

export interface ShopFacts {
  ownerName: string | null;
  legalBusinessName: string | null;
  shopName: string;
  pincode: string | null;
  /** Two-letter state, when it can be told from the PIN code. */
  stateCode: string | undefined;
  isFoodBusiness: boolean;
}

export function shopNames(shop: ShopFacts): string[] {
  return [shop.ownerName, shop.legalBusinessName, shop.shopName].filter((n): n is string => Boolean(n));
}

export interface DocCheckInput {
  docType: SellerDocType;
  vendorStatus: SellerVerificationStatus;
  record: SourceRecord | null;
  shop: ShopFacts;
  /** GSTIN only: does the PAN inside the GSTIN equal the shop's submitted PAN? null when no PAN on file. */
  gstinPanMatchesShopPan?: boolean | null;
  /** GSTIN only: state code from characters 1–2. */
  gstStateCode?: string;
  nameMatchAutoApprove: number;
}

export interface DocChecks {
  nameScore: number | null;
  recordName: string | null;
  matchedShopName: string | null;
  panLinked: boolean | null;
  stateMatch: boolean | null;
  pincodeMatch: boolean | null;
}

export interface DocCheckResult {
  status: SellerVerificationStatus;
  errorCode: string | null;
  checks: DocChecks;
}

export function applyDocumentChecks(input: DocCheckInput): DocCheckResult {
  const { record, shop, docType } = input;
  const checks: DocChecks = {
    nameScore: null,
    recordName: null,
    matchedShopName: null,
    panLinked: null,
    stateMatch: null,
    pincodeMatch: null,
  };
  if (input.vendorStatus !== "VERIFIED" || !record) {
    return { status: input.vendorStatus, errorCode: null, checks };
  }

  const recordNames = [record.name, record.tradeName, record.ownerName];
  const best = bestNameMatch(recordNames, shopNames(shop));
  checks.nameScore = record.name || record.tradeName || record.ownerName ? best.score : null;
  checks.recordName = best.recordName;
  checks.matchedShopName = best.shopName;

  if (record.pincode && shop.pincode) checks.pincodeMatch = record.pincode === shop.pincode;

  if (docType === "GSTIN") {
    checks.panLinked = input.gstinPanMatchesShopPan ?? null;
    const gstState = input.gstStateCode ? GST_STATE_CODES[input.gstStateCode] : toStateCode(record.stateCode);
    if (gstState && shop.stateCode) checks.stateMatch = gstState === shop.stateCode;
  }

  const fail = (errorCode: string): DocCheckResult => ({ status: "MANUAL_REVIEW", errorCode, checks });

  if (checks.nameScore === null) return fail("name_not_returned");
  if (checks.nameScore < input.nameMatchAutoApprove) return fail("name_mismatch");
  if (docType === "GSTIN" && checks.panLinked === false) return fail("gstin_pan_mismatch");
  if (docType === "GSTIN" && checks.stateMatch === false) return fail("state_mismatch");
  if (docType === "FSSAI") {
    if (!record.validUntil) return fail("expiry_not_returned");
    if (checks.pincodeMatch === false) return fail("address_mismatch");
  }
  if (docType === "SHOP_ACT" && checks.pincodeMatch === false) return fail("address_mismatch");

  return { status: "VERIFIED", errorCode: null, checks };
}

/* ------------------------------------------------- cross-document score */

/** The minimum each document row must expose for the shop-level score. */
export interface ScoredDoc {
  docType: SellerDocType;
  status: SellerVerificationStatus;
  nameMatchScore: number | null;
  details: { panLinked?: boolean | null; stateMatch?: boolean | null; pincodeMatch?: boolean | null };
}

export interface ConsistencyScore {
  /** 0–100, or null when no document has been checked yet. */
  score: number | null;
  components: { key: "name" | "panLinkage" | "pincode" | "state"; weight: number; value: number }[];
}

const WEIGHTS = { name: 40, panLinkage: 25, pincode: 20, state: 15 } as const;

/**
 * How well the shop's documents agree with each other and with the shop:
 * names (average match), PAN linkage (GSTIN ↔ PAN), PIN code and state.
 * Components with no evidence are left out and the rest re-weighted, so a
 * shop without a GSTIN is not penalised for having no PAN linkage to check.
 */
export function consistencyScore(docs: ScoredDoc[]): ConsistencyScore {
  const considered = docs.filter((d) => d.status === "VERIFIED" || d.status === "MANUAL_REVIEW");
  const components: ConsistencyScore["components"] = [];

  const names = considered.map((d) => d.nameMatchScore).filter((n): n is number => n !== null);
  if (names.length) {
    components.push({ key: "name", weight: WEIGHTS.name, value: Math.round(names.reduce((a, b) => a + b, 0) / names.length) });
  }

  const fraction = (pick: (d: ScoredDoc) => boolean | null | undefined) => {
    const vals = considered.map(pick).filter((v): v is boolean => typeof v === "boolean");
    return vals.length ? Math.round((vals.filter(Boolean).length / vals.length) * 100) : null;
  };
  const pan = fraction((d) => (d.docType === "GSTIN" ? d.details.panLinked : null));
  if (pan !== null) components.push({ key: "panLinkage", weight: WEIGHTS.panLinkage, value: pan });
  const pin = fraction((d) => d.details.pincodeMatch);
  if (pin !== null) components.push({ key: "pincode", weight: WEIGHTS.pincode, value: pin });
  const state = fraction((d) => d.details.stateMatch);
  if (state !== null) components.push({ key: "state", weight: WEIGHTS.state, value: state });

  if (components.length === 0) return { score: null, components };
  const totalWeight = components.reduce((a, c) => a + c.weight, 0);
  const score = Math.round(components.reduce((a, c) => a + c.value * c.weight, 0) / totalWeight);
  return { score, components };
}

/* ------------------------------------------------------- requirements */

export type Requirement = "required" | "required_or_declaration" | "optional" | "not_applicable";

/**
 * Which documents a shop must have verified. Shop Act is required because
 * the Maharashtra Shops and Establishments Act 2017 covers every
 * establishment (registration, or intimation below 10 workers) — CONFIRM
 * WITH A LAWYER for shops outside Maharashtra and for home-based sellers.
 */
export function requirementFor(docType: SellerDocType, shop: Pick<ShopFacts, "isFoodBusiness">): Requirement {
  switch (docType) {
    case "PAN":
      return "required";
    case "GSTIN":
      return "required_or_declaration";
    case "UDYAM":
      return "optional";
    case "FSSAI":
      return shop.isFoodBusiness ? "required" : "optional";
    case "SHOP_ACT":
      return "required";
  }
}

export function isMandatory(docType: SellerDocType, shop: Pick<ShopFacts, "isFoodBusiness">): boolean {
  const r = requirementFor(docType, shop);
  return r === "required" || r === "required_or_declaration";
}
