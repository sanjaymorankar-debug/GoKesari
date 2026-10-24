/**
 * Location, addresses and serviceability as the customer sees them: the
 * delivery location (PIN, device, saved address, default address, clear),
 * the address book and its fields (TC-FLD-010…019), the cart and checkout
 * against an address the shop does not reach, and society links.
 *
 * Signed-in tier. Every check uses its own browser / API context for the
 * location cookie, puts back the addresses it adds and the default flag, and
 * restores any shop setting it changes.
 */
import type { BrowserContext, Page } from "@playwright/test";

import { as } from "../lib/actors";
import { call, expectStatus, RUN, why } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { BASE_URL } from "../lib/target";
import { world } from "../lib/world";
import {
  addressBody,
  cartGroup,
  checkoutAs,
  clearCart,
  createAddress,
  fillCart,
  home,
  homeAddressId,
  listAddresses,
  listing,
  open,
  ordersOf,
  pointNorth,
  postAddress,
  removeAddress,
  setDefault,
  shopName,
  signedPage,
  SIGNED,
  storefrontRow,
  validateCart,
  walletOf,
  withAddresses,
  withShop,
  type SavedAddress,
} from "../lib/shopping-helpers";

const FAR = { pincode: "411057", latitude: 18.5913, longitude: 73.7389 }; // Hinjewadi, ~12 km from shop A

/** The "Deliver to" label of whichever header the page has. */
function deliverToLabel(page: Page) {
  return page.locator('[data-testid="deliver-to-label"]:visible, [data-testid="location-label"]:visible').first();
}

/** The location cookie as the browser holds it. */
async function locationCookie(context: BrowserContext) {
  const cookie = (await context.cookies(BASE_URL)).find((c) => c.name === "gk_location");
  if (!cookie) return null;
  return { cookie, value: JSON.parse(decodeURIComponent(cookie.value)) as { label: string; pincode: string | null; latitude: number | null; longitude: number | null; source: string; addressId: string | null } };
}

/** Opens the home page's location sheet. */
async function openSheet(page: Page) {
  await page.getByTestId("deliver-to").click();
  const sheet = page.getByRole("dialog", { name: /delivery location/i });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Shop cards in the home page's "Shops near you" section. */
function homeShops(page: Page) {
  return page.getByTestId("home-shops").getByTestId("shop-card");
}

/* ------------------------------------------------------- the delivery location */

qa("TC-LOC-001", "PIN location: label, 'Shops near you' and /shops follow it, and it survives pages and reloads (gk_location cookie)", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  try {
    await open(page, "/");
    await expect(page.getByTestId("home-set-location")).toBeVisible();
    const sheet = await openSheet(page);
    await sheet.getByLabel("Enter a PIN code").fill(home().pincode);
    await sheet.getByRole("button", { name: "Use PIN" }).click();
    await expect(deliverToLabel(page)).toContainText(`PIN ${home().pincode}`, { timeout: 30_000 });
    // The shops section now lists the shops near that PIN, shop A among them.
    await expect(page.getByTestId("home-set-location")).toHaveCount(0);
    await expect(homeShops(page).filter({ hasText: shopName("A") }).first()).toBeVisible();
    const saved = await locationCookie(context);
    expect(saved, "gk_location cookie set").not.toBeNull();
    expect(saved!.cookie.httpOnly, "cookie is httpOnly").toBe(true);
    expect(saved!.value).toMatchObject({ pincode: home().pincode, source: "PINCODE" });
    for (const path of ["/shops", "/search?q=bread", "/categories"]) {
      await open(page, path);
      await expect(deliverToLabel(page), `label on ${path}`).toContainText(`PIN ${home().pincode}`);
    }
    await open(page, "/shops");
    await expect(page.getByTestId("shop-count")).toContainText(`near PIN ${home().pincode}`);
    await page.reload();
    await expect(page.getByTestId("shop-count")).toContainText(`near PIN ${home().pincode}`);
    return `PIN ${home().pincode}: label, home shops (${shopName("A")}), /shops, /search, /categories and a reload all use it; cookie httpOnly`;
  } finally {
    await context.close();
  }
}, { ...SIGNED, mobile: true, partial: "the guest half (set by PIN, clear) is guest/storefront.spec.ts" });

qa(["TC-LOC-002", "TC-FLD-020"], "a refused PIN shows a message on the field, the API answers 422 and the previous location stays", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  try {
    await open(page, "/");
    let sheet = await openSheet(page);
    await sheet.getByLabel("Enter a PIN code").fill(home().pincode);
    await sheet.getByRole("button", { name: "Use PIN" }).click();
    await expect(deliverToLabel(page)).toContainText(`PIN ${home().pincode}`, { timeout: 30_000 });

    sheet = await openSheet(page);
    const field = sheet.getByLabel("Enter a PIN code");
    const messages: string[] = [];
    for (const typed of ["", "12345"]) {
      await field.fill(typed);
      await sheet.getByRole("button", { name: "Use PIN" }).click();
      const message = await field.evaluate((el) => (el as HTMLInputElement).validationMessage);
      expect(message, `field message for "${typed}"`).not.toBe("");
      messages.push(`"${typed}": ${message}`);
    }
    await field.fill("ab%$cd");
    expect(await field.inputValue(), "letters and symbols are not taken").toBe("");
    await field.fill("1234567");
    expect((await field.inputValue()).length, "seven digits are cut to six").toBe(6);
    await page.keyboard.press("Escape");

    const api: string[] = [];
    for (const pincode of ["", "12345", "1234567", "abcdef", "41 038", "4110385", "%27--"]) {
      const res = await page.request.post("/api/location", { data: { pincode } });
      expect(res.status(), `POST /api/location "${pincode}"`).toBe(422);
      api.push(`"${pincode}"→${res.status()}`);
    }
    const kept = await locationCookie(context);
    expect(kept?.value.pincode, "the previous location stays after refused PINs").toBe(home().pincode);
    await page.reload();
    await expect(deliverToLabel(page)).toContainText(`PIN ${home().pincode}`);
    return `field messages ${messages.join("; ")}; API ${api.join(", ")}; location still PIN ${home().pincode}`;
  } finally {
    await context.close();
  }
}, { ...SIGNED, partial: "PINs starting with 0 (000000, 011001) are accepted — known defect D-04, asserted by the guest check in guest/storefront.spec.ts" });

qa("TC-LOC-003", "device position: allowed → set and rounded to 4 decimals; denied → a clear message and the previous location kept", async ({ browser }) => {
  const at = { latitude: 18.50745678, longitude: 73.80771234 };
  const allowed = await browser.newContext({ baseURL: BASE_URL, geolocation: at, permissions: ["geolocation"] });
  const denied = await browser.newContext({ baseURL: BASE_URL });
  try {
    const page = await allowed.newPage();
    await open(page, "/");
    const sheet = await openSheet(page);
    await sheet.getByTestId("location-gps").click();
    // Labelled with the spot's address, or the area and city of a shop or saved address nearby
    // ("Kothrud, Pune"); "Current location" only when nothing is known there (#225/#226, api/location).
    await expect(deliverToLabel(page)).toContainText(/Current location|[A-Za-z]+, [A-Za-z]+/i, { timeout: 30_000 });
    const set = await locationCookie(allowed);
    expect(set?.value, "cookie after allow").toMatchObject({ source: "DEVICE", latitude: 18.5075, longitude: 73.8077 });

    const other = await denied.newPage();
    await denied.clearPermissions();
    await open(other, "/");
    let sheet2 = await openSheet(other);
    await sheet2.getByLabel("Enter a PIN code").fill(home().pincode);
    await sheet2.getByRole("button", { name: "Use PIN" }).click();
    await expect(deliverToLabel(other)).toContainText(`PIN ${home().pincode}`, { timeout: 30_000 });
    sheet2 = await openSheet(other);
    await sheet2.getByTestId("location-gps").click();
    await expect(sheet2.getByRole("alert")).toContainText(/permission was not given/i);
    await other.keyboard.press("Escape");
    await expect(deliverToLabel(other)).toContainText(`PIN ${home().pincode}`);
    expect((await locationCookie(denied))?.value.pincode).toBe(home().pincode);
    return `allowed: ${at.latitude},${at.longitude} stored as ${set?.value.latitude},${set?.value.longitude}; denied: "Location permission was not given…", PIN ${home().pincode} kept`;
  } finally {
    await allowed.close();
    await denied.close();
  }
}, { ...SIGNED, mobile: true });

qa("TC-LOC-004", "a saved address picked in the location chooser changes the shops listed, and the cart preselects that address", async ({ browser }) => {
  const item = listing("packaged");
  return withAddresses("customer", [{ ...FAR, label: `QA far ${RUN}`, line1: `QA far ${RUN}`, area: "Hinjewadi" }], async ([far]) => {
    await fillCart("customer", [{ item, quantity: 1 }]);
    const near = await homeAddressId("customer");
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, "/");
      let sheet = await openSheet(page);
      await sheet.getByRole("button", { name: `QA far ${RUN} — ${FAR.pincode}` }).click();
      await expect(deliverToLabel(page)).toContainText(FAR.pincode, { timeout: 30_000 });
      await expect(homeShops(page).filter({ hasText: shopName("A") }), "shop A is not listed for the far address").toHaveCount(0);
      await open(page, "/cart");
      await expect(page.locator("#deliver-to"), "cart preselects the far address").toHaveValue(far.id);
      await expect(cartGroup(page, shopName("A")).getByTestId("delivery-warning")).toContainText(/does not deliver/i);

      await open(page, "/");
      sheet = await openSheet(page);
      await sheet.getByRole("button", { name: new RegExp(`^${home().pincode}$`) }).first().click();
      await expect(deliverToLabel(page)).toContainText(home().pincode, { timeout: 30_000 });
      await expect(homeShops(page).filter({ hasText: shopName("A") }).first()).toBeVisible();
      await open(page, "/cart");
      await expect(page.locator("#deliver-to"), "cart preselects the near address").toHaveValue(near);
      await expect(cartGroup(page, shopName("A")).getByTestId("delivery-warning")).toHaveCount(0);
    } finally {
      await context.close();
      await clearCart("customer");
    }
    return `far address (${FAR.pincode}): ${shopName("A")} not listed, cart preselects it and warns; near address: listed again, cart preselects it`;
  });
}, { ...SIGNED, mobile: true });

qa(["TC-LOC-005", "TC-LOC-007"], "signed in with no location cookie, discovery uses the default address; clearing the location falls back to it", async ({ browser }) => {
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, "/shops");
    expect(await locationCookie(context), "no cookie yet").toBeNull();
    await expect(page.getByTestId("shop-count")).toContainText(home().pincode);
    const card = page.getByTestId("shop-card").filter({ hasText: shopName("A") }).first();
    await expect(card).toContainText(/Delivers to you · \d/);
    // Choose a PIN, then clear it: the default address is used again.
    const set = await page.request.post("/api/location", { data: { pincode: FAR.pincode } });
    expect(set.status()).toBe(200);
    await page.reload();
    await expect(page.getByTestId("shop-count")).toContainText(`PIN ${FAR.pincode}`);
    const cleared = await page.request.delete("/api/location");
    expect(cleared.status()).toBe(200);
    expect(await locationCookie(context), "cookie cleared").toBeNull();
    await page.reload();
    await expect(page.getByTestId("shop-count")).not.toContainText(`PIN ${FAR.pincode}`);
    await expect(page.getByTestId("shop-count")).toContainText(home().pincode);
    await expect(page.getByTestId("shop-card").filter({ hasText: shopName("A") }).first()).toContainText(/Delivers to you/);
  } finally {
    await context.close();
  }
  // customer2's default address is ~12 km away: shop A is not near it.
  const { context: c2, page: p2 } = await signedPage(browser, "customer2");
  try {
    await open(p2, "/shops");
    await expect(p2.getByTestId("shop-card").filter({ hasText: shopName("A") })).toHaveCount(0);
  } finally {
    await c2.close();
  }
  return `customer: /shops near the default address (${home().pincode}), ${shopName("A")} delivers; PIN ${FAR.pincode} then DELETE → back to the default address; customer2 (12 km): shop A not listed`;
}, { ...SIGNED, mobile: true, partial: "TC-LOC-007's guest half (all shops / a prompt) is guest/storefront.spec.ts" });

qa(["TC-LOC-006", "TC-FLD-021"], "address search (Places) in the location chooser", async ({ browser }) => {
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, "/shops");
    await page.getByTestId("location-pill").click();
    await expect(page.getByTestId("location-picker")).toBeVisible();
    if ((await page.getByRole("button", { name: "Search an address" }).count()) === 0) {
      blocked("Google Maps is not configured on this site (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY unset): the chooser offers no 'Search an address'");
    }
    blocked("the Places search box needs live Google Places suggestions, which this run cannot reach");
  } finally {
    await context.close();
  }
}, SIGNED);

/* ------------------------------------------------------------ address book */

qa("TC-LOC-008", "address book: add (type, recipient, landmark, PIN, map pin), edit, set default, delete — and the deleted one is gone from the cart", async ({ browser }) => {
  const pin = pointNorth(0.3);
  const before = await listAddresses("customer");
  const original = before.find((a) => a.isDefault) ?? before[0];
  const { context, page } = await signedPage(browser, "customer", { geolocation: pin, permissions: ["geolocation"] });
  const line1 = `QA Work ${RUN}`;
  let created: SavedAddress | undefined;
  try {
    await open(page, "/profile/addresses");
    await page.getByRole("button", { name: "Add a new address" }).click();
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Save address" }) });
    await form.getByRole("radio", { name: "Work" }).click();
    await form.getByLabel("Label (optional)").fill(`Office ${RUN}`);
    await form.getByLabel("Recipient name (optional)").fill("Asha Patil");
    await form.getByLabel("Recipient mobile (optional)").fill("9876543210");
    await form.getByLabel("Address line 1").fill(line1);
    await form.getByLabel("Flat / house / floor (optional)").fill("4th floor");
    await form.getByLabel("Area").fill("Kothrud");
    await form.getByLabel("City").fill("Pune");
    await form.getByLabel("State").fill("Maharashtra");
    await form.getByLabel("PIN code").fill(home().pincode);
    await form.getByLabel("Landmark (optional)").fill("Near the temple");
    await form.getByLabel("Delivery instructions (optional)").fill("Ring twice");
    await form.getByRole("button", { name: "Use my current location" }).click();
    await expect(form.getByTestId("address-geotag")).toContainText(`${pin.latitude.toFixed(5)}`);
    await form.getByRole("button", { name: "Save address" }).click();
    const card = page.locator("div").filter({ hasText: line1 }).filter({ has: page.getByRole("button", { name: "Edit" }) }).last();
    await expect(card).toBeVisible();
    await expect(card).toContainText("Work");
    await expect(card).toContainText("Landmark: Near the temple");

    created = (await listAddresses("customer")).find((a) => a.line1 === line1);
    expect(created, "saved through the form").toBeTruthy();
    expect(created).toMatchObject({
      addressType: "WORK",
      label: `Office ${RUN}`,
      recipientName: "Asha Patil",
      recipientPhone: "9876543210",
      line2: "4th floor",
      pincode: home().pincode,
      landmark: "Near the temple",
      deliveryInstructions: "Ring twice",
      isDefault: false,
    });
    expect(Number(created!.latitude)).toBeCloseTo(pin.latitude, 5);

    // Edit
    await card.getByRole("button", { name: "Edit" }).click();
    const edit = page.locator("form").filter({ has: page.getByRole("button", { name: "Save address" }) });
    await edit.getByLabel("Landmark (optional)").fill("Opposite the park");
    await edit.getByLabel("Set as default address").check();
    await edit.getByRole("button", { name: "Save address" }).click();
    const edited = page.locator("div").filter({ hasText: line1 }).filter({ has: page.getByRole("button", { name: "Edit" }) }).last();
    await expect(edited).toContainText("Landmark: Opposite the park");
    await expect(edited).toContainText("Default");
    const after = await listAddresses("customer");
    expect(after.filter((a) => a.isDefault).map((a) => a.id), "the default flag moved").toEqual([created!.id]);

    // Put the default back on the original, then delete the (now non-default) new address in the page.
    if (original) expectStatus(await setDefault("customer", after.find((a) => a.id === original.id)!), 200, "restore default");
    await page.reload();
    const toDelete = page.locator("div").filter({ hasText: line1 }).filter({ has: page.getByRole("button", { name: "Edit" }) }).last();
    await toDelete.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(page.getByText(line1)).toHaveCount(0);
    expect((await listAddresses("customer")).some((a) => a.id === created!.id), "gone from the address list").toBe(false);

    // Not selectable in the cart.
    await fillCart("customer", [{ item: listing("packaged"), quantity: 1 }]);
    await open(page, "/cart");
    await expect(page.locator("#deliver-to option")).not.toHaveText([new RegExp(line1)]);
    expect(await page.locator(`#deliver-to option[value="${created!.id}"]`).count(), "deleted address not offered at checkout").toBe(0);
    created = undefined;
    return "added WORK address with recipient, landmark, PIN and map pin; edited landmark and made it default; deleted it; not in the cart's list";
  } finally {
    await context.close();
    if (created) await removeAddress("customer", created.id);
    const now = await listAddresses("customer");
    if (original && !now.find((a) => a.id === original.id)?.isDefault) await setDefault("customer", now.find((a) => a.id === original.id)!);
    await clearCart("customer");
  }
}, { ...SIGNED, mobile: true });

qa(["TC-LOC-009", "TC-FLD-012"], "recipient mobile: wrong length, first digit and non-digits refused on the field and by the API; a valid number saved exactly", async ({ browser }) => {
  const api: string[] = [];
  for (const phone of ["12345", "987654321", "98765432101", "5876543210", "98765abcde", "98765 43210", "+919876543210", "+91 9876543210"]) {
    const res = await postAddress("customer", addressBody({ recipientPhone: phone }));
    expect(res.status, `API recipientPhone "${phone}"`).toBe(422);
    expect(JSON.stringify(res.body?.error?.details ?? res.body)).toMatch(/10-digit mobile/i);
    api.push(phone);
  }
  const good = await createAddress("customer", { recipientPhone: "9876543210" });
  expect(good.recipientPhone, "valid number saved exactly").toBe("9876543210");
  await removeAddress("customer", good.id);

  const { context, page } = await signedPage(browser, "customer");
  const ui: string[] = [];
  try {
    await open(page, "/profile/addresses");
    await page.getByRole("button", { name: "Add a new address" }).click();
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Save address" }) });
    await form.getByLabel("Address line 1").fill(`QA phone ${RUN}`);
    await form.getByLabel("City").fill("Pune");
    await form.getByLabel("PIN code").fill(home().pincode);
    const phone = form.getByLabel("Recipient mobile (optional)");
    for (const typed of ["12345", "5876543210"]) {
      await phone.fill(typed);
      await form.getByRole("button", { name: "Save address" }).click();
      const message = await phone.evaluate((el) => (el as HTMLInputElement).validationMessage);
      expect(message, `field message for "${typed}"`).not.toBe("");
      ui.push(`${typed}: "${message}"`);
    }
    await phone.fill("98a76-5.4");
    expect(await phone.inputValue(), "non-digits are dropped as typed").toBe("987654");
    await phone.fill("987654321012");
    expect(await phone.inputValue(), "the field stops at 10 digits").toBe("9876543210");
    // +91: the API refuses it; the field must strip it or refuse it the same way.
    await phone.fill("+91 9876543210");
    const shown = await phone.inputValue();
    ui.push(`"+91 9876543210" becomes "${shown}"`);
    expect(["9876543210", ""], `"+91 9876543210" in the field became "${shown}" — neither stripped to the number nor refused`).toContain(shown);
  } finally {
    await context.close();
    for (const a of await listAddresses("customer")) if (a.line1 === `QA phone ${RUN}`) await removeAddress("customer", a.id);
  }
  return `API 422 for ${api.join(", ")}; valid saved exactly; field: ${ui.join("; ")}`;
}, { ...SIGNED, partial: "blank is accepted: the field is labelled '(optional)' in src/components/address-manager.tsx (expected result superseded)" });

qa(["TC-LOC-010", "TC-FLD-017"], "re-pin an address with the device position: new coordinates saved and 'Geo-tagged at' updates; bad coordinates refused", async ({ browser }) => {
  const api: string[] = [];
  for (const [lat, lng] of [[95, 73.8], [18.5, 200], ["18.5", "73.8"], ["north", "east"]] as const) {
    const res = await postAddress("customer", { ...addressBody(), latitude: lat, longitude: lng });
    expect(res.status, `coordinates ${lat},${lng}`).toBe(422);
    api.push(`${lat},${lng}→422`);
  }
  // Without a pin: saved as PIN-only.
  const plain = await createAddress("customer", { latitude: null, longitude: null });
  expect(plain.latitude, "no pin → no coordinates").toBeNull();
  await removeAddress("customer", plain.id);

  const moved = pointNorth(0.7);
  return withAddresses("customer", [{ line1: `QA repin ${RUN}`, isDefault: true, ...pointNorth(0.2) }], async ([a]) => {
    const { context, page } = await signedPage(browser, "customer", { geolocation: moved, permissions: ["geolocation"] });
    try {
      await open(page, "/profile");
      await expect(page.getByText(`Geo-tagged at ${Number(a.latitude).toFixed(5)}`)).toBeVisible();
      await open(page, "/profile/addresses");
      const card = page.locator("div").filter({ hasText: `QA repin ${RUN}` }).filter({ has: page.getByRole("button", { name: "Edit" }) }).last();
      await card.getByRole("button", { name: "Edit" }).click();
      const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Save address" }) });
      await form.getByRole("button", { name: "Use my current location" }).click();
      await expect(form.getByTestId("address-geotag")).toContainText(moved.latitude.toFixed(5));
      await form.getByRole("button", { name: "Save address" }).click();
      await expect(form).toHaveCount(0);
      await page.reload();
      const saved = (await listAddresses("customer")).find((x) => x.id === a.id)!;
      expect(Number(saved.latitude)).toBeCloseTo(moved.latitude, 5);
      await open(page, "/profile");
      await expect(page.getByText(`Geo-tagged at ${moved.latitude.toFixed(5)}, ${moved.longitude.toFixed(5)}`)).toBeVisible();
    } finally {
      await context.close();
    }
    return `API ${api.join(", ")}; no pin → PIN-only; re-pinned ${Number(a.latitude).toFixed(5)} → ${moved.latitude.toFixed(5)}, persisted after reload and shown as 'Geo-tagged at'`;
  });
}, { ...SIGNED, partial: "the map itself (drag the pin) needs a Google Maps key; the device position path is used" });

/* -------------------------------------------- serviceability: lists, cart, checkout */

qa("TC-LOC-013", "a customer outside the radius: shop not 'delivers to you', absent from the delivering filter and from product search", async ({ browser }) => {
  const item = listing("packaged");
  return withShop("A", { serviceRadiusKm: 2 }, async () => {
    const context = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();
    try {
      const at = pointNorth(5);
      expect((await page.request.post("/api/location", { data: { ...at, label: "QA 5 km" } })).status()).toBe(200);
      await open(page, "/");
      const homeCard = homeShops(page).filter({ hasText: shopName("A") });
      if (await homeCard.count()) await expect(homeCard.first()).not.toContainText("Delivers to you");
      await open(page, "/shops");
      const card = page.getByTestId("shop-card").filter({ hasText: shopName("A") });
      if (await card.count()) await expect(card.first()).toContainText(/outside its delivery area/);
      await open(page, "/shops?delivery=true");
      await expect(page.getByTestId("shop-card").filter({ hasText: shopName("A") })).toHaveCount(0);
      await open(page, `/search?q=${encodeURIComponent(item.name)}`);
      await expect(page.getByTestId("product-card").filter({ hasText: shopName("A") })).toHaveCount(0);
      await expect(page.getByText(/Showing only shops that deliver to you/)).toBeVisible();
      return `radius 2 km, location 5 km away: home/shops show "${shopName("A")}" as not delivering, /shops?delivery=true and /search omit it`;
    } finally {
      await context.close();
    }
  });
}, { ...SIGNED, mobile: true, partial: "'Shops that deliver to you' is now 'Shops near you', which also lists nearby non-delivering shops marked 'Pickup · outside its delivery area' (src/app/shops/page.tsx, nearby-referral-2026-10)" });

qa(["TC-LOC-018", "TC-LOC-020"], "cart: switching to an address the shop does not reach warns 'does not deliver' with 'Change address' and disables pay, without a reload; switching back clears it", async ({ browser }) => {
  const item = listing("packaged");
  return withAddresses("customer", [{ ...FAR, label: `QA far ${RUN}`, line1: `QA far ${RUN}`, area: "Hinjewadi" }], async ([far]) => {
    await fillCart("customer", [{ item, quantity: 1 }]);
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, "/cart");
      const group = cartGroup(page, shopName("A"));
      const pay = page.getByRole("button", { name: /Pay from wallet/ });
      await expect(pay).toBeEnabled();
      await page.evaluate(() => ((window as unknown as { __qaNoReload: boolean }).__qaNoReload = true));
      await page.locator("#deliver-to").selectOption(far.id);
      const warning = group.getByTestId("delivery-warning");
      await expect(warning).toContainText(/does not deliver/i);
      await expect(warning.getByRole("button", { name: "Change address" })).toBeVisible();
      await expect(pay).toBeDisabled();
      await page.locator("#deliver-to").selectOption(await homeAddressId("customer"));
      await expect(group.getByTestId("delivery-warning")).toHaveCount(0);
      await expect(pay).toBeEnabled();
      expect(await page.evaluate(() => (window as unknown as { __qaNoReload?: boolean }).__qaNoReload), "no page reload").toBe(true);
      const check = await validateCart("customer", far.id);
      const a = check.shops.find((s) => s.shopName === shopName("A"))!;
      expect(a.eligible).toBe(false);
      expect(a.issues.map((i) => i.code)).toContain("NOT_DELIVERABLE");
    } finally {
      await context.close();
      await clearCart("customer");
    }
    return `far address → "${shopName("A")} does not deliver…" + Change address, pay disabled; near address → cleared, pay enabled; no reload`;
  });
}, { ...SIGNED, mobile: true, partial: "the delivery fee does not depend on the address in this build (computeDeliveryFee uses the subtotal only), so only issues and eligibility change" });

qa(["TC-LOC-019", "TC-FLD-025"], "checkout to an address the shop does not reach, another user's, a made-up one or none is refused: no order, no debit, no stock change", async () => {
  const item = listing("packaged");
  const results: string[] = [];
  await withAddresses("customer", [{ ...FAR, line1: `QA far ${RUN}`, area: "Hinjewadi" }], async ([far]) => {
    await fillCart("customer", [{ item, quantity: 1 }]);
    const wallet = await walletOf();
    const stock = (await storefrontRow("A", item.shopProductId))?.onlineStock;
    const orders = (await ordersOf()).length;
    const refusals: [string, string | null, number[]][] = [
      ["out of zone", far.id, [422]],
      ["another user's address", world().addresses?.customer2 ?? need(null, "customer2's address id (local data)"), [403, 404]],
      ["a made-up id", "00000000-0000-4000-8000-000000000000", [404, 422]],
      ["not a uuid", "not-an-address", [422]],
      ["no address", null, [422]],
    ];
    for (const [what, addressId, statuses] of refusals) {
      const res = await checkoutAs("customer", { addressId, paymentMethod: "WALLET" });
      expect(statuses, `${what}: ${why(res)}`).toContain(res.status);
      if (what === "out of zone") expect(res.body?.error?.message, "names the shop").toContain(shopName("A"));
      if (what === "no address") expect(res.body?.error?.details?.missing).toBe("address");
      results.push(`${what} → ${res.status}`);
    }
    expect(await walletOf(), "no debit").toBe(wallet);
    expect((await ordersOf()).length, "no order").toBe(orders);
    if (stock !== undefined) expect((await storefrontRow("A", item.shopProductId))?.onlineStock, "no stock change").toBe(stock);
  });
  await clearCart("customer");
  return `${results.join("; ")}; wallet, orders and stock unchanged`;
}, { ...SIGNED, partial: "TC-FLD-025 'each listed option saves and shows': the cart's address list is checked in TC-LOC-004/TC-LOC-008" });

qa("TC-FLD-025", "checkout refuses an address the customer has deleted from the address book (it is no longer on the list)", async () => {
  const item = listing("packaged");
  const gone = await createAddress("customer");
  await removeAddress("customer", gone.id);
  expect((await listAddresses("customer")).some((a) => a.id === gone.id), "deleted address is off the list").toBe(false);
  await fillCart("customer", [{ item, quantity: 1 }]);
  const before = (await ordersOf()).length;
  const res = await checkoutAs("customer", { addressId: gone.id, paymentMethod: "WALLET" });
  try {
    expect([404, 422], `deleted own address: ${why(res)} — checkout accepted an address deleted from the address book`).toContain(res.status);
    expect((await ordersOf()).length).toBe(before);
  } finally {
    if (res.status === 201) for (const o of res.body.orders) await call(await as("customer"), "PATCH", `/api/orders/${o.id}/status`, { status: "CANCELLED", note: "QA clean-up" });
    await clearCart("customer");
  }
  return `deleted own address → ${res.status}`;
}, SIGNED);

qa("TC-LOC-021", "mixed cart: only the shop that cannot take the order is flagged; 'Remove these items' removes only its lines and pay becomes available", async ({ browser }) => {
  const a = listing("packaged");
  const b = listing("sharedB");
  need(world().users.shopB, "shop B's owner");
  await fillCart("customer", [{ item: a, quantity: 1 }, { item: b, quantity: 1 }]);
  return withShop("B", { ordersPaused: true }, async () => {
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, "/cart");
      const groupB = cartGroup(page, shopName("B"));
      await expect(groupB.getByTestId("delivery-warning")).toContainText(/not taking new orders/i);
      await expect(cartGroup(page, shopName("A")).getByTestId("delivery-warning")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Pay from wallet/ })).toBeDisabled();
      await groupB.getByRole("button", { name: "Remove these items" }).click();
      await expect(page.getByRole("link", { name: shopName("B"), exact: true })).toHaveCount(0);
      await expect(page.getByText(a.name).first()).toBeVisible();
      await expect(page.getByRole("button", { name: /Pay from wallet/ })).toBeEnabled();
      const cart = await validateCart("customer");
      expect(cart.shops.map((s) => s.shopName)).toEqual([shopName("A")]);
    } finally {
      await context.close();
      await clearCart("customer");
    }
    return `${shopName("B")} paused → only its group flagged; 'Remove these items' left ${a.name} from ${shopName("A")}; pay enabled`;
  });
}, { ...SIGNED, mobile: true, partial: "an out-of-zone group offers 'Change address' (not a remove) — that path is TC-LOC-018; here the flagged shop is one not taking orders" });

/* ------------------------------------------------------------- address fields */

qa("TC-FLD-010", "address type: each of Home / Work / Other saves and shows after reload; a value not in the list is refused (422)", async ({ browser }) => {
  const bad = await postAddress("customer", { ...addressBody(), addressType: "PALACE" });
  expect(bad.status, "unlisted type").toBe(422);
  const none = await postAddress("customer", addressBody({ addressType: undefined }));
  expectStatus(none, 201, "no type");
  const noneType = none.body.addressType;
  await removeAddress("customer", none.body.id);
  const seen: string[] = [];
  return withAddresses("customer", (["HOME", "WORK", "OTHER"] as const).map((t) => ({ addressType: t, line1: `QA type ${t} ${RUN}` })), async (saved) => {
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, "/profile/addresses");
      await page.reload();
      for (const a of saved) {
        const label = a.addressType === "HOME" ? "Home" : a.addressType === "WORK" ? "Work" : "Other";
        const card = page.locator("div").filter({ hasText: a.line1 }).filter({ has: page.getByRole("button", { name: "Edit" }) }).last();
        await expect(card).toContainText(label);
        seen.push(label);
      }
      await page.getByRole("button", { name: "Add a new address" }).click();
      await expect(page.getByRole("radiogroup", { name: "Address type" }).getByRole("radio", { checked: true }), "a type is always chosen in the form").toHaveText("Home");
    } finally {
      await context.close();
    }
    return `unlisted → 422; ${seen.join(", ")} saved and shown after reload; the form preselects Home; the API saves a missing type as ${noneType}`;
  });
}, { ...SIGNED, partial: "'nothing chosen' cannot happen in the form (Home is preselected) and the API defaults a missing type to OTHER (addresses.ts) — recorded, not refused" });

/** Saves `value` into `field` and returns the stored row (or the refusal). */
async function trySave(field: string, value: unknown) {
  const res = await postAddress("customer", { ...addressBody(), [field]: value });
  return res;
}

qa(["TC-FLD-011", "TC-FLD-013", "TC-FLD-014", "TC-FLD-015"], "address text fields: blank/spaces refused where required, over-long refused at the limit (never 500), script and Hindi/Marathi stored as text, outer spaces trimmed", async ({ browser }) => {
  const script = "<script>alert(1)</script> & % ' \"";
  const hindi = "श्री गणेश सोसायटी, फ्लॅट क्र. ४";
  const notes: string[] = [];
  const created: string[] = [];
  let alerted = false;
  try {
    // Required lines: blank and spaces-only refused.
    for (const field of ["line1", "city"]) {
      for (const value of ["", "   "]) {
        const res = await trySave(field, value);
        expect(res.status, `${field} "${value}"`).toBe(422);
      }
    }
    // Over-long: refused at the schema limit, never a 500.
    const limits: Record<string, number> = { recipientName: 100, line1: 200, line2: 200, landmark: 200, city: 100, state: 100 };
    for (const [field, limit] of Object.entries(limits)) {
      const over = await trySave(field, "x".repeat(301));
      expect(over.status, `${field} 301 chars`).toBe(422);
      const at = await trySave(field, "y".repeat(limit));
      expectStatus(at, 201, `${field} at its limit (${limit})`);
      created.push(at.body.id);
      notes.push(`${field} ≤${limit}`);
    }
    // Script text and Hindi / Marathi, with outer spaces.
    const res = await postAddress("customer", {
      ...addressBody(),
      recipientName: `  ${hindi}  `,
      line1: `  ${script}  `,
      line2: hindi,
      landmark: script,
      city: "  पुणे  ",
      state: "  महाराष्ट्र  ",
      deliveryInstructions: hindi,
    });
    expectStatus(res, 201, "script / Hindi address");
    created.push(res.body.id);
    expect(res.body).toMatchObject({ recipientName: hindi, line1: script, line2: hindi, landmark: script, city: "पुणे", state: "महाराष्ट्र" });
    // One character is enough for a line.
    const one = await trySave("line1", "A");
    expectStatus(one, 201, "one-character line");
    created.push(one.body.id);
    // Blank optional fields are accepted.
    const blanks = await postAddress("customer", { ...addressBody(), landmark: "", line2: "", recipientName: "" });
    expectStatus(blanks, 201, "blank optional fields");
    created.push(blanks.body.id);

    const { context, page } = await signedPage(browser, "customer");
    page.on("dialog", async (d) => {
      alerted = true;
      await d.dismiss();
    });
    try {
      await open(page, "/profile/addresses");
      const card = page.locator("div").filter({ hasText: hindi }).filter({ has: page.getByRole("button", { name: "Edit" }) }).last();
      await expect(card).toContainText(script);
      await expect(card).toContainText(`Landmark: ${script}`);
      await expect(card).toContainText("पुणे");
      expect(alerted, "no script ran").toBe(false);
    } finally {
      await context.close();
    }
  } finally {
    for (const id of created) await removeAddress("customer", id);
  }
  return `line1/city blank & spaces → 422; limits ${notes.join(", ")} (301 → 422); script and Hindi stored and shown as text, outer spaces trimmed; blank landmark/line2/name accepted`;
}, {
  ...SIGNED,
  partial: "recipient name and state are optional in this build (address form '(optional)', route schema nullish), so blank is accepted (expected superseded); no auto-fill of city/state from the PIN; the rider's view of the lines is TC-FLD-013 in local/shopping-delivery-leg.spec.ts",
});

qa("TC-FLD-016", "address PIN: blank, 5/7 digits, letters and symbols refused (422); a valid PIN saved; PIN far from the map pin → serviceability goes by the pin", async () => {
  const refused: string[] = [];
  for (const pincode of ["", "41103", "4110381", "41a038", "41-038", "      "]) {
    const res = await postAddress("customer", { ...addressBody(), pincode });
    expect(res.status, `PIN "${pincode}"`).toBe(422);
    refused.push(`"${pincode}"`);
  }
  // A Delhi PIN with a pin next to shop A: the distance (the pin) decides, everywhere the same.
  return withAddresses("customer", [{ pincode: "110001", ...pointNorth(1), line1: `QA mismatch ${RUN}` }], async ([a]) => {
    expect(a.pincode).toBe("110001");
    await fillCart("customer", [{ item: listing("packaged"), quantity: 1 }]);
    try {
      const check = await validateCart("customer", a.id);
      const shopA = check.shops.find((s) => s.shopName === shopName("A"))!;
      expect(shopA.eligible, "cart: deliverable by distance").toBe(true);
      expect(shopA.distanceKm).toBe(1);
    } finally {
      await clearCart("customer");
    }
    return `refused ${refused.join(", ")}; PIN 110001 with a pin 1 km from shop A: cart check eligible at 1 km (coordinates decide; checkout uses the same shopServiceability)`;
  });
}, { ...SIGNED, partial: "PINs starting with 0 are accepted — known defect D-04 (checked in the next check)" });

qa("TC-FLD-016", "address PIN: 000000 and a PIN starting with 0 are refused", async () => {
  const seen: string[] = [];
  for (const pincode of ["000000", "011001"]) {
    const res = await postAddress("customer", { ...addressBody(), pincode });
    if (res.status === 201) await removeAddress("customer", res.body.id);
    seen.push(`${pincode} → ${res.status}`);
  }
  expect(seen, `known defect D-04: ${seen.join(", ")}`).toEqual(["000000 → 422", "011001 → 422"]);
  return seen.join(", ");
}, SIGNED);

qa("TC-FLD-018", "default flag: exactly one default at any time; deleting the default is refused or another becomes default", async () => {
  return withAddresses("customer", [{ line1: `QA def1 ${RUN}` }, { line1: `QA def2 ${RUN}` }], async ([one, two]) => {
    expectStatus(await setDefault("customer", two), 200, "mark the second as default");
    let list = await listAddresses("customer");
    expect(list.filter((a) => a.isDefault).map((a) => a.id)).toEqual([two.id]);
    // default = true for both through the API.
    expectStatus(await setDefault("customer", one), 200, "first as default too");
    list = await listAddresses("customer");
    expect(list.filter((a) => a.isDefault).map((a) => a.id), "only the last one stays default").toEqual([one.id]);
    const created = await createAddress("customer", { line1: `QA def3 ${RUN}`, isDefault: true });
    list = await listAddresses("customer");
    expect(list.filter((a) => a.isDefault).map((a) => a.id), "a new default replaces the old").toEqual([created.id]);
    // Delete the default.
    const del = await call(await as("customer"), "DELETE", `/api/addresses/${created.id}`);
    list = await listAddresses("customer");
    const defaults = list.filter((a) => a.isDefault).length;
    expect(del.status === 204 ? defaults : 1, `deleting the default answered ${del.status}; afterwards ${defaults} address(es) are marked default`).toBe(1);
    return `second → only default; both via API → one; new default replaces; delete default → ${del.status}, ${defaults} default left`;
  });
}, SIGNED);

/* ------------------------------------------------------------------- society */

qa(["TC-LOC-028", "TC-FLD-019"], "an address cannot be linked to an unverified society, to one the user is not a member of, or to a made-up value", async () => {
  const society = need(world().society, "a verified society in the test data");
  const address = need(world().addresses?.customer2, "customer2's address id (local data)");
  const results: string[] = [];
  // A society customer2 registers is not verified yet (it is customer2's own, still PENDING).
  const own = await call(await as("customer2"), "POST", "/api/societies", {
    name: `QA Pending Society ${RUN}`,
    addressLine1: "QA Road",
    city: "Pune",
    pincode: FAR.pincode,
  });
  const pendingId: string | undefined = own.body?.id ?? own.body?.society?.id;
  for (const [what, societyId, statuses] of [
    ["verified, not a member", society.id, [403]],
    ...(pendingId ? [["unverified (own registration)", pendingId, [403]]] : []),
    ["made-up id", "00000000-0000-4000-8000-000000000000", [403, 404]],
    ["not a uuid", "society-1", [422]],
  ] as [string, string, number[]][]) {
    const res = await call(await as("customer2"), "PUT", `/api/addresses/${address}/society`, { societyId });
    expect(statuses, `${what}: ${why(res)}`).toContain(res.status);
    results.push(`${what} → ${res.status}`);
  }
  const after = (await listAddresses("customer2")).find((a) => a.id === address);
  expect(after?.societyId ?? null, "no link stored").toBeNull();
  return `${results.join("; ")}${pendingId ? "" : ` (no pending society: POST /api/societies ${own.status})`}; address unchanged`;
}, { ...SIGNED, partial: "TC-FLD-019 'each listed option saves' is TC-LOC-027" });

qa(["TC-LOC-027", "TC-FLD-019"], "link an address to the verified society the customer is an approved member of; the order carries the society and shows on its dashboard", async ({ browser }) => {
  const society = need(world().society, "a verified society in the test data");
  need(world().users.society, "the society's admin account");
  const join = await call(await as("customer"), "POST", `/api/societies/${society.id}/members`, { unitLabel: `A-${RUN}` });
  expect([201, 409], `join: ${why(join)}`).toContain(join.status);
  if (join.status === 201) {
    const approve = await call(await as("society"), "PATCH", `/api/societies/members/${join.body.id}`, { action: "approve" });
    expectStatus(approve, 200, "society admin approves");
  }
  const addressId = await homeAddressId("customer");
  let orderId: string | null = null;
  try {
    // The page offers the society for the address.
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, "/profile/addresses");
      const select = page.getByTestId("address-societies").getByLabel("Society for this address").first();
      await expect(select.locator("option", { hasText: society.name })).toHaveCount(1);
    } finally {
      await context.close();
    }
    const link = await call(await as("customer"), "PUT", `/api/addresses/${addressId}/society`, { societyId: society.id });
    expectStatus(link, 200, "link the address");
    expect((await listAddresses("customer")).find((a) => a.id === addressId)?.societyId).toBe(society.id);
    await fillCart("customer", [{ item: listing("packaged"), quantity: 1 }]);
    const res = await checkoutAs("customer", { addressId, paymentMethod: "WALLET", acknowledgeClosedShopIds: [world().shops.A?.id].filter(Boolean) });
    expectStatus(res, 201, "order to the society address");
    orderId = res.body.orders[0].id;
    const number = res.body.orders[0].orderNumber as string;
    const dash = await call(await as("society"), "GET", `/society/${society.id}`, undefined, { maxRedirects: 3 });
    expectStatus(dash, 200, "society dashboard");
    expect(dash.text, "the order is among the society's deliveries").toContain(number);
    return `member approved, address linked to ${society.name}; order ${number} listed on the society dashboard`;
  } finally {
    if (orderId) await call(await as("customer"), "PATCH", `/api/orders/${orderId}/status`, { status: "CANCELLED", note: "QA clean-up" });
    await call(await as("customer"), "PUT", `/api/addresses/${addressId}/society`, { societyId: null });
    await clearCart("customer");
  }
}, SIGNED);
