/**
 * Super dealer requests (owner, 28-Nov-2026 ~20.00 IST; docs/dealer-promotion-2026-11/README.md).
 *
 * A dealer — usually a shop owner promoted to dealer — asks to become a super dealer (super franchisee,
 * src/server/dealers/super-franchisee.ts). An ADMIN or an OPERATOR approves or rejects the request (approvals engine,
 * type SUPER_DEALER_REQUEST; never the person who raised it). On approval he becomes a super franchisee at the
 * default rates; an admin can still set his own rates and his team on the dealer's page.
 *
 * Asked before the dealer is approved (the free-dealer request, or an admin / operator promoting a shop owner with
 * "also make super dealer"): the wish is kept on the dealer row (0233 wants_super_at / wants_super_by) and acted on
 * when the dealer is approved — at once when an ADMIN asked for it, otherwise as a request for an admin / operator.
 */
import { and, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";

import { conflict, notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { approvalRequests, dealers, superFranchiseeMembers, superFranchisees, users, type Dealer, type UserRole } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";

export const SUPER_DEALER_REQUEST = "SUPER_DEALER_REQUEST";
/** Who may approve or reject a super dealer request (one person; never the requester). */
export const SUPER_REQUEST_DECIDER_ROLES = ["ADMIN", "OPERATOR"] as const satisfies readonly UserRole[];

export interface RequestActor {
  id: string;
  role: UserRole;
}

const CLOSED: Dealer["status"][] = ["REJECTED", "TERMINATED", "SUSPENDED"];

async function dealerOfUser(userId: string): Promise<Dealer | null> {
  const [d] = await db.select().from(dealers).where(and(eq(dealers.userId, userId), eq(dealers.isInternal, false))).orderBy(desc(dealers.createdAt)).limit(1);
  return d ?? null;
}

async function pendingFor(dealerId: string) {
  const [r] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.type, SUPER_DEALER_REQUEST), eq(approvalRequests.subjectId, dealerId), eq(approvalRequests.status, "PENDING")))
    .limit(1);
  return r ?? null;
}

async function isSuper(dealerId: string): Promise<boolean> {
  const [s] = await db.select({ status: superFranchisees.status }).from(superFranchisees).where(eq(superFranchisees.dealerId, dealerId));
  return s?.status === "ACTIVE";
}

async function inTeam(dealerId: string): Promise<boolean> {
  const [m] = await db.select({ id: superFranchiseeMembers.id }).from(superFranchiseeMembers).where(and(eq(superFranchiseeMembers.memberDealerId, dealerId), isNull(superFranchiseeMembers.endsAt)));
  return !!m;
}

export type SuperRequestStatus = "NOT_A_DEALER" | "CLOSED" | "IN_TEAM" | "SUPER" | "PENDING" | "AFTER_DEALER_APPROVAL" | "CAN_REQUEST";

/** The account's super dealer state, for the dealer page and the franchise start page. */
export async function superRequestState(userId: string): Promise<{ status: SuperRequestStatus; dealerId: string | null; approvalId: string | null; requestedAt: string | null }> {
  const dealer = await dealerOfUser(userId);
  if (!dealer) return { status: "NOT_A_DEALER", dealerId: null, approvalId: null, requestedAt: null };
  const base = { dealerId: dealer.id, approvalId: null, requestedAt: null };
  if (CLOSED.includes(dealer.status)) return { ...base, status: "CLOSED" };
  if (await isSuper(dealer.id)) return { ...base, status: "SUPER" };
  if (await inTeam(dealer.id)) return { ...base, status: "IN_TEAM" };
  const pending = await pendingFor(dealer.id);
  if (pending) return { ...base, status: "PENDING", approvalId: pending.id, requestedAt: pending.requestedAt.toISOString() };
  if (dealer.status !== "APPROVED") return { ...base, status: dealer.wantsSuperAt ? "AFTER_DEALER_APPROVAL" : "CAN_REQUEST", requestedAt: dealer.wantsSuperAt?.toISOString() ?? null };
  return { ...base, status: "CAN_REQUEST" };
}

/** Admins and operators (not `except`), for the "a request is waiting" notice. */
async function deciders(except: string | null) {
  return db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.role, [...SUPER_REQUEST_DECIDER_ROLES]), eq(users.status, "ACTIVE"), isNull(users.deletedAt), ...(except ? [ne(users.id, except)] : [])));
}

async function submitFor(dealer: Dealer, actor: RequestActor, reason: string) {
  if (await isSuper(dealer.id)) throw conflict("This dealer is already a super dealer.");
  if (await inTeam(dealer.id)) throw conflict("This dealer is in a super dealer's team. An admin must take him out of that team first.");
  const pending = await pendingFor(dealer.id);
  if (pending) return pending;
  const { submitApproval } = await import("@/server/approvals");
  const request = await submitApproval({
    type: SUPER_DEALER_REQUEST,
    actor,
    subjectType: "dealer",
    subjectId: dealer.id,
    title: `Make super dealer: ${dealer.legalName}`,
    reason,
    payload: { dealerId: dealer.id },
  });
  for (const s of await deciders(actor.id)) {
    await notify({
      userId: s.id,
      type: NOTIFICATION_TYPES.STAFF_APPROVAL_PENDING,
      title: `Super dealer request: ${dealer.legalName}`,
      body: `${dealer.legalName} is waiting to become a super dealer. An admin or operator approves or rejects it in Admin → Dealers → Promote.`,
      actionUrl: "/admin/dealers/promote",
      dedupeKey: `super-request:${request.id}:${s.id}`,
    }).catch((e) => console.error("[super-requests] staff notice failed", dealer.id, e));
  }
  return request;
}

/**
 * The dealer (or shop owner) asks to become a super dealer. An approved dealer: a request for an admin / operator.
 * A dealer not approved yet: the wish is kept and the request follows the dealer's approval. No dealer at all: 409
 * (ask to become a dealer first — the franchise start page sends both).
 */
export async function requestSuperDealer(actor: RequestActor, note?: string | null): Promise<{ status: SuperRequestStatus; approvalId: string | null }> {
  const dealer = await dealerOfUser(actor.id);
  if (!dealer) throw conflict("Become a dealer first: ask to become a free dealer, or buy a franchise territory.", { reason: "DEALER_REQUIRED", redirect: "/franchise/start" });
  if (CLOSED.includes(dealer.status)) throw conflict(`Your dealer account is ${dealer.status.toLowerCase()} — contact GoKesari support.`);
  const why = (note ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  if (dealer.status !== "APPROVED") {
    await db.update(dealers).set({ wantsSuperAt: new Date(), wantsSuperBy: actor.id, updatedAt: new Date() }).where(eq(dealers.id, dealer.id));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPER_FRANCHISEE_CHANGED, entityType: "dealer", entityId: dealer.id, newValue: { superDealerWish: true, dealerStatus: dealer.status, note: why || null } });
    return { status: "AFTER_DEALER_APPROVAL", approvalId: null };
  }
  const request = await submitFor(dealer, actor, why.length >= 3 ? why : `${dealer.legalName} asks to become a super dealer`);
  return { status: "PENDING", approvalId: request.id };
}

/** Staff (admin / operator) raise a super dealer request for an approved dealer — the "Make super dealer" of an operator. */
export async function requestSuperDealerForDealer(dealerId: string, actor: RequestActor, reason: string): Promise<{ approvalId: string }> {
  const [dealer] = await db.select().from(dealers).where(eq(dealers.id, dealerId));
  if (!dealer || dealer.isInternal) throw notFound("Dealer");
  if (dealer.status !== "APPROVED") throw conflict("Only an approved dealer can be made a super dealer.");
  const request = await submitFor(dealer, actor, reason);
  return { approvalId: request.id };
}

/** The approval's executor: the dealer becomes a super franchisee (default rates), decided by the admin / operator. */
export async function applySuperRequest(request: { id: string; subjectId: string | null; reason: string }, decidedBy: RequestActor): Promise<void> {
  if (!request.subjectId) return;
  if (await isSuper(request.subjectId)) return;
  const { promoteSuperFranchisee } = await import("./super-franchisee");
  await promoteSuperFranchisee(request.subjectId, { reason: `Super dealer request ${request.id.slice(0, 8)} approved: ${request.reason}`.slice(0, 300) }, decidedBy, { viaApprovedRequest: true });
}

/** A rejected request: the dealer is told why. */
export async function onSuperRequestRejected(request: { id: string; subjectId: string | null; decisionComment: string | null }): Promise<void> {
  if (!request.subjectId) return;
  const [d] = await db.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, request.subjectId));
  if (!d?.userId) return;
  await notify({
    userId: d.userId,
    type: NOTIFICATION_TYPES.DEALER_TEAM_CHANGED,
    title: "Super dealer request not approved",
    vars: { message: `GoKesari did not approve your request to become a super dealer${request.decisionComment ? `: ${request.decisionComment}` : "."} You stay a dealer; contact GoKesari support with any question.` },
    actionUrl: "/dealer",
    dedupeKey: `super-request-rejected:${request.id}`,
  }).catch((e) => console.error("[super-requests] rejection notice failed", request.id, e));
}

/**
 * Called after a dealer is approved (decideDealer, a paid franchise going live): acts on a super dealer wish made
 * before the approval. An admin's wish promotes him at once; anyone else's raises a request. Never throws.
 */
export async function afterDealerApproved(dealerId: string): Promise<void> {
  try {
    const [dealer] = await db.select().from(dealers).where(eq(dealers.id, dealerId));
    if (!dealer?.wantsSuperAt || dealer.status !== "APPROVED") return;
    // Claim the wish once (a second call finds it cleared).
    const [claimed] = await db
      .update(dealers)
      .set({ wantsSuperAt: null, wantsSuperBy: null })
      .where(and(eq(dealers.id, dealerId), isNotNull(dealers.wantsSuperAt)))
      .returning({ id: dealers.id });
    if (!claimed) return;
    const [by] = dealer.wantsSuperBy ? await db.select({ id: users.id, role: users.role, status: users.status }).from(users).where(eq(users.id, dealer.wantsSuperBy)) : [];
    if (await isSuper(dealerId)) return;
    if (by && by.role === "ADMIN" && by.status === "ACTIVE") {
      const { promoteSuperFranchisee } = await import("./super-franchisee");
      await promoteSuperFranchisee(dealerId, { reason: "Asked for by an admin when promoting the shop owner to dealer" }, { id: by.id, role: "ADMIN" });
      return;
    }
    const actor: RequestActor = by ? { id: by.id, role: by.role } : { id: dealer.userId ?? dealerId, role: "CUSTOMER" };
    await submitFor(dealer, actor, `${dealer.legalName} asked to become a super dealer when applying to be a dealer`);
  } catch (error) {
    console.error("[super-requests] after approval failed", dealerId, error instanceof Error ? error.message : error);
  }
}

/** Admin → Dealers → Promote: super dealer requests waiting for an admin / operator, newest first. */
export async function listPendingSuperRequests() {
  const rows = await db
    .select({ request: approvalRequests, dealerName: dealers.legalName, contactName: dealers.contactName, requester: users.name, requesterEmail: users.email })
    .from(approvalRequests)
    .leftJoin(dealers, eq(dealers.id, approvalRequests.subjectId))
    .leftJoin(users, eq(users.id, approvalRequests.requestedBy))
    .where(and(eq(approvalRequests.type, SUPER_DEALER_REQUEST), eq(approvalRequests.status, "PENDING")))
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(200);
  return rows.map((r) => ({
    approvalId: r.request.id,
    dealerId: r.request.subjectId,
    dealerName: r.dealerName ?? "Dealer",
    contactName: r.contactName ?? null,
    reason: r.request.reason,
    requestedBy: r.request.requestedBy,
    requestedByName: r.requester ?? r.requesterEmail ?? null,
    requestedAt: r.request.requestedAt.toISOString(),
  }));
}
