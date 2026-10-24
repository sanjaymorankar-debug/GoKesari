/**
 * Database access for "local"-tier cases only: arranging data a person would
 * arrange by hand (a stock level, an expired code) and reading what the case
 * says must be stored (an audit row, a ledger). Never an action under test.
 *
 * Refuses unless the target is a local server and E2E_DATABASE_URL is a
 * local database — the suite never connects to a site's database.
 */
import postgres from "postgres";

import { blocked } from "./record";
import { IS_LOCAL } from "./target";

let client: ReturnType<typeof postgres> | null = null;

export function db() {
  if (!IS_LOCAL) throw new Error("db() is for local runs only");
  const url = process.env.E2E_DATABASE_URL;
  if (!url) blocked("E2E_DATABASE_URL (the local server's database) is not set");
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) throw new Error("E2E_DATABASE_URL must point at a local database");
  client ??= postgres(url, { max: 2, onnotice: () => {} });
  return client;
}

export async function closeDb() {
  await client?.end({ timeout: 5 }).catch(() => {});
  client = null;
}
