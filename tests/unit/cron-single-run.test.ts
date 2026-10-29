/**
 * One run of each cron entry point at a time (src/server/cron/single-run.ts).
 * No database.
 */
import { describe, expect, it } from "vitest";

import { runSingle } from "@/server/cron/single-run";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe("runSingle", () => {
  it("skips a call while the previous run of the same entry point is going", async () => {
    const g = gate();
    const first = runSingle("t-overlap", 60_000, async () => {
      await g.opened;
      return "first";
    });
    const second = await runSingle("t-overlap", 60_000, async () => "second");
    expect(second).toMatchObject({ skipped: true, reason: "ALREADY_RUNNING" });
    g.open();
    expect(await first).toBe("first");
    // Once it finished, the next call runs.
    expect(await runSingle("t-overlap", 60_000, async () => "third")).toBe("third");
  });

  it("does not block a different entry point", async () => {
    const g = gate();
    const minute = runSingle("t-minute", 60_000, async () => g.opened);
    expect(await runSingle("t-hourly", 60_000, async () => "hourly")).toBe("hourly");
    g.open();
    await minute;
  });

  it("frees the entry point when a run fails", async () => {
    await expect(runSingle("t-fail", 60_000, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await runSingle("t-fail", 60_000, async () => "ok")).toBe("ok");
  });

  it("runs anyway once the previous run is older than the stale limit, and the late finish keeps the new mark", async () => {
    let clock = 0;
    const now = () => clock;
    const hung = gate();
    const old = runSingle("t-stale", 1_000, async () => hung.opened, now);

    clock = 2_000;
    const fresh = gate();
    const replacement = runSingle("t-stale", 1_000, async () => fresh.opened.then(() => "replacement"), now);

    // The hung run finishing must not clear the replacement's mark.
    hung.open();
    await old;
    clock = 2_500;
    expect(await runSingle("t-stale", 1_000, async () => "third", now)).toMatchObject({ skipped: true });

    fresh.open();
    expect(await replacement).toBe("replacement");
  });
});
