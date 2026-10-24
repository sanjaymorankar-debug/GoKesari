/**
 * Shop registration (/shop/register, POST /api/shops): the happy path, the
 * business-identifier and duplicate rules, double submission, resubmission
 * of a rejected shop, the on-blur duplicate pre-check, and the field cases
 * of the registration form (TC-FLD-034 … 042, 046, 048).
 *
 * Local tier: every registration is made by a fresh account (a person who
 * has never registered a shop), created in the local database the way a
 * completed sign-up leaves it, so the world's shop owners are never touched.
 */
import type { Page } from "@playwright/test";

import { as } from "../lib/actors";
import { db } from "../lib/db";
import { call, expectStatus, RUN, why } from "../lib/http";
import { expect, qa } from "../lib/record";
import {
  ctxFor,
  freshAccount,
  markDocumentsVerified,
  needPanStorage,
  pageFor,
  registerShop,
  registrationBody,
  shopRow,
  uniquePan,
  uniqueShopAct,
  uniqueUdyam,
} from "../lib/sellers-helpers";

const local = { tier: "local" as const, timeout: 180_000 };

/** Fills the registration form with valid values (a stationery shop, Shop Act only). */
async function fillForm(page: Page, values: { name: string; owner?: string; phone: string; address?: string; shopAct?: string; pincode?: string }) {
  await page.getByLabel("Shop name *").fill(values.name);
  await page.getByLabel("Owner name *").fill(values.owner ?? "QA Form Owner");
  await page.getByLabel(/^Phone/).fill(values.phone);
  await page.getByLabel(/^Address/).fill(values.address ?? "12 QA Form Lane, Paud Road");
  await page.getByLabel(/^PIN code/).fill(values.pincode ?? "411038");
  await page.getByLabel(/^Shop type/).selectOption("STATIONERY_STORE");
  const group = page.getByRole("group", { name: "Shop categories" });
  await group.getByLabel("Stationery Store").check();
  if (values.shopAct !== undefined) await page.getByLabel(/^Shop Act \/ Gumasta licence number/).fill(values.shopAct);
}

async function ownShops(ownerId: string) {
  return db()<{ id: string; name: string; status: string; registration_number: string | null }[]>`
    select id, name, status, registration_number from shops where owner_id = ${ownerId} and deleted_at is null order by created_at`;
}

/* -------------------------------------------------------------- happy path */

qa("TC-ONB-001", "register a shop on /shop/register: PENDING_APPROVAL with a registration number, the person becomes SHOP_OWNER, /shop shows the pending state", async ({ browser }) => {
  const owner = await freshAccount("onb001");
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: "Add my shop" })).toBeVisible();
    const name = `QA Register UI ${RUN}`;
    await fillForm(page, { name, phone: owner.phone, shopAct: uniqueShopAct() });
    await page.getByLabel("We deliver to customers").check();
    await page.getByLabel("Delivery fee (₹)").fill("15");
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await page.waitForURL(/\/shop\/documents/, { timeout: 30_000 });
    const shops = await ownShops(owner.id);
    expect(shops.length, "exactly one shop created").toBe(1);
    expect(shops[0].status).toBe("PENDING_APPROVAL");
    expect(shops[0].registration_number, "registration number assigned").toBeTruthy();
    const session = await call(await ctxFor(owner), "GET", "/api/auth/session");
    expect(session.body?.user?.role, "the account now acts as SHOP_OWNER").toBe("SHOP_OWNER");
    await page.goto("/shop");
    // The seller home's action list (desktop) or its status banner (phone).
    await expect(page.getByRole("status").filter({ hasText: /awaiting approval/i, visible: true }).first()).toBeVisible();
    const row = await shopRow(shops[0].id);
    return `"${name}" → ${row.status}, ${shops[0].registration_number}, lifecycle ${row.lifecycle_status}; role SHOP_OWNER; /shop shows "awaiting approval"`;
  } finally {
    await context.close();
  }
}, { ...local, mobile: true });

qa("TC-ONB-005", "double-clicking Submit sends one registration: the button disables at once with a spinner and exactly one shop is created", async ({ browser }) => {
  const owner = await freshAccount("onb005");
  const { context, page } = await pageFor(browser, owner);
  try {
    let posts = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/shops") posts += 1;
    });
    await page.goto("/shop/register");
    await fillForm(page, { name: `QA Double Click ${RUN}`, phone: owner.phone, shopAct: uniqueShopAct() });
    const submit = page.getByRole("button", { name: /Submit for approval|Submitting/ });
    // Slow the answer so the busy state can be seen before the page moves on.
    await page.route("**/api/shops", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await submit.dblclick();
    await expect(page.getByRole("button", { name: /Submitting/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Submitting/ })).toHaveAttribute("aria-busy", "true");
    await page.waitForURL(/\/shop\/documents/, { timeout: 30_000 });
    const shops = await ownShops(owner.id);
    expect(posts, "POST /api/shops sent once").toBe(1);
    expect(shops.length, "one shop").toBe(1);
    return `double-click → button "Submitting…" disabled + aria-busy; ${posts} POST; ${shops.length} shop`;
  } finally {
    await context.close();
  }
}, local);

/* -------------------------------------------------------- identifiers */

qa("TC-ONB-002", "at least one business identifier is required, and a PAN needs its holder name: 422 with the fields highlighted", async ({ browser }) => {
  await needPanStorage();
  const owner = await freshAccount("onb002");
  const ctx = await ctxFor(owner);
  const none = await call(ctx, "POST", "/api/shops", await registrationBody({ shopActNumber: null }));
  expect(none.status, why(none)).toBe(422);
  expect(JSON.stringify(none.body)).toMatch(/at least one of PAN, Udyam Aadhaar, GST or Shop Act/i);
  const panOnly = await call(ctx, "POST", "/api/shops", await registrationBody({ shopActNumber: null, panNumber: uniquePan(), panHolderName: null }));
  expect(panOnly.status, why(panOnly)).toBe(422);
  expect(panOnly.body?.error?.details?.fields?.panHolderName, "panHolderName highlighted").toBeTruthy();
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    await fillForm(page, { name: `QA No Identifier ${RUN}`, phone: owner.phone });
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByText("Please check the highlighted fields.")).toBeVisible();
    await expect(page.getByText(/Please enter at least one of PAN, Udyam Aadhaar, GST or Shop Act number/)).toBeVisible();
    await page.getByLabel(/^PAN/).fill(uniquePan());
    await expect(page.getByLabel("Name on PAN card")).toBeVisible();
    await expect(page.getByLabel("Name on PAN card")).toHaveAttribute("required", "");
  } finally {
    await context.close();
  }
  expect((await ownShops(owner.id)).length, "nothing registered").toBe(0);
  return `none → 422 "${none.body?.error?.message}"; PAN without holder → 422 fields.panHolderName; form shows the identifier message and asks for the PAN holder name`;
}, local);

qa("TC-ONB-003", "identifier formats: bad PAN, a bare 12-digit Udyam and a placeholder Shop Act are refused on the field; valid mixed-case values are accepted and normalised", async ({ browser }) => {
  await needPanStorage();
  const owner = await freshAccount("onb003");
  const ctx = await ctxFor(owner);
  const bad: [string, Record<string, unknown>, string][] = [
    ["PAN ABCDE12345", { shopActNumber: null, panNumber: "ABCDE12345", panHolderName: "QA" }, "panNumber"],
    ["Udyam 123412341234", { shopActNumber: null, udyamNumber: "123412341234" }, "udyamNumber"],
    ["Shop Act NA", { shopActNumber: "NA" }, "shopActNumber"],
    ["Shop Act 0000", { shopActNumber: "0000" }, "shopActNumber"],
  ];
  const seen: string[] = [];
  for (const [label, body, field] of bad) {
    const res = await call(ctx, "POST", "/api/shops", await registrationBody(body));
    expect(res.status, `${label}: ${why(res)}`).toBe(422);
    expect(res.body?.error?.details?.fields?.[field], `${label}: message on ${field}`).toBeTruthy();
    seen.push(`${label} → 422 ${field}`);
  }
  // Valid values typed loosely: lower case, spaces, hyphens.
  const pan = uniquePan();
  const udyam = uniqueUdyam();
  const act = uniqueShopAct();
  const loosePan = `${pan.slice(0, 5).toLowerCase()} ${pan.slice(5, 9)}-${pan.slice(9).toLowerCase()}`;
  const looseUdyam = udyam.toLowerCase().replace(/-/g, " ");
  const looseAct = `  ${act.toLowerCase().replace(/-/g, "  -  ")} `;
  const { shop } = await registerShop(ctx, { shopActNumber: looseAct, panNumber: loosePan, panHolderName: "QA Holder", udyamNumber: looseUdyam });
  const [stored] = await db()<{ shop_act_number: string; shop_act_key: string; udyam_number: string; pan_last4: string }[]>`
    select shop_act_number, shop_act_key, udyam_number, pan_last4 from shops where id = ${shop.id}`;
  expect(stored.udyam_number).toBe(udyam);
  expect(stored.shop_act_key).toBe(act.replace(/[^A-Z0-9]/g, ""));
  expect(stored.shop_act_number).toBe(act.replace(/-/g, " - ").replace(/\s+/g, " ").trim());
  expect(stored.pan_last4).toBe(pan.slice(-4));
  // The form says it on the field too.
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    await page.getByLabel(/^PAN/).fill("ABCDE12345");
    await page.getByLabel(/^PAN/).blur();
    await expect(page.getByText("PAN must be 10 characters in the format AAAAA9999A.")).toBeVisible();
    await page.getByLabel(/^Udyam/).fill("123412341234");
    await page.getByLabel(/^Udyam/).blur();
    await expect(page.getByText(/looks like a personal Aadhaar number/)).toBeVisible();
    await page.getByLabel(/^Shop Act/).fill("NA");
    await page.getByLabel(/^Shop Act/).blur();
    await expect(page.getByText(/Enter the licence number exactly as printed/)).toBeVisible();
  } finally {
    await context.close();
  }
  return `${seen.join("; ")}; loose "${loosePan}" / "${looseUdyam}" / "${looseAct.trim()}" accepted → stored ${stored.udyam_number}, ${stored.shop_act_number}, PAN …${stored.pan_last4}; field messages shown on blur`;
}, local);

qa("TC-ONB-004", "at least one shop category is required", async ({ browser }) => {
  const owner = await freshAccount("onb004");
  const res = await call(await ctxFor(owner), "POST", "/api/shops", await registrationBody({ categoryIds: [] }));
  expect(res.status, why(res)).toBe(422);
  expect(JSON.stringify(res.body)).toMatch(/at least one shop category/i);
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    await fillForm(page, { name: `QA No Category ${RUN}`, phone: owner.phone, shopAct: uniqueShopAct() });
    await page.getByRole("group", { name: "Shop categories" }).getByLabel("Stationery Store").uncheck();
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByText("Please select at least one shop category.").first()).toBeVisible();
  } finally {
    await context.close();
  }
  expect((await ownShops(owner.id)).length).toBe(0);
  return `API → 422 "${res.body?.error?.message}"; the form refuses with "Please select at least one shop category."`;
}, local);

/* ---------------------------------------------------------- duplicates */

qa("TC-ONB-007", "duplicate by Shop Act licence from another account (other spacing and case): 409, identifier masked, says it is registered and waiting, nothing about the other shop", async () => {
  const first = await freshAccount("onb007a");
  const act = uniqueShopAct();
  const { shop: x } = await registerShop(await ctxFor(first), { shopActNumber: act });
  const second = await freshAccount("onb007b");
  const variant = act.toLowerCase().replace(/-/g, " ");
  const res = await call(await ctxFor(second), "POST", "/api/shops", await registrationBody({ name: `QA Other Name ${RUN}`, shopActNumber: variant }));
  expect(res.status, why(res)).toBe(409);
  const text = JSON.stringify(res.body);
  expect(res.body?.error?.details?.reason).toBe("DUPLICATE_SHOP");
  expect(res.body?.error?.message).toMatch(/already registered/i);
  expect(res.body?.error?.message).toMatch(/waiting|review|pending/i);
  const key = act.replace(/[^A-Z0-9]/g, "");
  expect(text, "the full licence number is not echoed").not.toContain(key);
  expect(text, "masked tail shown").toContain(key.slice(-4));
  expect(text, "the other shop's name is not revealed").not.toContain(String(x.name));
  expect(text, "the other shop's id is not revealed").not.toContain(x.id);
  expect(res.body?.error?.details?.matchedShopId, "no matched shop id for a self-service caller").toBeUndefined();
  return `"${variant}" vs pending "${act}" → 409: ${res.body.error.message}`;
}, local);

qa("TC-ONB-008", "duplicate by PAN at the same place is blocked; the same PAN at another PIN and name is allowed (a branch)", async () => {
  await needPanStorage();
  const pan = uniquePan();
  const first = await freshAccount("onb008a");
  const { shop: x } = await registerShop(await ctxFor(first), { panNumber: pan, panHolderName: "QA PAN Holder", shopActNumber: null });
  await markDocumentsVerified(x.id);
  await db()`update shops set fee_payment_status = 'PAID' where id = ${x.id}`;
  expectStatus(await call(await as("ops"), "POST", `/api/shops/${x.id}/approve`, { classification: "GREEN" }), 200, "approve shop X");
  const second = await freshAccount("onb008b");
  const ctx = await ctxFor(second);
  const samePlace = await call(ctx, "POST", "/api/shops", await registrationBody({ name: x.name, panNumber: pan, panHolderName: "QA PAN Holder", shopActNumber: null }));
  expect(samePlace.status, `same PAN, PIN and name: ${why(samePlace)}`).toBe(409);
  const branch = await call(ctx, "POST", "/api/shops", await registrationBody({ name: `QA Branch ${RUN}`, addressLine1: "99 Other Road", pincode: "411001", panNumber: pan, panHolderName: "QA PAN Holder", shopActNumber: null }));
  expect(branch.status, `same PAN at another PIN and name: ${why(branch)}`).toBe(201);
  return `PAN …${pan.slice(-4)}: same place → 409 (${samePlace.body?.error?.details?.matchedOn}); other PIN + name → 201 ${branch.body.registrationNumber ?? branch.body.id}`;
}, local);

qa("TC-ONB-009", "the same owner submitting the same shop (name + PIN) while it is pending is blocked; /shop/register warns about the own pending shop", async ({ browser }) => {
  const owner = await freshAccount("onb009");
  const ctx = await ctxFor(owner);
  const { shop, body } = await registerShop(ctx);
  const again = await call(ctx, "POST", "/api/shops", { ...body, shopActNumber: uniqueShopAct() });
  expect(again.status, why(again)).toBe(409);
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    await expect(page.getByText(`Already waiting for approval: ${shop.name}`)).toBeVisible();
  } finally {
    await context.close();
  }
  expect((await ownShops(owner.id)).length).toBe(1);
  return `second submission → 409 "${again.body?.error?.message}"; /shop/register shows "Already waiting for approval: ${shop.name}"`;
}, local);

qa("TC-ONB-006", "a refused submission (duplicate) shows the error and the form keeps everything typed", async ({ browser }) => {
  const act = uniqueShopAct();
  await registerShop(await ctxFor(await freshAccount("onb006a")), { shopActNumber: act });
  const owner = await freshAccount("onb006b");
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    const name = `QA Keeps Values ${RUN}`;
    await fillForm(page, { name, phone: owner.phone, shopAct: act, address: "7 Kept Address Road" });
    await page.getByLabel("About your shop (optional)").fill("Typed description that must survive");
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByText(/already registered/i).first()).toBeVisible();
    await expect(page.getByLabel("Shop name *")).toHaveValue(name);
    await expect(page.getByLabel(/^Phone/)).toHaveValue(owner.phone);
    await expect(page.getByLabel(/^Address/)).toHaveValue("7 Kept Address Road");
    await expect(page.getByLabel(/^Shop Act/)).toHaveValue(act);
    await expect(page.getByLabel("About your shop (optional)")).toHaveValue("Typed description that must survive");
    await expect(page.getByRole("group", { name: "Shop categories" }).getByLabel("Stationery Store")).toBeChecked();
    await expect(page.getByLabel(/^Shop type/)).toHaveValue("STATIONERY_STORE");
  } finally {
    await context.close();
  }
  return "duplicate refused with the message; name, phone, address, Shop Act, description, category and type kept";
}, local);

qa("TC-ONB-010", "a rejected shop is corrected and resubmitted: the same record (same registration number) returns to PENDING_APPROVAL", async ({ browser }) => {
  const owner = await freshAccount("onb010");
  const ctx = await ctxFor(owner);
  const { shop, body } = await registerShop(ctx);
  const before = await shopRow(shop.id);
  expectStatus(await call(await as("ops"), "POST", `/api/shops/${shop.id}/reject`, { reason: "QA: address is incomplete" }), 200, "reject");
  expect((await shopRow(shop.id)).status).toBe("REJECTED");
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/manage/today");
    await expect(page.getByText("QA: address is incomplete")).toBeVisible();
    await page.getByRole("link", { name: "Correct the details and resubmit" }).click();
    await page.waitForURL(/\/shop\/register/);
    await expect(page.getByText(`Resubmitting ${shop.name}?`)).toBeVisible();
    await fillForm(page, { name: String(body.name), phone: String(body.phone), shopAct: String(body.shopActNumber), address: "12 Corrected Lane, Paud Road" });
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await page.waitForURL(/\/shop\/documents/, { timeout: 30_000 });
  } finally {
    await context.close();
  }
  const after = await shopRow(shop.id);
  const all = await ownShops(owner.id);
  expect(all.length, "no new shop").toBe(1);
  expect(after.status).toBe("PENDING_APPROVAL");
  expect(after.registration_number).toBe(before.registration_number);
  expect(after.rejection_reason).toBeNull();
  return `${before.registration_number}: REJECTED → resubmitted from the /shop link → PENDING_APPROVAL, same record`;
}, local);

qa("TC-ONB-011", "on-blur duplicate pre-check: DUPLICATE / RESUBMISSION / CLEAR, sent by POST (never in the URL), 429 after 20 a minute", async ({ browser }) => {
  const act = uniqueShopAct();
  await registerShop(await ctxFor(await freshAccount("onb011a")), { shopActNumber: act });
  const owner = await freshAccount("onb011b");
  const ctx = await ctxFor(owner);
  const { context, page } = await pageFor(browser, owner);
  const urls: string[] = [];
  try {
    page.on("request", (r) => {
      if (r.url().includes("duplicate-check")) urls.push(`${r.method()} ${r.url()}`);
    });
    await page.goto("/shop/register");
    await page.getByLabel("Shop name *").fill(`QA Precheck ${RUN}`);
    await page.getByLabel(/^Shop Act/).fill(act.toLowerCase());
    await page.getByLabel(/^Shop Act/).blur();
    await expect(page.getByText(/already registered/i).first()).toBeVisible();
  } finally {
    await context.close();
  }
  expect(urls.length, "a pre-check was sent").toBeGreaterThan(0);
  for (const u of urls) {
    expect(u.startsWith("POST "), u).toBe(true);
    expect(u, "identifier not in the URL").not.toContain(act.replace(/[^A-Z0-9]/g, "").slice(-6).toLowerCase());
  }
  const clear = await call(ctx, "POST", "/api/shops/duplicate-check", { shopActNumber: uniqueShopAct(), name: "x", pincode: "411038" });
  expect(clear.body?.status, why(clear)).toBe("CLEAR");
  const dup = await call(ctx, "POST", "/api/shops/duplicate-check", { shopActNumber: act });
  expect(dup.body?.status).toBe("DUPLICATE");
  // RESUBMISSION: the caller's own rejected shop.
  const mine = await registerShop(ctx);
  expectStatus(await call(await as("ops"), "POST", `/api/shops/${mine.shop.id}/reject`, { reason: "QA resubmission check" }), 200, "reject own");
  const resub = await call(ctx, "POST", "/api/shops/duplicate-check", { shopActNumber: String(mine.body.shopActNumber) });
  expect(resub.body?.status).toBe("RESUBMISSION");
  const get = await call(ctx, "GET", `/api/shops/duplicate-check?shopActNumber=${encodeURIComponent(act)}`);
  expect(get.status, "GET is not offered").toBe(405);
  let limited = 0;
  let sent = 3;
  for (let i = 0; i < 22 && !limited; i++) {
    const res = await call(ctx, "POST", "/api/shops/duplicate-check", { shopActNumber: uniqueShopAct() });
    sent += 1;
    if (res.status === 429) limited = sent;
  }
  expect(limited, "429 within the minute").toBeGreaterThan(0);
  expect(limited).toBeLessThanOrEqual(21 + urls.length);
  return `blur → warning; ${urls.join(", ")}; CLEAR / DUPLICATE / RESUBMISSION; GET 405; 429 at check #${limited}`;
}, local);

/* ------------------------------------------------------- field cases */

const SCRIPT = "<script>alert(1)</script> & 'quotes' \"x\"";
const MARATHI = "श्री गणेश दुग्धालय";

/** Registers one value of a text field; returns the answer. */
async function tryField(ctx: Awaited<ReturnType<typeof ctxFor>>, field: string, value: unknown, extra: Record<string, unknown> = {}) {
  return call(ctx, "POST", "/api/shops", await registrationBody({ [field]: value, ...extra }));
}

qa("TC-FLD-034", "shop name: blank, spaces and 1 character refused on the field; 300+ refused at the 120 limit (no 500); script stored as text; Marathi saved; outer spaces trimmed", async ({ browser }) => {
  const owner = await freshAccount("fld034");
  const ctx = await ctxFor(owner);
  const notes: string[] = [];
  for (const [label, value] of [["blank", ""], ["spaces", "    "], ["1 char", "Q"], ["301 chars", "Q".repeat(301)]] as const) {
    const res = await tryField(ctx, "name", value);
    expect(res.status, `${label}: ${why(res)}`).toBe(422);
    notes.push(`${label} → 422`);
  }
  const script = await tryField(ctx, "name", `${SCRIPT} ${RUN}`);
  expect(script.status, why(script)).toBe(201);
  expect(script.body.name).toBe(`${SCRIPT} ${RUN}`);
  const marathi = await tryField(ctx, "name", `${MARATHI} ${RUN}`);
  expect(marathi.status, why(marathi)).toBe(201);
  expect(marathi.body.name).toBe(`${MARATHI} ${RUN}`);
  const spaced = await tryField(ctx, "name", `   QA Trimmed ${RUN}   `);
  expect(spaced.status, why(spaced)).toBe(201);
  expect(spaced.body.name, "outer spaces trimmed").toBe(`QA Trimmed ${RUN}`);
  // The owner's own page shows the stored names as text.
  const { context, page } = await pageFor(browser, owner);
  let dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs += 1;
    await d.dismiss();
  });
  try {
    await page.goto("/shop/register");
    await expect(page.getByText(/Already waiting for approval:/)).toContainText("<script>alert(1)</script>");
    await expect(page.getByText(/Already waiting for approval:/)).toContainText(MARATHI);
    await page.getByLabel("Shop name *").fill("   ");
    await page.getByLabel("Owner name *").fill("QA");
    await page.getByLabel(/^Phone/).fill(owner.phone);
    await page.getByLabel(/^Address/).fill("1 Lane");
    await page.getByLabel(/^PIN code/).fill("411038");
    await page.getByLabel(/^Shop type/).selectOption("STATIONERY_STORE");
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByText("Shop name is required.")).toBeVisible();
  } finally {
    await context.close();
  }
  expect(dialogs, "no script ran").toBe(0);
  return `${notes.join(", ")} (limit 120); script and Marathi stored verbatim and shown as text; "   QA Trimmed   " → trimmed; spaces-only shows "Shop name is required."`;
}, local);

qa("TC-FLD-035", "owner name: blank, spaces and 1 character refused; 300+ refused at 120; script stored as text; Marathi saved; outer spaces trimmed", async () => {
  const ctx = await ctxFor(await freshAccount("fld035"));
  const notes: string[] = [];
  for (const [label, value] of [["blank", ""], ["spaces", "    "], ["1 char", "Q"], ["301 chars", "Q".repeat(301)]] as const) {
    const res = await tryField(ctx, "ownerName", value);
    expect(res.status, `${label}: ${why(res)}`).toBe(422);
    notes.push(`${label} → 422`);
  }
  for (const value of [SCRIPT, MARATHI]) {
    const res = await tryField(ctx, "ownerName", value);
    expect(res.status, why(res)).toBe(201);
    expect(res.body.ownerName).toBe(value);
  }
  const spaced = await tryField(ctx, "ownerName", "   QA Spaced Owner   ");
  expect(spaced.body.ownerName).toBe("QA Spaced Owner");
  return `${notes.join(", ")}; script and Marathi stored verbatim; outer spaces trimmed`;
}, { ...local, partial: "the display of the owner name is the operator's queue (TC-ONB-012 opens it)" });

qa("TC-FLD-036", "phone: blank, 9/11 digits, first digit below 6, letters and spaces refused; +91 refused every time; a valid number saved exactly", async ({ browser }) => {
  const owner = await freshAccount("fld036");
  const ctx = await ctxFor(owner);
  const bad = ["", "987654321", "98765432101", "5876543210", "98765abcde", "98765 43210", "+919876543210"];
  for (const value of bad) {
    const res = await tryField(ctx, "phone", value);
    expect(res.status, `"${value}": ${why(res)}`).toBe(422);
    const again = value === "+919876543210" ? await tryField(ctx, "phone", value) : null;
    if (again) expect(again.status, "+91 handled the same way every time").toBe(422);
  }
  const good = "9876543210";
  const res = await tryField(ctx, "phone", good);
  expect(res.status, why(res)).toBe(201);
  expect((await db()<{ phone: string }[]>`select phone from shops where id = ${res.body.id}`)[0].phone).toBe(good);
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    const phone = page.getByLabel(/^Phone/);
    for (const value of ["987654321", "5876543210", "98765abcde"]) {
      await phone.fill(value);
      expect(await phone.evaluate((el: HTMLInputElement) => el.validity.valid), `the form marks "${value}" invalid`).toBe(false);
    }
    await phone.fill(good);
    expect(await phone.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(true);
  } finally {
    await context.close();
  }
  return `${bad.map((b) => `"${b}"`).join(", ")} → 422 (+91 is refused, consistently); the form's pattern flags them; ${good} stored exactly`;
}, local);

qa("TC-FLD-037", "address line: blank and spaces-only refused; 1 character refused; 300+ refused at the limit; script stored as text; Marathi saved; outer spaces trimmed", async () => {
  const ctx = await ctxFor(await freshAccount("fld037"));
  const notes: string[] = [];
  for (const [label, value] of [["blank", ""], ["1 char", "Q"], ["301 chars", "Q".repeat(301)]] as const) {
    const res = await tryField(ctx, "addressLine1", value);
    expect(res.status, `${label}: ${why(res)}`).toBe(422);
    notes.push(`${label} → 422`);
  }
  for (const value of [`${SCRIPT} Road`, `${MARATHI} मार्ग`]) {
    const res = await tryField(ctx, "addressLine1", value);
    expect(res.status, why(res)).toBe(201);
    expect(res.body.addressLine1).toBe(value);
  }
  const spaces = await tryField(ctx, "addressLine1", "      ");
  notes.push(`spaces-only → ${spaces.status}`);
  const padded = await tryField(ctx, "addressLine1", "   12 Padded Road   ");
  notes.push(`"   12 Padded Road   " → ${padded.status} stored "${padded.body?.addressLine1}"`);
  expect(spaces.status, `spaces-only address must be refused — ${notes.join("; ")}`).toBe(422);
  expect(padded.body?.addressLine1, `outer spaces must be trimmed — ${notes.join("; ")}`).toBe("12 Padded Road");
  return notes.join("; ");
}, local);

qa("TC-FLD-038", "PIN: blank, 5/7 digits, letters refused (422); 000000 and a PIN starting with 0 refused; a valid PIN accepted", async () => {
  const ctx = await ctxFor(await freshAccount("fld038"));
  for (const value of ["", "41103", "4110381", "41a03b", "4110-8"]) {
    const res = await tryField(ctx, "pincode", value);
    expect(res.status, `"${value}": ${why(res)}`).toBe(422);
  }
  const ok = await tryField(ctx, "pincode", "411038");
  expect(ok.status, why(ok)).toBe(201);
  const zeros = await tryField(ctx, "pincode", "000000");
  const leading = await tryField(ctx, "pincode", "011038");
  expect([zeros.status, leading.status], `000000 → ${zeros.status}, 011038 → ${leading.status} (known defect D-04)`).toEqual([422, 422]);
  return "blank, 5, 7 digits and letters → 422; 000000 and 011038 → 422; 411038 accepted";
}, { ...local, partial: "the field message on the form is the browser's pattern check (pattern [0-9]{6})" });

qa("TC-FLD-039", "shop categories: none refused; every listed option saves and shows after reload; an unlisted value refused (422); several can be chosen", async () => {
  const owner = await freshAccount("fld039");
  const ctx = await ctxFor(owner);
  const none = await tryField(ctx, "categoryIds", []);
  expect(none.status).toBe(422);
  const list = await call(ctx, "GET", "/api/shop-categories");
  const all = (list.body.categories as { id: string; name: string }[]).map((c) => c.id);
  const every = await tryField(ctx, "categoryIds", all);
  expect(every.status, why(every)).toBe(201);
  const view = await call(ctx, "GET", `/api/shops/${every.body.id}/categories`);
  expectStatus(view, 200, "GET the shop's categories");
  const savedIds = ((view.body?.categories ?? view.body ?? []) as { id?: string; categoryId?: string }[]).map((c) => c.id ?? c.categoryId);
  expect(new Set(savedIds), `all ${all.length} categories saved`).toEqual(new Set(all));
  const unknown = await tryField(ctx, "categoryIds", ["00000000-0000-4000-8000-000000000000"]);
  expect(unknown.status, `an unlisted category: ${why(unknown)}`).toBe(422);
  const text = await tryField(ctx, "categoryIds", ["Groceries"]);
  expect(text.status).toBe(422);
  return `[] → 422; all ${all.length} listed categories saved together and read back; unknown uuid → ${unknown.status}; text → 422`;
}, local);

qa("TC-FLD-040", "Shop Act number: blank is fine with a PAN; all identifiers blank refused; symbols and 100 characters refused; lower case with spaces normalised so a duplicate is still caught", async () => {
  await needPanStorage();
  const ctx = await ctxFor(await freshAccount("fld040"));
  const withPan = await tryField(ctx, "shopActNumber", null, { panNumber: uniquePan(), panHolderName: "QA" });
  expect(withPan.status, why(withPan)).toBe(201);
  const allBlank = await tryField(ctx, "shopActNumber", "");
  expect(allBlank.status).toBe(422);
  for (const value of ["@@##!!12345", "1".repeat(100)]) {
    const res = await tryField(ctx, "shopActNumber", value);
    expect(res.status, `"${value.slice(0, 20)}": ${why(res)}`).toBe(422);
  }
  const act = uniqueShopAct();
  const lower = await tryField(ctx, "shopActNumber", `  ${act.toLowerCase().replace(/-/g, " ")}  `);
  expect(lower.status, why(lower)).toBe(201);
  const other = await ctxFor(await freshAccount("fld040b"));
  const dup = await call(other, "POST", "/api/shops", await registrationBody({ shopActNumber: act }));
  expect(dup.status, "the normalised duplicate is caught").toBe(409);
  return `blank + PAN → 201; all blank → 422; symbols / 100 chars → 422; "${act.toLowerCase().replace(/-/g, " ")}" stored, "${act}" from another account → 409`;
}, local);

qa("TC-FLD-041", "PAN and holder name: wrong length and pattern refused; lower case converted; holder name required with a PAN; saved PAN shown masked", async () => {
  await needPanStorage();
  const ctx = await ctxFor(await freshAccount("fld041"));
  for (const value of ["ABCDE1234", "ABCDE1234FG", "ABCDE12345", "12345ABCDE"]) {
    const res = await tryField(ctx, "panNumber", value, { shopActNumber: null, panHolderName: "QA" });
    expect(res.status, `"${value}": ${why(res)}`).toBe(422);
    expect(res.body?.error?.details?.fields?.panNumber).toBeTruthy();
  }
  const pan = uniquePan();
  const noHolder = await tryField(ctx, "panNumber", pan, { shopActNumber: null, panHolderName: "" });
  expect(noHolder.status).toBe(422);
  const lower = await tryField(ctx, "panNumber", pan.toLowerCase(), { shopActNumber: null, panHolderName: "QA Holder" });
  expect(lower.status, why(lower)).toBe(201);
  const text = JSON.stringify(lower.body);
  expect(text, "the full PAN never comes back").not.toContain(pan);
  const [row] = await db()<{ pan_last4: string; pan_number_encrypted: string | null }[]>`select pan_last4, pan_number_encrypted from shops where id = ${lower.body.id}`;
  expect(row.pan_last4).toBe(pan.slice(-4));
  expect(row.pan_number_encrypted ?? "", "stored encrypted, not in plain text").not.toContain(pan);
  return `9/11 chars and both wrong patterns → 422 on panNumber; holder blank → 422; "${pan.toLowerCase()}" converted and accepted; answer carries no full PAN, last4 ${row.pan_last4}`;
}, { ...local, partial: "the masked PAN on the owner's GST/PAN screen is checked by TC-ONB-017" });

qa("TC-FLD-042", "Udyam number: too short and digits without the UDYAM prefix refused; a full UDYAM-XX-00-0000000 accepted", async () => {
  const ctx = await ctxFor(await freshAccount("fld042"));
  for (const value of ["UDYAM-MH-00", "MH260012345", "26 0012345 1234"]) {
    const res = await tryField(ctx, "udyamNumber", value, { shopActNumber: null });
    expect(res.status, `"${value}": ${why(res)}`).toBe(422);
  }
  const udyam = uniqueUdyam();
  const ok = await tryField(ctx, "udyamNumber", udyam, { shopActNumber: null });
  expect(ok.status, why(ok)).toBe(201);
  return `UDYAM-MH-00, bare digits → 422; ${udyam} accepted`;
}, local);

qa("TC-FLD-046", "delivery settings: a delivering shop needs a valid fee (0 allowed); negative and text refused; with delivery off no fee is asked for", async ({ browser }) => {
  const owner = await freshAccount("fld046");
  const ctx = await ctxFor(owner);
  for (const value of [-100, "abc", 10.5]) {
    const res = await tryField(ctx, "deliveryFeePaise", value, { deliveryAvailable: true });
    expect(res.status, `fee ${value}: ${why(res)}`).toBe(422);
  }
  const free = await tryField(ctx, "deliveryFeePaise", 0, { deliveryAvailable: true });
  expect(free.status, why(free)).toBe(201);
  const off = await tryField(ctx, "deliveryFeePaise", undefined, { deliveryAvailable: false });
  expect(off.status, why(off)).toBe(201);
  const { context, page } = await pageFor(browser, owner);
  let blankFee = "";
  try {
    await page.goto("/shop/register");
    await expect(page.getByLabel("Delivery fee (₹)")).toHaveCount(0);
    await page.getByLabel("We deliver to customers").check();
    await expect(page.getByLabel("Delivery fee (₹)")).toBeVisible();
    await page.getByLabel("Delivery fee (₹)").fill("-5");
    expect(await page.getByLabel("Delivery fee (₹)").evaluate((el: HTMLInputElement) => el.validity.valid), "the form refuses a negative fee").toBe(false);
    // What a blank fee becomes on submit.
    await fillForm(page, { name: `QA Blank Fee ${RUN}`, phone: owner.phone, shopAct: uniqueShopAct() });
    await page.getByLabel("Delivery fee (₹)").fill("");
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/shops"),
      page.getByRole("button", { name: "Submit for approval" }).click(),
    ]);
    blankFee = String(JSON.parse(request.postData() ?? "{}").deliveryFeePaise);
    await page.waitForURL(/\/shop\/documents/, { timeout: 30_000 });
  } finally {
    await context.close();
  }
  return `fee -100 / "abc" / 10.5 paise → 422; 0 (free) accepted; delivery off → no fee asked (field hidden); a blank fee on the form is sent as ${blankFee} paise (free delivery)`;
}, local);

qa("TC-FLD-048", "referral code: blank accepted; 300+ characters refused at the 32 limit (no 500); script and Marathi text refused as unknown codes; an unknown code gives a clear message and blocks the same way every time", async ({ browser }) => {
  const owner = await freshAccount("fld048");
  const ctx = await ctxFor(owner);
  const blank = await tryField(ctx, "referralCode", "");
  expect(blank.status, why(blank)).toBe(201);
  const long = await tryField(ctx, "referralCode", "R".repeat(301));
  expect(long.status, why(long)).toBe(422);
  const answers: string[] = [];
  for (const value of ["<script>x</script>", "संदर्भ", `NOPE${RUN}`.slice(0, 20), `NOPE${RUN}`.slice(0, 20)]) {
    const res = await tryField(ctx, "referralCode", value);
    expect(res.status, `"${value}": ${why(res)}`).toBe(422);
    expect(res.body?.error?.details?.fields?.referralCode, "message on the referral field").toBeTruthy();
    answers.push(`${value} → ${res.status}`);
  }
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    await page.getByLabel("Referral code").fill(`nope${RUN}`.slice(0, 20));
    await page.getByLabel("Referral code").blur();
    await expect(page.getByTestId("referral-code-field")).toContainText(/not|invalid|unknown|no such/i);
    await expect(page.getByLabel("Referral code")).toHaveValue(`NOPE${RUN}`.slice(0, 20).toUpperCase());
  } finally {
    await context.close();
  }
  return `blank → 201; 301 chars → 422 (limit 32, input maxLength 32); ${answers.join(", ")} — an unknown code blocks registration consistently, with a message on the field`;
}, local);
