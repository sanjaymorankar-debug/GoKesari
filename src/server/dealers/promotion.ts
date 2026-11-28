/**
 * A shop owner promoted to dealer / franchisee (owner, 28-Nov-2026): "when a franchisee, a shop owner is getting
 * promoted to dealer / franchise, this option is also enabled" — the same as the new shop registration, where the
 * shop owner's account is the customer account.
 *
 * 1. One account, nothing typed again. The shop owner's existing account becomes the dealer; name, PAN / GSTIN,
 *    address, mobile and e-mail come from his live shop and account, and so does the payout bank account when it is
 *    verified there. What the shop already verified (PAN, GSTIN, the bank's ₹1 check, the signed-in mobile) counts as
 *    verified for the dealer too — no second online check, no vendor fee. Paths: the free franchisee request and paid
 *    franchise start (/franchise/start), the full application (/dealer/apply) and the pay-first franchise buyer.
 *
 * 2. Four-eye approval. An admin's Approve of a shop owner's promotion (a free franchisee request, or a dealer
 *    application from the owner of a live shop) only records a pending decision (approval type
 *    DEALER_PROMOTION_APPROVE). A DIFFERENT admin or operator confirms it — in Admin → Dealers or
 *    POST /api/approvals/{id}/decide — and only then decideDealer approves: the GKD code, the DEALER role, the role
 *    history and the e-mail. Strict: nobody confirms their own decision, not even a lone Super Admin. Always on for
 *    these promotions, whatever flag dealer_platform_four_eye (scheme publish / change, franchise refunds) says.
 *    A paid franchise is not a promotion here: it stays live on payment (onboarding v2) or on its KYC approval.
 */
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";

import { DEALER_STATUS_LABELS } from "@/lib/dealers";
import { AppError, conflict, forbidden, notFound } from "@/lib/errors";
import { decryptSecret, maskPan } from "@/lib/pan-crypto";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import { approvalRequests, bankAccounts, dealers, dealerVerifications, users, type BankAccount, type Dealer, type Shop, type User, type UserRole } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";

import type { DealerActor, DealerApplicationInput, DealerDecision } from "./service";

export const DEALER_PROMOTION_APPROVAL = "DEALER_PROMOTION_APPROVE" as const;
/** Who may confirm a promotion an admin approved (a different person). DEFAULT – confirm with Sanjay: admin or operator, as the owner's "second admin or operator". */
export const PROMOTION_CONFIRMER_ROLES: readonly UserRole[] = ["ADMIN", "OPERATOR"];
/** Where the confirmed provenance of a shop-verified PAN / GSTIN is recorded (dealer_verifications.provider). */
export const SHOP_VERIFIED_PROVIDER = "SHOP_VERIFIED";

const OPEN_FOR_DETAILS: readonly Dealer["status"][] = ["DRAFT", "PENDING", "REJECTED"];
const digits10 = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");

/* ============================================================= shop details */

export interface ShopDetailsView {
  shopId: string;
  shopName: string;
  legalName: string;
  contactName: string;
  mobileMasked: string | null;
  mobileVerified: boolean;
  email: string | null;
  emailVerified: boolean;
  panMasked: string | null;
  panVerified: boolean;
  gstin: string | null;
  gstVerified: boolean;
  address: { line1: string | null; city: string | null; pincode: string | null; state: string | null };
  /** Only a payout account verified on the shop (or the owner's own verified account); null otherwise. */
  bank: { holderName: string; accountMasked: string; ifsc: string } | null;
}

interface ShopDetails {
  shop: Shop;
  user: User;
  view: ShopDetailsView;
  mobile: string | null;
  mobileVerified: boolean;
  email: string | null;
  panVerified: boolean;
  gstVerified: boolean;
  bank: BankAccount | null;
}

/** The shop's PAN counts as verified: checked at the source (or by an admin) for the number on the shop now. */
function shopPanVerified(shop: Shop): boolean {
  return shop.panStatus === "VERIFIED" && !!shop.panVerifiedAt && !!shop.panHash && !!shop.panNumberEncrypted;
}

/** The shop's GSTIN counts as verified: a registered GSTIN checked at the source or by an admin. */
function shopGstVerified(shop: Shop): boolean {
  return !!shop.gstin && !!shop.gstVerifiedAt && (shop.gstStatus === "REGISTERED" || shop.gstStatus === "COMPOSITION") && shop.gstVerificationSource !== "SELF_DECLARED";
}

/** The verified payout bank account of the shop, else the owner's own verified account (bank transfer only, never UPI). */
async function verifiedBank(shop: Shop, userId: string, client: DbClient): Promise<BankAccount | null> {
  const rows = await client
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.userId, userId), eq(bankAccounts.isCurrent, true), eq(bankAccounts.status, "VERIFIED"), eq(bankAccounts.method, "BANK_ACCOUNT")));
  const usable = rows.filter((r) => r.accountNumberEncrypted && r.ifsc && r.accountNumberLast4);
  return usable.find((r) => r.shopId === shop.id) ?? usable.find((r) => r.shopId === null) ?? null;
}

/** The owner's live shop and account details for a dealer row, or null when he has no live shop. */
async function shopDetails(userId: string, client: DbClient = db): Promise<ShopDetails | null> {
  const { liveShopForUser } = await import("@/server/onboarding-v2/franchise");
  const shop = await liveShopForUser(userId, client);
  if (!shop) return null;
  const [user] = await client.select().from(users).where(eq(users.id, userId));
  if (!user) return null;
  const accountMobile = digits10(user.phoneE164 ?? user.phone);
  const mobile = accountMobile || digits10(shop.phone) || null;
  const mobileVerified = !!mobile && !!user.phoneVerifiedAt && accountMobile === mobile;
  const email = user.emailPlaceholder ? (shop.email ?? null) : (user.email ?? null);
  const bank = await verifiedBank(shop, userId, client);
  const panVerified = shopPanVerified(shop);
  const gstVerified = shopGstVerified(shop);
  const legalName = (shop.legalBusinessName || user.name || shop.ownerName || shop.name).replace(/\s+/g, " ").trim().slice(0, 120);
  const contactName = (user.name || shop.ownerName || legalName).replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    shop,
    user,
    mobile,
    mobileVerified,
    email,
    panVerified,
    gstVerified,
    bank,
    view: {
      shopId: shop.id,
      shopName: shop.name,
      legalName,
      contactName,
      mobileMasked: mobile ? `+91••••••${mobile.slice(-4)}` : null,
      mobileVerified,
      email,
      emailVerified: !!email && email === user.email && !!user.emailVerified,
      panMasked: shop.panLast4 && shop.panNumberEncrypted ? maskPan(shop.panLast4) : null,
      panVerified,
      gstin: shop.gstin ?? null,
      gstVerified,
      address: { line1: shop.addressLine1 ?? null, city: shop.city ?? null, pincode: shop.pincode ?? null, state: shop.state ?? null },
      bank: bank ? { holderName: bank.accountHolderName, accountMasked: `••••${bank.accountNumberLast4}`, ifsc: bank.ifsc! } : null,
    },
  };
}

/** What a shop owner's dealer screens show read-only ("from your shop"); null without a live shop. */
export async function shopDetailsForUser(userId: string, client: DbClient = db): Promise<ShopDetailsView | null> {
  return (await shopDetails(userId, client))?.view ?? null;
}

/** A PAN already on another open dealer is never copied (the PAN is unique among dealers that are not rejected). */
async function panFreeFor(panHash: string, userId: string, client: DbClient): Promise<boolean> {
  const [taken] = await client
    .select({ id: dealers.id })
    .from(dealers)
    .where(and(eq(dealers.panHash, panHash), ne(dealers.status, "REJECTED"), ne(dealers.userId, userId)))
    .limit(1);
  return !taken;
}

/**
 * /dealer/apply: the shop owner's blanks filled from his live shop and account — names, mobile, PAN, GSTIN and
 * address. What he typed is kept (he may correct it). Without a live shop the input is returned unchanged.
 */
export async function withShopDefaults(input: DealerApplicationInput, userId: string, client: DbClient = db): Promise<DealerApplicationInput> {
  const d = await shopDetails(userId, client);
  if (!d) return input;
  const [saved] = await client.select().from(dealers).where(eq(dealers.userId, userId)).orderBy(desc(dealers.createdAt)).limit(1);
  const blank = (v: string | null | undefined) => !v || !v.trim();
  const out: DealerApplicationInput = { ...input };
  if (blank(out.legalName)) out.legalName = d.view.legalName;
  if (blank(out.contactName)) out.contactName = d.view.contactName;
  if (blank(out.mobile) && !saved?.mobileE164 && d.mobile) out.mobile = d.mobile;
  const shopPan = d.shop.panNumberEncrypted && d.shop.panHash && (await panFreeFor(d.shop.panHash, userId, client)) ? decryptSecret(d.shop.panNumberEncrypted) : null;
  if (blank(out.pan) && !saved?.panHash && shopPan) out.pan = shopPan;
  const pan = (out.pan ?? "").trim().toUpperCase() || (saved?.panEnc ? decryptSecret(saved.panEnc) : null);
  // The shop's GSTIN only when it belongs to the PAN the application carries (saveApplication refuses a mismatch).
  if (blank(out.gstin) && d.shop.gstin && (!pan || d.shop.gstin.slice(2, 12) === pan)) out.gstin = d.shop.gstin;
  if (blank(out.addressLine1) && blank(out.city) && blank(out.pincode) && d.shop.addressLine1 && d.shop.city && d.shop.pincode) {
    Object.assign(out, { addressLine1: d.shop.addressLine1, city: d.shop.city, pincode: d.shop.pincode, state: out.state || d.shop.state });
  }
  return out;
}

/**
 * Completes an open (draft / pending / rejected) dealer row of a shop owner from his live shop and account: fills
 * only what is missing, and carries over what the shop already verified — the mobile (his signed-in, verified
 * number), the PAN and GSTIN (recorded as verified checks, provider SHOP_VERIFIED, so no second online check) and the
 * payout bank account verified on the shop. Never overwrites what the dealer gave himself (a different PAN, GSTIN or
 * account stays, and is checked as usual). Idempotent; audited when it changes anything. Returns the row.
 *
 * DEFAULT – confirm with Sanjay: copying the shop's verified bank account needs no fresh SMS + e-mail step-up
 * (dual_auth BANK_CHANGE) — it is the same person's account, already verified by the bank for his shop.
 */
export async function applyShopDetails(dealerId: string, actor: DealerActor, client: DbClient = db): Promise<Dealer> {
  const [dealer] = await client.select().from(dealers).where(eq(dealers.id, dealerId));
  if (!dealer) throw notFound("Dealer");
  if (!dealer.userId || dealer.isInternal || !OPEN_FOR_DETAILS.includes(dealer.status)) return dealer;
  const d = await shopDetails(dealer.userId, client);
  if (!d) return dealer;
  const now = new Date();
  const fill: Partial<typeof dealers.$inferInsert> = {};

  if (!dealer.mobileE164 && d.mobile) Object.assign(fill, { mobileE164: `+91${d.mobile}` });
  const mobile = digits10(fill.mobileE164 ?? dealer.mobileE164);
  if (!dealer.mobileVerifiedAt && d.mobileVerified && mobile === d.mobile) Object.assign(fill, { mobileVerifiedAt: now, mobileVerificationMethod: "OTP" as const });
  if (!dealer.email && d.email) fill.email = d.email;
  if (!dealer.emailVerifiedAt && (fill.email ?? dealer.email) === d.user.email && d.user.emailVerified && !d.user.emailPlaceholder) fill.emailVerifiedAt = d.user.emailVerified;
  if (!dealer.panHash && d.shop.panHash && d.shop.panNumberEncrypted && (await panFreeFor(d.shop.panHash, dealer.userId, client))) {
    Object.assign(fill, { panEnc: d.shop.panNumberEncrypted, panHash: d.shop.panHash, panLast4: d.shop.panLast4 });
  }
  const pan = fill.panHash ?? dealer.panHash;
  if (!dealer.gstin && d.shop.gstin && (!pan || pan === d.shop.panHash)) fill.gstin = d.shop.gstin;
  if (!dealer.addressLine1 && d.shop.addressLine1) Object.assign(fill, { addressLine1: d.shop.addressLine1, city: d.shop.city, pincode: d.shop.pincode, state: d.shop.state });

  // The payout bank: the shop's verified account when the dealer has none, or has the very same one still unverified.
  if (dealer.bankStatus !== "VERIFIED" && d.bank) {
    const same = !!dealer.bankAccountEnc && dealer.bankIfsc === d.bank.ifsc && decryptSecret(dealer.bankAccountEnc) === decryptSecret(d.bank.accountNumberEncrypted!);
    if (!dealer.bankAccountEnc || same) {
      Object.assign(fill, {
        bankHolderName: d.bank.accountHolderName,
        bankAccountEnc: d.bank.accountNumberEncrypted,
        bankAccountLast4: d.bank.accountNumberLast4,
        bankIfsc: d.bank.ifsc,
        bankStatus: "VERIFIED" as const,
        bankVerifiedAt: d.bank.verifiedAt ?? now,
        bankStatusReason: `Verified by the bank for the shop ${d.shop.name}; reused for the dealer account.`,
        bankCheckRef: d.bank.gatewayReference,
      });
    }
  }

  let row = dealer;
  if (Object.keys(fill).length) {
    [row] = await client.update(dealers).set({ ...fill, updatedAt: now }).where(eq(dealers.id, dealer.id)).returning();
  }

  // The shop's verified PAN / GSTIN for the number now on the dealer row: a verified check (no second vendor call).
  const reused: string[] = [];
  const checks = await client.select().from(dealerVerifications).where(eq(dealerVerifications.dealerId, dealer.id));
  const record = async (docType: "PAN" | "GSTIN", numberKey: string, matchedName: string | null, details: Record<string, string | null>) => {
    if (checks.some((c) => c.docType === docType && c.numberKey === numberKey && c.status === "VERIFIED")) return;
    const values = { numberKey, status: "VERIFIED" as const, matchedName, nameScore: null, errorCode: null, provider: SHOP_VERIFIED_PROVIDER, providerRef: d.shop.id, details, checkedBy: actor.id, checkedAt: now };
    await client
      .insert(dealerVerifications)
      .values({ dealerId: dealer.id, docType, ...values })
      .onConflictDoUpdate({ target: [dealerVerifications.dealerId, dealerVerifications.docType], set: values });
    reused.push(docType);
  };
  if (d.panVerified && row.panHash && row.panHash === d.shop.panHash) await record("PAN", row.panHash, d.shop.panHolderName ?? null, {});
  if (d.gstVerified && row.gstin && row.gstin === d.shop.gstin) {
    await record("GSTIN", row.gstin, d.shop.gstTradeName ?? d.shop.legalBusinessName ?? null, { stateCode: d.shop.gstStateCode ?? null, pincode: d.shop.pincode ?? null });
  }

  if (Object.keys(fill).length || reused.length) {
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_APPLICATION_SAVED,
        entityType: "dealer",
        entityId: dealer.id,
        newValue: { via: "shop_details_reused", shopId: d.shop.id, filled: Object.keys(fill).filter((k) => k !== "panEnc" && k !== "bankAccountEnc"), verifiedFromShop: reused },
      },
      client,
    );
  }
  return row;
}

/* ============================================================= four-eye */

/**
 * Is approving this dealer a shop owner's promotion (four-eye)? A free franchisee request (source SHOP_REQUEST), or
 * any application whose account owns a live shop. Not GoKesari's own dealer account, and not a paid franchise owner
 * (live on payment / on his KYC approval, owner's rule).
 * DEFAULT – confirm with Sanjay: "shop owner" = owns a LIVE shop at approval; an applicant whose shop is still
 * waiting for approval is approved by one admin as before.
 */
export async function isShopOwnerPromotion(dealer: Dealer, client: DbClient = db): Promise<boolean> {
  if (dealer.isInternal || !dealer.userId) return false;
  const { franchiseZonesOfDealer } = await import("./service");
  if ((await franchiseZonesOfDealer(dealer.id, client)).length) return false;
  if (dealer.source === "SHOP_REQUEST") return true;
  const { liveShopForUser } = await import("@/server/onboarding-v2/franchise");
  return !!(await liveShopForUser(dealer.userId, client));
}

/** decideDealer's guard: the request is this dealer's promotion, confirmed by someone other than the admin who approved it. */
export async function assertPromotionConfirmed(approvalId: string, dealerId: string, client: DbClient = db): Promise<void> {
  const [request] = await client.select().from(approvalRequests).where(eq(approvalRequests.id, approvalId));
  if (!request || request.type !== DEALER_PROMOTION_APPROVAL || request.subjectId !== dealerId) throw forbidden("This confirmation is not for this dealer.");
  if (request.status !== "APPROVED" || request.appliedAt) throw conflict("This promotion has not been confirmed (or was already applied).");
  if (!request.decidedBy || request.decidedBy === request.requestedBy) throw forbidden("A different admin or operator must confirm this promotion.");
}

export interface PendingPromotion {
  approvalId: string;
  dealerId: string;
  dealerName: string;
  contactName: string;
  source: string;
  agreementStart: string | null;
  agreementEnd: string | null;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: string;
}

async function pendingRows(dealerId?: string, client: DbClient = db): Promise<PendingPromotion[]> {
  const rows = await client
    .select({ request: approvalRequests, name: users.name, email: users.email })
    .from(approvalRequests)
    .leftJoin(users, eq(users.id, approvalRequests.requestedBy))
    .where(and(eq(approvalRequests.type, DEALER_PROMOTION_APPROVAL), eq(approvalRequests.status, "PENDING"), ...(dealerId ? [eq(approvalRequests.subjectId, dealerId)] : [])))
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(200);
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.request.subjectId).filter((s): s is string => !!s))];
  const people = await client.select({ id: dealers.id, legalName: dealers.legalName, contactName: dealers.contactName, source: dealers.source }).from(dealers).where(inArray(dealers.id, ids));
  const byId = new Map(people.map((p) => [p.id, p]));
  return rows
    .filter((r) => r.request.subjectId && byId.has(r.request.subjectId))
    .map((r) => {
      const d = byId.get(r.request.subjectId!)!;
      const p = r.request.payload;
      return {
        approvalId: r.request.id,
        dealerId: d.id,
        dealerName: d.legalName,
        contactName: d.contactName,
        source: d.source,
        agreementStart: typeof p.agreementStart === "string" ? p.agreementStart : null,
        agreementEnd: typeof p.agreementEnd === "string" ? p.agreementEnd : null,
        requestedBy: r.request.requestedBy,
        requestedByName: r.name ?? r.email ?? null,
        requestedAt: r.request.requestedAt.toISOString(),
      };
    });
}

/** Admin → Dealers: every promotion waiting for its second admin / operator, newest first. */
export async function listPendingPromotions(): Promise<PendingPromotion[]> {
  return pendingRows();
}

/** The promotion of one dealer waiting for confirmation, or null. */
export async function pendingPromotionFor(dealerId: string, client: DbClient = db): Promise<PendingPromotion | null> {
  return (await pendingRows(dealerId, client))[0] ?? null;
}

/**
 * Step 1 — the admin's Approve of a shop owner's promotion. Runs every check approval needs now (so the confirmer
 * never meets one the admin could have fixed), then records a pending decision for a different admin or operator.
 * Nothing changes on the dealer yet. One pending decision per dealer.
 */
export async function proposeDealerPromotion(
  dealerId: string,
  decision: Extract<DealerDecision, { action: "APPROVE" }>,
  actor: DealerActor,
): Promise<{ pendingApproval: true; approvalId: string; message: string }> {
  const service = await import("./service");
  const { requireDealerPermission, requireDealerInScope } = await import("./staff-access");
  requireDealerPermission(actor, PERMISSIONS.DEALER_APPROVE, "decide dealers");
  if (actor.role === "REGIONAL_ADMIN") await requireDealerInScope(actor, await service.getDealer(dealerId));
  // The shop's details first (an older request may predate the reuse), then the same checks as the approval.
  await applyShopDetails(dealerId, actor);
  const dealer = await service.assertDealerApprovable(dealerId, decision);
  if (!(await isShopOwnerPromotion(dealer))) throw conflict("This dealer is not a shop owner's promotion; approve it directly.");
  const pending = await pendingPromotionFor(dealerId);
  if (pending) {
    throw conflict(pending.requestedBy === actor.id ? "You already approved this; a different admin or operator must confirm it." : "This promotion is already waiting for confirmation.", { approvalId: pending.approvalId });
  }
  const kind = dealer.source === "SHOP_REQUEST" ? "free franchisee request" : "dealer application";
  const { submitApproval } = await import("@/server/approvals");
  const request = await submitApproval({
    type: DEALER_PROMOTION_APPROVAL,
    actor,
    subjectType: "dealer",
    subjectId: dealerId,
    title: `Promote shop owner to dealer: ${dealer.legalName}`,
    reason: `Approve the ${kind} of ${dealer.legalName} (agreement ${decision.agreementStart} to ${decision.agreementEnd})`,
    payload: {
      dealerId,
      agreementStart: decision.agreementStart,
      agreementEnd: decision.agreementEnd,
      mobileConfirmedByCall: decision.mobileConfirmedByCall === true,
      bankVerifiedByDocument: decision.bankVerifiedByDocument === true,
    },
  });
  // Tell the other admins and operators (never the requester). After the commit; a failed notice never fails it.
  const staff = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.role, [...PROMOTION_CONFIRMER_ROLES]), eq(users.status, "ACTIVE"), isNull(users.deletedAt), ne(users.id, actor.id)));
  for (const s of staff) {
    await notify({
      userId: s.id,
      type: NOTIFICATION_TYPES.STAFF_APPROVAL_PENDING,
      title: `Confirm a promotion to dealer: ${dealer.legalName}`,
      body: `An admin approved the ${kind} of ${dealer.legalName}, a live GoKesari shop. A second admin or operator must confirm it before the dealer code is issued: Admin → Dealers.`,
      actionUrl: `/admin/dealers/${dealerId}`,
      dedupeKey: `dealer-promotion:${request.id}:${s.id}`,
    }).catch((e) => console.error("[dealers] promotion notice failed", dealerId, e));
  }
  return { pendingApproval: true, approvalId: request.id, message: "Sent for confirmation: a different admin or operator must confirm it before the dealer code is issued." };
}

/** The approval's executor (registered in src/server/approvals/dealer-promotion.ts): decideDealer as the admin who approved. */
export async function applyConfirmedPromotion(request: { id: string; payload: Record<string, unknown>; requestedBy: string; requestedByRole: string }, confirmedBy: { id: string }): Promise<void> {
  const p = request.payload;
  const dealerId = typeof p.dealerId === "string" ? p.dealerId : null;
  if (!dealerId || typeof p.agreementStart !== "string" || typeof p.agreementEnd !== "string") throw new AppError("INTERNAL", "Approval payload is missing the dealer or the agreement dates.");
  const service = await import("./service");
  const dealer = await service.getDealer(dealerId);
  if (dealer.status === "APPROVED") return; // approved already (e.g. a second confirmation); nothing to do
  if (dealer.status !== "PENDING") throw conflict(`The application is ${DEALER_STATUS_LABELS[dealer.status].toLowerCase()} now; it cannot be approved.`);
  await service.decideDealer(
    dealerId,
    { action: "APPROVE", agreementStart: p.agreementStart, agreementEnd: p.agreementEnd, mobileConfirmedByCall: p.mobileConfirmedByCall === true, bankVerifiedByDocument: p.bankVerifiedByDocument === true },
    { id: request.requestedBy, role: request.requestedByRole as UserRole },
    { promotionApproval: { id: request.id, confirmedBy: confirmedBy.id } },
  );
}

/** A rejected confirmation: the application stays PENDING; the admin who approved it is told why. */
export async function onPromotionRejected(request: { id: string; subjectId: string | null; requestedBy: string; decisionComment: string | null }): Promise<void> {
  if (!request.subjectId) return;
  const [dealer] = await db.select({ legalName: dealers.legalName }).from(dealers).where(eq(dealers.id, request.subjectId));
  await notify({
    userId: request.requestedBy,
    type: NOTIFICATION_TYPES.STAFF_APPROVAL_PENDING,
    title: `Promotion not confirmed: ${dealer?.legalName ?? "dealer"}`,
    body: `The second admin / operator did not confirm the promotion${request.decisionComment ? `: ${request.decisionComment}` : "."} The application is still pending; approve it again or reject it in Admin → Dealers.`,
    actionUrl: `/admin/dealers/${request.subjectId}`,
    dedupeKey: `dealer-promotion-rejected:${request.id}`,
  }).catch((e) => console.error("[dealers] promotion rejection notice failed", request.id, e));
}
