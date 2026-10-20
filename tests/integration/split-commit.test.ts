/**
 * A transaction that writes both databases is applied exactly once
 * (src/server/db/index.ts). On the split layout postgres_fdw commits the
 * seller side before the core commits. Until 20 Oct the core ran at
 * SERIALIZABLE, whose check can fail at COMMIT: the seller writes then stayed
 * committed, the core writes were undone, and the re-run wrote the seller side
 * again (CI, 19 Oct: a legal document rejected without its audit row or notice).
 *
 * Two transactions cross-read and cross-write two core rows in the order that
 * makes that check fail (T1 reads B and writes A, T2 reads A and writes B,
 * T2 commits first) while T1 also inserts a seller row (a brand). The same
 * file runs in both CI jobs.
 */
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { brands, platformSettings } from "@/server/db/schema";

const tag = `split-commit-${process.pid}-${Date.now()}`;
const keyA = `${tag}-a`;
const keyB = `${tag}-b`;

function signal() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

afterAll(async () => {
  await db.delete(brands).where(eq(brands.name, tag));
  await db.delete(platformSettings).where(inArray(platformSettings.key, [keyA, keyB]));
});

describe("a transaction that writes both databases", () => {
  it("writes its seller rows once when a concurrent transaction conflicts with its core rows", async () => {
    await db.insert(platformSettings).values([
      { key: keyA, value: 0 },
      { key: keyB, value: 0 },
    ]);
    const t1Read = signal();
    const t2Read = signal();
    const t1Wrote = signal();
    const t2Committed = signal();

    let t1Runs = 0;
    const t1 = db.transaction(async (tx) => {
      t1Runs += 1;
      const first = t1Runs === 1;
      await tx.select().from(platformSettings).where(eq(platformSettings.key, keyB));
      if (first) {
        t1Read.open();
        await t2Read.opened;
      }
      await tx.insert(brands).values({ name: tag, slug: `${tag}-${t1Runs}` });
      await tx.update(platformSettings).set({ value: 1 }).where(eq(platformSettings.key, keyA));
      if (first) {
        t1Wrote.open();
        await t2Committed.opened;
      }
    });
    const t2 = (async () => {
      await t1Read.opened;
      await db.transaction(async (tx) => {
        await tx.select().from(platformSettings).where(eq(platformSettings.key, keyA));
        t2Read.open();
        await t1Wrote.opened;
        await tx.update(platformSettings).set({ value: 1 }).where(eq(platformSettings.key, keyB));
      });
      t2Committed.open();
    })();
    await Promise.all([t1, t2]);

    expect(await db.select({ slug: brands.slug }).from(brands).where(eq(brands.name, tag))).toHaveLength(1);
    const settings = await db.select().from(platformSettings).where(inArray(platformSettings.key, [keyA, keyB]));
    expect(settings.map((s) => s.value)).toEqual([1, 1]);
  });
});
