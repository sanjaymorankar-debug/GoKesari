/**
 * Admin → Dealers → Promote (owner, 28-Nov-2026 ~20.00 IST; docs/dealer-promotion-2026-11/README.md).
 *
 * Search any shop (name, owner, mobile, shop id) or dealer (name, mobile, code) and promote:
 *   - a live shop's owner → dealer: the dealer row is made from the shop (verified mobile, PAN, GSTIN, address, bank —
 *     nothing typed), sent as a shop owner's request and approved four-eye — the admin / operator who starts it is the
 *     first person; a DIFFERENT admin / operator confirms (src/server/dealers/promotion.ts). "Also make super dealer"
 *     is kept and acted on at the approval (src/server/dealers/super-requests.ts).
 *   - an approved dealer → super dealer: an ADMIN promotes at once; an OPERATOR raises a request another admin /
 *     operator approves.
 */
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { dealerCodes, dealers, referralCodes, shops, superFranchiseeMembers, superFranchisees, users, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export interface StaffActor {
  id: string;
  role: UserRole;
}

const STAFF: readonly UserRole[] = ["ADMIN", "OPERATOR"];
function requireStaff(actor: StaffActor) {
  if (!STAFF.includes(actor.role)) throw forbidden("Only an admin or operator can promote dealers.");
}

export interface PromotionCandidate {
  ownerId: string | null;
  ownerName: string | null;
  mobileLast4: string | null;
  shops: { id: string; name: string; status: string; live: boolean }[];
  dealer: { id: string; legalName: string; status: string; source: string; code: string | null; wantsSuper: boolean } | null;
  isSuper: boolean;
  inSuperTeam: boolean;
}

const last4 = (v: string | null | undefined) => {
  const d = (v ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
};

/** Shops and dealers matching the term, grouped by the person (the shop owner's / dealer's account). At most 25. */
export async function searchPromotionCandidates(q: string, actor: StaffActor): Promise<PromotionCandidate[]> {
  requireStaff(actor);
  const term = q.trim().slice(0, 80);
  if (term.length < 2) return [];
  const isUuid = /^[0-9a-f-]{36}$/i.test(term);
  const like = `%${term.replace(/[%_]/g, "")}%`;
  const digits = term.replace(/\D/g, "").slice(-10);
  const byPhone = digits.length >= 4;

  const shopRows = await db
    .select({ id: shops.id, name: shops.name, status: shops.status, ownerId: shops.ownerId, ownerName: shops.ownerName, phone: shops.phone })
    .from(shops)
    .where(
      and(
        isNull(shops.deletedAt),
        isUuid
          ? eq(shops.id, term)
          : or(
              ilike(shops.name, like),
              ilike(shops.ownerName, like),
              ...(byPhone ? [sql`${shops.phone} like ${"%" + digits + "%"}`] : []),
              // the owner's account: name, e-mail, mobile
              inArray(
                shops.ownerId,
                db
                  .select({ id: users.id })
                  .from(users)
                  .where(or(ilike(users.name, like), ilike(users.email, like), ...(byPhone ? [sql`coalesce(${users.phoneE164}, ${users.phone}, '') like ${"%" + digits + "%"}`] : []))),
              ),
            ),
      ),
    )
    .orderBy(desc(shops.createdAt))
    .limit(25);
  const dealerRows = await db
    .select({ id: dealers.id, userId: dealers.userId })
    .from(dealers)
    .leftJoin(dealerCodes, eq(dealerCodes.dealerId, dealers.id))
    .leftJoin(referralCodes, eq(referralCodes.id, dealerCodes.referralCodeId))
    .where(
      and(
        eq(dealers.isInternal, false),
        isUuid
          ? eq(dealers.id, term)
          : or(ilike(dealers.legalName, like), ilike(dealers.contactName, like), ilike(referralCodes.code, like), ...(byPhone ? [sql`${dealers.mobileE164} like ${"%" + digits + "%"}`] : [])),
      ),
    )
    .limit(25);

  const ownerIds = [...new Set([...shopRows.map((s) => s.ownerId), ...dealerRows.map((d) => d.userId)].filter((x): x is string => !!x))];
  const dealerOnly = dealerRows.filter((d) => !d.userId).map((d) => d.id);
  const [ownerShops, ownerUsers, ownerDealers] = ownerIds.length
    ? await Promise.all([
        db.select({ id: shops.id, name: shops.name, status: shops.status, ownerId: shops.ownerId }).from(shops).where(and(inArray(shops.ownerId, ownerIds), isNull(shops.deletedAt))),
        db.select({ id: users.id, name: users.name, phone: users.phone, phoneE164: users.phoneE164 }).from(users).where(inArray(users.id, ownerIds)),
        db.select().from(dealers).where(and(inArray(dealers.userId, ownerIds), eq(dealers.isInternal, false))).orderBy(desc(dealers.createdAt)),
      ])
    : [[], [], []];
  const extraDealers = dealerOnly.length ? await db.select().from(dealers).where(inArray(dealers.id, dealerOnly)) : [];
  const allDealers = [...ownerDealers, ...extraDealers];
  const dIds = allDealers.map((d) => d.id);
  const [codes, supers, members] = dIds.length
    ? await Promise.all([
        db.select({ dealerId: dealerCodes.dealerId, code: referralCodes.code, kind: dealerCodes.kind, status: dealerCodes.status }).from(dealerCodes).innerJoin(referralCodes, eq(referralCodes.id, dealerCodes.referralCodeId)).where(inArray(dealerCodes.dealerId, dIds)),
        db.select({ dealerId: superFranchisees.dealerId, status: superFranchisees.status }).from(superFranchisees).where(inArray(superFranchisees.dealerId, dIds)),
        db.select({ dealerId: superFranchiseeMembers.memberDealerId }).from(superFranchiseeMembers).where(and(inArray(superFranchiseeMembers.memberDealerId, dIds), isNull(superFranchiseeMembers.endsAt))),
      ])
    : [[], [], []];

  const dealerView = (d: (typeof allDealers)[number]) => ({
    id: d.id,
    legalName: d.legalName,
    status: d.status,
    source: d.source,
    code: codes.find((c) => c.dealerId === d.id && c.kind !== "SALESPERSON" && c.status === "ACTIVE")?.code ?? null,
    wantsSuper: !!d.wantsSuperAt,
  });
  const out: PromotionCandidate[] = ownerIds.map((ownerId) => {
    const u = ownerUsers.find((x) => x.id === ownerId);
    const d = ownerDealers.find((x) => x.userId === ownerId) ?? null;
    const own = ownerShops.filter((s) => s.ownerId === ownerId);
    return {
      ownerId,
      ownerName: u?.name ?? shopRows.find((s) => s.ownerId === ownerId)?.ownerName ?? d?.contactName ?? null,
      mobileLast4: last4(u?.phoneE164 ?? u?.phone ?? shopRows.find((s) => s.ownerId === ownerId)?.phone),
      shops: own.map((s) => ({ id: s.id, name: s.name, status: s.status, live: s.status === "APPROVED" })),
      dealer: d ? dealerView(d) : null,
      isSuper: !!d && supers.some((x) => x.dealerId === d.id && x.status === "ACTIVE"),
      inSuperTeam: !!d && members.some((m) => m.dealerId === d.id),
    };
  });
  for (const d of extraDealers) {
    out.push({ ownerId: null, ownerName: d.contactName, mobileLast4: last4(d.mobileE164), shops: [], dealer: dealerView(d), isSuper: supers.some((x) => x.dealerId === d.id && x.status === "ACTIVE"), inSuperTeam: members.some((m) => m.dealerId === d.id) });
  }
  return out.slice(0, 25);
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Promote a live shop's owner to dealer. Returns the pending four-eye approval (a different admin / operator confirms
 * it), or the dealer already waiting for one. alsoSuper: the dealer becomes a super dealer at the approval (an
 * admin's wish) or a super dealer request follows it (an operator's).
 */
export async function promoteShopOwner(
  shopId: string,
  actor: StaffActor,
  input: { alsoSuper?: boolean; agreementStart?: string | null; agreementEnd?: string | null; reason?: string | null } = {},
): Promise<{ dealerId: string; approvalId: string | null; message: string }> {
  requireStaff(actor);
  const [shop] = await db.select({ id: shops.id, ownerId: shops.ownerId, status: shops.status, name: shops.name, deletedAt: shops.deletedAt }).from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.deletedAt) throw notFound("Shop");
  if (shop.status !== "APPROVED") throw conflict("Only the owner of a live shop can be promoted to dealer. This shop is not live yet.");
  const [owner] = await db.select({ id: users.id, role: users.role, status: users.status }).from(users).where(eq(users.id, shop.ownerId));
  if (!owner || owner.status !== "ACTIVE") throw conflict("The shop owner's account is not active.");
  if (owner.role === "ADMIN" || owner.role === "OPERATOR") throw conflict("A GoKesari staff account cannot be made a dealer here.");
  const today = new Date();
  const start = (input.agreementStart ?? "").trim() || isoDay(today);
  const end = (input.agreementEnd ?? "").trim() || `${Number(start.slice(0, 4)) + 1}${start.slice(4)}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) throw validationFailed("Agreement dates: YYYY-MM-DD, the end not before the start.", { fields: { agreementEnd: "Check the dates." } });

  const { ensureDealerFromShop } = await import("@/server/onboarding-v2/franchise");
  const dealer = await db.transaction(async (tx) => {
    const d = await ensureDealerFromShop({ id: owner.id, role: owner.role }, tx);
    if (d.status === "APPROVED") return d;
    const now = new Date();
    const patch: Partial<typeof dealers.$inferInsert> = { updatedAt: now };
    if (d.status === "DRAFT") Object.assign(patch, { status: "PENDING", source: "SHOP_REQUEST", submittedAt: now, statusReason: "Promoted from the shop by GoKesari staff" });
    if (input.alsoSuper) Object.assign(patch, { wantsSuperAt: now, wantsSuperBy: actor.id });
    const [row] = await tx.update(dealers).set(patch).where(eq(dealers.id, d.id)).returning();
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_APPLICATION_SUBMITTED, entityType: "dealer", entityId: d.id, newValue: { via: "admin_promote_shop_owner", shopId: shop.id, status: row.status, alsoSuper: !!input.alsoSuper, reason: (input.reason ?? "").slice(0, 300) || null } },
      tx,
    );
    return row;
  });
  if (dealer.status === "APPROVED") {
    if (!input.alsoSuper) throw conflict("This shop owner is already a dealer. Use Make super dealer to promote him further.");
    const r = await makeSuperDealer(dealer.id, actor, input.reason || `Promoted from ${shop.name}`);
    return { dealerId: dealer.id, approvalId: r.approvalId, message: r.message };
  }
  const { applyShopDetails, proposeDealerPromotion, pendingPromotionFor } = await import("./promotion");
  await applyShopDetails(dealer.id, actor);
  const pending = await pendingPromotionFor(dealer.id);
  if (pending) return { dealerId: dealer.id, approvalId: pending.approvalId, message: pending.requestedBy === actor.id ? "Already sent: a different admin or operator must confirm it." : "This promotion is already waiting for confirmation — confirm it in Admin → Dealers." };
  const r = await proposeDealerPromotion(dealer.id, { action: "APPROVE", agreementStart: start, agreementEnd: end }, actor);
  return { dealerId: dealer.id, approvalId: r.approvalId, message: `${r.message}${input.alsoSuper ? " He becomes a super dealer with the approval." : ""}` };
}

/** Approved dealer → super dealer. An admin: at once. An operator: a request a different admin / operator approves. */
export async function makeSuperDealer(dealerId: string, actor: StaffActor, reason: string): Promise<{ approvalId: string | null; message: string }> {
  requireStaff(actor);
  const why = (reason ?? "").trim();
  if (why.length < 5) throw validationFailed("Say why (at least 5 characters). It is kept in the audit log.", { fields: { reason: "Required." } });
  if (actor.role === "ADMIN") {
    const { promoteSuperFranchisee } = await import("./super-franchisee");
    await promoteSuperFranchisee(dealerId, { reason: why }, actor);
    return { approvalId: null, message: "He is now a super dealer (default rates). Set his own rates and his team on his dealer page." };
  }
  const { requestSuperDealerForDealer } = await import("./super-requests");
  const r = await requestSuperDealerForDealer(dealerId, actor, why);
  return { approvalId: r.approvalId, message: "Sent: a different admin or operator approves the super dealer request." };
}
