/**
 * Writes tests/fixtures/bulk_upload/PUZZLES.xlsm — the reconstruction of the
 * Amazon PUZZLES template used by the bulk-upload tests
 * (tests/helpers/amazon-template.ts says why it is a reconstruction).
 *   npx tsx scripts/product-import/write-puzzles-fixture.ts
 */
import { writeFileSync } from "node:fs";

import { buildAmazonWorkbook, puzzlesFixtureRows } from "../../tests/helpers/amazon-template";

async function main() {
  const bytes = await buildAmazonWorkbook(puzzlesFixtureRows(), { macros: true });
  writeFileSync("tests/fixtures/bulk_upload/PUZZLES.xlsm", bytes);
  console.log(`tests/fixtures/bulk_upload/PUZZLES.xlsm: ${bytes.length} bytes`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
