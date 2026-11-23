/**
 * Dealership & Franchise Platform phase 2 (owner brief 23-Nov-2026; docs/dealer-platform/PHASE_2_REGISTRATION.md):
 * one registration for every scheme.
 *
 *   1. The applicant compares the published dealership schemes on /dealer/apply and chooses one
 *      (dealers.requested_version_id). Territory franchises are bought on /franchise (zone booking).
 *   2. A scheme with a joining charge is paid online before submitting (payment purpose DEALER_JOINING_FEE; the
 *      gateway is the site's usual one). A free scheme skips payment.
 *   3. On submit he accepts the scheme's terms: the acceptance (terms fingerprint, IP, browser) is kept for good.
 *   4. On approval he is put on exactly the version he accepted (assignment source REGISTRATION).
 *   5. On rejection a paid joining charge is refunded through the gateway.
 * External calls (gateway) never run inside a database transaction.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { chargeTotals, schemeTermsSchema, type SchemeTerms } from "@/lib/dealer-schemes";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  dealerJoiningPayments,
  dealers,
  dealerSchemeAcceptances,
  dealerSchemeAssignments,
  dealerSchemes,
  dealerSchemeVersions,
  users,
  type Dealer,
  type DealerJoiningPayment,
  type UserRole,
} from "@/server/db/schema";
import type { PaymentIntentRef } from "@/server/payments/intents";
import type { PaymentIntentRow } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

interface Actor {
  id: string;
  role: UserRole;
}

const EDITABLE = ["DRAFT", "REJECTED"];

export interface OfferedScheme {
  schemeId: string;
  code: string;
  name: string;
  versionId: string;
  version: number;
  termsHash: string;
  terms: SchemeTerms;
  totals: { basePaise: number; gstPaise: number; totalPaise: number };
}

/** The dealership schemes a new applicant may choose today (published scheme, published version), in display order. */
export async function offeredSchemes(client: DbClient = db): Promise<OfferedScheme[]> {
  const rows = await client
    .select({ s: dealerSchemes, v: dealerSchemeVersions })
    .from(dealerSchemes)
    .innerJoin(dealerSchemeVersions, and(eq(dealerSchemeVersions.schemeId, dealerSchemes.id), eq(dealerSchemeVersions.status, "PUBLISHED")))
    .where(and(eq(dealerSchemes.status, "PUBLISHED"), eq(dealerSchemes.category, "DEALERSHIP")))
    .orderBy(dealerSchemes.sortOrder);
  return rows.map(({ s, v }) => {
    const terms = schemeTermsSchema.parse(v.terms);
    return { schemeId: s.id, code: s.code, name: s.name, versionId: v.id, version: v.version, termsHash: v.termsHash, terms, totals: chargeTotals(terms.charge) };
  });
}

async function offeredVersion(versionId: string, client: DbClient = db): Promise<OfferedScheme> {
  const offer = (await offeredSchemes(client)).find((o) => o.versionId === versionId);
  if (!offer) throw validationFailed("That scheme is not open for new dealers. Choose another.", { fields: { scheme: "Not available." } });
  return offer;
}

/** The scheme the applicant has chosen: his choice, else the default (Free Dealership's published version). */
export async function chosenScheme(dealer: Pick<Dealer, "requestedVersionId">, client: DbClient = db): Promise<OfferedScheme | null> {
  const offers = await offeredSchemes(client);
  return offers.find((o) => o.versionId === dealer.requestedVersionId) ?? offers.find((o) => o.code === "FREE") ?? null;
}

async function myDealer(actor: Actor): Promise<Dealer> {
  const [dealer] = await db.select().from(dealers).where(eq(dealers.userId, actor.id));
  if (!dealer) throw validationFailed("Save your details first.");
  return dealer;
}

async function openPayment(dealerId: string, versionId: string, client: DbClient = db): Promise<DealerJoiningPayment | null> {
  const [row] = await client
    .select()
    .from(dealerJoiningPayments)
    .where(and(eq(dealerJoiningPayments.dealerId, dealerId), eq(dealerJoiningPayments.versionId, versionId), inArray(dealerJoiningPayments.status, ["PENDING", "PAID"])));
  return row ?? null;
}

/** The applicant chooses a scheme. Refused once he has paid for another one (support refunds or moves it). */
export async function chooseScheme(actor: Actor, versionId: string): Promise<Dealer> {
  const dealer = await myDealer(actor);
  if (!EDITABLE.includes(dealer.status)) throw conflict("Your application is already submitted; the scheme cannot change now.");
  const offer = await offeredVersion(versionId);
  const [paidOther] = await db
    .select({ id: dealerJoiningPayments.id })
    .from(dealerJoiningPayments)
    .where(and(eq(dealerJoiningPayments.dealerId, dealer.id), eq(dealerJoiningPayments.status, "PAID")));
  if (paidOther && dealer.requestedVersionId !== versionId) {
    throw conflict("You have already paid the joining charge of another scheme. Contact support to change your scheme.");
  }
  const [row] = await db.update(dealers).set({ requestedVersionId: offer.versionId, updatedAt: new Date() }).where(eq(dealers.id, dealer.id)).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_SCHEME_CHOSEN, entityType: "dealer", entityId: dealer.id, previousValue: { versionId: dealer.requestedVersionId }, newValue: { versionId: offer.versionId, scheme: offer.code, version: offer.version } });
  return row;
}

export interface JoiningChargeView {
  required: boolean;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  status: DealerJoiningPayment["status"] | null;
  paidAt: string | null;
}

/** What the applicant owes for his chosen scheme and whether it is paid. */
export async function joiningChargeView(dealer: Dealer, client: DbClient = db): Promise<JoiningChargeView> {
  const offer = await chosenScheme(dealer, client);
  if (!offer || offer.totals.totalPaise === 0) return { required: false, basePaise: 0, gstPaise: 0, totalPaise: 0, status: null, paidAt: null };
  const [last] = await client.select().from(dealerJoiningPayments).where(and(eq(dealerJoiningPayments.dealerId, dealer.id), eq(dealerJoiningPayments.versionId, offer.versionId))).orderBy(desc(dealerJoiningPayments.createdAt)).limit(1);
  return { required: true, ...offer.totals, status: last?.status ?? null, paidAt: last?.paidAt?.toISOString() ?? null };
}

/** Starts (or resumes) the online payment of the chosen scheme's joining charge (an applicant). */
export async function startJoiningPayment(actor: Actor) {
  const dealer = await myDealer(actor);
  if (!EDITABLE.includes(dealer.status)) throw conflict("Your application is already submitted.");
  if (!dealer.requestedVersionId) throw validationFailed("Choose your scheme first.", { fields: { scheme: "Required." } });
  const offer = await offeredVersion(dealer.requestedVersionId);
  return startJoiningPaymentFor(actor, dealer.id, offer, "/dealer/apply?paid=1");
}

/** The joining payment of `offer` for a dealer (an applicant, or an approved dealer upgrading; phase 6). */
export async function startJoiningPaymentFor(actor: Actor, dealerId: string, offer: OfferedScheme, returnPath: string) {
  if (offer.totals.totalPaise === 0) throw conflict("This scheme has no joining charge.");
  let row = await openPayment(dealerId, offer.versionId);
  if (row?.status === "PAID") throw conflict("The joining charge is already paid.");
  if (!row) {
    try {
      [row] = await db
        .insert(dealerJoiningPayments)
        .values({ dealerId, versionId: offer.versionId, basePaise: offer.totals.basePaise, gstRateBp: offer.terms.charge.gstRateBp, gstPaise: offer.totals.gstPaise, totalPaise: offer.totals.totalPaise })
        .returning();
    } catch {
      row = await openPayment(dealerId, offer.versionId); // two clicks at once: the other one won
      if (!row) throw conflict("Please try again.");
    }
  }
  const [u] = await db.select({ name: users.name, email: users.email, phone: users.phone }).from(users).where(eq(users.id, actor.id));
  const { createPaymentIntent } = await import("@/server/payments/intents");
  const created = await createPaymentIntent({
    purpose: "DEALER_JOINING_FEE",
    referenceId: row.id,
    userId: actor.id,
    amountPaise: Number(row.totalPaise),
    customer: { id: actor.id, name: u?.name ?? null, email: u?.email ?? null, phone: u?.phone ?? null },
    description: `GoKesari ${offer.name} joining charge`,
    idempotencyKey: `dealer-joining:${row.id}`,
    mode: "CHECKOUT",
    returnPath,
  });
  await db.update(dealerJoiningPayments).set({ paymentIntentId: created.intent.id, updatedAt: new Date() }).where(and(eq(dealerJoiningPayments.id, row.id), eq(dealerJoiningPayments.status, "PENDING")));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_JOINING_FEE_CHANGED, entityType: "dealer", entityId: dealerId, newValue: { paymentStarted: created.intent.id, joiningPaymentId: row.id, totalPaise: Number(row.totalPaise) } });
  return created;
}

/** Payment purpose handler, inside the capture transaction. Idempotent; a wrong amount is recorded, not accepted. */
export async function onJoiningFeeCaptured(intent: PaymentIntentRef, client: DbClient): Promise<void> {
  const [row] = await client.select().from(dealerJoiningPayments).where(eq(dealerJoiningPayments.id, intent.referenceId)).for("update");
  if (!row || row.status === "PAID") return;
  const now = new Date();
  if (intent.amountPaise !== Number(row.totalPaise) || (row.paymentIntentId && row.paymentIntentId !== intent.id)) {
    await recordAudit({ action: AUDIT_ACTIONS.DEALER_JOINING_FEE_CHANGED, entityType: "dealer", entityId: row.dealerId, newValue: { problem: "amount_or_intent_mismatch", intentId: intent.id, intentAmount: intent.amountPaise, total: Number(row.totalPaise) } }, client);
    return;
  }
  // Paid after it was cancelled (a late webhook): keep the money traceable as paid; support refunds or uses it.
  await client.update(dealerJoiningPayments).set({ status: "PAID", paidAt: now, paymentIntentId: intent.id, updatedAt: now }).where(eq(dealerJoiningPayments.id, row.id));
  await recordAudit({ action: AUDIT_ACTIONS.DEALER_JOINING_FEE_CHANGED, entityType: "dealer", entityId: row.dealerId, previousValue: { status: row.status }, newValue: { status: "PAID", intentId: intent.id, totalPaise: Number(row.totalPaise) } }, client);
  // Phase 6: an approved dealer's paid upgrade applies now (an applicant's on approval).
  await (await import("./scheme-change")).applyPaidChange(row.dealerId, row.versionId, client);
}

/** Payment ended without paying: the charge is closed so a new attempt starts cleanly. */
export async function onJoiningFeeEnded(intent: PaymentIntentRow, to: "FAILED" | "EXPIRED", client: DbClient): Promise<void> {
  await client
    .update(dealerJoiningPayments)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(and(eq(dealerJoiningPayments.id, intent.referenceId), eq(dealerJoiningPayments.status, "PENDING"), eq(dealerJoiningPayments.paymentIntentId, intent.id)));
  await recordAudit({ action: AUDIT_ACTIONS.DEALER_JOINING_FEE_CHANGED, entityType: "dealer_joining_payment", entityId: intent.referenceId, newValue: { status: "CANCELLED", payment: to.toLowerCase() } }, client);
}

/**
 * For submitApplication, inside its transaction: checks the chosen scheme is still offered, its charge is paid and
 * the terms he saw are the terms on file; records his acceptance.
 */
export async function acceptSchemeOnSubmit(
  dealer: Dealer,
  input: { termsHash?: string | null; ipAddress?: string | null; userAgent?: string | null; actorId: string },
  tx: DbClient,
): Promise<OfferedScheme> {
  const offer = await chosenScheme(dealer, tx);
  if (!offer) throw conflict("No scheme is open for new dealers right now.");
  if (dealer.requestedVersionId && dealer.requestedVersionId !== offer.versionId) throw validationFailed("Your scheme is no longer offered. Choose a scheme again.", { fields: { scheme: "Choose again." } });
  if (input.termsHash != null && input.termsHash !== offer.termsHash) throw conflict("The scheme's terms changed while you were reading them. Reload the page and accept the current terms.");
  if (offer.totals.totalPaise > 0) {
    const paid = await openPayment(dealer.id, offer.versionId, tx);
    if (paid?.status !== "PAID") throw validationFailed(`Pay the joining charge of ${offer.name} first.`, { fields: { payment: "Not paid." } });
  }
  // Phase 5: the scheme's own questions answered, files uploaded, eligibility rules met.
  await (await import("./custom-fields")).checkCustomOnSubmit(dealer, offer.terms, tx);
  await tx.update(dealers).set({ requestedVersionId: offer.versionId }).where(eq(dealers.id, dealer.id));
  await tx.insert(dealerSchemeAcceptances).values({ dealerId: dealer.id, versionId: offer.versionId, termsHash: offer.termsHash, context: "APPLICATION", acceptedBy: input.actorId, ipAddress: input.ipAddress?.slice(0, 64) ?? null, userAgent: input.userAgent?.slice(0, 300) ?? null });
  return offer;
}

/**
 * Puts a dealer on a scheme version (ends his current assignment). Used on approval (REGISTRATION) and by scheme
 * changes. Uses the latest acceptance of that version for the accepted-at / IP / browser on the assignment.
 */
export async function assignSchemeVersion(
  dealerId: string,
  versionId: string,
  source: (typeof dealerSchemeAssignments.$inferInsert)["source"],
  reason: string,
  actorId: string | null,
  tx: DbClient,
): Promise<void> {
  const [version] = await tx.select().from(dealerSchemeVersions).where(eq(dealerSchemeVersions.id, versionId));
  if (!version) throw notFound("Scheme version");
  const [current] = await tx.select().from(dealerSchemeAssignments).where(and(eq(dealerSchemeAssignments.dealerId, dealerId), eq(dealerSchemeAssignments.status, "ACTIVE"))).for("update");
  if (current?.versionId === versionId) return;
  const [acceptance] = await tx.select().from(dealerSchemeAcceptances).where(and(eq(dealerSchemeAcceptances.dealerId, dealerId), eq(dealerSchemeAcceptances.versionId, versionId))).orderBy(desc(dealerSchemeAcceptances.acceptedAt)).limit(1);
  const now = new Date();
  if (current) await tx.update(dealerSchemeAssignments).set({ status: "SUPERSEDED", endsAt: now < current.startsAt ? current.startsAt : now, endReason: reason }).where(eq(dealerSchemeAssignments.id, current.id));
  await tx.insert(dealerSchemeAssignments).values({
    dealerId,
    schemeId: version.schemeId,
    versionId,
    status: "ACTIVE",
    source,
    startsAt: now,
    acceptedTerms: version.terms,
    acceptedAt: acceptance?.acceptedAt ?? null,
    acceptedIp: acceptance?.ipAddress ?? null,
    acceptedUserAgent: acceptance?.userAgent ?? null,
    previousAssignmentId: current?.id ?? null,
    reason,
    createdBy: actorId,
  });
}

/** On approval, inside decideDealer's transaction: the dealer goes onto the version he accepted. */
export async function assignOnApproval(dealer: Dealer, actorId: string, tx: DbClient): Promise<void> {
  if (dealer.isInternal || !dealer.requestedVersionId) return;
  await assignSchemeVersion(dealer.id, dealer.requestedVersionId, "REGISTRATION", "application approved", actorId, tx);
}

/**
 * After a rejection commits: refunds a paid joining charge through the gateway (the payment's own method).
 * Never throws: a failed refund stays REFUND_PENDING for finance to see.
 */
export async function refundJoiningFeeOnRejection(dealerId: string, reason: string, actor: Actor): Promise<void> {
  const rows = await db.select().from(dealerJoiningPayments).where(and(eq(dealerJoiningPayments.dealerId, dealerId), eq(dealerJoiningPayments.status, "PAID")));
  for (const row of rows) {
    if (!row.paymentIntentId) continue;
    await db.update(dealerJoiningPayments).set({ status: "REFUND_PENDING", refundReason: reason, updatedAt: new Date() }).where(and(eq(dealerJoiningPayments.id, row.id), eq(dealerJoiningPayments.status, "PAID")));
    try {
      const { refundPaymentIntent } = await import("@/server/payments/intents");
      const refund = await refundPaymentIntent({ intentId: row.paymentIntentId, amountPaise: Number(row.totalPaise), reason: `Dealer application rejected: ${reason}`.slice(0, 200), idempotencyKey: `dealer-joining-refund:${row.id}` });
      const done = refund.status === "SUCCESS";
      await db.update(dealerJoiningPayments).set({ refundId: refund.id, ...(done ? { status: "REFUNDED", refundedAt: new Date() } : {}), updatedAt: new Date() }).where(eq(dealerJoiningPayments.id, row.id));
      await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_JOINING_FEE_CHANGED, entityType: "dealer", entityId: dealerId, newValue: { refund: refund.status, refundId: refund.id, joiningPaymentId: row.id, amountPaise: Number(row.totalPaise) } });
    } catch (error) {
      console.error("[dealers] joining fee refund failed", row.id, error);
      await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_JOINING_FEE_CHANGED, entityType: "dealer", entityId: dealerId, newValue: { refund: "FAILED", joiningPaymentId: row.id, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" } });
    }
  }
}
