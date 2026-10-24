/**
 * The sign-in form's own validation and the site's security basics, as a
 * guest (production-safe): only refused input is submitted, so no code is
 * ever sent; headers, HTTPS, robots.txt and error bodies are read.
 */
import type { Page } from "@playwright/test";

import { anonymous, call, callApp } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";
import { BASE_URL, IS_LOCAL, TARGET } from "../lib/target";

async function signinForm(page: Page) {
  const res = await page.goto("/signin", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBeLessThan(400);
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  const identifier = page.getByLabel("Mobile number or email");
  if (!(await identifier.count())) blocked("the sign-in code form is not shown here (email sending is not configured on this server)");
  const agree = page.getByRole("checkbox", { name: /I agree/i }).first();
  const getCode = page.getByRole("button", { name: "Get code" });
  return { identifier, agree, getCode };
}

/** Ticks the consent box until React (once hydrated) enables Get code. */
async function agreeTo(page: Page, agree: ReturnType<Page["getByRole"]>, getCode: ReturnType<Page["getByRole"]>) {
  for (let i = 0; i < 30 && !(await getCode.isEnabled()); i++) {
    if (await agree.isChecked().catch(() => false)) await agree.click({ force: true }).catch(() => {});
    await agree.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

qa(["TC-FLD-004", "TC-MKT-002"], "Get code stays disabled until the terms box is ticked", async ({ page }) => {
  const { identifier, agree, getCode } = await signinForm(page);
  await identifier.fill("9876543210");
  await expect(getCode, "Get code before consent").toBeDisabled();
  await agreeTo(page, agree, getCode);
  await expect(getCode, "Get code after consent").toBeEnabled();
  return "disabled until 'I agree' is ticked, enabled after";
}, { mobile: true, partial: "the page half; the API half (sign-up without consent) and the recorded consent row run on the local tier" });

qa(["TC-AUTH-019", "TC-FLD-001", "TC-FLD-002"], "invalid mobile numbers and emails get a field message and no code is requested", async ({ page }) => {
  const { identifier, agree, getCode } = await signinForm(page);
  await agreeTo(page, agree, getCode);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/otp/request") && r.method() === "POST") requests.push(r.postData() ?? "");
  });
  const refused: string[] = [];
  for (const value of ["12345", "5876543210", "98765432101", "abcdefghij", "+91 5876543210", "abc@", "@x.com", "a b@x.com"]) {
    await identifier.fill(value);
    await getCode.click();
    await expect(page.getByRole("alert").or(page.locator("[role=alert], .text-red-600, [data-testid=otp-error]")).first(), `message for "${value}"`).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel("One-time code"), `no code step for "${value}"`).toHaveCount(0);
    refused.push(value);
  }
  expect(requests, `codes were requested for: ${requests.join(" | ")}`).toEqual([]);
  return `${refused.length} invalid values refused on the field; no /api/otp/request sent`;
}, { mobile: true, partial: "blank and over-254-character emails, and how a valid number is stored, run on the local tier" });

qa("TC-FLD-002", "the sign-in API refuses an over-long or malformed email without sending anything", async () => {
  const guest = await anonymous();
  const out: string[] = [];
  // One call on a deployed site (the sign-in limit is per IP); all three locally.
  const emails = IS_LOCAL ? ["a".repeat(250) + "@x.com", "not-an-email", ""] : ["a".repeat(250) + "@x.com"];
  for (const email of emails) {
    const res = await callApp(guest, "POST", "/api/otp/request", { email });
    if (res.host) blocked(`the host firewall answered ${res.status} three times, not the app (E-01)`);
    expect(res.status, `email "${email.slice(0, 20)}…" — HTTP ${res.status}`).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    out.push(`${email.length} chars → ${res.status}`);
  }
  await guest.dispose();
  return out.join("; ");
});

qa("TC-SEC-007", "HTTP redirects to HTTPS", async () => {
  if (IS_LOCAL) blocked("local server has no HTTPS");
  const http = BASE_URL.replace(/^https:/, "http:");
  const res = await fetch(http, { redirect: "manual" });
  expect([301, 302, 307, 308], `http:// answered ${res.status}`).toContain(res.status);
  expect(res.headers.get("location") ?? "").toMatch(/^https:\/\//);
  return `${http} → ${res.status} ${res.headers.get("location")}`;
});

qa("TC-SEC-008", "robots.txt: the test site (and any non-production host) keeps search engines out; production lets them in", async () => {
  const guest = await anonymous();
  const res = await call(guest, "GET", "/robots.txt");
  await guest.dispose();
  if (TARGET === "production") {
    if (res.status === 200) expect(res.text, "production must not disallow everything").not.toMatch(/^Disallow:\s*\/\s*$/im);
    return `production robots.txt → ${res.status}: ${res.text.replace(/\s+/g, " ").slice(0, 80)}`;
  }
  expect(res.status, `robots.txt on ${TARGET}`).toBe(200);
  expect(res.text, `${TARGET} robots.txt`).toMatch(/^Disallow:\s*\/\s*$/im);
  return `${TARGET} robots.txt: ${res.text.replace(/\s+/g, " ").slice(0, 120)}`;
}, { partial: "'the agent allowed for testing is permitted': no testing agent needs crawling today, so none is listed" });

qa(["TC-SEC-010", "TC-SEC-005"], "error answers and headers give no server details (no stack, SQL, paths or version)", async () => {
  const guest = await anonymous();
  const leaks: string[] = [];
  const probes: [string, "GET" | "POST"][] = [
    ["/api/shops/abc/products", "GET"],
    ["/api/products/abc", "GET"],
    ["/api/otp/request", "POST"],
    ["/api/grievances", "POST"],
    ["/this-page-does-not-exist", "GET"],
  ];
  for (const [path, method] of probes) {
    const res = await call(guest, method, path, method === "POST" ? { bad: true } : undefined);
    if (/at [\w.<>]+ \(|node_modules|\/home\/|\/var\/www|SELECT |INSERT |relation "|duplicate key|ECONNREFUSED|postgres/i.test(res.text)) leaks.push(`${path}: body has server details`);
    if (res.headers["x-powered-by"]) leaks.push(`${path}: X-Powered-By ${res.headers["x-powered-by"]}`);
  }
  const home = await call(guest, "GET", "/");
  if (/\d+\.\d+/.test(home.headers["server"] ?? "")) leaks.push(`Server header has a version: ${home.headers["server"]}`);
  await guest.dispose();
  expect(leaks, leaks.join("; ")).toEqual([]);
  return `${probes.length} error answers and the home headers carry no stack, SQL, path or version`;
}, { partial: "no 500 was found to read; signed-in responses (PAN, bank, codes) are checked in the signed-in tier" });

qa("TC-SEC-006", "the session cookie is HttpOnly, Secure and SameSite on the sites", async ({ page }) => {
  // A guest gets the CSRF cookie from Auth.js; it carries the same flags as the session cookie.
  await page.goto("/api/auth/csrf");
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => /authjs\.csrf-token/.test(c.name));
  if (!csrf) blocked("no Auth.js cookie was set to inspect");
  expect(csrf.httpOnly, "HttpOnly").toBe(true);
  expect(["Lax", "Strict"]).toContain(csrf.sameSite);
  if (!IS_LOCAL) {
    expect(csrf.secure, "Secure").toBe(true);
    expect(csrf.name.startsWith("__Host-") || csrf.name.startsWith("__Secure-"), `prefix of ${csrf.name}`).toBe(true);
  }
  return `${csrf.name}: HttpOnly ${csrf.httpOnly}, Secure ${csrf.secure}, SameSite ${csrf.sameSite}`;
}, { partial: "reads the Auth.js CSRF cookie, set with the session cookie's options; the session cookie itself is read in the signed-in tier" });
