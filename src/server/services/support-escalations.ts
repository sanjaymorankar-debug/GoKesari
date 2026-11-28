/**
 * Support escalation ladder (owner, 28-Nov-2026 ~12.00 IST; migration 0232; rule supportEscalation;
 * docs/onboarding-v2-2026-11/README.md "Go-live rule and escalations").
 *
 * Owner, verbatim: "first contact and support from franchisee; if he did not act within 1 week it should be escalated
 * to operator and in 10 days it should be escalated to admin team; same will be applicable for deferred payment as
 * well; also add a check that if shop did not upload product list and start selling in 10 days it should get a
 * reminder as per above escalation policy."
 *
 * One mechanism, three kinds (support_escalations, one open row per kind + subject):
 *   SHOP_REVIEW           a v2 / v3 shop held because another owner's shop has the same GSTIN or PAN (the only hold
 *                         left by the go-live rule). Franchisee, operator or admin approves / rejects (with a reason).
 *   FEE_PAY_LATER         a pay-later request waiting for its decision (fee-pay-later.ts). Escalated, the operators
 *                         and then the admins may decide it as well as the franchisee.
 *   NO_PRODUCTS_OR_SALES  a v2 / v3 shop live for noSalesAfterDays with no product listed or no sale yet: a reminder
 *                         to the owner and a task for the franchisee; closed by itself once both exist.
 *
 * Day 0 the franchisee behind the shop's referral code (payLaterApproverForCode: the code's free dealer / franchisee,
 * or the franchisee above a team member) — or the operators when there is none. Not closed within franchiseeDays (7)
 * of opening → the operator queue; within adminDays (10) → the admin team. Every step tells whoever now has it
 * (in-app + e-mail), reminds the shop owner (in-app + e-mail), and is written to support_escalation_events and the
 * audit log (who had it, when it moved, who closed it). Run by the existing hourly cron job (support-escalations) —
 * no new server timer.
 */
import { and, asc, desc, eq, exists, inArray, isNull, lte, notExists, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  dealers,
  orders,
  shopFeePayLater,
  shopProducts,
  shopRegistrationDrafts,
  shopReviewFlags,
  shops,
  supportEscalationEvents,
  supportEscalations,
  users,
  type Shop,
  type ShopReviewFlagType,
  type SupportEscalation,
  type SupportEscalationKind,
  type SupportEscalationLevel,
  type SupportEscalationResolution,
  type UserRole,
} from "@/server/db/schema";
import { listAudienceUserIds } from "@/server/events/recipients";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { notify } from "./notifications";
import { getRule } from "./settings";

const DAY_MS = 86_400_000;
const RANK: Record<SupportEscalationLevel, number> = { FRANCHISEE: 0, OPERATOR: 1, ADMIN: 2 };

export interface EscalationActor {
  id: string;
  role: UserRole;
}

export interface Franchisee {
  dealerId: string;
  userId: string;
  name: string;
}

const KIND_LABEL: Record<SupportEscalationKind, string> = {
  SHOP_REVIEW: "Shop held for review",
  FEE_PAY_LATER: "Pay-later request",
  NO_PRODUCTS_OR_SALES: "No products or sales yet",
};

const LEVEL_LABEL: Record<SupportEscalationLevel, string> = {
  FRANCHISEE: "Franchisee",
  OPERATOR: "Operator queue",
  ADMIN: "Admin team",
};

function site(): string {
  return (process.env.APP_BASE_URL ?? process.env.NEXTAUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");
}

const isStaff = (role: UserRole) => role === "ADMIN" || role === "OPERATOR";

/* ================================================================ ladder */

/**
 * Pure: the level an escalation should be at `now`. Measured from the day it opened (owner: "within 1 week …
 * operator, in 10 days … admin team"); never lower than where it is.
 */
export function levelDue(
  current: SupportEscalationLevel,
  openedAt: Date,
  now: Date,
  rule: { franchiseeDays: number; adminDays: number },
): SupportEscalationLevel {
  const days = (now.getTime() - openedAt.getTime()) / DAY_MS;
  let due: SupportEscalationLevel = current;
  if (days >= rule.adminDays) due = "ADMIN";
  else if (days >= rule.franchiseeDays && current === "FRANCHISEE") due = "OPERATOR";
  return RANK[due] > RANK[current] ? due : current;
}

/** When the escalation moves to its next level (null at ADMIN). */
export function nextStepAt(e: Pick<SupportEscalation, "level" | "openedAt">, rule: { franchiseeDays: number; adminDays: number }): Date | null {
  if (e.level === "ADMIN") return null;
  const days = e.level === "FRANCHISEE" ? Math.min(rule.franchiseeDays, rule.adminDays) : rule.adminDays;
  return new Date(e.openedAt.getTime() + days * DAY_MS);
}

/** The franchisee behind a shop's referral code (the same resolver the pay-later approval uses), or null. */
export async function franchiseeForShop(shop: Pick<Shop, "id" | "referralCodeId">, client: DbClient = db): Promise<Franchisee | null> {
  const { payLaterApproverForCode } = await import("./fee-pay-later");
  if (shop.referralCodeId) {
    const viaId = await payLaterApproverForCode({ id: shop.referralCodeId }, client);
    if (viaId) return { dealerId: viaId.dealerId, userId: viaId.userId, name: viaId.name };
  }
  // A dealer code typed at a v2 registration is on the draft (attributed to the shop after creation).
  const [draft] = await client.select({ code: shopRegistrationDrafts.referralCode }).from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.shopId, shop.id)).limit(1);
  if (!draft?.code) return null;
  const viaText = await payLaterApproverForCode({ text: draft.code }, client);
  return viaText ? { dealerId: viaText.dealerId, userId: viaText.userId, name: viaText.name } : null;
}

/* ================================================================ messages */

interface Context {
  shopName: string;
  franchiseeName: string | null;
}

async function contextOf(e: SupportEscalation, client: DbClient = db): Promise<Context> {
  const [shop] = e.shopId ? await client.select({ name: shops.name }).from(shops).where(eq(shops.id, e.shopId)) : [];
  const [dealer] = e.franchiseeDealerId ? await client.select({ name: dealers.legalName }).from(dealers).where(eq(dealers.id, e.franchiseeDealerId)) : [];
  const draftName = typeof e.details?.shopName === "string" ? e.details.shopName : null;
  return { shopName: shop?.name ?? draftName ?? "the shop", franchiseeName: dealer?.name ?? null };
}

function whoHasIt(level: SupportEscalationLevel, ctx: Context): string {
  if (level === "FRANCHISEE") return ctx.franchiseeName ? `your franchisee ${ctx.franchiseeName}` : "your franchisee";
  return level === "OPERATOR" ? "GoKesari's operations team" : "GoKesari's admin team";
}

function assigneeMessage(e: SupportEscalation, level: SupportEscalationLevel, ctx: Context, from: SupportEscalationLevel | null): { title: string; message: string } {
  const moved = from ? ` It was with the ${LEVEL_LABEL[from].toLowerCase()} and was not closed in time, so it is now yours.` : "";
  switch (e.kind) {
    case "SHOP_REVIEW":
      return {
        title: `Shop to review: ${ctx.shopName}`,
        message: `${ctx.shopName} is held before going live: another owner's shop has the same ${String(e.details?.reasons ?? "GSTIN / PAN")}. Contact the owner, check it and approve or reject it (with a reason).${moved}`,
      };
    case "FEE_PAY_LATER":
      return {
        title: `Pay-later request waiting: ${ctx.shopName}`,
        message: `The owner of ${ctx.shopName} asked to pay the registration fee${typeof e.details?.amountPaise === "number" ? ` of ${formatPaise(e.details.amountPaise)}` : ""} later and is waiting for an answer. Approve or reject it.${moved}`,
      };
    case "NO_PRODUCTS_OR_SALES":
      return {
        title: `Help needed: ${ctx.shopName} has not started selling`,
        message: `${ctx.shopName} has been live for ${String(e.details?.days ?? "10")} days with ${String(e.details?.missing ?? "no products or no sale")} yet. Contact the owner and help them list their products and take their first order.${moved}`,
      };
  }
}

function ownerMessage(e: SupportEscalation, level: SupportEscalationLevel, ctx: Context): { title: string; message: string; actionUrl: string } {
  const who = whoHasIt(level, ctx);
  switch (e.kind) {
    case "SHOP_REVIEW":
      return {
        title: `${ctx.shopName}: a quick check before going live`,
        message: `Another shop on GoKesari has the same GSTIN or PAN as ${ctx.shopName}, so it is checked before it goes live. ${who[0].toUpperCase()}${who.slice(1)} will contact you. You can reply to this e-mail or contact support@gokesari.com.`,
        actionUrl: "/shop",
      };
    case "FEE_PAY_LATER":
      return {
        title: `Your pay-later request for ${ctx.shopName}`,
        message: `Your request to pay the registration fee later is now with ${who}. You will be told as soon as it is decided. You can also pay the fee any time: ${site()}/shop/registration-fee${e.shopId ? `?shop=${e.shopId}` : ""}`,
        actionUrl: e.shopId ? `/shop/registration-fee?shop=${e.shopId}` : "/shop/register",
      };
    case "NO_PRODUCTS_OR_SALES":
      return {
        title: `${ctx.shopName}: add your products and start selling`,
        message: `${ctx.shopName} has been live for ${String(e.details?.days ?? "10")} days with ${String(e.details?.missing ?? "no products or no sale")} yet. Add your product list (photos, prices, stock) so customers can order: ${site()}/shop/products. ${who[0].toUpperCase()}${who.slice(1)} will help you.`,
        actionUrl: "/shop/products",
      };
  }
}

/** Who has the escalation at `level`: the franchisee, the operators (admins when there are none), the admins. */
async function recipientsAt(e: SupportEscalation, level: SupportEscalationLevel): Promise<string[]> {
  if (level === "FRANCHISEE") return e.franchiseeUserId ? [e.franchiseeUserId] : [];
  if (level === "OPERATOR") {
    const operators = await listAudienceUserIds("OPERATIONS");
    // DEFAULT – confirm with Sanjay: with no operator account the operator step goes to the admins.
    return operators.length ? operators : listAudienceUserIds("SUPPORT_LEAD");
  }
  return listAudienceUserIds("SUPPORT_LEAD");
}

/** Tells whoever now has it and reminds the owner. Never throws. */
async function announce(e: SupportEscalation, level: SupportEscalationLevel, from: SupportEscalationLevel | null, options: { assignee?: boolean; owner?: boolean } = {}): Promise<void> {
  try {
    const ctx = await contextOf(e);
    if (options.assignee !== false) {
      const text = assigneeMessage(e, level, ctx, from);
      for (const userId of await recipientsAt(e, level)) {
        await notify({
          userId,
          type: NOTIFICATION_TYPES.SUPPORT_ESCALATION_ASSIGNED,
          vars: text,
          actionUrl: level === "FRANCHISEE" ? "/dealer/escalations" : "/admin/shops/escalations",
          channels: ["EMAIL"],
          mandatory: true,
          dedupeKey: `support-escalation:${e.id}:${level}:${userId}`,
          metadata: { escalationId: e.id, kind: e.kind, level, shopId: e.shopId },
        });
      }
    }
    if (options.owner !== false && e.ownerId) {
      const text = ownerMessage(e, level, ctx);
      await notify({
        userId: e.ownerId,
        type: NOTIFICATION_TYPES.SHOP_SUPPORT_REMINDER,
        vars: { title: text.title, message: text.message },
        actionUrl: text.actionUrl,
        channels: ["EMAIL"],
        mandatory: true,
        dedupeKey: `support-escalation-owner:${e.id}:${level}`,
        metadata: { escalationId: e.id, kind: e.kind, level, shopId: e.shopId },
      });
    }
  } catch (error) {
    console.error("[support-escalations] notice failed", e.id, error);
  }
}

/* ================================================================ open */

export interface OpenInput {
  kind: SupportEscalationKind;
  subjectId: string;
  shopId: string | null;
  ownerId: string | null;
  reason: string;
  details?: Record<string, unknown>;
  /** Already known (the pay-later request's approver); else resolved from the shop's referral code. */
  franchisee?: Franchisee | null;
  openedAt?: Date;
  /** Tell the assignee / remind the owner now (default both). */
  announce?: { assignee?: boolean; owner?: boolean };
}

/**
 * Opens an escalation (idempotent: the open one is returned). With rule supportEscalation off, nothing is opened.
 * A shop without a franchisee starts with the operators (DEFAULT – confirm with Sanjay).
 */
export async function openEscalation(input: OpenInput): Promise<SupportEscalation | null> {
  const rule = await getRule("supportEscalation");
  if (!rule.enabled) return null;
  const [existing] = await db
    .select()
    .from(supportEscalations)
    .where(and(eq(supportEscalations.kind, input.kind), eq(supportEscalations.subjectId, input.subjectId), isNull(supportEscalations.resolvedAt)))
    .limit(1);
  if (existing) return existing;
  let franchisee = input.franchisee;
  if (franchisee === undefined && input.shopId) {
    const [shop] = await db.select({ id: shops.id, referralCodeId: shops.referralCodeId }).from(shops).where(eq(shops.id, input.shopId));
    franchisee = shop ? await franchiseeForShop(shop) : null;
  }
  const openedAt = input.openedAt ?? new Date();
  const start: SupportEscalationLevel = franchisee ? "FRANCHISEE" : "OPERATOR";
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(supportEscalations)
      .values({
        kind: input.kind,
        subjectId: input.subjectId,
        shopId: input.shopId,
        ownerId: input.ownerId,
        level: start,
        franchiseeDealerId: franchisee?.dealerId ?? null,
        franchiseeUserId: franchisee?.userId ?? null,
        reason: input.reason,
        details: input.details ?? {},
        openedAt,
        levelChangedAt: openedAt,
        lastRemindedAt: openedAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return null;
    await tx.insert(supportEscalationEvents).values({ escalationId: row.id, event: "OPENED", toLevel: start, note: input.reason, createdAt: openedAt });
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SUPPORT_ESCALATION_OPENED,
        entityType: input.shopId ? "shop" : "support_escalation",
        entityId: input.shopId ?? row.id,
        newValue: { escalationId: row.id, kind: input.kind, level: start, franchisee: franchisee ? { dealerId: franchisee.dealerId, name: franchisee.name } : null, reason: input.reason },
      },
      tx,
    );
    return row;
  });
  if (!created) {
    const [row] = await db
      .select()
      .from(supportEscalations)
      .where(and(eq(supportEscalations.kind, input.kind), eq(supportEscalations.subjectId, input.subjectId), isNull(supportEscalations.resolvedAt)))
      .limit(1);
    return row ?? null;
  }
  await announce(created, start, null, input.announce);
  return created;
}

/** SHOP_REVIEW for a v2 / v3 shop held because another owner's shop has the same GSTIN / PAN. */
export async function openShopReview(shop: Shop, duplicate: { shopId: string; reasons: string[] }): Promise<SupportEscalation | null> {
  return openEscalation({
    kind: "SHOP_REVIEW",
    subjectId: shop.id,
    shopId: shop.id,
    ownerId: shop.ownerId,
    reason: `Another owner's shop has the same ${duplicate.reasons.join(" and ")}.`,
    details: { matchedShopId: duplicate.shopId, reasons: duplicate.reasons.join(" and ") },
  });
}

/** FEE_PAY_LATER for a new request (the request's dealer is its franchisee; the existing request notice is enough). */
export async function openPayLaterEscalation(
  request: { id: string; ownerId: string; shopId: string | null; amountPaise: number; approverDealerId: string | null; approverUserId: string | null; requestedAt: Date },
  shopName: string,
  options: { announce?: boolean } = {},
): Promise<SupportEscalation | null> {
  const { payLaterDecider } = await import("./fee-pay-later");
  const dealerDecides = (await payLaterDecider(request)) === "DEALER";
  const [dealer] = dealerDecides && request.approverDealerId ? await db.select({ name: dealers.legalName }).from(dealers).where(eq(dealers.id, request.approverDealerId)) : [];
  return openEscalation({
    kind: "FEE_PAY_LATER",
    subjectId: request.id,
    shopId: request.shopId,
    ownerId: request.ownerId,
    reason: "Pay-later request waiting for a decision.",
    details: { amountPaise: request.amountPaise, shopName },
    franchisee: dealerDecides ? { dealerId: request.approverDealerId!, userId: request.approverUserId!, name: dealer?.name ?? "" } : null,
    openedAt: request.requestedAt,
    // The request notice already went to the dealer / the administrators; the owner just asked.
    announce: options.announce ? undefined : { assignee: dealerDecides ? false : true, owner: false },
  });
}

/* ================================================================ resolve */

/** Closes the open escalation of this kind and subject, if any (inside the caller's transaction when given). */
export async function resolveEscalationFor(
  kind: SupportEscalationKind,
  subjectId: string,
  resolution: SupportEscalationResolution,
  by: { id: string | null; role?: UserRole | null },
  note: string | null = null,
  client: DbClient = db,
  now: Date = new Date(),
): Promise<SupportEscalation | null> {
  const [row] = await client
    .update(supportEscalations)
    .set({ resolvedAt: now, resolvedBy: by.id, resolution, resolutionNote: note, updatedAt: now })
    .where(and(eq(supportEscalations.kind, kind), eq(supportEscalations.subjectId, subjectId), isNull(supportEscalations.resolvedAt)))
    .returning();
  if (!row) return null;
  await client.insert(supportEscalationEvents).values({ escalationId: row.id, event: "RESOLVED", fromLevel: row.level, actorId: by.id, note: note ?? resolution, createdAt: now });
  await recordAudit(
    {
      actorId: by.id,
      actorRole: by.role ?? null,
      action: AUDIT_ACTIONS.SUPPORT_ESCALATION_RESOLVED,
      entityType: row.shopId ? "shop" : "support_escalation",
      entityId: row.shopId ?? row.id,
      previousValue: { level: row.level },
      newValue: { escalationId: row.id, kind, resolution, note, openedAt: row.openedAt.toISOString() },
    },
    client,
  );
  return row;
}

/** The open escalation's condition is gone (decided elsewhere, products + a sale): close it. True when closed. */
async function autoResolve(e: SupportEscalation, now: Date): Promise<boolean> {
  if (e.kind === "SHOP_REVIEW") {
    const [shop] = await db.select().from(shops).where(eq(shops.id, e.subjectId));
    if (!shop || shop.deletedAt) return Boolean(await resolveEscalationFor(e.kind, e.subjectId, "CLOSED", { id: null }, "The shop was closed.", db, now));
    if (shop.status === "PENDING_APPROVAL") return false;
    const resolution = shop.status === "REJECTED" ? "REJECTED" : shop.status === "APPROVED" ? "APPROVED" : "RESOLVED";
    return Boolean(await resolveEscalationFor(e.kind, e.subjectId, resolution, { id: shop.status === "APPROVED" ? shop.approvedBy : shop.statusActorId }, `Shop is ${shop.status.toLowerCase()}.`, db, now));
  }
  if (e.kind === "FEE_PAY_LATER") {
    const [request] = await db.select().from(shopFeePayLater).where(eq(shopFeePayLater.id, e.subjectId));
    if (request && request.status === "REQUESTED") return false;
    const resolution = request?.status === "APPROVED" || request?.status === "SETTLED" ? "APPROVED" : request?.status === "REJECTED" ? "REJECTED" : "RESOLVED";
    return Boolean(await resolveEscalationFor(e.kind, e.subjectId, resolution, { id: request?.decidedBy ?? null }, request ? `Request ${request.status.toLowerCase()}.` : "Request no longer exists.", db, now));
  }
  const [shop] = await db.select({ status: shops.status, deletedAt: shops.deletedAt }).from(shops).where(eq(shops.id, e.subjectId));
  if (!shop || shop.deletedAt) return Boolean(await resolveEscalationFor(e.kind, e.subjectId, "CLOSED", { id: null }, "The shop was closed.", db, now));
  const progress = await sellingProgress(e.subjectId);
  if (progress.products && progress.sales) return Boolean(await resolveEscalationFor(e.kind, e.subjectId, "RESOLVED", { id: null }, "Products listed and a first sale delivered.", db, now));
  return false;
}

/**
 * Has the shop started selling? DEFAULT – confirm with Sanjay ("start selling"): at least one active listing AND at
 * least one DELIVERED order.
 */
export async function sellingProgress(shopId: string, client: DbClient = db): Promise<{ products: boolean; sales: boolean }> {
  const [p] = await client
    .select({ id: shopProducts.id })
    .from(shopProducts)
    .where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.isActive, true), isNull(shopProducts.deletedAt)))
    .limit(1);
  const [o] = await client.select({ id: orders.id }).from(orders).where(and(eq(orders.shopId, shopId), eq(orders.status, "DELIVERED"))).limit(1);
  return { products: Boolean(p), sales: Boolean(o) };
}

/* ================================================================ the job */

export interface EscalationRunResult {
  skipped?: boolean;
  opened: number;
  escalated: number;
  resolved: number;
  checked: number;
}

/**
 * The hourly job (src/server/cron/schedule.ts → HOURLY "support-escalations"): opens what is missing (pay-later
 * requests waiting, v2 / v3 shops live for noSalesAfterDays without products or a sale), closes what cleared, and
 * moves the rest up the ladder. `now` is injectable for tests. Idempotent.
 */
export async function runSupportEscalations(now: Date = new Date()): Promise<EscalationRunResult> {
  const rule = await getRule("supportEscalation");
  if (!rule.enabled) return { skipped: true, opened: 0, escalated: 0, resolved: 0, checked: 0 };
  let opened = 0;
  let escalated = 0;
  let resolved = 0;

  // 1. Pay-later requests still waiting without an escalation (safety net; normally opened with the request).
  const waiting = await db
    .select({ r: shopFeePayLater, shopName: shops.name })
    .from(shopFeePayLater)
    .leftJoin(shops, eq(shops.id, shopFeePayLater.shopId))
    .where(
      and(
        eq(shopFeePayLater.status, "REQUESTED"),
        notExists(db.select({ x: sql`1` }).from(supportEscalations).where(and(eq(supportEscalations.kind, "FEE_PAY_LATER"), eq(supportEscalations.subjectId, shopFeePayLater.id)))),
      ),
    )
    .limit(200);
  for (const { r, shopName } of waiting) {
    if (await openPayLaterEscalation(r, shopName ?? "your shop").catch((error: unknown) => (console.error("[support-escalations] pay-later open failed", r.id, error), null))) opened += 1;
  }

  // 2. v2 / v3 shops live for noSalesAfterDays with no product listed or no sale yet (once per shop).
  // DEFAULT – confirm with Sanjay: only shops from an onboarding v2 / v3 registration (not every older live shop).
  const liveBefore = new Date(now.getTime() - rule.noSalesAfterDays * DAY_MS);
  const candidates = await db
    .select({ id: shops.id, ownerId: shops.ownerId, name: shops.name, referralCodeId: shops.referralCodeId, approvedAt: shops.approvedAt })
    .from(shops)
    .where(
      and(
        eq(shops.status, "APPROVED"),
        isNull(shops.deletedAt),
        lte(shops.approvedAt, liveBefore),
        exists(
          db
            .select({ x: sql`1` })
            .from(shopRegistrationDrafts)
            .where(and(eq(shopRegistrationDrafts.shopId, shops.id), eq(shopRegistrationDrafts.flowVersion, "v2"), inArray(shopRegistrationDrafts.status, ["SUBMITTED", "COMPLETED"]))),
        ),
        notExists(db.select({ x: sql`1` }).from(supportEscalations).where(and(eq(supportEscalations.kind, "NO_PRODUCTS_OR_SALES"), eq(supportEscalations.subjectId, shops.id)))),
      ),
    )
    .orderBy(asc(shops.approvedAt))
    .limit(200);
  for (const s of candidates) {
    const progress = await sellingProgress(s.id);
    if (progress.products && progress.sales) continue;
    const missing = !progress.products && !progress.sales ? "no products listed and no sale" : !progress.products ? "no products listed" : "no sale";
    const days = Math.floor((now.getTime() - (s.approvedAt ?? now).getTime()) / DAY_MS);
    const row = await openEscalation({
      kind: "NO_PRODUCTS_OR_SALES",
      subjectId: s.id,
      shopId: s.id,
      ownerId: s.ownerId,
      reason: `Live for ${days} days with ${missing} yet.`,
      details: { days, missing, products: progress.products, sales: progress.sales },
      franchisee: await franchiseeForShop(s),
      openedAt: now,
    }).catch((error: unknown) => (console.error("[support-escalations] no-sales open failed", s.id, error), null));
    if (row) opened += 1;
  }

  // 3. Every open escalation: closed when its condition cleared, else moved up the ladder when due.
  const open = await db.select().from(supportEscalations).where(isNull(supportEscalations.resolvedAt)).orderBy(asc(supportEscalations.openedAt)).limit(1000);
  for (const e of open) {
    try {
      if (await autoResolve(e, now)) {
        resolved += 1;
        continue;
      }
      const due = levelDue(e.level, e.openedAt, now, rule);
      if (due === e.level) continue;
      const moved = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(supportEscalations)
          .set({ level: due, levelChangedAt: now, lastRemindedAt: now, updatedAt: now })
          .where(and(eq(supportEscalations.id, e.id), eq(supportEscalations.level, e.level), isNull(supportEscalations.resolvedAt)))
          .returning();
        if (!row) return null;
        await tx.insert(supportEscalationEvents).values({ escalationId: e.id, event: "ESCALATED", fromLevel: e.level, toLevel: due, note: `Not closed within ${due === "ADMIN" ? rule.adminDays : rule.franchiseeDays} days of opening.`, createdAt: now });
        await recordAudit(
          {
            action: AUDIT_ACTIONS.SUPPORT_ESCALATION_ESCALATED,
            entityType: e.shopId ? "shop" : "support_escalation",
            entityId: e.shopId ?? e.id,
            previousValue: { level: e.level, since: e.levelChangedAt.toISOString(), franchiseeDealerId: e.franchiseeDealerId },
            newValue: { escalationId: e.id, kind: e.kind, level: due, openedAt: e.openedAt.toISOString() },
          },
          tx,
        );
        return row;
      });
      if (!moved) continue;
      escalated += 1;
      await announce(moved, due, e.level);
    } catch (error) {
      console.error("[support-escalations] step failed", e.id, error);
    }
  }
  return { opened, escalated, resolved, checked: open.length };
}

/* ================================================================ decisions */

async function loadOpen(escalationId: string): Promise<SupportEscalation> {
  const [row] = await db.select().from(supportEscalations).where(eq(supportEscalations.id, escalationId));
  if (!row) throw notFound("Escalation");
  if (row.resolvedAt) throw conflict(`This item is already closed (${(row.resolution ?? "closed").toLowerCase()}).`);
  return row;
}

/**
 * May `actor` act on it? Admin / operator: always for a held shop and a no-sales task; a pay-later request once it
 * left the franchisee (fee-pay-later.ts checks that again). The franchisee: while it is at their level and after
 * (DEFAULT – confirm with Sanjay).
 */
export function canActOn(e: Pick<SupportEscalation, "kind" | "level" | "franchiseeUserId">, actor: EscalationActor): boolean {
  if (e.franchiseeUserId && actor.id === e.franchiseeUserId) return true;
  if (!isStaff(actor.role) || !can(actor.role, PERMISSIONS.SHOP_APPROVE)) return false;
  if (e.kind === "FEE_PAY_LATER") return e.level !== "FRANCHISEE" || !e.franchiseeUserId;
  return true;
}

/** An admin / operator / the franchisee decides a SHOP_REVIEW (approve, or reject with a reason). */
export async function decideHeldShop(
  escalationId: string,
  decision: "APPROVE" | "REJECT",
  note: string | null,
  actor: EscalationActor,
): Promise<{ escalation: SupportEscalation | null; shop: Shop }> {
  const e = await loadOpen(escalationId);
  if (e.kind !== "SHOP_REVIEW") throw conflict("This item is not a shop review.");
  if (!canActOn(e, actor)) throw forbidden("This shop is reviewed by the franchisee behind its referral code, an operator or an admin.");
  const reason = note?.trim().slice(0, 500) || null;
  if (decision === "REJECT" && !reason) throw validationFailed("Give a reason for the shop owner.", { fields: { note: "Required." } });
  const { approveShop, rejectShop } = await import("./shops");
  let shop: Shop;
  if (decision === "APPROVE") {
    const [current] = await db.select().from(shops).where(eq(shops.id, e.subjectId));
    if (!current) throw notFound("Shop");
    const rule = await getRule("sellerVerification");
    shop = await approveShop(e.subjectId, { classification: current.classification ?? rule.autoApproveClassification }, actor);
  } else {
    shop = await rejectShop(e.subjectId, reason!, actor);
  }
  // approveShop / rejectShop close the escalation; the note given here is kept on it.
  await resolveEscalationFor("SHOP_REVIEW", e.subjectId, decision === "APPROVE" ? "APPROVED" : "REJECTED", actor, reason);
  if (reason) await db.update(supportEscalations).set({ resolutionNote: reason }).where(eq(supportEscalations.id, e.id));
  const [escalation] = await db.select().from(supportEscalations).where(eq(supportEscalations.id, e.id));
  return { escalation: escalation ?? null, shop };
}

/** Pay-later from the escalation screens (operator / admin once escalated, or the franchisee): fee-pay-later decides. */
export async function decideEscalatedPayLater(escalationId: string, decision: "APPROVE" | "REJECT", note: string | null, actor: EscalationActor) {
  const e = await loadOpen(escalationId);
  if (e.kind !== "FEE_PAY_LATER") throw conflict("This item is not a pay-later request.");
  if (!canActOn(e, actor)) throw forbidden("This request is still with the franchisee behind the shop's referral code.");
  return (await import("./fee-pay-later")).decidePayLater(e.subjectId, decision, note, actor);
}

/** Staff close an item by hand with a note (e.g. a no-sales task the owner explained). */
export async function closeEscalation(escalationId: string, note: string | null, actor: EscalationActor): Promise<SupportEscalation> {
  const e = await loadOpen(escalationId);
  if (!isStaff(actor.role) || !can(actor.role, PERMISSIONS.SHOP_APPROVE)) throw forbidden("Only an operator or admin can close this item.");
  if (e.kind === "SHOP_REVIEW" || e.kind === "FEE_PAY_LATER") throw conflict("Approve or reject this item instead.");
  const reason = note?.trim().slice(0, 500) || null;
  if (!reason) throw validationFailed("Write why it is closed.", { fields: { note: "Required." } });
  const row = await resolveEscalationFor(e.kind, e.subjectId, "CLOSED", actor, reason);
  if (!row) throw conflict("This item is already closed.");
  return row;
}

/* ================================================================ lists */

export interface EscalationView {
  id: string;
  kind: SupportEscalationKind;
  kindLabel: string;
  level: SupportEscalationLevel;
  levelLabel: string;
  subjectId: string;
  shopId: string | null;
  shopName: string | null;
  shopStatus: string | null;
  registrationNumber: string | null;
  ownerName: string | null;
  ownerContact: string;
  franchiseeName: string | null;
  /** The franchisee's account (for the permission check on the screens). */
  franchiseeUserIdForChecks: string | null;
  reason: string | null;
  openedAt: Date;
  levelChangedAt: Date;
  nextStepAt: Date | null;
  resolvedAt: Date | null;
  resolution: SupportEscalationResolution | null;
  resolutionNote: string | null;
  events: { event: string; fromLevel: string | null; toLevel: string | null; note: string | null; at: Date; actorName: string | null }[];
}

/**
 * Staff: every escalation (open by default), optionally one level. A franchisee (`franchiseeUserId`): only theirs —
 * still open, at whatever level.
 */
export async function listEscalations(filter: { level?: SupportEscalationLevel | "ALL"; open?: boolean; franchiseeUserId?: string; limit?: number } = {}): Promise<EscalationView[]> {
  const rule = await getRule("supportEscalation");
  const where = and(
    filter.open === false ? undefined : isNull(supportEscalations.resolvedAt),
    filter.level && filter.level !== "ALL" ? eq(supportEscalations.level, filter.level) : undefined,
    filter.franchiseeUserId ? eq(supportEscalations.franchiseeUserId, filter.franchiseeUserId) : undefined,
  );
  const rows = await db
    .select({ e: supportEscalations, shopName: shops.name, shopStatus: shops.status, registrationNumber: shops.registrationNumber, ownerName: users.name, ownerEmail: users.email, ownerPhone: users.phoneE164, franchiseeName: dealers.legalName })
    .from(supportEscalations)
    .leftJoin(shops, eq(shops.id, supportEscalations.shopId))
    .leftJoin(users, eq(users.id, supportEscalations.ownerId))
    .leftJoin(dealers, eq(dealers.id, supportEscalations.franchiseeDealerId))
    .where(where)
    .orderBy(filter.open === false ? desc(supportEscalations.openedAt) : asc(supportEscalations.openedAt))
    .limit(filter.limit ?? 300);
  const ids = rows.map((r) => r.e.id);
  const events = ids.length
    ? await db
        .select({ ev: supportEscalationEvents, actorName: users.name, actorEmail: users.email })
        .from(supportEscalationEvents)
        .leftJoin(users, eq(users.id, supportEscalationEvents.actorId))
        .where(inArray(supportEscalationEvents.escalationId, ids))
        .orderBy(asc(supportEscalationEvents.createdAt))
    : [];
  return rows.map(({ e, shopName, shopStatus, registrationNumber, ownerName, ownerEmail, ownerPhone, franchiseeName }) => ({
    id: e.id,
    kind: e.kind,
    kindLabel: KIND_LABEL[e.kind],
    level: e.level,
    levelLabel: LEVEL_LABEL[e.level],
    subjectId: e.subjectId,
    shopId: e.shopId,
    shopName: shopName ?? (typeof e.details?.shopName === "string" ? e.details.shopName : null),
    shopStatus,
    registrationNumber,
    ownerName: ownerName ?? ownerEmail,
    ownerContact: [ownerPhone, ownerEmail].filter(Boolean).join(" · "),
    franchiseeName: e.franchiseeDealerId ? franchiseeName : null,
    franchiseeUserIdForChecks: e.franchiseeUserId,
    reason: e.reason,
    openedAt: e.openedAt,
    levelChangedAt: e.levelChangedAt,
    nextStepAt: e.resolvedAt ? null : nextStepAt(e, rule),
    resolvedAt: e.resolvedAt,
    resolution: e.resolution,
    resolutionNote: e.resolutionNote,
    events: events
      .filter((x) => x.ev.escalationId === e.id)
      .map((x) => ({ event: x.ev.event, fromLevel: x.ev.fromLevel, toLevel: x.ev.toLevel, note: x.ev.note, at: x.ev.createdAt, actorName: x.ev.actorId ? (x.actorName ?? x.actorEmail) : null })),
  }));
}

/** Open items per level (staff screens) — and, with `franchiseeUserId`, the franchisee's open items. */
export async function countOpenEscalations(franchiseeUserId?: string): Promise<Record<SupportEscalationLevel, number> & { total: number }> {
  const rows = await db
    .select({ level: supportEscalations.level, n: sql<number>`count(*)::int` })
    .from(supportEscalations)
    .where(and(isNull(supportEscalations.resolvedAt), franchiseeUserId ? eq(supportEscalations.franchiseeUserId, franchiseeUserId) : undefined))
    .groupBy(supportEscalations.level);
  const out = { FRANCHISEE: 0, OPERATOR: 0, ADMIN: 0, total: 0 };
  for (const r of rows) {
    out[r.level] = Number(r.n);
    out.total += Number(r.n);
  }
  return out;
}

/* ================================================================ review flags */

/** Records the v2 / v3 review flags of a shop (one open flag per kind). Never a hold. */
export async function recordReviewFlags(shopId: string, flags: { flag: ShopReviewFlagType; details: Record<string, unknown> }[]): Promise<number> {
  let added = 0;
  for (const f of flags) {
    const [row] = await db.insert(shopReviewFlags).values({ shopId, flag: f.flag, details: f.details }).onConflictDoNothing().returning();
    if (!row) continue;
    added += 1;
    await recordAudit({ action: AUDIT_ACTIONS.SHOP_REVIEW_FLAG_RAISED, entityType: "shop", entityId: shopId, newValue: { flagId: row.id, flag: f.flag, details: f.details } });
  }
  return added;
}

export const REVIEW_FLAG_LABEL: Record<ShopReviewFlagType, string> = {
  NAME_MATCH_LOW: "Name on the GST / PAN record does not match well",
  NAME_NOT_RETURNED: "The government source returned no name",
  PAN_NOT_IN_GSTIN: "PAN is not the one inside the GSTIN",
};

export interface ReviewFlagView {
  id: string;
  shopId: string;
  shopName: string | null;
  shopStatus: string | null;
  registrationNumber: string | null;
  flag: ShopReviewFlagType;
  label: string;
  details: Record<string, unknown>;
  createdAt: Date;
}

export async function listOpenReviewFlags(limit = 200): Promise<ReviewFlagView[]> {
  const rows = await db
    .select({ f: shopReviewFlags, shopName: shops.name, shopStatus: shops.status, registrationNumber: shops.registrationNumber })
    .from(shopReviewFlags)
    .leftJoin(shops, eq(shops.id, shopReviewFlags.shopId))
    .where(isNull(shopReviewFlags.resolvedAt))
    .orderBy(desc(shopReviewFlags.createdAt))
    .limit(limit);
  return rows.map(({ f, shopName, shopStatus, registrationNumber }) => ({
    id: f.id,
    shopId: f.shopId,
    shopName,
    shopStatus,
    registrationNumber,
    flag: f.flag,
    label: REVIEW_FLAG_LABEL[f.flag],
    details: f.details,
    createdAt: f.createdAt,
  }));
}

/** Admin / operator: the flag was looked at (with a note). */
export async function resolveReviewFlag(flagId: string, note: string | null, actor: EscalationActor): Promise<void> {
  if (!isStaff(actor.role) || !can(actor.role, PERMISSIONS.SHOP_APPROVE)) throw forbidden("Only an operator or admin can clear a review flag.");
  const reason = note?.trim().slice(0, 500) || null;
  if (!reason) throw validationFailed("Write what was checked.", { fields: { note: "Required." } });
  const now = new Date();
  const [row] = await db
    .update(shopReviewFlags)
    .set({ resolvedAt: now, resolvedBy: actor.id, resolutionNote: reason })
    .where(and(eq(shopReviewFlags.id, flagId), isNull(shopReviewFlags.resolvedAt)))
    .returning();
  if (!row) throw conflict("This flag is already cleared.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SHOP_REVIEW_FLAG_RESOLVED, entityType: "shop", entityId: row.shopId, newValue: { flagId, flag: row.flag, note: reason } });
}

/* ================================================================ screens */

const ist = (d: Date | null) =>
  d ? d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).replace(":", ".") : null;

const EVENT_LABEL: Record<string, string> = { OPENED: "Opened", ESCALATED: "Moved", REMINDED: "Reminded", RESOLVED: "Closed" };

/** The rows of SupportEscalationsTable for this viewer (plain, IST-formatted). */
export function escalationTableRows(views: EscalationView[], viewer: EscalationActor) {
  return views.map((v) => {
    const open = v.resolvedAt === null;
    const actsOn = open && canActOn({ kind: v.kind, level: v.level, franchiseeUserId: v.franchiseeUserIdForChecks ?? null }, viewer);
    return {
      id: v.id,
      kind: v.kind,
      kindLabel: v.kindLabel,
      level: v.level,
      levelLabel: v.levelLabel,
      shopId: v.shopId,
      shopName: v.shopName,
      registrationNumber: v.registrationNumber,
      shopStatus: v.shopStatus,
      owner: v.ownerName ?? "—",
      ownerContact: v.ownerContact,
      franchisee: v.franchiseeName,
      reason: v.reason,
      openedAt: ist(v.openedAt)!,
      nextStepAt: ist(v.nextStepAt),
      resolution: v.resolution,
      resolutionNote: v.resolutionNote,
      history: v.events.map(
        (e) =>
          `${ist(e.at)} — ${EVENT_LABEL[e.event] ?? e.event}${e.fromLevel && e.toLevel ? ` ${LEVEL_LABEL[e.fromLevel as SupportEscalationLevel]} → ${LEVEL_LABEL[e.toLevel as SupportEscalationLevel]}` : e.toLevel ? ` (${LEVEL_LABEL[e.toLevel as SupportEscalationLevel]})` : ""}${e.actorName ? ` by ${e.actorName}` : ""}${e.note ? `: ${e.note}` : ""}`,
      ),
      canDecide: actsOn && v.kind !== "NO_PRODUCTS_OR_SALES",
      canClose: open && v.kind === "NO_PRODUCTS_OR_SALES" && isStaff(viewer.role) && can(viewer.role, PERMISSIONS.SHOP_APPROVE),
    };
  });
}

export function reviewFlagTableRows(views: ReviewFlagView[]) {
  return views.map((f) => ({ id: f.id, shopId: f.shopId, shopName: f.shopName, registrationNumber: f.registrationNumber, label: f.label, createdAt: ist(f.createdAt)! }));
}
