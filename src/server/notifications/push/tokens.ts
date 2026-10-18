/**
 * F13.1.2: the app's push tokens. Registered by the website after sign-in
 * (POST /api/push-tokens, token from the app bridge), one owner per token.
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import { pushTokens, type PushToken } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";
import { isExpoPushToken } from "./types";

export interface RegisterPushTokenInput {
  token: string;
  platform: "android" | "ios";
  appVariant?: "production" | "preview";
  deviceId?: string | null;
  deviceName?: string | null;
}

/** Saves (or moves to this user, or refreshes) a device token. Idempotent. */
export async function registerPushToken(userId: string, input: RegisterPushTokenInput): Promise<PushToken> {
  if (!isExpoPushToken(input.token)) throw validationFailed("That is not an Expo push token.");
  const now = new Date();
  const values = {
    userId,
    token: input.token,
    platform: input.platform,
    appVariant: input.appVariant ?? "production",
    deviceId: input.deviceId?.slice(0, 200) ?? null,
    deviceName: input.deviceName?.slice(0, 200) ?? null,
    active: true,
    lastSeenAt: now,
    deactivatedAt: null,
    deactivatedReason: null,
    updatedAt: now,
  };
  const [row] = await db
    .insert(pushTokens)
    .values(values)
    .onConflictDoUpdate({ target: pushTokens.token, set: values })
    .returning();

  // The same phone with a new token (reinstall, token rotation): the old one is retired.
  if (row.deviceId) {
    await db
      .update(pushTokens)
      .set({ active: false, deactivatedAt: now, deactivatedReason: "REPLACED", updatedAt: now })
      .where(
        and(eq(pushTokens.userId, userId), eq(pushTokens.deviceId, row.deviceId), ne(pushTokens.id, row.id), eq(pushTokens.active, true)),
      );
  }

  // At most maxDevicesPerUser active devices: the least recently seen go first.
  const { maxDevicesPerUser } = await getRule("push");
  const active = await db
    .select({ id: pushTokens.id })
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.active, true)))
    .orderBy(desc(pushTokens.lastSeenAt), desc(pushTokens.createdAt));
  const surplus = active.slice(maxDevicesPerUser).map((r) => r.id);
  if (surplus.length > 0) {
    await db
      .update(pushTokens)
      .set({ active: false, deactivatedAt: now, deactivatedReason: "TOO_MANY_DEVICES", updatedAt: now })
      .where(inArray(pushTokens.id, surplus));
  }
  return row;
}

/** The app signed out or switched notifications off: stop sending to this token (only the owner can). */
export async function unregisterPushToken(userId: string, token: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(pushTokens)
    .set({ active: false, deactivatedAt: now, deactivatedReason: "UNREGISTERED", updatedAt: now })
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, token)))
    .returning({ id: pushTokens.id });
  return rows.length > 0;
}

export async function activePushTokens(userId: string, client: DbClient = db): Promise<PushToken[]> {
  return client
    .select()
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.active, true)))
    .orderBy(desc(pushTokens.lastSeenAt));
}

export async function hasActivePushToken(userId: string, client: DbClient = db): Promise<boolean> {
  const [row] = await client
    .select({ id: pushTokens.id })
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.active, true)))
    .limit(1);
  return Boolean(row);
}

/** Expo said the app is gone from that phone (or notifications were switched off there). */
export async function deactivatePushTokens(tokenIds: string[], reason: string): Promise<void> {
  if (tokenIds.length === 0) return;
  const now = new Date();
  const rows = await db
    .update(pushTokens)
    .set({ active: false, deactivatedAt: now, deactivatedReason: reason.slice(0, 80), updatedAt: now })
    .where(and(inArray(pushTokens.id, tokenIds), eq(pushTokens.active, true)))
    .returning({ id: pushTokens.id, userId: pushTokens.userId });
  for (const row of rows) {
    await recordAudit({
      action: AUDIT_ACTIONS.PUSH_TOKEN_DEACTIVATED,
      entityType: "push_token",
      entityId: row.id,
      newValue: { userId: row.userId, reason },
    });
  }
}

/** Active devices per platform, for the admin view. */
export async function pushTokenStats(): Promise<{ android: number; ios: number }> {
  const rows = await db
    .select({ platform: pushTokens.platform, n: sql<number>`count(*)::int` })
    .from(pushTokens)
    .where(eq(pushTokens.active, true))
    .groupBy(pushTokens.platform);
  const by = Object.fromEntries(rows.map((r) => [r.platform, r.n]));
  return { android: by.android ?? 0, ios: by.ios ?? 0 };
}
