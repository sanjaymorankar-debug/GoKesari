/**
 * Onboarding v2 — owner, 27-Nov-2026: "if documents are not submitted as per policy, shop should be suspended, it
 * will be activated post documents are provided ... no additional admin approval is required for any of the
 * scenarios" (docs/onboarding-v2-2026-11).
 *
 * A shop the documents follow-up suspended (shop_suspensions.source = DOCUMENT_FOLLOW_UP, 0219) is reinstated with
 * no person as soon as nothing is chased any more: every document the follow-up asks for is given — verified, or
 * sent and waiting for GoKesari's check (PENDING / MANUAL_REVIEW, the follow-up's WITH_THE_TEAM; a licence entered
 * or uploaded at a v2 registration). Optional documents never count. A shop suspended for any other reason is never
 * touched. Runs right after a document is given (seller documents, the Shop Act certificate, the FSSAI upload, the
 * legal-documents register, a registration licence decision) and every day from the follow-up job (safety net).
 * Only while the onboarding_v2 flag is on; off, a person reinstates the shop as before.
 *
 * DEFAULT – confirm with Sanjay: it applies to every shop the follow-up suspends from this release on (not only shops
 * registered through v2), and not to documents suspensions made before 0219 (no source recorded: a person lifts those).
 */
import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "@/server/db";
import { shopSuspensions, shops } from "@/server/db/schema";
import { onboardingV2Enabled } from "./roles";

const NOTE = "Reinstated automatically: the documents the follow-up asked for are given (onboarding v2, owner 27-Nov-2026).";

/** Reinstates one shop when the documents follow-up suspended it and nothing is chased any more. True if done. */
export async function reactivateIfDocumentsGiven(shopId: string): Promise<boolean> {
  if (!(await onboardingV2Enabled())) return false;
  const [active] = await db
    .select({ source: shopSuspensions.source })
    .from(shopSuspensions)
    .innerJoin(shops, eq(shops.id, shopSuspensions.shopId))
    .where(and(eq(shopSuspensions.shopId, shopId), eq(shopSuspensions.status, "ACTIVE"), eq(shops.status, "SUSPENDED")))
    .limit(1);
  if (active?.source !== "DOCUMENT_FOLLOW_UP") return false;
  const { shopsMissingDocuments } = await import("@/server/services/shop-document-follow-up");
  const [still] = await shopsMissingDocuments({ statuses: ["SUSPENDED"], shopIds: [shopId] });
  // Documents made needed later whose date has not come (`upcoming`) were never a reason to suspend.
  if (still && (still.missing.length > 0 || still.missingLicences.length > 0)) return false;
  const { reactivateShopAfterDocuments } = await import("@/server/services/shop-suspension");
  return (await reactivateShopAfterDocuments(shopId, NOTE)) !== null;
}

/** After a document is given: never fails the caller (a problem is logged; the daily run retries). */
export async function afterShopDocumentGiven(shopId: string | null | undefined): Promise<void> {
  if (!shopId) return;
  await reactivateIfDocumentsGiven(shopId).catch((error: unknown) => console.error("[onboarding-v2] automatic reinstatement failed", shopId, error));
}

/** The daily safety net (runShopDocumentFollowUp): every shop the follow-up suspended. Returns how many came back. */
export async function reactivateDocumentSuspensions(): Promise<number> {
  if (!(await onboardingV2Enabled())) return 0;
  const rows = await db
    .select({ shopId: shopSuspensions.shopId })
    .from(shopSuspensions)
    .where(and(eq(shopSuspensions.status, "ACTIVE"), isNotNull(shopSuspensions.source), eq(shopSuspensions.source, "DOCUMENT_FOLLOW_UP")));
  let done = 0;
  for (const r of rows) {
    try {
      if (await reactivateIfDocumentsGiven(r.shopId)) done += 1;
    } catch (error) {
      console.error("[onboarding-v2] automatic reinstatement failed", r.shopId, error);
    }
  }
  return done;
}
