/**
 * Sign-in and sign-up by emailed code (QA package 1, Login & onboarding):
 * new users by mobile and by email, first-time details and address, the
 * returning user, the code rules (wrong, expired, superseded, replayed,
 * cooldown, hourly and per-IP limits), consent at sign-up, no account
 * enumeration, suspended accounts, the audit trail and the admin's OTP rules.
 *
 * Local tier: codes go to brand-new email addresses and are read from the
 * local mail catcher; codes are aged and rules changed in the local database
 * and admin settings (always restored). Each check uses its own client IP
 * (X-Forwarded-For) so only TC-AUTH-018 meets the per-IP limit.
 */
import { as } from "../lib/actors";
import {
  ageCodes,
  agreeToTerms,
  auditSince,
  CURRENT_POLICY_VERSION,
  enterCode,
  fakeIp,
  guestContext,
  keep,
  kept,
  localUser,
  newestSubject,
  openSignIn,
  otpRows,
  requestCode,
  requestCodeOnPage,
  sessionUser,
  signInWithCode,
  signOutFromMenu,
  uniqueEmail,
  uniqueMobile,
  walletOrder,
  withRule,
} from "../lib/auth-helpers";
import { db } from "../lib/db";
import { call, expectStatus, RUN } from "../lib/http";
import { messagesTo, waitForCode } from "../lib/mail";
import { blocked, expect, manual, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 240_000 };
const HOME = { latitude: 18.5164, longitude: 73.8077 };

interface Account {
  email: string;
  mobile?: string;
  id?: string;
  state?: Awaited<ReturnType<import("@playwright/test").BrowserContext["storageState"]>>;
}

const MOBILE_USER = "signin-mobile-user";
const EMAIL_USER = "signin-email-user";

function account(key: string, what: string) {
  const value = kept<Account>(key);
  if (!value) blocked(`needs ${what} from earlier in this run`);
  return value;
}

async function userRow(email: string) {
  const [row] = await db()<{ id: string; email: string; phone_e164: string | null; phone_verified_at: Date | null; name: string | null; gender: string | null; profile_completed_at: Date | null; status: string; role: string }[]>`
    select id, email, phone_e164, phone_verified_at, name, gender, profile_completed_at, status, role from users where email = ${email.toLowerCase()}`;
  return row ?? null;
}

/* ================================================================ sign-up */

qa("TC-AUTH-001", "new user by mobile: the generic code-step reply, 'Sign up with your email', masked email, code subject, details form with the mobile", async ({ browser }) => {
  const mobile = uniqueMobile();
  const email = uniqueEmail("mobile-signup");
  const { context, page } = await guestContext(browser, { geolocation: HOME, permissions: ["geolocation"] });
  try {
    await openSignIn(page);
    await agreeToTerms(page);
    await page.getByLabel("Mobile number or email").fill(mobile);
    await page.getByRole("button", { name: "Get code" }).click();
    const sentTo = page.getByTestId("otp-sent-to");
    await expect(sentTo).toContainText(`if +91 ${mobile} is registered`);
    const stepText = (await sentTo.innerText()).trim();
    await page.getByRole("button", { name: "Sign up with your email" }).click();
    await expect(page.getByText(`link +91 ${mobile} to your account`)).toBeVisible();
    await page.getByLabel("Email address").fill(email);
    const since = Date.now();
    await page.getByRole("button", { name: "Send code" }).click();
    const masked = `${email.slice(0, 2)}***@test.local`;
    await expect(sentTo).toContainText(`OTP sent to your email ${masked}`);
    const code = await waitForCode(email, since);
    expect(newestSubject(email, since), "email subject").toBe(`${code} is your Gokesari sign-in code`);
    await enterCode(page, code);
    await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Tell us about you" })).toBeVisible();
    await expect(page.getByLabel("Mobile number"), "mobile pre-filled").toHaveValue(mobile);
    const emailField = page.getByLabel("Email", { exact: true });
    await expect(emailField).toHaveValue(email);
    await expect(emailField, "email is read-only").toHaveAttribute("readonly", "");
    const row = await userRow(email);
    expect(row?.phone_e164, "the number saved exactly, in +91 form").toBe(`+91${mobile}`);
    keep(MOBILE_USER, { email, mobile, id: row?.id, state: await context.storageState() });
    return `new +91 ${mobile}: "${stepText.slice(0, 90)}…"; code to ${masked} ("${code} is your Gokesari sign-in code"); details form with mobile pre-filled, email read-only; saved as +91${mobile}`;
  } finally {
    await context.close();
  }
}, {
  ...local,
  partial:
    "step 2 no longer says 'not registered yet': the reply is the same for every number (expected result superseded by docs/login-profile/DEPLOY_AND_TEST.md 'New user via mobile' and src/components/otp-login-form.tsx) — the sign-up starts from 'Sign up with your email'",
});

qa("TC-AUTH-002", "first-time details and a geo-tagged address: home, then My Profile shows them and a zero wallet exists", async ({ browser }) => {
  const user = account(MOBILE_USER, "the account signed up in TC-AUTH-001");
  const context = await browser.newContext({ storageState: user.state, geolocation: HOME, permissions: ["geolocation"], extraHTTPHeaders: { "x-forwarded-for": fakeIp() } });
  const page = await context.newPage();
  try {
    const [wallet] = await db()<{ balance_paise: string }[]>`select w.balance_paise from wallets w join users u on u.id = w.user_id where u.email = ${user.email}`;
    expect(wallet, "a wallet was created with the account").toBeTruthy();
    expect(Number(wallet.balance_paise), "wallet balance").toBe(0);
    await page.goto("/onboarding");
    await page.getByLabel("Full name").fill(`QA Mobile ${RUN}`);
    await page.getByRole("radio", { name: "Female" }).click();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByRole("heading", { name: "Delivery address" })).toBeVisible();
    await page.getByRole("button", { name: "Use my current location" }).click();
    await expect(page.getByTestId("address-geotag")).toContainText(`${HOME.latitude.toFixed(5)}, ${HOME.longitude.toFixed(5)}`);
    await page.getByLabel("Address line 1").fill(`QA Flat 7, Karve Road ${RUN}`);
    await page.getByLabel("Area").fill("Kothrud");
    await page.getByLabel("City").fill("Pune");
    await page.getByLabel("State").fill("Maharashtra");
    await page.getByLabel("PIN code").fill("411038");
    await page.getByRole("button", { name: "Save address" }).click();
    await page.waitForURL((u) => u.pathname === "/", { timeout: 30_000 });
    await page.goto("/profile");
    await expect(page.getByTestId("profile-details-form").getByLabel("Full name")).toHaveValue(`QA Mobile ${RUN}`);
    await expect(page.getByRole("radio", { name: "Female" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("phone-link")).toContainText(`+91 ${user.mobile!.slice(0, 5)} ${user.mobile!.slice(5)}`);
    await expect(page.getByTestId("email-change")).toContainText(user.email);
    await expect(page.getByText(`Geo-tagged at ${HOME.latitude.toFixed(5)}, ${HOME.longitude.toFixed(5)}`)).toBeVisible();
    await expect(page.getByText(`QA Flat 7, Karve Road ${RUN}`)).toBeVisible();
    keep(MOBILE_USER, { ...user, state: await context.storageState() });
    return `details saved (name, Female); address geo-tagged at ${HOME.latitude}, ${HOME.longitude}; landed on home; /profile shows name, gender, mobile, email, address; wallet 0`;
  } finally {
    await context.close();
  }
}, { ...local, partial: "dragging the map pin needs a Google Maps key (not set locally): 'Use my current location' geo-tags the address" });

qa("TC-AUTH-004", "new user by email only: account and wallet, empty mobile on the details form, 'Fill in later' on the address step goes home", async ({ browser }) => {
  const email = uniqueEmail("email-signup");
  const { context, page } = await guestContext(browser);
  try {
    const signIn = await signInWithCode(page, email);
    expect(signIn.sentTo).toContain(`${email.slice(0, 2)}***@test.local`);
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByRole("heading", { name: "Tell us about you" })).toBeVisible();
    await expect(page.getByLabel("Mobile number"), "mobile field empty").toHaveValue("");
    const row = await userRow(email);
    expect(row, "account created").toBeTruthy();
    const [wallet] = await db()<{ n: number }[]>`select count(*)::int as n from wallets where user_id = ${row!.id}`;
    expect(wallet.n, "wallet created").toBe(1);
    await page.getByLabel("Full name").fill(`QA Email ${RUN}`);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByRole("heading", { name: "Delivery address" })).toBeVisible();
    await page.getByRole("button", { name: "Fill in later" }).click();
    await page.waitForURL((u) => u.pathname === "/", { timeout: 30_000 });
    const after = await userRow(email);
    expect(after?.phone_e164 ?? null, "no mobile saved").toBeNull();
    expect(after?.profile_completed_at, "details saved once").toBeTruthy();
    keep(EMAIL_USER, { email, id: row!.id, state: await context.storageState() });
    return `${email}: account + wallet, details form with empty mobile, saved without a mobile, 'Fill in later' → home`;
  } finally {
    await context.close();
  }
}, local);

qa(["TC-MKT-002", "TC-FLD-004"], "sign-up records the Terms & Privacy consent with its time and policy version", async () => {
  const people = [kept<Account>(MOBILE_USER), kept<Account>(EMAIL_USER)].filter(Boolean) as Account[];
  if (!people.length) blocked("needs the accounts signed up in TC-AUTH-001 / TC-AUTH-004");
  const seen: string[] = [];
  for (const person of people) {
    const rows = await db()<{ consent_type: string; version: string; granted: boolean; created_at: Date }[]>`
      select c.consent_type, c.version, c.granted, c.created_at from user_consents c join users u on u.id = c.user_id
      where u.email = ${person.email} and c.consent_type = 'TERMS_AND_PRIVACY'`;
    expect(rows.length, `${person.email}: one Terms consent row`).toBe(1);
    expect(rows[0].granted).toBe(true);
    expect(rows[0].version, "policy version").toBe(CURRENT_POLICY_VERSION);
    expect(Date.now() - rows[0].created_at.getTime(), "recorded at sign-up").toBeLessThan(60 * 60_000);
    seen.push(`${person.email.split("@")[0]}: v${rows[0].version} at ${rows[0].created_at.toISOString()}`);
  }
  return seen.join("; ");
}, { ...local, partial: "the page half (Get code disabled until ticked) is TC-FLD-004 in tests/qa/guest/signin-security.spec.ts" });

qa("TC-FLD-004", "a sign-up sent without the consent value is refused by the server (no code, no account)", async ({ browser }) => {
  const email = uniqueEmail("no-consent");
  const { context, page } = await guestContext(browser);
  try {
    await openSignIn(page);
    await page.getByLabel("Mobile number or email").fill(email);
    await expect(page.getByRole("button", { name: "Get code" }), "Get code with the box unticked").toBeDisabled();
    const since = Date.now();
    // What a script sends: the same request with the box left unticked (the form submitted directly).
    await page.locator('[data-testid="otp-signin"] form').evaluate((form) => (form as HTMLFormElement).requestSubmit());
    const reached = await page.getByTestId("otp-sent-to").waitFor({ timeout: 10_000 }).then(() => true, () => false);
    if (!reached) return "the code request is refused without consent";
    const code = await waitForCode(email, since);
    await enterCode(page, code);
    await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 30_000 }).catch(() => {});
    const row = await userRow(email);
    const consents = row
      ? await db()<{ consent_type: string; version: string }[]>`select consent_type, version from user_consents where user_id = ${row.id}`
      : [];
    expect(
      row,
      `with the box unticked a code was sent to ${email} and the code created account ${row?.id} (landed on ${new URL(page.url()).pathname}); ` +
        `consent rows recorded anyway: ${consents.map((c) => `${c.consent_type} v${c.version}`).join(", ") || "none"}`,
    ).toBeNull();
    return "no account without consent";
  } finally {
    await context.close();
  }
}, { ...local, partial: "the page half (Get code disabled until ticked) is in tests/qa/guest/signin-security.spec.ts" });

/* ============================================================ code rules */

const ALERT = '[data-testid="otp-signin"] [role="alert"]';

qa("TC-AUTH-012", "five wrong codes lock the code: each says 'wrong or has expired', then even the right code is refused", async ({ browser }) => {
  const email = uniqueEmail("wrong5");
  const { context, page } = await guestContext(browser);
  try {
    const step = await requestCodeOnPage(page, email);
    const code = await step.code();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 5; i++) {
      await enterCode(page, wrong);
      await expect.poll(async () => (await otpRows(email))[0]?.attempts, { message: `attempt ${i} counted` }).toBe(i);
      await expect(page.locator(ALERT)).toContainText("That code is wrong or has expired");
    }
    await enterCode(page, code);
    await expect(page.locator(ALERT)).toContainText("Too many wrong attempts. Request a new code.");
    await expect(page).toHaveURL(/\/signin/);
    expect(await sessionUser(context.request), "no session").toBeNull();
    return "5 × 'That code is wrong or has expired…'; the right code then → 'Too many wrong attempts. Request a new code.'; not signed in";
  } finally {
    await context.close();
  }
}, local);

qa("TC-AUTH-013", "an expired code is refused with the same wrong/expired message", async ({ browser }) => {
  const email = uniqueEmail("expired");
  const { context, page } = await guestContext(browser);
  try {
    const step = await requestCodeOnPage(page, email);
    const code = await step.code();
    const [row] = await otpRows(email);
    const lifetime = Math.round((row.expires_at.getTime() - row.created_at.getTime()) / 60_000);
    // Waiting out the expiry: the code's expiry is moved to the past.
    await db()`update login_otps set expires_at = now() - interval '1 second' where id = ${row.id}`;
    await enterCode(page, code);
    await expect(page.locator(ALERT)).toContainText("That code is wrong or has expired. Check the latest email or request a new code.");
    expect(await sessionUser(context.request)).toBeNull();
    return `code lives ${lifetime} min; after expiry the right code → generic wrong/expired message`;
  } finally {
    await context.close();
  }
}, { ...local, partial: "default expiry is now 5 minutes, not 10 (expected result superseded by docs/decision-log.md D-A01); the wait is simulated by moving the code's expiry into the past" });

qa("TC-AUTH-014", "a newer code supersedes the older one: the first is refused, the second signs in", async ({ browser }) => {
  const email = uniqueEmail("superseded");
  const { context, page } = await guestContext(browser);
  try {
    const step = await requestCodeOnPage(page, email);
    const first = await step.code();
    await ageCodes(email); // the minute's wait before a second code
    const since = Date.now();
    expectStatus(await requestCode({ email }), 200, "second code");
    const second = await waitForCode(email, since);
    expect(second, "a different code").not.toBe(first);
    await enterCode(page, first);
    await expect(page.locator(ALERT)).toContainText("That code is wrong or has expired");
    await enterCode(page, second);
    await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 30_000 });
    expect((await sessionUser(context.request))?.email).toBe(email);
    return "first code refused after a second was sent; the second signed in";
  } finally {
    await context.close();
  }
}, { ...local, partial: "the 60 s wait between the two codes is simulated by ageing the first code" });

qa("TC-FLD-003", "code field: blank blocked, 5 and 7 digits refused, letters cannot be typed, a pasted code with spaces is cleaned and accepted", async ({ browser }) => {
  const email = uniqueEmail("codefield");
  const { context, page } = await guestContext(browser);
  try {
    const step = await requestCodeOnPage(page, email);
    const code = await step.code();
    const field = page.getByLabel("One-time code");
    await field.fill("");
    await page.getByRole("button", { name: "Sign in" }).click();
    expect(await field.evaluate((el) => (el as HTMLInputElement).validity.valueMissing), "blank is blocked by the field").toBe(true);
    expect((await otpRows(email))[0].attempts, "blank sends nothing").toBe(0);
    const counts: string[] = [];
    for (const value of ["12345", "1234567"]) {
      await enterCode(page, value);
      await expect(page.locator(ALERT)).toContainText("That code is wrong or has expired");
      counts.push(`${value.length} digits → refused, attempts ${(await otpRows(email))[0].attempts}`);
    }
    await field.fill("abcdef");
    await expect(field, "letters are dropped as they are typed").toHaveValue("");
    await field.fill(` ${code} `);
    await expect(field, "spaces around a pasted code are removed").toHaveValue(code);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 30_000 });
    expect((await sessionUser(context.request))?.email).toBe(email);
    return `${counts.join("; ")} (short and long codes count towards the 5 attempts); letters cannot be typed; " ${code} " cleaned and accepted`;
  } finally {
    await context.close();
  }
}, local);

qa("TC-AUTH-016", "resend cooldown: Resend counts down 60 s, an immediate API request is told to wait, after the cooldown a new code arrives", async ({ browser }) => {
  const email = uniqueEmail("cooldown");
  const { context, page } = await guestContext(browser);
  try {
    const step = await requestCodeOnPage(page, email);
    const first = await step.code();
    const resend = page.getByRole("button", { name: /Resend code/ });
    await expect(resend).toBeDisabled();
    await expect(resend).toHaveText(/Resend code in (5\d|60)s/);
    const api = await requestCode({ email });
    expect(api.status, "immediate second request").toBe(429);
    const wait = Number(api.body?.error?.message?.match(/wait (\d+) seconds/)?.[1]);
    expect(wait, api.body?.error?.message).toBeGreaterThan(50);
    expect(wait).toBeLessThanOrEqual(60);
    // The documented cooldown: wait for the button to come back on its own.
    await expect(resend).toHaveText("Resend code", { timeout: 75_000 });
    await expect(resend).toBeEnabled();
    const since = Date.now();
    await resend.click();
    const second = await waitForCode(email, since);
    await enterCode(page, second);
    await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 30_000 });
    return `Resend disabled with a countdown; API at once → 429 "${api.body?.error?.message}"; after 60 s Resend sent a new code (${first} → ${second}) that signed in`;
  } finally {
    await context.close();
  }
}, { ...local, timeout: 300_000 });

qa("TC-AUTH-017", "hourly code limit: the 6th code for one email or number is refused, the same way for known and unknown ones", async () => {
  const known = await localUser("hourly-known");
  const out: string[] = [];
  for (const [label, email] of [["unknown email", uniqueEmail("hourly")], ["known email", known.email]] as const) {
    for (let i = 1; i <= 5; i++) {
      const res = await requestCode({ email });
      expectStatus(res, 200, `${label}: code ${i}`);
      await ageCodes(email); // respecting the cooldown between requests
    }
    const sixth = await requestCode({ email });
    expect(sixth.status, `${label}: 6th code`).toBe(429);
    expect(sixth.body?.error?.message).toBe("Too many codes were requested for this email. Try again later.");
    out.push(`${label}: 5 sent, 6th → 429 "${sixth.body.error.message}"`);
  }
  const numbers: string[] = [];
  for (const [label, mobile] of [["unknown number", uniqueMobile()], ["known number", known.mobile!]] as const) {
    const replies: number[] = [];
    for (let i = 1; i <= 6; i++) replies.push((await requestCode({ mobile })).status);
    const last = await requestCode({ mobile });
    expect(replies.slice(0, 5), `${label}: first five`).toEqual([200, 200, 200, 200, 200]);
    expect(replies[5], `${label}: 6th request`).toBe(429);
    numbers.push(`${label}: ${replies.join(",")} → "${last.body?.error?.message}"`);
  }
  return `${out.join("; ")}; ${numbers.join("; ")}`;
}, { ...local, partial: "the 60 s between requests is simulated by ageing each code" });

qa("TC-AUTH-018", "per-IP limit: after 20 code requests from one IP the next is refused with 429 RATE_LIMITED and retryAfterSeconds", async () => {
  const ip = fakeIp();
  const statuses: number[] = [];
  for (let i = 1; i <= 20; i++) statuses.push((await requestCode({ email: uniqueEmail(`ip${i}`) }, ip)).status);
  expect(statuses.filter((s) => s === 200).length, `first 20: ${statuses.join(",")}`).toBe(20);
  const over = await requestCode({ email: uniqueEmail("ip21") }, ip);
  expect(over.status, "21st request").toBe(429);
  expect(over.body?.error?.code).toBe("RATE_LIMITED");
  expect(over.body?.error?.details?.retryAfterSeconds, JSON.stringify(over.body)).toBeGreaterThan(0);
  const other = await requestCode({ email: uniqueEmail("ip-other") });
  expectStatus(other, 200, "another IP is not affected");
  return `20 × 200 from ${ip}; 21st → 429 ${over.body.error.code}, retryAfterSeconds ${over.body.error.details.retryAfterSeconds}; another IP still 200`;
}, local);

qa("TC-AUTH-011", "no account enumeration: registered and unregistered numbers get the same reply, screen, errors and throttle", async ({ browser }) => {
  const registered = await localUser("enum-reg");
  const unregistered = uniqueMobile();
  const shape = (body: Record<string, unknown>) => JSON.stringify(body);
  const times = { reg: [] as number[], unreg: [] as number[] };
  for (let i = 0; i < 3; i++) {
    const r = await requestCode({ mobile: registered.mobile });
    const u = await requestCode({ mobile: unregistered });
    expect([r.status, u.status]).toEqual([200, 200]);
    expect(shape(r.body), "same reply body").toBe(shape(u.body));
    times.reg.push(r.ms);
    times.unreg.push(u.ms);
  }
  const avg = (list: number[]) => Math.round(list.reduce((a, b) => a + b, 0) / list.length);
  expect(Math.abs(avg(times.reg) - avg(times.unreg)), `timing ${avg(times.reg)} vs ${avg(times.unreg)} ms`).toBeLessThan(750);
  // Errors and throttling: invalid input and the per-number limit answer alike.
  const badR = await requestCode({ mobile: `${registered.mobile}1` });
  const badU = await requestCode({ mobile: `${unregistered}1` });
  expect([badR.status, shape(badR.body)]).toEqual([badU.status, shape(badU.body)]);
  for (let i = 0; i < 3; i++) {
    await requestCode({ mobile: registered.mobile });
    await requestCode({ mobile: unregistered });
  }
  const limR = await requestCode({ mobile: registered.mobile });
  const limU = await requestCode({ mobile: unregistered });
  expect([limR.status, limR.body?.error?.message]).toEqual([limU.status, limU.body?.error?.message]);
  // The screen: identical apart from the number typed.
  const texts: string[] = [];
  for (const mobile of [uniqueMobile(), (await localUser("enum-reg-ui")).mobile!]) {
    const { context, page } = await guestContext(browser);
    try {
      const step = await requestCodeOnPage(page, mobile);
      texts.push(step.sentTo.replace(mobile, "<number>"));
    } finally {
      await context.close();
    }
  }
  expect(texts[0], "code step for an unknown vs a registered number").toBe(texts[1]);
  return `reply ${shape(await requestCode({ mobile: unregistered }).then((r) => r.body))} for both; avg ${avg(times.reg)} ms (registered) vs ${avg(times.unreg)} ms; invalid → ${badR.status} for both; throttle → ${limR.status} "${limR.body?.error?.message}" for both; the code step reads the same`;
}, { ...local, partial: "the designed 'Sign up with your email' link shows for every number (no 'not registered' message at all)" });

qa("TC-AUTH-050", "invalid numbers get no code; registered and unregistered numbers get the same reply", async () => {
  const ip = fakeIp();
  const invalid = ["5876543210", "987654321", "+1 2025550123", "+44 7911123456"];
  const answers: string[] = [];
  for (const mobile of invalid) {
    const res = await requestCode({ mobile }, ip);
    expect(res.status, `${mobile}`).toBe(422);
    answers.push(`${mobile} → 422 "${res.body?.error?.message}"`);
  }
  const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from login_otps where ip_address = ${ip}`;
  expect(n, "no code was issued for an invalid number").toBe(0);
  const known = await localUser("sms-enum");
  const a = await requestCode({ mobile: known.mobile });
  const b = await requestCode({ mobile: uniqueMobile() });
  expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  return `${answers.join("; ")}; no code stored; registered/unregistered both ${a.status} ${JSON.stringify(a.body)}`;
}, { ...local, partial: "SMS itself is not sent by this build (SMS codes are a Phase 2 stub — src/server/otp/providers.ts, docs/decision-log.md D-A02/D-F08); a handset is needed to prove no SMS goes out" });

/* ======================================================= field rules */

qa(["TC-FLD-001", "TC-AUTH-019"], "sign-in mobile: blank, wrong length, first digit, non-digits refused with no code; +91 stripped; the valid number saved exactly", async ({ browser }) => {
  const { context, page } = await guestContext(browser);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/otp/request") && r.method() === "POST") requests.push(r.postData() ?? "");
  });
  try {
    await openSignIn(page);
    await agreeToTerms(page);
    const field = page.getByLabel("Mobile number or email");
    await field.fill("");
    await page.getByRole("button", { name: "Get code" }).click();
    expect(await field.evaluate((el) => (el as HTMLInputElement).validity.valueMissing), "blank is blocked").toBe(true);
    for (const value of ["987654321", "98765432101", "5876543210", "abcdefghij", "98#765$432"]) {
      await field.fill(value);
      await page.getByRole("button", { name: "Get code" }).click();
      await expect(page.locator(ALERT), `message for "${value}"`).toContainText("Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9.");
    }
    expect(requests, "no code requested for a refused number").toEqual([]);
    const ip = fakeIp();
    const api: string[] = [];
    for (const value of ["987654321", "98765432101", "5876543210", "abcdefghij", "98#765$432"]) {
      const res = await requestCode({ mobile: value }, ip);
      expect(res.status, `API "${value}"`).toBe(422);
      api.push(`${value}→${res.status}`);
    }
    // +91 and spaces are stripped (src/lib/contact.ts parseIndianMobile); the number is then saved exactly.
    const mobile = uniqueMobile();
    const email = uniqueEmail("plus91");
    await field.fill(`+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}`);
    await page.getByRole("button", { name: "Get code" }).click();
    await expect(page.getByTestId("otp-sent-to")).toContainText(`if +91 ${mobile} is registered`);
    await page.getByRole("button", { name: "Sign up with your email" }).click();
    await page.getByLabel("Email address").fill(email);
    const since = Date.now();
    await page.getByRole("button", { name: "Send code" }).click();
    await enterCode(page, await waitForCode(email, since));
    await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
    expect((await userRow(email))?.phone_e164, "saved exactly").toBe(`+91${mobile}`);
    return `blank blocked; 9/11 digits, 5…, letters, symbols → field message, no request; API ${api.join(", ")}; "+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}" → +91 stripped, spaces removed, saved as +91${mobile}`;
  } finally {
    await context.close();
  }
}, { ...local, mobile: true, partial: "a number typed with spaces is accepted and normalised, by design (src/lib/contact.ts: accepts \"98765 43210\")" });

qa("TC-FLD-002", "sign-in email: blank and over 254 characters refused on the field, nothing sent; a valid address in capitals with outer spaces is trimmed and stored in lower case", async ({ browser }) => {
  const { context, page } = await guestContext(browser);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/otp/request") && r.method() === "POST") requests.push(r.postData() ?? "");
  });
  try {
    await openSignIn(page);
    await agreeToTerms(page);
    const field = page.getByLabel("Mobile number or email");
    await field.fill("");
    await page.getByRole("button", { name: "Get code" }).click();
    expect(await field.evaluate((el) => (el as HTMLInputElement).validity.valueMissing), "blank is blocked").toBe(true);
    for (const value of ["abc@", "@x.com", "a b@x.com", `${"a".repeat(250)}@x.com`]) {
      await field.fill(value);
      await page.getByRole("button", { name: "Get code" }).click();
      await expect(page.locator(ALERT), `message for "${value.slice(0, 20)}"`).toContainText("Enter a valid email address");
    }
    expect(requests, "nothing sent for a refused address").toEqual([]);
    const email = uniqueEmail("caps");
    await field.fill(`  ${email.toUpperCase()}  `);
    const since = Date.now();
    await page.getByRole("button", { name: "Get code" }).click();
    await expect(page.getByTestId("otp-sent-to")).toContainText(`${email.slice(0, 2)}***@test.local`);
    await enterCode(page, await waitForCode(email, since));
    await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
    const row = await userRow(email);
    expect(row?.email, "stored trimmed and in lower case").toBe(email);
    return `blank blocked; abc@, @x.com, 'a b@x.com', 256 chars → field message, no request; "  ${email.toUpperCase().slice(0, 16)}…  " stored as ${email}`;
  } finally {
    await context.close();
  }
}, { ...local, mobile: true, partial: "'abc' without @ is read as a mobile number and refused with the mobile message (one field for both)" });

/* ============================================ returning users, odd pairs */

qa("TC-AUTH-021", "an unregistered mobile with an email that belongs to another number signs in to that account and changes nothing", async ({ browser }) => {
  const owner = await localUser("other-number");
  const newMobile = uniqueMobile();
  const { context, page } = await guestContext(browser);
  try {
    const signIn = await signInWithCode(page, newMobile, { signupEmail: owner.email });
    expect(signIn.sentTo).toContain(`${owner.email.slice(0, 2)}***@test.local`);
    const who = await sessionUser(context.request);
    expect(who?.id, "signed in to the email's own account").toBe(owner.id);
    const [row] = await db()<{ phone_e164: string | null }[]>`select phone_e164 from users where id = ${owner.id}`;
    expect(row.phone_e164, "the account keeps its own mobile").toBe(`+91${owner.mobile}`);
    const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from users where phone_e164 = ${`+91${newMobile}`} or email = ${owner.email}`;
    expect(n, "no second account, the new number linked to nobody").toBe(1);
    return `+91 ${newMobile} + ${owner.email} → code to that email, signed in to it; it keeps +91${owner.mobile}; the new number was not linked; no account created`;
  } finally {
    await context.close();
  }
}, {
  ...local,
  partial:
    "no 'already registered with a different mobile' refusal: the code goes to the email and signs in to its account (expected result superseded by docs/login-profile/DEPLOY_AND_TEST.md 'Duplicate mobile or email' and the comment in src/server/otp/service.ts requestLoginOtp — refusing would reveal which numbers have accounts)",
});

qa("TC-AUTH-015", "a used code cannot be replayed after signing out", async ({ browser }) => {
  const email = uniqueEmail("replay");
  const { context, page } = await guestContext(browser);
  try {
    const first = await signInWithCode(page, email);
    await page.goto("/");
    await signOutFromMenu(page);
    expect(await sessionUser(context.request), "signed out").toBeNull();
    // Back on the code step without asking for a new code, so only the used one is in play.
    await page.route("**/api/otp/request", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "SENT", maskedEmail: `${email.slice(0, 2)}***@test.local`, resendAfterSeconds: 60, expiryMinutes: 5 }) }),
    );
    await requestCodeOnPage(page, email);
    await page.unroute("**/api/otp/request");
    await enterCode(page, first.code);
    await expect(page.locator(ALERT)).toContainText("That code is wrong or has expired");
    expect(await sessionUser(context.request), "no session from the replayed code").toBeNull();
    const [row] = await otpRows(email);
    expect(row.consumed_at, "the code is marked used").toBeTruthy();
    return `signed in with ${first.code}, signed out; the same code → "That code is wrong or has expired…"; no session`;
  } finally {
    await context.close();
  }
}, local);

qa("TC-AUTH-003", "returning user by mobile: the code goes to the account's email (not shown), then home with no onboarding form", async ({ browser }) => {
  const user = account(MOBILE_USER, "the account from TC-AUTH-001/002");
  await ageCodes(user.email); // a later visit, past the resend cooldown
  const { context, page } = await guestContext(browser);
  try {
    const signIn = await signInWithCode(page, user.mobile!, { codeEmail: user.email });
    expect(signIn.sentTo, "the code step").toContain(`if +91 ${user.mobile} is registered, the code went to the email address on that account`);
    expect(signIn.sentTo, "the address is not shown").not.toContain("***@");
    await expect(page).toHaveURL((u) => u.pathname === "/");
    await expect(page.getByRole("heading", { name: "Tell us about you" })).toHaveCount(0);
    return `+91 ${user.mobile} → code mailed to the account's email (step: "${signIn.sentTo.slice(0, 80)}…") → home, no form`;
  } finally {
    await context.close();
  }
}, { ...local, partial: "the account email is no longer shown masked for a mobile sign-in (expected result superseded by docs/login-profile/DEPLOY_AND_TEST.md 'Returning user via mobile': no address shown)" });

qa("TC-AUTH-005", "'Add your mobile number' after each sign-in of an email-only account until a number is added", async ({ browser }) => {
  const user = account(EMAIL_USER, "the email-only account from TC-AUTH-004");
  const dialog = (page: import("@playwright/test").Page) => page.getByRole("dialog", { name: "Add your mobile number" });
  const seen: string[] = [];
  for (const round of ["not now", "add", "after"] as const) {
    await ageCodes(user.email);
    const { context, page } = await guestContext(browser);
    try {
      await signInWithCode(page, user.email);
      if (round === "after") {
        await expect(page).toHaveURL((u) => u.pathname === "/");
        await expect(dialog(page)).toHaveCount(0);
        seen.push("after adding: no popup");
        continue;
      }
      await expect(dialog(page), `popup on sign-in (${round})`).toBeVisible();
      if (round === "not now") {
        await dialog(page).getByRole("button", { name: "Not now" }).click();
        await page.waitForURL((u) => u.pathname === "/");
        seen.push("popup → Not now → home");
      } else {
        const mobile = uniqueMobile();
        await dialog(page).getByLabel("Mobile number").fill(mobile);
        await dialog(page).getByRole("button", { name: "Save" }).click();
        await page.waitForURL((u) => u.pathname === "/");
        expect((await userRow(user.email))?.phone_e164).toBe(`+91${mobile}`);
        seen.push(`popup again → added ${mobile}`);
      }
    } finally {
      await context.close();
    }
  }
  return seen.join("; ");
}, { ...local, timeout: 300_000, partial: "the minute between sign-ins is simulated by ageing the codes" });

qa("TC-AUTH-007", "skip onboarding: home and wallet work; the cart asks for a mobile and an address instead of Pay; with both the order carries the address; unsaved details come back at the next sign-in", async ({ browser }) => {
  const email = uniqueEmail("skip");
  const { context, page } = await guestContext(browser);
  const listing = need(world().listings.packaged, "shop A's packaged listing");
  try {
    await signInWithCode(page, email);
    await expect(page.getByRole("heading", { name: "Tell us about you" })).toBeVisible();
    await page.getByRole("button", { name: "Fill in later" }).click();
    await page.waitForURL((u) => u.pathname === "/");
    const row = await userRow(email);
    // A top-up as the payment gateway would settle it.
    const { fundWallet } = await import("../lib/auth-helpers");
    await fundWallet(row!.id, 50_000);
    const wallet = await call(context.request, "GET", "/api/wallet");
    expectStatus(wallet, 200, "wallet");
    expect(wallet.body.wallet.balancePaise).toBe(50_000);
    expectStatus(await call(context.request, "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 1 }), [200, 201], "add to cart");
    await page.goto("/cart");
    const missing = page.getByTestId("checkout-missing-details");
    await expect(missing).toContainText("Add your mobile number before ordering");
    await expect(missing).toContainText("Add a delivery address before ordering");
    await expect(page.getByRole("button", { name: "Pay from wallet" })).toHaveCount(0);
    const mobile = uniqueMobile();
    expectStatus(await call(context.request, "PUT", "/api/me/phone", { mobile }), 200, "add mobile");
    const line1 = `QA Skip Flat ${RUN}`;
    expectStatus(
      await call(context.request, "POST", "/api/addresses", { line1, area: "Kothrud", city: "Pune", state: "Maharashtra", pincode: "411038", latitude: 18.5164, longitude: 73.8077, addressType: "HOME", isDefault: true }),
      [200, 201],
      "add address",
    );
    await page.reload();
    const pay = page.getByRole("button", { name: "Pay from wallet" });
    await expect(pay).toBeVisible();
    await pay.click();
    await page.waitForURL(/\/orders/, { timeout: 60_000 });
    const [order] = await db()<{ id: string; line1: string | null }[]>`select id, delivery_address_snapshot->>'line1' as line1 from orders where user_id = ${row!.id} order by created_at desc limit 1`;
    expect(order?.line1, "the order carries the address").toBe(line1);
    // Next sign-in before the details were ever saved: the form is back.
    await signOutFromMenu(page);
    await ageCodes(email);
    await signInWithCode(page, email);
    await expect(page.getByRole("heading", { name: "Tell us about you" })).toBeVisible();
    await call(context.request, "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA cleanup" });
    return `Fill in later → home; wallet ₹500; cart showed both prompts and no Pay; after adding mobile + address Pay placed the order to "${line1}"; next sign-in → details form again`;
  } finally {
    await context.close();
  }
}, { ...local, partial: "the wallet top-up is settled in the database (a gateway payment is not available on a local production build); top-ups are covered by the wallet specs" });

qa("TC-AUTH-006", "an account from before the details form is asked for its details once and keeps its wallet and orders", async ({ browser }) => {
  const user = await localUser("prerelease", { walletPaise: 100_000, address: true });
  const listing = need(world().listings.packaged, "shop A's packaged listing");
  const order = await walletOrder(user.ctx, listing.shopProductId, need(world().shops.A?.id, "shop A"), user.addressId);
  const before = (await call(user.ctx, "GET", "/api/wallet")).body.wallet.balancePaise;
  // As accounts were before migration 0037: no details saved.
  await db()`update users set name = null, profile_completed_at = null where id = ${user.id}`;
  const { context, page } = await guestContext(browser);
  try {
    await signInWithCode(page, user.email);
    await expect(page.getByRole("heading", { name: "Tell us about you" })).toBeVisible();
    const wallet = await call(context.request, "GET", "/api/wallet");
    expect(wallet.body.wallet.balancePaise, "wallet unchanged").toBe(before);
    const orders = await call(context.request, "GET", "/api/orders");
    expect(JSON.stringify(orders.body), "order history unchanged").toContain(order.orderNumber);
    await page.getByLabel("Full name").fill(`QA Pre ${RUN}`);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.waitForURL((u) => u.pathname === "/");
    await call(user.ctx, "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA cleanup" });
    return `details form shown; wallet ${before} paise and order ${order.orderNumber} unchanged; saved once → home`;
  } finally {
    await context.close();
  }
}, { ...local, partial: "signed in by emailed code; the magic link is TC-AUTH-009, Google needs a Google account (TC-AUTH-008)" });

qa("TC-AUTH-009", "email magic link signs in; the link cannot be used again after signing out", async ({ browser }) => {
  const user = await localUser("magic");
  const { context, page } = await guestContext(browser);
  try {
    await openSignIn(page);
    await agreeToTerms(page);
    const since = Date.now();
    await page.getByLabel("Or get a sign-in link by email").fill(user.email);
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect(page.getByTestId("check-email")).toBeVisible({ timeout: 30_000 });
    let link: string | null = null;
    for (let i = 0; i < 40 && !link; i++) {
      link = messagesTo(user.email, since).map((m) => m.body.match(/https?:\/\/[^\s"<>]+\/api\/auth\/callback\/email[^\s"<>]+/)?.[0]).find(Boolean) ?? null;
      if (!link) await page.waitForTimeout(500);
    }
    if (!link) blocked("no sign-in link reached the local mail catcher");
    const url = link.replace(/&amp;/g, "&");
    await page.goto(url);
    await page.waitForLoadState("networkidle").catch(() => {});
    expect((await sessionUser(context.request))?.id, "signed in by the link").toBe(user.id);
    await page.goto("/profile");
    await signOutFromMenu(page);
    expect(await sessionUser(context.request)).toBeNull();
    await page.goto(url);
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(await sessionUser(context.request), "the used link does not sign in again").toBeNull();
    return `link mailed and signed in; after signing out the same link → ${new URL(page.url()).pathname}${new URL(page.url()).search}, not signed in`;
  } finally {
    await context.close();
  }
}, local);

/* ====================================================== blocked accounts */

qa("TC-AUTH-027", "a suspended account gets no sign-in code by email or mobile, its open session stops working, and the sign-in page's AccessDenied notice explains it with the grievance link", async ({ browser }) => {
  const user = await localUser("suspended");
  const admin = await as("admin");
  expectStatus(await call(admin, "POST", `/api/users/${user.id}/suspend`, { reason: "QA suspended-account check" }), 200, "admin suspends");
  const since = Date.now();
  const byEmail = await requestCode({ email: user.email });
  const byMobile = await requestCode({ mobile: user.mobile });
  expect([byEmail.status, byMobile.status], "same replies as any account").toEqual([200, 200]);
  await new Promise((r) => setTimeout(r, 4000));
  const codes = messagesTo(user.email, since).filter((m) => /is your Gokesari sign-in code/.test(m.body));
  expect(codes.length, "no sign-in code mailed").toBe(0);
  const blockedRows = await auditSince("auth.otp_blocked", since);
  expect(blockedRows.filter((r) => r.new_value?.reason === "account_blocked").length, "attempts audited as blocked").toBeGreaterThanOrEqual(2);
  expect(await call(user.ctx, "GET", "/api/wallet").then((r) => r.status), "the existing session stops working").toBe(401);
  const { context, page } = await guestContext(browser);
  try {
    await page.goto("/signin?error=AccessDenied");
    const notice = page.getByTestId("signin-access-denied");
    await expect(notice).toContainText("This account is suspended or closed, so it cannot sign in.");
    await expect(notice.getByRole("link", { name: "contact us through the grievance form" })).toHaveAttribute("href", "/grievance");
    return "email and mobile code requests → 200 but no code (audited account_blocked); the old session → 401; /signin?error=AccessDenied shows the suspended notice with the grievance link";
  } finally {
    await context.close();
  }
}, { ...local, partial: "Google sign-in is not configured on the local server (needs a Google account and OAuth keys); the emailed link is the next check" });

qa("TC-AUTH-027", "the emailed sign-in link asked for a suspended account lands on the suspended notice (/signin?error=AccessDenied), not an error page, and opens no session", async ({ browser }) => {
  const user = await localUser("suspended-link");
  expectStatus(await call(await as("admin"), "POST", `/api/users/${user.id}/suspend`, { reason: "QA suspended-account link check" }), 200, "admin suspends");
  const { context, page } = await guestContext(browser);
  try {
    await openSignIn(page);
    await agreeToTerms(page);
    await page.getByLabel("Or get a sign-in link by email").fill(user.email);
    await page.getByRole("button", { name: "Email me a link" }).click();
    await page.waitForURL(/error=AccessDenied/, { timeout: 15_000 }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(await sessionUser(context.request), "no session").toBeNull();
    const errorPage = await page.getByText("Something went wrong on our side").isVisible().catch(() => false);
    const ref = errorPage ? ((await page.getByText(/^Ref: /).innerText().catch(() => "")) || "") : "";
    expect(
      page.url(),
      errorPage
        ? `"Email me a link" for the suspended account showed the error page "Something went wrong on our side" (${ref}) at ${page.url().replace(/^https?:\/\/[^/]+/, "")} instead of the suspended notice; the server logged AccessDenied thrown by the link form's signIn (src/app/signin/page.tsx)`
        : `landed on ${page.url()}`,
    ).toMatch(/error=AccessDenied/);
    await expect(page.getByTestId("signin-access-denied")).toBeVisible();
    return "link request refused → /signin?error=AccessDenied with the notice; no session";
  } finally {
    await context.close();
  }
}, local);

/* ========================================================= audit trail */

qa(["TC-AUTH-028", "TC-AUTH-052"], "OTP events are audited with masked identifiers; codes never appear in responses, the audit log or the database", async ({ browser }) => {
  const since = Date.now();
  const user = await localUser("audit");
  const { context, page } = await guestContext(browser);
  try {
    const step = await requestCodeOnPage(page, user.mobile!, { codeEmail: user.email });
    const code = await step.code();
    await enterCode(page, code === "000000" ? "111111" : "000000");
    await expect(page.locator(ALERT)).toContainText("That code is wrong or has expired");
    const again = await requestCode({ email: user.email });
    expect(again.status, "cooldown → blocked").toBe(429);
    expect(again.text, "no code in a reply").not.toContain(code);
    await enterCode(page, code);
    await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
    const fresh = await requestCode({ email: uniqueEmail("audit-reply") });
    expect(fresh.text).not.toMatch(/\b\d{6}\b/);
    const [row] = await otpRows(user.email);
    expect(row.code_hash, "salt:hex").toMatch(/^[0-9a-f]{16}:[0-9a-f]{64}$/);
    expect(row.code_hash).not.toContain(code);
    const rows = [];
    for (const action of ["auth.otp_requested", "auth.otp_verified", "auth.otp_failed", "auth.otp_blocked"]) {
      const found = (await auditSince(action, since)).filter((r) => String(r.new_value?.email ?? "").startsWith(user.email.slice(0, 2)));
      expect(found.length, `${action} recorded`).toBeGreaterThan(0);
      rows.push(...found);
    }
    for (const r of rows) {
      const text = JSON.stringify(r.new_value);
      expect(text, "email masked").not.toContain(user.email);
      expect(text, "email masked").toContain("***@");
      expect(text, "no code").not.toContain(code);
      if (r.new_value?.phone) expect(String(r.new_value.phone), "number masked").toMatch(/^\+91 \*+\d{4}$/);
    }
    const { pageAs } = await import("../lib/actors");
    const adminPage = await pageAs(browser, "admin");
    try {
      await adminPage.page.goto("/admin/console/audit-log");
      await expect(adminPage.page.getByText("auth.otp_verified").first()).toBeVisible();
      expect(await adminPage.page.content(), "no code on the audit page").not.toContain(code);
    } finally {
      await adminPage.context.close();
    }
    return `requested/verified/failed/blocked rows with ${String(rows[0].new_value?.email)} and ${String(rows.find((r) => r.new_value?.phone)?.new_value?.phone ?? "—")}; code_hash ${row.code_hash.slice(0, 20)}…; no code in replies, audit rows or the admin audit page`;
  } finally {
    await context.close();
  }
}, { ...local, partial: "the admin audit page lists the latest 100 events and has no search box; SMS text, sender and template need an SMS vendor (Phase 2 — TC-AUTH-052's SMS half)" });

qa("TC-AUTH-029", "OTP limits follow /admin/settings: expiry 1 min, 2 attempts, 5 s cooldown apply at once; restoring the default reverts them", async ({ browser }) => {
  const email = uniqueEmail("rules");
  const seen: string[] = [];
  await withRule("otp", { expiryMinutes: 1, maxAttempts: 2, resendCooldownSeconds: 5 }, async () => {
    const { context, page } = await guestContext(browser);
    try {
      const step = await requestCodeOnPage(page, email);
      const code = await step.code();
      const [row] = await otpRows(email);
      expect(row.max_attempts, "attempts").toBe(2);
      expect(Math.round((row.expires_at.getTime() - row.created_at.getTime()) / 1000), "expiry").toBe(60);
      await expect(page.getByRole("button", { name: /Resend code/ })).toHaveText(/Resend code in [1-5]s/);
      const quick = await requestCode({ email });
      expect(quick.status).toBe(429);
      expect(Number(quick.body?.error?.message?.match(/wait (\d+) seconds/)?.[1])).toBeLessThanOrEqual(5);
      for (let i = 0; i < 2; i++) {
        await enterCode(page, code === "000000" ? "111111" : "000000");
        await expect.poll(async () => (await otpRows(email))[0].attempts).toBe(i + 1);
      }
      await enterCode(page, code);
      await expect(page.locator(ALERT)).toContainText("Too many wrong attempts");
      await new Promise((r) => setTimeout(r, 5500));
      const later = await requestCode({ email });
      expectStatus(later, 200, "after the 5 s cooldown");
      expect(later.body).toMatchObject({ resendAfterSeconds: 5, expiryMinutes: 1 });
      seen.push(`set: code lives 60 s, 2 attempts then 'Too many wrong attempts', cooldown ≤ 5 s ("${quick.body.error.message}"), a new code after 5.5 s`);
    } finally {
      await context.close();
    }
  });
  const back = await requestCode({ email: uniqueEmail("rules-back") });
  expect(back.body, "defaults again").toMatchObject({ resendAfterSeconds: 60, expiryMinutes: 5 });
  seen.push(`restored: resend 60 s, expiry 5 min`);
  return seen.join("; ");
}, { ...local, partial: "the rule is set through the admin settings API (PUT/DELETE /api/admin/settings, the endpoint the /admin/settings form uses); the 1-minute expiry is read from the stored code rather than waited out" });

/* ============================================== SMS and the channel step */

qa(["TC-AUTH-010", "TC-AUTH-047"], "a registered mobile's code goes to the account's email (no SMS choice while SMS is off); an email sign-in shows the masked address", async ({ browser }) => {
  const user = await localUser("channel");
  const out: string[] = [];
  for (const identifier of [user.mobile!, user.email]) {
    await ageCodes(user.email);
    const { context, page } = await guestContext(browser);
    try {
      const step = await requestCodeOnPage(page, identifier, { codeEmail: user.email });
      await expect(page.getByRole("radio", { name: /SMS/i }).or(page.getByRole("button", { name: /SMS/i }))).toHaveCount(0);
      if (identifier === user.email) expect(step.sentTo).toContain(`${user.email.slice(0, 2)}***@test.local`);
      else expect(step.sentTo).toContain("the code went to the email address on that account");
      await enterCode(page, await step.code());
      await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
      expect((await sessionUser(context.request))?.id).toBe(user.id);
      out.push(`${identifier === user.email ? "email" : "mobile"}: code by email, signed in`);
    } finally {
      await context.close();
    }
  }
  return out.join("; ");
}, {
  ...local,
  partial:
    "SMS codes are a Phase 2 stub with no vendor (src/server/otp/providers.ts; docs/decision-log.md D-A02, D-F08), so no SMS option is offered and the SMS half needs a vendor and a handset",
});

qa("TC-AUTH-051", "SMS unavailable for a mobile-only account: the failure is recorded and the code withdrawn; the reply stays the generic one", async ({ browser }) => {
  const user = await localUser("sms-down", { placeholderEmail: true });
  const since = Date.now();
  const res = await requestCode({ mobile: user.mobile });
  expectStatus(res, 200, "mobile code request");
  expect(res.body.status).toBe("SENT_IF_REGISTERED");
  await expect.poll(async () => (await otpRows(user.email))[0]?.superseded_at ?? null, { message: "the unsent code is withdrawn", timeout: 15_000 }).not.toBeNull();
  const [row] = await otpRows(user.email);
  expect(row.channel).toBe("SMS");
  const failed = (await auditSince("auth.otp_failed", since)).filter((r) => r.new_value?.otpId === row.id);
  expect(failed[0]?.new_value?.reason, "failure recorded").toBe("delivery_failed");
  const { context, page } = await guestContext(browser);
  try {
    const step = await requestCodeOnPage(page, user.mobile!, { codeEmail: user.email });
    await expect(page.getByRole("button", { name: "Sign up with your email" })).toBeVisible();
    return `reply ${JSON.stringify(res.body)}; SMS code ${row.id} withdrawn, audited auth.otp_failed delivery_failed; the page says: "${step.sentTo.slice(0, 120)}…" and offers email sign-up`;
  } finally {
    await context.close();
  }
}, {
  ...local,
  partial:
    "telling the person that the SMS failed is not done: a mobile request always gets the same reply so it cannot reveal which numbers have accounts (expected result superseded by src/server/otp/service.ts requestLoginOtp and docs/login-profile/DEPLOY_AND_TEST.md); the generic text still mentions SMS as a possible channel",
});

manual("TC-AUTH-008", "Google sign-in still works", "needs a Google account and Google OAuth keys (AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET are not set on the local server, whose sign-in page says 'Google sign-in is not configured'); run by hand on test.gokesari.com", { tier: "local" });
manual("TC-AUTH-046", "new mobile sign-up gets the code by SMS", "needs an SMS vendor in test mode and a real handset: SMS codes are a Phase 2 stub on this build (src/server/otp/providers.ts SmsOtpProvider; docs/decision-log.md D-A02, D-F08) and new mobiles sign up through email", { tier: "local" });
manual("TC-AUTH-048", "wrong, expired and superseded SMS codes", "needs an SMS vendor and a handset to read SMS codes; the same rules for emailed codes are TC-AUTH-012/013/014/029", { tier: "local" });
manual("TC-AUTH-049", "SMS resend cooldown and hourly limit", "needs an SMS vendor and a handset (no SMS cost can be observed without one); the same limits for emailed codes are TC-AUTH-016/017", { tier: "local" });
manual("TC-AUTH-053", "mobile change proven by an SMS code to the new number", "needs an SMS vendor and a handset; on this build a profile mobile is saved unverified by design (docs/login-profile/DEPLOY_AND_TEST.md: 'Numbers are not SMS-verified'; src/server/otp/service.ts linkPhone) and an admin can release a wrongly claimed number (TC-AUTH-022)", { tier: "local" });
