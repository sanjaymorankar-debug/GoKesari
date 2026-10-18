/**
 * Batch 2026-10 integration (found by the staging run): test.gokesari.com runs
 * a production build, so "is this production?" must be decided by the site's
 * host (AUTH_URL), as bank-account verification and push already do — not by
 * NODE_ENV. Sandboxes, mocks and simulator secrets work on the test site and
 * never on gokesari.com; a production build without AUTH_URL counts as
 * gokesari.com (fail safe).
 */
import { describe, expect, it } from "vitest";

import { derivedTestSecret, getEnv, isProductionSite, type ServerEnv } from "@/lib/env";
import { pickupQrSecret } from "@/server/services/pickup-qr";

const base = getEnv();
const site = (nodeEnv: string, authUrl: string | undefined, extra: Partial<ServerEnv> = {}) =>
  ({ ...base, NODE_ENV: nodeEnv, AUTH_URL: authUrl, PICKUP_QR_SECRET: undefined, ...extra }) as ServerEnv;

describe("which site is production (host-based)", () => {
  it("TC-B26-I-001 gokesari.com and www.gokesari.com are production; test.gokesari.com is not, though it is a production build", () => {
    expect(isProductionSite(site("production", "https://gokesari.com"))).toBe(true);
    expect(isProductionSite(site("production", "https://www.gokesari.com"))).toBe(true);
    expect(isProductionSite(site("production", "https://test.gokesari.com"))).toBe(false);
  });

  it("TC-B26-I-002 fails safe: a production build without a usable AUTH_URL is treated as gokesari.com", () => {
    expect(isProductionSite(site("production", undefined))).toBe(true);
  });

  it("TC-B26-I-003 development and tests are never the production site", () => {
    expect(isProductionSite(site("development", "https://gokesari.com"))).toBe(false);
    expect(isProductionSite(site("test", undefined))).toBe(false);
  });

  it("TC-B26-I-004 the pickup QR key: required on gokesari.com, derived per deployment on the test site", () => {
    expect(pickupQrSecret(site("production", "https://gokesari.com"))).toBeNull();
    const staging = site("production", "https://test.gokesari.com");
    expect(pickupQrSecret(staging)).toBe(derivedTestSecret("pickup-qr", staging));
    expect(pickupQrSecret(staging)).not.toBe(staging.AUTH_SECRET);
    expect(pickupQrSecret(site("production", "https://gokesari.com", { PICKUP_QR_SECRET: "x".repeat(32) }))).toBe("x".repeat(32));
  });

  it("TC-B26-I-005 derived secrets differ by purpose and by AUTH_SECRET", () => {
    const a = site("production", "https://test.gokesari.com", { AUTH_SECRET: "one" });
    const b = site("production", "https://test.gokesari.com", { AUTH_SECRET: "two" });
    expect(derivedTestSecret("pickup-qr", a)).not.toBe(derivedTestSecret("sandbox-payment-webhook", a));
    expect(derivedTestSecret("pickup-qr", a)).not.toBe(derivedTestSecret("pickup-qr", b));
  });
});
