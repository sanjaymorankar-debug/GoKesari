/**
 * Attribution claims and the dealer's own shops (docs/dealer-programme,
 * GKS-RA-001).
 *
 * A dealer who believes a shop is theirs — another dealer's code was used, or
 * their lead was closed — raises a claim with the shop owner's mobile, a note
 * and (optionally) their lead. A help-desk ticket is opened for it (category
 * "Other", so the help desk's own form is unchanged). The answer never says
 * whether a shop with that mobile exists: dealers do not learn about shops that
 * are not theirs. Staff (admin or operator) uphold or reject the claim;
 * upholding moves the attribution to the claiming dealer, with the reason, in
 * the audit log, and both outcomes are sent to the dealer.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { createTicket } from "@/server/aftercare/support-tickets";
import { db } from "@/server/db";
import {
  dealerAttributionDisputes,
  dealerLeads,
  dealers,
  dealerSalespeople,
  shopAttributions,
  shops,
  type Dealer,
  type DealerAttributionDispute,
  type UserRole,
} from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { normalizeIndianMobile } from "./attribution";

interface Actor {
  id: string;
  role: UserRole;
}

export async function raiseDispute(dealer: Dealer, input: { mobile: string; note: string; leadId?: string | null }, actor: Actor): Promise<{ id: string }> {
  if (!["APPROVED", "SUSPENDED"].includes(dealer.status)) throw forbidden("Your dealer account is not active.");
  const phone = normalizeIndianMobile(input.mobile);
  if (!phone) throw validationFailed("Enter the shop owner's 10-digit mobile number.", { fields: { mobile: "10 digits." } });
  const note = input.note.trim().slice(0, 2000);
  if (note.length < 10) throw validationFailed("Explain why the shop is yours (your visit, the lead, what happened).", { fields: { note: "At least 10 characters." } });
  if (input.leadId) {
    const [lead] = await db.select({ id: dealerLeads.id }).from(dealerLeads).where(and(eq(dealerLeads.id, input.leadId), eq(dealerLeads.dealerId, dealer.id)));
    if (!lead) throw notFound("Lead");
  }
  const [open] = await db
    .select({ id: dealerAttributionDisputes.id })
    .from(dealerAttributionDisputes)
    .where(and(eq(dealerAttributionDisputes.dealerId, dealer.id), eq(dealerAttributionDisputes.claimedPhoneE164, phone), eq(dealerAttributionDisputes.status, "OPEN")));
  if (open) throw conflict("You already have an open claim for this mobile number.");
  const [shop] = await db
    .select({ id: shops.id })
    .from(shops)
    .where(and(isNull(shops.deletedAt), sql`right(regexp_replace(${shops.phone}, '\\D', '', 'g'), 10) = ${phone.slice(-10)}`))
    .orderBy(desc(shops.createdAt))
    .limit(1);
  let ticketId: string | null = null;
  try {
    const ticket = await createTicket(
      {
        category: "OTHER",
        subject: `Dealer attribution claim: ${dealer.legalName}`.slice(0, 200),
        description: `Dealer ${dealer.legalName} claims the shop with mobile ending ${phone.slice(-4)}.\n\n${note}`.slice(0, 5000),
      },
      actor,
    );
    ticketId = ticket.id;
  } catch (error) {
    // The help desk may be switched off; the claim is still recorded for the admin queue.
    console.error("[dealers] claim ticket not created", error instanceof Error ? error.message : error);
  }
  const [row] = await db
    .insert(dealerAttributionDisputes)
    .values({ dealerId: dealer.id, shopId: shop?.id ?? null, leadId: input.leadId ?? null, claimedPhoneE164: phone, note, ticketId, createdBy: actor.id })
    .returning({ id: dealerAttributionDisputes.id });
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DEALER_DISPUTE_SAVED,
    entityType: "dealer",
    entityId: dealer.id,
    newValue: { disputeId: row.id, status: "OPEN", shopFound: Boolean(shop), ticketId },
  });
  return row;
}

export interface DisputeView {
  id: string;
  dealerId: string;
  dealerName: string;
  status: DealerAttributionDispute["status"];
  phoneTail: string;
  note: string;
  shopId: string | null;
  shopName: string | null;
  currentDealerName: string | null;
  ticketId: string | null;
  resolutionNote: string | null;
  createdAt: Date;
}

/** Staff: claims (open first). The dealer: their own. */
export async function listDisputes(filter: { dealerId?: string; status?: DealerAttributionDispute["status"] } = {}): Promise<DisputeView[]> {
  const current = db
    .select({ shopId: shopAttributions.shopId, name: dealers.legalName })
    .from(shopAttributions)
    .innerJoin(dealers, eq(dealers.id, shopAttributions.dealerId))
    .as("current");
  const rows = await db
    .select({ d: dealerAttributionDisputes, dealerName: dealers.legalName, shopName: shops.name, currentDealerName: current.name })
    .from(dealerAttributionDisputes)
    .innerJoin(dealers, eq(dealers.id, dealerAttributionDisputes.dealerId))
    .leftJoin(shops, eq(shops.id, dealerAttributionDisputes.shopId))
    .leftJoin(current, eq(current.shopId, dealerAttributionDisputes.shopId))
    .where(
      and(
        filter.dealerId ? eq(dealerAttributionDisputes.dealerId, filter.dealerId) : sql`true`,
        filter.status ? eq(dealerAttributionDisputes.status, filter.status) : sql`true`,
      ),
    )
    .orderBy(sql`${dealerAttributionDisputes.status} <> 'OPEN'`, desc(dealerAttributionDisputes.createdAt))
    .limit(500);
  const forDealer = Boolean(filter.dealerId);
  return rows.map((r) => ({
    id: r.d.id,
    dealerId: r.d.dealerId,
    dealerName: r.dealerName,
    status: r.d.status,
    phoneTail: r.d.claimedPhoneE164.slice(-4),
    note: r.d.note,
    // A dealer never sees which shop (or whose) a claim matched.
    shopId: forDealer ? null : r.d.shopId,
    shopName: forDealer ? null : r.shopName,
    currentDealerName: forDealer ? null : r.currentDealerName,
    ticketId: r.d.ticketId,
    resolutionNote: r.d.resolutionNote,
    createdAt: r.d.createdAt,
  }));
}

/**
 * Staff (ADMIN or OPERATOR) decide a claim. Upholding needs the shop to have
 * been found; it moves the shop's attribution to the claiming dealer (source
 * ADMIN), keeping the old one in the audit log.
 */
export async function decideDispute(disputeId: string, decision: "UPHELD" | "REJECTED", note: string, actor: Actor): Promise<void> {
  if (actor.role !== "ADMIN" && actor.role !== "OPERATOR") throw forbidden("Only GoKesari staff decide attribution claims.");
  const why = note.trim().slice(0, 1000);
  if (why.length < 5) throw validationFailed("Give the reason (it is sent to the dealer).", { fields: { note: "Required." } });
  await db.transaction(async (tx) => {
    const [d] = await tx.select().from(dealerAttributionDisputes).where(eq(dealerAttributionDisputes.id, disputeId)).for("update");
    if (!d) throw notFound("Claim");
    if (d.status !== "OPEN") throw conflict("This claim was already decided.");
    if (decision === "UPHELD") {
      if (!d.shopId) throw conflict("No shop with this mobile was found, so the claim cannot be upheld.");
      const [before] = await tx.select().from(shopAttributions).where(eq(shopAttributions.shopId, d.shopId)).for("update");
      const [claimant] = await tx.select({ status: dealers.status }).from(dealers).where(eq(dealers.id, d.dealerId));
      if (claimant?.status !== "APPROVED") throw conflict("The claiming dealer is not approved, so the shop cannot move to them.");
      const values = { dealerId: d.dealerId, salespersonId: null, leadId: d.leadId, source: "ADMIN" as const, note: `claim upheld: ${why}`, updatedAt: new Date() };
      if (before) {
        await tx.update(shopAttributions).set(values).where(eq(shopAttributions.shopId, d.shopId));
      } else {
        // One unique key (the primary key): a target-less DO NOTHING is safe on the split layout.
        await tx.insert(shopAttributions).values({ shopId: d.shopId, ...values }).onConflictDoNothing();
      }
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AUDIT_ACTIONS.DEALER_ATTRIBUTION_CHANGED,
          entityType: "shop",
          entityId: d.shopId,
          previousValue: before ? { dealerId: before.dealerId, salespersonId: before.salespersonId, source: before.source } : null,
          newValue: { dealerId: d.dealerId, source: "ADMIN", disputeId, reason: why },
        },
        tx,
      );
    }
    await tx
      .update(dealerAttributionDisputes)
      .set({ status: decision, resolutionNote: why, resolvedBy: actor.id, resolvedAt: new Date() })
      .where(eq(dealerAttributionDisputes.id, disputeId));
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_DISPUTE_SAVED, entityType: "dealer", entityId: d.dealerId, previousValue: { status: "OPEN" }, newValue: { disputeId, status: decision, note: why } },
      tx,
    );
    const [dealer] = await tx.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, d.dealerId));
    if (dealer?.userId) {
      await notify(
        {
          userId: dealer.userId,
          type: NOTIFICATION_TYPES.DEALER_DISPUTE_DECIDED,
          vars: { decision: decision === "UPHELD" ? "upheld" : "not upheld", phoneTail: d.claimedPhoneE164.slice(-4), note: why },
          actionUrl: "/dealer",
          dedupeKey: `dealer-dispute:${disputeId}`,
        },
        tx,
      );
    }
  });
}

export interface DealerShopView {
  shopId: string;
  name: string;
  place: string;
  status: string;
  source: string;
  employee: string | null;
  employeeText: string | null;
  matchKind: string;
  attributedAt: Date;
}

/** The shops attributed to a dealer (theirs only). */
export async function listDealerShops(dealerId: string): Promise<DealerShopView[]> {
  const rows = await db
    .select({ a: shopAttributions, name: shops.name, area: shops.area, city: shops.city, status: shops.status, employee: dealerSalespeople.name })
    .from(shopAttributions)
    .innerJoin(shops, eq(shops.id, shopAttributions.shopId))
    .leftJoin(dealerSalespeople, eq(dealerSalespeople.id, shopAttributions.salespersonId))
    .where(and(eq(shopAttributions.dealerId, dealerId), eq(shopAttributions.status, "ACTIVE")))
    .orderBy(desc(shopAttributions.createdAt))
    .limit(1000);
  return rows.map((r) => ({
    shopId: r.a.shopId,
    name: r.name,
    place: [r.area, r.city].filter(Boolean).join(", "),
    status: r.status,
    source: r.a.source,
    employee: r.employee,
    employeeText: r.employee ? null : r.a.employeeText,
    matchKind: r.a.matchKind,
    attributedAt: r.a.createdAt,
  }));
}
