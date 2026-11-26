/**
 * Going live through the identity-first registration — the parts that are
 * safe on test.gokesari.com (TC-ONB-073 … 076). The rest of TC-ONB-070 …
 * 088 and the journeys SC-38 / SC-39 / SC-44 need a GSTIN or PAN the staging
 * KYC provider verifies, payments, back-dated rows, rule changes or the cron
 * secret, and run in the local tier (tests/qa/local/sellers-go-live.spec.ts,
 * tests/qa/scenarios/SC-3*.spec.ts, SC-44-*.spec.ts).
 *
 * Signed tier. Nothing here creates a shop, a registration draft or a payment:
 *   - the live and done screens are read on a staging account whose latest
 *     wizard registration is live (blocked when none is);
 *   - the GSTIN of shop A is sent as another account to the GSTIN check,
 *     which refuses it before any draft is made or any government lookup is
 *     paid for (shop-registration-draft.ts submitDraftGstin → assertGstinFree);
 *   - the template download and the registration-date display are reads.
 */
import ExcelJS from "exceljs";

import { as, pageAs, shopFreeCustomer } from "../lib/actors";
import { shopOf } from "../lib/flows";
import { call, expectStatus, why } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { BASE_URL } from "../lib/target";
import { world, type Role } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 240_000 };

/** Staging accounts that may have registered a shop through the wizard. */
const OWNERS: Role[] = ["admin", "shop", "shopB"];

/**
 * The first owner account whose /shop/register shows `testId` (the live or
 * done screen). Returns its open page; blocks when no account shows it.
 */
async function wizardScreen(browser: Parameters<typeof pageAs>[0], testId: string, what: string) {
  const seen: string[] = [];
  for (const role of OWNERS) {
    if (!world().users[role]) continue;
    let opened: Awaited<ReturnType<typeof pageAs>> | null = null;
    try {
      opened = await pageAs(browser, role);
      await opened.page.goto("/shop/register");
      await opened.page.getByTestId("registration-tiles").or(opened.page.getByTestId("registration-waiting")).first().waitFor({ timeout: 30_000 }).catch(() => {});
      if (await opened.page.getByTestId(testId).isVisible().catch(() => false)) return { role, ...opened };
      seen.push(`${role}: not on the ${what}`);
    } catch (error) {
      seen.push(`${role}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    await opened?.context.close();
  }
  blocked(`no staging account's latest wizard registration is on the ${what} (${seen.join("; ")})`);
}

qa("TC-ONB-074", "the live screen of a wizard shop: the add-products question, 'Add products manually' / 'Upload using template', the template download and 'Upload filled file' → /shop/product-import", async ({ browser }) => {
  const { role, context, page } = await wizardScreen(browser, "onboarding-complete", "live screen");
  try {
    await expect(page.getByTestId("onboarding-complete")).toHaveText("Your onboarding is complete and your shop is live for accepting orders.");
    await expect(page.getByTestId("add-products-prompt")).toHaveText("Add your products so customers can select them and place orders with you. How would you like to add them?");
    await expect(page.getByTestId("add-products")).toHaveText("Add products manually");
    await page.getByTestId("add-products-template").click();
    const link = page.getByTestId("download-product-template");
    await expect(link).toHaveAttribute("href", "/api/v1/product-imports/template");
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBe("GoKesari_Product_Upload_Template.xlsx");
    await page.getByTestId("upload-product-file").click();
    await page.waitForURL(/\/shop\/product-import/);
    return `${role}: live screen as expected; template ${download.suggestedFilename()}; upload → /shop/product-import`;
  } finally {
    await context.close();
  }
}, signed);

qa("TC-ONB-074", "the product template downloads as GoKesari_Product_Upload_Template.xlsx with the mandatory columns", async () => {
  const res = await (await as("shop")).fetch(new URL("/api/v1/product-imports/template", BASE_URL).toString(), { failOnStatusCode: false, timeout: 120_000 });
  expect(res.status(), "GET the template as a shop owner").toBe(200);
  expect(res.headers()["content-disposition"]).toContain('filename="GoKesari_Product_Upload_Template.xlsx"');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await res.body()) as unknown as ArrayBuffer);
  const sheet = need(wb.getWorksheet("Products") ?? wb.worksheets[0], "the template's first sheet");
  const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
  for (const column of ["Product Name", "Category", "MRP", "Stock Qty"]) expect(header, column).toContain(column);
  return `sheet "${sheet.name}": ${header.filter(Boolean).join(", ").slice(0, 200)}`;
}, { ...signed, partial: "the live screen that links it is the previous check (and the local tier)" });

qa("TC-ONB-073", "the done screen of a wizard shop: 'Registration successful 🎉', tiles 'Get paid' → /shop/bank-account and 'How you deliver' → /shop/setup/delivery, 'Go to my shop' and 'Register another shop'", async ({ browser }) => {
  const { role, context, page } = await wizardScreen(browser, "done-next-steps", "done screen");
  try {
    await expect(page.getByRole("heading", { name: "Registration successful 🎉" })).toBeVisible();
    const tiles = page.getByTestId("done-next-steps");
    await expect(tiles.getByRole("link", { name: /Get paid/ })).toHaveAttribute("href", "/shop/bank-account");
    await expect(tiles.getByRole("link", { name: /How you deliver/ })).toHaveAttribute("href", "/shop/setup/delivery");
    await expect(page.getByRole("link", { name: "Go to my shop", exact: true })).toHaveAttribute("href", "/shop");
    await expect(page.getByRole("link", { name: "Register another shop", exact: true })).toHaveAttribute("href", "/shop/register?new=1");
    await tiles.getByRole("link", { name: /How you deliver/ }).click();
    await page.waitForURL(/\/shop\/setup\/delivery/);
    await expect(page.getByRole("heading", { name: "How you deliver" })).toBeVisible();
    await page.goto("/shop/register");
    await page.getByTestId("done-next-steps").getByRole("link", { name: /Get paid/ }).click();
    await page.waitForURL(/\/shop\/bank-account/);
    return `${role}: done screen; tiles and buttons point where the case says; How you deliver and Get paid open`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "'Register another shop' is followed in the local tier only (it opens a new registration)" });

qa("TC-ONB-075", "Seller Central shows the shop's registration date as stored (no day lost to UTC)", async ({ browser }) => {
  const shop = await shopOf("A");
  const record = await call(await as("shop"), "GET", `/api/shops/${shop.id}`);
  expectStatus(record, 200, "shop A's record as its owner");
  const iso = need(record.body.registrationDate as string | null, "shop A's registration date");
  const shown = new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  const { context, page } = await pageAs(browser, "shop");
  try {
    await page.goto("/shop/manage/registration");
    // Since the registration subscription (PR #557, 25-Nov-2026) the page also has the Shop Registration card, whose
    // "Registration date" is the start of the paid registration period (registration_start_date): read the shop's
    // own record under "Registration details".
    const details = page.locator("section").filter({ has: page.getByRole("heading", { name: "Registration details" }) });
    const term = details.getByRole("term").filter({ hasText: "Registration date" });
    await expect(term.locator("..").getByRole("definition")).toHaveText(shown);
  } finally {
    await context.close();
  }
  return `${shop.name}: registered ${iso}, shown ${shown}`;
}, { ...signed, partial: "a shop registered between 00.00 and 05.30 IST is checked in the local tier (the stored IST date)" });

qa("TC-ONB-076", "another account sending the GSTIN of a live shop is refused before any check: 'A shop with this GSTIN is already registered on GoKesari by another account. It is live on GoKesari. …'", async () => {
  const shop = await shopOf("A");
  const record = await call(await as("shop"), "GET", `/api/shops/${shop.id}`);
  expectStatus(record, 200, "shop A's record as its owner");
  const gstin = need((record.body.gstin as string | null) || null, "a GSTIN on shop A");
  expect(record.body.status, "shop A is live").toBe("APPROVED");
  const other = await shopFreeCustomer();
  const ctx = await as(other);
  const before = await call(ctx, "GET", "/api/shops/registration-draft");
  expectStatus(before, 200, "the other account's registration");
  const res = await call(ctx, "POST", "/api/shops/registration-draft/gstin", { gstin, consent: true });
  if (res.status === 409 && res.body?.error?.details?.reason === "REGISTRATION_PENDING") blocked(`${other} has a registration waiting: ${why(res)}`);
  expect(res.status, why(res)).toBe(409);
  expect(res.body.error.message).toBe(
    "A shop with this GSTIN is already registered on GoKesari by another account. It is live on GoKesari. If it is yours, sign in with the account that registered it, or contact support.",
  );
  expect(res.body.error.details?.fields?.gstin).toBe("This GSTIN is already registered.");
  const after = await call(ctx, "GET", "/api/shops/registration-draft");
  expect(after.body?.id ?? null, "no registration was started").toBe(before.body?.id ?? null);
  return `${other} sending shop A's GSTIN: 409 "${res.body.error.message}"`;
}, { ...signed, partial: "the waiting / not-active sentences, the PAN route, the Verify screen and the held-after-payment path run in the local tier" });
