/**
 * Candidate retrieval and ranking for the searches PostgreSQL served with
 * pg_trgm and tsvector.
 *
 * The division of labour is the point. PostgreSQL did retrieval *and* ranking
 * in SQL - `WHERE search_text % $1 ORDER BY similarity(search_text, $1) DESC` -
 * because a GIN trigram index can answer both. MySQL's full-text index can only
 * narrow, and its relevance score is not similarity. So:
 *
 *   MySQL     retrieves a generous candidate set through the ngram index
 *   TypeScript ranks it with trigramSimilarity(), the same definition
 *             PostgreSQL's similarity() uses, and applies the same threshold
 *
 * Ordering and scores therefore come out identical to the PostgreSQL ones for
 * every similarity-ranked query. What changes is *recall*: which rows the index
 * offers up for ranking. That is measured rather than assumed - see
 * scripts/pmd/measure-recall.ts.
 *
 * `%` deserves a specific warning, because it is the reason none of this could
 * be left alone: in PostgreSQL `a % b` is "similar enough"; in MySQL it is
 * modulo. It parses, it runs, and on two strings it answers 0 - so every
 * predicate using it would have quietly matched nothing.
 */
import { trigramSimilarity } from "../normalize/text";

/** Characters MySQL's boolean mode reads as operators. */
const OPERATORS = /[+\-><()~*"@]/g;

function terms(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(OPERATORS, "").trim())
    .filter((t) => t.length > 0);
}

/**
 * A boolean query for **keyword** search: every term required.
 *
 * This is what `to_tsquery('simple', 'a & b:*')` meant - all terms present,
 * the last one as a prefix. Under the ngram parser a quoted term is matched as
 * a contiguous ngram sequence, which is to say as a substring, so `"deterg"`
 * finds "detergent" and the trailing-prefix behaviour comes for free.
 */
export function booleanQuery(text: string): string {
  const parts = terms(text);
  if (parts.length === 0) return "";
  return parts.map((t) => `+"${t}"`).join(" ");
}

/**
 * A query for **fuzzy candidate** retrieval: the ngrams of the input, OR'd.
 *
 * This is the one thing about the ngram index that has to be got right, and
 * measuring it is what showed the obvious form to be wrong. Asking for the
 * terms themselves - `+"amull" +"buttar"` - makes the parser look for those
 * strings as substrings, and a misspelling is not a substring of the correct
 * spelling, so the typo queries that fuzzy search exists for returned nothing
 * at all: 0% recall on "amull buttar" and "brittania".
 *
 * Decomposing into ngrams and OR-ing them is how an ngram index is meant to be
 * asked a fuzzy question. "buttar" shares bu, ut and tt with "butter", so the
 * row is retrieved, and then trigramSimilarity decides - which is exactly the
 * division of labour described at the top of this file. Recall measured by
 * scripts/pmd/measure-recall.ts went from 47% to the figure recorded in
 * docs/PMD_MYSQL_PORT.md.
 *
 * `ngram_token_size` is the server's (2 by default) and has to match, or the
 * tokens asked for are not the tokens indexed.
 */
export function ngramQuery(text: string, tokenSize = 2): string {
  const grams = new Set<string>();
  for (const term of terms(text)) {
    if (term.length < tokenSize) {
      // Shorter than one ngram: nothing in the index can represent it.
      continue;
    }
    for (let i = 0; i + tokenSize <= term.length; i += 1) grams.add(term.slice(i, i + tokenSize));
  }
  // Quoted so each is matched as an ngram rather than parsed again, and OR'd
  // (no `+`) so sharing some is enough to be a candidate.
  return [...grams].map((g) => `"${g}"`).join(" ");
}

/**
 * Ranks candidates by trigram similarity to `query`, keeps those at or above
 * `threshold`, and returns the best `limit`.
 *
 * This is what `ORDER BY similarity(col, $1) DESC` and the
 * `pg_trgm.similarity_threshold` did, moved up a layer. The `rank` it writes
 * onto each row is on the same 0-1 scale `similarity()` produced, so the
 * per-strategy base scores the callers add keep their meaning.
 */
export function rankBySimilarity<T>(
  rows: readonly T[],
  query: string,
  text: (row: T) => string,
  threshold: number,
  limit: number,
): (T & { rank: number })[] {
  return rows
    .map((row) => ({ ...row, rank: trigramSimilarity(text(row), query) }))
    .filter((row) => row.rank >= threshold)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
}

/**
 * Rescales MySQL's MATCH relevance onto 0-1, dividing by the largest in the set.
 *
 * `ts_rank` returned 0-1 and the callers add it to a per-strategy base - 100 for
 * an identifier hit, 50 for a keyword hit, 0 for a fuzzy one - so the base
 * decides the strategy order and the rank only breaks ties within a strategy.
 * MySQL's relevance is unbounded (1.337 on a nine-row table), so used raw it
 * would eventually push a keyword hit past the identifier base and let a
 * name match outrank an exact barcode match. Rescaling keeps that ordering
 * intact; within the strategy the order is unchanged, since dividing by a
 * positive constant is monotonic.
 */
export function normaliseRelevance<T extends { rank?: number | null }>(rows: readonly T[]): T[] {
  const top = Math.max(...rows.map((r) => r.rank ?? 0), 0);
  if (top <= 0) return [...rows];
  return rows.map((r) => ({ ...r, rank: (r.rank ?? 0) / top }));
}
