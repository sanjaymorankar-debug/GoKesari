/**
 * My Profile as the signed-in customer (QA package 1): name and gender, the
 * mobile number (add, change, remove, already-linked), a new email that is
 * refused, the marketing-consent switch and the notification preferences —
 * with the field rules of TC-FLD-005..008 and TC-FLD-124.
 *
 * Signed-in tier: the test accounts change only their own details and every
 * check puts them back (name, gender, mobile, consent, preferences) in a
 * finally block. Nothing is mailed: a new email is only ever refused here
 * (the code-sending halves are in tests/qa/local/auth-profile.spec.ts).
 */
import type { Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { fakeIp, uniqueMobile } from "../lib/auth-helpers";
import { db } from "../lib/db";
import { addToCart, emptyCart, sellable } from "../lib/flows";
import { call, expectStatus, RUN } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { IS_LOCAL } from "../lib/target";
import { world, type Role } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 180_000 };

interface Profile {
  name: string | null;
  gender: string | null;
  phoneE164: string | null;
  email: string;
}

async function profileOf(role: Role): Promise<Profile> {
  const res = await call(await as(role), "GET", "/api/profile");
  expectStatus(res, 200, "GET /api/profile");
  return res.body as Profile;
}

async function restoreDetails(role: Role, original: Profile) {
  await call(await as(role), "PATCH", "/api/profile", { name: original.name, gender: original.gender });
}

async function restoreMobile(role: Role, original: Profile) {
  const ctx = await as(role);
  if (original.phoneE164) await call(ctx, "PUT", "/api/me/phone", { mobile: original.phoneE164.slice(3) });
  else await call(ctx, "DELETE", "/api/me/phone");
}

/** The first letter shown on whichever account button the page's header has. */
async function headerInitial(page: Page) {
  for (const id of ["account-button", "board-account", "account-dropdown", "seller-account-button"]) {
    const button = page.getByTestId(id).first();
    if (await button.isVisible().catch(() => false)) return (await button.innerText()).trim().charAt(0);
  }
  return null;
}

const details = (page: Page) => page.getByTestId("profile-details-form");

/* ============================================================ details */

qa("TC-AUTH-023", "My Profile: change name and gender → 'Saved.', the header initial follows, the values persist after reload", async ({ browser }) => {
  const original = await profileOf("customer");
  const { context, page } = await pageAs(browser, "customer");
  const name = `Zara QA ${RUN}`;
  try {
    await page.goto("/profile");
    await details(page).getByLabel("Full name").fill(name);
    const target = original.gender === "MALE" ? "Female" : "Male";
    await details(page).getByRole("radio", { name: target, exact: true }).click();
    await details(page).getByRole("button", { name: "Save details" }).click();
    await expect(details(page).getByText("Saved.")).toBeVisible();
    await expect.poll(() => headerInitial(page), { message: "header initial" }).toBe("Z");
    await page.reload();
    await expect(details(page).getByLabel("Full name")).toHaveValue(name);
    await expect(details(page).getByRole("radio", { name: target, exact: true })).toHaveAttribute("aria-checked", "true");
    const saved = await profileOf("customer");
    expect([saved.name, saved.gender]).toEqual([name, target.toUpperCase()]);
    return `name → "${name}", gender → ${target}; 'Saved.'; header initial Z; both kept after reload`;
  } finally {
    await context.close();
    await restoreDetails("customer", original);
  }
}, { ...signed, mobile: true });

qa("TC-FLD-005", "profile name: limit 100 (longer refused, never a 500), script text shown as text, Hindi/Marathi kept, outer spaces trimmed, the header initial follows", async ({ browser }) => {
  const original = await profileOf("customer");
  const ctx = await as("customer");
  const out: string[] = [];
  try {
    for (const [value, expected] of [["", null], ["   ", null], ["A", "A"], ["  QA Trim  ", "QA Trim"]] as const) {
      const res = await call(ctx, "PATCH", "/api/profile", { name: value });
      expectStatus(res, 200, `name ${JSON.stringify(value)}`);
      expect(res.body.name, `stored for ${JSON.stringify(value)}`).toBe(expected);
    }
    out.push("blank/spaces → no name (optional), 'A' kept, outer spaces trimmed");
    const long = await call(ctx, "PATCH", "/api/profile", { name: "x".repeat(300) });
    expect(long.status, "300 characters").toBe(422);
    const at = await call(ctx, "PATCH", "/api/profile", { name: "y".repeat(100) });
    expectStatus(at, 200, "100 characters");
    out.push("300 chars → 422, 100 chars → saved (limit 100)");
    const { context, page } = await pageAs(browser, "customer");
    let alerted = false;
    page.on("dialog", async (d) => {
      alerted = true;
      await d.dismiss();
    });
    try {
      await page.goto("/profile");
      const field = details(page).getByLabel("Full name");
      await field.fill("z".repeat(300));
      expect((await field.inputValue()).length, "the field stops at 100").toBe(100);
      const script = `<script>alert(1)</script> & <b>QA</b>`;
      await field.fill(script);
      await details(page).getByRole("button", { name: "Save details" }).click();
      await expect(details(page).getByText("Saved.")).toBeVisible();
      await page.reload();
      await expect(page.getByText(script, { exact: true }).first(), "shown as plain text").toBeVisible();
      expect(alerted, "the script did not run").toBe(false);
      const hindi = "सीमा पाटील";
      await details(page).getByLabel("Full name").fill(hindi);
      await details(page).getByRole("button", { name: "Save details" }).click();
      await expect(details(page).getByText("Saved.")).toBeVisible();
      await page.reload();
      await expect(details(page).getByLabel("Full name")).toHaveValue(hindi);
      await expect.poll(() => headerInitial(page), { message: "header initial" }).toBe("स");
      out.push(`script stored and shown as text, no alert; "${hindi}" kept, header initial स`);
    } finally {
      await context.close();
    }
    return out.join("; ");
  } finally {
    await restoreDetails("customer", original);
  }
}, {
  ...signed,
  partial:
    "blank and spaces-only names are accepted and clear the name: every profile field is optional (expected result superseded by docs/login-profile/DEPLOY_AND_TEST.md 'Everything optional'; src/server/services/profile.ts updateProfile)",
});

qa("TC-FLD-006", "profile gender: each option saves and shows after reload; an unlisted value is refused (422)", async ({ browser }) => {
  const original = await profileOf("customer");
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/profile");
    const seen: string[] = [];
    for (const [label, value] of [["Female", "FEMALE"], ["Male", "MALE"], ["Other", "OTHER"], ["Prefer not to say", null]] as const) {
      await details(page).getByRole("radio", { name: label, exact: true }).click();
      await details(page).getByRole("button", { name: "Save details" }).click();
      await expect(details(page).getByText("Saved.")).toBeVisible();
      await page.reload();
      await expect(details(page).getByRole("radio", { name: label, exact: true })).toHaveAttribute("aria-checked", "true");
      expect((await profileOf("customer")).gender).toBe(value);
      seen.push(`${label}→${value ?? "none"}`);
    }
    const ctx = await as("customer");
    const bad = await call(ctx, "PATCH", "/api/profile", { gender: "UNKNOWN" });
    expect(bad.status, "unlisted gender").toBe(422);
    const empty = await call(ctx, "PATCH", "/api/profile", { gender: "" });
    expect(empty.status, "empty string gender").toBe(422);
    return `${seen.join(", ")}; "UNKNOWN" → 422, "" → 422`;
  } finally {
    await context.close();
    await restoreDetails("customer", original);
  }
}, {
  ...signed,
  partial: "'nothing chosen' is the 'Prefer not to say' choice and is accepted, by design (expected result superseded by docs/login-profile/DEPLOY_AND_TEST.md: every detail optional)",
});

/* ============================================================ mobile */

qa("TC-AUTH-024", "change the mobile, then remove it: the new number shows, then 'Not added'; the cart asks for a mobile again; a 'Mobile number changed' notice is sent", async ({ browser }) => {
  const original = await profileOf("customer");
  if (!original.phoneE164) blocked("the customer account has no mobile to change");
  const { context, page } = await pageAs(browser, "customer");
  const mobile = uniqueMobile();
  try {
    const before = Date.now();
    await page.goto("/profile");
    const phone = page.getByTestId("phone-link");
    await phone.getByRole("button", { name: "Change" }).click();
    await phone.getByLabel("Mobile number").fill(mobile);
    await phone.getByRole("button", { name: "Save" }).click();
    await expect(phone).toContainText(`Mobile: +91 ${mobile.slice(0, 5)} ${mobile.slice(5)}`);
    const notes = await call(await as("customer"), "GET", "/api/notifications");
    const changed = (notes.body.notifications as { title: string; createdAt: string }[]).find((n) => n.title === "Mobile number changed" && new Date(n.createdAt).getTime() >= before - 5000);
    expect(changed, "security notice 'Mobile number changed'").toBeTruthy();
    await phone.getByRole("button", { name: "Remove" }).click();
    await expect(phone).toContainText("Mobile: Not added");
    const listing = await sellable("A");
    await emptyCart();
    expectStatus(await addToCart("customer", listing.shopProductId, 1), [200, 201], "add a delivery item");
    await page.goto("/cart");
    await expect(page.getByTestId("checkout-missing-details")).toContainText("Add your mobile number before ordering");
    return `changed to +91 ${mobile} (shown; 'Mobile number changed' notice); removed → 'Not added'; the cart asks for a mobile again`;
  } finally {
    await context.close();
    await restoreMobile("customer", original);
    await emptyCart().catch(() => {});
  }
}, { ...signed, partial: "the notice is checked in-app; its email copy follows the customer's notification settings (notification specs)" });

qa(["TC-AUTH-020", "TC-AUTH-054"], "a mobile linked to another account is refused from My Profile, the popup and the API, without saying whose it is; the other account keeps it", async ({ browser }) => {
  const owner = await profileOf("customer");
  const taken = need(owner.phoneE164, "a mobile on the customer account").slice(3);
  const other = await profileOf("customer2");
  if (other.phoneE164) blocked("customer 2 must have no mobile for the popup half");
  const MESSAGE = "This mobile number is already linked to another account.";
  const out: string[] = [];
  const { context, page } = await pageAs(browser, "customer2");
  try {
    await page.goto("/profile");
    const phone = page.getByTestId("phone-link");
    await phone.getByLabel("Mobile number").fill(taken);
    await phone.getByRole("button", { name: "Add" }).click();
    await expect(phone).toContainText(MESSAGE);
    out.push("My Profile refused");
    await page.goto("/onboarding");
    const dialog = page.getByRole("dialog", { name: "Add your mobile number" });
    await expect(dialog, "customer 2 (details saved, no mobile) gets the popup").toBeVisible();
    await dialog.getByLabel("Mobile number").fill(taken);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toContainText(MESSAGE);
    out.push("popup refused");
    const ctx = await as("customer2");
    for (const [method, path, body] of [["PUT", "/api/me/phone", { mobile: taken }], ["PATCH", "/api/profile", { mobile: taken }]] as const) {
      const res = await call(ctx, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(res.body.error.message).toContain(MESSAGE);
      for (const leak of [owner.email, owner.name ?? "\u0000"]) expect(res.text, "says nothing about the other account").not.toContain(leak);
      out.push(`${method} ${path} → 409`);
    }
    expect((await profileOf("customer2")).phoneE164, "nothing saved").toBeNull();
    expect((await profileOf("customer")).phoneE164, "the owner keeps the number").toBe(owner.phoneE164);
    return `${out.join("; ")} — "${MESSAGE}…"; customer 1 keeps +91${taken}`;
  } finally {
    await context.close();
  }
}, {
  ...signed,
  partial:
    "the onboarding-form half (first-time details) is in tests/qa/local/auth-profile.spec.ts; TC-AUTH-054: a free number is saved without an SMS code by design (numbers are not SMS-verified — docs/login-profile/DEPLOY_AND_TEST.md), so only a number already linked elsewhere is protected",
});

qa("TC-FLD-007", "profile mobile: wrong length, first digit and non-digits refused with a message and nothing saved; +91 and spaces stripped; the valid number saved exactly", async ({ browser }) => {
  const original = await profileOf("customer2");
  if (original.phoneE164) blocked("customer 2 must have no mobile");
  const HINT = "Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9.";
  const ctx = await as("customer2");
  const out: string[] = [];
  const { context, page } = await pageAs(browser, "customer2");
  try {
    await page.goto("/profile");
    const phone = page.getByTestId("phone-link");
    const field = phone.getByLabel("Mobile number");
    await expect(phone.getByRole("button", { name: "Add" }), "blank: Add is disabled").toBeDisabled();
    await field.fill("abcdefghij");
    await expect(field, "letters cannot be typed").toHaveValue("");
    await field.fill("98765432109");
    await expect(field, "an 11th digit is cut off").toHaveValue("9876543210");
    for (const value of ["987654321", "5876543210"]) {
      await field.fill(value);
      await phone.getByRole("button", { name: "Add" }).click();
      await expect(phone, `message for ${value}`).toContainText(HINT);
    }
    out.push("UI: blank → Add disabled, letters dropped, 11th digit cut, 9 digits and 5… → message");
    for (const value of ["987654321", "98765432101", "5876543210", "abcdefghij", "98#7654321"]) {
      const res = await call(ctx, "PUT", "/api/me/phone", { mobile: value });
      expect(res.status, `API ${value}`).toBe(422);
    }
    expect((await profileOf("customer2")).phoneE164, "nothing saved").toBeNull();
    out.push("API: 9/11 digits, 5…, letters, symbols → 422, nothing saved");
    const mobile = uniqueMobile();
    for (const value of [`+91 ${mobile}`, `${mobile.slice(0, 5)} ${mobile.slice(5)}`, mobile]) {
      const res = await call(ctx, "PUT", "/api/me/phone", { mobile: value });
      expectStatus(res, 200, `save "${value}"`);
      expect(res.body.phoneE164, `"${value}" saved as`).toBe(`+91${mobile}`);
    }
    out.push(`"+91 ${mobile}", "${mobile.slice(0, 5)} ${mobile.slice(5)}" and "${mobile}" all saved as +91${mobile} (+91 stripped)`);
    const owner = need((await profileOf("customer")).phoneE164, "a mobile on customer 1");
    const taken = await call(ctx, "PUT", "/api/me/phone", { mobile: owner.slice(3) });
    expect(taken.status, "a number of another account").toBe(409);
    expect(taken.body.error.message).not.toMatch(/@|QA Customer/);
    out.push("another account's number → 409, without saying whose");
    return out.join("; ");
  } finally {
    await context.close();
    await restoreMobile("customer2", original);
  }
}, signed);

/* ============================================================== email */

qa("TC-AUTH-026", "changing the email to one another account uses is refused: 'This email address is already used by another account.'", async ({ browser }) => {
  const other = await profileOf("customer2");
  const before = await profileOf("customer");
  const { context, page } = await pageAs(browser, "customer", { extraHTTPHeaders: { "x-forwarded-for": fakeIp() } });
  try {
    await page.goto("/profile");
    const box = page.getByTestId("email-change");
    await box.getByRole("button", { name: "Change email" }).click();
    await box.getByLabel("New email address").fill(other.email);
    await box.getByRole("button", { name: "Send code" }).click();
    await expect(box).toContainText("This email address is already used by another account.");
    const api = await call(page.request, "POST", "/api/profile/email", { email: other.email });
    expect(api.status).toBe(409);
    expect((await profileOf("customer")).email).toBe(before.email);
    return `page and API (409) refuse ${other.email.replace(/^(.{2}).*@/, "$1***@")}; email unchanged`;
  } finally {
    await context.close();
  }
}, signed);

qa("TC-FLD-008", "new email: blank, bad formats and over 254 characters refused on the field with nothing sent; the current email is refused", async ({ browser }) => {
  const me = await profileOf("customer");
  const { context, page } = await pageAs(browser, "customer", { extraHTTPHeaders: { "x-forwarded-for": fakeIp() } });
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/profile/email") && r.method() === "POST") requests.push(r.postData() ?? "");
  });
  try {
    await page.goto("/profile");
    const box = page.getByTestId("email-change");
    await box.getByRole("button", { name: "Change email" }).click();
    const field = box.getByLabel("New email address");
    const send = box.getByRole("button", { name: "Send code" });
    const refused: string[] = [];
    for (const value of ["", "abc", "abc@", "@x.com", "a b@x.com", `${"a".repeat(250)}@x.com`]) {
      await field.fill(value);
      await send.click();
      const native = await field.evaluate((el) => !(el as HTMLInputElement).validity.valid);
      const message = await box.getByText("Enter a valid email address").isVisible().catch(() => false);
      expect(native || message, `"${value.slice(0, 16)}" refused on the field`).toBe(true);
      refused.push(`${value ? value.slice(0, 12) : "blank"}:${native ? "browser" : "message"}`);
    }
    expect(requests, "nothing sent for a refused address").toEqual([]);
    const ctx = page.request;
    const tooLong = await call(ctx, "POST", "/api/profile/email", { email: `${"a".repeat(250)}@x.com` });
    expect(tooLong.status, "API: over 254 characters").toBe(422);
    const same = await call(ctx, "POST", "/api/profile/email", { email: me.email.toUpperCase() });
    expect(same.status, "API: the current email").toBe(422);
    expect(same.body.error.message).toBe("That is already your email address.");
    expect((await profileOf("customer")).email, "email unchanged").toBe(me.email);
    return `field refuses ${refused.join(", ")} (no request); API: 256 chars → 422, current email (in capitals) → "That is already your email address."; another account's address is TC-AUTH-026`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "a valid address in capitals with spaces (code to the lower-case address) is in tests/qa/local/auth-profile.spec.ts — it mails a code" });

/* ============================================ consent and preferences */

qa("TC-MKT-001", "marketing consent: switch on and off from My Profile, each change saved with its time; an error is shown when saving fails", async ({ browser }) => {
  const ctx = await as("customer");
  const start = (await call(ctx, "GET", "/api/consents/marketing")).body as { granted: boolean; lastChangedAt: string | null };
  const countRows = async () =>
    IS_LOCAL ? (await db()<{ n: number }[]>`select count(*)::int as n from user_consents where user_id = ${world().users.customer!.id!} and consent_type = 'MARKETING_COMMUNICATIONS'`)[0].n : null;
  const rowsBefore = await countRows();
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/profile?tab=offers");
    const toggle = page.getByRole("switch", { name: "Offers from GoKesari and its shops" });
    await expect(toggle).toHaveAttribute("aria-checked", String(start.granted));
    const times: string[] = [];
    for (const next of [!start.granted, start.granted]) {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", String(next));
      const now = (await call(ctx, "GET", "/api/consents/marketing")).body;
      expect(now.granted, "GET /api/consents/marketing").toBe(next);
      expect(now.lastChangedAt, "a new entry each time").not.toBe(times.at(-1) ?? start.lastChangedAt);
      times.push(now.lastChangedAt);
    }
    if (rowsBefore !== null) expect(await countRows(), "two history rows added").toBe(rowsBefore + 2);
    await page.route("**/api/consents/marketing", (route) =>
      route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "QA: saving failed" } }) }) : route.continue(),
    );
    await toggle.click();
    await expect(page.getByTestId("marketing-consent")).toContainText("QA: saving failed");
    await expect(toggle, "unchanged after a failed save").toHaveAttribute("aria-checked", String(start.granted));
    return `${start.granted ? "on" : "off"} → ${!start.granted ? "on" : "off"} → ${start.granted ? "on" : "off"}; lastChangedAt ${times.join(" → ")}${rowsBefore !== null ? "; +2 consent rows" : ""}; a failed save shows the error`;
  } finally {
    await context.close();
    const end = (await call(ctx, "GET", "/api/consents/marketing")).body;
    if (end.granted !== start.granted) await call(ctx, "PUT", "/api/consents/marketing", { granted: start.granted });
  }
}, {
  ...signed,
  mobile: true,
  partial: "there is no Save button to disable: the switch saves on each tap so withdrawing is one click (expected result superseded by src/components/marketing-consent-toggle.tsx, DPDPA §6(4))",
});

qa("TC-FLD-124", "consent and notification switches persist both ways after reload; non-boolean values are refused; Account & security notices cannot be switched off", async ({ browser }) => {
  const ctx = await as("customer");
  const consent = (await call(ctx, "GET", "/api/consents/marketing")).body as { granted: boolean };
  const prefs = (await call(ctx, "GET", "/api/notifications/preferences")).body.preferences as { category: string; label: string; mandatory: boolean; channels: { channel: string; enabled: boolean; available: boolean }[] }[];
  const row = prefs.find((p) => !p.mandatory && p.channels.some((c) => c.channel === "EMAIL" && c.available));
  if (!row) blocked("no optional notification category with email available");
  const emailBefore = row.channels.find((c) => c.channel === "EMAIL")!.enabled;
  const security = prefs.find((p) => p.mandatory);
  const { context, page } = await pageAs(browser, "customer");
  const out: string[] = [];
  try {
    await page.goto("/profile?tab=offers");
    const toggle = page.getByRole("switch", { name: "Offers from GoKesari and its shops" });
    for (const next of [!consent.granted, consent.granted]) {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", String(next));
      await page.reload();
      await expect(toggle, "kept after reload").toHaveAttribute("aria-checked", String(next));
    }
    out.push("marketing switch kept both ways after reload");
    await page.goto("/profile?tab=notifications");
    const box = page.getByRole("checkbox", { name: `${row.label} — Email` });
    for (const next of [!emailBefore, emailBefore]) {
      await box.click();
      await expect(box).toBeChecked({ checked: next });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.reload();
      await expect(page.getByRole("checkbox", { name: `${row.label} — Email` }), "kept after reload").toBeChecked({ checked: next });
    }
    out.push(`"${row.label} — Email" kept both ways after reload`);
    if (security) {
      await expect(page.getByRole("checkbox", { name: `${security.label} — In-app` })).toBeDisabled();
      await expect(page.getByRole("checkbox", { name: `${security.label} — Email` })).toBeDisabled();
      const off = await call(ctx, "PUT", "/api/notifications/preferences", { category: security.category, channel: "EMAIL", enabled: false });
      expect(off.status).toBe(422);
      expect(off.body.error.message).toBe("Security notices cannot be switched off.");
      out.push(`"${security.label}" switches disabled; API off → 422 "${off.body.error.message}"`);
    }
    const bad1 = await call(ctx, "PUT", "/api/consents/marketing", { granted: "yes" });
    const bad2 = await call(ctx, "PUT", "/api/notifications/preferences", { category: row.category, channel: "EMAIL", enabled: "no" });
    expect([bad1.status, bad2.status], "non-boolean values").toEqual([422, 422]);
    out.push("non-boolean → 422 on both APIs");
    return out.join("; ");
  } finally {
    await context.close();
    await call(ctx, "PUT", "/api/consents/marketing", { granted: consent.granted });
    await call(ctx, "PUT", "/api/notifications/preferences", { category: row.category, channel: "EMAIL", enabled: emailBefore });
  }
}, { ...signed, partial: "'takes effect where it should' (marketing audiences, email delivery) is TC-MKT-006 and the notification specs" });
