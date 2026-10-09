/**
 * Module 2 — the GoKesari Connector for Tally (connector/tally/connector.cjs),
 * against a fake GoKesari and a fake Tally: it carries GoKesari's XML to
 * Tally and Tally's replies back, follows multi-step jobs, uploads the item
 * list only when it changed, and reports "Tally is not open" in GoKesari's terms.
 */
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const connector = require(path.resolve(__dirname, "../../connector/tally/connector.cjs")) as {
  VERSION: string;
  run: (config: { server: string; token: string; tallyUrl: string }, options: { fetch: typeof fetch; once: boolean }) => Promise<{ itemsHash: string | null }>;
};

const CONFIG = { server: "https://test.gokesari.com", token: "gkc_abcdefghijklmnopqrstuvwxyz012345", tallyUrl: "http://localhost:9000" };

function world(options: { tallyDown?: boolean } = {}) {
  const sent: { path: string; body: unknown; auth: string | null }[] = [];
  const tallyRequests: string[] = [];
  let items = "<ENVELOPE><STOCKITEM NAME=\"Milk\"><CLOSINGBALANCE>10 Nos</CLOSINGBALANCE></STOCKITEM></ENVELOPE>";
  let jobs: unknown[] = [{ jobId: "j1", kind: "PUSH_INVOICE", stepId: "LOOKUP", body: "<LOOKUP/>" }];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (url.startsWith("http://localhost:9000")) {
      tallyRequests.push(String(init?.body));
      if (options.tallyDown) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      const body = String(init?.body);
      if (body.includes("GKCompanies")) return new Response('<ENVELOPE><COMPANY NAME="Dairy &amp; Co"/></ENVELOPE>');
      if (body === "<ITEMS/>") return new Response(items);
      if (body === "<LOOKUP/>") return new Response("<ENVELOPE/>");
      if (body === "<CREATE/>") return new Response("<RESPONSE><CREATED>1</CREATED></RESPONSE>");
      return new Response("?");
    }
    const p = url.replace(`${CONFIG.server}/api/connector/v1`, "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (headers["Content-Type"]?.startsWith("application/json") ? JSON.parse(String(init.body)) : String(init.body)) : null;
    sent.push({ path: p, body, auth: headers.Authorization ?? null });
    if (p === "/hello") return json({ shop: { name: "Dairy" }, company: "Dairy & Co", pollSeconds: 25, itemCheckSeconds: 120, itemsRequest: "<ITEMS/>" });
    if (p === "/items") return json({ accepted: true, items: 1 }, 202);
    if (p.startsWith("/jobs?")) {
      const out = jobs;
      jobs = [];
      return json({ jobs: out });
    }
    if (p === "/jobs/j1/result") {
      return (body as { stepId: string }).stepId === "LOOKUP"
        ? json({ done: false, next: { jobId: "j1", stepId: "CREATE", body: "<CREATE/>" } })
        : json({ done: true });
    }
    return json({}, 404);
  }) as typeof fetch;
  return {
    fetchFn,
    sent,
    tallyRequests,
    setItems: (xml: string) => (items = xml),
    queue: (j: unknown[]) => (jobs = j),
  };
}

describe("GoKesari Connector (Tally)", () => {
  it("says hello, uploads items, and runs a job step by step with the token", async () => {
    const w = world();
    await connector.run(CONFIG, { fetch: w.fetchFn, once: true });
    const paths = w.sent.map((s) => s.path);
    expect(paths[0]).toBe("/hello");
    expect(w.sent[0].body).toMatchObject({ version: connector.VERSION, tallyRunning: true, companies: ["Dairy & Co"] });
    expect(paths).toContain("/items");
    expect(paths.filter((p) => p === "/jobs/j1/result")).toHaveLength(2);
    const results = w.sent.filter((s) => s.path === "/jobs/j1/result").map((s) => s.body as { stepId: string; ok: boolean; response: string });
    expect(results[0]).toMatchObject({ ok: true, stepId: "LOOKUP", response: "<ENVELOPE/>" });
    expect(results[1]).toMatchObject({ ok: true, stepId: "CREATE" });
    expect(w.sent.every((s) => s.auth === `Bearer ${CONFIG.token}`)).toBe(true);
    expect(w.tallyRequests).toContain("<CREATE/>");
  });

  it("reports Tally not running as TALLY_NOT_RUNNING, and does not upload an empty item list", async () => {
    const w = world({ tallyDown: true });
    await connector.run(CONFIG, { fetch: w.fetchFn, once: true });
    expect(w.sent[0].body).toMatchObject({ tallyRunning: false });
    expect(w.sent.some((s) => s.path === "/items")).toBe(false);
    const result = w.sent.find((s) => s.path === "/jobs/j1/result")!.body as { ok: boolean; errorCode: string };
    expect(result).toMatchObject({ ok: false, errorCode: "TALLY_NOT_RUNNING" });
  });
});
