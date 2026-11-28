/**
 * Registration fee "Pay later" (owner request 28-Nov-2026; docs/fee-pay-later-2026-11; migration 0229;
 * flag shop_fee_pay_later_enabled).
 *
 *   1. The owner chooses "Pay later" on the registration fee step (onboarding v2, before the shop exists) or on
 *      Pay registration fee for a shop that owes it. A request (shop_fee_pay_later, REQUESTED) goes to the
 *      administrators.
 *   2. An administrator approves (APPROVED) or rejects (REJECTED). Approved, the fee no longer holds the shop back:
 *      it goes live at once when nothing else does (instant approval, else the approval with the documents
 *      promise), or as soon as the owner finishes registering. Rejected, the owner pays the fee as before.
 *   3. While the fee is owed the owner gets the fee reminder every week from the approval (in-app + push + e-mail
 *      with a Pay now link; shop-registration-subscription.ts), and every payout (payout cycle or weekly
 *      settlement) first pays the fee: the whole fee when the payout is larger, all of the payout when it is
 *      smaller (the rest from the next payouts). Each deduction is a fee payment on the shop's ledger (method
 *      PAYOUT_DEDUCTION) and a shop_fee_recoveries row; a fee paid in full ends the request (SETTLED). Paying
 *      online at any time works as before and ends it too.
 *   4. The owner's Registration fee page shows the statement: fee, every deduction (date, payout before, amount),
 *      what is left, and the commission GoKesari has earned from the shop so far.
 *
 * With the flag off nothing new is offered; requests already approved keep being recovered from payouts.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  orderFinancials,
  shopFeePayLater,
  shopFeeRecoveries,
  shopPayments,
  shopRegistrationDrafts,
  shops,
  users,
  type Shop,
  type ShopFeePayLater,
  type ShopFeePayLaterStatus,
  type UserRole,
} from "@/server/db/schema";
import { listAudienceUserIds } from "@/server/events/recipients";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { isFeatureEnabled } from "./feature-flags";
import { notify } from "./notifications";
import { registrationFeeDue } from "./registration-fee-payment";

export const PAY_LATER_FLAG = "shop_fee_pay_later_enabled" as const;
const OPEN: ShopFeePayLaterStatus[] = ["REQUESTED", "APPROVED"];

export interface PayLaterActor {
  id: string;
  role: UserRole;
}

export async function payLaterEnabled(): Promise<boolean> {
  return isFeatureEnabled(PAY_LATER_FLAG).catch(() => false);
}

function site(): string {
  return (process.env.APP_BASE_URL ?? process.env.NEXTAUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");
}

/** The open (requested or approved) request of a shop, or null. A request made on the shop's draft is linked here if it was not yet. */
export async function openPayLaterForShop(shopId: string, client: DbClient = db): Promise<ShopFeePayLater | null> {
  const find = async () =>
    (
      await client
        .select()
        .from(shopFeePayLater)
        .where(and(eq(shopFeePayLater.shopId, shopId), inArray(shopFeePayLater.status, OPEN)))
        .limit(1)
    )[0] ?? null;
  const row = await find();
  if (row) return row;
  const [draft] = await client.select({ id: shopRegistrationDrafts.id }).from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.shopId, shopId)).limit(1);
  if (!draft) return null;
  await linkPayLaterToShop(draft.id, shopId, client);
  return find();
}

/** The open request of a registration draft, or null. */
export async function openPayLaterForDraft(draftId: string, client: DbClient = db): Promise<ShopFeePayLater | null> {
  const [row] = await client
    .select()
    .from(shopFeePayLater)
    .where(and(eq(shopFeePayLater.draftId, draftId), inArray(shopFeePayLater.status, OPEN)))
    .limit(1);
  return row ?? null;
}

/** The latest request made on a registration draft (any status), or null. */
export async function latestPayLaterForDraft(draftId: string, client: DbClient = db): Promise<ShopFeePayLater | null> {
  const [row] = await client.select().from(shopFeePayLater).where(eq(shopFeePayLater.draftId, draftId)).orderBy(desc(shopFeePayLater.requestedAt)).limit(1);
  return row ?? null;
}

/** The shop's fee is "approved to pay later": the fee does not hold it back from going live. */
export async function feeDeferredByApproval(shopId: string, client: DbClient = db): Promise<boolean> {
  const row = await openPayLaterForShop(shopId, client);
  return row?.status === "APPROVED";
}

/* ============================================================ request */

/**
 * Records the owner's request (inside the caller's transaction when given) and tells the administrators after.
 * One open request per draft / shop: asking again returns the open one.
 */
export async function createPayLaterRequest(
  input: { ownerId: string; draftId?: string | null; shopId?: string | null; amountPaise: number; note?: string | null; shopName: string },
  client: DbClient = db,
): Promise<{ request: ShopFeePayLater; created: boolean }> {
  if (!input.draftId && !input.shopId) throw validationFailed("A registration or a shop is required.");
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw conflict("Nothing is due: there is no fee to pay later.");
  const existing = input.shopId ? await openPayLaterForShop(input.shopId, client) : await openPayLaterForDraft(input.draftId!, client);
  if (existing) return { request: existing, created: false };
  const note = input.note?.trim().slice(0, 500) || null;
  const [request] = await client
    .insert(shopFeePayLater)
    .values({ ownerId: input.ownerId, draftId: input.draftId ?? null, shopId: input.shopId ?? null, amountPaise: input.amountPaise, ownerNote: note })
    .returning();
  await recordAudit(
    {
      actorId: input.ownerId,
      actorRole: "SHOP_OWNER",
      action: AUDIT_ACTIONS.SHOP_FEE_PAY_LATER_REQUESTED,
      entityType: input.shopId ? "shop" : "shop_registration_draft",
      entityId: input.shopId ?? input.draftId!,
      newValue: { requestId: request.id, amountPaise: input.amountPaise, note },
    },
    client,
  );
  return { request, created: true };
}

/** After the request is committed: the administrators are told (in-app + e-mail). Never throws. */
export async function tellAdminsOfPayLaterRequest(request: ShopFeePayLater, shopName: string): Promise<void> {
  try {
    const [owner] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, request.ownerId));
    const admins = await listAudienceUserIds("SUPPORT_LEAD");
    for (const userId of admins) {
      await notify({
        userId,
        type: NOTIFICATION_TYPES.SUPPORT_SHOP_FEE_PAY_LATER_REQUESTED,
        vars: { shopName, ownerName: owner?.name ?? owner?.email ?? "A shop owner", amount: formatPaise(request.amountPaise) },
        actionUrl: "/admin/shops/pay-later",
        dedupeKey: `shop-fee-pay-later-requested:${request.id}:${userId}`,
        metadata: { requestId: request.id },
      });
    }
  } catch (error) {
    console.error("[fee-pay-later] admin notice failed", request.id, error);
  }
}

/** An existing shop that owes its registration fee (Pay registration fee page): the owner asks to pay later. */
export async function requestShopFeePayLater(shopId: string, owner: { id: string }, note?: string | null): Promise<ShopFeePayLater> {
  if (!(await payLaterEnabled())) throw conflict("Pay later is not available.");
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.ownerId !== owner.id || shop.deletedAt) throw notFound("Shop");
  if (shop.status !== "PENDING_APPROVAL" && shop.status !== "APPROVED") throw conflict("This shop cannot ask to pay later.");
  const due = registrationFeeDue(shop);
  const { request, created } = await createPayLaterRequest({ ownerId: owner.id, shopId, amountPaise: due, note, shopName: shop.name });
  if (created) await tellAdminsOfPayLaterRequest(request, shop.name);
  return request;
}

/** The v2 draft became its shop: its pay-later request now belongs to the shop (idempotent). */
export async function linkPayLaterToShop(draftId: string, shopId: string, client: DbClient = db): Promise<void> {
  await client
    .update(shopFeePayLater)
    .set({ shopId, updatedAt: new Date() })
    .where(and(eq(shopFeePayLater.draftId, draftId), isNull(shopFeePayLater.shopId)));
}

/* ============================================================ decision */

function assertCanDecide(actor: PayLaterActor): void {
  if (!can(actor.role, PERMISSIONS.REGISTRATION_FEE_MANAGE)) throw forbidden("Only an administrator approves paying the registration fee later.");
}

export interface PayLaterDecisionResult {
  request: ShopFeePayLater;
  /** APPROVE: the shop is live now. */
  live: boolean;
  /** APPROVE: what still holds the shop back (documents, duplicate, the owner has not finished registering…). */
  waitingFor: string | null;
}

/**
 * The administrator's answer. APPROVE: the fee stops holding the shop back and the shop is approved now when
 * nothing else does (instant approval; else the approval with the documents promise). REJECT: the owner pays
 * the fee as before (a v2 draft goes back to the fee step).
 */
export async function decidePayLater(
  requestId: string,
  decision: "APPROVE" | "REJECT",
  note: string | null,
  actor: PayLaterActor,
): Promise<PayLaterDecisionResult> {
  assertCanDecide(actor);
  const reason = note?.trim().slice(0, 500) || null;
  if (decision === "REJECT" && !reason) throw validationFailed("Give a reason for the shop owner.", { fields: { note: "Required." } });
  const now = new Date();
  const request = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(shopFeePayLater).where(eq(shopFeePayLater.id, requestId)).for("update");
    if (!row) throw notFound("Pay-later request");
    if (row.status !== "REQUESTED") throw conflict(`This request is already ${row.status.toLowerCase()}.`);
    const [updated] = await tx
      .update(shopFeePayLater)
      .set({ status: decision === "APPROVE" ? "APPROVED" : "REJECTED", decidedAt: now, decidedBy: actor.id, decisionNote: reason, updatedAt: now })
      .where(eq(shopFeePayLater.id, row.id))
      .returning();
    if (decision === "REJECT" && row.draftId) {
      // The registration goes back to the fee step (the steps after it stay as they were).
      await tx.update(shopRegistrationDrafts).set({ feeDeferredAt: null, updatedAt: now }).where(and(eq(shopRegistrationDrafts.id, row.draftId), isNull(shopRegistrationDrafts.feePaidAt)));
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: decision === "APPROVE" ? AUDIT_ACTIONS.SHOP_FEE_PAY_LATER_APPROVED : AUDIT_ACTIONS.SHOP_FEE_PAY_LATER_REJECTED,
        entityType: row.shopId ? "shop" : "shop_registration_draft",
        entityId: row.shopId ?? row.draftId!,
        previousValue: { status: row.status },
        newValue: { requestId: row.id, status: updated.status, amountPaise: row.amountPaise, note: reason },
      },
      tx,
    );
    return updated;
  });

  let live = false;
  let waitingFor: string | null = null;
  const shop = request.shopId ? (await db.select().from(shops).where(eq(shops.id, request.shopId)))[0] : undefined;
  if (decision === "APPROVE") {
    if (!shop) waitingFor = "the owner to finish registering (the shop goes live when they do)";
    else if (shop.status === "APPROVED") live = true;
    else if (shop.status === "PENDING_APPROVAL") ({ live, waitingFor } = await approveDeferredShop(shop, actor));
    else waitingFor = `the shop is ${shop.status.toLowerCase().replace("_", " ")}`;
  }
  await tellOwnerOfDecision(request, decision, shop ?? null, live, reason);
  return { request, live, waitingFor };
}

/** The fee is approved to pay later: approve the pending shop now unless something else holds it back. */
async function approveDeferredShop(shop: Shop, actor: PayLaterActor): Promise<{ live: boolean; waitingFor: string | null }> {
  const { autoApproveShopIfReady, approveShop } = await import("./shops");
  // A v2 registration goes live only after its seller agreement is accepted (the owner's last step).
  const { v2SlaPendingForShop } = await import("@/server/onboarding-v2/shop-view");
  if (await v2SlaPendingForShop(shop.id)) return { live: false, waitingFor: "the owner to accept the seller agreement (the shop goes live when they do)" };
  if (await autoApproveShopIfReady(shop.id).catch(() => false)) return { live: true, waitingFor: null };
  const { getRule } = await import("./settings");
  const rule = await getRule("sellerVerification");
  const classification = shop.classification ?? rule.autoApproveClassification;
  // Documents complete: the plain approval. Else the approval on the owner's documents promise (the 90-day follow-up chases them).
  const reasons: string[] = [];
  for (const options of [{}, { acceptDocumentsPromise: true }]) {
    try {
      await approveShop(shop.id, { classification }, actor, options);
      return { live: true, waitingFor: null };
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { live: false, waitingFor: `shop approval: ${[...new Set(reasons)].join(" / ")} — approve it under Admin → Shops once that is resolved` };
}

async function tellOwnerOfDecision(request: ShopFeePayLater, decision: "APPROVE" | "REJECT", shop: Shop | null, live: boolean, reason: string | null): Promise<void> {
  const name = shop?.name ?? "your shop";
  const amount = formatPaise(request.amountPaise);
  const message =
    decision === "APPROVE"
      ? [
          `Your request to pay the registration fee of ${amount} later is approved.`,
          live ? `${name} is live: you can add your products and take orders now.` : "Finish your registration and your shop goes live.",
          "The fee will be taken from your payouts until it is paid (all of a payout when it is smaller than the fee). You can also pay it any time:",
          `${site()}/shop/registration-fee${shop ? `?shop=${shop.id}` : ""}`,
        ].join(" ")
      : [`Your request to pay the registration fee of ${amount} later was not approved${reason ? `: ${reason}` : ""}.`, "Please pay the registration fee to continue:", `${site()}${shop ? `/shop/registration-fee?shop=${shop.id}` : "/shop/register"}`].join(" ");
  await notify({
    userId: request.ownerId,
    type: NOTIFICATION_TYPES.SHOP_FEE_PAY_LATER,
    vars: { title: decision === "APPROVE" ? `Pay later approved — ${name}` : `Pay later not approved — ${name}`, message },
    actionUrl: shop ? `/shop/registration-fee?shop=${shop.id}` : "/shop/register",
    channels: ["PUSH", "EMAIL"],
    mandatory: true,
    dedupeKey: `shop-fee-pay-later-decision:${request.id}`,
    metadata: { requestId: request.id, decision },
  }).catch((error) => console.error("[fee-pay-later] owner notice failed", request.id, error));
}

/* ============================================================ recovery */

export interface RecoveryDue {
  payLaterId: string;
  duePaise: number;
  /** Who approved it: the fee payment is recorded in their name. */
  approvedBy: string | null;
}

/** Shops among `shopIds` with an approved pay-later fee still owed, and what is owed. */
export async function feeRecoveriesDue(shopIds: string[], client: DbClient = db): Promise<Map<string, RecoveryDue>> {
  const out = new Map<string, RecoveryDue>();
  if (shopIds.length === 0) return out;
  const rows = await client
    .select({ request: shopFeePayLater, shop: shops })
    .from(shopFeePayLater)
    .innerJoin(shops, eq(shops.id, shopFeePayLater.shopId))
    .where(and(inArray(shopFeePayLater.shopId, shopIds), eq(shopFeePayLater.status, "APPROVED")));
  for (const { request, shop } of rows) {
    const due = registrationFeeDue(shop);
    if (due > 0) out.set(shop.id, { payLaterId: request.id, duePaise: due, approvedBy: request.decidedBy });
  }
  return out;
}

/** Pure: what a payout pays towards the fee — all of the fee when the payout is larger, all of the payout when smaller. */
export function recoveryFrom(payoutPaise: number, duePaise: number): number {
  if (payoutPaise <= 0 || duePaise <= 0) return 0;
  return Math.min(payoutPaise, duePaise);
}

/**
 * Inside the payout transaction: the deduction on the shop's fee ledger (a REGISTRATION_FEE payment, method
 * PAYOUT_DEDUCTION) and its recovery row; the request ends (SETTLED) once nothing is owed.
 */
export async function recordFeeRecovery(
  tx: DbClient,
  input: { shopId: string; due: RecoveryDue; amountPaise: number; payoutBeforePaise: number; sourceType: "PAYOUT_CYCLE" | "SHOP_SETTLEMENT"; sourceId: string; label: string },
): Promise<void> {
  if (input.amountPaise <= 0) return;
  const { recordPayment } = await import("./shop-payments");
  const recorded = await recordPayment(
    {
      shopId: input.shopId,
      paymentType: "REGISTRATION_FEE",
      amountPaise: input.amountPaise,
      method: "PAYOUT_DEDUCTION",
      note: `Registration fee (pay later) taken from ${input.label}: ${formatPaise(input.amountPaise)} of a payout of ${formatPaise(input.payoutBeforePaise)}.`,
    },
    // The ledger keeps who approved paying later as the person it was recorded for (the payout job has no user).
    { id: input.due.approvedBy ?? (await shopOwnerId(tx, input.shopId)), role: input.due.approvedBy ? "ADMIN" : "SHOP_OWNER" },
    tx,
  );
  await tx.insert(shopFeeRecoveries).values({
    payLaterId: input.due.payLaterId,
    shopId: input.shopId,
    amountPaise: input.amountPaise,
    payoutBeforePaise: input.payoutBeforePaise,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    shopPaymentId: recorded.payment.id,
  });
  await recordAudit(
    {
      actorId: null,
      actorRole: null,
      action: AUDIT_ACTIONS.SHOP_FEE_RECOVERED_FROM_PAYOUT,
      entityType: "shop",
      entityId: input.shopId,
      newValue: { requestId: input.due.payLaterId, amountPaise: input.amountPaise, payoutBeforePaise: input.payoutBeforePaise, source: `${input.sourceType}:${input.sourceId}`, reference: recorded.payment.reference, feePaymentStatus: recorded.feePaymentStatus },
    },
    tx,
  );
  // A fee paid in full ends the request (recordPayment does it, in this transaction).
}

async function shopOwnerId(tx: DbClient, shopId: string): Promise<string> {
  const [row] = await tx.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
  if (!row) throw notFound("Shop");
  return row.ownerId;
}

/** The fee is paid in full (from payouts, online or by hand): the shop's open request ends. Idempotent. */
export async function settlePayLater(client: DbClient, shopId: string, how: string): Promise<boolean> {
  const now = new Date();
  const ended = await client
    .update(shopFeePayLater)
    .set({ status: "SETTLED", settledAt: now, updatedAt: now })
    .where(and(eq(shopFeePayLater.shopId, shopId), eq(shopFeePayLater.status, "APPROVED")))
    .returning({ id: shopFeePayLater.id });
  // A request not yet answered when the fee was paid is no longer needed.
  await client
    .update(shopFeePayLater)
    .set({ status: "CANCELLED", decisionNote: `Fee paid before a decision (${how}).`, updatedAt: now })
    .where(and(eq(shopFeePayLater.shopId, shopId), eq(shopFeePayLater.status, "REQUESTED")));
  if (ended.length === 0) return false;
  await recordAudit(
    { actorId: null, actorRole: null, action: AUDIT_ACTIONS.SHOP_FEE_PAY_LATER_SETTLED, entityType: "shop", entityId: shopId, newValue: { requestId: ended[0].id, how } },
    client,
  );
  return true;
}

/** After the payout transaction commits: each shop is told what was taken and what is left. Never throws. */
export async function tellOwnersOfRecoveries(recoveries: { shopId: string; amountPaise: number; payoutBeforePaise: number; label: string }[]): Promise<void> {
  for (const r of recoveries) {
    try {
      const [shop] = await db.select().from(shops).where(eq(shops.id, r.shopId));
      if (!shop) continue;
      const left = registrationFeeDue(shop);
      const { refreshRegistrationStatusSafely } = await import("./shop-membership");
      await refreshRegistrationStatusSafely(shop.id);
      const message = [
        `${formatPaise(r.amountPaise)} of your payout (${r.label}, ${formatPaise(r.payoutBeforePaise)} before this) went towards the registration fee of ${shop.name}.`,
        left > 0 ? `Still to pay: ${formatPaise(left)} — it will be taken from your next payouts, or pay it now:` : "Your registration fee is now paid in full. Thank you!",
        `${site()}/shop/registration-fee?shop=${shop.id}`,
      ].join(" ");
      await notify({
        userId: shop.ownerId,
        type: NOTIFICATION_TYPES.SHOP_FEE_PAY_LATER,
        vars: { title: left > 0 ? `Registration fee: ${formatPaise(r.amountPaise)} taken from your payout` : `Registration fee paid — ${shop.name}`, message },
        actionUrl: `/shop/registration-fee?shop=${shop.id}`,
        channels: ["PUSH", "EMAIL"],
        mandatory: true,
        metadata: { shopId: shop.id, amountPaise: r.amountPaise, leftPaise: left },
      });
      if (left === 0) {
        const { checkCommissionMilestonesSafely } = await import("@/server/dealers/commission");
        await checkCommissionMilestonesSafely(shop.id);
      }
    } catch (error) {
      console.error("[fee-pay-later] recovery notice failed", r.shopId, error);
    }
  }
}

/* ============================================================ views */

export interface PayLaterStatement {
  request: { id: string; status: ShopFeePayLaterStatus; requestedAt: Date; decidedAt: Date | null; decisionNote: string | null; amountPaise: number } | null;
  feePaise: number;
  paidPaise: number;
  duePaise: number;
  /** Paid by deduction from payouts. */
  recoveredPaise: number;
  /** Paid any other way (online, by hand). */
  paidOtherwisePaise: number;
  deductions: { at: Date; amountPaise: number; payoutBeforePaise: number; source: "PAYOUT_CYCLE" | "SHOP_SETTLEMENT"; reference: string | null }[];
  /** GoKesari's commission on the shop's delivered orders so far. */
  commissionEarnedPaise: number;
  deliveredOrders: number;
  goodsPaise: number;
}

/** The owner's (and staff's) statement for a shop's pay-later fee. */
export async function payLaterStatement(shop: Shop): Promise<PayLaterStatement> {
  const [latest] = await db.select().from(shopFeePayLater).where(eq(shopFeePayLater.shopId, shop.id)).orderBy(desc(shopFeePayLater.requestedAt)).limit(1);
  const deductions = await db
    .select({ r: shopFeeRecoveries, reference: shopPayments.reference })
    .from(shopFeeRecoveries)
    .leftJoin(shopPayments, eq(shopPayments.id, shopFeeRecoveries.shopPaymentId))
    .where(eq(shopFeeRecoveries.shopId, shop.id))
    .orderBy(shopFeeRecoveries.createdAt);
  const [orders] = await db
    .select({
      commission: sql<number>`coalesce(sum(${orderFinancials.commissionPaise}), 0)::bigint`,
      goods: sql<number>`coalesce(sum(${orderFinancials.goodsPaise}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(orderFinancials)
    .where(eq(orderFinancials.shopId, shop.id));
  const recoveredPaise = deductions.reduce((s, d) => s + Number(d.r.amountPaise), 0);
  const paidPaise = shop.amountPaidPaise;
  return {
    request: latest
      ? { id: latest.id, status: latest.status, requestedAt: latest.requestedAt, decidedAt: latest.decidedAt, decisionNote: latest.decisionNote, amountPaise: Number(latest.amountPaise) }
      : null,
    feePaise: shop.registrationFeePaise ?? 0,
    paidPaise,
    duePaise: registrationFeeDue(shop),
    recoveredPaise,
    paidOtherwisePaise: Math.max(0, paidPaise - recoveredPaise),
    deductions: deductions.map((d) => ({ at: d.r.createdAt, amountPaise: Number(d.r.amountPaise), payoutBeforePaise: Number(d.r.payoutBeforePaise), source: d.r.sourceType, reference: d.reference })),
    commissionEarnedPaise: Number(orders?.commission ?? 0),
    deliveredOrders: Number(orders?.count ?? 0),
    goodsPaise: Number(orders?.goods ?? 0),
  };
}

export interface PayLaterAdminRow {
  id: string;
  status: ShopFeePayLaterStatus;
  amountPaise: number;
  ownerNote: string | null;
  decisionNote: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  shopId: string | null;
  shopName: string | null;
  shopStatus: string | null;
  registrationNumber: string | null;
  duePaise: number | null;
  recoveredPaise: number;
}

/** Admin: requests by status (newest first), with what has been recovered so far. */
export async function listPayLaterRequests(filter: ShopFeePayLaterStatus | "ALL" = "REQUESTED", limit = 200): Promise<{ rows: PayLaterAdminRow[]; counts: Record<ShopFeePayLaterStatus, number> }> {
  const rows = await db
    .select({ r: shopFeePayLater, shop: shops, ownerName: users.name, ownerEmail: users.email, ownerPhone: users.phoneE164 })
    .from(shopFeePayLater)
    .leftJoin(shops, eq(shops.id, shopFeePayLater.shopId))
    .leftJoin(users, eq(users.id, shopFeePayLater.ownerId))
    .where(filter === "ALL" ? undefined : eq(shopFeePayLater.status, filter))
    .orderBy(desc(shopFeePayLater.requestedAt))
    .limit(limit);
  const ids = rows.map((r) => r.r.id);
  const recovered = ids.length
    ? await db
        .select({ id: shopFeeRecoveries.payLaterId, sum: sql<number>`sum(${shopFeeRecoveries.amountPaise})::bigint` })
        .from(shopFeeRecoveries)
        .where(inArray(shopFeeRecoveries.payLaterId, ids))
        .groupBy(shopFeeRecoveries.payLaterId)
    : [];
  const recoveredBy = new Map(recovered.map((r) => [r.id, Number(r.sum)]));
  const countRows = await db.select({ status: shopFeePayLater.status, n: sql<number>`count(*)::int` }).from(shopFeePayLater).groupBy(shopFeePayLater.status);
  const counts = { REQUESTED: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0, SETTLED: 0 } as Record<ShopFeePayLaterStatus, number>;
  for (const c of countRows) counts[c.status] = Number(c.n);
  return {
    counts,
    rows: rows.map(({ r, shop, ownerName, ownerEmail, ownerPhone }) => ({
      id: r.id,
      status: r.status,
      amountPaise: Number(r.amountPaise),
      ownerNote: r.ownerNote,
      decisionNote: r.decisionNote,
      requestedAt: r.requestedAt,
      decidedAt: r.decidedAt,
      ownerName,
      ownerEmail,
      ownerPhone,
      shopId: shop?.id ?? null,
      shopName: shop?.name ?? null,
      shopStatus: shop?.status ?? null,
      registrationNumber: shop?.registrationNumber ?? null,
      duePaise: shop ? registrationFeeDue(shop) : null,
      recoveredPaise: recoveredBy.get(r.id) ?? 0,
    })),
  };
}
