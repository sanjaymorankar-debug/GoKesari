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
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies, headers } from "next/headers";

import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import { trustedDevices } from "@/server/db/schema";
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

/** Is this browser trusted for the account right now? */
export async function isDeviceTrusted(userId: string): Promise<boolean> {
  const token = await readToken();
  if (!token) return false;
  const [row] = await db
    .update(trustedDevices)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(trustedDevices.userId, userId),
        eq(trustedDevices.deviceHash, deviceHash(token)),
        isNull(trustedDevices.revokedAt),
        gt(trustedDevices.expiresAt, new Date()),
      ),
    )
    .returning({ id: trustedDevices.id });
  return Boolean(row);
}

/** Both factors were just completed on this browser for the account: trust it for rule dualAuth.trustDays. */
export async function trustThisDevice(userId: string, reason: string): Promise<boolean> {
  const token = await ensureToken();
  if (!token) return false;
  const { trustDays } = await getRule("dualAuth");
  const { ip, userAgent } = await requestMeta();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + trustDays * 24 * 3_600_000);
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
