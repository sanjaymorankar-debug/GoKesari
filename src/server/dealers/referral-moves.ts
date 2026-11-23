/**
 * Referral moves (owner, 21/22-Nov-2026).
 *
 * An admin can
 *   - SHOPS: add a referral code to shops that have none, or move shops to another dealer's (franchise) team — to a
 *     team member's code or to the dealer's own code;
 *   - MEMBER: move a team lead / agent, with his own referral code and the shops he registered, to another dealer's
 *     team (reporting to the dealer, or under one of its team leads).
 *
 * Maker-checker: one admin raises the request with a written reason and the signed consent letters (PDF / photo,
 * stored encrypted); a different admin approves or rejects it. Nobody decides his own request.
 * Documents: SHOPS — a consent from each shop's owner, from the old dealer (when a shop had one) and from the new
 * dealer; MEMBER — from the person, the old dealer and the new dealer.
 *
 * Money ("old stays, new from move"): commission already earned stays with whoever earned it. From the moment of the
 * approval the new team earns: one-time commission not earned yet (a shop not activated yet, a part waiting for its
 * trading orders, renewals), and recurring franchise commission on orders delivered from then on (the old attachment
 * is kept as a closed period in franchise_shop_team_periods).
 */
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed, AppError } from "@/lib/errors";
import { isPanEncryptionConfigured } from "@/lib/env";
import { decryptBytes, encryptBytes } from "@/lib/pan-crypto";
import { db, type DbClient } from "@/server/db";
import {
  dealerCodes,
  dealerSalespeople,
  dealerTierShopPlans,
  dealers,
  franchiseShopAttributionHistory,
  franchiseShopAttributions,
  franchiseShopTeamPeriods,
  referralCodes,
  referralMoveDocuments,
  referralMoveRequests,
  referralRedemptions,
  shopAttributions,
  shops,
  REFERRAL_MOVE_DOC_KINDS,
  type ReferralMoveRequest,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export interface MoveActor {
  id: string;
  role: UserRole;
}

export type MoveDocKind = (typeof REFERRAL_MOVE_DOC_KINDS)[number];

export const MOVE_DOC_LABELS: Record<MoveDocKind, string> = {
  SHOP_OWNER_CONSENT: "Shop owner's signed consent",
  FROM_DEALER_CONSENT: "Old dealer / franchise owner's signed consent",
  TO_DEALER_CONSENT: "New dealer / franchise owner's signed consent",
  MEMBER_CONSENT: "Team member's signed consent",
  OTHER: "Other supporting document",
};

const MAX_SHOPS = 50;

const requireAdmin = (actor: MoveActor) => {
  if (actor.role !== "ADMIN" && !can(actor.role, PERMISSIONS.DEALER_REASSIGN)) throw forbidden("Only an admin can move referral codes.");
};

const cleanReason = (reason: string, min = 10) => {
  const r = (reason ?? "").trim().replace(/\s+/g, " ").slice(0, 500);
  if (r.length < min) throw validationFailed(`Give a reason of at least ${min} characters.`, { fields: { reason: "Required." } });
  return r;
};

async function approvedDealer(client: DbClient, dealerId: string) {
  const [d] = await client.select().from(dealers).where(eq(dealers.id, dealerId));
  if (!d) throw notFound("Dealer");
  if (d.status !== "APPROVED") throw conflict("The new dealer is not approved.");
  if (d.isInternal) throw conflict("Shops cannot be moved to GoKesari's own dealer record.");
  return d;
}

/* ============================================================== requests */

export interface NewMoveRequest {
  kind: "SHOPS" | "MEMBER";
  shopIds?: string[];
  memberId?: string | null;
  toDealerId: string;
  /** SHOPS: whose code the shops get (null = the dealer's own). MEMBER: the team lead he joins under (null = the dealer). */
  toMemberId?: string | null;
  reason: string;
}

export async function createMoveRequest(input: NewMoveRequest, actor: MoveActor): Promise<ReferralMoveRequest> {
  requireAdmin(actor);
  const reason = cleanReason(input.reason);
  const toDealer = await approvedDealer(db, input.toDealerId);
  const toMemberId = input.toMemberId ?? null;
  if (toMemberId) {
    const [m] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, toMemberId));
    if (!m || m.dealerId !== toDealer.id) throw validationFailed("That team member is not in the new dealer's team.");
    if (m.status !== "ACTIVE") throw conflict("That team member is not active.");
    if (input.kind === "MEMBER" && m.teamRole !== "TEAM_LEAD") throw validationFailed("A moved person can join under a team lead only.");
  }
  const open = await db.select().from(referralMoveRequests).where(eq(referralMoveRequests.status, "PENDING"));

  if (input.kind === "SHOPS") {
    const ids = [...new Set(input.shopIds ?? [])];
    if (!ids.length) throw validationFailed("Choose at least one shop.");
    if (ids.length > MAX_SHOPS) throw validationFailed(`At most ${MAX_SHOPS} shops in one request.`);
    const found = await db.select({ id: shops.id }).from(shops).where(and(inArray(shops.id, ids), isNull(shops.deletedAt)));
    if (found.length !== ids.length) throw notFound("Shop");
    const attrs = await db.select().from(shopAttributions).where(inArray(shopAttributions.shopId, ids));
    const fromDealers: Record<string, string | null> = Object.fromEntries(ids.map((id) => [id, null]));
    for (const a of attrs) if (a.status === "ACTIVE") fromDealers[a.shopId] = a.dealerId;
    for (const a of attrs) {
      if (a.status === "ACTIVE" && a.dealerId === toDealer.id && (a.salespersonId ?? null) === toMemberId) throw conflict("A chosen shop is already with that team and code.");
    }
    const busy = open.find((r) => r.kind === "SHOPS" && r.shopIds.some((s) => ids.includes(s)));
    if (busy) throw conflict("A chosen shop already has a move waiting for approval.");
    const [row] = await db.insert(referralMoveRequests).values({ kind: "SHOPS", shopIds: ids, fromDealers, toDealerId: toDealer.id, toMemberId, reason, requestedBy: actor.id }).returning();
    await audit(db, actor, row, AUDIT_ACTIONS.REFERRAL_MOVE_REQUESTED, { kind: "SHOPS", shopIds: ids, fromDealers, toDealerId: toDealer.id, toMemberId, reason });
    return row;
  }

  if (!input.memberId) throw validationFailed("Choose the team member to move.");
  const [member] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, input.memberId));
  if (!member) throw notFound("Team member");
  if (member.status !== "ACTIVE") throw conflict("Only an active team member can be moved.");
  if (member.dealerId === toDealer.id) throw conflict("The person is already in this dealer's team.");
  if (open.some((r) => r.kind === "MEMBER" && r.memberId === member.id)) throw conflict("This person already has a move waiting for approval.");
  const [row] = await db.insert(referralMoveRequests).values({ kind: "MEMBER", memberId: member.id, fromDealerId: member.dealerId, toDealerId: toDealer.id, toMemberId, reason, requestedBy: actor.id }).returning();
  await audit(db, actor, row, AUDIT_ACTIONS.REFERRAL_MOVE_REQUESTED, { kind: "MEMBER", memberId: member.id, fromDealerId: member.dealerId, toDealerId: toDealer.id, toMemberId, reason });
  return row;
}

/** The consent letters still missing before the request can be approved. */
export async function missingDocuments(request: ReferralMoveRequest, client: DbClient = db): Promise<{ kind: MoveDocKind; shopId: string | null; label: string }[]> {
  const docs = await client.select({ kind: referralMoveDocuments.kind, shopId: referralMoveDocuments.shopId }).from(referralMoveDocuments).where(eq(referralMoveDocuments.requestId, request.id));
  const has = (kind: MoveDocKind, shopId: string | null = null) => docs.some((d) => d.kind === kind && (shopId == null || d.shopId === shopId));
  const out: { kind: MoveDocKind; shopId: string | null; label: string }[] = [];
  if (request.kind === "SHOPS") {
    for (const s of request.shopIds) if (!has("SHOP_OWNER_CONSENT", s)) out.push({ kind: "SHOP_OWNER_CONSENT", shopId: s, label: MOVE_DOC_LABELS.SHOP_OWNER_CONSENT });
    if (Object.values(request.fromDealers).some((d) => d && d !== request.toDealerId) && !has("FROM_DEALER_CONSENT")) out.push({ kind: "FROM_DEALER_CONSENT", shopId: null, label: MOVE_DOC_LABELS.FROM_DEALER_CONSENT });
  } else {
    if (!has("MEMBER_CONSENT")) out.push({ kind: "MEMBER_CONSENT", shopId: null, label: MOVE_DOC_LABELS.MEMBER_CONSENT });
    if (!has("FROM_DEALER_CONSENT")) out.push({ kind: "FROM_DEALER_CONSENT", shopId: null, label: MOVE_DOC_LABELS.FROM_DEALER_CONSENT });
  }
  if (!has("TO_DEALER_CONSENT")) out.push({ kind: "TO_DEALER_CONSENT", shopId: null, label: MOVE_DOC_LABELS.TO_DEALER_CONSENT });
  return out;
}

/** Uploads one consent letter to a waiting request (PDF, JPEG, PNG or WebP up to 5 MB, checked from the bytes). */
export async function addMoveDocument(requestId: string, input: { kind: MoveDocKind; shopId?: string | null; name: string; bytes: Buffer }, actor: MoveActor) {
  requireAdmin(actor);
  if (!isPanEncryptionConfigured()) throw new AppError("CONFLICT", "Document upload is not available on this site yet (secure storage is not set up).");
  const { DOC_MIME, MAX_DOC_BYTES, sniffMime } = await import("./service");
  const request = await getRequest(requestId);
  if (request.status !== "PENDING") throw conflict("Documents can be added only while the request waits for approval.");
  if (!(REFERRAL_MOVE_DOC_KINDS as readonly string[]).includes(input.kind)) throw validationFailed("Unknown document type.");
  const shopId = input.kind === "SHOP_OWNER_CONSENT" ? (input.shopId ?? null) : null;
  if (input.kind === "SHOP_OWNER_CONSENT" && (!shopId || !request.shopIds.includes(shopId))) throw validationFailed("Choose which shop's owner signed this consent.");
  if (input.bytes.length === 0) throw validationFailed("The file is empty.");
  if (input.bytes.length > MAX_DOC_BYTES) throw validationFailed("The file is larger than 5 MB.");
  const mimeType = sniffMime(input.bytes);
  if (!mimeType || !DOC_MIME[mimeType]) throw validationFailed("Upload a PDF, JPEG, PNG or WebP file.");
  const fileName = (input.name.replace(/[^\w.\- ]+/g, "_").slice(0, 100) || `consent.${DOC_MIME[mimeType]}`).trim();
  const [row] = await db
    .insert(referralMoveDocuments)
    .values({ requestId, kind: input.kind, shopId, fileName, mimeType, sizeBytes: input.bytes.length, content: encryptBytes(input.bytes), uploadedBy: actor.id })
    .returning({ id: referralMoveDocuments.id, kind: referralMoveDocuments.kind, shopId: referralMoveDocuments.shopId, fileName: referralMoveDocuments.fileName, mimeType: referralMoveDocuments.mimeType, sizeBytes: referralMoveDocuments.sizeBytes, uploadedAt: referralMoveDocuments.uploadedAt });
  await audit(db, actor, request, AUDIT_ACTIONS.REFERRAL_MOVE_DOCUMENT, { documentId: row.id, kind: row.kind, shopId, sizeBytes: row.sizeBytes, mimeType });
  return row;
}

export async function readMoveDocument(requestId: string, documentId: string, actor: MoveActor): Promise<{ fileName: string; mimeType: string; bytes: Buffer }> {
  requireAdmin(actor);
  const [d] = await db.select().from(referralMoveDocuments).where(and(eq(referralMoveDocuments.id, documentId), eq(referralMoveDocuments.requestId, requestId)));
  if (!d) throw notFound("Document");
  return { fileName: d.fileName, mimeType: d.mimeType, bytes: decryptBytes(d.content) };
}

export async function getRequest(id: string, client: DbClient = db): Promise<ReferralMoveRequest> {
  const [r] = await client.select().from(referralMoveRequests).where(eq(referralMoveRequests.id, id));
  if (!r) throw notFound("Move request");
  return r;
}

export async function cancelMoveRequest(id: string, note: string, actor: MoveActor): Promise<ReferralMoveRequest> {
  requireAdmin(actor);
  const why = cleanReason(note, 5);
  const r = await getRequest(id);
  if (r.status !== "PENDING") throw conflict("Only a waiting request can be cancelled.");
  if (r.requestedBy !== actor.id) throw forbidden("Only the admin who raised the request can cancel it; another admin can reject it.");
  const [row] = await db.update(referralMoveRequests).set({ status: "CANCELLED", decisionNote: why, decidedAt: new Date() }).where(and(eq(referralMoveRequests.id, id), eq(referralMoveRequests.status, "PENDING"))).returning();
  if (!row) throw conflict("The request was decided meanwhile.");
  await audit(db, actor, row, AUDIT_ACTIONS.REFERRAL_MOVE_DECIDED, { decision: "CANCELLED", note: why });
  return row;
}

/**
 * A second admin approves (the move is applied at once) or rejects. Approval needs every consent letter.
 * `at` is the moment of the move (tests only; default now).
 */
export async function decideMoveRequest(id: string, input: { approve: boolean; note: string; at?: Date }, actor: MoveActor): Promise<ReferralMoveRequest> {
  requireAdmin(actor);
  const note = cleanReason(input.note, 5);
  const r = await getRequest(id);
  if (r.status !== "PENDING") throw conflict("This request has already been decided.");
  if (r.requestedBy === actor.id) throw forbidden("A different admin must approve or reject this request.");
  if (!input.approve) {
    const [row] = await db.update(referralMoveRequests).set({ status: "REJECTED", decidedBy: actor.id, decidedAt: new Date(), decisionNote: note }).where(and(eq(referralMoveRequests.id, id), eq(referralMoveRequests.status, "PENDING"))).returning();
    if (!row) throw conflict("The request was decided meanwhile.");
    await audit(db, actor, row, AUDIT_ACTIONS.REFERRAL_MOVE_DECIDED, { decision: "REJECTED", note });
    return row;
  }
  const missing = await missingDocuments(r);
  if (missing.length) throw conflict(`Upload the missing consent letters first: ${[...new Set(missing.map((m) => m.label))].join("; ")}.`);
  await approvedDealer(db, r.toDealerId);
  const at = input.at ?? new Date();
  const why = `Referral move ${r.id.slice(0, 8)}: ${r.reason}`;

  // MEMBER: the person first gets his place in the new team (src/server/dealers/service.ts transferMemberToDealer:
  // old place ends, payee details carry over), then keeps his own code and takes his shops along.
  let newMemberId: string | null = null;
  let movedShopIds: string[] = r.shopIds;
  if (r.kind === "MEMBER") {
    const [member] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, r.memberId!));
    if (!member || member.status !== "ACTIVE" || member.dealerId !== r.fromDealerId) throw conflict("The person is no longer active in the old team; reject this request.");
    const attributed = await db.select({ shopId: shopAttributions.shopId }).from(shopAttributions).where(and(eq(shopAttributions.salespersonId, member.id), eq(shopAttributions.dealerId, member.dealerId), eq(shopAttributions.status, "ACTIVE")));
    movedShopIds = attributed.map((a) => a.shopId);
    const { transferMemberToDealer } = await import("./service");
    const created = await transferMemberToDealer(member.id, r.toDealerId, why.slice(0, 300), { id: actor.id, role: actor.role });
    newMemberId = created.id;
    if (r.toMemberId) {
      const { setMemberPlacement } = await import("./tiered");
      await setMemberPlacement(created.id, { role: "AGENT", parentId: r.toMemberId }, why.slice(0, 300), { id: actor.id, role: actor.role });
    }
  }

  const result = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(referralMoveRequests).where(eq(referralMoveRequests.id, id)).for("update");
    if (!locked || locked.status !== "PENDING") throw conflict("The request was decided meanwhile.");
    let keptCode: string | null = null;
    if (r.kind === "MEMBER" && newMemberId) keptCode = await keepMembersCode(tx, r.memberId!, newMemberId, r.toDealerId);
    const targetMemberId = r.kind === "MEMBER" ? newMemberId : r.toMemberId;
    const moved: { shopId: string; fromDealerId: string | null; franchise: string }[] = [];
    for (const shopId of movedShopIds) moved.push(await moveShop(tx, shopId, r.toDealerId, targetMemberId, at, why, actor));
    const res = { at: at.toISOString(), shops: moved, newMemberId, keptCode };
    const [row] = await tx.update(referralMoveRequests).set({ status: "APPROVED", decidedBy: actor.id, decidedAt: at, decisionNote: note, result: res, shopIds: movedShopIds }).where(eq(referralMoveRequests.id, id)).returning();
    await audit(tx, actor, row, AUDIT_ACTIONS.REFERRAL_MOVE_DECIDED, { decision: "APPROVED", note, ...res });
    return row;
  });
  return result;
}

/* ============================================================== applying a move */

/** The code a shop gets: the team member's active code, or the dealer's own. */
async function targetCode(tx: DbClient, dealerId: string, memberId: string | null): Promise<string | null> {
  const [c] = await tx
    .select({ referralCodeId: dealerCodes.referralCodeId })
    .from(dealerCodes)
    .where(and(eq(dealerCodes.dealerId, dealerId), memberId ? eq(dealerCodes.salespersonId, memberId) : isNull(dealerCodes.salespersonId), eq(dealerCodes.status, "ACTIVE")))
    .orderBy(desc(dealerCodes.createdAt))
    .limit(1);
  return c?.referralCodeId ?? null;
}

/**
 * MEMBER move: the person keeps his own referral code. His old code (closed when his old place ended) is re-opened on
 * his new place; the code made for the new place is retired.
 */
async function keepMembersCode(tx: DbClient, oldMemberId: string, newMemberId: string, toDealerId: string): Promise<string | null> {
  const [old] = await tx.select().from(dealerCodes).where(and(eq(dealerCodes.salespersonId, oldMemberId), eq(dealerCodes.kind, "SALESPERSON"))).orderBy(desc(dealerCodes.createdAt)).limit(1);
  if (!old) return null;
  const fresh = await tx.select().from(dealerCodes).where(and(eq(dealerCodes.salespersonId, newMemberId), eq(dealerCodes.status, "ACTIVE")));
  for (const f of fresh) {
    await tx.update(dealerCodes).set({ status: "RETIRED", updatedAt: new Date() }).where(eq(dealerCodes.id, f.id));
    await tx.update(referralCodes).set({ status: "INACTIVE" }).where(eq(referralCodes.id, f.referralCodeId));
  }
  await tx.update(dealerCodes).set({ dealerId: toDealerId, salespersonId: newMemberId, status: "ACTIVE", replacedById: null, updatedAt: new Date() }).where(eq(dealerCodes.id, old.id));
  await tx.update(referralCodes).set({ status: "ACTIVE" }).where(eq(referralCodes.id, old.referralCodeId));
  const [code] = await tx.select({ code: referralCodes.code }).from(referralCodes).where(eq(referralCodes.id, old.referralCodeId));
  return code?.code ?? null;
}

/**
 * Moves one shop to `toDealerId` / `toMemberId` from `at`. Earned commission stays; the plan's people (who earn the
 * parts not earned yet and renewals) become the new team's; the franchise attachment for recurring is closed at `at`
 * and the shop attaches to the new dealer's franchise in its zone, if he holds one.
 */
async function moveShop(tx: DbClient, shopId: string, toDealerId: string, toMemberId: string | null, at: Date, why: string, actor: MoveActor): Promise<{ shopId: string; fromDealerId: string | null; franchise: string }> {
  const [shop] = await tx.select().from(shops).where(eq(shops.id, shopId)).for("update");
  if (!shop || shop.deletedAt) throw notFound("Shop");
  const codeId = await targetCode(tx, toDealerId, toMemberId);
  const [before] = await tx.select().from(shopAttributions).where(eq(shopAttributions.shopId, shopId));

  // The shop's referral code.
  if (codeId) {
    await tx.update(shops).set({ referralCodeId: codeId, updatedAt: new Date() }).where(eq(shops.id, shopId));
    const [red] = await tx.select().from(referralRedemptions).where(eq(referralRedemptions.shopId, shopId));
    if (red) await tx.update(referralRedemptions).set({ referralCodeId: codeId }).where(eq(referralRedemptions.id, red.id));
    else await tx.insert(referralRedemptions).values({ referralCodeId: codeId, shopId, registrationFeePaise: shop.registrationFeePaise, redeemedBy: actor.id });
  }

  // Who the shop is with.
  const note = why.slice(0, 300);
  if (before) {
    await tx.update(shopAttributions).set({ dealerId: toDealerId, salespersonId: toMemberId, referralCodeId: codeId, source: "ADMIN", status: "ACTIVE", note, placementAt: at, updatedAt: new Date() }).where(eq(shopAttributions.shopId, shopId));
  } else {
    await tx.insert(shopAttributions).values({ shopId, dealerId: toDealerId, salespersonId: toMemberId, referralCodeId: codeId, source: "ADMIN", note, placementAt: at });
  }

  // One-time commission: what was earned stays (ledger untouched); what is not earned yet follows the new team.
  const [plan] = await tx.select().from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, shopId)).for("update");
  if (plan && plan.status !== "REVERSED") {
    const { placementFor } = await import("./tiered");
    const place = await placementFor(tx, toDealerId, toMemberId, at);
    await tx
      .update(dealerTierShopPlans)
      .set({ dealerId: toDealerId, directMemberId: place.direct?.id ?? null, leadMemberId: place.lead?.id ?? null, mainOverride: place.mainOverride, developmentId: null, developmentMemberId: null, updatedAt: new Date() })
      .where(eq(dealerTierShopPlans.shopId, shopId));
  }

  // Recurring (franchise): close the old attachment at `at`; attach to the new dealer's franchise in the zone, if any.
  const [fsa] = await tx.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shopId)).for("update");
  const { franchiseModelFor } = await import("@/server/franchise/model");
  const target = await franchiseModelFor(tx, toDealerId, shopId, at);
  let franchise = "none";
  if (fsa && fsa.status === "ACTIVE" && fsa.ownerDealerId !== toDealerId) {
    await tx.insert(franchiseShopTeamPeriods).values({ shopId, zoneId: fsa.zoneId, allocationId: fsa.allocationId, ownerDealerId: fsa.ownerDealerId, validFrom: fsa.attachedFrom, validTo: at, reason: note });
  }
  if (target && (plan || fsa)) {
    const after = { ownerDealerId: toDealerId, allocationId: target.id, zoneId: target.zoneId, origin: "TEAM" as const, memberId: toMemberId, status: "ACTIVE" as const, attachedFrom: at };
    if (fsa) await tx.update(franchiseShopAttributions).set({ ...after, holdReason: null, updatedAt: new Date() }).where(eq(franchiseShopAttributions.shopId, shopId));
    else await tx.insert(franchiseShopAttributions).values({ shopId, ...after, activatedAt: plan?.activatedAt ?? null });
    await tx.insert(franchiseShopAttributionHistory).values({ shopId, before: fsa ? { ownerDealerId: fsa.ownerDealerId, allocationId: fsa.allocationId, status: fsa.status } : null, after: { ownerDealerId: toDealerId, allocationId: target.id, attachedFrom: at.toISOString() }, reason: note, changedBy: actor.id });
    franchise = `attached to ${target.zoneId}`;
  } else if (fsa && fsa.status !== "REVERSED" && fsa.ownerDealerId !== toDealerId) {
    // The new team holds no franchise in this zone: from the move the shop earns like any free-team shop in the zone.
    await tx.update(franchiseShopAttributions).set({ status: "REVERSED", holdReason: `Moved to another team (${note})`.slice(0, 300), updatedAt: new Date() }).where(eq(franchiseShopAttributions.shopId, shopId));
    await tx.insert(franchiseShopAttributionHistory).values({ shopId, before: { ownerDealerId: fsa.ownerDealerId, allocationId: fsa.allocationId, status: fsa.status }, after: { status: "REVERSED", movedAt: at.toISOString() }, reason: note, changedBy: actor.id });
    franchise = "detached";
  }

  await recordAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.DEALER_ATTRIBUTION_CHANGED,
      entityType: "shop",
      entityId: shopId,
      previousValue: before ? { dealerId: before.dealerId, salespersonId: before.salespersonId, referralCodeId: before.referralCodeId, status: before.status } : null,
      newValue: { dealerId: toDealerId, salespersonId: toMemberId, referralCodeId: codeId, at: at.toISOString(), franchise, reason: note },
    },
    tx,
  );
  return { shopId, fromDealerId: before?.status === "ACTIVE" ? before.dealerId : null, franchise };
}

/* ============================================================== views */

export async function listMoveRequests(status?: ReferralMoveRequest["status"]) {
  const rows = await db.select().from(referralMoveRequests).where(status ? eq(referralMoveRequests.status, status) : undefined).orderBy(desc(referralMoveRequests.requestedAt)).limit(200);
  const docs = rows.length
    ? await db
        .select({ id: referralMoveDocuments.id, requestId: referralMoveDocuments.requestId, kind: referralMoveDocuments.kind, shopId: referralMoveDocuments.shopId, fileName: referralMoveDocuments.fileName, sizeBytes: referralMoveDocuments.sizeBytes, uploadedAt: referralMoveDocuments.uploadedAt })
        .from(referralMoveDocuments)
        .where(inArray(referralMoveDocuments.requestId, rows.map((r) => r.id)))
    : [];
  const dealerIds = [...new Set(rows.flatMap((r) => [r.toDealerId, r.fromDealerId, ...Object.values(r.fromDealers)]).filter((x): x is string => !!x))];
  const memberIds = [...new Set(rows.flatMap((r) => [r.memberId, r.toMemberId]).filter((x): x is string => !!x))];
  const shopIds = [...new Set(rows.flatMap((r) => r.shopIds))];
  const dealerNames = new Map((dealerIds.length ? await db.select({ id: dealers.id, name: dealers.legalName }).from(dealers).where(inArray(dealers.id, dealerIds)) : []).map((d) => [d.id, d.name]));
  const memberNames = new Map((memberIds.length ? await db.select({ id: dealerSalespeople.id, name: dealerSalespeople.name }).from(dealerSalespeople).where(inArray(dealerSalespeople.id, memberIds)) : []).map((m) => [m.id, m.name]));
  const shopNames = new Map((shopIds.length ? await db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, shopIds)) : []).map((s) => [s.id, s.name]));
  const out = [];
  for (const r of rows) {
    out.push({
      ...r,
      toDealerName: dealerNames.get(r.toDealerId) ?? null,
      fromDealerName: r.fromDealerId ? (dealerNames.get(r.fromDealerId) ?? null) : null,
      memberName: r.memberId ? (memberNames.get(r.memberId) ?? null) : null,
      toMemberName: r.toMemberId ? (memberNames.get(r.toMemberId) ?? null) : null,
      shops: r.shopIds.map((id) => ({ id, name: shopNames.get(id) ?? id, fromDealerName: r.fromDealers[id] ? (dealerNames.get(r.fromDealers[id]!) ?? null) : null })),
      documents: docs.filter((d) => d.requestId === r.id),
      missing: r.status === "PENDING" ? await missingDocuments(r) : [],
    });
  }
  return out;
}

async function audit(client: DbClient, actor: MoveActor, r: ReferralMoveRequest, action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS], value: Record<string, unknown>) {
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action, entityType: "referral_move_request", entityId: r.id, newValue: value }, client);
}

/** Approved dealers (not GoKesari's own) and their active team members — the targets of a move. */
export async function moveTargets() {
  const ds = await db.select({ id: dealers.id, name: dealers.legalName }).from(dealers).where(and(eq(dealers.status, "APPROVED"), eq(dealers.isInternal, false))).orderBy(dealers.legalName);
  const ms = ds.length
    ? await db
        .select({ id: dealerSalespeople.id, dealerId: dealerSalespeople.dealerId, name: dealerSalespeople.name, teamRole: dealerSalespeople.teamRole })
        .from(dealerSalespeople)
        .where(and(inArray(dealerSalespeople.dealerId, ds.map((d) => d.id)), eq(dealerSalespeople.status, "ACTIVE")))
        .orderBy(dealerSalespeople.name)
    : [];
  return ds.map((d) => ({ ...d, members: ms.filter((m) => m.dealerId === d.id).map(({ id, name, teamRole }) => ({ id, name, teamRole })) }));
}

/** Shops by name, phone or id (at most 20), with the team and code they are with now. */
export async function searchShopsForMove(q: string) {
  const term = q.trim().slice(0, 80);
  if (term.length < 2) return [];
  const { or, ilike, sql } = await import("drizzle-orm");
  const isUuid = /^[0-9a-f-]{36}$/i.test(term);
  const rows = await db
    .select({ id: shops.id, name: shops.name, status: shops.status, dealerId: shopAttributions.dealerId, salespersonId: shopAttributions.salespersonId, attrStatus: shopAttributions.status, code: referralCodes.code })
    .from(shops)
    .leftJoin(shopAttributions, eq(shopAttributions.shopId, shops.id))
    .leftJoin(referralCodes, eq(referralCodes.id, shops.referralCodeId))
    .where(and(isNull(shops.deletedAt), isUuid ? eq(shops.id, term) : or(ilike(shops.name, `%${term.replace(/[%_]/g, "")}%`), sql`${shops.phone} like ${"%" + term.replace(/\D/g, "").slice(-10) + "%"}`)))
    .limit(20);
  const dIds = [...new Set(rows.map((r) => r.dealerId).filter((x): x is string => !!x))];
  const names = new Map((dIds.length ? await db.select({ id: dealers.id, name: dealers.legalName }).from(dealers).where(inArray(dealers.id, dIds)) : []).map((d) => [d.id, d.name]));
  return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, code: r.code, dealerName: r.attrStatus === "ACTIVE" && r.dealerId ? (names.get(r.dealerId) ?? null) : null }));
}
