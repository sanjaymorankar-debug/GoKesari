/**
 * Measures what the MySQL port costs the fuzzy searches in recall.
 *
 * PostgreSQL answered `WHERE col % $1 ORDER BY similarity(col, $1) DESC LIMIT k`
 * from one GIN trigram index: the predicate and the ordering came from the same
 * scan, so the k rows it returned were exactly the k most similar above the
 * threshold. MySQL cannot do that. Its ngram full-text index narrows, and
 * trigramSimilarity() in the application ranks - so the ranking is identical by
 * construction (same definition as similarity()), and the only thing that can
 * differ is whether the index offered a row up to be ranked at all.
 *
 * So this computes the PostgreSQL answer directly - brute-force
 * trigramSimilarity over every row, which is what `%` and `similarity()`
 * compute - and compares it with what the index-plus-ranking pipeline returns
 * at a range of fanouts. No PostgreSQL server is needed to know what PostgreSQL
 * would have said.
 *
 * Run with: npx tsx scripts/pmd/measure-recall.ts "mysql://..."
 */
import { createSql } from "@/server/pmd/mysql/sql";
import { ngramQuery, rankBySimilarity } from "@/server/pmd/mysql/search";
import { trigramSimilarity } from "@/server/pmd/normalize/text";

const BRANDS = ["amul", "lg", "hp", "tata", "maggi", "surf excel", "samsung", "dove", "britannia",
  "parle", "nestle", "dabur", "patanjali", "haldiram", "bisleri", "colgate", "lux", "godrej",
  "whirlpool", "philips", "ge", "3m", "bosch", "mi", "oneplus", "boat", "noise", "sony"];
const ITEMS = ["butter", "milk", "washing machine", "salt", "masala noodles", "matic detergent",
  "galaxy smartphone", "shampoo", "biscuits", "glucose biscuits", "coffee powder", "honey",
  "atta", "namkeen", "mineral water", "toothpaste", "soap bar", "hair oil", "refrigerator",
  "led bulb", "mixer grinder", "air conditioner", "bluetooth earbuds", "smart watch", "television",
  "laserjet printer", "ceiling fan", "pressure cooker", "basmati rice", "mustard oil"];
const VARIANTS = ["", "classic", "premium", "fresh", "pro", "max", "plus", "lite", "gold", "select"];
const PACKS = ["100 g", "250 g", "500 g", "1 kg", "2 kg", "5 kg", "200 ml", "500 ml", "1 l",
  "6 inch", "32 inch", "43 inch", "7 kg", "pack of 2", "pack of 6"];

function catalogue(n: number): string[] {
  const out: string[] = [];
  let seed = 1;
  const pick = <T,>(xs: readonly T[]) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return xs[seed % xs.length]!;
  };
  while (out.length < n) {
    const name = [pick(BRANDS), pick(ITEMS), pick(VARIANTS), pick(PACKS)].filter(Boolean).join(" ");
    out.push(name);
  }
  return out;
}

/** Queries chosen to probe the cases the index could plausibly lose. */
const QUERIES = [
  ["exact phrase", "amul butter"],
  ["two-char brand", "lg"],
  ["two-char brand + item", "hp laserjet"],
  ["typo", "amull buttar"],
  ["transposition", "amul buttre"],
  ["partial word", "detergen"],
  ["middle substring", "aserjet"],
  ["pack size", "500 ml"],
  ["brand only", "britannia"],
  ["three words", "samsung galaxy smartphone"],
  ["unit token", "kg"],
  ["misspelt brand", "brittania"],
] as const;

const THRESHOLD = 0.3;
const K = 20;
const FANOUTS = [10, 20, 50, 100, 200];

async function main() {
  const url = process.argv[2] ?? process.env.PMD_DATABASE_URL;
  if (!url) throw new Error("pass a MySQL URL as the first argument");
  const sql = createSql(url, { max: 3 });
  const names = catalogue(5000);

  await sql`DROP TABLE IF EXISTS recall_probe`;
  // The stopword list must be off while the index is built, or every 2-gram
  // that is an English stopword is dropped from it - see
  // drizzle-pmd/0001_search_indexes.sql. It is a SESSION variable, so this has
  // to be one pinned connection: on a pool the CREATE could land elsewhere.
  const held = await sql.reserve();
  try {
    await held.unsafe("SET SESSION innodb_ft_enable_stopword = OFF");
    await held.unsafe(`CREATE TABLE recall_probe (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      search_text text NOT NULL,
      FULLTEXT KEY ft (search_text) WITH PARSER ngram
    ) ENGINE=InnoDB`);
  } finally {
    held.release();
  }
  for (let i = 0; i < names.length; i += 500) {
    const part = names.slice(i, i + 500);
    await sql`INSERT INTO recall_probe ${sql(part.map((search_text) => ({ search_text })) as never, "search_text" as never)}`;
  }
  console.log(`catalogue: ${names.length} rows, ${new Set(names).size} distinct\n`);

  const header = ["query".padEnd(26), "top/qual", ...FANOUTS.map((f) => `x${f}`.padStart(7))].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));

  const totals = new Map<number, { found: number; wanted: number }>(FANOUTS.map((f) => [f, { found: 0, wanted: 0 }]));

  for (const [label, q] of QUERIES) {
    // What PostgreSQL would have returned: every row over the threshold,
    // most-similar first, capped at k.
    const all = rankBySimilarity(names.map((search_text) => ({ search_text })), q, (r) => r.search_text, THRESHOLD, Number.MAX_SAFE_INTEGER);
    const truth = all.slice(0, K);
    const truthSet = new Set(truth.map((t) => t.search_text));
    // When far more rows clear the threshold than k, the "top k" is decided by
    // ties and is arbitrary in either engine; the figure to read then is
    // whether the pipeline returns k *qualifying* rows, not these exact ones.
    const qualifying = all.length;

    const cells: string[] = [];
    for (const fanout of FANOUTS) {
      const query = ngramQuery(q);
      const candidates = query
        ? await sql<{ search_text: string }[]>`
            SELECT search_text, MATCH(search_text) AGAINST(${query} IN BOOLEAN MODE) AS score
            FROM recall_probe
            WHERE MATCH(search_text) AGAINST(${query} IN BOOLEAN MODE)
            ORDER BY score DESC
            LIMIT ${K * fanout}`
        : [];
      const got = rankBySimilarity(candidates, q, (r) => r.search_text, THRESHOLD, K);
      const hit = got.filter((g) => truthSet.has(g.search_text)).length;
      const t = totals.get(fanout)!;
      t.found += hit;
      t.wanted += truth.length;
      cells.push(truth.length === 0 ? "    n/a" : `${Math.round((hit / truth.length) * 100)}%`.padStart(7));
    }
    console.log([label.padEnd(26), `${truth.length}/${qualifying}`.padStart(8), ...cells].join(" "));
  }

  console.log("-".repeat(header.length));
  console.log(
    ["overall recall".padEnd(26), "".padStart(5),
      ...FANOUTS.map((f) => {
        const t = totals.get(f)!;
        return `${t.wanted ? Math.round((t.found / t.wanted) * 100) : 0}%`.padStart(7);
      })].join(" "),
  );
  console.log("\nRanking is identical to PostgreSQL's by construction; this measures retrieval only.");
  console.log("Where `qual` greatly exceeds `top`, the top-k is chosen among near-ties and is");
  console.log("arbitrary in either engine; what matters there is that k qualifying rows come back.");

  await sql`DROP TABLE recall_probe`;
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
