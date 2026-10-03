/**
 * Referral codes (requirement §4.3).
 *
 * A code is created by an operator/admin, then attributed to a shop exactly once
 * at (or after) registration. `referral_redemptions` carries a UNIQUE(shop_id),
 * so a shop can never be double-attributed — the database refuses it rather than
 * relying on a service-layer check.
 */
import { and, desc, eq, isNull, like, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  referralCodes,
  referralRedemptions,
  shops,
  type ReferralCode,
  type ReferralStatus,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { insertReturning, updateReturning } from "@/server/db/returning";

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

  const [created] = await insertReturning(db, referralCodes, {
    code,
    label: input.label ?? null,
    referrerName: input.referrerName ?? null,
    referrerUserId: input.referrerUserId ?? null,
    expiresAt: input.expiresAt ?? null,
    note: input.note ?? null,
    createdBy: actor.id,
  });

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.REFERRAL_CODE_CREATED,
    entityType: "referral_code",
    entityId: created.id,
    newValue: { code: created.code, label: created.label },
  });
  return created;
}

export async function updateReferralCode(
  id: string,
  patch: {
    status?: ReferralStatus;
    label?: string | null;
    note?: string | null;
  },
  actor: Actor,
): Promise<ReferralCode> {
  const current = await db.query.referralCodes.findFirst({
    where: eq(referralCodes.id, id),
  });
  if (!current) throw notFound("Referral code");

  const [updated] = await updateReturning(
    db,
    referralCodes,
    { ...patch, updatedAt: new Date() },
    eq(referralCodes.id, id),
  );

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.REFERRAL_CODE_UPDATED,
    entityType: "referral_code",
    entityId: id,
    previousValue: { status: current.status, label: current.label },
    newValue: { status: updated.status, label: updated.label },
  });
  return updated;
}

/**
 * Resolves a code for use at registration. Rejects unknown, inactive and
 * expired codes rather than silently ignoring them, so a mistyped code is
 * visible to the operator instead of quietly losing the attribution.
 */
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
    throw validationFailed(
      `Referral code ${code} is ${found.status.toLowerCase()}.`,
    );
  }
  if (
    found.expiresAt &&
    found.expiresAt < new Date().toISOString().slice(0, 10)
  ) {
    throw validationFailed(
      `Referral code ${code} expired on ${found.expiresAt}.`,
    );
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
    const code = await resolveUsableCode(rawCode, tx);

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

export async function listReferralCodes(
  options: {
    status?: ReferralStatus;
    search?: string;
    limit?: number;
  } = {},
): Promise<(ReferralCode & { shopCount: number })[]> {
  const filters = [];
  if (options.status) filters.push(eq(referralCodes.status, options.status));
  if (options.search)
    filters.push(like(referralCodes.code, `%${options.search}%`));

  const rows = await db
    .select({
      code: referralCodes,
      shopCount: sql<number>`(
        SELECT CAST(COUNT(*) AS SIGNED) FROM ${referralRedemptions}
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
      shopCount: sql<number>`CAST(COUNT(${referralRedemptions.id}) AS SIGNED)`,
      feesAttributedPaise: sql<number>`CAST(COALESCE(SUM(${referralRedemptions.registrationFeePaise}), 0) AS SIGNED)`,
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
