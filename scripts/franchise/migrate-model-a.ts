/**
 * Franchise brief §13: existing dealers become Model A (TIERED: 20 / 4 / 3) going forward. Their codes keep
 * working, past commission is never recalculated (each shop's plan is frozen at activation), and only shops
 * activated after the move use the TIERED rates.
 *
 * Dry run by default — it lists what would change. With --apply it moves each approved STANDARD dealer to TIERED
 * through the same service an admin uses (audited with the reason). Needs ADMIN_ID (an admin user's id).
 *
 *   ADMIN_ID=<uuid> DATABASE_URL=… node --import tsx scripts/franchise/migrate-model-a.ts            # dry run
 *   ADMIN_ID=<uuid> DATABASE_URL=… node --import tsx scripts/franchise/migrate-model-a.ts --apply    # apply
 *
 * Production: run only after the owner's go-ahead (decision F-04) and a database backup.
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { dealers } from "@/server/db/schema";
import { setDealerCommissionModel, tierRule } from "@/server/dealers/tiered";

async function main() {
  const apply = process.argv.includes("--apply");
  const adminId = process.env.ADMIN_ID;
  if (apply && !adminId) throw new Error("Set ADMIN_ID to an admin user's id.");
  const rule = await tierRule();
  const candidates = await db.select({ id: dealers.id, name: dealers.legalName, model: dealers.commissionModel }).from(dealers).where(and(eq(dealers.status, "APPROVED"), eq(dealers.isInternal, false), eq(dealers.commissionModel, "STANDARD")));
  console.log(`Rule dealerTieredCommission is ${rule.enabled ? "ON" : "OFF"} (direct ${rule.directBp / 100}%, first override ${rule.leadOverrideBp / 100}%, second override ${rule.mainOverrideBp / 100}%, by distance: ${rule.overrideByDistance !== false}).`);
  console.log(`${candidates.length} approved STANDARD dealer(s) would move to Model A (TIERED):`);
  for (const c of candidates) console.log(`  - ${c.name} (${c.id})`);
  if (!apply) {
    console.log("Dry run — nothing changed. Re-run with --apply.");
    return;
  }
  if (!rule.enabled) throw new Error("Switch rule dealerTieredCommission on first (Admin → Settings).");
  let n = 0;
  for (const c of candidates) {
    await setDealerCommissionModel(c.id, "TIERED", "Franchise brief §13 (21-Nov-2026): existing dealers move to Model A, no recalculation of history", { id: adminId!, role: "ADMIN" });
    n++;
  }
  console.log(`Moved ${n} dealer(s) to TIERED.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
