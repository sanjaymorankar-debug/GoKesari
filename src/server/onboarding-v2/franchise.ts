/**
 * Onboarding v2 — Flow 3, franchise (docs/onboarding-v2-2026-11; owner brief 26-Nov-2026 18.19 IST). Behind the flag
 * onboarding_v2; with the flag off nothing here is reachable and the franchise pages behave exactly as before.
 *
 *  1. Entry: "Become a franchisee" → /franchise/start (signed in).
 *  2. A LIVE registered shop is mandatory (no live shop, no franchise); without one the user is sent to shop
 *     registration with ?return=/franchise/start. The shop's and the account's verified details make the dealer row.
 *  3. Model: free dealer — a request an admin approves (owner, 27-Nov-2026), then a GKD code; no area; paid franchise — zones + a plan
 *     (franchise_plans) + optional coupon, paid online 100% upfront, live at payment with a GKF code (booking.ts).
 *  4. KYC: no 30-day rule. PAN and a verified payout bank are asked before the first payout only (payeeStatus).
 * Every role given here is written to onboarding_role_history (recordRoleChange); every change is audited.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { istDate } from "@/lib/franchise";
import { db, type DbClient } from "@/server/db";
import { dealers, franchiseAllocations, franchiseBookings, franchiseCodes, franchisePlans, onboardingRoleHistory, shops, users, type Dealer, type UserRole } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { grantRole } from "@/server/services/roles";
import { prefixedCode } from "@/server/franchise/prefixed-code";
import { issueCode, listDealerCodes } from "@/server/dealers/codes";
import { listMarketplaceRoles, onboardingV2Enabled, recordRoleChange } from "./roles";

export interface Actor {
  id: string;
  role: UserRole;
}

export const FRANCHISE_START_PATH = "/franchise/start";
/** Where a user without a live shop registers one first; the shop flow comes back to `return`. */
export const SHOP_REGISTER_FOR_FRANCHISE = `/shop/register?return=${encodeURIComponent(FRANCHISE_START_PATH)}`;

const CLOSED_DEALER: readonly string[] = ["REJECTED", "SUSPENDED", "TERMINATED"];

/* ============================================================= live shop */

/**
 * The user's live registered shop (oldest approved first), or null. "Live" = approved by GoKesari and not deleted.
 * DEFAULT – confirm with Sanjay: a shop whose owner paused orders is still live for this check.
 */
export async function liveShopForUser(userId: string, client: DbClient = db) {
  const [shop] = await client
    .select()
    .from(shops)
    .where(and(eq(shops.ownerId, userId), eq(shops.status, "APPROVED")))
    .orderBy(asc(shops.approvedAt), asc(shops.createdAt));
  return shop && !shop.deletedAt ? shop : null;
}

export async function requireLiveShop(userId: string, client: DbClient = db) {
  const shop = await liveShopForUser(userId, client);
  if (!shop) throw conflict("Register your shop first — a live GoKesari shop is needed to become a dealer or franchisee.", { reason: "SHOP_REQUIRED", redirect: SHOP_REGISTER_FOR_FRANCHISE });
  return shop;
}

async function requireFlag(): Promise<void> {
  if (!(await onboardingV2Enabled())) throw forbidden("Become a franchisee is not open yet.");
}

/* ============================================================= dealer row from the shop */

const digits10 = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");

/**
 * The account's dealer row, made (or completed) from the live shop and the customer account — name, mobile, e-mail,
 * GSTIN, PAN, address — so nothing verified is asked again. A PAN already on another open dealer is not copied (the
 * owner adds his own before the first payout). Returns the row (DRAFT for a new one).
 */
export async function ensureDealerFromShop(actor: Actor, client: DbClient = db): Promise<Dealer> {
  const shop = await requireLiveShop(actor.id, client);
  const [user] = await client.select().from(users).where(eq(users.id, actor.id));
  if (!user) throw notFound("Account");
  const now = new Date();
  const mobile = digits10(user.phoneE164 ?? user.phone) || digits10(shop.phone);
  const mobileVerified = !!user.phoneVerifiedAt && digits10(user.phoneE164 ?? user.phone) === mobile;
  const email = user.emailPlaceholder ? (shop.email ?? null) : user.email;
  let panHash: string | null = shop.panHash ?? null;
  if (panHash) {
    const [taken] = await client.select({ userId: dealers.userId, status: dealers.status }).from(dealers).where(eq(dealers.panHash, panHash)).limit(1);
    if (taken && taken.userId !== actor.id && taken.status !== "REJECTED") panHash = null;
  }
  const pan = panHash && shop.panNumberEncrypted ? { panEnc: shop.panNumberEncrypted, panHash, panLast4: shop.panLast4 } : {};

  const [existing] = await client.select().from(dealers).where(eq(dealers.userId, actor.id)).orderBy(desc(dealers.createdAt)).limit(1);
  if (existing) {
    if (existing.isInternal || CLOSED_DEALER.includes(existing.status)) throw conflict(`Your dealer account is ${existing.status.toLowerCase()} — contact GoKesari support.`);
    // Fill only what is missing; nothing the dealer already gave is overwritten.
    const fill: Partial<typeof dealers.$inferInsert> = {};
    if (!existing.panHash && pan.panHash) Object.assign(fill, pan);
    if (!existing.gstin && shop.gstin) fill.gstin = shop.gstin;
    if (!existing.mobileE164 && mobile) Object.assign(fill, { mobileE164: `+91${mobile}`, ...(mobileVerified ? { mobileVerifiedAt: now, mobileVerificationMethod: "OTP" as const } : {}) });
    if (!existing.email && email) Object.assign(fill, { email, emailVerifiedAt: user.emailVerified ?? null });
    if (!existing.addressLine1) Object.assign(fill, { addressLine1: shop.addressLine1, city: shop.city, pincode: shop.pincode, state: shop.state });
    if (!Object.keys(fill).length) return existing;
    const [row] = await client.update(dealers).set({ ...fill, updatedAt: now }).where(eq(dealers.id, existing.id)).returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_APPLICATION_SAVED, entityType: "dealer", entityId: row.id, newValue: { via: "onboarding_v2_from_shop", shopId: shop.id, filled: Object.keys(fill).filter((k) => k !== "panEnc") } }, client);
    return row;
  }

  const name = (shop.legalBusinessName || user.name || shop.ownerName).replace(/\s+/g, " ").trim().slice(0, 120);
  const [row] = await client
    .insert(dealers)
    .values({
      userId: actor.id,
      legalName: name,
      contactName: (user.name || shop.ownerName).trim().slice(0, 120),
      // DEFAULT – confirm with Sanjay: a GST-registered shop's owner is a proprietorship, else an individual.
      dealerType: shop.gstin ? "PROPRIETORSHIP" : "INDIVIDUAL",
      mobileE164: mobile ? `+91${mobile}` : null,
      mobileVerifiedAt: mobileVerified ? now : null,
      mobileVerificationMethod: mobileVerified ? "OTP" : null,
      email,
      emailVerifiedAt: email && email === user.email ? (user.emailVerified ?? null) : null,
      ...pan,
      gstin: shop.gstin ?? null,
      addressLine1: shop.addressLine1,
      city: shop.city,
      pincode: shop.pincode,
      state: shop.state,
      status: "DRAFT",
      source: "APPLICATION",
    })
    .returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_APPLICATION_SAVED, entityType: "dealer", entityId: row.id, newValue: { status: "DRAFT", via: "onboarding_v2_from_shop", shopId: shop.id, panFromShop: !!pan.panHash } }, client);
  return row;
}

/* ============================================================= instant approval */

/**
 * Approves a DRAFT / PENDING dealer at once (no admin step) — the parts of decideDealer's APPROVE that make a dealer
 * live: status APPROVED, the GKD dealer code, the DEALER role, the default scheme (Free Dealership) — and writes the
 * marketplace role to the history. An APPROVED dealer is returned unchanged. A closed dealer is left as it
 * is (never throws on a payment path). Call inside the caller's transaction; the notice goes after the commit.
 */
export async function approveDealerInstantly(
  client: DbClient,
  dealer: Dealer,
  role: "dealer_free" | "franchisee_paid",
  reason: string,
): Promise<{ dealer: Dealer; code: string | null; approvedNow: boolean }> {
  const actorId = dealer.userId;
  const existingCode = async () => (await listDealerCodes(dealer.id, client)).find((c) => c.kind !== "SALESPERSON" && c.status === "ACTIVE")?.code ?? null;
  if (dealer.isInternal || CLOSED_DEALER.includes(dealer.status)) return { dealer, code: null, approvedNow: false };
  if (dealer.status === "APPROVED") return { dealer, code: await existingCode(), approvedNow: false };
  const now = new Date();
  const actor = { id: actorId ?? dealer.id, role: "CUSTOMER" as UserRole };
  const code =
    (await existingCode()) ??
    (await issueCode(client, { dealerId: dealer.id, kind: "DEALER", makeCode: () => prefixedCode("GKD"), label: `Dealer: ${dealer.legalName}`, referrerName: dealer.legalName, referrerUserId: dealer.userId }, actor)).code;
  // The default dealership scheme (Free Dealership), as an application without a choice gets on approval.
  const schemes = await import("@/server/dealers/scheme-registration");
  const requestedVersionId = dealer.requestedVersionId ?? (await schemes.chosenScheme(dealer, client))?.versionId ?? null;
  const [row] = await client
    .update(dealers)
    .set({ status: "APPROVED", statusReason: reason, submittedAt: dealer.submittedAt ?? now, decidedAt: now, decidedBy: null, agreementStart: dealer.agreementStart ?? istDate(now), requestedVersionId, updatedAt: now })
    .where(eq(dealers.id, dealer.id))
    .returning();
  if (dealer.userId) {
    // DEFAULT – confirm with Sanjay: the role grant source is ADMIN (the platform approves; no new source value).
    await grantRole(dealer.userId, "DEALER", { source: "ADMIN", grantedBy: dealer.userId, activateIfCustomer: true }, client);
    await recordRoleChange({ userId: dealer.userId, role, action: "GRANTED", dealerId: dealer.id, actorUserId: dealer.userId, reason }, client);
  }
  await schemes.assignOnApproval(row, actor.id, client);
  await recordAudit({ actorId: dealer.userId, actorRole: "CUSTOMER", action: AUDIT_ACTIONS.DEALER_STATUS_CHANGED, entityType: "dealer", entityId: dealer.id, previousValue: { status: dealer.status }, newValue: { status: "APPROVED", code, reason, via: "onboarding_v2_instant", role } }, client);
  return { dealer: row, code, approvedNow: true };
}

/* ============================================================= paid franchise go-live */

/**
 * Onboarding v2 paid booking, after its allocations are ACTIVE: the dealer approved (GKD code, DEALER role), one
 * GKF code per franchise, the free team's earlier shops attached, and franchisee_paid GRANTED in the role history
 * (once per dealer). Idempotent. Run in a savepoint of the capture (a failure never undoes the payment) and again
 * by the 5-minute franchise job until it succeeds.
 */
export async function goLiveV2Booking(client: DbClient, bookingId: string): Promise<{ codes: number }> {
  const [booking] = await client.select().from(franchiseBookings).where(eq(franchiseBookings.id, bookingId));
  if (!booking?.planId || booking.kind !== "NEW") return { codes: 0 };
  const [dealer] = await client.select().from(dealers).where(eq(dealers.id, booking.ownerDealerId)).for("update");
  if (!dealer) return { codes: 0 };
  const approved = (await approveDealerInstantly(client, dealer, "franchisee_paid", "Onboarding v2: paid franchise live at payment")).dealer;
  if (approved.status !== "APPROVED") return { codes: 0 }; // a closed dealer account stays closed (admin decides)
  if (approved.userId) {
    const [seen] = await client
      .select({ id: onboardingRoleHistory.id })
      .from(onboardingRoleHistory)
      .where(and(eq(onboardingRoleHistory.userId, approved.userId), eq(onboardingRoleHistory.role, "franchisee_paid"), eq(onboardingRoleHistory.action, "GRANTED"), eq(onboardingRoleHistory.dealerId, approved.id)))
      .limit(1);
    if (!seen) await recordRoleChange({ userId: approved.userId, role: "franchisee_paid", action: "GRANTED", dealerId: approved.id, actorUserId: approved.userId, reason: "Onboarding v2: paid franchise live at payment" }, client);
  }
  const { ensureAllocationCode } = await import("@/server/franchise/codes");
  const { attachUpgradeShops } = await import("@/server/franchise/booking");
  const live = await client.select().from(franchiseAllocations).where(and(eq(franchiseAllocations.bookingId, booking.id), inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"])));
  for (const a of live) {
    await ensureAllocationCode(client, a);
    await attachUpgradeShops(client, a);
  }
  return { codes: live.length };
}

/** 5-minute franchise job: v2 paid bookings whose go-live did not finish at capture (no code yet, or dealer not approved). */
export async function retryV2GoLive(): Promise<{ retried: number; failed: number }> {
  const rows = await db
    .selectDistinct({ id: franchiseBookings.id })
    .from(franchiseBookings)
    .innerJoin(franchiseAllocations, eq(franchiseAllocations.bookingId, franchiseBookings.id))
    .innerJoin(dealers, eq(dealers.id, franchiseBookings.ownerDealerId))
    .leftJoin(franchiseCodes, eq(franchiseCodes.allocationId, franchiseAllocations.id))
    .where(
      and(
        eq(franchiseBookings.status, "PAID"),
        eq(franchiseBookings.kind, "NEW"),
        sql`${franchiseBookings.planId} is not null`,
        inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"]),
        sql`(${franchiseCodes.id} is null or ${dealers.status} in ('DRAFT', 'PENDING'))`,
        isNull(franchiseAllocations.kycDueAt),
      ),
    );
  let retried = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await db.transaction((tx) => goLiveV2Booking(tx, r.id));
      retried++;
    } catch (e) {
      failed++;
      console.error("[onboarding-v2] franchise go-live retry failed", r.id, e);
    }
  }
  return { retried, failed };
}

/* ============================================================= flow */

export interface StartState {
  enabled: boolean;
  shop: { id: string; name: string } | null;
  dealer: { id: string; status: string; legalName: string; code: string | null } | null;
  roles: string[];
  isFreeDealer: boolean;
  isFranchisee: boolean;
  /** What still stops the first payout (PAN, verified bank) — never going live. */
  payoutMissing: string[];
}

export function payoutMissingFor(dealer: Pick<Dealer, "panHash" | "bankStatus"> | null): string[] {
  if (!dealer) return [];
  const missing: string[] = [];
  if (!dealer.panHash) missing.push("PAN");
  if (dealer.bankStatus !== "VERIFIED") missing.push("payout bank account");
  return missing;
}

/** Everything /franchise/start needs for this account. */
export async function franchiseStartState(userId: string): Promise<StartState> {
  const enabled = await onboardingV2Enabled();
  const [shop, roles, dealerRow] = await Promise.all([
    liveShopForUser(userId),
    listMarketplaceRoles(userId),
    db.select().from(dealers).where(eq(dealers.userId, userId)).orderBy(desc(dealers.createdAt)).limit(1).then((r) => r[0] ?? null),
  ]);
  const code = dealerRow && dealerRow.status === "APPROVED" ? ((await listDealerCodes(dealerRow.id)).find((c) => c.kind !== "SALESPERSON" && c.status === "ACTIVE")?.code ?? null) : null;
  return {
    enabled,
    shop: shop ? { id: shop.id, name: shop.name } : null,
    dealer: dealerRow ? { id: dealerRow.id, status: dealerRow.status, legalName: dealerRow.legalName, code } : null,
    roles: roles.roles,
    isFreeDealer: roles.roles.includes("dealer_free"),
    isFranchisee: roles.roles.includes("franchisee_paid"),
    payoutMissing: payoutMissingFor(dealerRow),
  };
}

/**
 * Model "free dealer": a REQUEST (owner, 27-Nov-2026; replaces "live at once", DEFAULT #15). From his live shop the
 * dealer row is made and sent for approval (PENDING, source SHOP_REQUEST); an admin approves it in Admin → Dealers
 * (decideDealer), which issues the GKD code and tells him. Idempotent: a pending request is returned as it is, an
 * approved dealer gets his code back. Needs the flag and a live shop.
 */
export async function becomeFreeDealer(actor: Actor): Promise<{ dealerId: string; code: string | null; approvedNow: boolean; status: Dealer["status"] }> {
  await requireFlag();
  const result = await db.transaction(async (tx) => {
    // One start at a time per account (a double tap must not make two dealer rows).
    await tx.execute(sqlLock(actor.id));
    const dealer = await ensureDealerFromShop(actor, tx);
    if (dealer.status === "APPROVED") {
      const code = (await listDealerCodes(dealer.id, tx)).find((c) => c.kind !== "SALESPERSON" && c.status === "ACTIVE")?.code ?? null;
      return { dealerId: dealer.id, code, approvedNow: false, status: dealer.status, requestedNow: false, legalName: dealer.legalName };
    }
    if (dealer.status === "PENDING") return { dealerId: dealer.id, code: null, approvedNow: false, status: dealer.status, requestedNow: false, legalName: dealer.legalName };
    const now = new Date();
    const [row] = await tx
      .update(dealers)
      .set({ status: "PENDING", source: "SHOP_REQUEST", submittedAt: now, statusReason: "Free franchisee request from a live shop", updatedAt: now })
      .where(and(eq(dealers.id, dealer.id), eq(dealers.status, "DRAFT")))
      .returning();
    if (!row) throw conflict("Your request changed; reload and try again.");
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_APPLICATION_SUBMITTED, entityType: "dealer", entityId: dealer.id, newValue: { status: "PENDING", via: "onboarding_v2_free_request" } }, tx);
    return { dealerId: dealer.id, code: null, approvedNow: false, status: row.status, requestedNow: true, legalName: row.legalName };
  });
  if (result.requestedNow) {
    await notify({ userId: actor.id, type: NOTIFICATION_TYPES.DEALER_APPLICATION_RECEIVED, vars: { legalName: result.legalName }, actionUrl: "/franchise/start", dedupeKey: `ov2-dealer-request:${result.dealerId}` }).catch((e) => console.error("[onboarding-v2] request notice failed", result.dealerId, e));
    const admins = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "ADMIN"), eq(users.status, "ACTIVE"), isNull(users.deletedAt)));
    for (const a of admins) {
      await notify({
        userId: a.id,
        type: NOTIFICATION_TYPES.DEALER_APPLICATION_RECEIVED,
        title: `Free franchisee request: ${result.legalName}`,
        body: `${result.legalName} (a live GoKesari shop) asks to become a free franchisee. Approve or reject it in Admin → Dealers → Pending approval; approval issues the dealer code.`,
        actionUrl: `/admin/dealers/${result.dealerId}`,
        dedupeKey: `ov2-dealer-request-admin:${result.dealerId}:${a.id}`,
      }).catch((e) => console.error("[onboarding-v2] admin request notice failed", result.dealerId, e));
    }
  }
  return { dealerId: result.dealerId, code: result.code, approvedNow: result.approvedNow, status: result.status };
}

/**
 * Model "paid franchise", step 1: the dealer row from the shop (no PAN form). Zones, plan, coupon and payment follow
 * through the booking API with the plan id (reserveZones → startBookingPayment → onFranchiseFeeCaptured).
 */
export async function startPaidFranchise(actor: Actor): Promise<{ dealerId: string; status: string }> {
  await requireFlag();
  const dealer = await db.transaction(async (tx) => {
    await tx.execute(sqlLock(actor.id));
    return ensureDealerFromShop(actor, tx);
  });
  return { dealerId: dealer.id, status: dealer.status };
}

function sqlLock(userId: string) {
  return sql`select pg_advisory_xact_lock(hashtext(${`ov2-franchise:${userId}`}))`;
}

/* ============================================================= plans (admin) */

export interface PlanInput {
  code: string;
  name: string;
  description?: string;
  durationMonths: number;
  /** Null = the zone's own tier fee. */
  pricePerZonePaise: number | null;
  gstExtra: boolean;
  isLaunchOffer: boolean;
  active: boolean;
  sortOrder: number;
}

/** Plans, in display order (active only for buyers). */
export async function listPlans(options: { activeOnly?: boolean } = {}, client: DbClient = db) {
  const rows = await client.select().from(franchisePlans).orderBy(asc(franchisePlans.sortOrder), asc(franchisePlans.createdAt));
  return options.activeOnly ? rows.filter((p) => p.active) : rows;
}

function cleanPlan(input: PlanInput): PlanInput {
  const code = input.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 40);
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 120);
  const fields: Record<string, string> = {};
  if (code.length < 2) fields.code = "A short code like LAUNCH_1Y.";
  if (name.length < 3) fields.name = "A name buyers understand.";
  if (!Number.isInteger(input.durationMonths) || input.durationMonths < 1 || input.durationMonths > 120) fields.durationMonths = "1 to 120 months.";
  if (input.pricePerZonePaise != null && (!Number.isInteger(input.pricePerZonePaise) || input.pricePerZonePaise < 100 || input.pricePerZonePaise > 10_000_000_00)) fields.pricePerZonePaise = "₹1 to ₹1,00,00,000, or empty for the zone's tier fee.";
  if (Object.keys(fields).length) throw validationFailed("Please check the plan.", { fields });
  return { ...input, code, name, description: (input.description ?? "").trim().slice(0, 500), sortOrder: Math.trunc(input.sortOrder) || 0 };
}

/** ADMIN: add a plan (audited). */
export async function createPlan(input: PlanInput, actor: Actor) {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change franchise plans.");
  const p = cleanPlan(input);
  const [dup] = await db.select({ id: franchisePlans.id }).from(franchisePlans).where(eq(franchisePlans.code, p.code));
  if (dup) throw conflict(`A plan with code ${p.code} already exists.`);
  const [row] = await db.insert(franchisePlans).values({ ...p, description: p.description ?? "", updatedBy: actor.id }).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_CONFIG_CHANGED, entityType: "franchise_plan", entityId: row.id, newValue: { created: row } });
  return row;
}

/** ADMIN: edit a plan (code included); existing bookings keep the plan id and their paid amounts. Audited. */
export async function updatePlan(id: string, input: PlanInput, actor: Actor) {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change franchise plans.");
  const p = cleanPlan(input);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(franchisePlans).where(eq(franchisePlans.id, id)).for("update");
    if (!before) throw notFound("Plan");
    if (p.code !== before.code) {
      const [dup] = await tx.select({ id: franchisePlans.id }).from(franchisePlans).where(eq(franchisePlans.code, p.code));
      if (dup) throw conflict(`A plan with code ${p.code} already exists.`);
    }
    const [row] = await tx.update(franchisePlans).set({ ...p, description: p.description ?? "", updatedAt: new Date(), updatedBy: actor.id }).where(eq(franchisePlans.id, id)).returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_CONFIG_CHANGED, entityType: "franchise_plan", entityId: id, previousValue: before, newValue: row }, tx);
    return row;
  });
}

/** ADMIN: deactivate (no new bookings on it) or reactivate a plan. Audited. */
export async function setPlanActive(id: string, active: boolean, actor: Actor) {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change franchise plans.");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(franchisePlans).where(eq(franchisePlans.id, id)).for("update");
    if (!before) throw notFound("Plan");
    const [row] = await tx.update(franchisePlans).set({ active, updatedAt: new Date(), updatedBy: actor.id }).where(eq(franchisePlans.id, id)).returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_CONFIG_CHANGED, entityType: "franchise_plan", entityId: id, previousValue: { active: before.active }, newValue: { active } }, tx);
    return row;
  });
}
