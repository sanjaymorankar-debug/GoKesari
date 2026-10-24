/**
 * Ending a session on the server, and what else Sign out does.
 *
 * Sessions are stateless Auth.js JWTs (auth.ts). Sign out used to remove the
 * cookie from that browser only, so a copy taken before signing out kept
 * working for the rest of its 30 days (QA TC-AUTH-034). Now:
 *
 *  - every session carries an id, `sid`, set at sign-in;
 *  - Sign out lists that id in revoked_sessions, kept until every copy of the
 *    token has expired (the auth-housekeeping job then deletes it);
 *  - the jwt callback refuses a listed id on every request — pages, APIs,
 *    server actions and /api/auth/session — reading it in the same query as
 *    the account row the session already loads.
 *
 * Per session, not per person: signing out on one phone leaves the person's
 * other devices signed in (TC-AUTH-036). A token issued before session ids
 * existed has no `sid`; its Auth.js `jti`, fixed for a cookie until Auth.js
 * re-issues it, stands in and is copied into `sid` so a re-issue keeps it.
 *
 * Signing out also clears the chosen delivery location (TC-AUTH-038), sets an
 * online rider offline (TC-AUTH-040) and records auth.signed_out (TC-AUTH-045).
 */
import { randomUUID } from "node:crypto";

import { lt, sql, eq } from "drizzle-orm";
import { cookies } from "next/headers";

import { LOCATION_COOKIE } from "@/lib/location";
import { db } from "@/server/db";
import { revokedSessions, users, type User } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { goOfflineOnSignOut } from "@/server/services/delivery-partners";

/** How long a session lasts after it was last issued (auth.ts session.maxAge). */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * A revocation outlives every copy of the token: one re-issued just before
 * Sign out is good for SESSION_MAX_AGE from then. A day's slack covers clocks.
 */
const REVOCATION_KEEP_MS = (SESSION_MAX_AGE_SECONDS + 24 * 60 * 60) * 1000;

/** The claims this module reads from a decoded session token. */
export interface SessionClaims {
  sub?: string | null;
  sid?: unknown;
  jti?: unknown;
}

/** The session's id: its `sid`, else (a token from before session ids) its `jti`; null when it has neither. */
export function sessionIdOf(token: SessionClaims): string | null {
  if (typeof token.sid === "string" && token.sid) return token.sid;
  if (typeof token.jti === "string" && token.jti) return token.jti;
  return null;
}

/** At sign-in: the new session's user and a fresh session id. */
export function startSession<T extends SessionClaims>(token: T, userId: string): T {
  token.sub = userId;
  token.sid = randomUUID();
  return token;
}

/**
 * On every request, before the session is used: null when the session has
 * been signed out (TC-AUTH-034) or carries no id at all — the caller then
 * drops it. Otherwise the account row (undefined when there is none), read in
 * the same query as the revocation check.
 */
export async function readSession(token: SessionClaims): Promise<{ user: User | undefined } | null> {
  const sessionId = sessionIdOf(token);
  // Every token Auth.js issues has a jti; one with neither id was not made by it.
  if (!sessionId) return null;
  // Kept in the token, so a re-issue (which gives it a new jti) keeps the same session id.
  token.sid = sessionId;
  if (!token.sub) return { user: undefined };
  const [row] = await db
    .select({
      user: users,
      revoked: sql<boolean>`exists (select 1 from ${revokedSessions} where ${revokedSessions.sessionId} = ${sessionId})`,
    })
    .from(users)
    .where(eq(users.id, token.sub));
  if (!row) return { user: undefined };
  if (row.revoked) return null;
  return { user: row.user };
}

/** Lists the session as signed out. False when it already was (a second click on Sign out). */
export async function revokeSession(userId: string, sessionId: string, now: Date = new Date()): Promise<boolean> {
  const inserted = await db
    .insert(revokedSessions)
    .values({ sessionId, userId, revokedAt: now, expiresAt: new Date(now.getTime() + REVOCATION_KEEP_MS) })
    .onConflictDoNothing()
    .returning({ sessionId: revokedSessions.sessionId });
  return inserted.length > 0;
}

/** auth-housekeeping: forgets revocations whose tokens have all expired. */
export async function purgeExpiredSessionRevocations(now: Date = new Date()): Promise<{ deleted: number }> {
  const deleted = await db
    .delete(revokedSessions)
    .where(lt(revokedSessions.expiresAt, now))
    .returning({ sessionId: revokedSessions.sessionId });
  return { deleted: deleted.length };
}

/**
 * Everything Sign out does on the server, for every way of signing out (the
 * header menus, /profile, /api/auth/signout): Auth.js calls it with the
 * decoded token just before it clears the cookie. Each step stands alone, so
 * one failing does not stop the others or the sign-out.
 */
export async function endSession(
  token: SessionClaims | null,
  request: { ip?: string | null; userAgent?: string | null } = {},
): Promise<void> {
  // TC-AUTH-038: the next person on this phone does not inherit the chosen delivery location.
  try {
    (await cookies()).delete(LOCATION_COOKIE);
  } catch (error) {
    console.error("[auth] could not clear the location cookie at sign-out", error);
  }

  const userId = typeof token?.sub === "string" ? token.sub : null;
  const sessionId = token ? sessionIdOf(token) : null;
  if (!userId || !sessionId) return;

  let first = true;
  try {
    first = await revokeSession(userId, sessionId);
  } catch (error) {
    console.error("[auth] could not revoke the session at sign-out", error);
  }
  // Signed out already (a double click): recorded and done the first time.
  if (!first) return;

  // TC-AUTH-045: written like auth.otp_verified at sign-in.
  await recordAudit({
    actorId: userId,
    action: AUDIT_ACTIONS.SIGNED_OUT,
    entityType: "user",
    entityId: userId,
    ipAddress: request.ip ?? null,
    userAgent: request.userAgent ?? null,
  });

  // TC-AUTH-040: a rider who signs out is not offered the next job.
  try {
    await goOfflineOnSignOut(userId);
  } catch (error) {
    console.error("[auth] could not set the rider offline at sign-out", error);
  }
}
