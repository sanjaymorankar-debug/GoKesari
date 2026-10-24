/**
 * API helpers shared by the QA specs: one call returns status, parsed JSON
 * and text and never throws on an HTTP status, so a check can assert on the
 * refusal it expects.
 */
import { expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BASE_URL, HOST, IS_REMOTE } from "./target";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface Answer {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- API bodies are checked field by field in the specs
  body: any;
  text: string;
  headers: Record<string, string>;
  location: string | null;
}

/** Remote sites answer slowly (checkout took 30–38 s on test, D-27). */
export const SLOW_MS = /^https:/.test(BASE_URL) ? 120_000 : 60_000;

export async function call(
  ctx: APIRequestContext,
  method: Method,
  path: string,
  data?: unknown,
  options: { headers?: Record<string, string>; form?: Record<string, string>; multipart?: Parameters<APIRequestContext["fetch"]>[1] extends infer O ? O extends { multipart?: infer M } ? M : never : never; maxRedirects?: number } = {},
): Promise<Answer> {
  const res = await ctx.fetch(new URL(path, BASE_URL).toString(), {
    method,
    ...(options.multipart ? { multipart: options.multipart } : options.form ? { form: options.form } : data === undefined ? {} : { data: JSON.stringify(data) }),
    headers: {
      ...(data !== undefined && !options.multipart && !options.form ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    maxRedirects: options.maxRedirects ?? 0,
    failOnStatusCode: false,
    timeout: SLOW_MS,
  });
  const headers = res.headers();
  const type = headers["content-type"] ?? "";
  const binary = /pdf|spreadsheet|octet-stream|image\//.test(type);
  const text = binary ? "" : (await res.body()).toString("utf8");
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status(), body, text, headers, location: headers["location"] ?? null };
}

/** "HTTP 409: <message>" for an answer. */
export function why(res: Answer) {
  const message = res.body?.error?.message ?? res.body?.error ?? res.body?.message ?? res.text.replace(/\s+/g, " ").slice(0, 200);
  return `HTTP ${res.status}: ${typeof message === "string" ? message : JSON.stringify(message)}`;
}

export function expectStatus(res: Answer, expected: number | number[], what: string) {
  const list = Array.isArray(expected) ? expected : [expected];
  expect(list, `${what} — ${why(res)}`).toContain(res.status);
}

/** A signed-out request context (no cookies). */
export async function anonymous(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: BASE_URL, timeout: SLOW_MS });
}

export async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, everyMs = 2000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, everyMs));
    value = await read();
  }
  return value;
}

/** A short pause between requests of a sweep on a deployed site, so a run stays at a person's pace. */
export async function pace(ms = 150) {
  if (IS_REMOTE) await new Promise((r) => setTimeout(r, ms));
}

/** True when the answer sends a signed-out caller to sign in (redirect) or refuses it (401/403). */
export function refusesGuest(res: Answer) {
  if (res.status === 401 || res.status === 403) return true;
  if ([302, 303, 307, 308].includes(res.status) && /\/signin/.test(res.location ?? "")) return true;
  return false;
}

/* ------------------------------------------------------------------ stash */

/**
 * Values that checks hand to each other (an order id, a product…), kept on
 * disk: Playwright starts a fresh worker after a failed test, so memory would
 * lose them. One file per host and spec run.
 */
const STASH = join("test-results", "qa", HOST.replace(/[^a-z0-9.-]/gi, "_"), "stash.json");

function readStash(): Record<string, unknown> {
  try {
    return existsSync(STASH) ? (JSON.parse(readFileSync(STASH, "utf8")) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function stash<T>(key: string, value: T): T {
  const all = readStash();
  all[key] = value;
  mkdirSync(join(STASH, ".."), { recursive: true });
  writeFileSync(STASH, JSON.stringify(all, null, 2));
  return value;
}

export function unstash<T>(key: string): T | undefined {
  return readStash()[key] as T | undefined;
}

/** A per-run suffix for names, so repeated runs never collide. */
export const RUN = Date.now().toString(36);
