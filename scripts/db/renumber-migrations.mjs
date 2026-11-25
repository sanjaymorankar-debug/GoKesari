#!/usr/bin/env node
// Renumbers a branch's own Drizzle migrations so they follow the base branch's
// last one (docs/staging-queue/README.md, "Migration numbers").
//
// Why: tests/unit/migration-journal.test.ts wants the journal contiguous
// (entry i is tagged NNNN_ with NNNN = i). Several PRs into staging often take
// the same next number; whichever lands first keeps it and the others conflict
// on drizzle/meta/_journal.json. This script does the renumbering a session
// would otherwise do by hand. The staging queue runs it too.
//
// Usage, inside a merge of the base that stopped on the journal:
//   git merge origin/staging            # conflict in drizzle/meta/_journal.json
//   node scripts/db/renumber-migrations.mjs origin/staging
//   git commit --no-edit
//
// Options: --branch <ref> (default HEAD: the branch's side of the merge),
//          --dry-run (print the plan, change nothing).
//
// What it changes (and stages with git add):
//   - drizzle/meta/_journal.json = the base's entries + the branch's own
//     entries, renumbered from the base's count, `when` kept increasing;
//   - drizzle/<old tag>.sql → drizzle/<new tag>.sql, and the branch's
//     drizzle/meta/<NNNN>_snapshot.json if it added one;
//   - scripts/rollback-<NNNN>*.sql files the branch added → the new number;
//   - in files the branch changed: every full old tag (0187_foo) and
//     "rollback-0187" becomes the new one;
//   - in files the branch added (its rollback script, design note): also the
//     bare number ("migration 0187"). The base had no such migration when the
//     branch was cut, so there it can only mean the branch's own. In files
//     the branch only modified it is left alone and listed for a check.
// Exit: 0 renumbered or nothing to do, 1 error.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const JOURNAL = "drizzle/meta/_journal.json";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const bi = args.indexOf("--branch");
const branchRef = bi >= 0 ? args[bi + 1] : "HEAD";
const baseRef = args.find((a, i) => !a.startsWith("--") && !(bi >= 0 && i === bi + 1));
if (!baseRef) {
  console.error("usage: renumber-migrations.mjs <base-ref> [--branch <ref>] [--dry-run]");
  process.exit(1);
}

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const journalAt = (ref) => JSON.parse(git("show", `${ref}:${JOURNAL}`));
const pad = (n) => String(n).padStart(4, "0");

const base = journalAt(baseRef);
const branch = journalAt(branchRef);
const baseTags = new Set(base.entries.map((e) => e.tag));
const own = branch.entries.filter((e) => !baseTags.has(e.tag));

// The base must itself be contiguous, or this would build on a broken journal.
for (const [i, e] of base.entries.entries()) {
  if (e.idx !== i || e.tag.slice(0, 4) !== pad(i)) {
    console.error(`base journal is not contiguous at ${e.tag} (idx ${e.idx}); fix the base first`);
    process.exit(1);
  }
}

const entries = base.entries.map((e) => ({ ...e }));
const renames = []; // { from, to } tags
for (const e of own) {
  const idx = entries.length;
  const tag = pad(idx) + e.tag.slice(4);
  const lastWhen = entries[entries.length - 1]?.when ?? 0;
  const when = e.when > lastWhen ? e.when : lastWhen + 100000;
  entries.push({ ...e, idx, when, tag });
  if (tag !== e.tag) renames.push({ from: e.tag, to: tag });
}

const next = JSON.stringify({ ...branch, entries }, null, 2) + "\n";
const current = existsSync(JOURNAL) ? readFileSync(JOURNAL, "utf8") : "";
if (renames.length === 0 && current === next) {
  console.log("migrations already follow the base; nothing to do");
  process.exit(0);
}
for (const r of renames) console.log(`${r.from} → ${r.to}`);
if (own.length === 0) console.log("the branch adds no migrations; journal taken from the base");
if (dryRun) process.exit(0);

// Files the branch itself changed: where references to its own tags live.
const mergeBase = git("merge-base", baseRef, branchRef);
const touched = new Set(git("diff", "--name-only", mergeBase, branchRef).split("\n").filter(Boolean));
const added = new Set(git("diff", "--name-only", "--diff-filter=A", mergeBase, branchRef).split("\n").filter(Boolean));
const baseFiles = new Set(git("ls-tree", "-r", "--name-only", baseRef).split("\n"));

const moves = [];
for (const { from, to } of renames) {
  const n0 = from.slice(0, 4), n1 = to.slice(0, 4);
  moves.push([`drizzle/${from}.sql`, `drizzle/${to}.sql`]);
  const snap = `drizzle/meta/${n0}_snapshot.json`;
  if (touched.has(snap) && !baseFiles.has(snap)) moves.push([snap, `drizzle/meta/${n1}_snapshot.json`]);
  for (const f of touched) {
    if (f.startsWith(`scripts/rollback-${n0}`) && !baseFiles.has(f)) {
      moves.push([f, `scripts/rollback-${n1}${f.slice(`scripts/rollback-${n0}`.length)}`]);
    }
  }
}
for (const [from] of moves) {
  if (!existsSync(from)) { console.error(`missing ${from}`); process.exit(1); }
}
// Through temporary names, so 0187→0188 and 0188→0189 never clash.
moves.forEach(([from], i) => renameSync(from, `${from}.renumber-${i}`));
moves.forEach(([from, to], i) => renameSync(`${from}.renumber-${i}`, to));
const movedTo = new Map(moves);

// One regex for all replacements, so a new tag is never renamed a second time.
const map = new Map();
for (const { from, to } of renames) {
  map.set(from, to);
  map.set(`rollback-${from.slice(0, 4)}`, `rollback-${to.slice(0, 4)}`);
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = map.size
  ? new RegExp([...map.keys()].map(esc).sort((a, b) => b.length - a.length).join("|"), "g")
  : null;
const bare = renames.map((r) => r.from.slice(0, 4));
const bareMap = new Map(renames.map((r) => [r.from.slice(0, 4), r.to.slice(0, 4)]));
const bareRe = bare.length ? new RegExp(`(?<![\\w-])(${bare.join("|")})(?!\\w)`, "g") : null;
const leftovers = new Set();
const edited = [];
for (const f0 of touched) {
  const f = movedTo.get(f0) ?? f0;
  if (f === JOURNAL || !existsSync(f) || !/\.(sql|ts|tsx|js|mjs|md|json|ya?ml|sh|txt)$/.test(f)) continue;
  const text = readFileSync(f, "utf8");
  let changed = re ? text.replace(re, (m) => map.get(m)) : text;
  if (added.has(f0) && bareRe) changed = changed.replace(bareRe, (m) => bareMap.get(m));
  if (changed !== text) { writeFileSync(f, changed); edited.push(f); }
  for (const n of bare) if (new RegExp(`\\b${n}\\b`).test(changed)) leftovers.add(`${f} (${n})`);
}
writeFileSync(JOURNAL, next);

git("add", "-A", "--", JOURNAL, ...moves.flat(), ...edited);
console.log(`journal: ${base.entries.length} base + ${own.length} own entries`);
if (edited.length) console.log(`references updated in: ${edited.join(", ")}`);
if (leftovers.size) console.log(`old numbers still mentioned (prose; check by hand): ${[...leftovers].join(", ")}`);
