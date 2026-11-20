/**
 * Franchise area booking (brief §3, §4.4–§4.5, §9.3): cart → reserve slots → pay → verify → activate, renewal,
 * and release on failure or expiry. Capacity is enforced by the database (two partial unique indexes on
 * franchise_allocations); the code takes zone rows FOR UPDATE in Zone ID order so a multi-area cart never
 * deadlocks, and the whole cart is all-or-nothing. Every amount is computed here from the config in force.
 */
import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import {
  FRANCHISE_AGREEMENT_TEXT,
  FRANCHISE_AGREEMENT_VERSION,
  OCCUPYING_STATUSES,
  allocationExpiry,
  bookingAmounts,
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
  franchiseZoneBoundaries,
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
import { franchiseConfig, franchiseConfigAt, franchiseNow, type FranchiseConfig } from "./config";
import { closeAllocationCodes, ensureAllocationCode, reopenMemberCodes } from "./codes";

export interface Actor {
  id: string;
  role: UserRole;
}

export const AGREEMENT_SHA256 = createHash("sha256").update(FRANCHISE_AGREEMENT_TEXT.join("\n")).digest("hex");

/* ============================================================= owner eligibility */

export interface OwnerStatus {
  dealer: Dealer | null;
  /** What still blocks paying (brief §4.5 step 2: KYC + PAN + bank verified before payment). */
  missing: string[];
  agreementAccepted: boolean;
}

export async function ownerStatusForUser(userId: string, client: DbClient = db): Promise<OwnerStatus> {
  const [dealer] = await client.select().from(dealers).where(eq(dealers.userId, userId));
  if (!dealer) return { dealer: null, missing: ["a GoKesari dealer account (apply free at /dealer/apply)"], agreementAccepted: false };
  const missing: string[] = [];
  if (dealer.status !== "APPROVED") missing.push("dealer account approval (KYC)");
  if (!dealer.panHash) missing.push("PAN");
  if (dealer.bankStatus !== "VERIFIED") missing.push("a verified bank account");
  if (dealer.isInternal) missing.push("a real dealer account (GoKesari Direct cannot book)");
  const [acc] = await client
    .select({ id: franchiseAgreementAcceptances.id })
    .from(franchiseAgreementAcceptances)
    .where(and(eq(franchiseAgreementAcceptances.ownerDealerId, dealer.id), eq(franchiseAgreementAcceptances.version, FRANCHISE_AGREEMENT_VERSION), eq(franchiseAgreementAcceptances.textSha256, AGREEMENT_SHA256)))
    .limit(1);
  return { dealer, missing, agreementAccepted: !!acc };
}

async function requireOwner(actor: Actor, client: DbClient = db): Promise<Dealer> {
  const s = await ownerStatusForUser(actor.id, client);
  if (!s.dealer) throw forbidden("Register as a GoKesari dealer first (free) — then you can book franchise areas.");
  if (s.missing.length) throw forbidden(`Before paying, complete: ${s.missing.join(", ")}.`);
  return s.dealer;
}

/** Clickwrap (brief §4.5 step 4): version, text hash, IP and device are stored. */
export async function acceptFranchiseAgreement(actor: Actor, version: string, device: { ipAddress?: string | null; userAgent?: string | null }): Promise<{ id: string }> {
  if (version !== FRANCHISE_AGREEMENT_VERSION) throw conflict("The agreement has changed — please read the current version.");
  const s = await ownerStatusForUser(actor.id);
  if (!s.dealer) throw forbidden("Register as a GoKesari dealer first.");
  const [row] = await db
    .insert(franchiseAgreementAcceptances)
    .values({ ownerDealerId: s.dealer.id, userId: actor.id, version, textSha256: AGREEMENT_SHA256, ipAddress: device.ipAddress?.slice(0, 64) ?? null, userAgent: device.userAgent?.slice(0, 300) ?? null })
    .returning({ id: franchiseAgreementAcceptances.id });
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_AGREEMENT_ACCEPTED, entityType: "dealer", entityId: s.dealer.id, newValue: { version, sha256: AGREEMENT_SHA256, ip: device.ipAddress ?? null } });
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
  /** Whether a new booking can be paid now, and at what fee (null: "new terms coming soon"). */
  feePerAreaPaise: number | null;
  gstRateBp: number;
  validityMonths: number;
  maxOwnersPerZone: number;
  holdMinutes: number;
  closedMessage: string | null;
}

export async function offerView(client: DbClient = db): Promise<OfferView> {
  const { config } = await franchiseConfig(client);
  const now = franchiseNow(config);
  const c = await launchCounts(client, now);
  const launch = launchState({ owners: c.owners, areas: c.areas, maxOwners: config.launchMaxOwners, maxAreas: config.launchMaxAreas, closeRule: config.launchCloseRule, closedAt: c.closedAt });
  const fee = launch.open ? config.feePerAreaPaise : config.postLaunchFeePaise;
  const closedMessage = !config.bookingOpen ? "Bookings open soon." : fee == null ? "Launch offer closed – new terms coming soon." : null;
  return { bookingOpen: config.bookingOpen && fee != null, launch, feePerAreaPaise: fee, gstRateBp: config.gstRateBp, validityMonths: config.validityMonths, maxOwnersPerZone: config.maxOwnersPerZone, holdMinutes: config.reservationHoldMinutes, closedMessage };
}

/* ============================================================= reserve (cart) */

export interface ReserveResult {
  booking: FranchiseBooking;
  allocations: FranchiseAllocation[];
}

/**
 * Reserves one slot in each zone of the cart for `holdMinutes` (brief §4.4). All-or-nothing: if any zone is
 * full, not bookable or already held by this owner, nothing is reserved and the zones are named.
 */
export async function reserveZones(actor: Actor, input: { zoneIds: string[]; test?: boolean }): Promise<ReserveResult> {
  const owner = await requireOwner(actor);
  const { version, config } = await franchiseConfig();
  const zoneIds = [...new Set(input.zoneIds.map((z) => z.trim().toUpperCase()))].filter(Boolean);
  if (!zoneIds.length) throw validationFailed("Choose at least one area.");
  if (zoneIds.length > config.maxAreasPerBooking) throw validationFailed(`Book at most ${config.maxAreasPerBooking} areas at a time.`);
  const isTest = !!input.test;
  if (isTest && actor.role !== "ADMIN") throw forbidden("Only an admin can book the test zone.");
  if (!config.bookingOpen && !isTest) throw conflict("Franchise bookings are not open yet.");
  const status = await ownerStatusForUser(actor.id);
  if (!status.agreementAccepted) throw conflict("Accept the franchise responsibilities and rules first.");

  const result = await db.transaction(async (tx) => {
    const now = franchiseNow(config);
    // Launch counters are serialised with activation (one place at a time).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('franchise-launch'))`);
    const c = await launchCounts(tx, now);
    const launch = launchState({ owners: c.owners, areas: c.areas, maxOwners: config.launchMaxOwners, maxAreas: config.launchMaxAreas, closeRule: config.launchCloseRule, closedAt: c.closedAt });
    let fee: number;
    let launchOffer = false;
    if (isTest) {
      fee = config.feePerAreaPaise;
    } else if (launch.open) {
      // Places still free once pending reservations are counted (so the 25th place is never sold twice).
      const ownerIsNew = !(await ownerHasLaunchArea(tx, owner.id)) && !c.pendingOwners.includes(owner.id);
      const areasLeft = config.launchMaxAreas - c.areas - c.pendingAreas;
      const ownersLeft = config.launchMaxOwners - c.owners - c.pendingOwners.length;
      const areasOk = config.launchCloseRule === "owners_only" || areasLeft >= zoneIds.length;
      const ownersOk = config.launchCloseRule === "areas_only" || !ownerIsNew || ownersLeft >= 1;
      if (!areasOk || !ownersOk) {
        throw conflict(areasLeft > 0 && ownersOk ? `Only ${areasLeft} launch place${areasLeft === 1 ? "" : "s"} left (some are being paid for now). Choose fewer areas or try again in 15 minutes.` : "The last launch places are being paid for right now. Try again in 15 minutes.");
      }
      fee = config.feePerAreaPaise;
      launchOffer = true;
    } else if (config.postLaunchFeePaise != null) {
      fee = config.postLaunchFeePaise;
    } else {
      throw conflict("Launch offer closed – new terms coming soon. WhatsApp or call +91 91751 93009.");
    }

    // Brief §4.4: lock the zones in Zone ID order (no deadlock between two carts).
    const locked = await tx.select().from(franchiseZones).where(inArray(franchiseZones.zoneId, zoneIds)).orderBy(asc(franchiseZones.zoneId)).for("update");
    const missingIds = zoneIds.filter((z) => !locked.some((l) => l.zoneId === z));
    if (missingIds.length) throw validationFailed(`Unknown area${missingIds.length > 1 ? "s" : ""}: ${missingIds.join(", ")}.`);
    const approved = new Set(
      (await tx.select({ zoneId: franchiseZoneBoundaries.zoneId }).from(franchiseZoneBoundaries).where(and(inArray(franchiseZoneBoundaries.zoneId, zoneIds), eq(franchiseZoneBoundaries.status, "APPROVED")))).map((r) => r.zoneId),
    );
    // Expired holds in these zones are freed now, under the lock (and by the job).
    await releaseExpiredHolds(tx, now, zoneIds);

    const problems: string[] = [];
    const plan: { zoneId: string; slotNo: number }[] = [];
    for (const zone of locked) {
      if (!config.regionsEnabled.includes(zone.regionCode)) problems.push(`${zone.zoneId} is not open for booking`);
      else if (zone.isTest !== isTest) problems.push(`${zone.zoneId} cannot be booked here`);
      else if (zone.status !== "BOOKABLE" || !approved.has(zone.zoneId)) problems.push(`${zone.zoneId} is ${zone.status === "PAUSED" ? "paused" : "coming soon (boundary not yet approved)"}`);
      if (problems.length) continue;
      const taken = await tx
        .select({ slotNo: franchiseAllocations.slotNo, owner: franchiseAllocations.ownerDealerId })
        .from(franchiseAllocations)
        .where(and(eq(franchiseAllocations.zoneId, zone.zoneId), inArray(franchiseAllocations.status, [...OCCUPYING_STATUSES])));
      if (taken.some((t) => t.owner === owner.id)) {
        problems.push(`you already hold or are booking ${zone.zoneId}`);
        continue;
      }
      const max = Math.min(zone.maxOwners, config.maxOwnersPerZone);
      const free = [1, 2].filter((s) => s <= max && !taken.some((t) => t.slotNo === s));
      if (!free.length) problems.push(`${zone.zoneId} is fully booked`);
      else plan.push({ zoneId: zone.zoneId, slotNo: free[0] });
    }
    if (problems.length) throw conflict(`Nothing was reserved: ${problems.join("; ")}. Remove ${problems.length > 1 ? "these areas" : "this area"} and try again.`);

    const amounts = bookingAmounts(plan.length, fee, config.gstRateBp);
    const holdExpiresAt = new Date(now.getTime() + config.reservationHoldMinutes * 60_000);
    const [booking] = await tx
      .insert(franchiseBookings)
      .values({ ownerDealerId: owner.id, kind: "NEW", status: "RESERVED", ...amounts, configVersion: version, launchOffer, holdExpiresAt, isTest, createdBy: actor.id })
      .returning();
    const allocations = await tx
      .insert(franchiseAllocations)
      .values(plan.map((p) => ({ zoneId: p.zoneId, slotNo: p.slotNo, ownerDealerId: owner.id, bookingId: booking.id, status: "RESERVED" as const, holdExpiresAt, feePaise: fee, configVersion: version, launchOffer, isTest })))
      .returning();
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_BOOKING_CHANGED, entityType: "franchise_booking", entityId: booking.id, newValue: { reserved: plan, totalPaise: amounts.totalPaise, launchOffer, holdExpiresAt: holdExpiresAt.toISOString(), configVersion: version, isTest } },
      tx,
    );
    return { booking, allocations };
  }).catch((e: unknown) => {
    // A race lost to the unique indexes (another cart took the last slot between the read and the insert).
    if (/franchise_allocations_(slot|owner)_unique/.test(String((e as Error)?.message ?? "")) || (e as { code?: string })?.code === "23505") {
      throw conflict("Another owner took one of these areas a moment ago. Refresh and try again.");
    }
    throw e;
  });
  return result;
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
  await client.update(franchiseBookings).set({ status: "EXPIRED", failureReason: "not paid in time", updatedAt: now }).where(and(eq(franchiseBookings.status, "RESERVED"), eq(franchiseBookings.kind, "RENEWAL"), lte(franchiseBookings.holdExpiresAt, now)));
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
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_BOOKING_CHANGED, entityType: "franchise_booking", entityId: bookingId, newValue: { cancelled: true } }, tx);
  });
}

/* ============================================================= pay */

/** Opens the gateway payment for a reserved booking (amount from the booking, never from the client). */
export async function startBookingPayment(bookingId: string, actor: Actor) {
  const [booking] = await db.select().from(franchiseBookings).where(eq(franchiseBookings.id, bookingId));
  if (!booking) throw notFound("Booking");
  const owner = await requireOwner(actor);
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
  const [u] = await db.select({ name: users.name, email: users.email, phone: users.phone }).from(users).where(eq(users.id, actor.id));
  const zones = booking.kind === "NEW" ? (await db.select({ zoneId: franchiseAllocations.zoneId }).from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, booking.id))).map((a) => a.zoneId) : [];
  const { createPaymentIntent } = await import("@/server/payments/intents");
  const created = await createPaymentIntent({
    purpose: "FRANCHISE_FEE",
    referenceId: booking.id,
    userId: actor.id,
    amountPaise: booking.totalPaise,
    customer: { id: actor.id, name: u?.name ?? null, email: u?.email ?? null, phone: u?.phone ?? null },
    description: booking.kind === "RENEWAL" ? "GoKesari franchise renewal (12 months)" : `GoKesari franchise — ${zones.join(", ")}`,
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
    await client.update(franchiseAllocations).set({ periodStart: alloc.expiresAt, expiresAt: newExpiry, tailEndAt: tail, renewalCount: alloc.renewalCount + 1, updatedAt: now }).where(eq(franchiseAllocations.id, alloc.id));
    await client.insert(franchiseAllocationRenewals).values({ allocationId: alloc.id, bookingId: booking.id, previousExpiresAt: alloc.expiresAt, newExpiresAt: newExpiry, feePaise: booking.basePaise, paidAt: now });
    await client.update(franchiseBookings).set({ status: "PAID", paidAt: now, updatedAt: now }).where(eq(franchiseBookings.id, booking.id));
    await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_ALLOCATION_CHANGED, entityType: "franchise_allocation", entityId: alloc.id, previousValue: { expiresAt: alloc.expiresAt.toISOString() }, newValue: { renewed: true, expiresAt: newExpiry.toISOString(), bookingId: booking.id, intentId: intent.id } }, client);
    notices.push(() => tellOwner(booking.ownerDealerId, "Franchise area renewed", `Zone ${alloc.zoneId} is renewed until ${formatIst(newExpiry)}. Receipt: /franchise/my/receipt/${booking.id}`, `franchise-renewed:${booking.id}`));
  } else {
    await client.execute(sql`select pg_advisory_xact_lock(hashtext('franchise-launch'))`);
    const allocations = await client.select().from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, booking.id)).orderBy(asc(franchiseAllocations.zoneId)).for("update");
    const months = bookingConfig.config.validityMonths;
    const expiresAt = allocationExpiry(now, months);
    const tail = tailEndAt({ chainStartAt: now, expiresAt, mode: config.tailMode, tailYears: config.tailYears });
    const counts = booking.launchOffer && !booking.isTest ? await launchCounts(client, now) : null;
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
        .set({ status: "ACTIVE", holdExpiresAt: null, activatedAt: now, periodStart: now, expiresAt, tailEndAt: tail, launchSeq: booking.launchOffer && !booking.isTest ? seq : null, updatedAt: now })
        .where(eq(franchiseAllocations.id, a.id));
      // Brief 21-Nov §1.4: one dealer code per dealer per area.
      await ensureAllocationCode(client, a);
      activated.push(a.zoneId);
    }
    await client.update(franchiseBookings).set({ status: "PAID", paidAt: now, failureReason: lost.length ? `slot lost for ${lost.join(", ")} — refund due` : null, updatedAt: now }).where(eq(franchiseBookings.id, booking.id));
    if (counts) await maybeCloseLaunch(client, config, now);
    if (activated.length) await reopenMemberCodes(client, booking.ownerDealerId);
    await recordAudit(
      { action: AUDIT_ACTIONS.FRANCHISE_ALLOCATION_CHANGED, entityType: "franchise_booking", entityId: booking.id, newValue: { activated, lost, activatedAt: now.toISOString(), expiresAt: expiresAt.toISOString(), tailEndAt: tail.toISOString(), intentId: intent.id, launchOffer: booking.launchOffer } },
      client,
    );
    if (lost.length) await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_BOOKING_CHANGED, entityType: "franchise_booking", entityId: booking.id, newValue: { problem: "slot_lost_after_late_payment", zones: lost, refundDuePaise: Math.round((booking.totalPaise * lost.length) / booking.areaCount) } }, client);
    notices.push(() =>
      tellOwner(
        booking.ownerDealerId,
        "Franchise booking confirmed",
        `Paid ${rupees(booking.totalPaise)}. Active: ${activated.join(", ") || "none"} until ${formatIst(expiresAt)}.${lost.length ? ` ${lost.join(", ")} could not be held (a refund is being arranged).` : ""} Your franchise code and receipt are on your franchise page.`,
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

/** The renewal fee then in force (brief §9.3): renewalFeePaise, else launch owners the launch fee, else the current fee. */
export function renewalFeeFor(alloc: Pick<FranchiseAllocation, "launchOffer">, config: FranchiseConfig): number | null {
  if (config.renewalFeePaise != null) return config.renewalFeePaise;
  if (alloc.launchOffer) return config.feePerAreaPaise;
  return config.postLaunchFeePaise ?? config.feePerAreaPaise;
}

/** Starts (or reuses) a renewal booking for one allocation — open 30 days before expiry up to its last second. */
export async function startRenewal(allocationId: string, actor: Actor) {
  const owner = await requireOwner(actor);
  const { version, config } = await franchiseConfig();
  const now = franchiseNow(config);
  const booking = await db.transaction(async (tx) => {
    const [alloc] = await tx.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, allocationId)).for("update");
    if (!alloc || alloc.ownerDealerId !== owner.id) throw notFound("Area");
    if (alloc.status !== "ACTIVE" || !alloc.expiresAt) throw conflict(alloc.status === "EXPIRED" ? "This area has expired; renewal is closed. Book it again if a slot is free." : "Only an active area can be renewed.");
    if (!renewalOpen(alloc.expiresAt, now, config.renewalWindowDays)) throw conflict(`Renewal opens ${config.renewalWindowDays} days before expiry (${formatIst(alloc.expiresAt)}).`);
    const fee = renewalFeeFor(alloc, config);
    if (fee == null) throw conflict("The renewal fee is not set yet. Contact GoKesari.");
    const [open] = await tx
      .select()
      .from(franchiseBookings)
      .where(and(eq(franchiseBookings.renewalAllocationId, alloc.id), inArray(franchiseBookings.status, ["RESERVED", "PAYMENT_PENDING"])))
      .orderBy(desc(franchiseBookings.createdAt))
      .limit(1);
    if (open) return open;
    const amounts = bookingAmounts(1, fee, config.gstRateBp);
    const [row] = await tx
      .insert(franchiseBookings)
      .values({ ownerDealerId: owner.id, kind: "RENEWAL", status: "RESERVED", ...amounts, configVersion: version, launchOffer: alloc.launchOffer, renewalAllocationId: alloc.id, holdExpiresAt: new Date(Math.min(now.getTime() + config.reservationHoldMinutes * 60_000, alloc.expiresAt.getTime())), isTest: alloc.isTest, createdBy: actor.id })
      .returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_BOOKING_CHANGED, entityType: "franchise_booking", entityId: row.id, newValue: { renewalOf: alloc.id, totalPaise: row.totalPaise } }, tx);
    return row;
  });
  return startBookingPayment(booking.id, actor);
}

/* ============================================================= admin: suspend / terminate / void */

export async function setAllocationStatus(allocationId: string, to: "SUSPENDED" | "ACTIVE" | "TERMINATED" | "CANCELLED", reason: string, actor: Actor): Promise<FranchiseAllocation> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change an allocation.");
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
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ALLOCATION_CHANGED, entityType: "franchise_allocation", entityId: allocationId, previousValue: { status: a.status }, newValue: { status: to, reason } }, tx);
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
