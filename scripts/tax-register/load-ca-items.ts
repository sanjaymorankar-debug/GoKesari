/**
 * docs/tax-register: loads questions for the CA from a JSON file kept outside the repository
 * (the owner's trackers folder). New refs are added; refs already present are left untouched.
 *
 * Usage (DATABASE_URL of the site):
 *   npx tsx scripts/tax-register/load-ca-items.ts <items.json> <actor-user-id>
 *
 * The file is an array of { ref, area?, title, question, blocks?, priority?, dueOn? }.
 * The actor is the Accountant or an admin (their user id); every item is audited as theirs.
 */
import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { importCaItems, type CaItemInput } from "@/server/tax-register/ca-items";

async function main() {
  const [file, actorId] = process.argv.slice(2);
  if (!file || !actorId) throw new Error("Usage: npx tsx scripts/tax-register/load-ca-items.ts <items.json> <actor-user-id>");
  const items = JSON.parse(readFileSync(file, "utf8")) as CaItemInput[];
  const [actor] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, actorId));
  if (!actor) throw new Error(`No user ${actorId}.`);
  const result = await importCaItems(items, actor);
  console.log(`Added ${result.added.length}: ${result.added.join(", ") || "—"}`);
  console.log(`Already there (left as they are) ${result.skipped.length}: ${result.skipped.join(", ") || "—"}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
