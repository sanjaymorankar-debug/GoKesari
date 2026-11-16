/**
 * Feature flags are cached for 15 s per process (Neon report 14-Nov-2026, item 3),
 * like platform_settings: a read inside the window does not touch the table,
 * a change through setFeatureFlag shows on the next read in this process, and
 * the cache expires after 15 s for changes made elsewhere.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { featureFlags } from "@/server/db/schema";
import { clearFeatureFlagCache, getFeatureFlags, isFeatureEnabled, setFeatureFlag } from "@/server/services/feature-flags";
import { createUser, resetDatabase } from "../helpers/fixtures";

const KEY = "dealer_rating_bonus_enabled" as const;
let admin = { id: "", role: "ADMIN" as const };

/** A write by another process: straight to the table, without clearing this process's cache. */
async function writeElsewhere(enabled: boolean) {
  await db.insert(featureFlags).values({ key: KEY, enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
}

beforeEach(async () => {
  await resetDatabase();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
});

afterEach(() => {
  vi.restoreAllMocks();
  clearFeatureFlagCache();
});

describe("feature flag cache", () => {
  it("serves reads from the cache for 15 s, then reads the table again", async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    expect(await isFeatureEnabled(KEY)).toBe(false);

    await writeElsewhere(true);
    now.mockReturnValue(start + 14_000);
    expect(await isFeatureEnabled(KEY)).toBe(false);

    now.mockReturnValue(start + 15_001);
    expect(await isFeatureEnabled(KEY)).toBe(true);
  });

  it("a change through setFeatureFlag shows on the very next read", async () => {
    expect(await isFeatureEnabled(KEY)).toBe(false);
    const res = await setFeatureFlag(KEY, { enabled: true, districtCodes: null }, "cache test", admin);
    expect(res.changed).toBe(true);
    expect(await isFeatureEnabled(KEY)).toBe(true);

    await setFeatureFlag(KEY, { enabled: false, districtCodes: null }, "cache test off", admin);
    expect(await isFeatureEnabled(KEY)).toBe(false);
  });

  it("clearFeatureFlagCache makes the next read go to the table", async () => {
    expect(await isFeatureEnabled(KEY)).toBe(false);
    await writeElsewhere(true);
    expect(await isFeatureEnabled(KEY)).toBe(false);
    clearFeatureFlagCache();
    expect(await isFeatureEnabled(KEY)).toBe(true);
  });

  it("callers get their own copy of the flag map", async () => {
    const first = await getFeatureFlags();
    delete (first as Partial<typeof first>)[KEY];
    expect((await getFeatureFlags())[KEY]).toMatchObject({ key: KEY, enabled: false });
  });

  it("a read that fails is not cached", async () => {
    const select = vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("connection lost");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await isFeatureEnabled(KEY)).toBe(false);
    expect(select).toHaveBeenCalledTimes(1);

    await writeElsewhere(true);
    expect(await isFeatureEnabled(KEY)).toBe(true);
    expect((await db.select().from(featureFlags).where(eq(featureFlags.key, KEY)))[0]?.enabled).toBe(true);
  });
});
