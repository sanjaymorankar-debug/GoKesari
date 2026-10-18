/**
 * Manufacturer accounts, their portal users and their bulk-upload API keys
 * (batch-2026-10 WS-D, F9.1.2).
 *
 * An administrator (PMD_MANUFACTURER_MANAGE) creates the account — the brand
 * owner's agreement to supply data is the reason it exists — and links the
 * people who may use /manufacturer. A member issues API keys there: the key is
 * shown ONCE, only its SHA-256 is stored, it can be revoked at once, every use
 * is rate limited per key (rule pmdSources.apiRequestsPerMinute) and audited.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, unauthenticated, validationFailed } from "@/lib/errors";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  pmdManufacturerAccounts,
  pmdManufacturerApiKeys,
  pmdManufacturerMembers,
  users,
  type PmdManufacturerAccount,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";

interface Actor {
  id: string;
  role: UserRole;
}

export const API_KEY_PREFIX = "gkm_";

export const hashApiKey = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export async function createManufacturerAccount(
  input: { name: string; brandNames?: string[]; contactEmail?: string | null },
  actor: Actor,
): Promise<PmdManufacturerAccount> {
  const name = input.name.trim();
  if (name.length < 2) throw validationFailed("Enter the manufacturer's name.");
  const slug = slugify(name);
  if (!slug) throw validationFailed("The name needs letters or digits.");
  const brandNames = [...new Set((input.brandNames ?? []).map((b) => b.trim()).filter(Boolean))];
  try {
    const [account] = await db
      .insert(pmdManufacturerAccounts)
      .values({ name, slug, brandNames, contactEmail: input.contactEmail?.trim() || null, sourceKey: `mfr_${slug}`, createdBy: actor.id })
      .returning();
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.PMD_MANUFACTURER_CREATED,
      entityType: "pmd_manufacturer",
      entityId: account.id,
      newValue: { name, slug, brandNames, sourceKey: account.sourceKey },
    });
    return account;
  } catch (error) {
    if ((error as { code?: string; cause?: { code?: string } })?.cause?.code === "23505" || (error as { code?: string }).code === "23505") {
      throw conflict("A manufacturer with this name already exists.");
    }
    throw error;
  }
}

export async function listManufacturerAccounts(): Promise<(PmdManufacturerAccount & { members: number; activeKeys: number })[]> {
  return db
    .select({
      account: pmdManufacturerAccounts,
      members: sql<number>`(select count(*)::int from ${pmdManufacturerMembers} m where m.account_id = ${pmdManufacturerAccounts.id})`,
      activeKeys: sql<number>`(select count(*)::int from ${pmdManufacturerApiKeys} k where k.account_id = ${pmdManufacturerAccounts.id} and k.revoked_at is null)`,
    })
    .from(pmdManufacturerAccounts)
    .orderBy(asc(pmdManufacturerAccounts.name))
    .then((rows) => rows.map((r) => ({ ...r.account, members: r.members, activeKeys: r.activeKeys })));
}

/** Links a user (by email) to the account. The user signs in as usual; membership is their access. */
export async function addManufacturerMember(
  accountId: string,
  input: { email: string; role?: "OWNER" | "UPLOADER" },
  actor: Actor,
): Promise<{ userId: string }> {
  const [account] = await db.select().from(pmdManufacturerAccounts).where(eq(pmdManufacturerAccounts.id, accountId));
  if (!account) throw notFound("Manufacturer");
  const email = input.email.trim().toLowerCase();
  const [user] = await db.select({ id: users.id }).from(users).where(and(eq(users.email, email), isNull(users.deletedAt)));
  if (!user) throw notFound("User with that email (they must sign in once first)");
  await db
    .insert(pmdManufacturerMembers)
    .values({ accountId, userId: user.id, role: input.role ?? "UPLOADER", createdBy: actor.id })
    .onConflictDoNothing();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PMD_MANUFACTURER_MEMBER_ADDED,
    entityType: "pmd_manufacturer",
    entityId: accountId,
    newValue: { userId: user.id, role: input.role ?? "UPLOADER" },
  });
  return { userId: user.id };
}

/** The manufacturer accounts this user belongs to (portal access). */
export async function manufacturerAccountsForUser(userId: string): Promise<PmdManufacturerAccount[]> {
  const rows = await db
    .select({ account: pmdManufacturerAccounts })
    .from(pmdManufacturerMembers)
    .innerJoin(pmdManufacturerAccounts, eq(pmdManufacturerAccounts.id, pmdManufacturerMembers.accountId))
    .where(eq(pmdManufacturerMembers.userId, userId))
    .orderBy(asc(pmdManufacturerAccounts.name));
  return rows.map((r) => r.account);
}

/** The signed-in user's account (the first, or the one asked for); 403 when they are not a member. */
export async function requireManufacturerMembership(userId: string, accountId?: string | null): Promise<PmdManufacturerAccount> {
  const accounts = await manufacturerAccountsForUser(userId);
  const account = accountId ? accounts.find((a) => a.id === accountId) : accounts[0];
  if (!account) throw forbidden("You are not a member of a manufacturer account.");
  if (account.status !== "ACTIVE") throw forbidden("This manufacturer account is suspended.");
  return account;
}

/* ------------------------------------------------------------------ keys */

export async function issueApiKey(accountId: string, input: { label?: string | null }, actor: Actor): Promise<{ id: string; key: string; prefix: string }> {
  const secret = randomBytes(24).toString("base64url");
  const key = `${API_KEY_PREFIX}${secret}`;
  const prefix = key.slice(0, API_KEY_PREFIX.length + 6);
  const [row] = await db
    .insert(pmdManufacturerApiKeys)
    .values({ accountId, label: input.label?.trim() || null, keyPrefix: prefix, keyHash: hashApiKey(key), createdBy: actor.id })
    .returning({ id: pmdManufacturerApiKeys.id });
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PMD_API_KEY_ISSUED,
    entityType: "pmd_manufacturer",
    entityId: accountId,
    newValue: { keyId: row.id, prefix, label: input.label ?? null },
  });
  return { id: row.id, key, prefix };
}

export async function listApiKeys(accountId: string) {
  return db
    .select({
      id: pmdManufacturerApiKeys.id,
      label: pmdManufacturerApiKeys.label,
      prefix: pmdManufacturerApiKeys.keyPrefix,
      createdAt: pmdManufacturerApiKeys.createdAt,
      lastUsedAt: pmdManufacturerApiKeys.lastUsedAt,
      useCount: pmdManufacturerApiKeys.useCount,
      revokedAt: pmdManufacturerApiKeys.revokedAt,
    })
    .from(pmdManufacturerApiKeys)
    .where(eq(pmdManufacturerApiKeys.accountId, accountId))
    .orderBy(desc(pmdManufacturerApiKeys.createdAt));
}

export async function revokeApiKey(accountId: string, keyId: string, actor: Actor): Promise<void> {
  const [row] = await db
    .update(pmdManufacturerApiKeys)
    .set({ revokedAt: new Date(), revokedBy: actor.id })
    .where(and(eq(pmdManufacturerApiKeys.id, keyId), eq(pmdManufacturerApiKeys.accountId, accountId), isNull(pmdManufacturerApiKeys.revokedAt)))
    .returning({ id: pmdManufacturerApiKeys.id });
  if (!row) throw notFound("Active API key");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PMD_API_KEY_REVOKED,
    entityType: "pmd_manufacturer",
    entityId: accountId,
    newValue: { keyId },
  });
}

export interface ApiKeySession {
  keyId: string;
  account: PmdManufacturerAccount;
}

/**
 * `Authorization: Bearer gkm_…` → the key's account. Missing, malformed,
 * unknown, revoked, or a suspended account → 401 with the same message (and an
 * audit row for a presented-but-refused key). Rate limited per key.
 */
export async function authenticateManufacturerApiKey(request: Request): Promise<ApiKeySession> {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const refuse = () => unauthenticated("A valid manufacturer API key is required (Authorization: Bearer <key>).");
  if (!presented.startsWith(API_KEY_PREFIX) || presented.length < API_KEY_PREFIX.length + 20) throw refuse();
  const hash = hashApiKey(presented);
  const [row] = await db
    .select({ key: pmdManufacturerApiKeys, account: pmdManufacturerAccounts })
    .from(pmdManufacturerApiKeys)
    .innerJoin(pmdManufacturerAccounts, eq(pmdManufacturerAccounts.id, pmdManufacturerApiKeys.accountId))
    .where(eq(pmdManufacturerApiKeys.keyHash, hash));
  if (!row || !timingSafeEqual(Buffer.from(row.key.keyHash), Buffer.from(hash))) throw refuse();
  if (row.key.revokedAt || row.account.status !== "ACTIVE") {
    await recordAudit({
      action: AUDIT_ACTIONS.PMD_API_KEY_USED,
      entityType: "pmd_manufacturer",
      entityId: row.account.id,
      newValue: { keyId: row.key.id, refused: row.key.revokedAt ? "revoked" : "account_suspended" },
    });
    throw refuse();
  }
  const rules = await getRule("pmdSources");
  enforceRateLimit(`pmd-api-key:${row.key.id}`, { limit: rules.apiRequestsPerMinute, windowMs: 60_000 });
  await db
    .update(pmdManufacturerApiKeys)
    .set({ lastUsedAt: new Date(), useCount: sql`${pmdManufacturerApiKeys.useCount} + 1` })
    .where(eq(pmdManufacturerApiKeys.id, row.key.id));
  return { keyId: row.key.id, account: row.account };
}
