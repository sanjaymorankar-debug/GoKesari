/**
 * docs/guest-checkout-2026-11: the signed, expiring link a guest uses to follow an order without
 * signing in (/track/<token>).
 *
 *   token = base64url(JSON {k, id, exp}) "." base64url(HMAC-SHA256(secret, "guest-track:v1:" + payload))
 *
 *   k   "G" an order group (multi-shop purchase) or "O" a single order
 *   id  the group's or order's uuid
 *   exp expiry, epoch seconds
 *
 * The secret is the existing AUTH_SECRET (already required on every site), separated from its other
 * uses by the "guest-track:v1:" prefix — no new environment variable. Rotating AUTH_SECRET ends every
 * link (and every session) at once. Holding a link only lets someone read that order's progress:
 * the page shows no address, e-mail or full phone number.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";

export type TrackingTargetKind = "G" | "O";

export interface TrackingTarget {
  kind: TrackingTargetKind;
  id: string;
}

/** How long an e-mailed tracking link works. Long enough for a slow delivery and a return. */
export const TRACKING_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`guest-track:v1:${payload}`).digest("base64url");
}

function secretOrDefault(secret?: string): string {
  const s = secret ?? getEnv().AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set: tracking links cannot be signed.");
  return s;
}

export function signTrackingToken(
  target: TrackingTarget,
  options: { now?: number; ttlSeconds?: number; secret?: string } = {},
): string {
  if (!UUID.test(target.id) || (target.kind !== "G" && target.kind !== "O")) throw new Error("Bad tracking target.");
  const now = options.now ?? Date.now();
  const exp = Math.floor(now / 1000) + (options.ttlSeconds ?? TRACKING_TOKEN_TTL_SECONDS);
  const payload = Buffer.from(JSON.stringify({ k: target.kind, id: target.id.toLowerCase(), exp })).toString("base64url");
  return `${payload}.${mac(secretOrDefault(options.secret), payload)}`;
}

export type TrackingTokenCheck = { ok: true; target: TrackingTarget; expiresAt: Date } | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" };

/** Checks the signature first (constant time), then the shape, then the expiry. */
export function verifyTrackingToken(token: string, options: { now?: number; secret?: string } = {}): TrackingTokenCheck {
  if (typeof token !== "string" || token.length > 400) return { ok: false, reason: "MALFORMED" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "MALFORMED" };
  const [payload, given] = parts;
  const expected = Buffer.from(mac(secretOrDefault(options.secret), payload));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: "BAD_SIGNATURE" };
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  const b = body as { k?: unknown; id?: unknown; exp?: unknown };
  if ((b.k !== "G" && b.k !== "O") || typeof b.id !== "string" || !UUID.test(b.id) || typeof b.exp !== "number") {
    return { ok: false, reason: "MALFORMED" };
  }
  const now = options.now ?? Date.now();
  if (b.exp * 1000 <= now) return { ok: false, reason: "EXPIRED" };
  return { ok: true, target: { kind: b.k, id: b.id }, expiresAt: new Date(b.exp * 1000) };
}

/** The page path for a target: /track/<token>. */
export function trackingPath(target: TrackingTarget, options: { now?: number; secret?: string } = {}): string {
  return `/track/${signTrackingToken(target, options)}`;
}
