/**
 * Switch a site's database to the seller / customer split, or back
 * (docs/db-split-2026-10/CODE_SPLIT_PLAN.md §5). Run it through the
 * "Database split" workflow; by hand only with the owner's go-ahead.
 *
 *   CORE_DATABASE_URL     the site's database (DATABASE_URL on the host)
 *   SELLER_DATABASE_URL   the seller database (emptied and rebuilt by "apply")
 *
 *   npx tsx scripts/db-split/switch.ts status        read-only: which layout the site's database is on (--expect split|single)
 *   npx tsx scripts/db-split/switch.ts check         read-only: can the site switch now, and what would happen
 *   npx tsx scripts/db-split/switch.ts apply         the switch (copy under a write pause, verify, link, overlay)
 *   npx tsx scripts/db-split/switch.ts check-back    read-only: can the switch be undone without losing anything
 *   npx tsx scripts/db-split/switch.ts back          the switch undone, with every row written since
 *   npx tsx scripts/db-split/switch.ts drop-parked   after the rollback window: free the core's parked copy
 *
 * --allow-remote is required for any host but localhost.
 */
import { connect, describeUrl } from "../../src/server/db/split/tools";
import { checkSwitch, checkSwitchBack, dropParked, layoutStatus, switchBack, switchToSplit } from "../../src/server/db/split/switch";

const args = process.argv.slice(2);
const action = args[0];

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  if (/<|PLACEHOLDER|CHANGE_ME/i.test(value)) throw new Error(`${name} is still a placeholder — set the real connection string.`);
  const host = new URL(value).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && !args.includes("--allow-remote")) {
    throw new Error(`${name} points at ${host}; add --allow-remote to run against a remote server.`);
  }
  return value;
}

async function main() {
  if (!["status", "check", "apply", "check-back", "back", "drop-parked"].includes(action)) {
    console.log("Usage: npx tsx scripts/db-split/switch.ts status|check|apply|check-back|back|drop-parked [--allow-remote] [--expect split|single]");
    process.exit(2);
  }
  const coreUrl = need("CORE_DATABASE_URL");
  const sellerUrl = need("SELLER_DATABASE_URL");
  console.log(`Core:   ${describeUrl(coreUrl)}\nSeller: ${describeUrl(sellerUrl)}\n`);
  const core = connect(coreUrl, 3);
  const seller = connect(sellerUrl, 3);
  const log = (line: string) => console.log(`- ${line}`);
  const remote = { openReader: () => connect(sellerUrl, 1), tableTimeoutMs: 10 * 60_000 };
  try {
    if (action === "status") {
      const status = await layoutStatus(core);
      console.log(`Layout: ${status.layout}${status.parked.length ? ` (parked copy kept for a switch back: ${status.parked.join(", ")})` : ""}.`);
      const expect = args[args.indexOf("--expect") + 1];
      if (args.includes("--expect") && expect !== status.layout) {
        console.log(`Expected ${expect}.`);
        process.exitCode = 1;
      }
    } else if (action === "check" || action === "check-back") {
      const check = action === "check" ? await checkSwitch(core, seller, { core: coreUrl, seller: sellerUrl }) : await checkSwitchBack(core, seller);
      for (const p of check.problems) console.log(`✗ ${p}`);
      for (const n of check.notes) console.log(`• ${n}`);
      console.log(check.ready ? "\nReady." : "\nNot ready.");
      if (!check.ready) process.exitCode = 1;
    } else if (action === "apply") {
      const r = await switchToSplit({ core, seller, coreUrl, sellerUrl, log, openReader: () => connect(coreUrl, 1), tableTimeoutMs: remote.tableTimeoutMs });
      console.log(`\nSwitched: ${r.tables} seller tables, ${r.rows} rows now live in the seller database. Writes waited ${r.writesPausedSeconds} s; ${r.seconds} s in all.`);
      console.log("The site picks the switch up by itself within 30 seconds (DB_SPLIT_MODE=split and SELLER_DATABASE_URL must be set on the host).");
    } else if (action === "back") {
      const r = await switchBack({ core, seller, sellerUrl, log, openReader: remote.openReader });
      console.log(`\nSwitched back: ${r.tables} seller tables, ${r.rows} rows are in the core again. ${r.seconds} s.`);
      if (r.orphanedForeignKeys.length) console.log(`Foreign keys with rows that break them (kept for new rows; fix the rows, then VALIDATE): ${r.orphanedForeignKeys.join(", ")}`);
    } else {
      await dropParked(core, log);
    }
  } finally {
    await core.end({ timeout: 5 });
    await seller.end({ timeout: 5 });
  }
}

// Exit once the step is done. On Neon the test site's switch (19 Oct) committed and printed
// "Switched" in 3½ minutes, then the process stayed up until the run was cancelled 24 minutes
// later: a connection left over from the copy can keep Node alive after every pool has ended.
main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
