/**
 * Re-running a transaction on the seller / customer split
 * (src/server/db/index.ts): db.transaction runs a transaction that ends in a
 * serialization failure again (split layout only); transactionOnce — for work
 * that calls an outside service before it commits — never does. The same file
 * runs in both CI jobs and checks the behaviour of the layout it is on.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, transactionOnce } from "@/server/db";

const split = process.env.DB_SPLIT_MODE === "split";
const serializationFailure = () => Object.assign(new Error("could not serialize access due to concurrent update"), { code: "40001" });

async function isolation(client: Pick<typeof db, "execute">): Promise<string> {
  const rows = (await client.execute(sql`select current_setting('transaction_isolation') as level`)) as unknown as { level: string }[];
  return rows[0].level;
}

describe("re-running a transaction after a serialization failure", () => {
  it(`db.transaction ${split ? "runs it again (split layout, at READ COMMITTED)" : "runs it once (one database)"}`, async () => {
    let runs = 0;
    const attempt = db.transaction(async (tx) => {
      runs += 1;
      const level = await isolation(tx);
      if (runs === 1) throw serializationFailure();
      return level;
    });
    if (split) {
      await expect(attempt).resolves.toBe("read committed");
      expect(runs).toBe(2);
    } else {
      await expect(attempt).rejects.toMatchObject({ code: "40001" });
      expect(runs).toBe(1);
    }
  });

  it("transactionOnce never runs it again, and runs at READ COMMITTED", async () => {
    let runs = 0;
    await expect(
      transactionOnce(async () => {
        runs += 1;
        throw serializationFailure();
      }),
    ).rejects.toMatchObject({ code: "40001" });
    expect(runs).toBe(1);
    await expect(transactionOnce((tx) => isolation(tx))).resolves.toBe("read committed");
  });
});
