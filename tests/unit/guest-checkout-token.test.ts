/** docs/guest-checkout-2026-11: the no-sign-in tracking link — sign, verify, expiry, tampering. */
import { describe, expect, it } from "vitest";

import { signTrackingToken, trackingPath, verifyTrackingToken, TRACKING_TOKEN_TTL_SECONDS } from "@/server/guest-checkout/token";

const SECRET = "unit-test-secret";
const GROUP = "0b9f0c3e-6f5a-4d0e-9c1a-1f2e3d4c5b6a";
const ORDER = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const NOW = 1_800_000_000_000;

describe("tracking token", () => {
  it("round-trips a group and an order target", () => {
    for (const target of [
      { kind: "G" as const, id: GROUP },
      { kind: "O" as const, id: ORDER },
    ]) {
      const token = signTrackingToken(target, { now: NOW, secret: SECRET });
      const check = verifyTrackingToken(token, { now: NOW + 1000, secret: SECRET });
      expect(check).toMatchObject({ ok: true, target });
      if (check.ok) expect(check.expiresAt.getTime()).toBe(Math.floor(NOW / 1000) * 1000 + TRACKING_TOKEN_TTL_SECONDS * 1000);
    }
  });

  it("expires after the TTL", () => {
    const token = signTrackingToken({ kind: "G", id: GROUP }, { now: NOW, secret: SECRET, ttlSeconds: 60 });
    expect(verifyTrackingToken(token, { now: NOW + 59_000, secret: SECRET }).ok).toBe(true);
    expect(verifyTrackingToken(token, { now: NOW + 61_000, secret: SECRET })).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("refuses a token whose payload was changed (another order, a later expiry)", () => {
    const token = signTrackingToken({ kind: "O", id: ORDER }, { now: NOW, secret: SECRET });
    const [, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "G", id: GROUP, exp: Math.floor(NOW / 1000) + 10 ** 9 })).toString("base64url");
    expect(verifyTrackingToken(`${forged}.${mac}`, { now: NOW, secret: SECRET })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("refuses a changed signature and a token signed with another secret", () => {
    const token = signTrackingToken({ kind: "G", id: GROUP }, { now: NOW, secret: SECRET });
    const last = token.at(-1) === "A" ? "B" : "A";
    expect(verifyTrackingToken(token.slice(0, -1) + last, { now: NOW, secret: SECRET }).ok).toBe(false);
    expect(verifyTrackingToken(token, { now: NOW, secret: "other-secret" })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("refuses malformed input", () => {
    for (const bad of ["", "abc", "a.b.c", ".x", "x.", "x".repeat(500)]) {
      expect(verifyTrackingToken(bad, { now: NOW, secret: SECRET }).ok).toBe(false);
    }
  });

  it("will not sign a target that is not a uuid", () => {
    expect(() => signTrackingToken({ kind: "G", id: "not-a-uuid" }, { secret: SECRET })).toThrow();
  });

  it("builds the /track path", () => {
    expect(trackingPath({ kind: "G", id: GROUP }, { now: NOW, secret: SECRET })).toMatch(/^\/track\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});
