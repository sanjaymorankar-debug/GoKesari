/**
 * One run of each cron entry point at a time, in this Node process.
 *
 * Hostinger counts every process and thread on the account against one limit
 * (120). A run that is still going when the scheduler calls again must not start
 * a second copy beside it: the new call answers at once with `skipped`, and the
 * jobs it would have run are picked up by the next call. The crontab line also
 * wraps its curl in `flock -n` (docs/crontab.txt), which stops a pile-up on the
 * host side; this guard covers a run that outlives the curl that started it.
 *
 * The site runs as one `next start` process, so an in-memory mark is enough and
 * needs no table: a restart clears it. Every job is idempotent, so a second
 * process (e.g. two deploys overlapping) running the same entry point is still
 * harmless. A run that has held the mark longer than `staleAfterMs` is taken as
 * hung, and the next call runs anyway so the deadlines keep moving.
 */

const running = new Map<string, number>();

export type SingleRunSkipped = { skipped: true; reason: "ALREADY_RUNNING"; runningSince: string };

export async function runSingle<T>(
  tag: string,
  staleAfterMs: number,
  run: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T | SingleRunSkipped> {
  const started = running.get(tag);
  if (started !== undefined && now() - started < staleAfterMs) {
    console.info(`[cron:${tag}] previous run still going since ${new Date(started).toISOString()} — skipped`);
    return { skipped: true, reason: "ALREADY_RUNNING", runningSince: new Date(started).toISOString() };
  }
  const mark = now();
  running.set(tag, mark);
  try {
    return await run();
  } finally {
    // A stale run finishing late must not clear the mark of the run that replaced it.
    if (running.get(tag) === mark) running.delete(tag);
  }
}
