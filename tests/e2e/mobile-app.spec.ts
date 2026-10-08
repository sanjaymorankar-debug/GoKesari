/**
 * The website side of the Android/iOS app (mobile/): Google sign-in handed
 * back from the system browser, and the sign-in page as the app sees it.
 *
 * Google itself cannot run here, so the browser half starts from "Google has
 * signed this browser in" (the dev sign-in form) plus the cookie
 * /mobile-auth/start sets; everything after that is the real flow.
 */
import { createHash, randomBytes } from "node:crypto";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const APP_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0 Mobile Safari/537.36 GoKesariApp/1.0.0 (android)";

async function devSignIn(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByPlaceholder("you@example.com").last().fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
}

async function sessionEmail(context: BrowserContext): Promise<string | null> {
  const response = await context.request.get("/api/auth/session");
  const body = await response.json().catch(() => null);
  return body?.user?.email ?? null;
}

/** What the system browser ends with: a code for the signed-in user, bound to `verifier`. */
async function codeFromBrowser(browserContext: BrowserContext, baseURL: string, verifier: string) {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await browserContext.addCookies([
    { name: "gk_mobile_auth", value: `gokesari.${challenge}`, url: `${baseURL}/mobile-auth/` },
  ]);
  const response = await browserContext.request.get("/mobile-auth/complete");
  expect(response.status()).toBe(200);
  const html = await response.text();
  const match = /href="gokesari:\/\/auth-callback\?code=([^"]+)"/.exec(html);
  expect(match).not.toBeNull();
  return decodeURIComponent(match![1]);
}

test.describe("mobile app", () => {
  test("Google sign-in comes back from the system browser to the app", async ({ browser, baseURL }) => {
    const email = `mobile-google-${Date.now()}@example.com`;
    const verifier = randomBytes(32).toString("base64url");

    const systemBrowser = await browser.newContext();
    await devSignIn(await systemBrowser.newPage(), email);
    const code = await codeFromBrowser(systemBrowser, baseURL!, verifier);
    // Used once: the browser forgets the challenge.
    expect((await systemBrowser.request.get("/mobile-auth/complete")).status()).toBe(400);

    const app = await browser.newContext({ userAgent: APP_USER_AGENT });
    expect(await sessionEmail(app)).toBeNull();
    const page = await app.newPage();
    await page.goto(`/mobile-auth/finish#code=${encodeURIComponent(code)}&verifier=${verifier}`);
    await page.waitForURL((url) => !url.pathname.startsWith("/mobile-auth"));
    expect(await sessionEmail(app)).toBe(email);

    await systemBrowser.close();
    await app.close();
  });

  test("a code without its verifier does not sign anyone in", async ({ browser, baseURL }) => {
    const systemBrowser = await browser.newContext();
    await devSignIn(await systemBrowser.newPage(), `mobile-intercept-${Date.now()}@example.com`);
    const code = await codeFromBrowser(systemBrowser, baseURL!, randomBytes(32).toString("base64url"));

    const attacker = await browser.newContext({ userAgent: APP_USER_AGENT });
    const page = await attacker.newPage();
    await page.goto(`/mobile-auth/finish#code=${encodeURIComponent(code)}&verifier=${randomBytes(32).toString("base64url")}`);
    await expect(page.getByRole("alert")).toContainText("This sign-in has expired");
    expect(await sessionEmail(attacker)).toBeNull();

    await systemBrowser.close();
    await attacker.close();
  });

  test("the start page remembers the challenge and goes to Google", async ({ request }) => {
    const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
    const response = await request.get(`/mobile-auth/start?app=gokesari&challenge=${challenge}`, { maxRedirects: 0 });
    test.skip(response.status() === 503, "Google sign-in is not configured on this server");
    expect([302, 303, 307]).toContain(response.status());
    expect(new URL(response.headers()["location"]).host).toBe("accounts.google.com");
    expect(response.headers()["set-cookie"]).toContain(`gk_mobile_auth=gokesari.${challenge}`);
  });

  test("the start page refuses a request without a proper challenge", async ({ request }) => {
    expect((await request.get("/mobile-auth/start?app=gokesari&challenge=plain")).status()).toBe(400);
    expect((await request.get("/mobile-auth/start?app=other&challenge=" + "a".repeat(43))).status()).toBe(400);
  });

  test("the sign-in page leaves out the emailed link inside the app", async ({ browser }) => {
    const website = await browser.newContext();
    const app = await browser.newContext({ userAgent: APP_USER_AGENT });
    const emailLink = (page: Page) => page.getByRole("button", { name: "Email me a link" });

    const websitePage = await website.newPage();
    await websitePage.goto("/signin");
    const offeredOnWebsite = await emailLink(websitePage).count();

    const appPage = await app.newPage();
    await appPage.goto("/signin");
    await expect(appPage.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(await emailLink(appPage).count()).toBe(0);
    // Only meaningful where the server has an email sender configured.
    test.skip(offeredOnWebsite === 0, "emailed sign-in links are not configured on this server");
    expect(offeredOnWebsite).toBe(1);

    await website.close();
    await app.close();
  });
});
