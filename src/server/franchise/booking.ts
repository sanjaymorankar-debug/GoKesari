/**
 * Franchise zone booking (final brief 21-Nov-2026 §5.5–§5.7): cart → reserve slots (15-minute hold) → pay 100%
 * online → verify → activate, renewal at the zone's current published fee, coupons, refunds, and release on
 * failure or expiry. Capacity is enforced by the database (two partial unique indexes on franchise_allocations); the
 * code takes zone rows FOR UPDATE in Zone ID order so a multi-zone cart never deadlocks, and the whole cart is
 * all-or-nothing. Every amount is computed here from the zone fees and config in force, never from the client.
 */
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import {
  FRANCHISE_AGREEMENT_TEXT,
  FRANCHISE_AGREEMENT_V2_TEXT,
  FRANCHISE_AGREEMENT_V2_VERSION,
  FRANCHISE_AGREEMENT_VERSION,
  OCCUPYING_STATUSES,
  allocationExpiry,
  formatIst,
  launchState,
  renewalOpen,
  renewedExpiry,
  rupees,
  tailEndAt,
  type LaunchState,
} from "@/lib/franchise";
import { db, type DbClient } from "@/server/db";
import {
  dealers,
  franchiseAgreementAcceptances,
  franchiseAllocationRenewals,
  franchiseAllocations,
  franchiseBookings,
  franchiseCampaigns,
  franchisePlans,
  franchiseZones,
  users,
  type Dealer,
  type FranchiseAllocation,
  type FranchiseBooking,
  type PaymentIntentRow,
  type UserRole,
} from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import type { PaymentIntentRef } from "@/server/payments/intents";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { gstOn, type CartLine } from "@/lib/franchise-zones";
import { planZoneFeePaise } from "@/lib/franchise-plans";
import { isPanEncryptionConfigured } from "@/lib/env";
import { encryptSecret, panBlindIndex } from "@/lib/pan-crypto";
import { franchiseConfig, franchiseConfigAt, franchiseNow, type FranchiseConfig } from "./config";
import { closeAllocationCodes, ensureAllocationCode } from "./codes";
import { checkCoupon, extendHold, holdRedemption, markRedemptionUsed, releaseRedemption } from "./coupons";
import { currentFee, saleProblem, syncSoldOut, zoneViews } from "./zones";

export interface Actor {
  id: string;
  role: UserRole;
}

export const AGREEMENT_SHA256 = createHash("sha256").update(FRANCHISE_AGREEMENT_TEXT.join("\n")).digest("hex");
/** Onboarding v2 rules (no 30-day KYC rule): accepted separately, so an owner who accepted the old text accepts again. */
export const AGREEMENT_V2_SHA256 = createHash("sha256").update(FRANCHISE_AGREEMENT_V2_TEXT.join("\n")).digest("hex");

/** Onboarding v2 (docs/onboarding-v2-2026-11): pay with a plan, live at payment, PAN + bank only before the first payout. */
interface OwnerOptions {
  v2?: boolean;
}

/* ============================================================= owner eligibility */

export interface OwnerStatus {
  dealer: Dealer | null;
  /** What still blocks paying. Since 22-Nov-2026 (owner: "pay first, KYC after") only a dealer account with a PAN. */
  missing: string[];
  /** What is still needed before a paid franchise goes live (KYC approval, bank) — finished after paying, within 30 days. */
  kycMissing: string[];
  agreementAccepted: boolean;
}

/** A paid franchise waits for KYC this long before the admin sees it as overdue (refund and free the zone). */
export const KYC_DAYS_AFTER_PAYMENT = 30;

const CLOSED_DEALER: readonly string[] = ["REJECTED", "SUSPENDED", "TERMINATED"];

/** What a dealer still needs before his paid franchise goes live (empty = KYC complete). */
export function kycMissingFor(dealer: Pick<Dealer, "status" | "panHash" | "bankStatus">): string[] {
  const missing: string[] = [];
  if (dealer.status !== "APPROVED") missing.push("dealer account approval (KYC documents)");
  if (!dealer.panHash) missing.push("PAN");
  if (dealer.bankStatus !== "VERIFIED") missing.push("a verified bank account");
  return missing;
}

export async function ownerStatusForUser(userId: string, client: DbClient = db, options: OwnerOptions = {}): Promise<OwnerStatus> {
  const [dealer] = await client.select().from(dealers).where(eq(dealers.userId, userId));
  if (!dealer) return { dealer: null, missing: ["your name, mobile and PAN"], kycMissing: kycMissingFor({ status: "DRAFT", panHash: null, bankStatus: "NOT_PROVIDED" }), agreementAccepted: false };
  const missing: string[] = [];
  if (dealer.isInternal) missing.push("a real dealer account (GoKesari Direct cannot book)");
  if (CLOSED_DEALER.includes(dealer.status)) missing.push(`an open dealer account (yours is ${dealer.status.toLowerCase()})`);
  // v2: PAN (with a verified bank) is needed before the first payout only (payeeStatus holds the payout).
  if (!dealer.panHash && !options.v2) missing.push("PAN");
  const version = options.v2 ? FRANCHISE_AGREEMENT_V2_VERSION : FRANCHISE_AGREEMENT_VERSION;
  const sha = options.v2 ? AGREEMENT_V2_SHA256 : AGREEMENT_SHA256;
  const [acc] = await client
    .select({ id: franchiseAgreementAcceptances.id })
    .from(franchiseAgreementAcceptances)
    .where(and(eq(franchiseAgreementAcceptances.ownerDealerId, dealer.id), eq(franchiseAgreementAcceptances.version, version), eq(franchiseAgreementAcceptances.textSha256, sha)))
    .limit(1);
  return { dealer, missing, kycMissing: kycMissingFor(dealer), agreementAccepted: !!acc };
}

async function requireOwner(actor: Actor, client: DbClient = db, options: OwnerOptions = {}): Promise<Dealer> {
  const s = await ownerStatusForUser(actor.id, client, options);
  if (!s.dealer) throw forbidden(options.v2 ? "Start from Become a franchisee (your registered shop's details make your account)." : "Give your name, mobile and PAN first — then you can pay for franchise zones.");
  if (s.missing.length) throw forbidden(`Before paying, complete: ${s.missing.join(", ")}.`);
  return s.dealer;
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/**
 * Paid franchise, pay first (owner 22-Nov-2026): the smallest dealer account a buyer needs to pay — name, mobile
 * and PAN, saved as a DRAFT dealer application he completes after paying (/dealer/apply). An existing open
 * application only gets the PAN added when it has none.
 */
export async function startFranchiseBuyer(actor: Actor & { email: string | null }, input: { name: string; mobile: string; pan: string }): Promise<Dealer> {
  if (!isPanEncryptionConfigured()) throw conflict("Franchise payments are not available on this site yet (secure storage is not set up).");
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 120);
  const mobile = input.mobile.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  const pan = input.pan.replace(/\s/g, "").toUpperCase();
  const fields: Record<string, string> = {};
  if (name.length < 3) fields.name = "Your full name.";
  if (!/^[6-9]\d{9}$/.test(mobile)) fields.mobile = "A 10-digit Indian mobile number.";
  if (!PAN_RE.test(pan)) fields.pan = "PAN like ABCDE1234F.";
  if (Object.keys(fields).length) throw validationFailed("Please check your details.", { fields });
  const panHash = panBlindIndex(pan);
  const [taken] = await db.select({ id: dealers.id, userId: dealers.userId }).from(dealers).where(and(eq(dealers.panHash, panHash), ne(dealers.status, "REJECTED"))).limit(1);
  if (taken && taken.userId !== actor.id) throw conflict("A dealer with this PAN is already registered. Sign in with that account.");
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(dealers).where(eq(dealers.userId, actor.id)).for("update");
    const now = new Date();
    let dealer: Dealer;
    if (existing) {
      if (existing.isInternal || CLOSED_DEALER.includes(existing.status)) throw conflict("This dealer account cannot book franchise zones.");
      if (existing.panHash) return existing;
      [dealer] = await tx.update(dealers).set({ panEnc: encryptSecret(pan), panHash, panLast4: pan.slice(-4), updatedAt: now }).where(eq(dealers.id, existing.id)).returning();
    } else {
      [dealer] = await tx
        .insert(dealers)
        .values({ userId: actor.id, legalName: name, contactName: name, dealerType: "INDIVIDUAL", mobileE164: `+91${mobile}`, email: actor.email, emailVerifiedAt: actor.email ? now : null, panEnc: encryptSecret(pan), panHash, panLast4: pan.slice(-4), status: "DRAFT", source: "APPLICATION" })
        .returning();
    }
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_APPLICATION_SAVED, entityType: "dealer", entityId: dealer.id, previousValue: existing ? { panGiven: false } : null, newValue: { status: dealer.status, via: "franchise_pay_first", panLast4: pan.slice(-4) } }, tx);
    return dealer;
  });
}

/**
 * A franchise paid before KYC goes live once the owner's KYC and bank are approved: his franchise code, his team's
 * earlier shops in the zone (upgrade), and commission from now. Called on the admin's approval, on the bank check and
 * by the daily job; idempotent. Returns the zones that went live.
 */
export async function goLiveAfterKyc(ownerDealerId: string, client: DbClient = db): Promise<string[]> {
  const [dealer] = await client.select().from(dealers).where(eq(dealers.id, ownerDealerId));
  if (!dealer || kycMissingFor(dealer).length) return [];
  const waiting = await client.select().from(franchiseAllocations).where(and(eq(franchiseAllocations.ownerDealerId, ownerDealerId), isNotNull(franchiseAllocations.kycDueAt), inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"])));
  if (!waiting.length) return [];
  const now = new Date();
  const live: string[] = [];
  for (const a of waiting) {
    await client.update(franchiseAllocations).set({ kycDueAt: null, kycClearedAt: now, updatedAt: now }).where(eq(franchiseAllocations.id, a.id));
    await ensureAllocationCode(client, a);
    await attachUpgradeShops(client, { ...a, activatedAt: now });
    live.push(a.zoneId);
  }
  await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_ALLOCATION_CHANGED, entityType: "dealer", entityId: ownerDealerId, newValue: { liveAfterKyc: live, at: now.toISOString() } }, client);
  // A caller inside a transaction tells the owner itself after the commit (no side effects inside db.transaction).
  if (client === db)
    await tellOwner(ownerDealerId, "Your franchise is live", `KYC approved — ${live.join(", ")} ${live.length === 1 ? "is" : "are"} live. Your franchise code is on your franchise page.`, `franchise-live:${ownerDealerId}:${live.join(",")}`).catch((e) => console.error("[franchise] live notice failed", ownerDealerId, e));
  return live;
}

/** Hourly (franchise job): franchises whose KYC is now complete go live; returns those still waiting, with days left. */
export async function sweepFranchiseKyc(now = new Date()): Promise<{ live: number; waiting: { id: string; zoneId: string; bookingId: string; ownerDealerId: string; dueAt: Date; daysLeft: number }[] }> {
  const owners = await db.selectDistinct({ id: franchiseAllocations.ownerDealerId }).from(franchiseAllocations).where(and(isNotNull(franchiseAllocations.kycDueAt), inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"])));
  let live = 0;
  for (const o of owners) live += (await goLiveAfterKyc(o.id)).length;
  const rows = await db
    .select({ id: franchiseAllocations.id, zoneId: franchiseAllocations.zoneId, bookingId: franchiseAllocations.bookingId, ownerDealerId: franchiseAllocations.ownerDealerId, dueAt: franchiseAllocations.kycDueAt })
    .from(franchiseAllocations)
    .where(
      and(
        isNotNull(franchiseAllocations.kycDueAt),
        inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"]),
        eq(franchiseAllocations.isTest, false),
        // Onboarding v2 bookings (with a plan) have no 30-day KYC rule: never reminded nor reported overdue.
        sql`not exists (select 1 from franchise_bookings b where b.id = ${franchiseAllocations.bookingId} and b.plan_id is not null)`,
      ),
    );
  const waiting = rows.map((r) => ({ ...r, dueAt: r.dueAt!, daysLeft: Math.ceil((r.dueAt!.getTime() - now.getTime()) / 86_400_000) }));
  return { live, waiting };
}

/** Clickwrap (brief §4.5 step 4): version, text hash, IP and device are stored. */
export async function acceptFranchiseAgreement(actor: Actor, version: string, device: { ipAddress?: string | null; userAgent?: string | null }): Promise<{ id: string }> {
  if (version !== FRANCHISE_AGREEMENT_VERSION && version !== FRANCHISE_AGREEMENT_V2_VERSION) throw conflict("The agreement has changed — please read the current version.");
  const sha = version === FRANCHISE_AGREEMENT_V2_VERSION ? AGREEMENT_V2_SHA256 : AGREEMENT_SHA256;
  const s = await ownerStatusForUser(actor.id);
  if (!s.dealer) throw forbidden("Register as a GoKesari dealer first.");
  const [row] = await db
    .insert(franchiseAgreementAcceptances)
    .values({ ownerDealerId: s.dealer.id, userId: actor.id, version, textSha256: sha, ipAddress: device.ipAddress?.slice(0, 64) ?? null, userAgent: device.userAgent?.slice(0, 300) ?? null })
    .returning({ id: franchiseAgreementAcceptances.id });
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_AGREEMENT_ACCEPTED, entityType: "dealer", entityId: s.dealer.id, newValue: { version, sha256: sha, ip: device.ipAddress ?? null } });
  return row;
}

/* ============================================================= launch offer */

interface LaunchCounts {
  owners: number;
  areas: number;
  pendingAreas: number;
  pendingOwners: string[];
  closedAt: Date | null;
}

async function launchCounts(client: DbClient, now: Date): Promise<LaunchCounts> {
  const [paid] = await client
    .select({ owners: sql<number>`count(distinct ${franchiseAllocations.ownerDealerId})::int`, areas: sql<number>`count(*)::int` })
    .from(franchiseAllocations)
    .where(and(eq(franchiseAllocations.launchOffer, true), eq(franchiseAllocations.isTest, false), isNotNull(franchiseAllocations.activatedAt)));
  const pending = await client
    .select({ owner: franchiseAllocations.ownerDealerId })
    .from(franchiseAllocations)
    .where(
      and(
        eq(franchiseAllocations.launchOffer, true),
        eq(franchiseAllocations.isTest, false),
        sql`(${franchiseAllocations.status} = 'PAYMENT_PENDING_VERIFICATION' or (${franchiseAllocations.status} = 'RESERVED' and ${franchiseAllocations.holdExpiresAt} > ${now.toISOString()}::timestamptz))`,
      ),
    );
  const [campaign] = await client.select().from(franchiseCampaigns).where(eq(franchiseCampaigns.code, "LAUNCH"));
  return { owners: Number(paid?.owners ?? 0), areas: Number(paid?.areas ?? 0), pendingAreas: pending.length, pendingOwners: [...new Set(pending.map((p) => p.owner))], closedAt: campaign?.closedAt ?? null };
}

export interface OfferView {
  bookingOpen: boolean;
  launch: LaunchState;
  /** §5.3: zones with a provisional fee can be bought only when this is on. */
  allowProvisionalSale: boolean;
  gstRateBp: number;
  validityMonths: number;
  maxOwnersPerZone: number;
  holdMinutes: number;
  maxZonesPerBooking: number;
  /** The launch-offer fee for every zone while the offer is open, else null. */
  promoFeePaise: number | null;
  closedMessage: string | null;
}

export async function offerView(client: DbClient = db): Promise<OfferView> {
  const { config } = await franchiseConfig(client);
  const now = franchiseNow(config);
  const c = await launchCounts(client, now);
  const launch = launchState({ owners: c.owners, areas: c.areas, maxOwners: config.launchMaxOwners, maxAreas: config.launchMaxAreas, closeRule: config.launchCloseRule, closedAt: c.closedAt });
  // §4 / §5.5: the zone fees are the launch offer for the first 25 dealers; later terms are never shown.
  const closedMessage = !config.bookingOpen ? "Bookings open soon." : !launch.open ? "Launch offer closed – new terms coming soon." : null;
  return { bookingOpen: config.bookingOpen && launch.open, launch, allowProvisionalSale: config.allowProvisionalSale, gstRateBp: config.gstRateBp, validityMonths: config.validityMonths, maxOwnersPerZone: config.maxOwnersPerZone, holdMinutes: config.reservationHoldMinutes, maxZonesPerBooking: config.maxAreasPerBooking, promoFeePaise: launch.open ? config.promoFeePaise : null, closedMessage };
}

/** The cart's amounts (§5.7): list fees − coupon discount = taxable; GST on the taxable amount; total. */
export function cartAmounts(lines: readonly { listPaise: number; discountPaise: number }[], gstRateBp: number) {
  const listPaise = lines.reduce((s, l) => s + l.listPaise, 0);
  const discountPaise = lines.reduce((s, l) => s + l.discountPaise, 0);
  const basePaise = listPaise - discountPaise;
  const gstPaise = gstOn(basePaise, gstRateBp);
  return { areaCount: lines.length, listPaise, discountPaise, basePaise, gstRateBp, gstPaise, totalPaise: basePaise + gstPaise };
}

/* ============================================================= reserve (cart) */

export interface ReserveResult {
  booking: FranchiseBooking;
  allocations: FranchiseAllocation[];
}

/**
 * Reserves one slot in each zone of the cart for the hold time (§5.5). All-or-nothing: if any zone cannot be bought
 * (status, reserved for someone else, sold out, fee still provisional, already held by this owner), nothing is
 * reserved and the zones are named. An optional coupon is validated here and held with the slots.
 */
export async function reserveZones(actor: Actor, input: { zoneIds: string[]; couponCode?: string | null; test?: boolean; planId?: string | null }): Promise<ReserveResult> {
  // Onboarding v2: a subscription plan is mandatory there and marks the booking (plan_id) — live at payment, no KYC wait.
  const plan = input.planId ? await planForBooking(input.planId) : null;
  const v2 = !!plan;
  const owner = await requireOwner(actor, db, { v2 });
  const { version, config } = await franchiseConfig();
  const zoneIds = [...new Set(input.zoneIds.map((z) => z.trim().toUpperCase()))].filter(Boolean);
  if (!zoneIds.length) throw validationFailed("Choose at least one zone.");
  if (zoneIds.length > config.maxAreasPerBooking) throw validationFailed(`Book at most ${config.maxAreasPerBooking} zones at a time.`);
  const isTest = !!input.test;
  if (isTest && actor.role !== "ADMIN") throw forbidden("Only an admin can book the test zone.");
  if (!config.bookingOpen && !isTest) throw conflict("Franchise bookings are not open yet.");
  const status = await ownerStatusForUser(actor.id, db, { v2 });
  if (!status.agreementAccepted) throw conflict("Accept the franchise responsibilities and rules first.");

  const result = await db.transaction(async (tx) => {
    const now = franchiseNow(config);
    // Launch counters are serialised with activation (one place at a time).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('franchise-launch'))`);
    const c = await launchCounts(tx, now);
    const launch = launchState({ owners: c.owners, areas: c.areas, maxOwners: config.launchMaxOwners, maxAreas: config.launchMaxAreas, closeRule: config.launchCloseRule, closedAt: c.closedAt });
    let launchOffer = false;
    // A plan that is not the launch offer is sold outside the launch counter (DEFAULT – confirm with Sanjay).
    if (!isTest && (!plan || plan.isLaunchOffer)) {
      if (!launch.open) throw conflict("Launch offer closed – new terms coming soon. WhatsApp or call +91 91751 93009.");
      // Places still free once pending reservations are counted (so the 25th place is never sold twice).
      const ownerIsNew = !(await ownerHasLaunchArea(tx, owner.id)) && !c.pendingOwners.includes(owner.id);
      const areasLeft = config.launchMaxAreas - c.areas - c.pendingAreas;
      const ownersLeft = config.launchMaxOwners - c.owners - c.pendingOwners.length;
      const areasOk = config.launchCloseRule === "owners_only" || areasLeft >= zoneIds.length;
      const ownersOk = config.launchCloseRule === "areas_only" || !ownerIsNew || ownersLeft >= 1;
      if (!areasOk || !ownersOk) {
        throw conflict(areasLeft > 0 && ownersOk ? `Only ${areasLeft} launch place${areasLeft === 1 ? "" : "s"} left (some are being paid for now). Choose fewer zones or try again in 15 minutes.` : "The last launch places are being paid for right now. Try again in 15 minutes.");
      }
      launchOffer = true;
    }

    // Lock the zones in Zone ID order (no deadlock between two carts), then free expired holds under the lock.
    const locked = await tx.select().from(franchiseZones).where(inArray(franchiseZones.zoneId, zoneIds)).orderBy(asc(franchiseZones.zoneId)).for("update");
    const missingIds = zoneIds.filter((z) => !locked.some((l) => l.zoneId === z));
    if (missingIds.length) throw validationFailed(`Unknown zone${missingIds.length > 1 ? "s" : ""}: ${missingIds.join(", ")}.`);
    await releaseExpiredHolds(tx, now, zoneIds);
    const views = await zoneViews({ zoneIds, includeTest: isTest, includeInactive: true, client: tx });

    const problems: string[] = [];
    const lines0: { zoneId: string; slotNo: number; line: CartLine; feeVersionId: string }[] = [];
    for (const zone of locked) {
      const v = views.find((x) => x.zoneId === zone.zoneId);
      if (!v || !config.zoneSetsEnabled.includes(zone.zoneSetCode)) {
        problems.push(`${zone.zoneId} is not open for booking`);
        continue;
      }
      if (zone.isTest !== isTest) {
        problems.push(`${zone.zoneId} cannot be booked here`);
        continue;
      }
      const taken = await tx
        .select({ slotNo: franchiseAllocations.slotNo, owner: franchiseAllocations.ownerDealerId })
        .from(franchiseAllocations)
        .where(and(eq(franchiseAllocations.zoneId, zone.zoneId), inArray(franchiseAllocations.status, [...OCCUPYING_STATUSES])));
      if (taken.some((t) => t.owner === owner.id)) {
        problems.push(`you already hold or are booking ${zone.zoneId}`);
        continue;
      }
      const why = saleProblem(v, owner.id, now, config.allowProvisionalSale);
      if (why) {
        problems.push(why === "Fees being finalised" ? `${zone.zoneId}: fees being finalised` : why.replace(/\.$/, ""));
        continue;
      }
      const free = [1, 2].filter((s) => s <= zone.maxOwners && !taken.some((t) => t.slotNo === s));
      const listPaise = plan ? planZoneFeePaise(plan, v, config.gstRateBp) : v.feePaise;
      if (!free.length) problems.push(`${zone.zoneId} is sold out`);
      else if (listPaise == null) problems.push(`${zone.zoneId} has no fee yet`);
      else lines0.push({ zoneId: zone.zoneId, slotNo: free[0], line: { zoneId: zone.zoneId, zoneSetCode: zone.zoneSetCode, tier: v.tier!, listPaise }, feeVersionId: v.feeVersionId! });
    }
    if (problems.length) throw conflict(`Nothing was reserved: ${problems.join("; ")}. Remove ${problems.length > 1 ? "these zones" : "this zone"} and try again.`);

    // §5.7: one coupon per order, validated on the server; the discount comes off the fees before GST.
    const coupon = input.couponCode?.trim() ? await checkCoupon(input.couponCode, { dealerId: owner.id, kind: "NEW", lines: lines0.map((p) => p.line), launchEligible: launchOffer, now }, tx) : null;
    const lines = lines0.map((p, i) => ({ ...p, listPaise: p.line.listPaise, discountPaise: coupon?.discounts[i] ?? 0 }));
    const amounts = cartAmounts(lines, config.gstRateBp);
    const holdExpiresAt = new Date(now.getTime() + config.reservationHoldMinutes * 60_000);
    const [booking] = await tx
      .insert(franchiseBookings)
      .values({ ownerDealerId: owner.id, kind: "NEW", status: "RESERVED", ...amounts, couponId: coupon?.coupon.id ?? null, couponCode: coupon?.coupon.code ?? null, configVersion: version, launchOffer, holdExpiresAt, isTest, createdBy: actor.id, planId: plan?.id ?? null })
      .returning();
    const allocations = await tx
      .insert(franchiseAllocations)
      .values(lines.map((l) => ({ zoneId: l.zoneId, slotNo: l.slotNo, ownerDealerId: owner.id, bookingId: booking.id, status: "RESERVED" as const, holdExpiresAt, feePaise: l.listPaise, discountPaise: l.discountPaise, tier: l.line.tier, feeVersionId: l.feeVersionId, configVersion: version, launchOffer, isTest })))
      .returning();
    if (coupon) await holdRedemption(tx, { couponId: coupon.coupon.id, dealerId: owner.id, bookingId: booking.id, discountPaise: amounts.discountPaise, heldUntil: holdExpiresAt });
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_BOOKING_CHANGED, entityType: "franchise_booking", entityId: booking.id, newValue: { reserved: lines.map((l) => ({ zoneId: l.zoneId, slotNo: l.slotNo, tier: l.line.tier, listPaise: l.listPaise, discountPaise: l.discountPaise })), coupon: coupon?.coupon.code ?? null, ...amounts, launchOffer, holdExpiresAt: holdExpiresAt.toISOString(), configVersion: version, isTest, plan: plan?.code ?? null } },
      tx,
    );
    return { booking, allocations };
  }).catch((e: unknown) => {
    // A race lost to the unique indexes (another cart took the last slot between the read and the insert).
    if (/franchise_allocations_(slot|owner)_unique/.test(String((e as Error)?.message ?? "")) || (e as { code?: string })?.code === "23505") {
      throw conflict("Another owner took one of these zones a moment ago. Refresh and try again.");
    }
    throw e;
  });
  return result;
}

/** Checks a coupon against a cart before reserving (the cart page's "Apply"): the discount per zone and the totals. */
export async function previewCart(actor: Actor, input: { zoneIds: string[]; couponCode?: string | null; planId?: string | null }) {
  const plan = input.planId ? await planForBooking(input.planId) : null;
  // A new buyer may see the price before giving his details (pay first, 22-Nov-2026); a closed account may not.
  const status = await ownerStatusForUser(actor.id, db, { v2: !!plan });
  if (status.dealer && status.missing.some((m) => m !== "PAN")) throw forbidden(`Before paying, complete: ${status.missing.join(", ")}.`);
  const owner = { id: status.dealer?.id ?? "" };
  if (input.couponCode?.trim() && !status.dealer) throw validationFailed("Give your name, mobile and PAN first, then apply the coupon.");
  const { config } = await franchiseConfig();
  const zoneIds = [...new Set(input.zoneIds.map((z) => z.trim().toUpperCase()))].filter(Boolean);
  const views = await zoneViews({ zoneIds });
  const now = franchiseNow(config);
  const lines: CartLine[] = [];
  const problems: string[] = [];
  for (const id of zoneIds) {
    const v = views.find((x) => x.zoneId === id);
    const why = v ? saleProblem(v, owner.id, now, config.allowProvisionalSale) : `${id} is not open for booking`;
    const listPaise = v && plan ? planZoneFeePaise(plan, v, config.gstRateBp) : v?.feePaise;
    if (why || !v) problems.push(why ?? id);
    else if (listPaise == null) problems.push(`${v.zoneId} has no fee yet.`);
    else lines.push({ zoneId: v.zoneId, zoneSetCode: v.zoneSetCode, tier: v.tier!, listPaise });
  }
  const launch = (await offerView()).launch;
  const launchEligible = launch.open && (!plan || plan.isLaunchOffer);
  const coupon = input.couponCode?.trim() && lines.length ? await checkCoupon(input.couponCode, { dealerId: owner.id, kind: "NEW", lines, launchEligible }) : null;
  const priced = lines.map((l, i) => ({ ...l, discountPaise: coupon?.discounts[i] ?? 0 }));
  return { lines: priced, problems, coupon: coupon ? { code: coupon.coupon.code, name: coupon.coupon.name } : null, plan: plan ? { id: plan.id, code: plan.code, name: plan.name, durationMonths: plan.durationMonths } : null, ...cartAmounts(priced, config.gstRateBp) };
}

/**
 * Onboarding v2: the active plan a booking is bought on. Refused while the onboarding_v2 flag is off (OFF = exactly
 * today's booking) or when the plan is inactive / unknown.
 */
export async function planForBooking(planId: string, client: DbClient = db) {
  const { onboardingV2Enabled } = await import("@/server/onboarding-v2/roles");
  if (!(await onboardingV2Enabled())) throw conflict("Subscription plans are not open yet.");
  const [plan] = /^[0-9a-f-]{36}$/i.test(planId) ? await client.select().from(franchisePlans).where(eq(franchisePlans.id, planId)) : [];
  if (!plan || !plan.active) throw validationFailed("Choose one of the subscription plans on offer.", { fields: { planId: "Not available." } });
  return plan;
}

async function ownerHasLaunchArea(client: DbClient, ownerId: string): Promise<boolean> {
  const [r] = await client.select({ id: franchiseAllocations.id }).from(franchiseAllocations).where(and(eq(franchiseAllocations.ownerDealerId, ownerId), eq(franchiseAllocations.launchOffer, true), isNotNull(franchiseAllocations.activatedAt))).limit(1);
  return !!r;
}

/** Frees reservations whose hold ran out (also run by the every-minute job). Returns the count. */
export async function releaseExpiredHolds(client: DbClient, now: Date, zoneIds?: string[]): Promise<number> {
  const expired = await client
    .update(franchiseAllocations)
    .set({ status: "RESERVATION_EXPIRED", endedAt: now, endReason: "hold expired", updatedAt: now })
    .where(and(eq(franchiseAllocations.status, "RESERVED"), lte(franchiseAllocations.holdExpiresAt, now), zoneIds?.length ? inArray(franchiseAllocations.zoneId, zoneIds) : undefined))
    .returning({ bookingId: franchiseAllocations.bookingId });
  const bookingIds = [...new Set(expired.map((e) => e.bookingId))];
  if (bookingIds.length) {
    await client.update(franchiseBookings).set({ status: "EXPIRED", failureReason: "hold expired before payment", updatedAt: now }).where(and(inArray(franchiseBookings.id, bookingIds), eq(franchiseBookings.status, "RESERVED")));
  }
  // A renewal booking holds no slot: it just lapses.
  const lapsed = await client.update(franchiseBookings).set({ status: "EXPIRED", failureReason: "not paid in time", updatedAt: now }).where(and(eq(franchiseBookings.status, "RESERVED"), eq(franchiseBookings.kind, "RENEWAL"), lte(franchiseBookings.holdExpiresAt, now))).returning({ id: franchiseBookings.id });
  // §5.7: the coupon use of a booking that was never paid is released.
  for (const id of [...bookingIds, ...lapsed.map((l) => l.id)]) await releaseRedemption(client, id, "hold expired before payment", now);
  return expired.length;
}

/** The owner gives up a reservation before paying: the slots are free at once. */
export async function cancelReservation(bookingId: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(franchiseBookings).where(eq(franchiseBookings.id, bookingId)).for("update");
    if (!booking) throw notFound("Booking");
    const owner = await ownerStatusForUser(actor.id, tx);
    if (actor.role !== "ADMIN" && booking.ownerDealerId !== owner.dealer?.id) throw notFound("Booking");
    if (booking.status !== "RESERVED") throw conflict(booking.status === "PAYMENT_PENDING" ? "The payment has started; it is released automatically if it does not complete." : "This booking is no longer open.");
    const now = new Date();
    await tx.update(franchiseBookings).set({ status: "CANCELLED", failureReason: "cancelled before payment", updatedAt: now }).where(eq(franchiseBookings.id, bookingId));
    await tx.update(franchiseAllocations).set({ status: "CANCELLED", endedAt: now, endReason: "reservation cancelled", updatedAt: now }).where(and(eq(franchiseAllocations.bookingId, bookingId), eq(franchiseAllocations.status, "RESERVED")));
    await releaseRedemption(tx, bookingId, "reservation cancelled", now);
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_BOOKING_CHANGED, entityType: "franchise_booking", entityId: bookingId, newValue: { cancelled: true } }, tx);
  });
}

/* ============================================================= pay */

/** Opens the gateway payment for a reserved booking (amount from the booking, never from the client). */
export async function startBookingPayment(bookingId: string, actor: Actor) {
  const [booking] = await db.select().from(franchiseBookings).where(eq(franchiseBookings.id, bookingId));
  if (!booking) throw notFound("Booking");
  const owner = await requireOwner(actor, db, { v2: !!booking.planId });
  if (booking.ownerDealerId !== owner.id) throw notFound("Booking");
  const { config } = await franchiseConfig();
  const now = franchiseNow(config);
  if (booking.status === "PAYMENT_PENDING" && booking.paymentIntentId) {
    // The same payment again (idempotent key): the gateway session is reused.
  } else if (booking.status !== "RESERVED") {
    throw conflict(booking.status === "PAID" ? "This booking is already paid." : "This reservation has ended. Please reserve again.");
  } else if (booking.holdExpiresAt.getTime() <= now.getTime()) {
    throw conflict("The 15-minute hold ran out before payment. Please reserve again.");
  }
  // §5.7: the coupon is checked again when the payment starts; a code no longer valid cancels the reservation.
  if (booking.couponCode && booking.status === "RESERVED") {
    const allocs = await db.select({ zoneId: franchiseAllocations.zoneId, fee: franchiseAllocations.feePaise, tier: franchiseAllocations.tier, set: franchiseZones.zoneSetCode }).from(franchiseAllocations).innerJoin(franchiseZones, eq(franchiseZones.zoneId, franchiseAllocations.zoneId)).where(eq(franchiseAllocations.bookingId, booking.id));
    const lines: CartLine[] = booking.kind === "RENEWAL" ? await renewalLines(booking) : allocs.map((a) => ({ zoneId: a.zoneId, zoneSetCode: a.set, tier: a.tier, listPaise: Number(a.fee) }));
    try {
      await checkCoupon(booking.couponCode, { dealerId: owner.id, kind: booking.kind, lines, launchEligible: booking.launchOffer, excludeBookingId: booking.id, now });
    } catch (e) {
      await cancelReservation(booking.id, actor).catch(() => {});
      throw conflict(`${e instanceof Error ? e.message : "The coupon is no longer valid."} Your reservation was released — reserve again without it.`);
    }
    await extendHold(db, booking.id, new Date(now.getTime() + 2 * 60 * 60_000));
  }
  const [u] = await db.select({ name: users.name, email: users.email, phone: users.phone }).from(users).where(eq(users.id, actor.id));
  const zones = booking.kind === "NEW" ? (await db.select({ zoneId: franchiseAllocations.zoneId }).from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, booking.id))).map((a) => a.zoneId) : [];
  const { createPaymentIntent } = await import("@/server/payments/intents");
  const created = await createPaymentIntent({
    purpose: "FRANCHISE_FEE",
    referenceId: booking.id,
    userId: actor.id,
    amountPaise: booking.totalPaise,
    customer: { id: actor.id, name: u?.name ?? null, email: u?.email ?? null, phone: u?.phone ?? null },
    description: booking.kind === "RENEWAL" ? "GoKesari franchise renewal (12 months)" : `GoKesari franchise — ${zones.join(", ")}${booking.planId ? ` (${(await db.select({ name: franchisePlans.name }).from(franchisePlans).where(eq(franchisePlans.id, booking.planId)))[0]?.name ?? "plan"})` : ""}${booking.couponCode ? ` (coupon ${booking.couponCode})` : ""}`,
    idempotencyKey: `franchise-booking:${booking.id}`,
    mode: "CHECKOUT",
    returnPath: `/franchise/my?booking=${booking.id}`,
  });
  await db.transaction(async (tx) => {
    const t = new Date();
    const moved = await tx
      .update(franchiseBookings)
      .set({ status: "PAYMENT_PENDING", paymentIntentId: created.intent.id, updatedAt: t })
      .where(and(eq(franchiseBookings.id, booking.id), inArray(franchiseBookings.status, ["RESERVED", "PAYMENT_PENDING"])))
      .returning({ id: franchiseBookings.id });
    if (moved.length && booking.kind === "NEW") {
      await tx.update(franchiseAllocations).set({ status: "PAYMENT_PENDING_VERIFICATION", updatedAt: t }).where(and(eq(franchiseAllocations.bookingId, booking.id), eq(franchiseAllocations.status, "RESERVED")));
    }
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_BOOKING_CHANGED, entityType: "franchise_booking", entityId: booking.id, newValue: { paymentStarted: created.intent.id, amountPaise: booking.totalPaise } }, tx);
  });
  return created;
}

/* ============================================================= captured / ended */

/**
 * Purpose handler, inside the capture transaction (brief §4.5 steps 6–8). Idempotent: a duplicate webhook
 * finds the booking PAID and does nothing. Activation time = the verified payment time (now).
 */
export async function onFranchiseFeeCaptured(intent: PaymentIntentRef, client: DbClient, afterCommit?: (task: () => Promise<void>) => void): Promise<void> {
  const [booking] = await client.select().from(franchiseBookings).where(eq(franchiseBookings.id, intent.referenceId)).for("update");
  if (!booking || booking.status === "PAID") return;
  if (intent.amountPaise !== booking.totalPaise || (booking.paymentIntentId && booking.paymentIntentId !== intent.id)) {
    await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_BOOKING_CHANGED, entityType: "franchise_booking", entityId: booking.id, newValue: { problem: "amount_or_intent_mismatch", intentId: intent.id, intentAmount: intent.amountPaise, bookingTotal: booking.totalPaise } }, client);
    return;
  }
  const { config } = await franchiseConfigAt(new Date(), client);
  const now = franchiseNow(config);
  const bookingConfig = await franchiseConfigAt(booking.createdAt, client);
  const notices: (() => Promise<void>)[] = [];

  if (booking.kind === "RENEWAL") {
    const [alloc] = await client.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, booking.renewalAllocationId!)).for("update");
    if (!alloc || !alloc.expiresAt || !["ACTIVE", "SUSPENDED"].includes(alloc.status)) {
      await client.update(franchiseBookings).set({ status: "PAID", paidAt: now, failureReason: "paid after the area ended — refund due", updatedAt: now }).where(eq(franchiseBookings.id, booking.id));
      await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_ALLOCATION_CHANGED, entityType: "franchise_allocation", entityId: booking.renewalAllocationId ?? booking.id, newValue: { problem: "renewal_paid_after_end", bookingId: booking.id, refundDue: booking.totalPaise } }, client);
      return;
    }
    const newExpiry = renewedExpiry(alloc.expiresAt, bookingConfig.config.validityMonths);
    const tail = tailEndAt({ chainStartAt: alloc.activatedAt!, expiresAt: newExpiry, mode: config.tailMode, tailYears: config.tailYears });
    // §5.5: the renewal pays the zone's current list fee, locked for the new term (the coupon is this payment only).
    const fee = await currentFee(alloc.zoneId, client);
    await client
      .update(franchiseAllocations)
      .set({ periodStart: alloc.expiresAt, expiresAt: newExpiry, tailEndAt: tail, renewalCount: alloc.renewalCount + 1, feePaise: booking.listPaise, discountPaise: booking.discountPaise, tier: fee?.tier ?? alloc.tier, feeVersionId: fee?.id ?? alloc.feeVersionId, updatedAt: now })
      .where(eq(franchiseAllocations.id, alloc.id));
    await client.insert(franchiseAllocationRenewals).values({ allocationId: alloc.id, bookingId: booking.id, previousExpiresAt: alloc.expiresAt, newExpiresAt: newExpiry, feePaise: booking.listPaise, discountPaise: booking.discountPaise, tier: fee?.tier ?? alloc.tier, paidAt: now });
    await client.update(franchiseBookings).set({ status: "PAID", paidAt: now, updatedAt: now }).where(eq(franchiseBookings.id, booking.id));
    await markRedemptionUsed(client, booking.id, now);
    await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_ALLOCATION_CHANGED, entityType: "franchise_allocation", entityId: alloc.id, previousValue: { expiresAt: alloc.expiresAt.toISOString() }, newValue: { renewed: true, expiresAt: newExpiry.toISOString(), bookingId: booking.id, intentId: intent.id } }, client);
    notices.push(() => tellOwner(booking.ownerDealerId, "Franchise area renewed", `Zone ${alloc.zoneId} is renewed until ${formatIst(newExpiry)}. Receipt: /franchise/my/receipt/${booking.id}`, `franchise-renewed:${booking.id}`));
  } else {
    await client.execute(sql`select pg_advisory_xact_lock(hashtext('franchise-launch'))`);
    const allocations = await client.select().from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, booking.id)).orderBy(asc(franchiseAllocations.zoneId)).for("update");
    // Onboarding v2: the plan's term; no plan = the configured validity, as before.
    const [plan] = booking.planId ? await client.select().from(franchisePlans).where(eq(franchisePlans.id, booking.planId)) : [];
    const months = plan?.durationMonths ?? bookingConfig.config.validityMonths;
    const expiresAt = allocationExpiry(now, months);
    const tail = tailEndAt({ chainStartAt: now, expiresAt, mode: config.tailMode, tailYears: config.tailYears });
    const counts = booking.launchOffer && !booking.isTest ? await launchCounts(client, now) : null;
    // Pay first, KYC after (owner 22-Nov-2026): without approved KYC + bank the zone is his but not live yet.
    // Onboarding v2 (booking with a plan): live at payment — the dealer account is approved now, the code issued now,
    // no kyc_due_at; PAN and the payout bank are asked before the first payout (payeeStatus holds it until then).
    let [ownerRow] = await client.select().from(dealers).where(eq(dealers.id, booking.ownerDealerId));
    if (booking.planId && ownerRow) {
      const v2 = await import("@/server/onboarding-v2/franchise");
      ownerRow = (await v2.approveDealerInstantly(client, ownerRow, "franchisee_paid", "Onboarding v2: paid franchise live at payment")).dealer;
    }
    const kycPending = booking.planId ? false : !ownerRow || kycMissingFor(ownerRow).length > 0;
    const kycDueAt = kycPending ? new Date(now.getTime() + KYC_DAYS_AFTER_PAYMENT * 86_400_000) : null;
    let seq = counts?.areas ?? 0;
    const activated: string[] = [];
    const lost: string[] = [];
    for (const a of allocations) {
      if (a.status === "ACTIVE") continue;
      // A late capture after the hold was released: take the slot back only if it is still free.
      if (!["RESERVED", "PAYMENT_PENDING_VERIFICATION"].includes(a.status)) {
        const ok = await client
          .transaction(async (sp) => {
            await sp.update(franchiseAllocations).set({ status: "PAYMENT_PENDING_VERIFICATION", endedAt: null, endReason: null, updatedAt: now }).where(eq(franchiseAllocations.id, a.id));
            return true;
          })
          .catch(() => false);
        if (!ok) {
          lost.push(a.zoneId);
          continue;
        }
      }
      seq += 1;
      await client
        .update(franchiseAllocations)
        .set({ status: "ACTIVE", holdExpiresAt: null, activatedAt: now, periodStart: now, expiresAt, tailEndAt: tail, launchSeq: booking.launchOffer && !booking.isTest ? seq : null, kycDueAt, updatedAt: now })
        .where(eq(franchiseAllocations.id, a.id));
      if (!kycPending) {
        // One franchise code per owner per franchise (an alias of his own code; closed at expiry).
        await ensureAllocationCode(client, a);
        // §7: an upgrade from the free dealership — his team's earlier shops in this zone attach for recurring.
        await attachUpgradeShops(client, { ...a, activatedAt: now });
      }
      // A zone Reserved for this dealer is his now: back to Available (Sold Out if every slot is taken).
      await client.update(franchiseZones).set({ status: "AVAILABLE", reservedForDealerId: null, reservedUntil: null, statusReason: "Reserved dealer bought the zone", updatedAt: now }).where(and(eq(franchiseZones.zoneId, a.zoneId), eq(franchiseZones.status, "RESERVED"), eq(franchiseZones.reservedForDealerId, a.ownerDealerId)));
      activated.push(a.zoneId);
    }
    await client.update(franchiseBookings).set({ status: "PAID", paidAt: now, failureReason: lost.length ? `slot lost for ${lost.join(", ")} — refund due` : null, updatedAt: now }).where(eq(franchiseBookings.id, booking.id));
    await markRedemptionUsed(client, booking.id, now);
    if (counts) await maybeCloseLaunch(client, config, now);
    for (const zoneId of activated) notices.push(() => syncSoldOut(zoneId));
    await recordAudit(
      { action: AUDIT_ACTIONS.FRANCHISE_ALLOCATION_CHANGED, entityType: "franchise_booking", entityId: booking.id, newValue: { activated, lost, kycDueAt: kycDueAt?.toISOString() ?? null, plan: plan?.code ?? null, months, activatedAt: now.toISOString(), expiresAt: expiresAt.toISOString(), tailEndAt: tail.toISOString(), intentId: intent.id, launchOffer: booking.launchOffer } },
      client,
    );
    if (lost.length) await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_BOOKING_CHANGED, entityType: "franchise_booking", entityId: booking.id, newValue: { problem: "slot_lost_after_late_payment", zones: lost, refundDuePaise: Math.round((booking.totalPaise * lost.length) / booking.areaCount) } }, client);
    notices.push(() =>
      tellOwner(
        booking.ownerDealerId,
        "Franchise booking confirmed",
        kycPending
          ? `Paid ${rupees(booking.totalPaise)}. ${activated.join(", ") || "none"} ${activated.length === 1 ? "is" : "are"} booked for you until ${formatIst(expiresAt)}.${lost.length ? ` ${lost.join(", ")} could not be held (a refund is being arranged).` : ""} Finish your dealer KYC and bank details by ${formatIst(kycDueAt!)} (/dealer/apply) — your franchise goes live as soon as they are approved.`
          : `Paid ${rupees(booking.totalPaise)}. Active: ${activated.join(", ") || "none"} until ${formatIst(expiresAt)}.${lost.length ? ` ${lost.join(", ")} could not be held (a refund is being arranged).` : ""} Your franchise code and receipt are on your franchise page.${booking.planId && ownerRow && (!ownerRow.panHash || ownerRow.bankStatus !== "VERIFIED") ? " Add your PAN and payout bank account before your first payout (/dealer)." : ""}`,
        `franchise-paid:${booking.id}`,
      ),
    );
  }
  const run = async () => {
    for (const n of notices) await n().catch((e) => console.error("[franchise] notice failed", booking.id, e));
  };
  if (client === db) await run();
  else if (afterCommit) afterCommit(run);
}

/** Launch offer: closes for good once its limit is reached (counted on verified payments). */
async function maybeCloseLaunch(client: DbClient, config: FranchiseConfig, now: Date): Promise<void> {
  const c = await launchCounts(client, now);
  if (c.closedAt) return;
  const s = launchState({ owners: c.owners, areas: c.areas, maxOwners: config.launchMaxOwners, maxAreas: config.launchMaxAreas, closeRule: config.launchCloseRule });
  if (s.open) return;
  await client.update(franchiseCampaigns).set({ closedAt: now, closedReason: `limit reached (${config.launchCloseRule})`, ownersAtClose: c.owners, areasAtClose: c.areas, updatedAt: now }).where(eq(franchiseCampaigns.code, "LAUNCH"));
  await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_CONFIG_CHANGED, entityType: "franchise_campaign", entityId: "LAUNCH", newValue: { closed: now.toISOString(), owners: c.owners, areas: c.areas, rule: config.launchCloseRule } }, client);
}

/** Payment failed or expired (brief §4.5 step 9): the slots are released at once and the owner may retry. */
export async function onFranchiseFeeEnded(intent: PaymentIntentRow, to: "FAILED" | "EXPIRED", client: DbClient): Promise<void> {
  const [booking] = await client.select().from(franchiseBookings).where(eq(franchiseBookings.id, intent.referenceId)).for("update");
  if (!booking || !["RESERVED", "PAYMENT_PENDING"].includes(booking.status)) return;
  if (booking.paymentIntentId && booking.paymentIntentId !== intent.id) return;
  const now = new Date();
  await client.update(franchiseBookings).set({ status: to === "FAILED" ? "FAILED" : "EXPIRED", failureReason: to === "FAILED" ? "payment failed" : "payment not completed in time", updatedAt: now }).where(eq(franchiseBookings.id, booking.id));
  if (booking.kind === "NEW") {
    await client
      .update(franchiseAllocations)
      .set({ status: to === "FAILED" ? "PAYMENT_FAILED" : "RESERVATION_EXPIRED", endedAt: now, endReason: to === "FAILED" ? "payment failed" : "payment expired", updatedAt: now })
      .where(and(eq(franchiseAllocations.bookingId, booking.id), inArray(franchiseAllocations.status, ["RESERVED", "PAYMENT_PENDING_VERIFICATION"])));
  }
  await releaseRedemption(client, booking.id, to === "FAILED" ? "payment failed" : "payment timed out", now);
  await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_BOOKING_CHANGED, entityType: "franchise_booking", entityId: booking.id, newValue: { ended: to, intentId: intent.id, slotsReleased: booking.kind === "NEW" } }, client);
  const [owner] = await client.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, booking.ownerDealerId));
  if (owner?.userId) {
    await notify(
      {
        userId: owner.userId,
        type: NOTIFICATION_TYPES.FRANCHISE_NOTICE,
        vars: { title: to === "FAILED" ? "Franchise payment failed" : "Franchise reservation expired", message: `Your ${booking.kind === "RENEWAL" ? "renewal" : "reserved areas"} ${to === "FAILED" ? "payment failed" : "was not paid in time"}; ${booking.kind === "NEW" ? "the slots were released. " : ""}You can try again from the franchise page.` },
        actionUrl: "/franchise/book",
        channels: ["PUSH"],
        dedupeKey: `franchise-ended:${booking.id}`,
      },
      client,
    );
  }
}

async function tellOwner(ownerDealerId: string, title: string, message: string, dedupeKey: string): Promise<void> {
  const [owner] = await db.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, ownerDealerId));
  if (!owner?.userId) return;
  await notify({ userId: owner.userId, type: NOTIFICATION_TYPES.FRANCHISE_NOTICE, vars: { title, message }, actionUrl: "/franchise/my", channels: ["PUSH", "SMS", "WHATSAPP"], dedupeKey });
}

/* ============================================================= renewal */

/** §5.5: the renewal fee is the zone's current published fee (null when the zone has none). */
export async function renewalFeeFor(alloc: Pick<FranchiseAllocation, "zoneId">, client: DbClient = db): Promise<{ feePaise: number; tier: string; changed: boolean; reason: string } | null> {
  const fee = await currentFee(alloc.zoneId, client);
  return fee ? { feePaise: Number(fee.feePaise), tier: fee.tier, changed: false, reason: fee.reason } : null;
}

async function renewalLines(booking: FranchiseBooking): Promise<CartLine[]> {
  const [a] = await db.select({ zoneId: franchiseAllocations.zoneId, set: franchiseZones.zoneSetCode }).from(franchiseAllocations).innerJoin(franchiseZones, eq(franchiseZones.zoneId, franchiseAllocations.zoneId)).where(eq(franchiseAllocations.id, booking.renewalAllocationId!));
  const fee = a ? await currentFee(a.zoneId) : null;
  return a && fee ? [{ zoneId: a.zoneId, zoneSetCode: a.set, tier: fee.tier, listPaise: Number(booking.listPaise) }] : [];
}

/**
 * Starts (or reuses) a renewal booking for one franchise — open 30 days before expiry up to its last second — at the
 * zone's current published fee, with an optional renewal coupon. Blocked when the zone is Inactive (§5.6).
 */
export async function startRenewal(allocationId: string, actor: Actor, input: { couponCode?: string | null } = {}) {
  const owner = await requireOwner(actor);
  const { version, config } = await franchiseConfig();
  const now = franchiseNow(config);
  const booking = await db.transaction(async (tx) => {
    const [alloc] = await tx.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, allocationId)).for("update");
    if (!alloc || alloc.ownerDealerId !== owner.id) throw notFound("Franchise");
    if (alloc.status !== "ACTIVE" || !alloc.expiresAt) throw conflict(alloc.status === "EXPIRED" ? "This franchise has expired; renewal is closed. Book the zone again if a slot is free." : "Only an active franchise can be renewed.");
    if (!renewalOpen(alloc.expiresAt, now, config.renewalWindowDays)) throw conflict(`Renewal opens ${config.renewalWindowDays} days before expiry (${formatIst(alloc.expiresAt)}).`);
    const [zone] = await tx.select().from(franchiseZones).where(eq(franchiseZones.zoneId, alloc.zoneId));
    if (zone?.status === "INACTIVE") throw conflict(`Zone ${alloc.zoneId} is inactive: renewal is closed. Your franchise runs to the end of its paid term (${formatIst(alloc.expiresAt)}).`);
    const fee = await currentFee(alloc.zoneId, tx);
    if (!fee) throw conflict("The zone's fee is not set. Contact GoKesari.");
    const [open] = await tx
      .select()
      .from(franchiseBookings)
      .where(and(eq(franchiseBookings.renewalAllocationId, alloc.id), inArray(franchiseBookings.status, ["RESERVED", "PAYMENT_PENDING"])))
      .orderBy(desc(franchiseBookings.createdAt))
      .limit(1);
    if (open) return open;
    const line: CartLine = { zoneId: alloc.zoneId, zoneSetCode: zone!.zoneSetCode, tier: fee.tier, listPaise: Number(fee.feePaise) };
    const coupon = input.couponCode?.trim() ? await checkCoupon(input.couponCode, { dealerId: owner.id, kind: "RENEWAL", lines: [line], launchEligible: alloc.launchOffer, now }, tx) : null;
    const amounts = cartAmounts([{ listPaise: line.listPaise, discountPaise: coupon?.discounts[0] ?? 0 }], config.gstRateBp);
    const holdExpiresAt = new Date(Math.min(now.getTime() + config.reservationHoldMinutes * 60_000, alloc.expiresAt.getTime()));
    const [row] = await tx
      .insert(franchiseBookings)
      .values({ ownerDealerId: owner.id, kind: "RENEWAL", status: "RESERVED", ...amounts, couponId: coupon?.coupon.id ?? null, couponCode: coupon?.coupon.code ?? null, configVersion: version, launchOffer: alloc.launchOffer, renewalAllocationId: alloc.id, holdExpiresAt, isTest: alloc.isTest, createdBy: actor.id })
      .returning();
    if (coupon) await holdRedemption(tx, { couponId: coupon.coupon.id, dealerId: owner.id, bookingId: row.id, discountPaise: amounts.discountPaise, heldUntil: holdExpiresAt });
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_BOOKING_CHANGED, entityType: "franchise_booking", entityId: row.id, newValue: { renewalOf: alloc.id, listPaise: amounts.listPaise, coupon: coupon?.coupon.code ?? null, totalPaise: row.totalPaise } }, tx);
    return row;
  });
  return startBookingPayment(booking.id, actor);
}

/**
 * §7: when a free dealer buys a franchise, his team's earlier (free-dealership) shops in that zone attach to the
 * franchise for recurring commission. Shops already attached to an earlier franchise of his are not restored (§4.2).
 */
export async function attachUpgradeShops(client: DbClient, allocation: Pick<FranchiseAllocation, "id" | "zoneId" | "ownerDealerId"> & { activatedAt: Date | null }): Promise<number> {
  const rows = (await client.execute(sql`
    insert into franchise_shop_attributions (shop_id, owner_dealer_id, allocation_id, zone_id, origin, member_id, status, registered_at, activated_at)
    select sa.shop_id, ${allocation.ownerDealerId}::uuid, ${allocation.id}::uuid, ${allocation.zoneId}, 'UPGRADE', sa.salesperson_id, 'ACTIVE', s.created_at, s.approved_at
    from shop_attributions sa
    join shops s on s.id = sa.shop_id
    join franchise_shop_area_periods p on p.shop_id = sa.shop_id and p.valid_to is null and p.zone_id = ${allocation.zoneId}
    where sa.dealer_id = ${allocation.ownerDealerId}::uuid and sa.status = 'ACTIVE'
      and not exists (select 1 from franchise_shop_attributions f where f.shop_id = sa.shop_id)
    returning shop_id`)) as unknown as { shop_id: string }[];
  if (rows.length) await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_ATTRIBUTION_CHANGED, entityType: "franchise_allocation", entityId: allocation.id, newValue: { upgradeShopsAttached: rows.length } }, client);
  return rows.length;
}

/**
 * Full refund of a franchise booking (§5.7): the booking is REFUNDED, its franchises are voided, codes closed, the
 * coupon use released and the zones' Sold Out status re-checked. The money itself is refunded in the gateway.
 */
export async function refundBooking(bookingId: string, reason: string, actor: Actor): Promise<void> {
  if (actor.role !== "ADMIN" && !can(actor.role, PERMISSIONS.DEALER_REFUND)) throw forbidden("Only an admin can refund a franchise booking.");
  if (reason.trim().length < 5) throw validationFailed("Give a reason of at least 5 characters.");
  const zones = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(franchiseBookings).where(eq(franchiseBookings.id, bookingId)).for("update");
    if (!b) throw notFound("Booking");
    if (b.status !== "PAID") throw conflict("Only a paid booking can be refunded.");
    const now = new Date();
    await tx.update(franchiseBookings).set({ status: "REFUNDED", failureReason: `refunded: ${reason.trim().slice(0, 200)}`, updatedAt: now }).where(eq(franchiseBookings.id, bookingId));
    const allocs = b.kind === "NEW" ? await tx.select().from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, bookingId)) : [];
    for (const a of allocs) {
      if (!["ACTIVE", "SUSPENDED", "PAYMENT_PENDING_VERIFICATION", "RESERVED"].includes(a.status)) continue;
      await tx.update(franchiseAllocations).set({ status: "CANCELLED", endedAt: now, endReason: `refunded: ${reason.trim().slice(0, 200)}`, tailEndAt: now, updatedAt: now }).where(eq(franchiseAllocations.id, a.id));
      await closeAllocationCodes(tx, a, now);
    }
    await releaseRedemption(tx, bookingId, "booking refunded", now);
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_BOOKING_CHANGED, entityType: "franchise_booking", entityId: bookingId, newValue: { refunded: true, reason, allocations: allocs.map((a) => a.id) } }, tx);
    return allocs.map((a) => a.zoneId);
  });
  for (const z of zones) await syncSoldOut(z);
}

/* ============================================================= admin: suspend / terminate / void */

export async function setAllocationStatus(allocationId: string, to: "SUSPENDED" | "ACTIVE" | "TERMINATED" | "CANCELLED", reason: string, actor: Actor): Promise<FranchiseAllocation> {
  if (actor.role !== "ADMIN" && !can(actor.role, PERMISSIONS.DEALER_TERRITORY_ALLOCATE)) throw forbidden("Only an admin can change an allocation.");
  if (reason.trim().length < 5) throw validationFailed("Give a reason of at least 5 characters.");
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, allocationId)).for("update");
    if (!a) throw notFound("Allocation");
    const allowed: Record<string, string[]> = { SUSPENDED: ["ACTIVE"], ACTIVE: ["SUSPENDED"], TERMINATED: ["ACTIVE", "SUSPENDED"], CANCELLED: ["ACTIVE", "SUSPENDED", "RESERVED", "PAYMENT_PENDING_VERIFICATION"] };
    if (!allowed[to].includes(a.status)) throw conflict(`An allocation that is ${a.status} cannot become ${to}.`);
    if (to === "CANCELLED" && a.status !== "RESERVED" && !a.isTest) throw conflict("Only a test allocation (or an unpaid reservation) can be voided; terminate a real one instead.");
    const now = new Date();
    const ending = to === "TERMINATED" || to === "CANCELLED";
    const [after] = await tx
      .update(franchiseAllocations)
      .set({ status: to, updatedAt: now, ...(ending ? { endedAt: now, endReason: reason.trim().slice(0, 300), tailEndAt: to === "TERMINATED" ? now : a.tailEndAt } : {}) })
      .where(eq(franchiseAllocations.id, allocationId))
      .returning();
    if (ending) await closeAllocationCodes(tx, a, now);
    if (to === "CANCELLED") await releaseRedemption(tx, a.bookingId, "franchise voided", now);
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ALLOCATION_CHANGED, entityType: "franchise_allocation", entityId: allocationId, previousValue: { status: a.status }, newValue: { status: to, reason } }, tx);
    return after;
  }).then(async (after) => {
    await syncSoldOut(after.zoneId);
    return after;
  });
}

/** The owner's other active owners in a zone, as a number only (brief §3.2: never who). */
export async function otherOwnersInZone(zoneId: string, ownerId: string, client: DbClient = db): Promise<number> {
  const [r] = await client
    .select({ n: sql<number>`count(*)::int` })
    .from(franchiseAllocations)
    .where(and(eq(franchiseAllocations.zoneId, zoneId), ne(franchiseAllocations.ownerDealerId, ownerId), inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"])));
  return Number(r?.n ?? 0);
}
