/**
 * docs/dealer-platform: puts the seeded dealer schemes back to their state after migrations 0177–0179 (the seed
 * versions are not linked to users, so resetDatabase() leaves a test's changes behind):
 *   Free v1 and v2 SUPERSEDED, Free v3 PUBLISHED (owner 25-Nov-2026: 20% one-time, no monthly), Business / Growth
 *   Partner v1 PUBLISHED when listed in `open` (production keeps them SUSPENDED: 0200),
 *   Territory Franchise v1 PUBLISHED; versions a test added are removed (and any scheme a test created).
 * `open` limits which dealership schemes are open to new applicants (the others go back to drafts).
 * `freeVersion: 1` puts Free version 1 back as the one new dealers get (the state before 0179): resetDatabase()
 * uses it so tests written for the existing commission models are not moved onto the scheme calculator.
 */
import { sql } from "drizzle-orm";

import { db } from "@/server/db";

export async function resetSchemes(
  open: readonly ("FREE" | "BUSINESS_PARTNER" | "GROWTH_PARTNER")[] = ["FREE", "BUSINESS_PARTNER", "GROWTH_PARTNER"],
  options: { freeVersion?: 1 | 2 | 3 } = {},
): Promise<void> {
  const freeVersion = options.freeVersion ?? 3;
  const list = sql.join(open.map((c) => sql`${c}`), sql`, `);
  await db.execute(sql`ALTER TABLE dealer_scheme_versions DISABLE TRIGGER dealer_scheme_versions_guard`);
  try {
    await db.execute(sql`DELETE FROM dealer_scheme_versions v USING dealer_schemes s WHERE s.id = v.scheme_id AND (s.code NOT IN ('FREE', 'BUSINESS_PARTNER', 'GROWTH_PARTNER', 'TERRITORY_FRANCHISE') OR (s.code = 'FREE' AND v.version > 3) OR (s.code <> 'FREE' AND v.version > 1))`);
    await db.execute(sql`DELETE FROM dealer_schemes WHERE code NOT IN ('FREE', 'BUSINESS_PARTNER', 'GROWTH_PARTNER', 'TERRITORY_FRANCHISE')`);
    // Unpublish everything first: the "one published version per scheme" index is checked row by row.
    await db.execute(sql`UPDATE dealer_scheme_versions SET status = 'DRAFT'`);
    await db.execute(sql`
      UPDATE dealer_scheme_versions v SET status = CASE
          WHEN s.code = 'FREE' AND v.version = 1 THEN (CASE WHEN ${freeVersion} = 1 THEN 'PUBLISHED' ELSE 'SUPERSEDED' END)
          WHEN s.code = 'FREE' AND v.version = 2 THEN (CASE WHEN ${freeVersion} = 2 AND 'FREE' IN (${list}) THEN 'PUBLISHED' WHEN ${freeVersion} = 3 THEN 'SUPERSEDED' ELSE 'DRAFT' END)
          WHEN s.code = 'FREE' AND v.version = 3 THEN (CASE WHEN ${freeVersion} = 3 AND 'FREE' IN (${list}) THEN 'PUBLISHED' ELSE 'DRAFT' END)
          WHEN s.code = 'TERRITORY_FRANCHISE' THEN 'PUBLISHED'
          WHEN s.code IN (${list}) AND s.code <> 'FREE' THEN 'PUBLISHED'
          ELSE 'DRAFT' END
      FROM dealer_schemes s WHERE s.id = v.scheme_id`);
    await db.execute(sql`UPDATE dealer_schemes SET status = CASE WHEN code IN (${list}) OR code IN ('TERRITORY_FRANCHISE', 'FREE') THEN 'PUBLISHED' ELSE 'DRAFT' END, launch_at = NULL`);
  } finally {
    await db.execute(sql`ALTER TABLE dealer_scheme_versions ENABLE TRIGGER dealer_scheme_versions_guard`);
  }
}
