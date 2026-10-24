/**
 * The profile changes that mail a code or act on another person's account
 * (QA package 1): changing the email with a code to the new address, the
 * email-change code field, a new email in capitals, the onboarding form with
 * a number someone else holds, and an admin releasing a claimed number.
 *
 * Local tier: brand-new accounts are created in the local database, codes are
 * read from the local mail catcher, and the admin acts on test accounts only.
 */
import { pageAs } from "../lib/actors";
import { ageCodes, auditSince, browserWithCookie, guestContext, localUser, newestSubject, otpRows, sessionUser, signInWithCode, signOutFromMenu, uniqueEmail, waitSignedOut } from "../lib/auth-helpers";
import { db } from "../lib/db";
import { call, expectStatus } from "../lib/http";
import { messagesTo, waitForCode } from "../lib/mail";
import { expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 240_000 };

async function emailOf(userId: string) {
  const [row] = await db()<{ email: string }[]>`select email from users where id = ${userId}`;
  return row.email;
}

qa("TC-AUTH-025", "change email: the code goes to the NEW address; a wrong code keeps the old email; the right one changes it, the old address is told, the new email signs in", async ({ browser }) => {
  const user = await localUser("email-old");
  const next = uniqueEmail("email-new");
  const { context, page } = await browserWithCookie(browser, user.cookie);
  try {
    await page.goto("/profile");
    const box = page.getByTestId("email-change");
    await box.getByRole("button", { name: "Change email" }).click();
    await box.getByLabel("New email address").fill(next);
    const since = Date.now();
    await box.getByRole("button", { name: "Send code" }).click();
    await expect(box).toContainText(`OTP sent to your email ${next.slice(0, 2)}***@test.local`);
    const code = await waitForCode(next, since);
    expect(newestSubject(next, since)).toBe(`${code} is your Gokesari email confirmation code`);
    expect(messagesTo(user.email, since).filter((m) => m.body.includes(code)), "nothing to the old address").toEqual([]);
    await box.getByLabel("Code").fill(code === "000000" ? "111111" : "000000");
    await box.getByRole("button", { name: "Confirm new email" }).click();
    await expect(box).toContainText("That code is wrong or has expired");
    expect(await emailOf(user.id), "wrong code: email unchanged").toBe(user.email);
    await box.getByLabel("Code").fill(code);
    await box.getByRole("button", { name: "Confirm new email" }).click();
    await expect(box).toContainText("Email updated. Use it to sign in from now on.");
    expect(await emailOf(user.id)).toBe(next);
    await expect.poll(() => messagesTo(user.email, since).some((m) => /Your Gokesari email address was changed/.test(m.body)), { message: "the old address is told", timeout: 20_000 }).toBe(true);
    const audit = (await auditSince("auth.email_changed", since)).find((r) => r.entity_id === user.id);
    expect(audit, "audited").toBeTruthy();
    await signOutFromMenu(page);
  } finally {
    await context.close();
  }
  const { context: again, page: login } = await guestContext(browser);
  try {
    await signInWithCode(login, next);
    expect((await sessionUser(again.request))?.id, "the new email signs in to the same account").toBe(user.id);
    return `code to ${next.slice(0, 2)}***@ ("NNNNNN is your Gokesari email confirmation code"); wrong code → error, email kept; right code → changed, old address mailed "was changed", audited; the new email signs in`;
  } finally {
    await again.close();
  }
}, local);

qa("TC-FLD-009", "email-change code field: blank blocked, 5 and 7 digits refused, letters dropped, a pasted code with spaces cleaned; the email changes only with the right code", async ({ browser }) => {
  const user = await localUser("emailcode");
  const next = uniqueEmail("emailcode-new");
  const { context, page } = await browserWithCookie(browser, user.cookie);
  try {
    await page.goto("/profile");
    const box = page.getByTestId("email-change");
    await box.getByRole("button", { name: "Change email" }).click();
    await box.getByLabel("New email address").fill(next);
    const since = Date.now();
    await box.getByRole("button", { name: "Send code" }).click();
    const code = await waitForCode(next, since);
    const field = box.getByLabel("Code");
    const confirm = box.getByRole("button", { name: "Confirm new email" });
    await field.fill("");
    await confirm.click();
    expect(await field.evaluate((el) => (el as HTMLInputElement).validity.valueMissing), "blank is blocked").toBe(true);
    const counted: string[] = [];
    for (const value of ["12345", "1234567"]) {
      await field.fill(value);
      await confirm.click();
      await expect(box).toContainText("That code is wrong or has expired");
      counted.push(`${value.length} digits → refused (attempts ${(await otpRows(next, "EMAIL_CHANGE"))[0].attempts})`);
      expect(await emailOf(user.id), "unchanged").toBe(user.email);
    }
    await field.fill("abcdef");
    await expect(field, "letters dropped").toHaveValue("");
    await field.fill(`  ${code}  `);
    await expect(field, "spaces removed").toHaveValue(code);
    await confirm.click();
    await expect(box).toContainText("Email updated.");
    expect(await emailOf(user.id)).toBe(next);
    return `blank blocked; ${counted.join("; ")} — short/long codes count as attempts; letters cannot be typed; "  ${code}  " cleaned and accepted; email changed only then`;
  } finally {
    await context.close();
  }
}, local);

qa("TC-FLD-008", "a valid new email in capitals with outer spaces gets its code at the trimmed, lower-case address", async () => {
  const user = await localUser("emailcaps");
  const next = uniqueEmail("emailcaps-new");
  const since = Date.now();
  const res = await call(user.ctx, "POST", "/api/profile/email", { email: `  ${next.toUpperCase()}  ` });
  expectStatus(res, 200, "send the code");
  expect(res.body.maskedEmail).toBe(`${next.slice(0, 2)}***@test.local`);
  const [row] = await otpRows(next, "EMAIL_CHANGE");
  expect(row, "code stored for the lower-case address").toBeTruthy();
  const code = await waitForCode(next, since);
  const done = await call(user.ctx, "PUT", "/api/profile/email", { email: `  ${next.toUpperCase()}  `, code });
  expectStatus(done, 200, "confirm");
  expect(await emailOf(user.id)).toBe(next);
  return `"  ${next.toUpperCase().slice(0, 18)}…  " → code to ${next}, stored as ${next}`;
}, local);

qa("TC-AUTH-020", "the first-time details form refuses a mobile that is linked to another account", async ({ browser }) => {
  const holder = await localUser("holder");
  const fresh = await localUser("fresh-onboarding", { mobile: null, profileComplete: false });
  const { context, page } = await browserWithCookie(browser, fresh.cookie);
  try {
    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "Tell us about you" })).toBeVisible();
    await page.getByLabel("Mobile number").fill(holder.mobile!);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByTestId("profile-setup")).toContainText("This mobile number is already linked to another account.");
    const [row] = await db()<{ phone_e164: string | null }[]>`select phone_e164 from users where id = ${fresh.id}`;
    expect(row.phone_e164, "nothing saved").toBeNull();
    return `onboarding with +91${holder.mobile} → "This mobile number is already linked to another account…"; nothing saved`;
  } finally {
    await context.close();
  }
}, { ...local, partial: "the My Profile and popup halves are in tests/qa/signed-in/auth-profile.spec.ts" });

qa("TC-AUTH-022", "admin releases a claimed mobile: audited; the holder no longer shows it; another account can add it", async ({ browser }) => {
  const holder = await localUser("claimed");
  const claimant = await localUser("claimant", { mobile: null });
  const mobile = need(holder.mobile, "a mobile on the holder");
  expect((await call(claimant.ctx, "PUT", "/api/me/phone", { mobile })).status, "taken before the release").toBe(409);
  const since = Date.now();
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/console/users#release-mobile");
    const section = page.locator("#release-mobile");
    await section.getByLabel("Mobile number").fill(mobile);
    await section.getByLabel("Reason").fill("QA: the claimant proved the number is theirs");
    await section.getByRole("button", { name: "Release number" }).click();
    await expect(section).toContainText(/released|Released/);
  } finally {
    await context.close();
  }
  const audit = await auditSince("auth.phone_released", since);
  expect(audit.length, "the release is audited").toBeGreaterThan(0);
  expect(audit[0].actor_id).toBe(need(world().users.admin?.id, "admin id"));
  expect((await call(holder.ctx, "GET", "/api/profile")).body.phoneE164, "the holder no longer has it").toBeNull();
  const added = await call(claimant.ctx, "PUT", "/api/me/phone", { mobile });
  expectStatus(added, 200, "the claimant adds it");
  return `released +91${mobile} from the console (audited by the admin); holder's profile shows no mobile; the claimant added it`;
}, local);

qa("TC-AUTH-045", "repeated sign-out is harmless: a double click and the sign-out address when already signed out show no error", async ({ browser }) => {
  const user = await localUser("double-out");
  const { context, page } = await guestContext(browser);
  try {
    await signInWithCode(page, user.email);
    await page.goto("/profile");
    const button = page.getByTestId("account-button").or(page.getByTestId("board-account")).or(page.getByTestId("account-dropdown")).first();
    await button.click();
    await page.getByRole("button", { name: /^Sign out$/ }).or(page.getByRole("menuitem", { name: /Sign out/ })).first().dblclick();
    await waitSignedOut(page);
    await page.waitForURL((u) => u.pathname === "/", { timeout: 30_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    await expect(page.locator("body")).not.toContainText(/Something went wrong|Application error|Internal Server Error/);
    expect(await sessionUser(context.request)).toBeNull();
    const res = await page.goto("/api/auth/signout");
    expect(res?.status() ?? 0, "the sign-out address when signed out").toBeLessThan(400);
    await expect(page.locator("body")).not.toContainText(/Something went wrong|Application error|Internal Server Error|error/i);
    const shown = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 80);
    await ageCodes(user.email);
    await signInWithCode(page, user.email);
    expect((await sessionUser(context.request))?.id, "signs in again").toBe(user.id);
    return `double-click Sign out → home, no error; /api/auth/signout signed out → ${res?.status()} "${shown}"; signed in again`;
  } finally {
    await context.close();
  }
}, { ...local, partial: "the sign-out address shows the Auth.js 'Sign out' confirmation page, not the home page; the recorded events are the next check" });

qa("TC-AUTH-045", "sign-in and sign-out are recorded with time and user for the admin's audit view", async ({ browser }) => {
  const user = await localUser("audit-inout");
  const since = Date.now();
  const { context, page } = await guestContext(browser);
  try {
    await signInWithCode(page, user.email);
    await page.goto("/profile");
    await signOutFromMenu(page);
  } finally {
    await context.close();
  }
  const signIns = (await auditSince("auth.otp_verified", since)).filter((r) => r.actor_id === user.id);
  expect(signIns.length, "sign-in recorded").toBe(1);
  const all = await db()<{ action: string }[]>`select action from audit_logs where actor_id = ${user.id} and created_at >= ${new Date(since - 2000)}`;
  const signOuts = all.filter((r) => /sign_?out|signed_out|logout|log_out|session_end/i.test(r.action));
  expect(signOuts.length, `sign-out recorded — audit rows for the user since sign-in: ${all.map((r) => r.action).join(", ")}`).toBeGreaterThan(0);
  return `sign-in (auth.otp_verified) and sign-out recorded`;
}, { ...local, partial: "read from the audit table the admin's audit view lists (/admin/console/audit-log)" });

