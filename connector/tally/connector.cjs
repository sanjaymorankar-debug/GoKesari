#!/usr/bin/env node
/**
 * GoKesari Connector for TallyPrime (Module 2, docs/three-modules-2026-10).
 *
 * Runs on the shop's Windows computer next to Tally. It only makes OUTBOUND
 * HTTPS calls to GoKesari and local calls to Tally (http://localhost:9000);
 * it opens no port, and Tally's port is never exposed to the internet.
 *
 * It is a dumb pipe on purpose: GoKesari builds every Tally XML request and
 * reads every reply, so the connector rarely needs updating.
 *
 *   1. hello            → company, timings and the request that reads Tally's items
 *   2. every 2 minutes  → runs that request; uploads the list only if it changed
 *   3. long-poll /jobs  → for each job: send its XML to Tally, post Tally's reply,
 *                         follow the next step GoKesari returns (lookup → create)
 *
 * Settings: connector.json next to the program (or GOKESARI_CONFIG):
 *   { "server": "https://test.gokesari.com", "token": "gkc_…", "tallyUrl": "http://localhost:9000" }
 * First run:  gokesari-connector setup --server https://gokesari.com --token gkc_…
 *
 * No dependencies: Node 20+ (fetch). Built into one .exe with Node's
 * single-executable-application support (see build.md).
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION = "1.0.0";

const IS_SEA = (() => {
  try {
    return require("node:sea").isSea();
  } catch {
    return false;
  }
})();

/* ----------------------------------------------------------- settings */

function configPath() {
  if (process.env.GOKESARI_CONFIG) return process.env.GOKESARI_CONFIG;
  const dir = IS_SEA ? path.dirname(process.execPath) : __dirname;
  return path.join(dir, "connector.json");
}

function loadConfig(file = configPath()) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const server = String(raw.server || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(server) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(server)) {
    throw new Error("connector.json: server must be the https:// address of GoKesari.");
  }
  if (!/^gkc_[A-Za-z0-9_-]{20,}$/.test(String(raw.token || ""))) {
    throw new Error("connector.json: token is missing. Create one in GoKesari → Shop settings → Integrations.");
  }
  const tallyUrl = String(raw.tallyUrl || "http://localhost:9000").replace(/\/+$/, "");
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(tallyUrl)) {
    throw new Error("connector.json: tallyUrl must be on this computer (http://localhost:9000).");
  }
  return { server, token: raw.token, tallyUrl };
}

function saveConfig(values, file = configPath()) {
  fs.writeFileSync(file, JSON.stringify(values, null, 2), { mode: 0o600 });
}

/* ------------------------------------------------------------ logging */

function log(level, message) {
  const line = `${new Date().toISOString()} ${level} ${message}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------- Tally */

/** Sends XML to Tally. Returns { ok, response } or { ok:false, errorCode, detail }. */
async function callTally(tallyUrl, xml, fetchFn = fetch) {
  try {
    const res = await fetchFn(tallyUrl, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body: xml,
      signal: AbortSignal.timeout(120000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, errorCode: "UNREACHABLE", detail: `Tally HTTP ${res.status}: ${text.slice(0, 500)}` };
    return { ok: true, response: text };
  } catch (error) {
    const msg = String((error && (error.cause && error.cause.code)) || (error && error.message) || error);
    if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|fetch failed/i.test(msg)) {
      return { ok: false, errorCode: "TALLY_NOT_RUNNING", detail: msg };
    }
    return { ok: false, errorCode: "INTERNAL", detail: msg };
  }
}

/* ----------------------------------------------------------- GoKesari */

function client(config, fetchFn = fetch) {
  async function call(method, pathName, body, contentType = "application/json", timeoutMs = 45000) {
    const res = await fetchFn(`${config.server}/api/connector/v1${pathName}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "X-Connector-Version": VERSION,
        ...(body !== undefined ? { "Content-Type": contentType } : {}),
      },
      body: body === undefined ? undefined : contentType === "application/json" ? JSON.stringify(body) : body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    if (res.status === 401) {
      const e = new Error((data && data.error && data.error.message) || "The connector token is not valid.");
      e.fatal = true;
      throw e;
    }
    if (!res.ok && res.status !== 202) {
      throw new Error(`GoKesari ${method} ${pathName}: HTTP ${res.status} ${(data && data.error && data.error.message) || ""}`);
    }
    return data;
  }
  return {
    hello: (info) => call("POST", "/hello", info),
    jobs: (wait) => call("GET", `/jobs?wait=${wait}`, undefined, undefined, (wait + 20) * 1000),
    result: (jobId, result) => call("POST", `/jobs/${jobId}/result`, result, "application/json", 150000),
    items: (xml) => call("POST", "/items", xml, "text/xml; charset=utf-8", 150000),
  };
}

/* --------------------------------------------------------------- work */

/** Runs one job to the end: each step's XML to Tally, Tally's reply to GoKesari. */
async function runJob(api, config, job, fetchFn = fetch) {
  let step = job;
  for (let i = 0; i < 10 && step; i++) {
    const outcome = await callTally(config.tallyUrl, step.body, fetchFn);
    const result = outcome.ok
      ? { ok: true, stepId: step.stepId, response: outcome.response }
      : { ok: false, stepId: step.stepId, errorCode: outcome.errorCode, detail: outcome.detail };
    const reply = await api.result(job.jobId, result);
    if (!reply || reply.done) {
      log(reply && reply.error ? "WARN" : "INFO", `${job.kind} ${job.jobId}: ${reply && reply.error ? `failed (${reply.error})` : "done"}`);
      return reply;
    }
    step = reply.next;
  }
  return null;
}

/** Reads Tally's items; uploads them only when the list changed since the last upload. */
async function checkItems(api, config, state, fetchFn = fetch) {
  if (!state.itemsRequest) return false;
  const outcome = await callTally(config.tallyUrl, state.itemsRequest, fetchFn);
  if (!outcome.ok) {
    if (state.lastTallyError !== outcome.errorCode) log("WARN", `Tally: ${outcome.errorCode} ${outcome.detail || ""}`);
    state.lastTallyError = outcome.errorCode;
    return false;
  }
  state.lastTallyError = null;
  const hash = crypto.createHash("sha256").update(outcome.response).digest("hex");
  if (hash === state.itemsHash) return false;
  const reply = await api.items(outcome.response);
  if (reply && reply.accepted) {
    state.itemsHash = hash;
    log("INFO", `Sent ${reply.items} items to GoKesari.`);
    return true;
  }
  log("WARN", `GoKesari did not accept the item list: ${JSON.stringify(reply)}`);
  return false;
}

async function hello(api, config, state, fetchFn = fetch) {
  const probe = await callTally(config.tallyUrl, "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>GKCompanies</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME=\"GKCompanies\" ISMODIFY=\"No\"><TYPE>Company</TYPE><FETCH>NAME</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>", fetchFn);
  const companies = probe.ok ? Array.from(probe.response.matchAll(/<COMPANY\s+NAME="([^"]*)"/g)).map((m) => decodeXml(m[1])) : undefined;
  const reply = await api.hello({ version: VERSION, tallyRunning: probe.ok, companies, machine: os.hostname().slice(0, 100) });
  state.itemsRequest = reply.itemsRequest;
  state.pollSeconds = reply.pollSeconds || 25;
  state.itemCheckSeconds = reply.itemCheckSeconds || 120;
  state.paused = Boolean(reply.paused);
  log("INFO", `Connected to GoKesari for ${reply.shop && reply.shop.name} (Tally company: ${reply.company || "not set"}).`);
  return reply;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** The main loop. Never exits on its own except for an invalid token. */
async function run(config, options = {}) {
  const fetchFn = options.fetch || fetch;
  const api = client(config, fetchFn);
  const state = { itemsHash: null, itemsRequest: null, pollSeconds: 25, itemCheckSeconds: 120, lastItemsAt: 0, lastHelloAt: 0 };
  let backoff = 5;
  while (!options.signal || !options.signal.aborted) {
    try {
      if (!state.lastHelloAt || Date.now() - state.lastHelloAt > 30 * 60 * 1000 || !state.itemsRequest) {
        await hello(api, config, state, fetchFn);
        state.lastHelloAt = Date.now();
      }
      if (!state.paused && Date.now() - state.lastItemsAt >= state.itemCheckSeconds * 1000) {
        state.lastItemsAt = Date.now();
        await checkItems(api, config, state, fetchFn);
      }
      const reply = await api.jobs(state.paused ? 5 : state.pollSeconds);
      for (const job of (reply && reply.jobs) || []) {
        await runJob(api, config, job, fetchFn);
        // Tally's stock changed with the voucher: send the new list soon.
        if (job.kind === "PUSH_INVOICE" || job.kind === "PUSH_CREDIT_NOTE") state.lastItemsAt = 0;
      }
      backoff = 5;
      if (options.once) return state;
    } catch (error) {
      if (error && error.fatal) {
        log("ERROR", `${error.message} Stopping.`);
        throw error;
      }
      log("WARN", `${(error && error.message) || error} — trying again in ${backoff} s.`);
      if (options.once) throw error;
      await sleep(backoff * 1000);
      backoff = Math.min(backoff * 2, 300);
    }
  }
  return state;
}

/* ---------------------------------------------------------------- CLI */

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const command = process.argv[2] || "run";
  if (command === "version" || command === "--version") {
    console.log(VERSION);
    return;
  }
  if (command === "setup") {
    const server = arg("server");
    const token = arg("token");
    if (!server || !token) {
      console.error("Usage: gokesari-connector setup --server https://gokesari.com --token gkc_… [--tally http://localhost:9000]");
      process.exit(2);
    }
    const values = { server, token, tallyUrl: arg("tally") || "http://localhost:9000" };
    saveConfig(values);
    loadConfig();
    console.log(`Saved ${configPath()}`);
    return;
  }
  const config = loadConfig();
  log("INFO", `GoKesari Connector ${VERSION} starting (server ${config.server}, Tally ${config.tallyUrl}).`);
  await run(config);
}

module.exports = { VERSION, loadConfig, callTally, client, runJob, checkItems, hello, run };

if (IS_SEA || require.main === module) {
  main().catch((error) => {
    log("ERROR", (error && error.message) || String(error));
    process.exit(1);
  });
}
