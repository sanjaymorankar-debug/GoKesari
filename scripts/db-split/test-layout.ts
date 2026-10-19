/**
 * Builds the split ("overlay") layout for TESTS: a migrated core database and
 * an empty seller database on the same server become the two-database layout
 * of docs/db-split-2026-10/CODE_SPLIT_PLAN.md. Used by CI's split-mode job and
 * locally; never point it at a site's database.
 *
 *   npx tsx scripts/db-split/test-layout.ts --core <url> --seller <url>
 *
 * Then run the suite with TEST_DATABASE_URL=<core>, DB_SPLIT_MODE=split and
 * SELLER_DATABASE_URL=<seller>.
 */
import { applyOverlay, buildOverlayPlan, linkSellerToCore } from "@/server/db/split/overlay";
import { connect, describeUrl, prepareTarget } from "@/server/db/split/tools";

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  if (!v) {
    console.log("Usage: npx tsx scripts/db-split/test-layout.ts --core <url> --seller <url>");
    process.exit(2);
  }
  return v;
}

async function main() {
  const coreUrl = arg("--core");
  const sellerUrl = arg("--seller");
  for (const url of [coreUrl, sellerUrl]) {
    const host = new URL(url).hostname;
    if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing ${describeUrl(url)}: the test layout is built on a local server only.`);
  }
  const core = connect(coreUrl, 2);
  const seller = connect(sellerUrl, 2);
  const log = (line: string) => console.log(line);
  try {
    const prepared = await prepareTarget(seller, "seller", { replace: true });
    log(`seller: ${prepared.keptTables.length} tables`);
    const plan = await buildOverlayPlan(core);
    await applyOverlay(core, sellerUrl, plan, log, seller);
    await linkSellerToCore(seller, coreUrl, log);
    log(`Split test layout ready: core ${describeUrl(coreUrl)}, seller ${describeUrl(sellerUrl)}.`);
  } finally {
    await core.end();
    await seller.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
