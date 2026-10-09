/**
 * SM-002 shop onboarding stages — client-safe labels and "what happens next".
 *
 * A shop awaiting approval is KYC_PENDING, PAYMENT_PENDING or VERIFIED (see
 * lib/status-models.ts deriveShopOnboardingStage; the database derives the
 * stored value, migration 0051). This module only turns a stage into words
 * for the shop owner and for operations.
 */
import type { ShopOnboardingStage } from "./status-models";
import { SHOP_ONBOARDING_STAGES } from "./status-models";
import { formatPaiseCompact } from "./money";

export { SHOP_ONBOARDING_STAGES };
export type { ShopOnboardingStage };

export const ONBOARDING_STAGE_LABELS: Record<ShopOnboardingStage, string> = {
  KYC_PENDING: "KYC pending",
  PAYMENT_PENDING: "Payment pending",
  VERIFIED: "Verified",
};

export const ONBOARDING_STAGE_TONES: Record<ShopOnboardingStage, "warning" | "info" | "success"> = {
  KYC_PENDING: "warning",
  PAYMENT_PENDING: "info",
  VERIFIED: "success",
};

export function isOnboardingStage(value: string | null | undefined): value is ShopOnboardingStage {
  return (SHOP_ONBOARDING_STAGES as readonly string[]).includes(value ?? "");
}

export interface OnboardingFacts {
  stage: ShopOnboardingStage;
  /** Labels of mandatory documents not yet verified, e.g. ["PAN", "Shop Act licence"]. */
  missingDocuments: string[];
  /** Registration fee still owed, in paise (0 when paid or waived). */
  feeOutstandingPaise: number;
}

export interface NextAction {
  text: string;
  href: string;
  linkLabel: string;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The one thing the shop owner should do now. */
export function ownerNextAction(facts: OnboardingFacts): NextAction {
  switch (facts.stage) {
    case "KYC_PENDING":
      return {
        text: facts.missingDocuments.length
          ? `Submit your documents for verification: ${list(facts.missingDocuments)}. Your shop moves to the payment step once they are verified.`
          : "Your documents are being checked. Your shop moves to the payment step once they are verified.",
        href: "/shop/verification",
        linkLabel: "Go to document verification",
      };
    case "PAYMENT_PENDING":
      return {
        text: `Your documents are verified. Pay the registration fee of ${formatPaiseCompact(facts.feeOutstandingPaise)} to GoKesari; operations records it and your shop moves to final approval.`,
        href: "/shop/manage/registration",
        linkLabel: "See registration fee",
      };
    case "VERIFIED":
      return {
        text: "Documents verified and fee settled. An operator will approve your shop shortly — no action needed from you.",
        href: "/shop/manage/registration",
        linkLabel: "See registration details",
      };
  }
}

/** The one thing operations should do now. */
export function adminNextAction(facts: OnboardingFacts): NextAction {
  switch (facts.stage) {
    case "KYC_PENDING":
      return {
        text: facts.missingDocuments.length
          ? `Waiting on documents: ${list(facts.missingDocuments)}. Review any in the seller verification queue.`
          : "Documents submitted and waiting on review.",
        href: "/admin/seller-verification",
        linkLabel: "Seller verification queue",
      };
    case "PAYMENT_PENDING":
      return {
        text: `Documents verified. Record the registration fee (${formatPaiseCompact(facts.feeOutstandingPaise)} outstanding) or waive it.`,
        href: "/admin/console/registration-fees#shop-finance",
        linkLabel: "Record fee payment",
      };
    case "VERIFIED":
      return {
        text: "Documents verified and fee settled — ready to approve.",
        href: "/admin/console/shops#shop-approvals",
        linkLabel: "Approve",
      };
  }
}
