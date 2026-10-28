/**
 * Instant approval on government GST/PAN verification + online payment
 * (docs/dealer-programme, GKS-SH-004), behind the flag
 * gov_verification_auto_approval_enabled (per district, from the shop's PIN).
 *
 * A pending shop is approved with no admin step when ALL hold:
 *   - its GSTIN was verified with the government source (status active), or,
 *     with no GSTIN, its PAN was (status valid). "Verified with the source"
 *     means: VERIFIED by the provider itself (not by a reviewer), the name on
 *     record matching within rule sellerVerification.nameMatchAutoApprove, and —
 *     for a GSTIN — belonging to the shop's PAN (seller verification refuses to
 *     VERIFY a GSTIN whose PAN differs). On a site set to production KYC the mock
 *     provider's answers do not count;
 *   - the registration fee is settled, and every rupee of it came through the
 *     payment gateway with a signature-checked webhook (ONLINE / CASHFREE /
 *     RAZORPAY payments). A fee recorded by staff by hand, or a "success" seen
 *     only in the browser, does not count;
 *   - no other owner's shop already has this GSTIN, PAN or mobile (a likely
 *     duplicate waits for an admin);
 *   - every document today's approval needs is in place, exactly as today:
 *     the mandatory seller documents verified (PAN, GSTIN or the "not
 *     registered" declaration, Shop Act — the database's own onboarding rule,
 *     migration 0051, which no approval may skip) and the shop-type documents
 *     (FSSAI for food, licences for pharmacies and clinics), which
 *     approveShopTransaction checks. A missing one is named in the log.
 * Anything else: the shop stays PENDING_APPROVAL on the existing admin path,
 * and the reasons are logged. Every decision is in shop_auto_approval_log.
 * A provider outage leaves the verification PENDING; the seller-verification
 * sweep retries it and, once VERIFIED, calls autoApproveShopIfReady again.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { SELLER_DOC_LABELS } from "@/lib/kyc/doc-formats";
import { db } from "@/server/db";
import { sellerVerifications, shopAutoApprovalLog, shopPayments, shopRegistrationDrafts, shops, type Shop } from "@/server/db/schema";
import { findLikelyDuplicate } from "@/server/dealers/attribution";
import { flagCoversDistrict, getFeatureFlag } from "./feature-flags";
import { districtCodeForPincode } from "./geo-areas";
import { getRule } from "./settings";
import { deferredReviewDocTypes, missingMandatoryDocuments } from "./shop-onboarding";

/** Payment methods only a verified gateway webhook writes. */
export const GATEWAY_CONFIRMED_METHODS = ["ONLINE", "CASHFREE", "RAZORPAY"] as const;

export interface GovDecision {
  approve: boolean;
  reasons: string[];
  evidence: Record<string, unknown>;
}

/**
 * Is the instant-approval rule on for this shop? Its district's flag decides — except for a
 * shop registered through the onboarding wizard, which is approved this way in every district
 * (owner decision B, 28 Oct 2026; docs/shop-onboarding-wizard-2026-10).
 */
export async function govAutoApprovalApplies(shop: Pick<Shop, "id" | "pincode">): Promise<boolean> {
  if (await isWizardShop(shop.id)) return true;
  const flag = await getFeatureFlag("gov_verification_auto_approval_enabled");
  if (!flag.enabled) return false;
  return flagCoversDistrict(flag, await districtCodeForPincode(shop.pincode));
}

/** The shop was created from an onboarding-wizard draft. */
export async function isWizardShop(shopId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: shopRegistrationDrafts.id })
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.shopId, shopId), inArray(shopRegistrationDrafts.status, ["SUBMITTED", "COMPLETED"])))
    .limit(1);
  return Boolean(row);
}

type VerificationRow = typeof sellerVerifications.$inferSelect;

function sourceCheck(v: VerificationRow | undefined, threshold: number, productionKyc: boolean): { ok: boolean; reason: string | null; evidence: Record<string, unknown> | null } {
  if (!v) return { ok: false, reason: "not submitted", evidence: null };
  const details = (v.details ?? {}) as { docStatus?: string };
  const evidence = {
    verificationId: v.id,
    status: v.status,
    sourceStatus: details.docStatus ?? null,
    provider: v.providerId,
    providerRef: v.providerRef,
    nameMatchScore: v.nameMatchScore,
    verifiedAt: v.verifiedAt?.toISOString() ?? null,
    number: v.numberMasked,
    byReviewer: v.reviewerId !== null,
    lastError: v.lastErrorCode,
  };
  if (v.status !== "VERIFIED") {
    return { ok: false, reason: v.status === "PENDING" ? "waiting for the government source (will retry)" : `status ${v.status.toLowerCase().replace("_", " ")}${v.lastErrorCode ? ` (${v.lastErrorCode})` : ""}`, evidence };
  }
  if (v.reviewerId) return { ok: false, reason: "verified by a reviewer, not by the government source", evidence };
  if (!v.providerId) return { ok: false, reason: "no provider on record", evidence };
  if (productionKyc && v.providerId === "mock") return { ok: false, reason: "verified by the test provider, not the government source", evidence };
  if (details.docStatus && details.docStatus !== "active") return { ok: false, reason: `source status ${details.docStatus}`, evidence };
  if (v.nameMatchScore != null && v.nameMatchScore < threshold) return { ok: false, reason: `name match ${v.nameMatchScore} below ${threshold}`, evidence };
  return { ok: true, reason: null, evidence };
}

/** The decision for one pending shop, with every reason it cannot be approved yet. */
export async function decideGovAutoApproval(shop: Shop): Promise<GovDecision> {
  const reasons: string[] = [];
  const evidence: Record<string, unknown> = { pincode: shop.pincode };
  if (shop.status !== "PENDING_APPROVAL") reasons.push(`shop is ${shop.status.toLowerCase().replace("_", " ")}`);

  // Government verification: GSTIN when the shop has one, else PAN.
  const rule = await getRule("sellerVerification");
  const productionKyc = getEnv().KYC_ENV === "production";
  const rows = await db
    .select()
    .from(sellerVerifications)
    .where(and(eq(sellerVerifications.shopId, shop.id), inArray(sellerVerifications.docType, ["GSTIN", "PAN"])))
    .orderBy(desc(sellerVerifications.updatedAt));
  const latest = (t: "GSTIN" | "PAN") => rows.find((r) => r.docType === t);
  if (shop.gstin) {
    const gst = sourceCheck(latest("GSTIN"), rule.nameMatchAutoApprove, productionKyc);
    evidence.gstin = gst.evidence;
    if (!gst.ok) reasons.push(`GSTIN: ${gst.reason}`);
    // With both given, a verified PAN is recorded too (the GSTIN's own check already tied it to this PAN).
    if (latest("PAN")) evidence.pan = sourceCheck(latest("PAN"), rule.nameMatchAutoApprove, productionKyc).evidence;
  } else {
    const pan = sourceCheck(latest("PAN"), rule.nameMatchAutoApprove, productionKyc);
    evidence.pan = pan.evidence;
    if (!pan.ok) reasons.push(`PAN: ${pan.reason}`);
  }

  // The fee, through the gateway only.
  const fee = shop.registrationFeePaise ?? 0;
  const payments = await db
    .select({ amountPaise: shopPayments.amountPaise, method: shopPayments.method, reference: shopPayments.reference, paidAt: shopPayments.createdAt })
    .from(shopPayments)
    .where(and(eq(shopPayments.shopId, shop.id), eq(shopPayments.paymentType, "REGISTRATION_FEE")));
  const viaGateway = payments.filter((p) => (GATEWAY_CONFIRMED_METHODS as readonly string[]).includes(p.method));
  const gatewayPaise = viaGateway.reduce((sum, p) => sum + Number(p.amountPaise), 0);
  evidence.payment = {
    feePaise: fee,
    feePaymentStatus: shop.feePaymentStatus,
    gatewayPaise,
    payments: viaGateway.map((p) => ({ method: p.method, amountPaise: Number(p.amountPaise), reference: p.reference, paidAt: p.paidAt.toISOString() })),
    otherPaise: payments.filter((p) => !viaGateway.includes(p)).reduce((sum, p) => sum + Number(p.amountPaise), 0),
  };
  if (shop.feePaymentStatus !== "PAID") reasons.push("registration fee not paid");
  else if (fee > 0 && gatewayPaise < fee) reasons.push("registration fee not confirmed by the payment gateway");

  // The documents every approval needs today (the database refuses an approval without them).
  const missing = await missingMandatoryDocuments(shop, db, { countDeferred: true });
  evidence.documentsMissing = missing;
  const deferred = [...(await deferredReviewDocTypes(shop.id))];
  if (deferred.length) evidence.documentsInReviewAfterApproval = deferred;
  if (missing.length) reasons.push(`documents not yet verified: ${missing.map((d) => SELLER_DOC_LABELS[d]).join(", ")}`);

  // Another owner's shop with the same GSTIN, PAN or mobile.
  const duplicate = await findLikelyDuplicate(shop.id);
  evidence.duplicate = duplicate;
  if (duplicate.kind === "DUPLICATE") reasons.push(`likely duplicate of another shop (${duplicate.reasons.join(", ").toLowerCase()})`);

  return { approve: reasons.length === 0, reasons, evidence };
}

/** Appends a decision, unless the shop's last one says the same. */
export async function logGovDecision(shopId: string, outcome: "APPROVED" | "PENDING", reasons: string[], evidence: Record<string, unknown>): Promise<void> {
  const [last] = await db.select().from(shopAutoApprovalLog).where(eq(shopAutoApprovalLog.shopId, shopId)).orderBy(desc(shopAutoApprovalLog.createdAt)).limit(1);
  if (last && last.outcome === outcome && JSON.stringify(last.reasons) === JSON.stringify(reasons)) return;
  await db.insert(shopAutoApprovalLog).values({ shopId, outcome, reasons, evidence });
}

export interface AutoApprovalLogView {
  id: string;
  shopId: string;
  shopName: string;
  shopStatus: string;
  registrationNumber: string | null;
  outcome: "APPROVED" | "PENDING";
  reasons: string[];
  evidence: Record<string, unknown>;
  createdAt: Date;
}

/** Staff: the decisions, newest first (only the latest per shop unless `all`). */
export async function listGovDecisions(filter: { outcome?: "APPROVED" | "PENDING"; all?: boolean } = {}): Promise<AutoApprovalLogView[]> {
  const rows = await db
    .select({ log: shopAutoApprovalLog, shopName: shops.name, shopStatus: shops.status, registrationNumber: shops.registrationNumber })
    .from(shopAutoApprovalLog)
    .innerJoin(shops, eq(shops.id, shopAutoApprovalLog.shopId))
    .orderBy(desc(shopAutoApprovalLog.createdAt))
    .limit(1000);
  const seen = new Set<string>();
  const out: AutoApprovalLogView[] = [];
  for (const r of rows) {
    if (!filter.all) {
      if (seen.has(r.log.shopId)) continue;
      seen.add(r.log.shopId);
    }
    if (filter.outcome && r.log.outcome !== filter.outcome) continue;
    // "Pending" means still waiting: a shop approved since by a person (or without its
    // documents, 0109) or rejected is no longer pending, whatever its last decision said.
    if (filter.outcome === "PENDING" && r.shopStatus !== "PENDING_APPROVAL") continue;
    out.push({
      id: r.log.id,
      shopId: r.log.shopId,
      shopName: r.shopName,
      shopStatus: r.shopStatus,
      registrationNumber: r.registrationNumber,
      outcome: r.log.outcome,
      reasons: r.log.reasons,
      evidence: r.log.evidence,
      createdAt: r.log.createdAt,
    });
  }
  return out;
}
