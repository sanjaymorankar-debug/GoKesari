/**
 * Onboarding v2, Flow 1 — the customer (docs/onboarding-v2-2026-11, flag onboarding_v2; ON on staging since
 * migration 0215, 26-Nov-2026 21.20 IST). Signed tier: staging test accounts and the E2E shop only.
 *
 *   login sheet: Terms tick (version + IST time) → e-mail → mobile SMS code → account + wallet
 *   checkout: payment choice mandatory (online / COD), delivery address AFTER payment, the prompt, tracking
 *   address-pending orders: rider dispatch waits; the customer can cancel for a full refund
 *
 * customer2 places the orders (customer is busy in the regression run); staging SMS is the mock outbox
 * (Admin → Test messages), read with the admin session.
 */
import { randomUUID } from "node:crypto";

import { as, pageAs } from "../lib/actors";
import { addToCart, emptyCart, fulfil, sellable, walletBalance } from "../lib/flows";
import { anonymous, call, expectStatus, RUN, why } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";

const BUYER = "customer2" as const;
const IST = /\d{2} [A-Z][a-z]{2} \d{4}, \d{2}\.\d{2} (AM|PM) IST/;

async function v2On(): Promise<boolean> {
  const res = await call(await as(BUYER), "POST", "/api/onboarding-v2/customer/status", {});
  return res.status !== 404;
}

async function sheetStatus(role: Parameters<typeof as>[0]) {
  const res = await call(await as(role), "POST", "/api/onboarding-v2/customer/status", {});
  expectStatus(res, 200, "login-sheet status");
  return res.body as { step: string; consent: { version: string; acceptedAtIst: string } | null; emailVerified: boolean; mobile: { masked: string; verified: boolean } | null };
}

/**
 * An order on shop A (staging's only delivering shop) without an address — the address follows payment.
 * Shop A does not take cash on delivery on staging, so the wallet pays (the v2 checkout gate is the same).
 */
async function orderAddressLater(method: "WALLET" | "COD" = "WALLET", key: "A" | "B" = "A"): Promise<{ id: string; orderNumber: string; totalPaise: number; addressPending: boolean }> {
  const listing = await sellable(key);
  await emptyCart(BUYER);
  const added = await addToCart(BUYER, listing.shopProductId, 1);
  expectStatus(added, [200, 201], "add to cart");
  const res = await call(await as(BUYER), "POST", "/api/checkout", {
    requestId: `qa-ov2-${RUN}-${randomUUID().slice(0, 8)}`,
    paymentMethod: method,
    acknowledgeClosedShopIds: [listing.shopId],
  });
  if (res.status === 409 || res.status === 422) blocked(`${method} checkout refused — ${why(res)}`);
  expectStatus(res, 201, `${method} checkout without an address`);
  const o = res.body.orders[0];
  return { id: o.id, orderNumber: o.orderNumber, totalPaise: o.totalPaise, addressPending: o.addressPending === true };
}

/** The buyer's order row from GET /api/orders (it carries addressPendingSince). */
async function orderDetail(id: string) {
  const res = await call(await as(BUYER), "GET", "/api/orders?limit=50");
  expectStatus(res, 200, "GET /api/orders");
  const list = (Array.isArray(res.body) ? res.body : (res.body?.orders ?? [])) as Record<string, unknown>[];
  const row = list.find((o) => o.id === id);
  expect(row, `order ${id} in the buyer's list`).toBeTruthy();
  return row!;
}

qa(["TC-OV2-010"], "a guest opening a customer's /r/<code> link lands on the home page, not on sign-in", async () => {
  if (!(await v2On())) blocked("onboarding_v2 is off on this site");
  const summary = await call(await as("customer"), "GET", "/api/customer-referrals");
  expectStatus(summary, 200, "the customer's referral code");
  const code = summary.body.code as string;
  const guest = await anonymous();
  try {
    const res = await call(guest, "GET", `/r/${code}`, undefined, { maxRedirects: 0 });
    expect(res.status).toBe(307);
    expect(res.location, "Location of /r/<code> for a guest").toBe("/");
    return `/r/${code.slice(0, 3)}… → 307 Location "/"`;
  } finally {
    await guest.dispose();
  }
});

qa(["TC-OV2-011"], "login sheet step 1: Continue stays disabled until the Terms tick; after it the e-mail step shows the acceptance time in IST and offers Google / e-mail link", async ({ page }) => {
  if (!(await v2On())) blocked("onboarding_v2 is off on this site");
  const listing = await sellable("A");
  await page.goto(`/shops`);
  // The guest cart lives in the browser: put the line there as the shop page's "Add to cart" does.
  await page.evaluate((id) => window.localStorage.setItem("gk_guest_cart_v1", JSON.stringify({ lines: [{ shopProductId: id, quantity: 1 }], updatedAt: Date.now() })), listing.shopProductId);
  await page.goto("/cart");
  const placeOrder = page.getByTestId("guest-cart-place-order");
  await expect(placeOrder).toBeEnabled({ timeout: 60_000 });
  await placeOrder.click();
  const sheet = page.getByTestId("login-sheet");
  await expect(sheet).toBeVisible();
  const cont = page.getByTestId("login-sheet-consent-continue");
  await expect(cont, "Continue before the tick").toBeDisabled();
  await expect(sheet.getByRole("link", { name: "Terms & Conditions" })).toHaveAttribute("href", "/legal/terms");
  await expect(sheet.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/legal/privacy-policy");
  await page.getByTestId("login-sheet-consent-box").check();
  await cont.click();
  await expect(sheet).toContainText("Step 2 of 3");
  await expect(sheet.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  const accepted = (await sheet.getByText(/^Terms accepted /).innerText()).trim();
  expect(accepted).toMatch(IST);
  await expect(page.getByTestId("login-sheet-email-send")).toBeVisible();
  const google = await page.getByTestId("login-sheet-google").isVisible();
  await expect(page).toHaveURL(/\/cart$/);
  return `tick required; "${accepted}"; e-mail step offers ${google ? "Continue with Google + " : ""}"${await page.getByTestId("login-sheet-email-send").innerText()}"; still on /cart`;
}, { tier: "signed", mobile: true });

qa(["TC-OV2-012"], "login sheet step 1 shows the Terms version accepted together with the IST time", async ({ page }) => {
  if (!(await v2On())) blocked("onboarding_v2 is off on this site");
  const listing = await sellable("A");
  await page.goto(`/shops`);
  await page.evaluate((id) => window.localStorage.setItem("gk_guest_cart_v1", JSON.stringify({ lines: [{ shopProductId: id, quantity: 1 }], updatedAt: Date.now() })), listing.shopProductId);
  await page.goto("/cart");
  await expect(page.getByTestId("guest-cart-place-order")).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId("guest-cart-place-order").click();
  const sheet = page.getByTestId("login-sheet");
  const consentResponse = page.waitForResponse((r) => r.url().endsWith("/api/onboarding-v2/customer/consent"));
  await page.getByTestId("login-sheet-consent-box").check();
  await page.getByTestId("login-sheet-consent-continue").click();
  const body = await (await consentResponse).json();
  expect(body.version, "the API records a version").toBeTruthy();
  await expect(sheet).toContainText("Step 2 of 3");
  const shown = await sheet.innerText();
  expect(shown, `the sheet shows the Terms version ${body.version} next to the time`).toContain(body.version);
  return `version ${body.version} shown with ${body.acceptedAtIst}`;
}, { tier: "signed" });

qa(["TC-OV2-013"], "login sheet steps 2–4 for a NEW e-mail: link / code e-mailed, back to the cart, mobile code, account + wallet", async () => {
  blocked(
    "not run: a new account's sign-in link / code goes to the real address (EMAIL_REDIRECT_TO never readdresses sign-in mail) and this session has no mailbox access (Gmail connector not authorised); the steps after the e-mail are covered for an existing account by TC-OV2-014",
  );
}, { tier: "signed" });

qa(["TC-OV2-014"], "login sheet step 3: the mobile SMS code (mock outbox) verifies the number; the account is DONE and has a wallet", async () => {
  if (!(await v2On())) blocked("onboarding_v2 is off on this site");
  // An account still at the MOBILE step whose number is known to it (staff accounts on staging have one unverified).
  let role: "ops" | "oplim" | "admin" | null = null;
  for (const r of ["ops", "oplim", "admin"] as const) {
    if ((await sheetStatus(r)).step === "MOBILE") {
      role = r;
      break;
    }
  }
  if (!role) blocked("no staging test account is left at the login sheet's MOBILE step");
  const profile = await call(await as(role), "GET", "/api/profile");
  expectStatus(profile, 200, "GET /api/profile");
  const phone = String(profile.body?.phone ?? profile.body?.user?.phone ?? profile.body?.phoneE164 ?? profile.body?.user?.phoneE164 ?? "").replace(/^\+91/, "");
  if (!/^\d{10}$/.test(phone)) blocked(`the ${role} account's number is not readable from /api/profile`);
  const since = Date.now();
  const sent = await call(await as(role), "POST", "/api/onboarding-v2/customer/mobile", { action: "send", mobile: phone });
  expectStatus(sent, 200, "send the mobile code");
  expect(sent.body.status).toBe("CODE_SENT");
  let code: string | null = null;
  for (let i = 0; i < 20 && !code; i++) {
    const out = await call(await as("admin"), "GET", `/api/admin/test-messages?to=${phone}`);
    const m = ((out.body?.messages ?? []) as { body: string; createdAt: string }[]).find((x) => new Date(x.createdAt).getTime() >= since - 5_000);
    code = m?.body.match(/\b(\d{6})\b/)?.[1] ?? null;
    if (!code) await new Promise((r) => setTimeout(r, 3_000));
  }
  if (!code) blocked("no SMS reached the mock outbox within a minute");
  const wrong = await call(await as(role), "POST", "/api/onboarding-v2/customer/mobile", { action: "verify", mobile: phone, code: code === "000000" ? "111111" : "000000" });
  expect(wrong.status, "a wrong code is refused").toBeGreaterThanOrEqual(400);
  const ok = await call(await as(role), "POST", "/api/onboarding-v2/customer/mobile", { action: "verify", mobile: phone, code });
  expectStatus(ok, 200, "verify the mobile code");
  expect(ok.body.step).toBe("DONE");
  expect(ok.body.mobile.verified).toBe(true);
  const wallet = await call(await as(role), "GET", "/api/wallet");
  expectStatus(wallet, 200, "the account's wallet");
  return `${role}: CODE_SENT ${sent.body.maskedPhone}, wrong code ${wrong.status}, right code → step DONE, mobile verified, wallet answers 200`;
}, { tier: "signed" });

qa(["TC-OV2-015"], "returning customer: no sheet; no payment preselected (button says Choose how to pay); COD with the location after paying → delivery-location prompt → saved address → order tracking", async ({ browser }) => {
  if (!(await v2On())) blocked("onboarding_v2 is off on this site");
  const status = await sheetStatus(BUYER);
  expect(status.step, "the returning customer has nothing left in the sheet").toBe("DONE");
  const listing = await sellable("A");
  await emptyCart(BUYER);
  expectStatus(await addToCart(BUYER, listing.shopProductId, 1), [200, 201], "add to cart");
  const { page, context } = await pageAs(browser, BUYER);
  try {
    await page.goto("/cart");
    const place = page.getByTestId("checkout-place-order-v2");
    await expect(place).toBeVisible({ timeout: 60_000 });
    await expect(place).toHaveText(/Choose how to pay/);
    await expect(place).toBeDisabled();
    expect(await page.locator('input[name="payment-method"]:checked').count(), "no payment method preselected").toBe(0);
    await page.locator("#deliver-to").selectOption("");
    const cod = page.getByRole("radio", { name: "Cash on delivery" });
    // Staging: shop A (the only delivering test shop) takes no cash on delivery, and "Pay online" opens
    // Cashfree's sandbox checkout page (not automated here) — the wallet pays when COD is off.
    const codNote = (await cod.isDisabled()) ? "COD disabled for shop A (shop setting), paid from the wallet" : "COD";
    const wallet = page.getByRole("radio", { name: /wallet/i });
    if (await cod.isEnabled()) await cod.check();
    else if (await wallet.count()) await wallet.check();
    else blocked("shop A takes no cash on delivery and the wallet does not cover the order");
    // Out of the express hours only a scheduled delivery is offered: pick the first slot.
    const picker = page.getByTestId("slot-picker");
    if (await picker.isVisible().catch(() => false)) await picker.locator('[data-testid^="slot-"]').first().click();
    await expect(place).toBeEnabled();
    await place.click();
    await expect(page.getByTestId("login-sheet")).toHaveCount(0);
    // An older open order of this account (e.g. another check's) asks "Ignore and continue".
    // So may a shop that is closed now ("Yes, continue"). Answer each question until the prompt opens.
    const confirm = page.getByRole("button", { name: /^(Ignore and continue|Yes, continue)$/ });
    for (let i = 0; i < 3 && !/delivery-location/.test(page.url()); i++) {
      await Promise.race([confirm.first().waitFor({ timeout: 20_000 }).then(() => confirm.first().click()), page.waitForURL(/delivery-location/, { timeout: 20_000 })]).catch(() => {});
    }
    await expect(page).toHaveURL(/\/orders\/delivery-location\?placed=1/, { timeout: 90_000 });
    const prompt = page.getByTestId("delivery-location-prompt");
    await expect(prompt).toBeVisible();
    await expect(page.getByTestId("delivery-location-cancel")).toBeVisible();
    // A saved address (customer2 has one); "New location" needs GPS / the map pin.
    const pendingShown = await prompt.innerText();
    await page.getByTestId("delivery-location-save").click();
    // One waiting order → its page; several (an older one still waiting too) → the orders list.
    await expect(page).toHaveURL(/\/orders(\/[0-9a-f-]{36}|\?placed=1)/, { timeout: 60_000 });
    const list = await call(await as(BUYER), "GET", "/api/orders?limit=5");
    const newest = ((Array.isArray(list.body) ? list.body : list.body.orders) as { id: string; orderNumber: string; addressPendingSince: string | null }[])[0];
    expect(pendingShown, "the prompt lists the new order").toContain(newest.orderNumber);
    const id = newest.id;
    const order = await orderDetail(id);
    expect(order.addressPendingSince ?? null, "address set").toBeNull();
    await page.goto(`/orders/${id}`);
    await expect(page.locator("main")).toContainText(newest.orderNumber);
    const text = await page.locator("main").innerText();
    // Tidy: cancel the test order (refund to the sandbox payment / wallet).
    await call(await as(BUYER), "PATCH", `/api/orders/${id}/status`, { status: "CANCELLED", note: "QA onboarding v2 test order" });
    return `no sheet; "Choose how to pay" disabled, nothing preselected; ${codNote}; "Set the location after paying" → /orders/delivery-location?placed=1 → saved address → /orders/${id.slice(0, 8)}… (${text.match(/Order [A-Z0-9-]+/)?.[0] ?? "tracking page"}); order cancelled afterwards`;
  } finally {
    await context.close();
  }
}, { tier: "signed", timeout: 300_000 });

qa(["TC-OV2-016"], "checkout API: no payment method chosen → 422 'Choose how to pay'; nothing is ordered", async () => {
  if (!(await v2On())) blocked("onboarding_v2 is off on this site");
  const listing = await sellable("A");
  await emptyCart(BUYER);
  expectStatus(await addToCart(BUYER, listing.shopProductId, 1), [200, 201], "add to cart");
  const res = await call(await as(BUYER), "POST", "/api/checkout", { requestId: `qa-ov2-${RUN}-${randomUUID().slice(0, 8)}`, acknowledgeClosedShopIds: [listing.shopId] });
  expect([400, 422], why(res)).toContain(res.status);
  expect(why(res)).toMatch(/Choose how to pay/);
  await emptyCart(BUYER);
  return why(res);
}, { tier: "signed" });

qa(["TC-OV2-017"], "address pending: the shop can pack the order but no rider is dispatched until the customer sets the location", async () => {
  if (!(await v2On())) blocked("onboarding_v2 is off on this site");
  const order = await orderAddressLater();
  expect(order.addressPending, "the checkout answer marks the address as pending").toBe(true);
  try {
    for (const action of ["accept", "start"] as const) expectStatus(await fulfil(order.id, action), [200, 201], action);
    const shop = await as("shop");
    const options = await call(shop, "GET", `/api/orders/${order.id}/fulfilment-plan`);
    expectStatus(options, 200, "delivery plan options");
    const slotKey = (options.body?.days as { slots: { key: string }[] }[] | undefined)?.[0]?.slots[0]?.key;
    if (!slotKey) blocked("no delivery slot can be chosen now");
    const planned = await call(shop, "POST", `/api/orders/${order.id}/fulfilment-plan`, { option: "GOKESARI_PARTNER", slotKey, markReady: true });
    if (planned.status >= 400) {
      // What the shop is pushed to instead: the only option left is pickup (probe, then reported).
      const pickup = await call(shop, "POST", `/api/orders/${order.id}/fulfilment-plan`, { option: "PICKUP", slotKey, markReady: true });
      const row = await orderDetail(order.id);
      throw new Error(
        `the shop cannot mark the paid delivery order READY for a GoKesari rider while the address is pending: ${why(planned)}; ` +
          `PICKUP instead → ${pickup.status} (order now ${row.status}, addressPendingSince ${row.addressPendingSince ? "still set" : "cleared"}) — expected: shop packs and marks ready, dispatch waits for the location (README #13)`,
      );
    }
    const detail = await orderDetail(order.id);
    expect(detail.status).toBe("READY");
    expect(detail.addressPendingSince, "still waiting for the location").toBeTruthy();
    // Dispatch (the operator's "assign nearest partner") must wait for the location.
    const assign = await call(await as("ops"), "POST", `/api/orders/${order.id}/assign`, {});
    expect(assign.status, `assign while the address is pending — ${why(assign)}`).toBe(409);
    expect(why(assign)).toMatch(/waiting for the customer's delivery location/);
    return `${order.orderNumber}: COD, addressPending; accept/start/ready (GoKesari partner) → READY; assign → 409 "${why(assign).slice(9, 90)}…"`;
  } finally {
    await call(await as(BUYER), "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA onboarding v2 test order" });
  }
}, { tier: "signed", timeout: 240_000 });

qa(["TC-OV2-018"], "address pending: the customer cancels the order (also after the shop accepted) and gets a full refund", async () => {
  if (!(await v2On())) blocked("onboarding_v2 is off on this site");
  const notes: string[] = [];
  // Paid from the wallet; the shop already accepted; no location given yet.
  const before = await walletBalance(BUYER);
  const w = await orderAddressLater("WALLET");
  expect(w.addressPending).toBe(true);
  const charged = before - (await walletBalance(BUYER));
  expect(charged, "wallet debited by the order total").toBe(w.totalPaise);
  expectStatus(await fulfil(w.id, "accept"), [200, 201], "shop accepts");
  expectStatus(await fulfil(w.id, "start"), [200, 201], "shop starts packing");
  const c2 = await call(await as(BUYER), "PATCH", `/api/orders/${w.id}/status`, { status: "CANCELLED", note: "QA: cancelled before giving a delivery location" });
  expectStatus(c2, 200, "customer cancels the accepted, packing, address-pending wallet order");
  expect(["CANCELLED", "REFUNDED"]).toContain((await orderDetail(w.id)).status);
  let after = 0;
  for (let i = 0; i < 10; i++) {
    after = await walletBalance(BUYER);
    if (after === before) break;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  expect(after, "wallet back to the balance before the order").toBe(before);
  notes.push(`WALLET ${w.orderNumber} ₹${w.totalPaise / 100} debited → shop accepted + packing → customer cancel 200 → ${(await orderDetail(w.id)).status} → wallet back to ₹${before / 100}`);
  return notes.join("; ");
}, { tier: "signed", timeout: 240_000 });

qa(["TC-OV2-019"], "pickup: an order from a pickup-only shop needs no delivery address and never asks for one", async () => {
  if (!(await v2On())) blocked("onboarding_v2 is off on this site");
  const order = await orderAddressLater("WALLET", "B");
  try {
    expect(order.addressPending, "a pickup order is never 'address pending'").toBe(false);
    const row = await orderDetail(order.id);
    expect(row.addressPendingSince ?? null).toBeNull();
    return `${order.orderNumber} (shop B, pickup only): placed without an address, addressPendingSince null`;
  } finally {
    await call(await as(BUYER), "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA onboarding v2 test order" });
  }
}, { tier: "signed" });

qa(["TC-OV2-020"], "cash on delivery with the address after payment (the brief's COD path)", async () => {
  if (!(await v2On())) blocked("onboarding_v2 is off on this site");
  const order = await orderAddressLater("COD");
  try {
    expect(order.addressPending).toBe(true);
    return `${order.orderNumber}: COD accepted without an address, addressPending`;
  } finally {
    await call(await as(BUYER), "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA onboarding v2 test order" });
  }
}, { tier: "signed" });
