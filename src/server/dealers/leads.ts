/**
 * Dealer leads (docs/dealer-programme, GKS-RA-001): a dealer documents a shop
 * they visited — shop name, the owner's mobile (and GSTIN if known), the PIN
 * code, and that the owner agreed to be contacted. For leadWindowDays (default
 * 30) the lead reserves the shop: if it registers WITHOUT a code, it is
 * attributed to the dealer with the earliest open lead (attribution.ts). A code
 * at registration always wins. Leads expire on their own; a dealer may hold at
 * most maxOpenLeadsPerDealer open leads, so nobody reserves a whole town.
 * A shop already on GoKesari cannot be a lead.
 */
import { and, asc, count, desc, eq, isNull, ne, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { dealerLeads, dealers, dealerSalespeople, shops, type Dealer, type DealerLead, type UserRole } from "@/server/db/schema";
import { touchSellerRow } from "@/server/db/split/gate";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { flagCoversDistrict, getFeatureFlag } from "@/server/services/feature-flags";
import { districtCodeForPincode } from "@/server/services/geo-areas";
import { getRule } from "@/server/services/settings";
import { expireLeads, normalizeIndianMobile } from "./attribution";

interface Actor {
  id: string;
  role: UserRole;
}

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export interface LeadInput {
  shopName: string;
  ownerName?: string | null;
  mobile: string;
  gstin?: string | null;
  pincode: string;
  latitude?: number | null;
  longitude?: number | null;
  salespersonId?: string | null;
  /** The owner agreed to be contacted by this dealer about joining GoKesari. */
  ownerConsent: boolean;
  consentNote?: string | null;
}

export interface LeadView {
  id: string;
  shopName: string;
  ownerName: string | null;
  mobileMasked: string;
  pincode: string | null;
  status: DealerLead["status"];
  expiresAt: Date;
  closedReason: string | null;
  salespersonId: string | null;
  createdAt: Date;
}

const view = (l: DealerLead): LeadView => ({
  id: l.id,
  shopName: l.shopName,
  ownerName: l.ownerName,
  mobileMasked: `+91••••••${l.phoneE164.slice(-4)}`,
  pincode: l.pincode,
  status: l.status,
  expiresAt: l.expiresAt,
  closedReason: l.closedReason,
  salespersonId: l.salespersonId,
  createdAt: l.createdAt,
});

export async function createLead(dealer: Dealer, input: LeadInput, actor: Actor): Promise<LeadView> {
  if (dealer.status !== "APPROVED") throw conflict("Only an approved dealer can log leads.");
  const shopName = input.shopName.trim().replace(/\s+/g, " ").slice(0, 120);
  if (shopName.length < 2) throw validationFailed("Enter the shop's name.", { fields: { shopName: "Required." } });
  const phone = normalizeIndianMobile(input.mobile);
  if (!phone) throw validationFailed("Enter the owner's 10-digit mobile number.", { fields: { mobile: "10 digits." } });
  const gstin = input.gstin?.trim().toUpperCase() || null;
  if (gstin && !GSTIN.test(gstin)) throw validationFailed("That is not a valid GSTIN.", { fields: { gstin: "Invalid GSTIN." } });
  const pincode = input.pincode.trim();
  if (!/^[1-9][0-9]{5}$/.test(pincode)) throw validationFailed("Enter the shop's 6-digit PIN code.", { fields: { pincode: "6 digits." } });
  if (!input.ownerConsent) {
    throw validationFailed("Record the owner's agreement to be contacted; a lead without it does not count.", { fields: { ownerConsent: "Required." } });
  }
  if (!flagCoversDistrict(await getFeatureFlag("dealer_programme_enabled"), await districtCodeForPincode(pincode))) {
    throw validationFailed("The dealer programme is not open in this shop's district yet.", { fields: { pincode: "Not open here yet." } });
  }
  if (input.salespersonId) {
    const [person] = await db
      .select({ status: dealerSalespeople.status })
      .from(dealerSalespeople)
      .where(and(eq(dealerSalespeople.id, input.salespersonId), eq(dealerSalespeople.dealerId, dealer.id)));
    if (!person) throw notFound("Employee");
    if (person.status !== "ACTIVE") throw conflict("That employee is not active.");
  }
  // Already on GoKesari: no lead (and no new-shop commission later).
  const tail = phone.slice(-10);
  const [already] = await db
    .select({ id: shops.id })
    .from(shops)
    .where(
      and(
        isNull(shops.deletedAt),
        ne(shops.status, "REJECTED"),
        sql`(right(regexp_replace(${shops.phone}, '\\D', '', 'g'), 10) = ${tail}${gstin ? sql` or ${shops.gstin} = ${gstin}` : sql``})`,
      ),
    )
    .limit(1);
  if (already) throw conflict("This shop is already on GoKesari, so it cannot be a new lead.");

  const rule = await getRule("dealerProgramme");
  await expireLeads();
  return db.transaction(async (tx) => {
    // The dealer row is the gate for counting the dealer's open leads (split layout: touched after the lock).
    await tx.select({ id: dealers.id }).from(dealers).where(eq(dealers.id, dealer.id)).for("update");
    await touchSellerRow(tx, dealers, dealer.id);
    const [{ n }] = await tx
      .select({ n: count() })
      .from(dealerLeads)
      .where(and(eq(dealerLeads.dealerId, dealer.id), eq(dealerLeads.status, "OPEN")));
    if (n >= rule.maxOpenLeadsPerDealer) {
      throw conflict(`You already have ${n} open leads, the most allowed. Close or convert some first.`);
    }
    const [mine] = await tx
      .select({ id: dealerLeads.id })
      .from(dealerLeads)
      .where(and(eq(dealerLeads.dealerId, dealer.id), eq(dealerLeads.phoneE164, phone), eq(dealerLeads.status, "OPEN")));
    if (mine) throw conflict("You already have an open lead for this mobile number.");
    const now = new Date();
    const [row] = await tx
      .insert(dealerLeads)
      .values({
        dealerId: dealer.id,
        salespersonId: input.salespersonId ?? null,
        shopName,
        ownerName: input.ownerName?.trim().slice(0, 120) || null,
        phoneE164: phone,
        gstin,
        pincode,
        latitude: input.latitude != null ? String(input.latitude) : null,
        longitude: input.longitude != null ? String(input.longitude) : null,
        consentAt: now,
        consentNote: input.consentNote?.trim().slice(0, 300) || null,
        expiresAt: new Date(now.getTime() + rule.leadWindowDays * 86_400_000),
        createdBy: actor.id,
      })
      .returning();
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_LEAD_SAVED, entityType: "dealer", entityId: dealer.id, newValue: { leadId: row.id, status: "OPEN", expiresAt: row.expiresAt } },
      tx,
    );
    return view(row);
  });
}

export async function listLeads(dealerId: string): Promise<LeadView[]> {
  await expireLeads();
  const rows = await db.select().from(dealerLeads).where(eq(dealerLeads.dealerId, dealerId)).orderBy(asc(sql`${dealerLeads.status} <> 'OPEN'`), desc(dealerLeads.createdAt)).limit(500);
  return rows.map(view);
}

/** The dealer closes one of their own open leads. */
export async function closeLead(dealerId: string, leadId: string, actor: Actor): Promise<LeadView> {
  const [row] = await db
    .update(dealerLeads)
    .set({ status: "CLOSED", closedReason: "closed by the dealer", updatedAt: new Date() })
    .where(and(eq(dealerLeads.id, leadId), eq(dealerLeads.dealerId, dealerId), eq(dealerLeads.status, "OPEN")))
    .returning();
  if (!row) throw notFound("Open lead");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_LEAD_SAVED, entityType: "dealer", entityId: dealerId, newValue: { leadId, status: "CLOSED" } });
  return view(row);
}
