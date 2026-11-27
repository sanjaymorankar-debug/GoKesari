/**
 * Trusted devices (docs/dual-auth-2026-11; table trusted_devices, 0219).
 *
 * Each browser (and the Android / iOS app, whose WebView keeps its own cookies) gets a random device token in the
 * httpOnly cookie gk_device; the table stores only its sha256, per account. A device is trusted for an account for
 * rule dualAuth.trustDays (30) after both factors were completed on it. On a trusted device a customer, shop owner,
 * dealer or rider signs in with one factor; staff never skip the second (policy.ts DEVICE_TRUST_ROLES).
 *
 * Changing the mobile or e-mail revokes the account's trusted devices (both factors again everywhere).
 * // DEFAULT – confirm with Sanjay.
 *
 * By role (owner 27-Nov-2026): customers 180 days (customerTrustDays), renewed at every sign-in on the device but
 * never past first trust + 365 days (customerTrustMaxDays); shop owners, dealers, riders and society admins 30 days
 * (trustDays), fixed — also for a customer who became one (checked against trusted_at at the next sign-in); staff are
 * never trusted (policy.ts).
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";

import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import { trustedDevices, users, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";

export const DEVICE_COOKIE = "gk_device";
/** The device token outlives any one trust period; a browser keeps the same id. */
const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function deviceHash(token: string): string {
  return createHash("sha256").update(`gk-device:${token}`).digest("hex");
}

async function readToken(): Promise<string | null> {
  try {
    const value = (await cookies()).get(DEVICE_COOKIE)?.value ?? "";
    return TOKEN_PATTERN.test(value) ? value : null;
  } catch {
    return null; // outside a request
  }
}

/** This browser's device token, created (and set as a cookie) when it has none. Only in a route / server action. */
async function ensureToken(): Promise<string | null> {
  const existing = await readToken();
  if (existing) return existing;
  const token = randomBytes(32).toString("base64url");
  try {
    (await cookies()).set(DEVICE_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: getEnv().NODE_ENV === "production",
      path: "/",
      maxAge: DEVICE_COOKIE_MAX_AGE_S,
    });
  } catch {
    return null; // a page render cannot set cookies: trust is given on the next action instead
  }
  return token;
}

async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    const h = await headers();
    return { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || null, userAgent: h.get("user-agent")?.slice(0, 300) ?? null };
  } catch {
    return { ip: null, userAgent: null };
  }
}

const DAY_MS = 24 * 3_600_000;

async function roleOf(userId: string): Promise<UserRole | null> {
  const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return row?.role ?? null;
}

/**
 * Is this browser trusted for the account right now? At sign-in (`renew`), a customer's trust is moved to now +
 * customerTrustDays, never past trusted_at + customerTrustMaxDays. Any other role is trusted only within trustDays
 * of trusted_at (fixed), so a customer who became a shop owner gets the 30-day rule from the next sign-in.
 */
export async function isDeviceTrusted(userId: string, options: { renew?: boolean } = {}): Promise<boolean> {
  const token = await readToken();
  if (!token) return false;
  const now = new Date();
  const role = await roleOf(userId);
  const rules = await getRule("dualAuth");
  const customer = role === "CUSTOMER";
  const conditions = [
    eq(trustedDevices.userId, userId),
    eq(trustedDevices.deviceHash, deviceHash(token)),
    isNull(trustedDevices.revokedAt),
    gt(trustedDevices.expiresAt, now),
  ];
  if (!customer) conditions.push(gt(trustedDevices.trustedAt, new Date(now.getTime() - rules.trustDays * DAY_MS)));
  const renewTo = new Date(now.getTime() + rules.customerTrustDays * DAY_MS);
  const [row] = await db
    .update(trustedDevices)
    .set({
      lastUsedAt: now,
      ...(customer && options.renew
        ? {
            expiresAt: sql`least(${renewTo.toISOString()}::timestamptz, ${trustedDevices.trustedAt} + make_interval(days => ${rules.customerTrustMaxDays}))`,
          }
        : {}),
    })
    .where(and(...conditions))
    .returning({ id: trustedDevices.id, expiresAt: trustedDevices.expiresAt });
  return Boolean(row);
}

/** Both factors were just completed on this browser for the account: trust it for rule dualAuth.trustDays. */
export async function trustThisDevice(userId: string, reason: string): Promise<boolean> {
  const token = await ensureToken();
  if (!token) return false;
  const rules = await getRule("dualAuth");
  const customer = (await roleOf(userId)) === "CUSTOMER";
  const trustDays = customer ? rules.customerTrustDays : rules.trustDays;
  const { ip, userAgent } = await requestMeta();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + trustDays * DAY_MS);
  const [row] = await db
    .insert(trustedDevices)
    .values({ userId, deviceHash: deviceHash(token), userAgent, ipAddress: ip, trustedAt: now, expiresAt, lastUsedAt: now })
    .onConflictDoUpdate({
      target: [trustedDevices.userId, trustedDevices.deviceHash],
      set: { trustedAt: now, expiresAt, lastUsedAt: now, revokedAt: null, userAgent, ipAddress: ip },
    })
    .returning({ id: trustedDevices.id });
  await recordAudit({
    actorId: userId,
    action: AUDIT_ACTIONS.DUAL_AUTH_DEVICE_TRUSTED,
    entityType: "trusted_device",
    entityId: row?.id ?? null,
    newValue: { reason, trustedUntil: expiresAt.toISOString(), trustDays },
    ipAddress: ip,
    userAgent,
  });
  return true;
}

/** Revokes every trusted device of the account (mobile / e-mail changed, or the person asked). */
export async function revokeTrustedDevices(userId: string, reason: string, actorId: string | null = userId): Promise<number> {
  const rows = await db
    .update(trustedDevices)
    .set({ revokedAt: new Date() })
    .where(and(eq(trustedDevices.userId, userId), isNull(trustedDevices.revokedAt)))
    .returning({ id: trustedDevices.id });
  if (rows.length) {
    await recordAudit({ actorId, action: AUDIT_ACTIONS.DUAL_AUTH_DEVICES_REVOKED, entityType: "user", entityId: userId, newValue: { reason, devices: rows.length } });
  }
  return rows.length;
}
