/**
 * Admin compliance dashboard (Part 58).
 *
 * This NEVER reports "COMPLIANT" — only whether a technical control is
 * ACTIVE, MISSING data/configuration, or REVIEW_REQUIRED (a human/legal
 * judgement call this code cannot make, e.g. "has a lawyer reviewed this
 * policy text"). Existence of a feature is not a legal compliance claim.
 */
import { getEnv, isPaymentGatewayLive, kycConfigProblem } from "@/lib/env";
import { isFoodBusinessShopType } from "@/lib/shop-types";
import { LEGAL_DOCS, LEGAL_ENTITY } from "@/lib/legal-docs";
import { db } from "@/server/db";
import { sellerVerifications, shops } from "@/server/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getGrievanceDashboard } from "./grievances";

export type ComplianceStatus = "ACTIVE" | "MISSING" | "REVIEW_REQUIRED";

export interface ComplianceItem {
  area: string;
  status: ComplianceStatus;
  detail: string;
}

function isPlaceholder(value: string): boolean {
  return value.startsWith("[PLACEHOLDER");
}

export async function getComplianceChecklist(): Promise<ComplianceItem[]> {
  const approvedShops = await db.query.shops.findMany({
    where: and(eq(shops.status, "APPROVED"), isNull(shops.deletedAt)),
  });

  const missingLegalName = approvedShops.filter((s) => !s.legalBusinessName).length;
  const foodShops = approvedShops.filter((s) => isFoodBusinessShopType(s.shopType));
  const missingFssai = foodShops.filter((s) => !s.fssaiLicenseNumber).length;

  const grievanceDashboard = await getGrievanceDashboard();

  const items: ComplianceItem[] = [];

  for (const doc of LEGAL_DOCS) {
    items.push({
      area: doc.title,
      status: "REVIEW_REQUIRED",
      detail: "Published and technically wired up. Content has not been reviewed by a lawyer.",
    });
  }

  items.push({
    area: "Grievance Officer details",
    status:
      isPlaceholder(LEGAL_ENTITY.grievanceOfficer.name) ||
      isPlaceholder(LEGAL_ENTITY.grievanceOfficer.phone) ||
      isPlaceholder(LEGAL_ENTITY.grievanceOfficer.address)
        ? "MISSING"
        : "ACTIVE",
    detail: isPlaceholder(LEGAL_ENTITY.grievanceOfficer.name)
      ? "Placeholder officer name/phone/address in src/lib/legal-docs.ts must be replaced with a real appointee."
      : "Grievance Officer contact details are on file.",
  });

  items.push({
    area: "Grievance response timeliness",
    status: grievanceDashboard.overdue > 0 ? "REVIEW_REQUIRED" : "ACTIVE",
    detail:
      grievanceDashboard.overdue > 0
        ? `${grievanceDashboard.overdue} complaint(s) open/in-progress beyond the 15-day Rule 3(2) guidance window.`
        : "No complaints are currently overdue against the 15-day guidance window.",
  });

  const entityPlaceholders = [
    LEGAL_ENTITY.legalName,
    LEGAL_ENTITY.registeredAddress,
    LEGAL_ENTITY.cinOrRegistrationNumber,
  ].filter(isPlaceholder).length;
  items.push({
    area: "Legal entity identity (name, address, CIN)",
    status: entityPlaceholders > 0 ? "MISSING" : "ACTIVE",
    detail:
      entityPlaceholders > 0
        ? `${entityPlaceholders} of 3 entity fields in src/lib/legal-docs.ts are still placeholders — shown publicly on the About page and site footer, so this must match the actual registration documents before launch.`
        : "Registered legal entity name/address/CIN are on file and shown on the About page.",
  });

  items.push({
    area: "Platform GSTIN",
    status: isPlaceholder(LEGAL_ENTITY.gstin) ? "MISSING" : "ACTIVE",
    detail: isPlaceholder(LEGAL_ENTITY.gstin)
      ? "Platform GSTIN placeholder in src/lib/legal-docs.ts is shown publicly in the site footer and About page — fill in the real value or confirm none applies."
      : "Platform GSTIN is on file and shown publicly.",
  });

  items.push({
    area: "Seller information (legal name)",
    status: missingLegalName > 0 ? "MISSING" : "ACTIVE",
    detail:
      missingLegalName > 0
        ? `${missingLegalName} of ${approvedShops.length} approved shop(s) have no legal business name on file.`
        : `All ${approvedShops.length} approved shop(s) have a legal business name on file.`,
  });

  items.push({
    area: "Food business licensing (FSSAI)",
    status: missingFssai > 0 ? "MISSING" : "ACTIVE",
    detail:
      foodShops.length === 0
        ? "No approved shops currently fall under a food-related shop type."
        : missingFssai > 0
          ? `${missingFssai} of ${foodShops.length} food-related shop(s) have no FSSAI licence number on file.`
          : `All ${foodShops.length} food-related shop(s) have an FSSAI licence number on file.`,
  });

  items.push({
    area: "Payment gateway configuration",
    status: isPaymentGatewayLive() ? "ACTIVE" : "MISSING",
    detail: isPaymentGatewayLive()
      ? "Live Cashfree credentials are configured."
      : "CASHFREE_APP_ID / CASHFREE_SECRET_KEY are not set — payments run in mock mode.",
  });

  items.push({
    area: "Wallet / payment-instrument boundary",
    status: "ACTIVE",
    detail:
      "Wallet is a platform ledger only: no peer-to-peer transfer, no cash-out, no bank transfer endpoint exists in the codebase.",
  });

  items.push({
    area: "Location privacy",
    status: "ACTIVE",
    detail: "No device-location/GPS feature exists in the application, so there is nothing to consent-gate today.",
  });

  items.push({
    area: "Consent capture (sign-up)",
    status: "ACTIVE",
    detail: "New sign-ups must tick 'I agree to Terms & Privacy Policy' before Google sign-in proceeds; recorded per-user with a policy version.",
  });

  items.push({
    area: "Consent re-capture on policy change",
    status: "MISSING",
    detail: "Existing users are not yet re-prompted when CURRENT_POLICY_VERSION changes — only new sign-ups are gated today.",
  });

  items.push({
    area: "Data retention automation",
    status: "MISSING",
    detail: "Retention periods are documented in the Privacy Policy but not yet enforced by an automated purge/anonymisation job.",
  });

  items.push({
    area: "Audit logging",
    status: "ACTIVE",
    detail: "Payments, wallet, vouchers, refunds, prices, seller info, subscriptions, grievances, and consent are all audit-logged.",
  });

  /* ------------------------------------------------ seller verification */
  const kycProblem = kycConfigProblem();
  const kycEnv = getEnv();
  items.push({
    area: "Seller document verification (KYC vendor)",
    status: kycProblem ? "MISSING" : kycEnv.KYC_PROVIDER === "mock" ? "REVIEW_REQUIRED" : "ACTIVE",
    detail: kycProblem
      ? `Verification is paused: ${kycProblem}`
      : kycEnv.KYC_PROVIDER === "mock"
        ? "Running against the mock vendor — no real document is being checked. Expected only before vendor keys are configured."
        : `Documents are checked with ${kycEnv.KYC_PROVIDER} (${kycEnv.KYC_ENV}).`,
  });

  const verifiedRows = approvedShops.length
    ? await db
        .select({ shopId: sellerVerifications.shopId, docType: sellerVerifications.docType })
        .from(sellerVerifications)
        .where(
          and(
            eq(sellerVerifications.status, "VERIFIED"),
            inArray(sellerVerifications.shopId, approvedShops.map((s) => s.id)),
          ),
        )
    : [];
  const verifiedByShop = new Map<string, Set<string>>();
  for (const r of verifiedRows) {
    if (!verifiedByShop.has(r.shopId)) verifiedByShop.set(r.shopId, new Set());
    verifiedByShop.get(r.shopId)!.add(r.docType);
  }
  // Food shops judged by shop type here; the seller screen also counts food categories.
  const incomplete = approvedShops.filter((s) => {
    const have = verifiedByShop.get(s.id) ?? new Set<string>();
    const need = ["PAN", "GSTIN", "SHOP_ACT", ...(isFoodBusinessShopType(s.shopType) ? ["FSSAI"] : [])];
    return need.some((d) => !have.has(d));
  }).length;
  items.push({
    area: "Seller documents verified (approved shops)",
    status: incomplete > 0 ? "REVIEW_REQUIRED" : "ACTIVE",
    detail:
      incomplete > 0
        ? `${incomplete} of ${approvedShops.length} approved shop(s) are missing a verified mandatory document (PAN, GSTIN or declaration, Shop Act, FSSAI for food). Shops approved before verification existed need to complete it.`
        : `All ${approvedShops.length} approved shop(s) have their mandatory documents verified.`,
  });

  items.push({
    area: "Seller verification — legal review",
    status: "REVIEW_REQUIRED",
    detail:
      "Consent wording, the GST 'not registered' declaration, the retention period after closing, Shop Act applicability outside Maharashtra and the vendor's data processing agreement need a lawyer/CA's sign-off — see docs/seller-verification/COMPLIANCE.md.",
  });

  return items;
}
