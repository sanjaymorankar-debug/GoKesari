/**
 * together() (src/server/db/together.ts): statements of one transaction sent
 * in one round trip. It starts query builders in the order given, waits for
 * every piece before throwing (a piece still running after the rollback would
 * send its next statement outside the transaction), and throws the error that
 * failed the transaction rather than a sibling's 25P02.
 */
import { describe, expect, it } from "vitest";

import { together } from "@/server/db/together";

/** A lazy thenable like a Drizzle query builder: nothing runs until then() is called. */
function builder<T>(log: string[], name: string, value: T, error?: unknown): PromiseLike<T> {
  return {
    then(onFulfilled, onRejected) {
      log.push(name);
      const p = error === undefined ? Promise.resolve(value) : Promise.reject(error);
      return p.then(onFulfilled, onRejected);
    },
  };
}

const aborted = Object.assign(new Error("current transaction is aborted"), { cause: { code: "25P02" } });

describe("together", () => {
  it("returns every result in order", async () => {
    const log: string[] = [];
    const [a, b, c] = await together([builder(log, "a", 1), Promise.resolve("two"), builder(log, "c", [3])]);
    expect([a, b, c]).toEqual([1, "two", [3]]);
  });

  it("starts query builders in the order given, before an async helper's first statement", async () => {
    const log: string[] = [];
    const helper = async () => {
      await builder(log, "helper", null);
    };
    await together([builder(log, "update", null), builder(log, "insert", null), helper()]);
    expect(log).toEqual(["update", "insert", "helper"]);
  });

  it("waits for every piece to settle before throwing", async () => {
    const log: string[] = [];
    let finished = false;
    const slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
    };
    await expect(together([builder(log, "fails", null, new Error("boom")), slow()])).rejects.toThrow("boom");
    expect(finished).toBe(true);
  });

  it("throws the failure that aborted the transaction, not a sibling's 25P02", async () => {
    const log: string[] = [];
    const serialization = Object.assign(new Error("could not serialize access"), { code: "40001" });
    await expect(
      together([builder(log, "first", null, aborted), builder(log, "cause", null, serialization)]),
    ).rejects.toBe(serialization);
  });

  it("throws the 25P02 when that is all there is", async () => {
    const log: string[] = [];
    await expect(together([builder(log, "only", null, aborted)])).rejects.toBe(aborted);
  });
});
