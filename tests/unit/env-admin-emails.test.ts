/**
 * SEC-03 (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): admin bootstrap
 * emails are now entirely environment-driven, with no hard-coded fallback.
 * A fresh, isolated file on purpose — env.ts caches its parsed config in a
 * module-level variable, so this needs its own module instance rather than
 * sharing one with any other test file that has already called getEnv().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["BOOTSTRAP_ADMIN_EMAILS", "PERMANENT_ADMIN_EMAILS"] as const;
const originalValues: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalValues[key] = process.env[key];

// env.ts caches its parsed config in a module-level variable on first call —
// reset the module registry before each test so a fresh import re-reads
// whatever process.env this test just set, instead of reusing a previous
// test's cached result within this same file.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalValues[key] === undefined) delete process.env[key];
    else process.env[key] = originalValues[key];
  }
});

describe("bootstrap admin emails (SEC-03)", () => {
  it("returns nothing when neither env var is set", async () => {
    delete process.env.BOOTSTRAP_ADMIN_EMAILS;
    delete process.env.PERMANENT_ADMIN_EMAILS;
    const { bootstrapAdminEmails, permanentBootstrapAdminEmails } = await import("@/lib/env");
    expect(bootstrapAdminEmails()).toEqual([]);
    expect(permanentBootstrapAdminEmails()).toEqual([]);
  });

  it("parses BOOTSTRAP_ADMIN_EMAILS: comma-separated, trimmed, lower-cased", async () => {
    process.env.BOOTSTRAP_ADMIN_EMAILS = " Owner@Example.com , ops@example.com ";
    delete process.env.PERMANENT_ADMIN_EMAILS;
    const { bootstrapAdminEmails } = await import("@/lib/env");
    expect(bootstrapAdminEmails()).toEqual(["owner@example.com", "ops@example.com"]);
  });

  it("PERMANENT_ADMIN_EMAILS is a subset that also self-heals, and appears in bootstrapAdminEmails too", async () => {
    process.env.PERMANENT_ADMIN_EMAILS = "owner@example.com";
    process.env.BOOTSTRAP_ADMIN_EMAILS = "ops@example.com";
    const { bootstrapAdminEmails, permanentBootstrapAdminEmails } = await import("@/lib/env");
    expect(permanentBootstrapAdminEmails()).toEqual(["owner@example.com"]);
    expect(bootstrapAdminEmails().sort()).toEqual(["ops@example.com", "owner@example.com"]);
  });

  it("de-duplicates an email listed in both variables", async () => {
    process.env.PERMANENT_ADMIN_EMAILS = "owner@example.com";
    process.env.BOOTSTRAP_ADMIN_EMAILS = "owner@example.com";
    const { bootstrapAdminEmails } = await import("@/lib/env");
    expect(bootstrapAdminEmails()).toEqual(["owner@example.com"]);
  });
});
