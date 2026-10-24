/**
 * Every QA check is declared with qa(): it is a Playwright test named after
 * the TC IDs it covers, and its outcome is written once per test to
 * test-results/qa/<host>/<project>.jsonl —
 *
 *   pass     behaved as the case's Expected result says
 *   fail     differed (the detail says how; Playwright keeps a screenshot and trace)
 *   blocked  could not be tested here (no session, no stock, no provider…)
 *   skipped  not run on this target by rule (e.g. a writing case on production)
 *
 * A check that covers only part of its case says so with `partial`, and the
 * master register shows the case as "Pass (partial)" with that note.
 * scripts/qa/collect.ts gathers the files into docs/testing/qa-runs/.
 */
import { test as base, expect, type Browser, type BrowserContext, type Page, type APIRequestContext } from "@playwright/test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

import { BASE_URL, HOST, TARGET, tierRefusal, type Tier } from "./target";

export type Outcome = "pass" | "fail" | "blocked" | "skipped";

export interface ResultRow {
  id: string;
  title: string;
  status: Outcome;
  detail: string;
  partial?: string;
  tier: Tier;
  project: string;
  target: string;
  host: string;
  spec: string;
  test: string;
  at: string;
  durationMs: number;
  evidence?: string;
}

class Blocked extends Error {}

/** The case cannot run here (missing data, session, provider…): recorded "blocked", not a failure. */
export function blocked(reason: string): never {
  throw new Blocked(reason);
}

/** Blocks the case unless `value` is present. */
export function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) blocked(`needs ${what}`);
  return value;
}

export interface QaOptions {
  /** Where the case may run (default "guest": production-safe). */
  tier?: Tier;
  /** Also run on the phone viewport project (UI cases). */
  mobile?: boolean;
  /** What of the case's Expected result this check does NOT cover. */
  partial?: string;
  /** Per-test timeout override (ms). */
  timeout?: number;
}

export interface QaFixtures {
  page: Page;
  context: BrowserContext;
  request: APIRequestContext;
  browser: Browser;
}

type QaBody = (fixtures: QaFixtures) => Promise<string | void>;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function describeError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(ANSI, "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4).join(" | ").slice(0, 700);
}

interface Pending {
  spec: string;
  ids: string[];
  title: string;
  tier: Tier;
  partial?: string;
  outcome?: { status: Outcome; detail: string };
}

/**
 * `test` with an automatic fixture that writes the result rows after every
 * qa() test — also when the test timed out or crashed, which a try/catch in
 * the test body would never see.
 */
export const test = base.extend<{ qaRecorder: { pending: Pending | null } }>({
  qaRecorder: [
    async ({}, use, testInfo) => {
      const state: { pending: Pending | null } = { pending: null };
      await use(state);
      const p = state.pending;
      if (!p) return;
      let outcome = p.outcome;
      if (!outcome || (outcome.status === "pass" && testInfo.status !== "passed" && testInfo.status !== "skipped")) {
        const why = testInfo.status === "timedOut" ? `timed out after ${testInfo.timeout / 1000} s` : describeError(testInfo.error?.message ?? testInfo.status);
        outcome = { status: "fail", detail: why };
      }
      const dir = join("test-results", "qa", HOST.replace(/[^a-z0-9.-]/gi, "_"));
      mkdirSync(dir, { recursive: true });
      const at = new Date().toISOString();
      const lines = p.ids.map((id) => {
        const row: ResultRow = {
          id,
          title: p.title,
          status: outcome.status,
          detail: outcome.detail,
          ...(p.partial ? { partial: p.partial } : {}),
          tier: p.tier,
          project: testInfo.project.name,
          target: TARGET,
          host: HOST,
          spec: p.spec,
          test: testInfo.title,
          at,
          durationMs: testInfo.duration,
          ...(outcome.status === "fail" ? { evidence: relative(process.cwd(), testInfo.outputDir) } : {}),
        };
        return JSON.stringify(row);
      });
      appendFileSync(join(dir, `${testInfo.project.name}.jsonl`), lines.join("\n") + "\n");
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Declares one QA check. `ids` are the TC IDs (or SC IDs) it proves; the body
 * returns a short note of what it saw (kept as the result's detail).
 */
/** The spec file that called qa() (Playwright's own location is this helper). */
function callerSpec() {
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  for (const frame of frames) {
    const file = frame.match(/\(?([^()\s]+\.spec\.ts):\d+:\d+\)?/)?.[1];
    if (file) return relative(process.cwd(), file);
  }
  return "tests/qa";
}

export function qa(ids: string | string[], title: string, body: QaBody, options: QaOptions = {}) {
  const list = Array.isArray(ids) ? ids : [ids];
  const tier = options.tier ?? "guest";
  const spec = callerSpec();
  test(`${list.join(" ")} ${title}`, async ({ page, context, request, browser, qaRecorder }, testInfo) => {
    if (testInfo.project.name === "mobile" && !options.mobile) {
      test.skip(true, "desktop-only check");
      return;
    }
    if (options.timeout) test.setTimeout(options.timeout);
    qaRecorder.pending = { spec, ids: list, title, tier, partial: options.partial };
    const refusal = tierRefusal(tier);
    if (refusal) {
      qaRecorder.pending.outcome = { status: "skipped", detail: refusal };
      test.skip(true, refusal);
      return;
    }
    try {
      const detail = (await body({ page, context, request, browser })) ?? "";
      qaRecorder.pending.outcome = { status: "pass", detail };
    } catch (error) {
      if (error instanceof Blocked) {
        qaRecorder.pending.outcome = { status: "blocked", detail: error.message };
        test.skip(true, `blocked: ${error.message}`);
        return;
      }
      qaRecorder.pending.outcome = { status: "fail", detail: describeError(error) };
      throw error;
    }
  });
}

/**
 * Declares cases that cannot be automated here (a real handset for SMS, a
 * WhatsApp sandbox, a gateway chargeback…). They are recorded "blocked" with
 * the reason on every run, so the register shows why, never a silent gap.
 */
export function manual(ids: string | string[], title: string, reason: string, options: { tier?: Tier } = {}) {
  qa(ids, title, async () => blocked(`not automated: ${reason}`), { tier: options.tier ?? "signed" });
}

export { BASE_URL };
