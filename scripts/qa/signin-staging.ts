/**
 * Signs the staging test accounts (tests/qa/worlds/staging.json) in on
 * test.gokesari.com with the normal emailed code and saves each browser
 * session for the signed-in QA tier: .e2e-auth/staging-<role>.json
 * (git-ignored; sessions last 30 days — decision D-041).
 *
 *   npx tsx scripts/qa/signin-staging.ts [--roles customer,shop,rider,admin,ops,oplim] [--wait 600] [--force]
 *
 * A session that is still signed in is kept. For the others it asks for a
 * code for every account at once, then waits for whoever reads the mailbox
 * (the Claude QA agent through Gmail, or a person) to write each code to
 * test-results/qa/codes/<role>.code. The request is in <role>.request
 * ({ email, requestedAt }). Nothing is forged; staging only.
 *
 * Mind the sign-in limits: a code per account at most every 60 s and 5 an
 * hour, and 20 code requests an hour per IP — one round for all seven
 * accounts uses 7. Do not loop this script.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium, request, type Browser, type Page } from "@playwright/test";

const BASE = "https://test.gokesari.com";
const AUTH_DIR = process.env.E2E_AUTH_DIR ?? ".e2e-auth";
const CODES = join("test-results", "qa", "codes");

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const world = JSON.parse(readFileSync(join("tests", "qa", "worlds", "staging.json"), "utf8")) as { users: Record<string, { email: string }> };
const roles = (arg("roles") ?? Object.keys(world.users).join(",")).split(",").map((r) => r.trim()).filter(Boolean);
const waitSeconds = Number(arg("wait") ?? 600);
const force = process.argv.includes("--force");

const stateFile = (role: string) => join(AUTH_DIR, `staging-${role}.json`);

async function signedInAs(role: string): Promise<string | null> {
  if (!existsSync(stateFile(role))) return null;
  const ctx = await request.newContext({ baseURL: BASE, storageState: stateFile(role) });
  try {
    const res = await ctx.get("/api/auth/session");
    const body = (await res.json().catch(() => null)) as { user?: { email?: string; role?: string } } | null;
    return body?.user?.email ? `${body.user.email} (${body.user.role})` : null;
  } finally {
    await ctx.dispose();
  }
}

/**
 * docs/sms-2fa-2026-11: with the SMS sign-in code on for customers / shop owners on staging
 * (Admin → Sign-in security), the email code is followed by an SMS step. Staging runs
 * SMS_PROVIDER=mock, so the code is in the mock outbox: read it through
 * GET /api/admin/test-messages with the saved ADMIN session (admins never get the SMS step,
 * so sign "admin" in first: --roles admin,...). Without an admin session, whoever runs this
 * writes the code from Admin → Test messages to test-results/qa/codes/<role>.smscode.
 * An account without a verified mobile needs a number: QA_SMS_MOBILE_<ROLE> (e.g.
 * QA_SMS_MOBILE_CUSTOMER=9xxxxxxxxx, one free number per account) or users.<role>.mobile in the world file.
 */
async function smsStepIfAsked(page: Page, role: string, email: string) {
  const step = page.getByTestId("sms-second-factor");
  const asked = await step.waitFor({ timeout: 8_000 }).then(() => true, () => false);
  if (!asked) return;
  const askedAt = Date.now();
  const numberBox = page.getByLabel("Mobile number for the SMS code");
  let last4 = "";
  if (await numberBox.isVisible().catch(() => false)) {
    const mobile = process.env[`QA_SMS_MOBILE_${role.toUpperCase()}`] ?? (world.users[role] as { mobile?: string }).mobile;
    if (!mobile) throw new Error(`${role}: the SMS step asks for a mobile number — set QA_SMS_MOBILE_${role.toUpperCase()}`);
    await numberBox.fill(mobile);
    await page.getByRole("button", { name: "Send SMS code" }).click();
    last4 = mobile.replace(/\D/g, "").slice(-4);
  }
  await page.getByLabel("SMS code").waitFor({ timeout: 60_000 });
  if (!last4) last4 = ((await page.getByTestId("sms-sent-to").innerText().catch(() => "")).match(/(\d{4})\D*$/)?.[1] ?? "");
  console.log(`signin-staging: ${role}: SMS step for ${email} (mobile ending ${last4 || "?"})`);

  const smsFile = join(CODES, `${role}.smscode`);
  let code = "";
  for (let i = 0; i < waitSeconds && !code; i++) {
    if (existsSync(smsFile)) code = readFileSync(smsFile, "utf8").trim();
    else if (last4 && existsSync(stateFile("admin")) && i % 3 === 0) code = (await smsCodeFromOutbox(last4, askedAt)) ?? "";
    if (!code) await page.waitForTimeout(1000);
  }
  if (!code) throw new Error(`${role}: no SMS code within ${waitSeconds} s (sign admin in first, or write ${smsFile})`);
  await page.getByLabel("SMS code").fill(code);
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  rmSync(smsFile, { force: true });
}

/** The newest mock SMS code to a number ending in `last4`, sent after `since`, read with the admin session. */
async function smsCodeFromOutbox(last4: string, since: number): Promise<string | null> {
  const ctx = await request.newContext({ baseURL: BASE, storageState: stateFile("admin") });
  try {
    const res = await ctx.get(`/api/admin/test-messages?to=${last4}`);
    if (!res.ok()) return null;
    const body = (await res.json().catch(() => null)) as { messages?: { body: string; purpose: string; createdAt: string }[] } | null;
    const hit = (body?.messages ?? []).find((m) => m.purpose === "otp" && new Date(m.createdAt).getTime() >= since - 5_000);
    return hit?.body.match(/verification OTP is (\d{4,8})\./)?.[1] ?? hit?.body.match(/^(\d{4,8}) is your GoKesari code/)?.[1] ?? null;
  } finally {
    await ctx.dispose();
  }
}

async function signIn(browser: Browser, role: string, email: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/signin`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const identifier = page.getByLabel("Mobile number or email");
    await identifier.waitFor({ timeout: 120_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    // The consent tick is React state: tick it until the hydrated page enables "Get code".
    const agree = page.getByRole("checkbox", { name: /I agree/i }).first();
    const getCode = page.getByRole("button", { name: "Get code" });
    for (let i = 0; i < 40 && !(await getCode.isEnabled()); i++) {
      if (await agree.isChecked().catch(() => false)) await agree.click({ force: true }).catch(() => {});
      await agree.click({ force: true }).catch(() => {});
      await page.waitForTimeout(600);
    }
    for (let i = 0; i < 10 && (await identifier.inputValue()) !== email; i++) {
      await identifier.fill(email);
      await page.waitForTimeout(300);
    }
    const codeFile = join(CODES, `${role}.code`);
    rmSync(codeFile, { force: true });
    await getCode.click();
    try {
      await page.getByLabel("One-time code").waitFor({ timeout: 60_000 });
    } catch {
      // Usually a sign-in limit: 60 s between codes, 5 an hour per account, 20 an hour per IP.
      const said = (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").match(/[^.]*(wait|too many|limit|try again)[^.]*\./i)?.[0];
      throw new Error(`no code step for ${email}: ${said ?? "no message on the page"}`);
    }
    writeFileSync(join(CODES, `${role}.request`), JSON.stringify({ role, email, requestedAt: new Date().toISOString() }));
    console.log(`signin-staging: ${role}: code requested for ${email}; waiting for ${codeFile}`);
    let code = "";
    for (let i = 0; i < waitSeconds && !code; i++) {
      if (existsSync(codeFile)) code = readFileSync(codeFile, "utf8").trim();
      else await page.waitForTimeout(1000);
    }
    if (!code) throw new Error(`no code for ${role} within ${waitSeconds} s`);
    await page.getByLabel("One-time code").fill(code);
    // The code form's own submit button ("Sign in"), not the header link or another provider's button.
    await page.getByTestId("otp-signin").getByRole("button", { name: "Sign in", exact: true }).click();
    await smsStepIfAsked(page, role, email);
    let who = "";
    for (let i = 0; i < 60 && !who; i++) {
      await page.waitForTimeout(1500);
      const session = (await (await page.request.get(`${BASE}/api/auth/session`)).json().catch(() => null)) as { user?: { email?: string } } | null;
      who = session?.user?.email ?? "";
    }
    if (who.toLowerCase() !== email.toLowerCase()) {
      await page.screenshot({ path: join(CODES, `${role}-failed.png`), fullPage: true }).catch(() => {});
      throw new Error(`${role}: not signed in after the code (session: ${who || "none"}; see ${role}-failed.png)`);
    }
    mkdirSync(AUTH_DIR, { recursive: true });
    await context.storageState({ path: stateFile(role) });
    rmSync(codeFile, { force: true });
    rmSync(join(CODES, `${role}.request`), { force: true });
    console.log(`signin-staging: ${role}: signed in → ${stateFile(role)}`);
  } finally {
    await context.close();
  }
}

async function main() {
  mkdirSync(CODES, { recursive: true });
  const todo: string[] = [];
  for (const role of roles) {
    const user = world.users[role];
    if (!user) throw new Error(`no staging account for role "${role}"`);
    const who = force ? null : await signedInAs(role);
    if (who) console.log(`signin-staging: ${role}: still signed in as ${who}`);
    else todo.push(role);
  }
  if (!todo.length) return;
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const results = await Promise.allSettled(
      todo.map((role) =>
        signIn(browser, role, world.users[role].email).catch((error) => {
          console.error(`signin-staging: ${role}: ${String(error).split("\n")[0]}`);
          throw error;
        }),
      ),
    );
    const failed = results.map((r, i) => (r.status === "rejected" ? `${todo[i]}: ${String(r.reason).split("\n")[0]}` : null)).filter(Boolean);
    if (failed.length) {
      console.error(`signin-staging: not signed in — ${failed.join("; ")}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
