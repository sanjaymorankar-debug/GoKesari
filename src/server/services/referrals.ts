/**
 * Referral codes (requirement §4.3).
 *
 * A code is created by an operator/admin, then attributed to a shop exactly once
 * at (or after) registration. `referral_redemptions` carries a UNIQUE(shop_id),
 * so a shop can never be double-attributed — the database refuses it rather than
 * relying on a service-layer check.
 */
import { and, count, desc, eq, gt, ilike, isNull, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  referralCodes,
  referralRedemptions,
  shopRegistrations,
  shops,
  type ReferralCode,
  type ReferralStatus,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

interface Actor {
  id: string;
  role: UserRole;
}

/** Codes are stored upper-cased so lookup is predictable and case-insensitive. */
function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export interface CreateReferralInput {
  code: string;
  label?: string | null;
  referrerName?: string | null;
  referrerUserId?: string | null;
  expiresAt?: string | null;
  note?: string | null;
  /** Module 3: the distributor credited, and how many shops may use the code (null = unlimited). */
  distributorId?: string | null;
  maxUses?: number | null;
}

export async function createReferralCode(
  input: CreateReferralInput,
  actor: Actor,
): Promise<ReferralCode> {
  const code = normaliseCode(input.code);
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) {
    throw validationFailed(
      "Referral code must be 3–32 characters: letters, digits, hyphen or underscore.",
    );
  }

  const existing = await db.query.referralCodes.findFirst({
    where: eq(referralCodes.code, code),
    columns: { id: true },
  });
  if (existing) throw conflict("That referral code already exists.");

  const [created] = await db
    .insert(referralCodes)
    .values({
      code,
      label: input.label ?? null,
      referrerName: input.referrerName ?? null,
      referrerUserId: input.referrerUserId ?? null,
      expiresAt: input.expiresAt ?? null,
      note: input.note ?? null,
      distributorId: input.distributorId ?? null,
      maxUses: input.maxUses ?? null,
      createdBy: actor.id,
    })
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.REFERRAL_CODE_CREATED,
    entityType: "referral_code",
    entityId: created.id,
    newValue: { code: created.code, label: created.label, distributorId: created.distributorId, maxUses: created.maxUses },
  });
  return created;
}

export async function updateReferralCode(
  id: string,
  patch: {
    status?: ReferralStatus;
    label?: string | null;
    note?: string | null;
    expiresAt?: string | null;
    distributorId?: string | null;
    maxUses?: number | null;
  },
  actor: Actor,
): Promise<ReferralCode> {
  const current = await db.query.referralCodes.findFirst({
    where: eq(referralCodes.id, id),
  });
  if (!current) throw notFound("Referral code");

  const [updated] = await db
    .update(referralCodes)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(referralCodes.id, id))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.REFERRAL_CODE_UPDATED,
    entityType: "referral_code",
    entityId: id,
    previousValue: { status: current.status, label: current.label, distributorId: current.distributorId, maxUses: current.maxUses, expiresAt: current.expiresAt },
    newValue: { status: updated.status, label: updated.label, distributorId: updated.distributorId, maxUses: updated.maxUses, expiresAt: updated.expiresAt },
  });
  return updated;
}

/**
 * Resolves a code for use at registration. Rejects unknown, inactive and
 * expired codes rather than silently ignoring them, so a mistyped code is
 * visible to the operator instead of quietly losing the attribution.
 */
/**
 * How many times a code is used: shops attributed to it, plus unpaid
 * self-registrations still holding a place on it (Module 3). Compared with
 * the code's usage limit (max_uses) on every path that takes a code.
 */
export async function referralCodeUses(codeId: string, client: DbClient = db): Promise<number> {
  const [{ redeemed }] = await client.select({ redeemed: count() }).from(referralRedemptions).where(eq(referralRedemptions.referralCodeId, codeId));
  const [{ held }] = await client
    .select({ held: count() })
    .from(shopRegistrations)
    .where(and(eq(shopRegistrations.referralCodeId, codeId), eq(shopRegistrations.status, "PENDING_PAYMENT"), gt(shopRegistrations.holdExpiresAt, new Date())));
  return Number(redeemed) + Number(held);
}

export async function resolveUsableCode(
  rawCode: string,
  client: DbClient = db,
): Promise<ReferralCode> {
  const code = normaliseCode(rawCode);
  const [found] = await client
    .select()
    .from(referralCodes)
    .where(eq(referralCodes.code, code))
    .limit(1);

  if (!found) throw validationFailed(`Referral code ${code} does not exist.`);
  if (found.status !== "ACTIVE") {
    throw validationFailed(`Referral code ${code} is ${found.status.toLowerCase()}.`);
  }
  if (found.expiresAt && found.expiresAt < new Date().toISOString().slice(0, 10)) {
    throw validationFailed(`Referral code ${code} expired on ${found.expiresAt}.`);
  }
  return found;
}

/**
 * A code a shop registers with: usable (above) and, when the code has a usage
 * limit (max_uses, Module 3), not used up by shops already. Customer sign-up
 * codes use resolveUsableCode alone: they take no shop's place.
 */
export async function resolveCodeForShop(rawCode: string, client: DbClient = db): Promise<ReferralCode> {
  const found = await resolveUsableCode(rawCode, client);
  if (found.maxUses != null && (await referralCodeUses(found.id, client)) >= found.maxUses) {
    throw validationFailed(`Referral code ${found.code} has already been used the maximum number of times.`);
  }
  return found;
}

/**
 * Attributes a shop to a referral code.
 *
 * Writes both the denormalised pointer on `shops` (so listings can filter
 * without a join) and the redemption row (which carries the fee snapshot for
 * referral revenue reporting).
 */
export async function attributeShopToCode(
  shopId: string,
  rawCode: string,
  actor: Actor,
  client?: DbClient,
): Promise<ReferralCode> {
  const run = async (tx: DbClient) => {
    const code = await resolveCodeForShop(rawCode, tx);

    const [shop] = await tx
      .select({
        id: shops.id,
        referralCodeId: shops.referralCodeId,
        registrationFeePaise: shops.registrationFeePaise,
      })
      .from(shops)
      .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)))
      .limit(1);
    if (!shop) throw notFound("Shop");
    if (shop.referralCodeId) {
      throw conflict("This shop is already attributed to a referral code.");
    }

    await tx
      .update(shops)
      .set({ referralCodeId: code.id, updatedAt: new Date() })
      .where(eq(shops.id, shopId));

    await tx.insert(referralRedemptions).values({
      referralCodeId: code.id,
      shopId,
      registrationFeePaise: shop.registrationFeePaise,
      redeemedBy: actor.id,
    });

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.REFERRAL_CODE_ASSIGNED,
        entityType: "shop",
        entityId: shopId,
        newValue: { referralCode: code.code },
      },
      tx,
    );
    return code;
  };

  return client ? run(client) : db.transaction(run);
}

export async function getReferralCodeById(
  id: string,
): Promise<ReferralCode | null> {
  const [found] = await db
    .select()
    .from(referralCodes)
    .where(eq(referralCodes.id, id))
    .limit(1);
  return found ?? null;
}

export async function listReferralCodes(options: {
  status?: ReferralStatus;
  search?: string;
  limit?: number;
} = {}): Promise<(ReferralCode & { shopCount: number })[]> {
  const filters = [];
  if (options.status) filters.push(eq(referralCodes.status, options.status));
  if (options.search) filters.push(ilike(referralCodes.code, `%${options.search}%`));

  const rows = await db
    .select({
      code: referralCodes,
      shopCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${referralRedemptions}
        WHERE ${referralRedemptions.referralCodeId} = ${referralCodes.id}
      )`,
    })
    .from(referralCodes)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(referralCodes.createdAt))
    .limit(options.limit ?? 100);

  return rows.map((r) => ({ ...r.code, shopCount: r.shopCount }));
}

/** Referral performance for the admin report (§14, §23). */
export async function getReferralPerformance() {
  return db
    .select({
      id: referralCodes.id,
      code: referralCodes.code,
      label: referralCodes.label,
      referrerName: referralCodes.referrerName,
      status: referralCodes.status,
      shopCount: sql<number>`COUNT(${referralRedemptions.id})::int`,
      feesAttributedPaise: sql<number>`COALESCE(SUM(${referralRedemptions.registrationFeePaise}), 0)::bigint`,
    })
    .from(referralCodes)
    .leftJoin(
      referralRedemptions,
      eq(referralRedemptions.referralCodeId, referralCodes.id),
    )
    .groupBy(
      referralCodes.id,
      referralCodes.code,
      referralCodes.label,
      referralCodes.referrerName,
      referralCodes.status,
    )
    .orderBy(desc(sql`COUNT(${referralRedemptions.id})`));
}
