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
  // numeric as a number: stock counts and cart quantities are numeric(…, 3) since D-95 (0095/0096).
  client ??= postgres(url, {
    max: 2,
    onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) } },
  });
  return client;
}

/**
 * A shop's seller document marked VERIFIED, with `fields` (column → value)
 * set as well. seller_verifications is a seller table: on the split layout
 * it is a foreign table, which takes no ON CONFLICT (…) DO UPDATE
 * (CLAUDE.md), so the row is updated, and inserted only when there is none.
 */
export async function verifySellerDocument(shopId: string, docType: string, fields: Record<string, string | Date | null> = {}) {
  const sql = db();
  const row = { status: "VERIFIED", verified_at: new Date(), ...fields };
  const updated = await sql`update seller_verifications set ${sql({ ...row, updated_at: new Date() })} where shop_id = ${shopId} and doc_type = ${docType} returning shop_id`;
  if (!updated.length) await sql`insert into seller_verifications ${sql({ shop_id: shopId, doc_type: docType, ...row })}`;
}

export async function closeDb() {
  await client?.end({ timeout: 5 }).catch(() => {});
  client = null;
}
