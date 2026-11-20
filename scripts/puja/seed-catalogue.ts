/**
 * Re-runs the Puja Samagri master catalogue seed on DATABASE_URL and prints the counts before
 * and after (docs/puja-samagri-2026-11). Safe to run any number of times: nothing is
 * duplicated and nothing an admin edited is overwritten. The catalogue migration already seeds each
 * site; use this to prove idempotency or to repair a database where rows were removed.
 *
 *   DATABASE_URL=… node --import tsx scripts/puja/seed-catalogue.ts
 */
import postgres from "postgres";

import { pujaCounts, runPujaSeed, type SqlExec } from "../../src/server/puja/seed-runner";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL.");
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  const exec: SqlExec = async (text) => (await client.unsafe(text)) as unknown as Record<string, unknown>[];
  try {
    const before = await pujaCounts(exec);
    const after = await runPujaSeed(exec);
    console.log(JSON.stringify({ before, after, addedProducts: after.products - before.products }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
