/**
 * Signs a test account in on a REMOTE site (test.gokesari.com, or a
 * production test account) with the normal email code, and saves the browser
 * session for the batch-2026-10 end-to-end specs (tests/e2e/batch-2026-10.spec.ts).
 *
 *   npx tsx scripts/e2e/remote-login.ts <baseUrl> <email> <stateFile> <codeFile>
 *
 * It requests the code, then waits (up to 10 minutes) for a person — or the
 * tester reading the mailbox — to write the code into <codeFile>. Nothing is
 * forged: the session is exactly what a customer's browser would hold. The
 * state file holds a live session cookie: keep it out of git (.e2e-auth/ is
 * gitignored) and delete it after the run.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";

async function main() {
  const [baseUrl, email, stateFile, codeFile] = process.argv.slice(2);
  if (!baseUrl || !email || !stateFile || !codeFile) {
    throw new Error("usage: remote-login.ts <baseUrl> <email> <stateFile> <codeFile>");
  }
  // Same as playwright.config.ts: an explicitly provided Chromium wins.
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(new URL("/signin", baseUrl).toString(), { waitUntil: "networkidle" });

  // The sign-in consent ("I agree") gates the Get code button; tick it once
  // the page has hydrated (a click before that is lost).
  const agree = page.getByTestId("signin-consent").locator("input[type=checkbox]").first();
  const getCode = page.getByRole("button", { name: "Get code" });
  for (let i = 0; i < 10 && !(await getCode.isEnabled()); i++) {
    if (await agree.count()) await agree.check({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
  await page.getByLabel("Mobile number or email").fill(email);
  await getCode.click();
  await page.getByTestId("otp-sent-to").waitFor({ timeout: 30_000 });
  console.log(`[remote-login] code requested for ${email}; waiting for ${codeFile}`);

  const deadline = Date.now() + 10 * 60_000;
  let code = "";
  while (Date.now() < deadline) {
    if (existsSync(codeFile)) {
      code = readFileSync(codeFile, "utf8").trim();
      if (/^\d{4,8}$/.test(code)) break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!code) throw new Error("no code arrived in time");

  await page.getByLabel("One-time code").fill(code);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 30_000 }),
    page.getByRole("button", { name: /verify|sign in|continue/i }).first().click(),
  ]);
  mkdirSync(dirname(stateFile), { recursive: true });
  await context.storageState({ path: stateFile });
  console.log(`[remote-login] signed in as ${email}; landed on ${page.url()}`);
  await browser.close();
}

main().catch((error) => {
  console.error("[remote-login] failed:", error);
  process.exit(1);
});
