/**
 * QA D-118 (staging billing v2 retest, 02-Nov-2026): Hostinger's CDN kept an
 * API 404 that had no Cache-Control for 10–20 s and gave it to the next
 * caller, so the invoice's own customer got another user's "not found". Every
 * API error answer now says "private, no-store".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/server/auth", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as invoiceJsonGet } from "@/app/api/invoices/[id]/json/route";
import { AppError } from "@/lib/errors";
import { proxy } from "@/proxy";
import { errorResponse, ok, parseBody, route } from "@/server/api/handler";

const NO_STORE = "private, no-store";

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routeFiles(path) : name === "route.ts" ? [path] : [];
  });
}

describe("API error answers are never cached (QA D-118)", () => {
  it("errorResponse keeps the status and body and adds no-store", async () => {
    const response = errorResponse(new AppError("NOT_FOUND", "Invoice not found."));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe(NO_STORE);
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Invoice not found." } });
  });

  it("route() answers thrown errors and validation failures with no-store, and leaves a success as it was", async () => {
    const refused = await route(async () => {
      throw new AppError("FORBIDDEN", "Not yours.");
    })();
    expect(refused.status).toBe(403);
    expect(refused.headers.get("cache-control")).toBe(NO_STORE);

    const invalid = await route(async (request: Request) => ok(await parseBody(request, z.object({ name: z.string() }))))(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ name: 1 }) }),
    );
    expect(invalid.status).toBe(422);
    expect(invalid.headers.get("cache-control")).toBe(NO_STORE);

    const fine = await route(async () => ok({ ok: true }))();
    expect(fine.status).toBe(200);
    expect(fine.headers.get("cache-control")).toBeNull();
  });

  it("a hand-written invoice route answers its 404 with no-store", async () => {
    const response = await invoiceJsonGet(new Request("http://localhost/x") as never, { params: Promise.resolve({ id: "not-an-id" }) });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("the cron guard's 410 and 401 are never cached either (release #332 check B-3)", () => {
    vi.stubEnv("CRON_ROUTES_ENABLED", "false");
    vi.stubEnv("CRON_SECRET", "s3cret");
    try {
      const retired = proxy(new NextRequest("http://localhost/api/cron/old-job"));
      expect(retired.status).toBe(410);
      expect(retired.headers.get("cache-control")).toBe(NO_STORE);
      const refused = proxy(new NextRequest("http://localhost/api/cron/every-minute"));
      expect(refused.status).toBe(401);
      expect(refused.headers.get("cache-control")).toBe(NO_STORE);
      const allowed = proxy(new NextRequest("http://localhost/api/cron/every-minute", { headers: { authorization: "Bearer s3cret" } }));
      expect(allowed.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("no GET route builds its own error answer from toClientError", () => {
    const offenders = routeFiles(join(process.cwd(), "src/app/api")).filter((file) => {
      const source = readFileSync(file, "utf8");
      return /toClientError\(/.test(source) && /export (async function|const) GET\b/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
