/**
 * Signs in to a GoKesari site in a real browser with the emailed sign-in code
 * and saves the session (Playwright storage state) for later test scripts.
 *
 *   node scripts/test-site/signin.mjs https://test.gokesari.com owner@example.com state.json codefile.txt
 *
 * The code is read from `codefile.txt` (whoever reads the mailbox writes it
 * there); the script waits up to five minutes for it.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { chromium } from "@playwright/test";

const [base, email, statePath, codeFile] = process.argv.slice(2);
if (!base || !email || !statePath || !codeFile) {
  console.error("usage: signin.mjs <base url> <email> <state.json> <code file>");
  process.exit(2);
}
if (existsSync(codeFile)) unlinkSync(codeFile);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
await page.goto(`${base}/signin`);
const agree = page.getByRole("checkbox").first();
if (await agree.isVisible().catch(() => false)) await agree.check();
await page.getByLabel("Mobile number or email").fill(email);
await page.getByLabel("Mobile number or email").press("Enter");
console.log("CODE_REQUESTED", new Date().toISOString());
let code = null;
for (let i = 0; i < 300 && !code; i += 1) {
  if (existsSync(codeFile)) code = readFileSync(codeFile, "utf8").trim();
  else await new Promise((r) => setTimeout(r, 1000));
}
if (!code) throw new Error("no code");
await page.getByLabel("One-time code").fill(code);
await page.getByLabel("One-time code").press("Enter");
await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 60_000 });
await context.storageState({ path: statePath });
const session = await (await context.request.get(`${base}/api/auth/session`)).json();
console.log("SIGNED_IN", session?.user?.email, page.url());
await browser.close();
