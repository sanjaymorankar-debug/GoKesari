/**
 * Administration of shop self-registration (Module 3): fee tiers,
 * distributor types and distributors (commission), referral codes for
 * self-registration, the auto-approved shops list, unpaid registrations,
 * the commission report and the mock SMS/WhatsApp outbox.
 */
import { and, asc, count, desc, eq, gte, ilike, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  COMMISSION_TYPES,
  distributors,
  distributorTypes,
  outboundTestMessages,
  referralCodes,
  referralCommissions,
  referralRedemptions,
  registrationFeeTiers,
  registrationPayments,
  shopRegistrations,
  shops,
  users,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

type Actor = { id: string; role: UserRole };

/* ------------------------------------------------------------------ tiers */

export async function listTiers() {
  return db.select().from(registrationFeeTiers).orderBy(asc(registrationFeeTiers.sortOrder));
}

export const tierSchema = z.object({
  label: z.string().trim().min(2).max(40),
  description: z.string().trim().max(300).nullish(),
  amountPaise: z.number().int().min(0).max(100_000_000),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(100).optional(),
});

export async function updateTier(code: string, input: z.infer<typeof tierSchema>, actor: Actor) {
  if (input.isActive && input.amountPaise <= 0) throw validationFailed("Set an amount above ₹0 before offering this plan.");
  const [before] = await db.select().from(registrationFeeTiers).where(eq(registrationFeeTiers.code, code));
  if (!before) throw notFound("Fee plan");
  const [row] = await db
    .update(registrationFeeTiers)
    .set({ label: input.label, description: input.description ?? null, amountPaise: input.amountPaise, isActive: input.isActive, sortOrder: input.sortOrder ?? before.sortOrder, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(registrationFeeTiers.id, before.id))
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.REGISTRATION_FEE_TIER_CHANGED,
    entityType: "registration_fee_tier",
    entityId: row.id,
    previousValue: { amountPaise: before.amountPaise, isActive: before.isActive, label: before.label },
    newValue: { amountPaise: row.amountPaise, isActive: row.isActive, label: row.label },
  });
  return row;
}

/* ------------------------------------------------------------ distributors */

const commission = {
  commissionType: z.enum(COMMISSION_TYPES),
  /** FLAT: paise. PERCENT: basis points (1000 = 10%). */
  commissionValue: z.number().int().min(0).max(100_000_000),
};

function checkCommission(type: "FLAT" | "PERCENT", value: number) {
  if (type === "PERCENT" && value > 10_000) throw validationFailed("A percentage commission cannot be above 100%.");
}

export const distributorTypeSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,30}$/, "Code: 2–30 letters, digits, - or _."),
  name: z.string().trim().min(2).max(80),
  ...commission,
  isActive: z.boolean().default(true),
});

export async function listDistributorTypes() {
  return db.select().from(distributorTypes).orderBy(asc(distributorTypes.name));
}

export async function saveDistributorType(id: string | null, input: z.infer<typeof distributorTypeSchema>, actor: Actor) {
  checkCommission(input.commissionType, input.commissionValue);
  try {
    const [row] = id
      ? await db.update(distributorTypes).set({ ...input, updatedAt: new Date() }).where(eq(distributorTypes.id, id)).returning()
      : await db.insert(distributorTypes).values({ ...input, createdBy: actor.id }).returning();
    if (!row) throw notFound("Distributor type");
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DISTRIBUTOR_TYPE_SAVED, entityType: "distributor_type", entityId: row.id, newValue: input });
    return row;
  } catch (error) {
    if ((error as { code?: string; cause?: { code?: string } }).cause?.code === "23505" || (error as { code?: string }).code === "23505") {
      throw conflict("A distributor type with this code exists.");
    }
    throw error;
  }
}

export const distributorSchema = z.object({
  distributorTypeId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  phoneE164: z
    .string()
    .trim()
    .regex(/^\+91[6-9]\d{9}$/, "Mobile as +91XXXXXXXXXX")
    .nullish(),
  email: z.string().trim().email().nullish(),
  district: z.string().trim().max(80).nullish(),
  state: z.string().trim().max(80).nullish(),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  /** Both set = the distributor's own commission; both null = the type's default. */
  commissionType: z.enum(COMMISSION_TYPES).nullish(),
  commissionValue: z.number().int().min(0).max(100_000_000).nullish(),
  note: z.string().trim().max(500).nullish(),
});

export async function saveDistributor(id: string | null, input: z.infer<typeof distributorSchema>, actor: Actor) {
  const own = input.commissionType != null && input.commissionValue != null;
  if ((input.commissionType == null) !== (input.commissionValue == null)) throw validationFailed("Give both the commission type and value, or neither (use the type's default).");
  if (own) checkCommission(input.commissionType!, input.commissionValue!);
  const [type] = await db.select({ id: distributorTypes.id }).from(distributorTypes).where(eq(distributorTypes.id, input.distributorTypeId));
  if (!type) throw notFound("Distributor type");
  const values = {
    distributorTypeId: input.distributorTypeId,
    name: input.name,
    phoneE164: input.phoneE164 ?? null,
    email: input.email ?? null,
    district: input.district ?? null,
    state: input.state ?? null,
    status: input.status,
    commissionType: own ? input.commissionType! : null,
    commissionValue: own ? input.commissionValue! : null,
    note: input.note ?? null,
  };
  const [row] = id
    ? await db.update(distributors).set({ ...values, updatedAt: new Date() }).where(eq(distributors.id, id)).returning()
    : await db.insert(distributors).values({ ...values, createdBy: actor.id }).returning();
  if (!row) throw notFound("Distributor");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DISTRIBUTOR_SAVED, entityType: "distributor", entityId: row.id, newValue: values });
  return row;
}

export async function listDistributors() {
  return db
    .select({
      distributor: distributors,
      typeName: distributorTypes.name,
      typeCommissionType: distributorTypes.commissionType,
      typeCommissionValue: distributorTypes.commissionValue,
      codes: sql<number>`(select count(*) from ${referralCodes} rc where rc.distributor_id = ${distributors.id})::int`,
      shops: sql<number>`(select count(*) from ${referralCommissions} c where c.distributor_id = ${distributors.id})::int`,
      commissionPaise: sql<number>`(select coalesce(sum(c.amount_paise), 0) from ${referralCommissions} c where c.distributor_id = ${distributors.id} and c.status <> 'REVERSED')::bigint`,
    })
    .from(distributors)
    .innerJoin(distributorTypes, eq(distributorTypes.id, distributors.distributorTypeId))
    .orderBy(asc(distributors.name));
}

/* ---------------------------------------------------- codes (self-service) */

export async function listCodesWithUsage() {
  const rows = await db
    .select({
      code: referralCodes,
      distributorName: distributors.name,
      redeemed: sql<number>`(select count(*) from ${referralRedemptions} r where r.referral_code_id = ${referralCodes.id})::int`,
      held: sql<number>`(select count(*) from ${shopRegistrations} s where s.referral_code_id = ${referralCodes.id} and s.status = 'PENDING_PAYMENT' and s.hold_expires_at > now())::int`,
    })
    .from(referralCodes)
    .leftJoin(distributors, eq(distributors.id, referralCodes.distributorId))
    .orderBy(desc(referralCodes.createdAt))
    .limit(500);
  return rows.map((r) => ({
    id: r.code.id,
    code: r.code.code,
    label: r.code.label,
    status: r.code.status,
    expiresAt: r.code.expiresAt,
    distributorId: r.code.distributorId,
    distributorName: r.distributorName,
    maxUses: r.code.maxUses,
    used: r.redeemed,
    held: r.held,
  }));
}

/* ---------------------------------------------------- auto-approved shops */

export const autoApprovedQuerySchema = z.object({
  code: z.string().trim().max(40).optional(),
  distributorId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  profile: z.enum(["complete", "incomplete"]).optional(),
  q: z.string().trim().max(100).optional(),
});

export async function listAutoApprovedShops(query: z.infer<typeof autoApprovedQuerySchema>) {
  const istStart = (d: string) => new Date(`${d}T00:00:00+05:30`);
  return db
    .select({
      shopId: shops.id,
      name: shops.name,
      registrationNumber: shops.registrationNumber,
      status: shops.status,
      approvedAt: shops.autoApprovedAt,
      profileCompletedAt: shops.profileCompletedAt,
      feePaise: shops.amountPaidPaise,
      ownerPhone: users.phoneE164,
      code: referralCodes.code,
      distributorName: distributors.name,
      commissionPaise: referralCommissions.amountPaise,
      commissionStatus: referralCommissions.status,
      tier: registrationFeeTiers.label,
    })
    .from(shops)
    .innerJoin(users, eq(users.id, shops.ownerId))
    .leftJoin(shopRegistrations, eq(shopRegistrations.id, shops.shopRegistrationId))
    .leftJoin(referralCodes, eq(referralCodes.id, shopRegistrations.referralCodeId))
    .leftJoin(referralCommissions, eq(referralCommissions.shopRegistrationId, shopRegistrations.id))
    .leftJoin(distributors, eq(distributors.id, shopRegistrations.distributorId))
    .leftJoin(registrationFeeTiers, eq(registrationFeeTiers.id, shops.registrationTierId))
    .where(
      and(
        eq(shops.onboardingChannel, "SELF_SERVICE"),
        isNull(shops.deletedAt),
        query.code ? eq(referralCodes.code, query.code.toUpperCase()) : undefined,
        query.distributorId ? eq(shopRegistrations.distributorId, query.distributorId) : undefined,
        query.from ? gte(shops.autoApprovedAt, istStart(query.from)) : undefined,
        query.to ? lt(shops.autoApprovedAt, new Date(istStart(query.to).getTime() + 86_400_000)) : undefined,
        query.profile === "complete" ? isNotNull(shops.profileCompletedAt) : query.profile === "incomplete" ? isNull(shops.profileCompletedAt) : undefined,
        query.q ? or(ilike(shops.name, `%${query.q}%`), ilike(shops.registrationNumber, `%${query.q}%`), ilike(users.phoneE164, `%${query.q}%`)) : undefined,
      ),
    )
    .orderBy(desc(shops.autoApprovedAt))
    .limit(500);
}

/* ------------------------------------------------- unpaid registrations */

export async function listRegistrations(status: "PENDING_PAYMENT" | "APPROVED" | "CANCELLED" | "ALL" = "PENDING_PAYMENT") {
  const rows = await db
    .select({
      registration: shopRegistrations,
      code: referralCodes.code,
      tier: registrationFeeTiers.label,
      lastPaymentStatus: sql<string | null>`(select p.status from ${registrationPayments} p where p.shop_registration_id = ${shopRegistrations.id} order by p.created_at desc limit 1)`,
      attempts: sql<number>`(select count(*) from ${registrationPayments} p where p.shop_registration_id = ${shopRegistrations.id})::int`,
    })
    .from(shopRegistrations)
    .innerJoin(referralCodes, eq(referralCodes.id, shopRegistrations.referralCodeId))
    .innerJoin(registrationFeeTiers, eq(registrationFeeTiers.id, shopRegistrations.feeTierId))
    .where(status === "ALL" ? undefined : eq(shopRegistrations.status, status))
    .orderBy(desc(shopRegistrations.createdAt))
    .limit(500);
  return rows.map((r) => ({
    id: r.registration.id,
    shopName: r.registration.shopName,
    mobile: r.registration.mobileE164,
    status: r.registration.status,
    feePaise: r.registration.feePaise,
    tier: r.tier,
    code: r.code,
    holdExpiresAt: r.registration.holdExpiresAt,
    lastPaymentStatus: r.lastPaymentStatus,
    attempts: r.attempts,
    createdAt: r.registration.createdAt,
    lastLinkSentAt: r.registration.lastLinkSentAt,
    shopId: r.registration.shopId,
  }));
}

export async function paymentProblems() {
  return db
    .select({ payment: registrationPayments, shopName: shopRegistrations.shopName })
    .from(registrationPayments)
    .innerJoin(shopRegistrations, eq(shopRegistrations.id, registrationPayments.shopRegistrationId))
    .where(or(eq(registrationPayments.status, "MISMATCH"), sql`${registrationPayments.failureReason} like '%refund due'`))
    .orderBy(desc(registrationPayments.updatedAt))
    .limit(100);
}

/* -------------------------------------------------------------- commission */

export async function commissionReport() {
  const byDistributor = await db
    .select({
      distributorId: referralCommissions.distributorId,
      name: distributors.name,
      status: referralCommissions.status,
      shops: count(),
      amountPaise: sql<number>`coalesce(sum(${referralCommissions.amountPaise}), 0)::bigint`,
      feesPaise: sql<number>`coalesce(sum(${referralCommissions.basePaise}), 0)::bigint`,
    })
    .from(referralCommissions)
    .leftJoin(distributors, eq(distributors.id, referralCommissions.distributorId))
    .groupBy(referralCommissions.distributorId, distributors.name, referralCommissions.status)
    .orderBy(asc(distributors.name));
  const rows = await db
    .select({
      commission: referralCommissions,
      shopName: shops.name,
      registrationNumber: shops.registrationNumber,
      code: referralCodes.code,
      distributorName: distributors.name,
    })
    .from(referralCommissions)
    .innerJoin(shops, eq(shops.id, referralCommissions.shopId))
    .innerJoin(referralCodes, eq(referralCodes.id, referralCommissions.referralCodeId))
    .leftJoin(distributors, eq(distributors.id, referralCommissions.distributorId))
    .orderBy(desc(referralCommissions.createdAt))
    .limit(500);
  return { byDistributor: byDistributor.map((r) => ({ ...r, shops: Number(r.shops), amountPaise: Number(r.amountPaise), feesPaise: Number(r.feesPaise) })), rows };
}

const NEXT: Record<string, string[]> = { ACCRUED: ["APPROVED", "REVERSED"], APPROVED: ["PAID", "REVERSED"], PAID: [], REVERSED: [] };

export async function setCommissionStatus(id: string, status: "APPROVED" | "PAID" | "REVERSED", note: string | null, actor: Actor) {
  const [current] = await db.select().from(referralCommissions).where(eq(referralCommissions.id, id));
  if (!current) throw notFound("Commission");
  if (!NEXT[current.status].includes(status)) throw conflict(`A ${current.status.toLowerCase()} commission cannot become ${status.toLowerCase()}.`);
  const [row] = await db
    .update(referralCommissions)
    .set({ status, note: note ?? current.note, updatedAt: new Date() })
    .where(and(eq(referralCommissions.id, id), eq(referralCommissions.status, current.status)))
    .returning();
  if (!row) throw conflict("The commission changed meanwhile. Reload and try again.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.REFERRAL_COMMISSION_STATUS_CHANGED,
    entityType: "referral_commission",
    entityId: id,
    previousValue: { status: current.status },
    newValue: { status, note },
  });
  return row;
}

/* ------------------------------------------------------------ test outbox */

export async function listTestMessages(to?: string) {
  return db
    .select()
    .from(outboundTestMessages)
    .where(to ? ilike(outboundTestMessages.toAddress, `%${to.replace(/\D/g, "")}%`) : undefined)
    .orderBy(desc(outboundTestMessages.createdAt))
    .limit(200);
}

