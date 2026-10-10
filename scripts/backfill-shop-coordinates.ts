/**
 * Fill missing shop map locations from the shops' addresses
 * (docs/nearby-referral-2026-10, feature 1). The same work as Admin → Shops
 * without location → "Fill all from address".
 *
 *   DATABASE_URL=<target> GOOGLE_MAPS_SERVER_API_KEY=<key> npx tsx scripts/backfill-shop-coordinates.ts          # dry run
 *   DATABASE_URL=<target> GOOGLE_MAPS_SERVER_API_KEY=<key> npx tsx scripts/backfill-shop-coordinates.ts --apply  # write
 *
 * Only shops with no (or an invalid) location are touched; a result in a
 * different PIN code than the shop's is refused. Prints counts and shop
 * names only.
 */
import { backfillShopCoordinates } from "@/server/services/shop-location-backfill";

async function main() {
  const apply = process.argv.includes("--apply");
  const results = await backfillShopCoordinates({ apply, limit: 500 }, { id: null, role: null });
  const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.result]: (acc[r.result] ?? 0) + 1 }), {});
  for (const r of results) console.log(`${r.result.padEnd(14)} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
  console.log(JSON.stringify({ apply, shops: results.length, ...counts }));
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
