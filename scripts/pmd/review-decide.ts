/**
 * Applies review decisions to the possible-duplicate queue, through the same service the admin screen uses
 * (decideCandidate): CONFIRMED_SAME merges the two masters by pointer (the older survives, nothing is deleted),
 * CONFIRMED_DIFFERENT closes the item. DRY RUN unless --apply is given.
 *
 *   PMD_DATABASE_URL=<target> [PMD_ALLOW_REMOTE=1] npx tsx scripts/pmd/review-decide.ts --decisions decisions.json
 *       [--actor-email <operator or admin>] [--label "text"] [--apply]
 *
 * decisions.json: [{ "id": 11, "decision": "CONFIRMED_SAME" | "CONFIRMED_DIFFERENT" | "SAME_FAMILY", "note": "why" }, ...]
 *
 * Decisions run one at a time in the order given. A merge shifts the sources of a retired master onto the survivor, so a
 * later item of the same cluster may already be resolved (or refused); each outcome is reported, and nothing is retried.
 */
import { readFileSync } from "node:fs";

import { decideCandidate, ReviewError, type ReviewDecision } from "@/server/pmd/pipeline/review";
import { arg, connect, describeTarget, flag, pmdDatabaseUrl } from "./lib";

interface Decision {
  id: number;
  decision: ReviewDecision;
  note?: string;
}

const ALLOWED = new Set<ReviewDecision>(["CONFIRMED_SAME", "CONFIRMED_DIFFERENT", "SAME_FAMILY"]);

async function main() {
  console.log(`target   ${describeTarget(pmdDatabaseUrl())}`);
  const file = arg("decisions");
  if (!file) throw new Error("--decisions <file.json> is required.");
  const decisions = JSON.parse(readFileSync(file, "utf8")) as Decision[];
  for (const d of decisions) if (!ALLOWED.has(d.decision)) throw new Error(`Item ${d.id}: unknown decision ${d.decision}.`);
  const apply = flag("apply");
  const sql = connect();

  const pending = await sql<{ candidate_id: number; review_status: string }[]>`
    SELECT candidate_id, review_status FROM pmd.match_candidate WHERE candidate_id = ANY(${decisions.map((d) => d.id)}::bigint[])`;
  const byId = new Map(pending.map((p) => [p.candidate_id, p.review_status]));
  const tally = (k: string) => decisions.filter((d) => d.decision === k).length;
  console.log(`decisions ${decisions.length}: ${tally("CONFIRMED_SAME")} same (merge), ${tally("CONFIRMED_DIFFERENT")} different, ${tally("SAME_FAMILY")} same family`);
  const missing = decisions.filter((d) => !byId.has(Number(d.id)));
  const done = decisions.filter((d) => byId.has(Number(d.id)) && byId.get(Number(d.id)) !== "PENDING");
  if (missing.length) console.log(`  not found: ${missing.map((d) => d.id).join(", ")}`);
  if (done.length) console.log(`  already decided (skipped): ${done.map((d) => d.id).join(", ")}`);

  if (!apply) {
    console.log("\nDRY RUN - nothing written. Re-run with --apply --actor-email <user> to apply.");
    await sql.end();
    return;
  }

  const email = arg("actor-email");
  if (!email) throw new Error("--apply needs --actor-email <an ACTIVE OPERATOR or ADMIN of the target application>.");
  const [actor] = await sql<{ id: string }[]>`
    SELECT id FROM public.users WHERE lower(email) = lower(${email}) AND status = 'ACTIVE' AND deleted_at IS NULL AND role IN ('OPERATOR','ADMIN') LIMIT 1`;
  if (!actor) throw new Error("No ACTIVE OPERATOR/ADMIN with that email exists in the target database.");
  const label = arg("label", "duplicate review (3-judge panel)") ?? "duplicate review";

  const counts = { merged: 0, closed: 0, family: 0, skipped: 0, refused: 0 };
  for (const d of decisions) {
    const id = Number(d.id);
    if (!byId.has(id) || byId.get(id) !== "PENDING") {
      counts.skipped++;
      continue;
    }
    try {
      const r = await decideCandidate(sql, id, d.decision, { userId: actor.id, label }, d.note ?? null);
      if (r.merged) {
        counts.merged++;
        console.log(`  #${id} merged`);
      } else if (d.decision === "CONFIRMED_SAME") {
        counts.closed++;
        console.log(`  #${id} confirmed same (already one product, nothing to merge)`);
      } else if (d.decision === "SAME_FAMILY") {
        counts.family++;
      } else {
        counts.closed++;
        console.log(`  #${id} closed as different`);
      }
    } catch (e) {
      counts.refused++;
      console.log(`  #${id} REFUSED: ${e instanceof ReviewError ? `${e.code} - ${e.message}` : (e as Error).message}`);
    }
  }
  console.log(`\nmerged ${counts.merged}, closed ${counts.closed}, same-family ${counts.family}, skipped ${counts.skipped}, refused ${counts.refused}`);
  const [left] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pmd.match_candidate WHERE review_status = 'PENDING'`;
  console.log(`still pending in the queue: ${left.n}`);
  await sql.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
