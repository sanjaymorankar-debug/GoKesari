/**
 * Statements of one transaction sent together: one network round trip for the
 * lot instead of one each. postgres-js pipelines them on the transaction's
 * connection and the database runs them one after another, under the same
 * locks and snapshot rules as before — only the waiting overlaps. Use it for
 * pieces that do not need each other's results.
 *
 * Each query builder is started here, in the order given (Promise.all would
 * leave a builder until a later tick, behind the async helpers listed after
 * it), so the database receives the pieces' first statements in that order.
 * A piece's later statements (notify, emitEvent) follow as it reaches them.
 *
 * Unlike Promise.all, it waits for every piece to settle before throwing. A
 * piece still running when the transaction ended would have postgres-js send
 * its next statement on the connection after the rollback, outside the
 * transaction. The error thrown is the one that failed the transaction, not a
 * sibling's "current transaction is aborted" (25P02), so a 40001 still
 * reaches the re-run.
 */
export async function together<T extends readonly unknown[] | []>(
  pieces: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const started = pieces.map((piece) =>
    isThenable(piece) ? new Promise((resolve, reject) => piece.then(resolve, reject)) : Promise.resolve(piece),
  );
  const results = await Promise.allSettled(started);
  const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
  if (failures.length > 0) throw failures.find((e) => !isAbortedTransaction(e)) ?? failures[0];
  return results.map((r) => (r as PromiseFulfilledResult<unknown>).value) as {
    -readonly [K in keyof T]: Awaited<T[K]>;
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === "function";
}

function isAbortedTransaction(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return String(e?.cause?.code ?? e?.code) === "25P02";
}
