/**
 * New customers and shared devices.
 *   SC-19 — a new customer signs up with an unused mobile and an email,
 *           completes the details and a geo-tagged address, tops up and
 *           places and receives an order without extra prompts.
 *   SC-28 — the same first-order journey with invalid entries first: each is
 *           stopped at its field with a clear message, the typed values are
 *           kept and nothing invalid is saved; the valid path ends with one
 *           order and one debit.
 *   SC-27 — sign out on a shared phone: after each sign-out nothing of the
 *           previous user is visible or reachable; each finds their own data
 *           on return; an idle session past its lifetime is ended and sign-in
 *           returns to the page asked for.
 *   SC-30 — SMS sign-up and messages on SMS, WhatsApp and push: manual.
 *
 * Local tier: sign-in codes are read from the local mail catcher; the
 * browser's location is set to an address beside shop A (no Google Maps key
 * locally, so the form's "Use my current location" geo-tags it); the wallet
 * top-up is started on the site and settled in the local database as the
 * gateway would (the production build has no gateway to pay at).
 */
import type { Page } from "@playwright/test";

import {
  deliverToPerson,
  expiredSession,
  freeRider,
  freshListing,
  freshMobile,
  freshPerson,
  guestPage,
  openSignInPage,
  packOrder,
  rid,
  sellingShop,
  settleTopUp,
  signInOnPage,
  signOutOnPage,
} from "../lib/finance-helpers";
import { db } from "../lib/db";
import { RUN } from "../lib/http";
import { waitForCode } from "../lib/mail";
import { expect, manual, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 420_000 };
const HOME = () => world().location ?? { pincode: "411038", lat: 18.5074, lng: 73.8077 };
const geo = () => ({ geolocation: { latitude: HOME().lat + 0.009, longitude: HOME().lng }, permissions: ["geolocation"] });

async function userByEmail(email: string) {
  const [u] = await db()<{ id: string; phone: string | null; name: string | null; profile_completed_at: Date | null }[]>`select id, phone, name, profile_completed_at from users where email = ${email.toLowerCase()}`;
  return need(u, `the account for ${email}`);
}

/** The first-time details step, then the address step with the device's location. */
async function completeSetup(page: Page, name: string, line1: string) {
  await expect(page.getByLabel("Full name"), "first-time details").toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Full name").fill(name);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByRole("button", { name: "Use my current location" }).click();
  await expect(page.getByTestId("address-geotag"), "the address is geo-tagged").toBeVisible();
  await page.getByLabel("Address line 1").fill(line1);
  await page.getByLabel("Area").fill("Kothrud");
  await page.getByLabel("City").fill("Pune");
  await page.getByLabel("State").fill("Maharashtra");
  await page.getByLabel("PIN code").fill(HOME().pincode);
  await page.getByRole("button", { name: "Save address" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/onboarding"), { timeout: 30_000 });
}

/** Cart → checkout with the page's own session (the default address). */
async function orderOnPage(page: Page, shopProductId: string, quantity: number, extra: Record<string, unknown> = {}) {
  await page.request.delete("/api/cart");
  const added = await page.request.post("/api/cart", { data: { shopProductId, quantity } });
  expect(added.status(), "add to cart").toBeLessThan(300);
  const addresses = (await (await page.request.get("/api/addresses")).json()) as { id: string; isDefault: boolean }[] | { addresses: { id: string; isDefault: boolean }[] };
  const list = Array.isArray(addresses) ? addresses : addresses.addresses;
  const address = need(list.find((a) => a.isDefault) ?? list[0], "the saved address");
  const res = await page.request.post("/api/checkout", { data: { requestId: rid("pg"), addressId: address.id, paymentMethod: "WALLET", ...extra } });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/* ------------------------------------------------------------------ SC-19 */

qa("SC-19", "new customer: mobile sign-up to first order — account, wallet and geo-tagged address created; topped up; the order completes without extra prompts", async ({ browser }) => {
  const mobile = freshMobile();
  const email = `qa-sc19-${RUN}-${mobile.slice(-4)}@test.local`;
  const { context, page } = await guestPage(browser, geo());
  try {
    // 1. Sign up with the unused mobile and an email.
    await signInOnPage(page, mobile, email, { signUp: true });
    // 2. Details and the geo-tagged address.
    await completeSetup(page, "QA Sc19 Customer", `QA SC-19 flat ${RUN}`);
    const user = await userByEmail(email);
    const [wallet] = await db()<{ balance: number }[]>`select balance_paise::int as balance from wallets where user_id = ${user.id}`;
    const [address] = await db()<{ latitude: string | null; longitude: string | null; is_default: boolean }[]>`select latitude, longitude, is_default from addresses where user_id = ${user.id}`;
    const bad: string[] = [];
    if (user.phone !== mobile) bad.push(`the account's mobile is ${user.phone}, expected ${mobile}`);
    if (!user.profile_completed_at || user.name !== "QA Sc19 Customer") bad.push("the details were not saved");
    if (!wallet) bad.push("no wallet");
    if (!address?.latitude || !address.is_default) bad.push(`address ${JSON.stringify(address)}`);
    // 3. Top up ₹500.
    const topUp = await page.request.post("/api/wallet/topup", { data: { amountPaise: 50_000 } });
    expect(topUp.status(), "start a top-up").toBe(200);
    const credited = await settleTopUp(user.id, (await topUp.json()).gatewayOrderId);
    // 4. Order and receive.
    await freeRider("rider");
    const listing = await freshListing({ name: "QA First Order Tea", pricePaise: 12_000, stock: 10 });
    const placed = await orderOnPage(page, listing.shopProductId, 1, { acknowledgeClosedShopIds: [listing.shopId] });
    expect(placed.status, `checkout at the first try: ${JSON.stringify(placed.body?.error ?? "")}`).toBe(201);
    const order = need(placed.body.orders?.[0] as { id: string; orderNumber: string; totalPaise: number } | undefined, "the order");
    await packOrder(order.id);
    await deliverToPerson(order.id, order.orderNumber, { email });
    const [done] = await db()<{ status: string }[]>`select status from orders where id = ${order.id}`;
    const [after] = await db()<{ balance: number }[]>`select balance_paise::int as balance from wallets where user_id = ${user.id}`;
    if (done.status !== "DELIVERED") bad.push(`order ${done.status}`);
    if (after.balance !== credited - order.totalPaise) bad.push(`wallet ${after.balance}, expected ${credited - order.totalPaise}`);
    expect(bad, bad.join("\n")).toEqual([]);
    return `signed up with ${mobile} + ${email}; details and geo-tagged default address saved; wallet created; ₹${credited / 100} top-up; ${order.orderNumber} (₹${order.totalPaise / 100}) placed at the first try and delivered; wallet ₹${after.balance / 100}`;
  } finally {
    await context.close();
  }
}, { ...local, partial: "the top-up is started on the site (gateway order created) and settled in the local database — the local production build has no payment gateway to pay at (/api/dev/settle-topup is 404 in production builds)" });

/* ------------------------------------------------------------------ SC-28 */

qa("SC-28", "field validation along the first-order journey: each invalid entry stopped at its field with a clear message and the typed value kept; nothing invalid saved; one order and one debit at the end", async ({ browser }) => {
  const mobile = freshMobile();
  const email = `qa-sc28-${RUN}-${mobile.slice(-4)}@test.local`;
  const { context, page } = await guestPage(browser, geo());
  const seen: string[] = [];
  const bad: string[] = [];
  const alert = page.getByTestId("otp-signin").getByRole("alert");
  try {
    // 1. Mobile, email and code.
    await openSignInPage(page);
    const id = page.getByLabel("Mobile number or email");
    await id.fill("12345");
    await page.getByRole("button", { name: "Get code" }).click();
    await expect(alert, "a short mobile is refused").toContainText(/mobile/i);
    seen.push(`mobile "12345" → "${(await alert.innerText()).trim()}"`);
    if ((await id.inputValue()) !== "12345") bad.push("the typed mobile was cleared");
    await id.fill(mobile);
    await page.getByRole("button", { name: "Get code" }).click();
    await expect(page.getByTestId("otp-sent-to")).toBeVisible();
    await page.getByRole("button", { name: "Sign up with your email" }).click();
    const emailField = page.getByLabel("Email address");
    await emailField.fill("qa-sc28@");
    await page.getByRole("button", { name: "Send code" }).click();
    // The field is type=email and required: the browser stops it at the field before the form's own check.
    const native = await emailField.evaluate((el: HTMLInputElement) => ({ valid: el.validity.valid, message: el.validationMessage }));
    const shownAlert = (await alert.count()) ? (await alert.innerText()).trim() : "";
    if (native.valid && !/valid email/i.test(shownAlert)) bad.push("a broken email is not stopped");
    seen.push(`email "qa-sc28@" → "${native.valid ? shownAlert : native.message}"`);
    if ((await emailField.inputValue()) !== "qa-sc28@") bad.push("the typed email was cleared");
    await emailField.fill(email);
    const since = Date.now();
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByTestId("otp-sent-to")).toContainText("***@");
    const code = await waitForCode(email, since);
    const codeField = page.getByLabel("One-time code");
    await codeField.fill("12ab");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alert, "letters in the code").toContainText("Enter the code we sent you.");
    const wrong = code === "999999" ? "888888" : "999999";
    await codeField.fill(wrong);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alert, "a wrong code").toBeVisible();
    seen.push(`code "12ab" → "Enter the code we sent you."; wrong code → "${(await alert.innerText()).trim()}"`);
    await codeField.fill(code);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 30_000 });
    // 2. Details and address: invalid first.
    await expect(page.getByLabel("Full name")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Full name").fill("QA Sc28 Customer");
    const mobileField = page.getByLabel("Mobile number", { exact: true });
    if (await mobileField.count()) {
      const kept = await mobileField.inputValue();
      await mobileField.fill("12345");
      await page.getByRole("button", { name: "Save and continue" }).click();
      const msg = page.getByText(/10-digit Indian mobile number/).first();
      await expect(msg, "a bad mobile in the details").toBeVisible();
      seen.push(`details mobile "12345" → "${(await msg.innerText()).trim()}"`);
      if ((await mobileField.inputValue()) !== "12345") bad.push("the typed details mobile was cleared");
      await mobileField.fill(kept || mobile);
    }
    await page.getByRole("button", { name: "Save and continue" }).click();
    const save = page.getByRole("button", { name: "Save address" });
    await expect(save).toBeVisible();
    const pin = page.getByLabel("PIN code");
    const recipientMobile = page.getByLabel("Recipient mobile (optional)");
    await page.getByLabel("Address line 1").fill(`QA SC-28 flat ${RUN}`);
    await page.getByLabel("City").fill("Pune");
    await pin.fill("4110");
    await recipientMobile.fill("12345");
    await save.click();
    const pinState = await pin.evaluate((el: HTMLInputElement) => ({ valid: el.validity.valid, message: el.validationMessage }));
    const recState = await recipientMobile.evaluate((el: HTMLInputElement) => ({ valid: el.validity.valid, message: el.validationMessage }));
    if (pinState.valid) bad.push("a 4-digit PIN code is not stopped at its field");
    if (recState.valid) bad.push("a 5-digit recipient mobile is not stopped at its field");
    seen.push(`PIN "4110" → "${pinState.message}"; recipient mobile "12345" → "${recState.message}"`);
    if ((await pin.inputValue()) !== "4110") bad.push("the typed PIN was cleared");
    const [{ n: savedBad }] = await db()<{ n: number }[]>`select count(*)::int as n from addresses a join users u on u.id = a.user_id where u.email = ${email}`;
    if (savedBad !== 0) bad.push("an address was saved with invalid fields");
    await pin.fill(HOME().pincode);
    await recipientMobile.fill("");
    await page.getByLabel("Delivery instructions (optional)").fill("QA: ring twice, leave with security");
    await page.getByRole("button", { name: "Use my current location" }).click();
    await expect(page.getByTestId("address-geotag")).toBeVisible();
    await save.click();
    await page.waitForURL((u) => !u.pathname.startsWith("/onboarding"), { timeout: 30_000 });
    const user = await userByEmail(email);
    // 3. Top-up: invalid amounts and voucher first.
    const tries: string[] = [];
    for (const [label, data] of [["₹0", { amountPaise: 0 }], ["₹0.50", { amountPaise: 50 }], ["₹10,00,00,000", { amountPaise: 10_000_000_000 }], ["₹10.555", { amountPaise: 1055.5 }], ["voucher NOSUCH", { amountPaise: 50_000, voucherCode: `NOSUCH${RUN}` }]] as const) {
      const r = await page.request.post("/api/wallet/topup", { data });
      const b = await r.json().catch(() => null);
      tries.push(`${label} → ${r.status()} "${b?.error?.message ?? ""}"`);
      if (r.status() < 400 || r.status() >= 500) bad.push(`top-up ${label} → ${r.status()}`);
    }
    seen.push(`top-up ${tries.join("; ")}`);
    const [{ n: payments }] = await db()<{ n: number }[]>`select count(*)::int as n from payments where user_id = ${user.id}`;
    if (payments !== 0) bad.push(`${payments} payment rows after refused top-ups`);
    const ok = await page.request.post("/api/wallet/topup", { data: { amountPaise: 50_000 } });
    expect(ok.status(), "a valid top-up").toBe(200);
    const credited = await settleTopUp(user.id, (await ok.json()).gatewayOrderId);
    // 4. Quantities: invalid first.
    const listing = await freshListing({ name: "QA Validation Jam", pricePaise: 9000, stock: 5 });
    const qty: string[] = [];
    for (const q of [0, -1, 1.5, 9999]) {
      const r = await page.request.post("/api/cart", { data: { shopProductId: listing.shopProductId, quantity: q } });
      qty.push(`${q} → ${r.status()}`);
      if (r.status() < 400 || r.status() >= 500) bad.push(`quantity ${q} accepted (${r.status()})`);
    }
    seen.push(`cart quantity ${qty.join(", ")}`);
    // 5. The order with notes and delivery instructions.
    await freeRider("rider");
    const placed = await orderOnPage(page, listing.shopProductId, 2, { acknowledgeClosedShopIds: [listing.shopId], notes: "QA: please pack the jam separately" });
    expect(placed.status, `the valid order: ${JSON.stringify(placed.body?.error ?? "")}`).toBe(201);
    const order = need(placed.body.orders?.[0] as { id: string; orderNumber: string; totalPaise: number } | undefined, "the order");
    const [{ orders }] = await db()<{ orders: number }[]>`select count(*)::int as orders from orders where user_id = ${user.id}`;
    const [kept] = await db()<{ notes: string | null; instructions: string | null }[]>`
      select o.notes as notes, o.delivery_address_snapshot->>'deliveryInstructions' as instructions from orders o where o.id = ${order.id}`;
    if (!kept?.notes?.includes("pack the jam separately") || !kept?.instructions?.includes("ring twice")) bad.push(`notes / instructions on the order: ${JSON.stringify(kept)}`);
    const [{ debits }] = await db()<{ debits: number }[]>`select count(*)::int as debits from wallet_transactions where user_id = ${user.id} and amount_paise < 0`;
    if (orders !== 1 || debits !== 1) bad.push(`${orders} orders and ${debits} debits`);
    await packOrder(order.id);
    await deliverToPerson(order.id, order.orderNumber, { email });
    expect(bad, `${bad.join("\n")}\n— ${seen.join(" | ")}`).toEqual([]);
    return `${seen.join(" | ")}; ₹${credited / 100} top-up; ${order.orderNumber} × 2 with notes — 1 order, 1 debit, delivered`;
  } finally {
    await context.close();
  }
}, { ...local, timeout: 480_000, partial: "the top-up is started on the site and settled in the local database (no payment gateway on the local production build); the top-up and quantity entries are tried on their APIs (the wallet and cart screens send the same requests)" });

/* ------------------------------------------------------------------ SC-27 */

qa("SC-27", "shared phone: after each sign-out nothing of the previous user is visible or reachable; each user finds their own cart and data on return; an idle session past its lifetime is ended and sign-in returns to the page asked for", async ({ browser }) => {
  const shop = await sellingShop("sc27");
  const customerEmail = `qa-sc27-cust-${RUN}@test.local`;
  const { context, page } = await guestPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ...geo() });
  const bad: string[] = [];
  try {
    // 1. The owner signs in on the phone, works in the shop portal, signs out.
    await signInOnPage(page, shop.owner.email, shop.owner.email);
    await page.goto("/shop/manage/today");
    await expect(page.locator("main"), "the owner's shop portal").toContainText(shop.name, { ignoreCase: true });
    await signOutOnPage(page);
    // 2. Back button and a saved /shop link.
    await page.goBack().catch(() => null);
    await page.reload().catch(() => null);
    if ((await page.content()).toLowerCase().includes(shop.name.toLowerCase())) bad.push(`after sign-out, Back shows "${shop.name}" (${page.url()})`);
    await page.goto("/shop/manage/today");
    if (!/\/signin/.test(page.url())) bad.push(`a saved /shop link opened ${page.url()} without signing in`);
    // 3. A customer signs in on the same browser, shops, signs out.
    const customer = await freshPerson("sc27-customer", { walletPaise: 50_000, address: true });
    await db()`update users set email = ${customerEmail} where id = ${customer.id}`;
    await signInOnPage(page, customerEmail, customerEmail);
    const add = await page.request.post("/api/cart", { data: { shopProductId: shop.listing.shopProductId, quantity: 2 } });
    expect(add.status(), "the customer adds to the cart").toBeLessThan(300);
    const seenShop = (await page.request.get(`/api/shops/${shop.shopId}/inventory`)).status();
    if (seenShop < 400) bad.push(`the customer can open the shop's inventory (${seenShop})`);
    await signOutOnPage(page);
    const anon = await page.request.get("/api/cart");
    if (anon.status() === 200 && JSON.stringify(await anon.json()).includes(shop.listing.shopProductId)) bad.push("the customer's cart is visible after sign-out");
    // 4. The owner signs in again: their own data, not the customer's cart.
    await signInOnPage(page, shop.owner.email, shop.owner.email);
    await page.goto("/shop/manage/today");
    await expect(page.locator("main")).toContainText(shop.name, { ignoreCase: true });
    const ownerCart = JSON.stringify(await (await page.request.get("/api/cart")).json());
    if (ownerCart.includes(shop.listing.shopProductId)) bad.push("the owner sees the customer's cart line");
    await signOutOnPage(page);
    // The customer returns to their own cart.
    await signInOnPage(page, customerEmail, customerEmail);
    const back = JSON.stringify(await (await page.request.get("/api/cart")).json());
    if (!back.includes(shop.listing.shopProductId)) bad.push("the customer's cart line is gone on return");
    await page.request.delete("/api/cart");
    await signOutOnPage(page);
    // 5. A session idle past its lifetime.
    await context.addCookies([await expiredSession(shop.owner)]);
    await page.goto("/shop/manage/today");
    if (!/\/signin/.test(page.url())) bad.push(`an expired session still opened ${page.url()}`);
    const asked = new URL(page.url());
    await signInOnPage(page, shop.owner.email, shop.owner.email, { path: `${asked.pathname}${asked.search}` });
    await page.waitForURL((u) => !u.pathname.startsWith("/onboarding"), { timeout: 10_000 }).catch(() => null);
    if (!page.url().includes("/shop/manage/today")) bad.push(`after signing in again at ${asked.pathname}${asked.search} the page is ${page.url()}, not the one asked for (/shop/manage/today)`);
    expect(bad, bad.join("\n")).toEqual([]);
    return "owner → sign out: Back and /shop link lead to sign-in; customer's cart and data separate; owner and customer each find their own on return; an expired session goes to sign-in and comes back to /shop/manage/today";
  } finally {
    await context.close();
    await shop.owner.ctx.dispose();
  }
}, { ...local, mobile: true, partial: "the idle session is a session cookie past its expiry (the 30-day lifetime cannot be waited out)" });

/* ------------------------------------------------------------------ SC-30 */

manual(
  "SC-30",
  "mobile sign-up by SMS code and messages on SMS, WhatsApp and push",
  "needs a real handset: the SMS sign-in code, WhatsApp messages and push notifications go to a phone (the local build sends codes by e-mail only and has no SMS, WhatsApp or push provider); run on staging with a test handset",
);
