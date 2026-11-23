/**
 * RBAC v2 generic approval engine (docs/rbac/01-assessment.md §4 #2; brief §10).
 *
 * One table set and one service for every maker-checker flow: four-eye admin actions, journal
 * entries, rate changes, shop-owner change requests, master-data corrections, document deletion.
 * Each type registers a handler (checker + apply); the engine owns who may decide:
 *
 *   ADMIN          an admin other than the requester. While fewer than two admins are active the
 *                  Super Admin (SUPER_ADMIN_EMAIL) may approve alone; the approval is marked
 *                  single_admin, audited, and e-mailed to the Super Admin.
 *   CA             a CA other than the requester.
 *   CA_THEN_ADMIN  stage 1 a CA, stage 2 an admin (neither the requester, nor the stage-1 CA).
 *   SHOP_OWNER     the owner of request.shop_id; may decide item by item (partial approval).
 *
 * Nobody approves their own request. A rejection needs a comment. Approving commits first; the
 * handler's apply() runs after the commit (it may call existing services that open their own
 * transactions or send messages) and the outcome is recorded as APPLY / APPLY_FAILED.
 * approval_decisions is append-only (DB trigger).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import {
  approvalDecisions,
  approvalRequestItems,
  approvalRequests,
  shops,
  users,
  type ApprovalChecker,
  type ApprovalRequest,
  type ApprovalRequestItem,
  type ApprovalDecision,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export interface ApprovalActor {
  id: string;
  role: UserRole;
  email?: string | null;
}

export interface ApprovalItemInput {
  entityType: string;
  entityId?: string | null;
  field: string;
  previousValue?: unknown;
  proposedValue: unknown;
}

export interface ApplyContext {
  request: ApprovalRequest;
  /** Items the checker approved (all items when the checker decides the request as a whole). */
  approvedItems: ApprovalRequestItem[];
  /** The checker whose decision made the request final. */
  decidedBy: ApprovalActor;
}

export interface ApprovalHandler {
  type: string;
  checker: ApprovalChecker;
  /** Whether the checker may approve some items and reject others (shop-owner change requests). */
  itemDecisions?: boolean;
  /** Applies the approved change. Runs after the approval commits; throw to record APPLY_FAILED. */
  apply(context: ApplyContext): Promise<void>;
  /** Optional: what happens when the request is rejected (e.g. lift an emergency suspension). */
  onRejected?(request: ApprovalRequest, decidedBy: ApprovalActor): Promise<void>;
  /** Optional: CA_THEN_ADMIN stage 1 approved, now waiting for an admin. */
  onAdvanced?(request: ApprovalRequest, decidedBy: ApprovalActor): Promise<void>;
}

const handlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(handler: ApprovalHandler): void {
  handlers.set(handler.type, handler);
}

export function getApprovalHandler(type: string): ApprovalHandler {
  const handler = handlers.get(type);
  if (!handler) throw new AppError("INTERNAL", `No approval handler for ${type}.`);
  return handler;
}

/* ----------------------------------------------------------------- admins */

export async function countActiveAdmins(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, "ADMIN"), eq(users.status, "ACTIVE")));
  return row?.n ?? 0;
}

export function superAdminEmail(): string {
  return getEnv().SUPER_ADMIN_EMAIL;
}

async function emailOf(userId: string): Promise<string | null> {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return row?.email?.toLowerCase() ?? null;
}

/* ----------------------------------------------------------------- submit */

export interface SubmitApprovalInput {
  type: string;
  actor: ApprovalActor;
  subjectType: string;
  subjectId?: string | null;
  shopId?: string | null;
  title: string;
  reason: string;
  payload?: Record<string, unknown>;
  items?: ApprovalItemInput[];
  effectiveAt?: Date | null;
  expiresAt?: Date | null;
  confirmBy?: Date | null;
  linkedTicketId?: string | null;
}

export async function submitApproval(input: SubmitApprovalInput): Promise<ApprovalRequest> {
  const handler = getApprovalHandler(input.type);
  const reason = input.reason.trim();
  if (reason.length < 3) throw validationFailed("Give a reason for this request.", { fields: { reason: "At least 3 characters." } });
  if (handler.checker === "SHOP_OWNER" && !input.shopId) throw validationFailed("A shop change request needs a shop.");

  return db.transaction(async (tx) => {
    const [request] = await tx
      .insert(approvalRequests)
      .values({
        type: input.type,
        checker: handler.checker,
        subjectType: input.subjectType,
        subjectId: input.subjectId ?? null,
        shopId: input.shopId ?? null,
        title: input.title.slice(0, 300),
        reason,
        payload: input.payload ?? {},
        requestedBy: input.actor.id,
        requestedByRole: input.actor.role,
        effectiveAt: input.effectiveAt ?? null,
        expiresAt: input.expiresAt ?? null,
        confirmBy: input.confirmBy ?? null,
        linkedTicketId: input.linkedTicketId ?? null,
      })
      .returning();
    if (input.items?.length) {
      await tx.insert(approvalRequestItems).values(
        input.items.map((item, position) => ({
          requestId: request.id,
          position,
          entityType: item.entityType,
          entityId: item.entityId ?? null,
          field: item.field,
          previousValue: (item.previousValue ?? null) as never,
          proposedValue: (item.proposedValue ?? null) as never,
        })),
      );
    }
    await tx.insert(approvalDecisions).values({ requestId: request.id, action: "SUBMIT", actorId: input.actor.id, actorRole: input.actor.role, comment: reason });
    await recordAudit(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: AUDIT_ACTIONS.APPROVAL_SUBMITTED,
        entityType: "approval_request",
        entityId: request.id,
        newValue: { type: input.type, subjectType: input.subjectType, subjectId: input.subjectId ?? null, reason },
      },
      tx,
    );
    return request;
  });
}

/* ----------------------------------------------------------------- decide */

export interface DecideApprovalInput {
  requestId: string;
  actor: ApprovalActor;
  decision: "APPROVE" | "REJECT";
  comment?: string | null;
  /** SHOP_OWNER only: per-item decisions. Items not listed take `decision`. */
  items?: { itemId: string; decision: "APPROVE" | "REJECT"; comment?: string | null }[];
}

export interface DecideResult {
  request: ApprovalRequest;
  applied: boolean;
  applyError: string | null;
  singleAdmin: boolean;
}

/**
 * Who may decide this request now. Returns whether the decision is a single-admin (bootstrap)
 * approval. Throws FORBIDDEN otherwise.
 */
async function assertMayDecide(request: ApprovalRequest, actor: ApprovalActor, decision: "APPROVE" | "REJECT"): Promise<{ singleAdmin: boolean }> {
  const self = request.requestedBy === actor.id;
  const stageChecker: "ADMIN" | "CA" | "SHOP_OWNER" =
    request.checker === "CA_THEN_ADMIN" ? (request.stage === 1 ? "CA" : "ADMIN") : request.checker;

  if (stageChecker === "SHOP_OWNER") {
    if (!request.shopId) throw forbidden("This request has no shop.");
    const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, request.shopId));
    if (!shop || shop.ownerId !== actor.id) throw forbidden("Only the shop owner can decide this request.");
    if (self) throw forbidden("You cannot approve your own request.");
    return { singleAdmin: false };
  }

  if (stageChecker === "CA") {
    if (actor.role !== "CA") throw forbidden("Only a CA can decide this request.");
    if (self) throw forbidden("You cannot approve your own request.");
    return { singleAdmin: false };
  }

  // ADMIN
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can decide this request.");
  if (request.checker === "CA_THEN_ADMIN") {
    const [stageOne] = await db
      .select({ actorId: approvalDecisions.actorId })
      .from(approvalDecisions)
      .where(and(eq(approvalDecisions.requestId, request.id), eq(approvalDecisions.action, "APPROVE")))
      .orderBy(desc(approvalDecisions.createdAt))
      .limit(1);
    if (stageOne?.actorId === actor.id) throw forbidden("The CA who approved this cannot also activate it.");
  }
  if (!self) return { singleAdmin: false };

  // The requester may reject (withdraw by deciding) their own request? No: use cancel. Self-approval
  // is allowed only to the Super Admin while fewer than two admins are active (brief §3.1).
  if (decision === "REJECT") throw forbidden("Cancel your own request instead of rejecting it.");
  const email = actor.email?.toLowerCase() ?? (await emailOf(actor.id));
  if (email !== superAdminEmail()) throw forbidden("A different admin must approve this request.");
  if ((await countActiveAdmins()) >= 2) throw forbidden("A different admin must approve this request (two admins are active).");
  return { singleAdmin: true };
}

export async function decideApproval(input: DecideApprovalInput): Promise<DecideResult> {
  const comment = input.comment?.trim() || null;
  const [current] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, input.requestId));
  if (!current) throw notFound("Approval request");
  const handler = getApprovalHandler(current.type);
  if (current.status !== "PENDING") throw conflict("This request has already been decided.");
  if (current.expiresAt && current.expiresAt.getTime() < Date.now()) throw conflict("This request has expired.");
  const { singleAdmin } = await assertMayDecide(current, input.actor, input.decision);
  if (input.items?.length && !handler.itemDecisions) throw validationFailed("This request is decided as a whole.");
  for (const item of input.items ?? []) {
    if (item.decision === "REJECT" && !(item.comment?.trim() || comment)) {
      throw validationFailed("Say why you are rejecting.", { fields: { comment: "A rejection needs a comment." } });
    }
  }
  if (input.decision === "REJECT" && !comment) {
    throw validationFailed("Say why you are rejecting.", { fields: { comment: "A rejection needs a comment." } });
  }

  // Stage 1 of CA_THEN_ADMIN: record the CA's approval and move to stage 2.
  const advancesStage = current.checker === "CA_THEN_ADMIN" && current.stage === 1 && input.decision === "APPROVE";

  const outcome = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, current.id)).for("update");
    if (!locked || locked.status !== "PENDING" || locked.stage !== current.stage) throw conflict("This request has already been decided.");
    const now = new Date();
    const items = await tx.select().from(approvalRequestItems).where(eq(approvalRequestItems.requestId, current.id)).orderBy(approvalRequestItems.position);
    const pending = items.filter((i) => i.status === "PENDING");

    if (advancesStage) {
      await tx.update(approvalRequests).set({ stage: 2, updatedAt: now }).where(eq(approvalRequests.id, current.id));
      await tx.insert(approvalDecisions).values({ requestId: current.id, action: "APPROVE", actorId: input.actor.id, actorRole: input.actor.role, comment });
      return { request: { ...locked, stage: 2, updatedAt: now }, approvedItems: [] as ApprovalRequestItem[], final: false };
    }

    const perItem = new Map((input.items ?? []).map((i) => [i.itemId, i]));
    for (const id of perItem.keys()) {
      if (!pending.some((p) => p.id === id)) throw validationFailed("An item in this decision is not part of the request.");
    }
    const approvedItems: ApprovalRequestItem[] = [];
    let rejectedCount = 0;
    for (const item of pending) {
      const choice = perItem.get(item.id);
      const verdict = choice?.decision ?? input.decision;
      const itemComment = choice?.comment?.trim() || (verdict === "REJECT" ? comment : null);
      const status = verdict === "APPROVE" ? "APPROVED" : "REJECTED";
      const [updated] = await tx
        .update(approvalRequestItems)
        .set({ status, decidedBy: input.actor.id, decidedAt: now, rejectionComment: verdict === "REJECT" ? itemComment : null })
        .where(eq(approvalRequestItems.id, item.id))
        .returning();
      await tx.insert(approvalDecisions).values({
        requestId: current.id,
        itemId: item.id,
        action: verdict,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        comment: itemComment,
        singleAdmin,
      });
      if (verdict === "APPROVE") approvedItems.push(updated);
      else rejectedCount += 1;
    }

    const anyApproved = pending.length === 0 ? input.decision === "APPROVE" : approvedItems.length > 0;
    const status =
      !anyApproved ? "REJECTED" : rejectedCount > 0 ? "PARTIALLY_APPROVED" : "APPROVED";
    const [request] = await tx
      .update(approvalRequests)
      .set({ status, decidedBy: input.actor.id, decidedAt: now, decisionComment: comment, singleAdmin, updatedAt: now })
      .where(eq(approvalRequests.id, current.id))
      .returning();
    if (pending.length === 0) {
      await tx.insert(approvalDecisions).values({
        requestId: current.id,
        action: input.decision,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        comment,
        singleAdmin,
      });
    }
    await recordAudit(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: singleAdmin ? AUDIT_ACTIONS.APPROVAL_SINGLE_ADMIN : AUDIT_ACTIONS.APPROVAL_DECIDED,
        entityType: "approval_request",
        entityId: current.id,
        previousValue: { status: "PENDING" },
        newValue: { status, type: current.type, comment, singleAdmin, approvedItems: approvedItems.length, rejectedItems: rejectedCount },
      },
      tx,
    );
    return { request, approvedItems, final: true };
  });

  if (!outcome.final) {
    if (handler.onAdvanced) await handler.onAdvanced(outcome.request, input.actor);
    return { request: outcome.request, applied: false, applyError: null, singleAdmin };
  }

  if (singleAdmin) await notifySingleAdminApproval(outcome.request, input.actor);

  if (outcome.request.status === "REJECTED") {
    if (handler.onRejected) await handler.onRejected(outcome.request, input.actor);
    return { request: outcome.request, applied: false, applyError: null, singleAdmin };
  }
  const result = await runApply(outcome.request, outcome.approvedItems, input.actor);
  return { ...result, singleAdmin };
}

async function runApply(request: ApprovalRequest, approvedItems: ApprovalRequestItem[], decidedBy: ApprovalActor) {
  const handler = getApprovalHandler(request.type);
  try {
    await handler.apply({ request, approvedItems, decidedBy });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [failed] = await db
      .update(approvalRequests)
      .set({ status: "FAILED", applyError: message.slice(0, 1000), updatedAt: new Date() })
      .where(eq(approvalRequests.id, request.id))
      .returning();
    await db.insert(approvalDecisions).values({ requestId: request.id, action: "APPLY_FAILED", actorId: decidedBy.id, actorRole: decidedBy.role, comment: message.slice(0, 1000) });
    return { request: failed ?? request, applied: false, applyError: message };
  }
  const now = new Date();
  const [applied] = await db.update(approvalRequests).set({ appliedAt: now, updatedAt: now }).where(eq(approvalRequests.id, request.id)).returning();
  await db.insert(approvalDecisions).values({ requestId: request.id, action: "APPLY", actorId: decidedBy.id, actorRole: decidedBy.role });
  await recordAudit({
    actorId: decidedBy.id,
    actorRole: decidedBy.role,
    action: AUDIT_ACTIONS.APPROVAL_APPLIED,
    entityType: "approval_request",
    entityId: request.id,
    newValue: { type: request.type, subjectType: request.subjectType, subjectId: request.subjectId },
  });
  return { request: applied ?? request, applied: true, applyError: null };
}

/** Brief §3.1: every single-admin approval is e-mailed to the Super Admin. Never throws. */
async function notifySingleAdminApproval(request: ApprovalRequest, actor: ApprovalActor): Promise<void> {
  try {
    const { sendEmail } = await import("@/server/email/transport");
    await sendEmail({
      to: superAdminEmail(),
      subject: `GoKesari: single-admin approval — ${request.title}`,
      text: [
        "A four-eye request was approved by one admin, because fewer than two admins are active.",
        "",
        `Request: ${request.title}`,
        `Type: ${request.type}`,
        `Reason given: ${request.reason}`,
        `Approved by: ${actor.email ?? actor.id}`,
        `Approved at: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`,
        "",
        "This mode switches off by itself once a second admin is active.",
      ].join("\n"),
    });
  } catch (error) {
    console.error("[approvals] single-admin e-mail failed", error);
  }
}

/* ----------------------------------------------------------------- cancel */

export async function cancelApproval(requestId: string, actor: ApprovalActor, comment?: string | null): Promise<ApprovalRequest> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, requestId)).for("update");
    if (!locked) throw notFound("Approval request");
    if (locked.requestedBy !== actor.id) throw forbidden("Only the person who raised this request can cancel it.");
    if (locked.status !== "PENDING") throw conflict("This request has already been decided.");
    const now = new Date();
    const [request] = await tx
      .update(approvalRequests)
      .set({ status: "CANCELLED", decidedBy: actor.id, decidedAt: now, decisionComment: comment?.trim() || null, updatedAt: now })
      .where(eq(approvalRequests.id, requestId))
      .returning();
    await tx.update(approvalRequestItems).set({ status: "CANCELLED" }).where(and(eq(approvalRequestItems.requestId, requestId), eq(approvalRequestItems.status, "PENDING")));
    await tx.insert(approvalDecisions).values({ requestId, action: "CANCEL", actorId: actor.id, actorRole: actor.role, comment: comment?.trim() || null });
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.APPROVAL_DECIDED, entityType: "approval_request", entityId: requestId, newValue: { status: "CANCELLED" } },
      tx,
    );
    return request;
  });
}

/* ------------------------------------------------------------------ reads */

export interface ApprovalDetail {
  request: ApprovalRequest;
  items: ApprovalRequestItem[];
  decisions: ApprovalDecision[];
}

export async function getApproval(requestId: string): Promise<ApprovalDetail> {
  const [request] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, requestId));
  if (!request) throw notFound("Approval request");
  const items = await db.select().from(approvalRequestItems).where(eq(approvalRequestItems.requestId, requestId)).orderBy(approvalRequestItems.position);
  const decisions = await db.select().from(approvalDecisions).where(eq(approvalDecisions.requestId, requestId)).orderBy(approvalDecisions.createdAt);
  return { request, items, decisions };
}

export async function listApprovals(options: { statuses?: string[]; checkers?: ApprovalChecker[]; shopId?: string; limit?: number } = {}): Promise<ApprovalRequest[]> {
  const where = [] as ReturnType<typeof eq>[];
  if (options.statuses?.length) where.push(inArray(approvalRequests.status, options.statuses as ApprovalRequest["status"][]));
  if (options.checkers?.length) where.push(inArray(approvalRequests.checker, options.checkers));
  if (options.shopId) where.push(eq(approvalRequests.shopId, options.shopId));
  return db
    .select()
    .from(approvalRequests)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(Math.min(options.limit ?? 100, 500));
}

/** Emergency actions applied at once whose second-admin confirmation is overdue (Admin board). */
export async function listOverdueConfirmations(): Promise<ApprovalRequest[]> {
  return db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.status, "PENDING"), sql`${approvalRequests.confirmBy} IS NOT NULL AND ${approvalRequests.confirmBy} < now()`))
    .orderBy(approvalRequests.confirmBy);
}
