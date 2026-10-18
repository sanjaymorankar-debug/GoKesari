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
  // By its accessible name: older builds have no data-testid on the consent box.
  const agree = page.getByRole("checkbox", { name: /I agree/i }).first();
  const getCode = page.getByRole("button", { name: "Get code" });
  for (let i = 0; i < 40 && !(await getCode.isEnabled()); i++) {
    // A tick that landed before hydration shows as checked while React's
    // state is still "not agreed": untick and tick again.
    if (await agree.isChecked().catch(() => false)) {
      await agree.click({ force: true }).catch(() => {});
      await page.waitForTimeout(200);
    }
    await agree.click({ force: true }).catch(() => {});
    await page.waitForTimeout(700);
  }
  // Typed only now: the consent tick taking effect proves React has hydrated
  // (text typed before hydration is wiped by the first render).
  const identifier = page.getByLabel("Mobile number or email");
  for (let i = 0; i < 10 && (await identifier.inputValue()) !== email; i++) {
    await identifier.fill(email);
    await page.waitForTimeout(300);
  }
  await getCode.click();
  // The code box appears once the code is sent (older builds have no test ids).
  try {
    await page.getByLabel("One-time code").waitFor({ timeout: 30_000 });
  } catch (error) {
    if (process.env.E2E_DEBUG_SHOT) await page.screenshot({ path: process.env.E2E_DEBUG_SHOT, fullPage: true });
    const text = (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 900);
    throw new Error(`no code box after "Get code"; the form says: ${text}`, { cause: error });
  }
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

  // Submit the code's own form (Enter) — a name match could hit "Continue with Google".
  const codeBox = page.getByLabel("One-time code");
  await codeBox.fill(code);
  await Promise.all([
    page.waitForURL((url) => url.host === new URL(baseUrl).host && !url.pathname.startsWith("/signin"), { timeout: 30_000 }),
    codeBox.press("Enter"),
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
