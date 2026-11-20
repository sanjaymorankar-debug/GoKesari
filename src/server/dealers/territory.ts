/**
 * Territory dealers (owner, 20-Nov-2026; docs/dealer-programme/TERRITORY_DEALER.md).
 *
 * An admin gives a TIERED dealer an exclusive territory: a set of pincodes that
 * no other territory holds at the same time (a unique index while not
 * released), for a yearly fee (GST included). The dealer pays it online
 * (payment intent TERRITORY_FEE) or an admin records it; each fee paid extends
 * the territory by termMonths. Unpaid, it expires; after graceDays its pincodes
 * are released for another dealer.
 *
 * The dealer keeps his team's TIERED registration commission and also earns a
 * share of GoKesari's commission on every order delivered by a shop in his
 * territory while it is paid up: the commission GoKesari kept (net of the
 * commission on refunded goods) × the share of the delivery day. The share
 * follows a daily performance rating (shop onboarding + product-upload
 * support; src/lib/territory-dealers.ts). It is worked out per order when the
 * month closes (one TERRITORY ledger entry per territory and month, paid on the
 * payout day) and a refund recorded later is taken back at a later close.
 *
 * Rule territoryDealer off: no territory can be given or paid and nothing is
 * worked out.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { PINCODE, commissionOnPaise, orderSharePaise, territoryRating, territoryShareBp, type TerritoryStatus } from "@/lib/territory-dealers";
import { db, type DbClient } from "@/server/db";
import {
  dealerCommissionLedger,
  dealerExclusiveTerritories,
  dealerTerritoryFees,
  dealerTerritoryOrderShares,
  dealerTerritoryPincodes,
  dealerTerritoryRatings,
  dealers,
  financialAdjustments,
  orderFinancials,
  shopProducts,
  shops,
  users,
  type DealerCommissionEntry,
  type DealerExclusiveTerritory,
  type DealerTerritoryFee,
  type UserRole,
} from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import type { PaymentIntentRef } from "@/server/payments/intents";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { addMonths } from "@/server/services/shop-membership";
import { writeEntry } from "./tiered";

interface Actor {
  id: string;
  role: UserRole;
}

export type TerritoryRule = Awaited<ReturnType<typeof territoryRule>>;
export const territoryRule = () => getRule("territoryDealer");

const DAY = 86_400_000;
const IST_OFFSET = 5.5 * 3_600_000;
/** How long before the paid-up date the renewal fee can be paid (and the dealer is reminded). */
export const RENEWAL_WINDOW_DAYS = 30;

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** The IST calendar date of an instant, "YYYY-MM-DD". */
export function istDay(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET).toISOString().slice(0, 10);
}

function requireAdmin(actor: Actor, what: string) {
  if (actor.role !== "ADMIN") throw forbidden(`Only an admin can ${what}.`);
}

function requireReason(reason: string | null | undefined, min = 5): string {
  const r = (reason ?? "").trim();
  if (r.length < min) throw validationFailed("Give the reason for the change (it is kept in the audit log).", { fields: { reason: "Required." } });
  return r.slice(0, 500);
}

async function requireOn(): Promise<TerritoryRule> {
  const rule = await territoryRule();
  if (!rule.enabled) throw conflict("Territory dealers are switched off (Admin → Settings → territoryDealer).");
  return rule;
}

function checkPincodes(pincodes: string[]): string[] {
  const unique = [...new Set(pincodes.map((p) => p.trim()))].sort();
  const bad = unique.filter((p) => !PINCODE.test(p));
  if (bad.length) throw validationFailed(`These are not 6-digit pincodes: ${bad.join(", ")}.`, { fields: { pincodes: "6 digits each." } });
  if (unique.length === 0) throw validationFailed("Give at least one pincode.", { fields: { pincodes: "Required." } });
  if (unique.length > 500) throw validationFailed("At most 500 pincodes in one territory.", { fields: { pincodes: "Too many." } });
  return unique;
}

function checkFee(feePaise: number): number {
  if (!Number.isInteger(feePaise) || feePaise < 100 || feePaise > 1_000_000_000) {
    throw validationFailed("Give the yearly fee in rupees (at least ₹1).", { fields: { feePaise: "Required." } });
  }
  return feePaise;
}

/** Refuses pincodes another territory holds now, naming them and the holder. */
async function assertFree(tx: DbClient, pincodes: string[], exceptTerritoryId: string | null): Promise<void> {
  if (pincodes.length === 0) return;
  const held = await tx
    .select({ pincode: dealerTerritoryPincodes.pincode, territoryId: dealerTerritoryPincodes.territoryId, name: dealerExclusiveTerritories.name, dealer: dealers.legalName })
    .from(dealerTerritoryPincodes)
    .innerJoin(dealerExclusiveTerritories, eq(dealerExclusiveTerritories.id, dealerTerritoryPincodes.territoryId))
    .innerJoin(dealers, eq(dealers.id, dealerExclusiveTerritories.dealerId))
    .where(and(inArray(dealerTerritoryPincodes.pincode, pincodes), isNull(dealerTerritoryPincodes.releasedAt)));
  const others = held.filter((h) => h.territoryId !== exceptTerritoryId);
  if (others.length) {
    throw conflict(`Already held by another territory: ${others.map((h) => `${h.pincode} (${h.dealer}, ${h.name})`).join("; ")}.`, { fields: { pincodes: "Held." } });
  }
}

async function tellDealer(dealerId: string, territory: string, headline: string, message: string, dedupeKey: string, client: DbClient = db): Promise<void> {
  const [d] = await client.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, dealerId));
  if (!d?.userId) return;
  await notify(
    { userId: d.userId, type: NOTIFICATION_TYPES.DEALER_TERRITORY_CHANGED, vars: { territory, headline, message }, actionUrl: "/dealer", channels: ["PUSH"], dedupeKey },
    client,
  );
}

/** The open (unpaid) fee row of a territory, made when there is none. */
async function ensureOpenFee(tx: DbClient, territory: DealerExclusiveTerritory): Promise<DealerTerritoryFee> {
  const [open] = await tx
    .select()
    .from(dealerTerritoryFees)
    .where(and(eq(dealerTerritoryFees.territoryId, territory.id), eq(dealerTerritoryFees.status, "AWAITING_PAYMENT")));
  if (open) return open;
  const [created] = await tx.insert(dealerTerritoryFees).values({ territoryId: territory.id, amountPaise: territory.feePaise }).returning();
  return created;
}

/* ============================================================ admin: give */

export interface CreateTerritoryInput {
  dealerId: string;
  name: string;
  pincodes: string[];
  feePaise: number;
}

/** ADMIN: gives a TIERED dealer a territory. It is his, waiting for the first fee, from now. */
export async function createTerritory(input: CreateTerritoryInput, actor: Actor): Promise<DealerExclusiveTerritory> {
  requireAdmin(actor, "give a dealer a territory");
  await requireOn();
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 120);
  if (name.length < 2) throw validationFailed("Give the territory a name.", { fields: { name: "Required." } });
  const pincodes = checkPincodes(input.pincodes);
  const feePaise = checkFee(input.feePaise);
  const created = await db.transaction(async (tx) => {
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, input.dealerId)).for("update");
    if (!dealer) throw notFound("Dealer");
    if (dealer.status !== "APPROVED") throw conflict("Only an approved dealer can be given a territory.");
    if (dealer.isInternal) throw conflict("GoKesari's own dealer record cannot hold a territory.");
    if (dealer.commissionModel !== "TIERED") throw conflict("Move this dealer to the TIERED model first: a territory dealer keeps the TIERED team and its commission.");
    // Serialises givers of the same pincodes: the unique index is the real guard, this gives the clear message.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('dealer-territory-pincodes'))`);
    await assertFree(tx, pincodes, null);
    const [territory] = await tx.insert(dealerExclusiveTerritories).values({ dealerId: dealer.id, name, feePaise, createdBy: actor.id }).returning();
    await tx.insert(dealerTerritoryPincodes).values(pincodes.map((pincode) => ({ territoryId: territory.id, pincode })));
    await tx.insert(dealerTerritoryFees).values({ territoryId: territory.id, amountPaise: feePaise });
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_TERRITORY_CHANGED, entityType: "dealer_territory", entityId: territory.id, newValue: { created: true, dealerId: dealer.id, name, pincodes, feePaise } },
      tx,
    );
    return territory;
  });
  await tellDealer(
    created.dealerId,
    created.name,
    "given to you",
    `GoKesari has given you the territory ${created.name} (${pincodes.length} pincode${pincodes.length === 1 ? "" : "s"}). Pay the yearly fee of ${rupees(feePaise)} on your dealer page to start earning on every order there.`,
    `territory-created:${created.id}`,
  );
  return created;
}

/** ADMIN: adds and releases pincodes of a territory that is not cancelled. */
export async function changeTerritoryPincodes(territoryId: string, input: { add: string[]; remove: string[]; reason: string }, actor: Actor): Promise<{ added: string[]; removed: string[] }> {
  requireAdmin(actor, "change a territory");
  await requireOn();
  const reason = requireReason(input.reason);
  const add = input.add.length ? checkPincodes(input.add) : [];
  const remove = [...new Set(input.remove.map((p) => p.trim()))];
  if (add.length === 0 && remove.length === 0) throw validationFailed("Give pincodes to add or remove.");
  const out = await db.transaction(async (tx) => {
    const [territory] = await tx.select().from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.id, territoryId)).for("update");
    if (!territory) throw notFound("Territory");
    if (territory.status === "CANCELLED") throw conflict("This territory is cancelled.");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('dealer-territory-pincodes'))`);
    const current = (await tx.select().from(dealerTerritoryPincodes).where(and(eq(dealerTerritoryPincodes.territoryId, territoryId), isNull(dealerTerritoryPincodes.releasedAt)))).map((p) => p.pincode);
    const toAdd = add.filter((p) => !current.includes(p));
    const toRemove = remove.filter((p) => current.includes(p));
    if (current.length + toAdd.length - toRemove.length < 1) throw conflict("A territory keeps at least one pincode; cancel it instead.");
    await assertFree(tx, toAdd, territoryId);
    const now = new Date();
    if (toAdd.length) await tx.insert(dealerTerritoryPincodes).values(toAdd.map((pincode) => ({ territoryId, pincode, heldFrom: now })));
    if (toRemove.length) {
      await tx
        .update(dealerTerritoryPincodes)
        .set({ releasedAt: now })
        .where(and(eq(dealerTerritoryPincodes.territoryId, territoryId), inArray(dealerTerritoryPincodes.pincode, toRemove), isNull(dealerTerritoryPincodes.releasedAt)));
    }
    await tx.update(dealerExclusiveTerritories).set({ updatedAt: now }).where(eq(dealerExclusiveTerritories.id, territoryId));
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_TERRITORY_CHANGED, entityType: "dealer_territory", entityId: territoryId, previousValue: { pincodes: current }, newValue: { added: toAdd, removed: toRemove, reason } },
      tx,
    );
    return { territory, added: toAdd, removed: toRemove };
  });
  if (out.added.length || out.removed.length) {
    const parts = [out.added.length ? `added ${out.added.join(", ")}` : "", out.removed.length ? `removed ${out.removed.join(", ")}` : ""].filter(Boolean).join("; ");
    await tellDealer(out.territory.dealerId, out.territory.name, "pincodes changed", `Pincodes ${parts}. Orders in a pincode count from the day it was added.`, `territory-pincodes:${territoryId}:${Date.now()}`);
  }
  return { added: out.added, removed: out.removed };
}

/** ADMIN: the yearly fee for the next payment (an unpaid fee is re-priced; one already being paid online is cancelled and a new one made). */
export async function setTerritoryFee(territoryId: string, feePaise: number, reason: string, actor: Actor): Promise<DealerExclusiveTerritory> {
  requireAdmin(actor, "change a territory fee");
  const why = requireReason(reason);
  const fee = checkFee(feePaise);
  return db.transaction(async (tx) => {
    const [territory] = await tx.select().from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.id, territoryId)).for("update");
    if (!territory) throw notFound("Territory");
    if (territory.status === "CANCELLED") throw conflict("This territory is cancelled.");
    const [after] = await tx.update(dealerExclusiveTerritories).set({ feePaise: fee, updatedAt: new Date() }).where(eq(dealerExclusiveTerritories.id, territoryId)).returning();
    const [open] = await tx.select().from(dealerTerritoryFees).where(and(eq(dealerTerritoryFees.territoryId, territoryId), eq(dealerTerritoryFees.status, "AWAITING_PAYMENT"))).for("update");
    if (open && open.amountPaise !== fee) {
      if (open.paymentIntentId) {
        await tx.update(dealerTerritoryFees).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(dealerTerritoryFees.id, open.id));
        await tx.insert(dealerTerritoryFees).values({ territoryId, amountPaise: fee });
      } else {
        await tx.update(dealerTerritoryFees).set({ amountPaise: fee, updatedAt: new Date() }).where(eq(dealerTerritoryFees.id, open.id));
      }
    }
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_TERRITORY_CHANGED, entityType: "dealer_territory", entityId: territoryId, previousValue: { feePaise: territory.feePaise }, newValue: { feePaise: fee, reason: why } },
      tx,
    );
    return after;
  });
}

/** ADMIN: ends a territory now and releases its pincodes. Order income already worked out stays. */
export async function cancelTerritory(territoryId: string, reason: string, actor: Actor): Promise<DealerExclusiveTerritory> {
  requireAdmin(actor, "cancel a territory");
  const why = requireReason(reason);
  const after = await db.transaction(async (tx) => {
    const [territory] = await tx.select().from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.id, territoryId)).for("update");
    if (!territory) throw notFound("Territory");
    if (territory.status === "CANCELLED") throw conflict("This territory is already cancelled.");
    const now = new Date();
    await tx.update(dealerTerritoryPincodes).set({ releasedAt: now }).where(and(eq(dealerTerritoryPincodes.territoryId, territoryId), isNull(dealerTerritoryPincodes.releasedAt)));
    await tx.update(dealerTerritoryFees).set({ status: "CANCELLED", updatedAt: now }).where(and(eq(dealerTerritoryFees.territoryId, territoryId), eq(dealerTerritoryFees.status, "AWAITING_PAYMENT")));
    const [row] = await tx
      .update(dealerExclusiveTerritories)
      .set({ status: "CANCELLED", endedAt: now, endReason: why, updatedAt: now })
      .where(eq(dealerExclusiveTerritories.id, territoryId))
      .returning();
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_TERRITORY_CHANGED, entityType: "dealer_territory", entityId: territoryId, previousValue: { status: territory.status }, newValue: { status: "CANCELLED", reason: why } },
      tx,
    );
    return row;
  });
  await tellDealer(after.dealerId, after.name, "cancelled", `GoKesari cancelled your territory ${after.name}: ${why}. Order income already earned is still paid.`, `territory-cancelled:${territoryId}`);
  return after;
}

/* ================================================================== fees */

/**
 * A fee is paid (online capture or an admin's record): the territory is paid
 * up for termMonths more — from its paid-up date while that is still ahead,
 * otherwise from now. Call inside a transaction. Returns null when the fee was
 * not waiting for payment (a second webhook).
 */
async function markFeePaid(tx: DbClient, feeId: string, method: "ONLINE" | "OFFLINE", extra: { intentId?: string; reference?: string; actor?: Actor | null }, rule: TerritoryRule): Promise<{ territory: DealerExclusiveTerritory; fee: DealerTerritoryFee } | null> {
  const [fee] = await tx.select().from(dealerTerritoryFees).where(eq(dealerTerritoryFees.id, feeId)).for("update");
  if (!fee || fee.status !== "AWAITING_PAYMENT") return null;
  const [territory] = await tx.select().from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.id, fee.territoryId)).for("update");
  if (!territory || territory.status === "CANCELLED") return null;
  const held = await tx.select({ n: sql<number>`count(*)::int` }).from(dealerTerritoryPincodes).where(and(eq(dealerTerritoryPincodes.territoryId, territory.id), isNull(dealerTerritoryPincodes.releasedAt)));
  if ((held[0]?.n ?? 0) === 0) {
    // Its pincodes were released after the grace period: nothing to pay for (an online payment is refunded by finance).
    await recordAudit({ actorId: extra.actor?.id ?? null, actorRole: extra.actor?.role ?? null, action: AUDIT_ACTIONS.DEALER_TERRITORY_FEE_PAID, entityType: "dealer_territory", entityId: territory.id, newValue: { problem: "pincodes_released", feeId: fee.id, intentId: extra.intentId ?? null } }, tx);
    return null;
  }
  const now = new Date();
  const start = territory.paidUntil && territory.paidUntil.getTime() > now.getTime() ? territory.paidUntil : now;
  const end = addMonths(start, rule.termMonths);
  const [paid] = await tx
    .update(dealerTerritoryFees)
    .set({ status: "PAID", method, paymentIntentId: extra.intentId ?? fee.paymentIntentId, reference: extra.reference ?? null, periodStart: start, periodEnd: end, paidAt: now, recordedBy: extra.actor?.id ?? null, updatedAt: now })
    .where(eq(dealerTerritoryFees.id, fee.id))
    .returning();
  const [after] = await tx
    .update(dealerExclusiveTerritories)
    .set({ status: "ACTIVE", paidUntil: end, activatedAt: territory.activatedAt ?? now, endedAt: null, endReason: null, updatedAt: now })
    .where(eq(dealerExclusiveTerritories.id, territory.id))
    .returning();
  await recordAudit(
    {
      actorId: extra.actor?.id ?? null,
      actorRole: extra.actor?.role ?? null,
      action: AUDIT_ACTIONS.DEALER_TERRITORY_FEE_PAID,
      entityType: "dealer_territory",
      entityId: territory.id,
      previousValue: { status: territory.status, paidUntil: territory.paidUntil },
      newValue: { feeId: fee.id, method, amountPaise: fee.amountPaise, intentId: extra.intentId ?? null, reference: extra.reference ?? null, periodStart: start, periodEnd: end },
    },
    tx,
  );
  return { territory: after, fee: paid };
}

async function tellPaid(territory: DealerExclusiveTerritory, fee: DealerTerritoryFee): Promise<void> {
  await tellDealer(
    territory.dealerId,
    territory.name,
    "fee received",
    `We received ${rupees(fee.amountPaise)} for ${territory.name}. It is yours until ${istDay(new Date(territory.paidUntil!.getTime() - 1))}; you earn on every order delivered there.`,
    `territory-paid:${fee.id}`,
  );
}

/** ADMIN: records a fee paid outside the website (bank transfer, cheque) with its reference. */
export async function recordOfflineFee(territoryId: string, input: { reference: string }, actor: Actor): Promise<DealerExclusiveTerritory> {
  requireAdmin(actor, "record a territory fee");
  const rule = await requireOn();
  const reference = (input.reference ?? "").trim().slice(0, 120);
  if (reference.length < 3) throw validationFailed("Give the payment reference (UTR, cheque number…).", { fields: { reference: "Required." } });
  const result = await db.transaction(async (tx) => {
    const [territory] = await tx.select().from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.id, territoryId)).for("update");
    if (!territory) throw notFound("Territory");
    if (territory.status === "CANCELLED") throw conflict("This territory is cancelled.");
    const open = await ensureOpenFee(tx, territory);
    if (open.paymentIntentId) {
      // An online checkout was started: it can no longer complete this fee.
      await tx.update(dealerTerritoryFees).set({ paymentIntentId: null, updatedAt: new Date() }).where(eq(dealerTerritoryFees.id, open.id));
    }
    const done = await markFeePaid(tx, open.id, "OFFLINE", { reference, actor }, rule);
    if (!done) throw conflict("This fee could not be recorded: the territory's pincodes were released after the grace period. Give the territory again instead.");
    return done;
  });
  await tellPaid(result.territory, result.fee);
  return result.territory;
}

/** The territory's own dealer, signed in. */
async function ownTerritory(territoryId: string, actor: Actor): Promise<DealerExclusiveTerritory> {
  const [row] = await db
    .select({ t: dealerExclusiveTerritories, userId: dealers.userId })
    .from(dealerExclusiveTerritories)
    .innerJoin(dealers, eq(dealers.id, dealerExclusiveTerritories.dealerId))
    .where(eq(dealerExclusiveTerritories.id, territoryId));
  if (!row || row.userId !== actor.id) throw notFound("Territory");
  return row.t;
}

/** Whether the dealer may pay now: the first fee, a renewal within RENEWAL_WINDOW_DAYS, or an expired one still holding its pincodes. */
export function canPayNow(t: Pick<DealerExclusiveTerritory, "status" | "paidUntil">, now: Date = new Date(), heldPincodes = 1): boolean {
  if (t.status === "CANCELLED" || heldPincodes === 0) return false;
  if (t.status === "AWAITING_FEE" || t.status === "EXPIRED") return true;
  return !t.paidUntil || t.paidUntil.getTime() - now.getTime() <= RENEWAL_WINDOW_DAYS * DAY;
}

/** The dealer pays the fee online: a gateway checkout; the territory is paid up only when the signed webhook confirms it. */
export async function payTerritoryFeeOnline(territoryId: string, actor: Actor) {
  await requireOn();
  const territory = await ownTerritory(territoryId, actor);
  const [{ n: heldNow }] = await db.select({ n: sql<number>`count(*)::int` }).from(dealerTerritoryPincodes).where(and(eq(dealerTerritoryPincodes.territoryId, territoryId), isNull(dealerTerritoryPincodes.releasedAt)));
  if (heldNow === 0) throw conflict("This territory's pincodes were released after the grace period; ask GoKesari to give it again.");
  if (!canPayNow(territory)) throw conflict(territory.status === "CANCELLED" ? "This territory is cancelled." : `The renewal can be paid from ${RENEWAL_WINDOW_DAYS} days before the paid-up date.`);
  const fee = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.id, territoryId)).for("update");
    return ensureOpenFee(tx, locked);
  });
  const [u] = await db.select({ name: users.name, email: users.email, phone: users.phone }).from(users).where(eq(users.id, actor.id));
  const { createPaymentIntent } = await import("@/server/payments/intents");
  const created = await createPaymentIntent({
    purpose: "TERRITORY_FEE",
    referenceId: fee.id,
    userId: actor.id,
    amountPaise: fee.amountPaise,
    customer: { id: actor.id, name: u?.name ?? null, email: u?.email ?? null, phone: u?.phone ?? null },
    description: `GoKesari territory fee — ${territory.name}`,
    idempotencyKey: `territory-fee:${fee.id}`,
    mode: "CHECKOUT",
    returnPath: "/dealer",
  });
  await db.update(dealerTerritoryFees).set({ paymentIntentId: created.intent.id, updatedAt: new Date() }).where(and(eq(dealerTerritoryFees.id, fee.id), eq(dealerTerritoryFees.status, "AWAITING_PAYMENT")));
  return created;
}

/** Purpose handler (inside the capture transaction): the fee is paid when the amount is right. */
export async function onTerritoryFeeCaptured(intent: PaymentIntentRef, client: DbClient, afterCommit?: (task: () => Promise<void>) => void): Promise<void> {
  const [fee] = await client.select().from(dealerTerritoryFees).where(eq(dealerTerritoryFees.id, intent.referenceId));
  if (!fee || fee.status !== "AWAITING_PAYMENT") return;
  if (intent.amountPaise !== fee.amountPaise || (fee.paymentIntentId && fee.paymentIntentId !== intent.id)) {
    await recordAudit(
      { action: AUDIT_ACTIONS.DEALER_TERRITORY_FEE_PAID, entityType: "dealer_territory", entityId: fee.territoryId, newValue: { problem: "amount_or_intent_mismatch", feeId: fee.id, intentId: intent.id, intentAmount: intent.amountPaise, feePaise: fee.amountPaise } },
      client,
    );
    return;
  }
  const rule = await territoryRule();
  const done = await markFeePaid(client, fee.id, "ONLINE", { intentId: intent.id }, rule);
  if (!done) return;
  const after = async () => {
    await tellPaid(done.territory, done.fee).catch((e) => console.error("[territory] fee notice failed", fee.id, e));
  };
  if (client === db) await after();
  else if (afterCommit) afterCommit(after);
  else setTimeout(() => void after(), 2_000).unref?.();
}

/* ============================================================= the rating */

/** Approved shops in the held pincodes of a territory, and how many have at least `minProducts` active products. */
async function territoryShopCounts(client: DbClient, territoryId: string, minProducts: number): Promise<{ total: number; live: number }> {
  const [r] = await client.execute<{ total: number; live: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where coalesce(p.n, 0) >= ${minProducts})::int as live
    from ${shops} s
    join ${dealerTerritoryPincodes} tp on tp.pincode = s.pincode and tp.territory_id = ${territoryId} and tp.released_at is null
    left join lateral (select count(*)::int as n from ${shopProducts} sp where sp.shop_id = s.id and sp.is_active) p on true
    where s.status = 'APPROVED'
  `);
  return { total: Number(r?.total ?? 0), live: Number(r?.live ?? 0) };
}

/** Works out and stores today's rating and share of one territory. */
export async function rateTerritory(territoryId: string, now: Date = new Date(), client: DbClient = db): Promise<{ rating: number; shareBp: number }> {
  const rule = await territoryRule();
  const [t] = await client
    .select({ t: dealerExclusiveTerritories, dealerRating: dealers.rating })
    .from(dealerExclusiveTerritories)
    .innerJoin(dealers, eq(dealers.id, dealerExclusiveTerritories.dealerId))
    .where(eq(dealerExclusiveTerritories.id, territoryId));
  if (!t) throw notFound("Territory");
  const counts = await territoryShopCounts(client, territoryId, rule.liveMinProducts);
  const r = territoryRating({ onboardingRating: t.dealerRating, shopsTotal: counts.total, shopsLive: counts.live, productWeightBp: rule.productWeightBp });
  const shareBp = territoryShareBp(r.rating, rule);
  const day = istDay(now);
  await client
    .insert(dealerTerritoryRatings)
    .values({ territoryId, day, onboardingRating: Math.min(10, Math.max(0, t.dealerRating)), shopsTotal: counts.total, shopsLive: counts.live, onboardingPoints: r.onboardingPoints, productPoints: r.productPoints, rating: r.rating, shareBp })
    .onConflictDoUpdate({
      target: [dealerTerritoryRatings.territoryId, dealerTerritoryRatings.day],
      set: { onboardingRating: Math.min(10, Math.max(0, t.dealerRating)), shopsTotal: counts.total, shopsLive: counts.live, onboardingPoints: r.onboardingPoints, productPoints: r.productPoints, rating: r.rating, shareBp },
    });
  await client.update(dealerExclusiveTerritories).set({ rating: r.rating, shareBp, ratedAt: now, updatedAt: now }).where(eq(dealerExclusiveTerritories.id, territoryId));
  return { rating: r.rating, shareBp };
}

/* ============================================================ daily job */

/**
 * Every morning: paid-up territories past their date expire (and get a fee
 * to pay), expired ones past the grace days release their pincodes, renewals
 * due within RENEWAL_WINDOW_DAYS are reminded once, and every active territory
 * gets today's rating. A no-op while the rule is off.
 */
export async function runTerritoryDaily(now: Date = new Date()): Promise<{ skipped: string } | { expired: number; released: number; reminded: number; rated: number }> {
  const rule = await territoryRule();
  if (!rule.enabled) return { skipped: "rule territoryDealer is off" };
  let expired = 0;
  let released = 0;
  let reminded = 0;
  let rated = 0;

  const lapsing = await db
    .select()
    .from(dealerExclusiveTerritories)
    .where(and(eq(dealerExclusiveTerritories.status, "ACTIVE"), lte(dealerExclusiveTerritories.paidUntil, now)));
  for (const t of lapsing) {
    const done = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.id, t.id)).for("update");
      if (!locked || locked.status !== "ACTIVE" || !locked.paidUntil || locked.paidUntil.getTime() > now.getTime()) return false;
      await tx.update(dealerExclusiveTerritories).set({ status: "EXPIRED", endedAt: locked.paidUntil, endReason: "fee not renewed", updatedAt: now }).where(eq(dealerExclusiveTerritories.id, t.id));
      await ensureOpenFee(tx, locked);
      await recordAudit({ action: AUDIT_ACTIONS.DEALER_TERRITORY_CHANGED, entityType: "dealer_territory", entityId: t.id, previousValue: { status: "ACTIVE" }, newValue: { status: "EXPIRED", paidUntil: locked.paidUntil } }, tx);
      return true;
    });
    if (!done) continue;
    expired++;
    await tellDealer(t.dealerId, t.name, "fee due — expired", `The yearly fee for ${t.name} was not renewed, so you earn nothing on its orders until it is paid. Its pincodes stay yours for ${rule.graceDays} more days; after that another dealer may take them.`, `territory-expired:${t.id}:${t.paidUntil?.toISOString()}`);
  }

  const graceCut = new Date(now.getTime() - rule.graceDays * DAY);
  const ending = await db
    .select()
    .from(dealerExclusiveTerritories)
    .where(and(eq(dealerExclusiveTerritories.status, "EXPIRED"), lte(dealerExclusiveTerritories.paidUntil, graceCut)));
  for (const t of ending) {
    const freed = await db
      .update(dealerTerritoryPincodes)
      .set({ releasedAt: now })
      .where(and(eq(dealerTerritoryPincodes.territoryId, t.id), isNull(dealerTerritoryPincodes.releasedAt)))
      .returning({ pincode: dealerTerritoryPincodes.pincode });
    if (freed.length === 0) continue;
    released++;
    await db.update(dealerTerritoryFees).set({ status: "CANCELLED", updatedAt: now }).where(and(eq(dealerTerritoryFees.territoryId, t.id), eq(dealerTerritoryFees.status, "AWAITING_PAYMENT")));
    await recordAudit({ action: AUDIT_ACTIONS.DEALER_TERRITORY_CHANGED, entityType: "dealer_territory", entityId: t.id, newValue: { released: freed.map((f) => f.pincode), reason: `fee unpaid ${rule.graceDays} days after it lapsed` } });
    await tellDealer(t.dealerId, t.name, "pincodes released", `The fee for ${t.name} was not paid within ${rule.graceDays} days, so its pincodes are released. Ask GoKesari if you want the territory again.`, `territory-released:${t.id}`);
  }

  const due = await db
    .select()
    .from(dealerExclusiveTerritories)
    .where(and(eq(dealerExclusiveTerritories.status, "ACTIVE"), lte(dealerExclusiveTerritories.paidUntil, new Date(now.getTime() + RENEWAL_WINDOW_DAYS * DAY))));
  for (const t of due) {
    reminded++;
    await tellDealer(t.dealerId, t.name, "renewal due", `${t.name} is paid up to ${istDay(new Date(t.paidUntil!.getTime() - 1))}. Pay the yearly fee of ${rupees(t.feePaise)} on your dealer page to keep it and its order income.`, `territory-renewal:${t.id}:${t.paidUntil?.toISOString()}`);
  }

  const active = await db.select({ id: dealerExclusiveTerritories.id }).from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.status, "ACTIVE"));
  for (const t of active) {
    await rateTerritory(t.id, now).catch((e) => console.error("[territory] rating failed", t.id, e));
    rated++;
  }
  return { expired, released, reminded, rated };
}

/* ========================================================== order income */

export interface TerritoryOrderRow {
  orderId: string;
  territoryId: string;
  dealerId: string;
  shopId: string;
  deliveredAt: Date;
  commissionPaise: number;
  refundedCommissionPaise: number;
  shareBp: number;
  amountPaise: number;
}

/**
 * Orders delivered in [start, end) by a shop in a pincode a territory held at
 * the delivery, while a paid fee covered it — not worked out yet — with the
 * commission GoKesari kept on each (refunds so far taken off) and the share of
 * the delivery day (the latest rating on or before it; the base share before
 * the first rating).
 */
export async function territoryOrdersBetween(client: DbClient, start: Date, end: Date, rule: TerritoryRule, territoryId: string | null = null): Promise<TerritoryOrderRow[]> {
  const rows = await client.execute<{
    order_id: string;
    territory_id: string;
    dealer_id: string;
    shop_id: string;
    delivered_at: string | Date;
    commission_paise: string | number;
    goods_paise: string | number;
    rate_bp: number;
    refunds: (string | number)[] | null;
    share_bp: number | null;
  }>(sql`
    select o.order_id, t.id as territory_id, t.dealer_id, o.shop_id, o.delivered_at, o.commission_paise, o.goods_paise, o.commission_rate_bp as rate_bp,
      (select array_agg(fa.customer_refund_paise) from ${financialAdjustments} fa where fa.order_id = o.order_id and fa.type in ('REFUND_SHOP', 'REFUND_PLATFORM')) as refunds,
      (select r.share_bp from ${dealerTerritoryRatings} r where r.territory_id = t.id and r.day <= (o.delivered_at at time zone 'Asia/Kolkata')::date order by r.day desc limit 1) as share_bp
    from ${orderFinancials} o
    join ${shops} s on s.id = o.shop_id
    join ${dealerTerritoryPincodes} tp on tp.pincode = s.pincode and tp.held_from <= o.delivered_at and (tp.released_at is null or tp.released_at > o.delivered_at)
    join ${dealerExclusiveTerritories} t on t.id = tp.territory_id
    join ${dealers} d on d.id = t.dealer_id and not d.is_internal
    where o.delivered_at >= ${start.toISOString()}::timestamptz and o.delivered_at < ${end.toISOString()}::timestamptz
      and (${territoryId}::uuid is null or t.id = ${territoryId}::uuid)
      and exists (select 1 from ${dealerTerritoryFees} f where f.territory_id = t.id and f.status = 'PAID' and f.period_start <= o.delivered_at and f.period_end > o.delivered_at)
      and not exists (select 1 from ${dealerTerritoryOrderShares} x where x.order_id = o.order_id)
    order by o.delivered_at, o.order_id
  `);
  return rows.map((r) => {
    const commission = Number(r.commission_paise);
    const goods = Number(r.goods_paise);
    const refunded = Math.min(commission, (r.refunds ?? []).reduce<number>((s, x) => s + commissionOnPaise(Math.min(Number(x), goods), Number(r.rate_bp)), 0));
    const shareBp = r.share_bp ?? rule.baseShareBp;
    return {
      orderId: r.order_id,
      territoryId: r.territory_id,
      dealerId: r.dealer_id,
      shopId: r.shop_id,
      deliveredAt: new Date(r.delivered_at),
      commissionPaise: commission,
      refundedCommissionPaise: refunded,
      shareBp,
      amountPaise: orderSharePaise(commission - refunded, shareBp),
    };
  });
}

/** Commission on refunded goods of already-settled orders, now (to find refunds recorded after a close). */
async function currentRefundedCommission(client: DbClient, orderIds: string[]): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map();
  const rows = await client
    .select({ orderId: financialAdjustments.orderId, refund: financialAdjustments.customerRefundPaise, goods: orderFinancials.goodsPaise, rateBp: orderFinancials.commissionRateBp, commission: orderFinancials.commissionPaise })
    .from(financialAdjustments)
    .innerJoin(orderFinancials, eq(orderFinancials.orderId, financialAdjustments.orderId))
    .where(and(inArray(financialAdjustments.orderId, orderIds), inArray(financialAdjustments.type, ["REFUND_SHOP", "REFUND_PLATFORM"])));
  const out = new Map<string, number>();
  for (const r of rows) {
    const id = r.orderId!;
    const next = (out.get(id) ?? 0) + commissionOnPaise(Math.min(Number(r.refund), Number(r.goods)), r.rateBp);
    out.set(id, Math.min(Number(r.commission), next));
  }
  return out;
}

/**
 * When `month` closes (closeCommissionMonth, before anything is approved):
 * one TERRITORY entry per territory for the orders delivered in the month,
 * and one REVERSAL per territory for refunds recorded since on orders of
 * earlier months. Each order is written once (dealer_territory_order_shares).
 * Dated inside the month.
 */
export async function accrueTerritoryIncome(tx: DbClient, month: string, start: Date, end: Date, actor: Actor | null): Promise<DealerCommissionEntry[]> {
  const rule = await territoryRule();
  if (!rule.enabled) return [];
  const out: DealerCommissionEntry[] = [];
  const at = new Date(end.getTime() - 1);
  const orders = await territoryOrdersBetween(tx, start, end, rule);
  const byTerritory = new Map<string, TerritoryOrderRow[]>();
  for (const o of orders) byTerritory.set(o.territoryId, [...(byTerritory.get(o.territoryId) ?? []), o]);

  for (const [territoryId, rows] of [...byTerritory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [territory] = await tx.select().from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.id, territoryId));
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, territory.dealerId)).for("update");
    const kept = rows.reduce((s, r) => s + r.commissionPaise - r.refundedCommissionPaise, 0);
    const amount = rows.reduce((s, r) => s + r.amountPaise, 0);
    const avgBp = kept > 0 ? Math.round((amount * 10_000) / kept) : 0;
    const entries =
      amount > 0
        ? await writeEntry(tx, {
            dealer,
            payee: null,
            shopId: null,
            salespersonId: null,
            milestone: "MONTHLY",
            entryType: "TERRITORY",
            accrualKey: `TO:${territoryId}:${month}`,
            feePaise: 0,
            basePaise: kept,
            bonusBp: avgBp,
            amountPaise: amount,
            note: `${month}: ${rows.length} order${rows.length === 1 ? "" : "s"} in ${territory.name} — ${rupees(kept)} GoKesari commission kept, ${(avgBp / 100).toFixed(2)}% share`,
            createdAt: at,
            actor,
          })
        : [];
    out.push(...entries);
    const ledgerEntryId = entries[0]?.id ?? null;
    await tx.insert(dealerTerritoryOrderShares).values(
      rows.map((r) => ({
        orderId: r.orderId,
        territoryId,
        dealerId: r.dealerId,
        shopId: r.shopId,
        month,
        deliveredAt: r.deliveredAt,
        commissionPaise: r.commissionPaise,
        refundedCommissionPaise: r.refundedCommissionPaise,
        shareBp: r.shareBp,
        amountPaise: r.amountPaise,
        ledgerEntryId,
      })),
    );
    await recordAudit(
      { actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.DEALER_TERRITORY_INCOME, entityType: "dealer_territory", entityId: territoryId, newValue: { month, orders: rows.length, keptPaise: kept, amountPaise: amount, ledgerEntryId } },
      tx,
    );
  }

  // Refunds recorded after an earlier month closed: take back the difference.
  const settled = await tx
    .select()
    .from(dealerTerritoryOrderShares)
    .where(and(sql`${dealerTerritoryOrderShares.month} < ${month}`, gt(dealerTerritoryOrderShares.amountPaise, 0)))
    .orderBy(asc(dealerTerritoryOrderShares.orderId));
  const refunded = await currentRefundedCommission(tx, settled.map((s) => s.orderId));
  const corrections = new Map<string, { rows: { orderId: string; refunded: number; amount: number; delta: number; entryId: string | null }[] }>();
  for (const s of settled) {
    const now = refunded.get(s.orderId) ?? 0;
    if (now <= Number(s.refundedCommissionPaise)) continue;
    const amount = orderSharePaise(Number(s.commissionPaise) - now, s.shareBp);
    const delta = amount - s.amountPaise;
    const c = corrections.get(s.territoryId) ?? { rows: [] };
    c.rows.push({ orderId: s.orderId, refunded: now, amount, delta, entryId: s.ledgerEntryId });
    corrections.set(s.territoryId, c);
  }
  for (const [territoryId, c] of corrections) {
    const total = c.rows.reduce((s, r) => s + r.delta, 0);
    for (const r of c.rows) {
      await tx.update(dealerTerritoryOrderShares).set({ refundedCommissionPaise: r.refunded, amountPaise: r.amount, updatedAt: new Date() }).where(eq(dealerTerritoryOrderShares.orderId, r.orderId));
    }
    if (total >= 0) continue;
    const [territory] = await tx.select().from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.id, territoryId));
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, territory.dealerId)).for("update");
    const [entry] = await tx
      .insert(dealerCommissionLedger)
      .values({
        dealerId: dealer.id,
        shopId: null,
        milestone: "MONTHLY",
        kind: "REVERSAL",
        entryType: "TERRITORY",
        payeeMemberId: null,
        level: 1,
        accrualKey: `TR:${territoryId}:${month}`,
        reversesId: c.rows.find((r) => r.entryId)?.entryId ?? null,
        amountPaise: total,
        status: "EARNED",
        note: `${month}: refunds recorded after an earlier close on ${c.rows.length} order${c.rows.length === 1 ? "" : "s"} in ${territory.name}`,
        createdBy: actor?.id ?? null,
        createdAt: at,
      })
      .returning();
    out.push(entry);
    await recordAudit(
      { actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.DEALER_TERRITORY_INCOME, entityType: "dealer_territory", entityId: territoryId, newValue: { month, correctionPaise: total, orders: c.rows.map((r) => r.orderId), ledgerEntryId: entry.id } },
      tx,
    );
  }
  return out;
}

/* ================================================================ views */

export interface TerritoryView {
  id: string;
  dealerId: string;
  dealerName: string;
  name: string;
  status: TerritoryStatus;
  feePaise: number;
  paidUntil: string | null;
  activatedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  pincodes: string[];
  rating: number;
  shareBp: number;
  ratedAt: string | null;
  latestRating: { day: string; onboardingRating: number; onboardingPoints: number; shopsTotal: number; shopsLive: number; productPoints: number } | null;
  canPay: boolean;
  openFee: { id: string; amountPaise: number } | null;
  fees: { id: string; amountPaise: number; status: string; method: string | null; reference: string | null; periodStart: string | null; periodEnd: string | null; paidAt: string | null }[];
  /** This month so far (IST), worked out now; paid when the month closes. */
  monthSoFar: { orders: number; commissionKeptPaise: number; incomePaise: number };
  /** Order income in the ledger, all time (TERRITORY accruals and corrections). */
  earnedPaise: number;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Territories with everything the dealer page and the admin screen show. `dealerId` null = every dealer (admin). */
export async function territoryViews(dealerId: string | null, now: Date = new Date()): Promise<TerritoryView[]> {
  const rule = await territoryRule();
  const list = await db
    .select({ t: dealerExclusiveTerritories, dealerName: dealers.legalName })
    .from(dealerExclusiveTerritories)
    .innerJoin(dealers, eq(dealers.id, dealerExclusiveTerritories.dealerId))
    .where(dealerId ? eq(dealerExclusiveTerritories.dealerId, dealerId) : sql`true`)
    .orderBy(desc(dealerExclusiveTerritories.createdAt))
    .limit(500);
  if (list.length === 0) return [];
  const ids = list.map((l) => l.t.id);
  const [pins, fees, ratings, earned] = await Promise.all([
    db.select().from(dealerTerritoryPincodes).where(and(inArray(dealerTerritoryPincodes.territoryId, ids), isNull(dealerTerritoryPincodes.releasedAt))),
    db.select().from(dealerTerritoryFees).where(inArray(dealerTerritoryFees.territoryId, ids)).orderBy(desc(dealerTerritoryFees.createdAt)),
    db.select().from(dealerTerritoryRatings).where(inArray(dealerTerritoryRatings.territoryId, ids)).orderBy(desc(dealerTerritoryRatings.day)),
    db
      .select({ territoryId: dealerTerritoryOrderShares.territoryId, paise: sql<number>`coalesce(sum(${dealerTerritoryOrderShares.amountPaise}), 0)::bigint` })
      .from(dealerTerritoryOrderShares)
      .where(inArray(dealerTerritoryOrderShares.territoryId, ids))
      .groupBy(dealerTerritoryOrderShares.territoryId),
  ]);
  const ist = new Date(now.getTime() + IST_OFFSET);
  const monthStart = new Date(`${ist.toISOString().slice(0, 7)}-01T00:00:00+05:30`);
  const soFar = rule.enabled ? await territoryOrdersBetween(db, monthStart, now, rule) : [];
  return list.map(({ t, dealerName }) => {
    const mine = soFar.filter((o) => o.territoryId === t.id);
    const latest = ratings.find((r) => r.territoryId === t.id) ?? null;
    const myFees = fees.filter((f) => f.territoryId === t.id);
    const open = myFees.find((f) => f.status === "AWAITING_PAYMENT") ?? null;
    return {
      id: t.id,
      dealerId: t.dealerId,
      dealerName,
      name: t.name,
      status: t.status,
      feePaise: t.feePaise,
      paidUntil: iso(t.paidUntil),
      activatedAt: iso(t.activatedAt),
      endedAt: iso(t.endedAt),
      endReason: t.endReason,
      pincodes: pins.filter((p) => p.territoryId === t.id).map((p) => p.pincode).sort(),
      rating: t.rating,
      shareBp: t.shareBp,
      ratedAt: iso(t.ratedAt),
      latestRating: latest ? { day: latest.day, onboardingRating: latest.onboardingRating, onboardingPoints: latest.onboardingPoints, shopsTotal: latest.shopsTotal, shopsLive: latest.shopsLive, productPoints: latest.productPoints } : null,
      canPay: rule.enabled && canPayNow(t, now, pins.filter((p) => p.territoryId === t.id).length),
      openFee: open ? { id: open.id, amountPaise: open.amountPaise } : null,
      fees: myFees.map((f) => ({ id: f.id, amountPaise: f.amountPaise, status: f.status, method: f.method, reference: f.reference, periodStart: iso(f.periodStart), periodEnd: iso(f.periodEnd), paidAt: iso(f.paidAt) })),
      monthSoFar: { orders: mine.length, commissionKeptPaise: mine.reduce((s, o) => s + o.commissionPaise - o.refundedCommissionPaise, 0), incomePaise: mine.reduce((s, o) => s + o.amountPaise, 0) },
      earnedPaise: Number(earned.find((e) => e.territoryId === t.id)?.paise ?? 0),
    };
  });
}

/** The approved TIERED dealers an admin can give a territory to. */
export async function territoryCandidates(): Promise<{ id: string; legalName: string }[]> {
  return db
    .select({ id: dealers.id, legalName: dealers.legalName })
    .from(dealers)
    .where(and(eq(dealers.status, "APPROVED"), eq(dealers.commissionModel, "TIERED"), eq(dealers.isInternal, false)))
    .orderBy(asc(dealers.legalName));
}
