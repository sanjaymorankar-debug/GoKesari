/**
 * Seller / customer split — the "overlay" layout (docs/db-split-2026-10/CODE_SPLIT_PLAN.md).
 *
 * After the seller tables have been copied into the seller database, this
 * replaces them in the core (customer) database with postgres_fdw foreign
 * tables of the same names. The site keeps one connection (DATABASE_URL,
 * the core); every read and write of a seller table is carried to the
 * seller database, where the data now physically lives.
 *
 *   npx tsx scripts/db-split/overlay.ts --core <url> --seller <url> [--apply]
 *
 * Without --apply it only prints what it would do. It is not reversible in
 * place: the rollback is to restore the core database (Neon branch / restore
 * point) taken before it ran.
 */
import { applyOverlay, buildOverlayPlan, linkSellerToCore } from "@/server/db/split/overlay";
import { connect, describeUrl } from "@/server/db/split/tools";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const coreUrl = arg("--core");
  const sellerUrl = arg("--seller");
  if (!coreUrl || !sellerUrl) {
    console.log("Usage: npx tsx scripts/db-split/overlay.ts --core <url> --seller <url> [--apply]");
    process.exit(2);
  }
  const core = connect(coreUrl, 2);
  try {
    const plan = await buildOverlayPlan(core);
    console.log(`Core ${describeUrl(coreUrl)} → seller ${describeUrl(sellerUrl)}`);
    console.log(`${plan.tables.length} seller tables become foreign tables; ${plan.crossForeignKeys.length} cross-database foreign keys are dropped in the core.`);
    if (!process.argv.includes("--apply")) {
      console.log("Dry run — nothing changed. Re-run with --apply.");
      return;
    }
    const seller = connect(sellerUrl, 2);
    try {
      await applyOverlay(core, sellerUrl, plan, (line) => console.log(line), seller);
      await linkSellerToCore(seller, coreUrl, (line) => console.log(line));
    } finally {
      await seller.end();
    }
    console.log("Overlay applied.");
  } finally {
    await core.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
