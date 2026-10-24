/**
 * The session check on every request (src/server/auth-sessions.ts readSession)
 * when the revocation list cannot be read — a database the 0088 migration has
 * not reached, or one whose role cannot read it. Every session used to be
 * dropped (no one could stay signed in on the test site after the deploy);
 * now the account is read as before the list existed.
 */
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { readSession, revokeSession } from "@/server/auth-sessions";
import { createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(resetDatabase);
afterEach(async () => {
  await db.execute(sql`alter table if exists revoked_sessions_hidden rename to revoked_sessions`);
  vi.restoreAllMocks();
});

describe("readSession", () => {
  it("refuses a revoked session and accepts a live one", async () => {
    const user = await createUser();
    expect((await readSession({ sub: user.id, sid: "live-1" }))?.user?.id).toBe(user.id);
    await revokeSession(user.id, "gone-1");
    expect(await readSession({ sub: user.id, sid: "gone-1" })).toBeNull();
  });

  it("without a readable revocation list, still reads the account (and logs the failure)", async () => {
    const user = await createUser();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await db.execute(sql`alter table revoked_sessions rename to revoked_sessions_hidden`);
    const read = await readSession({ sub: user.id, sid: "any-session" });
    expect(read?.user?.id).toBe(user.id);
    expect(logged.mock.calls.flat().join(" ")).toMatch(/revoked_sessions check failed/);
  });
});
