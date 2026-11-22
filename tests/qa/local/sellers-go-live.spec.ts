/**
 * Going live through the identity-first registration (owner brief 08-Nov-2026;
 * decisions DI-11 … DI-14, Phase 2 fixes P2-D1 … P2-D6, reminders WP4):
 * TC-ONB-070 … TC-ONB-088.
 *
 *   - paying the fee takes a verified shop live, e-mails the owner, and the live
 *     and done screens lead on (070, 073, 074);
 *   - a failed payment can be retried; an unpaid shop is told it goes live on
 *     payment; one registration at a time; the IST registration date (071, 072,
 *     075, 078);
 *   - another account's GSTIN / PAN is refused or held; the same name at the
 *     same PIN is refused; a similar name or shared mobile does not hold (076,
 *     077, 079);
 *   - mandatory licence by shop type, the 90-day grace e-mail, the reminders,
 *     the automatic suspension and the grace-days setting (080 … 084);
 *   - reminders at 24 h / 72 h, the dealer notice, payment cancelling them and
 *     the 7-day abandoned draft (085 … 088).
 *
 * Local tier: fresh accounts (sellers-helpers), the local mock KYC provider,
 * the sandbox fee page, the local mail catcher, CRON_SECRET for the cron
 * entry points, and back-dated rows where the case waits for time to pass.
 * Rules changed for a check are restored in finally. The documents follow-up
 * run (daily cron) acts on every live shop of the local database, as the
 * 05.00 IST job does.
 */
import { as, pageAs } from "../lib/actors";
import { stockWholeCategory } from "../lib/category-stock";
import { db } from "../lib/db";
import {
  addressAndPin,
  answerSandbox,
  approvalLog,
  createShop,
  cron,
  dealerWithCode,
  displayDate,
  expectLive,
  homePlace,
  licenceNotice,
  liveShop,
  mailMatching,
  noticesOf,
  otherPlace,
  payFee,
  referralCode,
  registerInWizard,
  reminderDueNow,
  reminderOf,
  runFollowUp,
  rupees,
  settledStatus,
  shopDetails,
  shopName,
  slugOf,
  startDraft,
  waitForLiveScreen,
  withFollowUpToday,
  wizardOf,
  wizardPan,
  wizardStep,
  type Place,
  type UnpaidShop,
  unpaidShop,
  MAIL_SUFFIX,
} from "../lib/go-live-helpers";
import { call, expectStatus, stash, unstash, why } from "../lib/http";
import { istDate, restoreRule, ruleOf } from "../lib/money-helpers";
import { expect, need, qa } from "../lib/record";
import { ctxFor, filePart, freshAccount, gstinFor, needPanStorage, pageFor, pdf, RUN_KEY, shopRow, uniqueMobile, uniqueShopAct, type Account } from "../lib/sellers-helpers";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 360_000 };
const STASH = `sellers-go-live:${RUN_KEY}`;

interface Kept {
  owner: Account;
  shopId: string;
  shopName: string;
  gstin: string | null;
  pan: string;
  place: Place;
}

const keep = (name: string, s: UnpaidShop | Kept): Kept => stash(`${STASH}:${name}`, { owner: s.owner, shopId: s.shopId, shopName: s.shopName, gstin: s.gstin, pan: s.pan, place: s.place });

/** A shop an earlier check of this file left in `status`, or a new one made by `make`. */
async function kept(name: string, status: string, make: () => Promise<UnpaidShop | Kept>): Promise<Kept> {
  const found = unstash<Kept>(`${STASH}:${name}`);
  if (found && (await shopRow(found.shopId).catch(() => null))?.status === status) return found;
  return keep(name, await make());
}

/** The live GENERAL_TRADING shop of TC-ONB-070 (or a new one). */
const liveOne = (browser: Parameters<typeof liveShop>[0]) => kept("live", "APPROVED", () => liveShop(browser, "onb-live", { shop: { name: shopName("Onb Traders") } }));

/** The unpaid wizard shop of TC-ONB-072 (or a new one). */
const unpaidOne = () => kept("unpaid", "PENDING_APPROVAL", () => unpaidShop("onb-unpaid", { shop: { name: shopName("Onb Unpaid Stores") } }));

/** "dd/mm/yyyy" as Seller Central shows a registration date (registration-panel.tsx). */
const shownDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });

/* ------------------------------------------------------- go live on payment */

qa("TC-ONB-070", "paying the fee takes a verified shop live: the live screen, the owner's e-mail, 'Live' in Seller Central and the shop listed for its PIN", async ({ browser }) => {
  const owner = await freshAccount("onb070");
  await needPanStorage(await ctxFor(owner));
  const pan = wizardPan();
  const gstin = gstinFor(pan);
  const name = shopName("Onb Traders");
  const place = homePlace();
  const since = Date.now() - 2_000;
  const { context, page } = await pageFor(browser, owner);
  try {
    await registerInWizard(page, { code: await referralCode(), gstin, name, phone: uniqueMobile(), shopType: "GENERAL_TRADING", place });
    await answerSandbox(page, "pay");
    await waitForLiveScreen(page);
    const view = need(await wizardOf(await ctxFor(owner)), "the owner's registration");
    const shop = need(view.shop, "the shop the wizard created");
    expect(shop.status, "the shop is live").toBe("APPROVED");
    await expect(page.getByTestId("onboarding-complete")).toHaveText("Your onboarding is complete and your shop is live for accepting orders.");
    await expect(page.getByRole("heading", { name: `🎉 ${shop.name} is live` })).toBeVisible();
    keep("live", { owner, shopId: shop.id, shopName: shop.name, gstin, pan, place });

    const mail = await mailMatching(owner.email, since, /^Your onboarding is complete — /);
    expect(mail?.subject, "the owner's e-mail").toBe(`Your onboarding is complete — ${shop.name} is now live${MAIL_SUFFIX}`);

    await page.goto("/shop");
    await expect(page.getByTestId("seller-shop").getByText("Live", { exact: true }), "the Seller Central status pill").toBeVisible();

    const found = await call(await as("customer"), "GET", `/api/shops?pincode=${place.pincode}&q=${encodeURIComponent(shop.name)}`);
    expectStatus(found, 200, "the shops at the PIN");
    const ids = ((Array.isArray(found.body) ? found.body : (found.body?.shops ?? [])) as { id: string }[]).map((s) => s.id);
    expect(ids, `"${shop.name}" is listed for PIN ${place.pincode}`).toContain(shop.id);
    return `"${shop.name}" (${shop.registrationNumber}) live after the sandbox payment; e-mail "${mail?.subject}"; pill Live; listed for ${place.pincode}`;
  } finally {
    await context.close();
  }
}, { ...local, partial: "products appearing once added is TC-ONB-073 / SC-38" });

qa("TC-ONB-074", "the live screen asks how to add products; 'Upload using template' downloads GoKesari_Product_Upload_Template.xlsx and 'Upload filled file' opens /shop/product-import", async ({ browser }) => {
  const live = await liveOne(browser);
  const { context, page } = await pageFor(browser, live.owner);
  try {
    await page.goto("/shop/register");
    await expect(page.getByTestId("onboarding-complete")).toBeVisible();
    await expect(page.getByTestId("add-products-prompt")).toHaveText("Add your products so customers can select them and place orders with you. How would you like to add them?");
    await expect(page.getByTestId("add-products")).toHaveText("Add products manually");
    await expect(page.getByTestId("add-products-template")).toHaveText("Upload using template");
    await page.getByTestId("add-products-template").click();
    await expect(page.getByTestId("template-choice")).toContainText("Download the template, fill in your products, then upload the file.");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-product-template").click()]);
    expect(download.suggestedFilename(), "the template's file name").toBe("GoKesari_Product_Upload_Template.xlsx");
    await page.getByTestId("upload-product-file").click();
    await page.waitForURL(/\/shop\/product-import/);
    // "Add products manually" goes on to the shop's categories.
    await page.goto("/shop/register");
    await page.getByTestId("add-products").click();
    await expect(page.getByRole("heading", { name: "7. What does your shop sell?" })).toBeVisible();
    return `"${live.shopName}": prompt and both choices shown; template ${download.suggestedFilename()}; upload → /shop/product-import; manual → categories`;
  } finally {
    await context.close();
  }
}, local);

qa("TC-ONB-073", "the done screen: 'Registration successful 🎉' with 'Get paid' and 'How you deliver', 'Go to my shop' and 'Register another shop' — each opens the right page", async ({ browser }) => {
  const live = await liveOne(browser);
  const ctx = await ctxFor(live.owner);
  // The products step done as the owner does it: a category and its products listed.
  const category = need(world().category?.id, "the world's QA category");
  expectStatus(await call(ctx, "POST", `/api/shops/${live.shopId}/product-categories`, { categoryId: category }), [200, 201], "add the QA category");
  await stockWholeCategory(ctx, live.shopId, category);
  const { context, page } = await pageFor(browser, live.owner);
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: "Registration successful 🎉" })).toBeVisible();
    const tiles = page.getByTestId("done-next-steps");
    await expect(tiles.getByRole("link", { name: /Get paid/ })).toHaveAttribute("href", "/shop/bank-account");
    await expect(tiles.getByRole("link", { name: /How you deliver/ })).toHaveAttribute("href", "/shop/setup/delivery");
    const mine = page.getByRole("link", { name: "Go to my shop", exact: true });
    const another = page.getByRole("link", { name: "Register another shop", exact: true });
    await expect(mine).toHaveAttribute("href", "/shop");
    await expect(another).toHaveAttribute("href", "/shop/register?new=1");

    await tiles.getByRole("link", { name: /Get paid/ }).click();
    await page.waitForURL(/\/shop\/bank-account/);
    await page.goto("/shop/register");
    await page.getByTestId("done-next-steps").getByRole("link", { name: /How you deliver/ }).click();
    await page.waitForURL(/\/shop\/setup\/delivery/);
    await expect(page.getByRole("heading", { name: "How do you deliver?" })).toBeVisible();
    await page.goto("/shop/register");
    await page.getByRole("link", { name: "Go to my shop", exact: true }).click();
    await page.waitForURL((u) => u.pathname === "/shop");
    await page.goto("/shop/register");
    await page.getByRole("link", { name: "Register another shop", exact: true }).click();
    await page.waitForURL(/\/shop\/register\?new=1/);
    await expect(page.getByRole("heading", { name: "Verify your business" })).toBeVisible();
    return `"${live.shopName}": done screen; Get paid → /shop/bank-account, How you deliver → /shop/setup/delivery, Go to my shop → /shop, Register another shop → a new "Verify your business"`;
  } finally {
    await context.close();
  }
}, local);

/* -------------------------------------------- an unpaid shop, one at a time */

qa("TC-ONB-072", "an unpaid wizard shop: 'Pay the registration fee … goes live as soon as the payment is confirmed', steps Shop registered / Registration fee paid / Shop live, 'payment pending' badges; the owner still shops", async ({ browser }) => {
  const shop = keep("unpaid", await unpaidShop("onb072", { shop: { name: shopName("Onb Unpaid Stores") } }));
  const fee = (await wizardOf(await ctxFor(shop.owner)))?.shop?.feeDuePaise ?? 0;
  const next = `Pay the registration fee of ${rupees(fee)} online. Your shop goes live as soon as the payment is confirmed.`;
  const { context, page } = await pageFor(browser, shop.owner);
  try {
    await page.goto("/shop");
    await expect(page.getByText(next).filter({ visible: true }).first(), "the seller home's next step").toBeVisible();
    await expect(page.getByTestId("seller-shop").getByText("Payment pending", { exact: true }), "the header pill").toBeVisible();

    await page.goto("/shop/manage/today");
    const stage = page.getByTestId("onboarding-stage");
    await expect(stage).toContainText("Payment pending");
    await expect(stage).toContainText("✓ Shop registered");
    await expect(stage).toContainText("2. Registration fee paid");
    await expect(stage).toContainText("3. Shop live");
    await expect(stage).not.toContainText("Approved by GoKesari");
    await expect(stage).toContainText(next);

    await page.goto("/shop/manage/registration");
    await expect(page.getByText("payment pending", { exact: true }), "Registration and fee: shop status").toBeVisible();

    // Still a customer: the storefront opens and an item goes into the cart.
    const listing = need(world().listings.packaged, "the world's packaged listing");
    const slug = need(world().shops.A?.slug, "shop A's slug");
    const store = await page.goto(`/shops/${slug}`);
    expect(store?.status(), "shop A's storefront").toBe(200);
    const ctx = await ctxFor(shop.owner);
    const added = await call(ctx, "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 1 });
    expectStatus(added, [200, 201], "the owner adds an item to the cart");
    await call(ctx, "DELETE", "/api/cart");
    return `"${shop.shopName}" fee ${rupees(fee)}: home and Today's work say "${next}"; steps ✓ Shop registered · 2. Registration fee paid · 3. Shop live; badges "payment pending" / "Payment pending"; cart add ${added.status}`;
  } finally {
    await context.close();
  }
}, local);

qa("TC-ONB-075", "the registration date is the IST date — stored, on Seller Central's Registration and fee, and in the shop record staff read", async ({ browser }) => {
  const shop = await unpaidOne();
  const today = istDate(0);
  const [row] = await db()<{ d: string }[]>`select registration_date::text as d from shops where id = ${shop.shopId}`;
  expect(row.d, "stored registration date = today in IST").toBe(today);
  const record = await call(await as("admin"), "GET", `/api/shops/${shop.shopId}`);
  expectStatus(record, 200, "the shop record as admin");
  expect(record.body.registrationDate, "the shop record (admin)").toBe(today);
  const { context, page } = await pageFor(browser, shop.owner);
  try {
    await page.goto("/shop/manage/registration");
    const term = page.getByRole("term").filter({ hasText: "Registration date" });
    await expect(term.locator("..").getByRole("definition")).toHaveText(shownDate(today));
  } finally {
    await context.close();
  }
  const ist = new Date(Date.now() + 330 * 60_000);
  const window = ist.getUTCHours() < 5 || (ist.getUTCHours() === 5 && ist.getUTCMinutes() < 30);
  return `registered ${today} (IST) — shown ${shownDate(today)}; ${window ? "run between 00.00 and 05.30 IST: the UTC date was the day before" : "run outside 00.00–05.30 IST, so the UTC date was the same"}`;
}, { ...local, partial: "decisive only when run between 00.00 and 05.30 IST (the detail says whether it was); no admin screen shows the date — the admin's shop record (GET /api/shops/<id>) is read instead" });

qa("TC-ONB-078", "while one wizard shop is unpaid, /shop/register?new=1 says '<shop> still has its registration fee to pay…' and 'Pay the registration fee' opens that shop's payment", async ({ browser }) => {
  const shop = await unpaidOne();
  const message = `${shop.shopName} still has its registration fee to pay. Please pay it first — you can add another shop after that.`;
  const refused = await call(await ctxFor(shop.owner), "POST", "/api/shops/registration-draft/referral", { referralCode: await referralCode() });
  expect(refused.status, `a new registration's first step — ${why(refused)}`).toBe(409);
  expect(refused.body?.error?.message).toBe(message);
  const { context, page } = await pageFor(browser, shop.owner);
  try {
    await page.goto("/shop/register?new=1");
    const waiting = page.getByTestId("registration-waiting");
    await expect(waiting).toContainText(message);
    await expect(page.getByTestId("registration-tiles")).toHaveCount(0);
    const pay = waiting.getByRole("link", { name: "Pay the registration fee" });
    await expect(pay).toHaveAttribute("href", `/shop/registration-fee?shop=${shop.shopId}`);
    await pay.click();
    await page.waitForURL(/\/shop\/registration-fee\?shop=/);
    await expect(page.getByRole("heading", { name: "Registration fee" })).toBeVisible();
    await expect(page.getByText(shop.shopName, { exact: true }).first()).toBeVisible();
    return `"${message}"; the API refuses a new registration (409); the button opens /shop/registration-fee?shop=${shop.shopId}`;
  } finally {
    await context.close();
  }
}, local);

qa("TC-ONB-071", "a failed fee payment takes no money and says so; the retry succeeds, the shop goes live, and only one payment is recorded", async ({ browser }) => {
  const shop = await unpaidOne();
  const { context, page } = await pageFor(browser, shop.owner);
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: "Pay the registration fee" })).toBeVisible();
    await page.getByRole("button", { name: /^Pay .+ now$/ }).click();
    await page.waitForURL(/\/orders\/pay\/sandbox\//, { timeout: 45_000 });
    await answerSandbox(page, "fail");
    // Back on the fee page, and on the wizard's payment step.
    await expect(page.getByText("Your last payment did not go through")).toBeVisible();
    await expect(page.getByText("No money was taken for it. You can try again below.")).toBeVisible();
    expect((await shopRow(shop.shopId)).status, "not live after the failure").toBe("PENDING_APPROVAL");
    await page.goto("/shop/register");
    const failed = page.getByTestId("fee-payment-failed");
    await expect(failed).toContainText("Your last payment did not go through");
    await expect(failed).toContainText("No money was taken for it. You can try again below.");

    await page.getByRole("button", { name: /^Pay .+ now$/ }).click();
    await page.waitForURL(/\/orders\/pay\/sandbox\//, { timeout: 45_000 });
    await answerSandbox(page, "pay");
    await waitForLiveScreen(page);
    await expectLive(shop.shopId);
    keep("paid-after-retry", shop);
  } finally {
    await context.close();
  }
  const payments = await db()<{ n: number }[]>`select count(*)::int as n from shop_payments where shop_id = ${shop.shopId} and payment_type = 'REGISTRATION_FEE'`;
  const intents = await db()<{ status: string; n: number }[]>`
    select status, count(*)::int as n from payment_intents where purpose = 'SHOP_REGISTRATION_FEE' and reference_id = ${shop.shopId} group by status order by status`;
  expect(payments[0].n, "one registration-fee payment on the shop's ledger").toBe(1);
  expect(intents.find((i) => i.status === "CAPTURED")?.n ?? 0, "one captured payment").toBe(1);
  expect(intents.find((i) => i.status === "FAILED")?.n ?? 0, "the failed attempt").toBe(1);
  const row = await shopRow(shop.shopId);
  expect(row.fee_payment_status).toBe("PAID");
  return `failure note on the fee page and the wizard; retry → live; ledger ${payments[0].n} payment; intents ${intents.map((i) => `${i.status}×${i.n}`).join(", ")}; fee ${row.fee_payment_status}`;
}, local);

/* --------------------------------------------------------------- duplicates */

qa("TC-ONB-076", "another account's GSTIN or PAN is refused on 'Verify your business' with the other shop's state, before any check", async ({ browser }) => {
  const live = await liveOne(browser);
  const gstin = need(live.gstin, "the live shop's GSTIN");
  const pending = await unpaidShop("onb076-pending", { shop: { name: shopName("Onb Waiting Mart") } });
  const tail = "If it is yours, sign in with the account that registered it, or contact support.";
  const other = await freshAccount("onb076");
  const ctx = await ctxFor(other);

  const onLive = await call(ctx, "POST", "/api/shops/registration-draft/gstin", { gstin, consent: true });
  expect(onLive.status, why(onLive)).toBe(409);
  expect(onLive.body.error.message).toBe(`A shop with this GSTIN is already registered on GoKesari by another account. It is live on GoKesari. ${tail}`);
  expect(onLive.body.error.details?.fields?.gstin).toBe("This GSTIN is already registered.");

  const onPending = await call(ctx, "POST", "/api/shops/registration-draft/gstin", { gstin: need(pending.gstin, "the pending shop's GSTIN"), consent: true });
  expect(onPending.status, why(onPending)).toBe(409);
  expect(onPending.body.error.message).toBe(`A shop with this GSTIN is already registered on GoKesari by another account. It is waiting for its registration fee or admin approval. ${tail}`);

  const onPan = await call(ctx, "POST", "/api/shops/registration-draft/pan", { pan: live.pan, declaration: true, consent: true });
  expect(onPan.status, why(onPan)).toBe(409);
  expect(onPan.body.error.message).toBe(`A shop with this PAN is already registered on GoKesari by another account. It is live on GoKesari. ${tail}`);
  expect(onPan.body.error.details?.fields?.pan).toBe("This PAN is already registered.");
  const nothing = await db()<{ n: number }[]>`select count(*)::int as n from shop_registration_drafts where owner_id = ${other.id} and gst_status <> 'NOT_SUBMITTED'`;
  expect(nothing[0].n, "no number was checked for this account").toBe(0);

  // The same refusal on the screen.
  const { context, page } = await pageFor(browser, other);
  try {
    await page.goto("/shop/register");
    await page.getByTestId("wizard-referral-code").fill(await referralCode());
    await page.getByTestId("gstin-input").fill(gstin);
    await page.getByLabel("I agree that GoKesari checks this number with the government record.").check();
    await page.getByTestId("verify-identity").click();
    await expect(page.getByText(`A shop with this GSTIN is already registered on GoKesari by another account. It is live on GoKesari. ${tail}`)).toBeVisible();
    await expect(page.getByText("This GSTIN is already registered.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Confirm your shop address" })).toHaveCount(0);
  } finally {
    await context.close();
  }
  return `live shop's GSTIN and PAN → "It is live on GoKesari."; a shop waiting for its fee → "It is waiting for its registration fee or admin approval."; refused before any check, on the API and the Verify screen`;
}, { ...local, partial: "the 'registered but not active' sentence is the next check (after TC-ONB-083 suspends a shop)" });

qa("TC-ONB-076", "a GSTIN taken by another account after this owner verified it: the paid shop is held — 'Payment received — pending admin approval', and admin sees it waiting as a likely duplicate", async ({ browser }) => {
  // This owner verifies a GSTIN no shop has yet …
  const pan = wizardPan();
  const gstin = gstinFor(pan);
  const late = await startDraft("onb076-late", { gstin });
  // … then another account registers a shop with it and goes live.
  const first = await liveShop(browser, "onb076-first", { gstin, shop: { name: shopName("Onb First Agencies") } });
  // This owner finishes elsewhere (another PIN and name) and pays.
  await addressAndPin(late, otherPlace());
  await shopDetails(late, { name: shopName("Onb Second Agencies") });
  const created = await createShop(late);
  await payFee(browser, late.owner, created.shopId, "pay");
  let log = await approvalLog(created.shopId);
  for (let i = 0; i < 20 && !log; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    log = await approvalLog(created.shopId);
  }
  expect((await shopRow(created.shopId)).fee_payment_status, "the fee is paid").toBe("PAID");
  expect(await settledStatus(created.shopId, "APPROVED", 5_000), "held, not live").toBe("PENDING_APPROVAL");
  expect(log?.outcome).toBe("PENDING");
  expect(log?.reasons.join("; ")).toContain("likely duplicate of another shop (gstin, pan)");
  expect((await wizardOf(late.ctx))?.nextStep).toBe("WAITING");

  const { context, page } = await pageFor(browser, late.owner);
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: "Payment received — pending admin approval" })).toBeVisible();
    await expect(page.getByText(`${created.shopName} is pending admin approval. We'll email you as soon as your shop is live.`)).toBeVisible();
  } finally {
    await context.close();
  }
  const admin = await pageAs(browser, "admin");
  try {
    await admin.page.goto("/admin/shops/instant-approvals?outcome=PENDING");
    const item = admin.page.getByTestId("instant-approvals").getByRole("listitem").filter({ hasText: created.shopName });
    await expect(item).toContainText("waiting for admin");
    await expect(item).toContainText("likely duplicate of another shop (gstin, pan)");
  } finally {
    await admin.context.close();
  }
  return `"${first.shopName}" took the GSTIN first; "${created.shopName}" paid and is held: ${log?.reasons.join("; ")}`;
}, local);

qa("TC-ONB-077", "the same owner cannot register a second shop with the same name at the same PIN: refused on the shop step (P2-D3)", async ({ browser }) => {
  const live = await liveOne(browser);
  const status = "This shop is already registered and live on GoKesari. If you're the owner and need to update details, log in to your account or contact support.";
  const line = "You have already registered a shop with this name at this PIN code";
  // Another business (another GSTIN) of the same owner, at the same PIN, with the same name.
  const d = await startDraft("onb077", { owner: live.owner });
  await addressAndPin(d, live.place);
  const body = { name: live.shopName, ownerName: null, phone: uniqueMobile(), email: null, shopType: "GENERAL_TRADING", categoryIds: [], annualTurnoverRupees: 15_00_000, couponCode: null, referralCode: null, employeeId: null };
  const refused = await call(d.ctx, "POST", "/api/shops/registration-draft/details", body);
  expect(refused.status, why(refused)).toBe(409);
  expect(refused.body.error.message).toBe(`${line}. ${status}`);
  expect(refused.body.error.details?.fields?.name).toBe(line);

  const { context, page } = await pageFor(browser, live.owner);
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: "Contact and shop details" })).toBeVisible();
    await page.getByTestId("shop-name").fill(live.shopName);
    await page.getByTestId("shop-phone").fill(uniqueMobile());
    await page.getByTestId("shop-type").selectOption("GENERAL_TRADING");
    const slabs = page.getByTestId("turnover-slabs").getByRole("radio");
    if ((await slabs.count()) > 0) await slabs.first().click();
    await page.getByTestId("shop-continue").click();
    await expect(page.getByText(`${line}. ${status}`)).toBeVisible();
    await expect(page.getByText(line, { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }

  // With the first shop's own GSTIN (same PAN) the PAN rule matches first.
  await wizardStep(d.ctx, "gstin", { gstin: need(live.gstin, "the live shop's GSTIN"), consent: true }, "verify the first shop's GSTIN again");
  const samePan = await call(d.ctx, "POST", "/api/shops/registration-draft/details", body);
  expect(samePan.status, why(samePan)).toBe(409);
  expect(samePan.body.error.message).toMatch(/^PAN number already registered \(.+\)\. This shop is already registered and live on GoKesari\./);
  return `another GSTIN: "${refused.body.error.message}"; the same GSTIN: "${samePan.body.error.message}"`;
}, local);

qa("TC-ONB-079", "a similar name at the same place and a shared mobile do not hold a verified, paid wizard shop: it goes live and the match is only recorded", async ({ browser }) => {
  const live = await liveOne(browser);
  const [first] = await db()<{ phone: string }[]>`select phone from shops where id = ${live.shopId}`;
  const second = await liveShop(browser, "onb079", { place: live.place, shop: { name: live.shopName, phone: first.phone } });
  const log = need(await approvalLog(second.shopId), "the instant-approval decision");
  expect(log.outcome).toBe("APPROVED");
  const duplicate = (log.evidence.duplicate ?? {}) as { kind?: string; reasons?: string[] };
  expect(duplicate.reasons ?? [], "the shared mobile is recorded").toContain("MOBILE");
  expect((duplicate.reasons ?? []).some((r) => r === "NAME_NEARBY" || r === "NAME_SAME_PIN"), `the similar name is recorded (${(duplicate.reasons ?? []).join(", ")})`).toBe(true);
  return `"${second.shopName}" beside "${live.shopName}", same mobile: APPROVED at once; recorded as possible ${duplicate.kind?.toLowerCase()} (${(duplicate.reasons ?? []).join(", ")})`;
}, local);

/* ---------------------------------------------- licences, grace, follow-up */

const LICENCES: [string, string | null][] = [
  ["BAKERY", "FSSAI licence"],
  ["GROCERY_KIRANA", "FSSAI licence"],
  ["PHARMACY", "Drug licence"],
  ["DOCTOR_CLINIC", "Medical registration"],
  ["SUPER_SPECIALITY_CLINIC", "Medical registration"],
  ["PROFESSIONAL_OFFICE", "Professional registration (Bar Council, ICAI or ICSI)"],
  ["GENERAL_TRADING", null],
  ["STATIONERY_STORE", null],
];

qa("TC-ONB-080", "the shop type decides the mandatory licence: FSSAI before payment for food (DF-08), the 90-day grace notice for pharmacy, clinics and professional offices; none for a general store", async ({ browser }) => {
  const d = await startDraft("onb080");
  const view = await addressAndPin(d);
  const { context, page } = await pageFor(browser, d.owner);
  const seen: string[] = [];
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: "Contact and shop details" })).toBeVisible();
    for (const [type, licence] of LICENCES) {
      await page.getByTestId("shop-type").selectOption(type);
      const notice = page.getByTestId("licence-grace-notice");
      if (licence) {
        await expect(notice, type).toContainText(licenceNotice(licence, view.licenceGraceDays));
        seen.push(`${type}: ${licence}`);
      } else {
        await expect(notice, type).toHaveCount(0);
        seen.push(`${type}: none`);
      }
    }
  } finally {
    await context.close();
  }
  return `${view.licenceGraceDays} days — ${seen.join("; ")}`;
}, { ...local, partial: "the FSSAI hold is the next check (DF-08)" });

qa(["TC-ONB-080", "TC-ONB-081"], "a food shop cannot pay without its FSSAI licence (DF-08); with it on file it goes live and gets no 90-day FSSAI e-mail", async ({ browser }) => {
  // Held: no FSSAI on the documents screen.
  const d = await startDraft("onb081-food");
  await addressAndPin(d);
  await shopDetails(d, { name: shopName("Onb Bakers"), shopType: "BAKERY" });
  const created = await wizardStep(d.ctx, "submit", undefined, "create the shop");
  expect(created.nextStep).toBe("DOCUMENTS");
  const held = await call(d.ctx, "POST", "/api/shops/registration-draft/documents-step", { promise: true });
  expect(held.status, "no FSSAI: the documents screen does not go on").toBe(409);
  expect(held.body.error.message).toContain("FSSAI licence is required by law");
  // With the FSSAI number verified (mock vendor) it pays and goes live, with no FSSAI grace e-mail.
  const since = Date.now() - 2_000;
  const shop = await liveShop(browser, "onb081-food-ok", { shop: { name: shopName("Onb Sweets"), shopType: "BAKERY" }, fssai: "11521998000123" });
  const notices = await noticesOf(shop.owner.id, "shop.licence_grace_notice", new Date(since), 3_000);
  expect(notices, "no 'upload within 90 days' for FSSAI").toHaveLength(0);
  return `held without FSSAI (409); "${shop.shopName}" (BAKERY) live with FSSAI, no grace e-mail`;
}, local);

qa("TC-ONB-081", "the grace e-mail of another licence type: a pharmacy is e-mailed the drug-licence notice with the due date = go-live date + grace days", async ({ browser }) => {
  const since = Date.now() - 2_000;
  const shop = keep("pharmacy", await liveShop(browser, "onb081-pharmacy", { shop: { name: shopName("Onb Chemists"), shopType: "PHARMACY" } }));
  const graceDays = (await ruleOf("shopDocumentFollowUp")).value.graceDays as number;
  const due = displayDate(istDate(graceDays));
  const mail = await mailMatching(shop.owner.email, since, /^Upload your licence within/);
  expect(mail?.subject).toBe(`Upload your licence within ${graceDays} days — ${shop.shopName}${MAIL_SUFFIX}`);
  const inApp = await noticesOf(shop.owner.id, "shop.licence_grace_notice", new Date(since), 10_000);
  expect(inApp.length, "one notice in the app as well").toBe(1);
  expect(inApp[0].body).toBe(`${licenceNotice("Drug licence", graceDays)} Please upload it on GoKesari by ${due}. We will remind you every 15 days until then.`);
  return `"${shop.shopName}" (PHARMACY): "${mail?.subject}", due ${due}`;
}, { ...local, partial: "the food (FSSAI) wording is asserted by the previous check" });

/** The grace end the follow-up prints: the IST date of approval + graceDays. */
async function graceLabel(shopId: string, graceDays: number) {
  const [row] = await db()<{ approved_at: Date }[]>`select approved_at from shops where id = ${shopId}`;
  return displayDate(new Date(row.approved_at.getTime() + graceDays * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10));
}

/** The owner uploads what the follow-up chases: the Shop Act number and the drug licence. */
async function uploadPharmacyDocuments(owner: Account, shopId: string) {
  const ctx = await ctxFor(owner);
  expectStatus(await call(ctx, "POST", `/api/shops/${shopId}/verifications`, { docType: "SHOP_ACT", number: uniqueShopAct(), consent: true }), 200, "submit the Shop Act licence");
  const number = `MH-PZ1-${String(Date.now()).slice(-6)}`;
  const res = await call(ctx, "POST", `/api/shops/${shopId}/legal-documents`, undefined, {
    multipart: { docType: "DRUG_LICENCE", number, expiryDate: istDate(365), file: filePart("drug-licence.pdf", pdf(["Drug licence", number], "drug-licence.pdf"), "application/pdf") },
  });
  expectStatus(res, 201, "upload the drug licence");
}

qa("TC-ONB-082", "the follow-up reminds a live shop in grace — 'If they are still missing on <date>, your shop will be suspended automatically. We will remind you every 15 days until then.' — and stops once the documents are in", async ({ browser }) => {
  const shop = await kept("pharmacy", "APPROVED", () => liveShop(browser, "onb082", { shop: { name: shopName("Onb Medicals"), shopType: "PHARMACY" } }));
  return withFollowUpToday({}, async () => {
    const graceDays = (await ruleOf("shopDocumentFollowUp")).value.graceDays as number;
    const until = await graceLabel(shop.shopId, graceDays);
    const since = new Date(Date.now() - 2_000);
    const first = await runFollowUp();
    const [reminder] = await noticesOf(shop.owner.id, "shop.documents_follow_up", since, 10_000);
    expect(reminder?.title).toMatch(/^Submit your shop documents — reminder \d+$/);
    expect(reminder?.body).toContain(`${shop.shopName} is live, but these documents are still missing: Shop Act (Shops & Establishments) certificate, Drug licence.`);
    expect(reminder?.body).toContain(`Your shop went live before its documents; they are due by ${until}.`);
    expect(reminder?.body).toContain(`If they are still missing on ${until}, your shop will be suspended automatically. We will remind you every 15 days until then.`);
    const mail = await mailMatching(shop.owner.email, since.getTime(), /^Submit your shop documents — reminder/);
    expect(mail?.subject, "by e-mail too").toBe(`${reminder?.title}${MAIL_SUFFIX}`);

    await uploadPharmacyDocuments(shop.owner, shop.shopId);
    const after = new Date();
    const second = await runFollowUp();
    const rows = await db()<{ n: number }[]>`select count(*)::int as n from shop_document_reminders where shop_id = ${shop.shopId}`;
    expect(rows[0].n, "nothing is chased any more: the reminder count is cleared").toBe(0);
    expect(await noticesOf(shop.owner.id, "shop.documents_follow_up", after), "no reminder after the upload").toHaveLength(0);
    return `"${reminder?.title}" (reminded ${first.reminded}); due ${until}; after the Shop Act and drug licence are in: cleared ${second.cleared}, no reminder`;
  });
}, { ...local, partial: "run with a pharmacy (drug licence + Shop Act): a food shop does not go live without FSSAI on this branch (see TC-ONB-080/081); the 15-day cadence is the rule's reminder days (1st and 15th), made today here" });

qa("TC-ONB-083", "after the grace period the follow-up suspends the shop: the owner sees why, admins and operators get 'Shop suspended for missing documents', the public page says it is not taking orders", async ({ browser }) => {
  const shop = await liveShop(browser, "onb083", { shop: { name: shopName("Onb Pharma"), shopType: "PHARMACY" } });
  // Grace 15 days (the setting's minimum), approved 16 days ago.
  await db()`update shops set approved_at = now() - interval '16 days' where id = ${shop.shopId}`;
  const since = new Date(Date.now() - 2_000);
  const result = await withFollowUpToday({ graceDays: 15 }, () => runFollowUp());
  expect((await shopRow(shop.shopId)).status, "suspended by the run").toBe("SUSPENDED");
  keep("suspended", shop);
  const documents = "Shop Act (Shops & Establishments) certificate, Drug licence";

  const staff = [need(world().users.admin?.id, "the admin account"), need(world().users.ops?.id, "the operator account")];
  for (const id of staff) {
    const [notice] = (await noticesOf(id, "support.shop_suspended_documents", since, 10_000)).filter((n) => n.title.includes(shop.shopName));
    expect(notice?.title, `staff ${id}`).toBe(`Shop suspended for missing documents: ${shop.shopName}`);
    expect(notice?.body).toBe(`${shop.shopName} was suspended automatically because these documents were not uploaded in time: ${documents}.`);
  }
  const { context, page } = await pageFor(browser, shop.owner);
  try {
    await page.goto("/shop/manage/today");
    const banner = page.getByTestId("suspension-notice");
    await expect(banner).toContainText("Your shop is suspended");
    await expect(banner).toContainText(`Reason: Shop documents not submitted within 15 days of approval without them: ${documents}.`);
    await expect(banner).toContainText(`What to do: Upload ${documents} on GoKesari (Shop → Verification). Our team reinstates the shop once they are verified.`);
    await page.goto(`/shops/${await slugOf(shop.shopId)}`);
    await expect(page.getByTestId("shop-suspended")).toContainText("This shop is suspended and is not taking orders.");
  } finally {
    await context.close();
  }
  return `"${shop.shopName}" SUSPENDED by the run (suspended ${result.suspended}); admin and operator told; owner banner and public page as expected`;
}, { ...local, partial: "run with a pharmacy (drug licence + Shop Act) — a food shop does not go live without FSSAI on this branch (TC-ONB-080/081); SC-39 runs the food journey; graceDays 15 and the approval back-dated 16 days" });

qa("TC-ONB-076", "a GSTIN whose shop is suspended: 'It is registered but not active at the moment.'", async ({ browser }) => {
  const shop = await kept("suspended", "SUSPENDED", async () => {
    const s = await liveShop(browser, "onb076-suspended", { shop: { name: shopName("Onb Closed Traders") } });
    await db()`update shops set status = 'SUSPENDED' where id = ${s.shopId}`;
    return s;
  });
  const other = await freshAccount("onb076-susp");
  const res = await call(await ctxFor(other), "POST", "/api/shops/registration-draft/gstin", { gstin: need(shop.gstin, "the suspended shop's GSTIN"), consent: true });
  expect(res.status, why(res)).toBe(409);
  expect(res.body.error.message).toBe(
    "A shop with this GSTIN is already registered on GoKesari by another account. It is registered but not active at the moment. If it is yours, sign in with the account that registered it, or contact support.",
  );
  return res.body.error.message;
}, local);

qa("TC-ONB-084", "the licence grace days setting (shopDocumentFollowUp.graceDays) takes 15 to 365 only: 14 and 366 are refused, 15 and 365 saved", async ({ browser }) => {
  const before = await ruleOf("shopDocumentFollowUp");
  const admin = await as("admin");
  const { context, page } = await pageAs(browser, "admin");
  const seen: string[] = [];
  try {
    for (const days of [14, 366]) {
      const api = await call(admin, "PUT", "/api/admin/settings", { key: "shopDocumentFollowUp", value: { ...before.value, graceDays: days } });
      expect(api.status, why(api)).toBe(422);
      expect(api.body.error.message).toBe("That value is not allowed for this setting.");
      expect(api.body.error.details?.fields?.graceDays, `${days}: the field is named`).toBeTruthy();
    }
    await page.goto("/admin/settings?rule=shopDocumentFollowUp");
    const editor = page.getByLabel("shopDocumentFollowUp settings (JSON)");
    for (const days of [14, 366, 15, 365]) {
      await editor.fill(JSON.stringify({ ...before.value, graceDays: days }, null, 2));
      await page.getByRole("button", { name: "Save", exact: true }).click();
      if (days === 14 || days === 366) {
        await expect(page.getByText(/^graceDays: /)).toBeVisible();
        expect((await ruleOf("shopDocumentFollowUp")).value.graceDays, `${days} not saved`).toBe(before.value.graceDays);
        seen.push(`${days} refused`);
      } else {
        await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
        await expect.poll(async () => (await ruleOf("shopDocumentFollowUp")).value.graceDays, { timeout: 10_000 }).toBe(days);
        seen.push(`${days} saved`);
      }
    }
  } finally {
    await context.close();
    await restoreRule(before);
  }
  expect((await ruleOf("shopDocumentFollowUp")).value.graceDays, "restored").toBe(before.value.graceDays);
  return `${seen.join(", ")}; restored ${before.value.graceDays}`;
}, local);

/* ------------------------------------------------- reminders and abandoning */

const HOUR = 3_600_000;

qa("TC-ONB-085", "an unfinished registration is reminded 24 h after its last step ('Your shop is 4 steps from going live' / 'You stopped at \"Confirm your shop address\"…') and once more 48 h later, then not again", async () => {
  const d = await startDraft("onb085");
  const view = need(await wizardOf(d.ctx), "the registration");
  const scheduled = need(await reminderOf(view.id), "the reminder scheduled by the last step");
  expect(scheduled.stage).toBe(1);
  expect(scheduled.payload.step).toBe("ADDRESS");
  expect(Math.abs(scheduled.due_at.getTime() - (Date.now() + 24 * HOUR)), "due 24 h after the last step").toBeLessThan(10 * 60_000);

  const since = new Date(Date.now() - 2_000);
  await reminderDueNow(view.id);
  await cron("/api/cron/every-minute");
  const [first] = await noticesOf(d.owner.id, "shop.registration_idle", since, 10_000);
  expect(first?.title).toBe("Your shop is 4 steps from going live");
  expect(first?.body).toMatch(/^You stopped at "Confirm your shop address"\. Everything you entered is saved — continue where you left off: https?:\/\/\S+\/shop\/register$/);
  const mail = await mailMatching(d.owner.email, since.getTime(), /^Your shop is \d+ steps? from going live — Gokesari$/);
  expect(mail?.subject, "by e-mail too").toBe(`${first?.title}${MAIL_SUFFIX}`);
  const second = need(await reminderOf(view.id), "the reminder row");
  expect(second.stage, "moved to the 72 h reminder").toBe(2);
  expect(Math.abs(second.due_at.getTime() - (Date.now() + 48 * HOUR)), "due 48 h later").toBeLessThan(10 * 60_000);

  await reminderDueNow(view.id);
  await cron("/api/cron/every-minute");
  await expect.poll(async () => (await noticesOf(d.owner.id, "shop.registration_idle", since)).length, { message: "the 72 h reminder", timeout: 10_000 }).toBe(2);
  const done = need(await reminderOf(view.id), "the reminder row");
  expect(done.sent_at, "the second reminder is the last").not.toBeNull();
  await cron("/api/cron/every-minute");
  expect(await noticesOf(d.owner.id, "shop.registration_idle", since), "no third reminder").toHaveLength(2);
  return `"${first?.title}" — ${first?.body}; second reminder 48 h later; then nothing`;
}, { ...local, partial: "the 24 h and 48 h waits are taken by bringing the reminder due (scheduled_notices.due_at), the time a person would wait" });

qa("TC-ONB-086", "the dealer whose code was used is told at the 72 h reminder: 'A shop with your code has not finished registering' (in the app; e-mail off by default)", async () => {
  const dealer = await dealerWithCode("onb086");
  const d = await startDraft("onb086", { code: dealer.code });
  const view = need(await wizardOf(d.ctx), "the registration");
  const since = new Date(Date.now() - 2_000);
  await reminderDueNow(view.id);
  await cron("/api/cron/every-minute");
  expect(await noticesOf(dealer.user.id, "dealer.registration_idle", since, 3_000), "not at the 24 h reminder").toHaveLength(0);
  await reminderDueNow(view.id);
  await cron("/api/cron/every-minute");
  const [notice] = await noticesOf(dealer.user.id, "dealer.registration_idle", since, 10_000);
  expect(notice?.title).toBe("A shop with your code has not finished registering");
  expect(notice?.body).toBe(`QA onb086 started registering a shop with your code ${dealer.code} 3 days ago and stopped at "Confirm your shop address". A call may help them finish.`);
  expect(await mailMatching(dealer.user.email, since.getTime(), /A shop with your code/, 5_000), "no e-mail by default").toBeNull();
  return `dealer told at 72 h: "${notice?.title}" — ${notice?.body}`;
}, local);

qa("TC-ONB-087", "paying cancels the pending reminder: no reminder is sent after payment", async ({ browser }) => {
  const shop = await liveShop(browser, "onb087", { shop: { name: shopName("Onb Paid Early") } });
  const [draft] = await db()<{ id: string }[]>`select id from shop_registration_drafts where shop_id = ${shop.shopId}`;
  need(await reminderOf(draft.id), "the reminder the registration scheduled");
  const since = new Date(Date.now() - 2_000);
  // The reminder as it stood before payment, coming due now (the owner paid and did not come back) …
  await db()`update scheduled_notices set cancelled_at = null, sent_at = null, stage = 1, due_at = now() - interval '1 minute' where key = ${`registration-idle:${draft.id}`}`;
  await cron("/api/cron/every-minute");
  // … and the 72 h one after it.
  await reminderDueNow(draft.id);
  await cron("/api/cron/every-minute");
  expect(await noticesOf(shop.owner.id, "shop.registration_idle", since, 3_000), "no reminder after payment").toHaveLength(0);
  expect(await mailMatching(shop.owner.email, since.getTime(), /from going live — Gokesari$/, 3_000), "no reminder e-mail after payment").toBeNull();
  // Back in the wizard, the reminder is cancelled outright.
  await db()`update scheduled_notices set cancelled_at = null, sent_at = null, stage = 1, due_at = now() + interval '1 day' where key = ${`registration-idle:${draft.id}`}`;
  expect((await wizardOf(await ctxFor(shop.owner)))?.nextStep).toBe("LIVE");
  expect((await reminderOf(draft.id))?.cancelled_at, "cancelled once the wizard shows the shop live").not.toBeNull();
  return `"${shop.shopName}": a reminder falling due after payment is not sent (24 h nor 72 h); the wizard cancels it`;
}, local);

qa("TC-ONB-088", "a registration idle for 7 days is ABANDONED: /shop/register starts again on 'Verify your business'", async ({ browser }) => {
  const d = await startDraft("onb088");
  await db()`update shop_registration_drafts set updated_at = now() - interval '7 days 1 hour' where id = ${d.view.id}`;
  const { context, page } = await pageFor(browser, d.owner);
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: "Verify your business" })).toBeVisible();
    await expect(page.getByTestId("registration-progress")).toHaveText("Step 2 of 5");
    await expect(page.getByTestId("gstin-input")).toHaveValue("");
    await expect(page.getByTestId("wizard-referral-code")).toHaveValue("");
  } finally {
    await context.close();
  }
  const [old] = await db()<{ status: string }[]>`select status from shop_registration_drafts where id = ${d.view.id}`;
  expect(old.status).toBe("ABANDONED");
  expect(await wizardOf(d.ctx), "nothing to resume").toBeNull();
  return `draft ${d.view.id} ABANDONED; the owner starts on "Verify your business" (Step 2 of 5) with nothing filled in`;
}, { ...local, partial: "the 7 days are taken by back-dating the draft's last step" });
