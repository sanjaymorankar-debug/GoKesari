/**
 * Dealership & Franchise Platform phase 6 (owner brief 23-Nov-2026 §13; docs/dealer-platform/): moving an approved
 * dealer to another scheme — upgrade or downgrade — always with his explicit acceptance of the new terms.
 *
 *   Dealer (portal):  requestSchemeChange → records his acceptance (UPGRADE / DOWNGRADE). A scheme with a joining
 *                     charge is paid online first; the change applies when the payment is captured. A free one
 *                     applies at once.
 *   Staff (admin):    changeDealerScheme → only to a version the dealer accepted in the last 30 days
 *                     (DEALER_REASSIGN; a second approver when dealer_platform_four_eye is on).
 * Every change ends the old assignment and starts a new one (history kept); earlier commission is untouched.
 */
import { and, desc, eq, gte } from "drizzle-orm";

import { chargeTotals } from "@/lib/dealer-schemes";
import { conflict, validationFailed } from "@/lib/errors";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import { dealerJoiningPayments, dealers, dealerSchemeAcceptances, dealerSchemeAssignments, type Dealer, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

import { currentDealerScheme } from "./schemes";
import { assignSchemeVersion, offeredSchemes, type OfferedScheme } from "./scheme-registration";
import { requireDealerInScope, requireDealerPermission } from "./staff-access";

interface Actor {
  id: string;
  role: UserRole;
}

const ACCEPTANCE_DAYS = 30;

async function offerFor(versionId: string): Promise<OfferedScheme> {
  const offer = (await offeredSchemes()).find((o) => o.versionId === versionId);
  if (!offer) throw validationFailed("That scheme is not open right now.", { fields: { scheme: "Not available." } });
  return offer;
}

/** The schemes an approved dealer may move to (published dealership schemes other than his current one). */
export async function changeOptions(dealer: Dealer): Promise<OfferedScheme[]> {
  const current = await currentDealerScheme(dealer.id);
  return (await offeredSchemes()).filter((o) => o.code !== current?.schemeCode);
}

/**
 * The dealer accepts another scheme's terms. Free (or cheaper with nothing to pay): applies now. A joining charge:
 * returns the payment to make; the change applies when it is captured.
 */
export async function requestSchemeChange(
  actor: Actor,
  input: { versionId: string; termsHash: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<{ applied: boolean; payment: { intentId: string; checkoutUrl: string | null } | null }> {
  const [dealer] = await db.select().from(dealers).where(eq(dealers.userId, actor.id));
  if (!dealer || dealer.status !== "APPROVED") throw conflict("Only an approved dealer can change his scheme.");
  const offer = await offerFor(input.versionId);
  if (offer.termsHash !== input.termsHash) throw conflict("The scheme's terms changed while you were reading them. Reload and accept the current terms.");
  const current = await currentDealerScheme(dealer.id);
  if (current?.schemeCode === offer.code) throw conflict("You are already on this scheme.");
  if (current?.category === "FRANCHISE") throw conflict("A franchise owner's scheme follows his franchise zone.");
  const currentTotal = current ? chargeTotals(current.terms.charge).totalPaise : 0;
  const context = offer.totals.totalPaise >= currentTotal ? "UPGRADE" : "DOWNGRADE";
  await db.insert(dealerSchemeAcceptances).values({ dealerId: dealer.id, versionId: offer.versionId, termsHash: offer.termsHash, context, acceptedBy: actor.id, ipAddress: input.ipAddress?.slice(0, 64) ?? null, userAgent: input.userAgent?.slice(0, 300) ?? null });
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_SCHEME_CHANGED, entityType: "dealer", entityId: dealer.id, previousValue: current ? { scheme: current.schemeCode, version: current.version } : null, newValue: { requested: offer.code, version: offer.version, context, accepted: true } });

  if (offer.totals.totalPaise === 0) {
    await db.transaction((tx) => assignSchemeVersion(dealer.id, offer.versionId, context, `dealer chose ${offer.name}`, actor.id, tx));
    return { applied: true, payment: null };
  }
  // A charge to pay: the joining payment for that version (the capture handler applies the change).
  await db.update(dealers).set({ requestedVersionId: offer.versionId, updatedAt: new Date() }).where(eq(dealers.id, dealer.id));
  const { startJoiningPaymentFor } = await import("./scheme-registration");
  const created = await startJoiningPaymentFor(actor, dealer.id, offer, "/dealer?scheme=paid");
  const { checkoutUrlOf } = await import("@/server/franchise/http");
  return { applied: false, payment: { intentId: created.intent.id, checkoutUrl: checkoutUrlOf(created as never) } };
}

/**
 * Inside the joining-fee capture transaction: an approved dealer who accepted an upgrade to the paid version moves
 * to it now. (An applicant's payment is applied on approval instead.)
 */
export async function applyPaidChange(dealerId: string, versionId: string, tx: DbClient): Promise<void> {
  const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, dealerId));
  if (!dealer || dealer.status !== "APPROVED") return;
  const [accepted] = await tx
    .select()
    .from(dealerSchemeAcceptances)
    .where(and(eq(dealerSchemeAcceptances.dealerId, dealerId), eq(dealerSchemeAcceptances.versionId, versionId)))
    .orderBy(desc(dealerSchemeAcceptances.acceptedAt))
    .limit(1);
  if (!accepted || accepted.context === "APPLICATION") return;
  await assignSchemeVersion(dealerId, versionId, accepted.context === "DOWNGRADE" ? "DOWNGRADE" : "UPGRADE", "joining charge paid", accepted.acceptedBy, tx);
}

/** Staff: moves a dealer to a version he accepted in the last 30 days (DEALER_REASSIGN; Regional Admin in scope). */
export async function changeDealerScheme(actor: Actor, dealerId: string, versionId: string, reason: string): Promise<void> {
  requireDealerPermission(actor, PERMISSIONS.DEALER_REASSIGN, "change a dealer's scheme");
  const why = reason.trim();
  if (why.length < 5) throw validationFailed("Give the reason (kept in the audit log).", { fields: { reason: "Required." } });
  const [dealer] = await db.select().from(dealers).where(eq(dealers.id, dealerId));
  if (!dealer || dealer.isInternal) throw validationFailed("No such dealer.");
  await requireDealerInScope(actor, dealer);
  const since = new Date(Date.now() - ACCEPTANCE_DAYS * 86_400_000);
  const [accepted] = await db
    .select()
    .from(dealerSchemeAcceptances)
    .where(and(eq(dealerSchemeAcceptances.dealerId, dealerId), eq(dealerSchemeAcceptances.versionId, versionId), gte(dealerSchemeAcceptances.acceptedAt, since)));
  if (!accepted) throw conflict("The dealer has not accepted that scheme's terms. He accepts them from his dealer page first (explicit acceptance is required for a change of terms).");
  const charge = (await offerFor(versionId)).totals.totalPaise;
  if (charge > 0) {
    const [paid] = await db.select({ id: dealerJoiningPayments.id }).from(dealerJoiningPayments).where(and(eq(dealerJoiningPayments.dealerId, dealerId), eq(dealerJoiningPayments.versionId, versionId), eq(dealerJoiningPayments.status, "PAID")));
    if (!paid) throw conflict("The joining charge of that scheme is not paid yet.");
  }
  const [before] = await db.select().from(dealerSchemeAssignments).where(and(eq(dealerSchemeAssignments.dealerId, dealerId), eq(dealerSchemeAssignments.status, "ACTIVE")));
  await db.transaction((tx) => assignSchemeVersion(dealerId, versionId, "ADMIN", why, actor.id, tx));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_SCHEME_CHANGED, entityType: "dealer", entityId: dealerId, previousValue: before ? { versionId: before.versionId } : null, newValue: { versionId, reason: why, acceptedAt: accepted.acceptedAt.toISOString() } });
}
