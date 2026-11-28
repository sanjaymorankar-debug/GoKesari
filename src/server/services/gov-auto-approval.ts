/**
 * Instant approval on government GST/PAN verification + online payment
 * (docs/dealer-programme, GKS-SH-004). Always on since the owner brief of
 * 08-Nov-2026 (one registration flow); the flag gov_verification_auto_approval_enabled
 * that used to switch it per district is retired.
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
 *   - no other shop already has this GSTIN or PAN (a shop not registered through the
 *     wizard is also held for the same mobile or a similar name nearby);
 *   - every document the approval needs is in place. A shop registered through the
 *     onboarding wizard (owner decision 29 Oct 2026, "follow the brief"; 0118) needs only
 *     the GSTIN (or PAN) above — licences, FSSAI included (DI-14), and the Shop Act are
 *     uploaded after go-live. Any other shop, exactly as before:
 *     the mandatory seller documents verified (PAN, GSTIN or the "not
 *     registered" declaration, Shop Act — the database's own onboarding rule,
 *     migration 0051, which no approval may skip) and the shop-type documents
 *     (FSSAI for food, licences for pharmacies and clinics), which
 *     approveShopTransaction checks. A missing one is named in the log.
 * Anything else: the shop stays PENDING_APPROVAL on the existing admin path,
 * and the reasons are logged. Every decision is in shop_auto_approval_log.
 * A provider outage leaves the verification PENDING; the seller-verification
 * sweep retries it and, once VERIFIED, calls autoApproveShopIfReady again.
 *
 * 0232 (owner, 28-Nov-2026 ~12.00 IST) — an onboarding v2 / v3 registration: live on GST or PAN verified (a
 * reviewer's verification counts), the fee through the gateway (or pay-later approved) and the agreement (checked
 * before this runs). A weak / missing name or a PAN that is not the one inside the GSTIN is a review flag, not a
 * reason; the only hold is another OWNER's shop with the same GSTIN or PAN (decision.duplicateOfOtherOwner → the
 * SHOP_REVIEW escalation, support-escalations.ts).
 */
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { SELLER_DOC_LABELS } from "@/lib/kyc/doc-formats";
import { db } from "@/server/db";
import { sellerVerifications, shopAutoApprovalLog, shopPayments, shops, type Shop, type ShopReviewFlagType } from "@/server/db/schema";
import { findLikelyDuplicate } from "@/server/dealers/attribution";
import { getRule } from "./settings";
import { deferredReviewDocTypes, isDocumentsLaterShop, isV2RegisteredShop, isWizardRegisteredShop, missingMandatoryDocuments } from "./shop-onboarding";

/** Payment methods only a verified gateway webhook writes. */
export const GATEWAY_CONFIRMED_METHODS = ["ONLINE", "CASHFREE", "RAZORPAY"] as const;

export interface GovDecision {
  approve: boolean;
  reasons: string[];
  evidence: Record<string, unknown>;
  /** 0232: the shop came from an onboarding v2 / v3 registration (the owner's go-live rule of 28-Nov-2026). */
  v2?: boolean;
  /** 0232 (v2 / v3): what to look at after go-live — never a hold (shop_review_flags). */
  reviewFlags?: { flag: ShopReviewFlagType; details: Record<string, unknown> }[];
  /** 0232 (v2 / v3): another owner's shop has the same GSTIN or PAN — the only hold left (SHOP_REVIEW escalation). */
  duplicateOfOtherOwner?: { shopId: string; reasons: ("GSTIN" | "PAN")[] } | null;
}

/**
 * 0232 (owner, 28-Nov-2026): another owner's shop (not closed, not rejected) with the same GSTIN or PAN. The same
 * owner's other shops never count.
 */
export async function otherOwnerWithSameIdentity(shop: Pick<Shop, "id" | "ownerId" | "gstin" | "panHash">): Promise<{ shopId: string; reasons: ("GSTIN" | "PAN")[] } | null> {
  if (!shop.gstin && !shop.panHash) return null;
  const rows = await db
    .select({ id: shops.id, gstin: shops.gstin, panHash: shops.panHash })
    .from(shops)
    .where(
      and(
        ne(shops.id, shop.id),
        ne(shops.ownerId, shop.ownerId),
        isNull(shops.deletedAt),
        ne(shops.status, "REJECTED"),
        or(shop.gstin ? eq(shops.gstin, shop.gstin) : undefined, shop.panHash ? eq(shops.panHash, shop.panHash) : undefined),
      ),
    )
    .limit(1);
  const hit = rows[0];
  if (!hit) return null;
  const reasons: ("GSTIN" | "PAN")[] = [];
  if (shop.gstin && hit.gstin === shop.gstin) reasons.push("GSTIN");
  if (shop.panHash && hit.panHash === shop.panHash) reasons.push("PAN");
  return { shopId: hit.id, reasons };
}

/**
 * Is the instant-approval rule on for this shop? Yes, for every shop in every district (owner
 * decision B, 28 Oct 2026, and the one-flow brief of 08-Nov-2026). Kept as a function so the
 * callers read the same as before.
 */
export async function govAutoApprovalApplies(): Promise<boolean> {
  return true;
}

/** The shop was created from an onboarding-wizard draft. */
export const isWizardShop = (shopId: string): Promise<boolean> => isWizardRegisteredShop(shopId);

type VerificationRow = typeof sellerVerifications.$inferSelect;

function sourceCheck(
  v: VerificationRow | undefined,
  threshold: number,
  productionKyc: boolean,
  /** 0232: a v2 / v3 registration — a weak or missing name is a review flag, not a hold; a reviewer's verification counts. */
  v2 = false,
): { ok: boolean; reason: string | null; evidence: Record<string, unknown> | null; flags: ShopReviewFlagType[] } {
  const flags: ShopReviewFlagType[] = [];
  const result = (ok: boolean, reason: string | null, evidence: Record<string, unknown> | null) => ({ ok, reason, evidence, flags });
  if (!v) return result(false, "not submitted", null);
  const details = (v.details ?? {}) as { docStatus?: string; reviewFlag?: string };
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
    return result(false, v.status === "PENDING" ? "waiting for the government source (will retry)" : `status ${v.status.toLowerCase().replace("_", " ")}${v.lastErrorCode ? ` (${v.lastErrorCode})` : ""}`, evidence);
  }
  // 0232: DEFAULT – confirm with Sanjay: for a v2 / v3 registration a number GoKesari's reviewer verified counts as
  // "GST or PAN verified" (the owner's rule), so a shop whose source check needed a person still goes live.
  if (v.reviewerId && !v2) return result(false, "verified by a reviewer, not by the government source", evidence);
  if (!v.providerId && !(v2 && v.reviewerId)) return result(false, "no provider on record", evidence);
  if (productionKyc && v.providerId === "mock") return result(false, "verified by the test provider, not the government source", evidence);
  if (details.docStatus && details.docStatus !== "active") return result(false, `source status ${details.docStatus}`, evidence);
  if (v2 && (details.reviewFlag === "NAME_MATCH_LOW" || details.reviewFlag === "NAME_NOT_RETURNED" || details.reviewFlag === "PAN_NOT_IN_GSTIN")) flags.push(details.reviewFlag);
  if (v.nameMatchScore != null && v.nameMatchScore < threshold) {
    // 0232 (owner, 28-Nov-2026): not a hold for a v2 / v3 registration when the number itself is verified.
    if (!v2) return result(false, `name match ${v.nameMatchScore} below ${threshold}`, evidence);
    if (!flags.includes("NAME_MATCH_LOW")) flags.push("NAME_MATCH_LOW");
  }
  return result(true, null, evidence);
}

/** The decision for one pending shop, with every reason it cannot be approved yet. */
export async function decideGovAutoApproval(shop: Shop): Promise<GovDecision> {
  const reasons: string[] = [];
  const evidence: Record<string, unknown> = { pincode: shop.pincode };
  if (shop.status !== "PENDING_APPROVAL") reasons.push(`shop is ${shop.status.toLowerCase().replace("_", " ")}`);
  // 0232 (owner, 28-Nov-2026 ~12.00 IST): a v2 / v3 registration goes live on its referral code, GST or PAN verified,
  // every term accepted (checked before this runs) and the fee through the gateway (or pay-later approved). The rest
  // is a review flag after go-live; the only hold is another owner's shop with the same GSTIN or PAN.
  const v2 = await isV2RegisteredShop(shop.id);
  const flags: { flag: ShopReviewFlagType; details: Record<string, unknown> }[] = [];
  const addFlags = (docType: "GSTIN" | "PAN", found: ShopReviewFlagType[], row: VerificationRow | undefined) => {
    for (const flag of found) {
      if (!flags.some((f) => f.flag === flag)) flags.push({ flag, details: { docType, verificationId: row?.id ?? null, nameMatchScore: row?.nameMatchScore ?? null, threshold: null } });
    }
  };
  if (v2) evidence.flowVersion = "v2";

  // Government verification: GSTIN when the shop has one, else PAN.
  const rule = await getRule("sellerVerification");
  const productionKyc = getEnv().KYC_ENV === "production";
  const rows = await db
    .select()
    .from(sellerVerifications)
    .where(and(eq(sellerVerifications.shopId, shop.id), inArray(sellerVerifications.docType, ["GSTIN", "PAN"])))
    .orderBy(desc(sellerVerifications.updatedAt));
  const latest = (t: "GSTIN" | "PAN") => rows.find((r) => r.docType === t);
  // 0120: registered with "upload documents later" — live on payment; payouts wait for the GSTIN / PAN.
  if (await isDocumentsLaterShop(shop.id)) {
    evidence.documentsLater = true;
  } else if (shop.gstin) {
    const gst = sourceCheck(latest("GSTIN"), rule.nameMatchAutoApprove, productionKyc, v2);
    evidence.gstin = gst.evidence;
    if (!gst.ok) reasons.push(`GSTIN: ${gst.reason}`);
    addFlags("GSTIN", gst.flags, latest("GSTIN"));
    // With both given, a verified PAN is recorded too, and it must be the PAN inside the GSTIN
    // (whichever was checked first — a PAN added after the GSTIN is compared here as well).
    const panRow = latest("PAN");
    if (panRow) {
      const pan = sourceCheck(panRow, rule.nameMatchAutoApprove, productionKyc, v2);
      evidence.pan = pan.evidence;
      addFlags("PAN", pan.flags, panRow);
    }
    const embedded = (latest("GSTIN")?.details as Record<string, unknown> | null)?.embeddedPanHash;
    if (panRow?.numberHash && typeof embedded === "string" && panRow.numberHash !== embedded) {
      // 0232: a v2 / v3 registration with a verified GSTIN goes live; the PAN difference is looked at after go-live.
      if (v2) addFlags("PAN", ["PAN_NOT_IN_GSTIN"], panRow);
      else reasons.push("PAN is not the one inside the GSTIN");
    }
  } else {
    const pan = sourceCheck(latest("PAN"), rule.nameMatchAutoApprove, productionKyc, v2);
    evidence.pan = pan.evidence;
    if (!pan.ok) reasons.push(`PAN: ${pan.reason}`);
    addFlags("PAN", pan.flags, latest("PAN"));
  }
  for (const f of flags) f.details.threshold = rule.nameMatchAutoApprove;

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
  // 0229 (docs/fee-pay-later-2026-11): an administrator approved paying the fee later — the fee does not hold the shop.
  const payLater = shop.feePaymentStatus !== "PAID" && (await (await import("./fee-pay-later")).feeDeferredByApproval(shop.id));
  if (payLater) evidence.payLater = { approved: true, duePaise: Math.max(0, fee - shop.amountPaidPaise) };
  else if (shop.feePaymentStatus !== "PAID") reasons.push("registration fee not paid");
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
  if (v2) {
    // 0232: held ONLY when a shop of a DIFFERENT owner has the same GSTIN or PAN; the same owner's shops never.
    const other = await otherOwnerWithSameIdentity(shop);
    evidence.identityDuplicate = other;
    if (other) reasons.push(`likely duplicate of another owner's shop (${other.reasons.join(", ").toLowerCase()})`);
    if (flags.length) evidence.reviewFlags = flags.map((f) => f.flag);
    return { approve: reasons.length === 0, reasons, evidence, v2: true, reviewFlags: flags, duplicateOfOtherOwner: other };
  }
  // Owner, 08-Nov-2026: verified and paid means live. A registration through the wizard is held only when
  // another shop has the same GSTIN or PAN; a similar name nearby or a shared mobile is recorded, not held.
  const heldOnlyForIdentity = await isWizardShop(shop.id);
  const holds = duplicate.kind === "DUPLICATE" && (!heldOnlyForIdentity || duplicate.reasons.some((r) => r === "GSTIN" || r === "PAN"));
  if (holds) reasons.push(`likely duplicate of another shop (${duplicate.reasons.join(", ").toLowerCase()})`);

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
