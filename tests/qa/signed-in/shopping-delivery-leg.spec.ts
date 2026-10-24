/**
 * What the customer writes at checkout and on the address reaches the right
 * people at the right time: order notes for the shop, the address lines,
 * landmark and delivery instructions for the rider — only once the order is
 * picked up — and, after delivery, the customer's review on the shop page.
 * One order goes through the whole delivery; the checks hand it on through
 * the stash, so a failed step blocks the ones after it.
 *
 * Signed-in tier (the local run makes rider 1 the only one online).
 */
import type { Page } from "@playwright/test";

import { as } from "../lib/actors";
import { deliveryCode, offerFor, onlyRiderOnline, pickupCode, riderAction } from "../lib/flows";
import { call, expectStatus, RUN, stash, unstash, why } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";
import {
  cancelAsShop,
  checkoutAs,
  clearCart,
  createAddress,
  fillCart,
  listing,
  open,
  pointNorth,
  removeAddress,
  shopSlug,
  signedPage,
  SIGNED,
} from "../lib/shopping-helpers";

// Not keyed by RUN: Playwright starts a new worker (and a new RUN) after a failed check, and the order must survive that.
const KEY = "shopping-delivery-leg";
const NOTE = `QA note ${RUN}: <b>ring</b> & leave at door — कृपया दूध फ्रिजमध्ये ठेवा`;
const LINE1 = `QA Leg ${RUN} Karve Road`;
const LINE2 = "Flat 12B, 3rd floor";
const LANDMARK = "<script>alert(1)</script> opposite Ganesh temple";
const INSTRUCTIONS = "गेटवर कॉल करा — call at the gate";

interface Leg {
  orderId: string;
  orderNumber: string;
  addressId: string;
  line1: string;
  deliveryOrderId?: string;
  delivered?: boolean;
}

function current(): Leg {
  const leg = unstash<Leg | null>(KEY);
  if (!leg) blocked("needs the order placed by TC-FLD-028 in this run");
  return leg;
}

/** The rider dashboard's active job, as text. */
async function riderJobText(page: Page) {
  await open(page, "/delivery-partner");
  return (await page.locator("main").innerText()).replace(/\s+/g, " ");
}

qa(["TC-FLD-028", "TC-CART-017"], "order notes: blank is fine, over 500 characters refused (422), script / Marathi text accepted — and the notes reach the shop unchanged", async ({ browser }) => {
  stash(KEY, null);
  await onlyRiderOnline("rider");
  const address = await createAddress("customer", {
    line1: LINE1,
    line2: LINE2,
    landmark: LANDMARK,
    deliveryInstructions: INSTRUCTIONS,
    ...pointNorth(0.4),
  });
  const item = listing("packaged");
  await fillCart("customer", [{ item, quantity: 1 }]);
  const tooLong = await checkoutAs("customer", { addressId: address.id, paymentMethod: "WALLET", notes: "n".repeat(501) });
  expect(tooLong.status, `501-character notes: ${why(tooLong)}`).toBe(422);
  const blank = await checkoutAs("customer", { addressId: address.id, paymentMethod: "WALLET", notes: "" });
  expectStatus(blank, 201, "blank notes");
  await cancelAsShop("shop", blank.body.orders[0].id);
  await fillCart("customer", [{ item, quantity: 1 }]);
  const res = await checkoutAs("customer", { addressId: address.id, paymentMethod: "WALLET", notes: NOTE });
  expectStatus(res, 201, "checkout with notes");
  const order = res.body.orders[0];
  stash(KEY, { orderId: order.id, orderNumber: order.orderNumber, addressId: address.id, line1: LINE1 } satisfies Leg);
  await clearCart("customer");

  // The shop's view of the order: the orders board and the packing slip.
  const { context, page } = await signedPage(browser, "shop");
  try {
    await open(page, "/shop/orders");
    await expect(page.getByText(order.orderNumber).first()).toBeVisible();
    const board = await page.locator("main").innerText();
    await open(page, `/shop/orders/${order.id}/packing-slip`);
    const slip = await page.locator("main").innerText();
    const seen = board.includes(NOTE) || slip.includes(NOTE);
    expect(seen, "the customer's order notes are on the shop's orders board or packing slip (they are stored on the order but neither page renders orders.notes; the cart page has no notes field either)").toBe(true);
  } finally {
    await context.close();
  }
  return `501 chars → 422 (limit 500); blank ok; ${order.orderNumber} carries the note and the shop sees it unchanged`;
}, { ...SIGNED, partial: "the cart page (src/components/cart-view.tsx) has no notes field, so notes can only be sent through the API" });

qa(["TC-CART-017", "TC-FLD-029"], "before pickup the rider sees only the area: no street line, landmark or delivery instructions", async ({ browser }) => {
  const leg = current();
  for (const action of ["accept", "start", "ready"]) {
    expectStatus(await call(await as("shop"), "POST", `/api/orders/${leg.orderId}/fulfilment`, { action }), 200, `shop ${action}`);
  }
  const offer = await offerFor(leg.orderId, "rider");
  if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept"), 200, "rider accepts");
  stash(KEY, { ...leg, deliveryOrderId: offer.deliveryOrderId });
  const { context, page } = await signedPage(browser, "rider");
  try {
    const text = await riderJobText(page);
    expect(text, "the job is on the rider's dashboard").toContain(leg.orderNumber);
    expect(text, "area shown before pickup").toContain("Kothrud");
    for (const hidden of [leg.line1, LINE2, "Ganesh temple", INSTRUCTIONS]) expect(text, `"${hidden}" hidden before pickup`).not.toContain(hidden);
  } finally {
    await context.close();
  }
  return `${leg.orderNumber} accepted by the rider: area only, no street, landmark or instructions`;
}, SIGNED);

qa(["TC-CART-017", "TC-FLD-029"], "after pickup the rider sees the street line, the landmark and the instructions exactly as saved (script as text)", async ({ browser }) => {
  const leg = current();
  const id = leg.deliveryOrderId ?? blocked("needs the rider's job from the previous check");
  const code = await pickupCode(leg.orderId);
  expectStatus(await riderAction(id, "pickup", code ? { pickupCode: code } : {}), 200, "pickup");
  const { context, page } = await signedPage(browser, "rider");
  let alerted = false;
  page.on("dialog", async (d) => {
    alerted = true;
    await d.dismiss();
  });
  try {
    const text = await riderJobText(page);
    expect(text, "street line").toContain(leg.line1);
    expect(text, "landmark, script shown as text").toContain(LANDMARK);
    expect(text, "delivery instructions (Marathi)").toContain(INSTRUCTIONS);
    expect(alerted, "no script ran").toBe(false);
  } finally {
    await context.close();
  }
  return "after pickup: street line, landmark (script as text) and Marathi instructions as saved";
}, SIGNED);

qa("TC-FLD-013", "after pickup the rider sees both address lines, including the flat / house line, exactly as saved", async ({ browser }) => {
  const leg = current();
  const { context, page } = await signedPage(browser, "rider");
  try {
    const text = await riderJobText(page);
    if (!text.includes(leg.line1)) blocked("the picked-up job is not on the rider's dashboard (previous check)");
    expect(text, "address line 1").toContain(leg.line1);
    expect(text, `the flat / house line "${LINE2}" (address line 2) on the rider's job — getMyActiveDeliveryDetail builds the address from line1, area and city only`).toContain(LINE2);
  } finally {
    await context.close();
  }
  return "rider sees line 1 and line 2 as saved";
}, SIGNED);

qa("TC-DISC-013", "after delivery the customer's rating and review show on the shop page", async ({ browser }) => {
  const leg = current();
  const id = leg.deliveryOrderId ?? blocked("needs the rider's job");
  const status = (await call(await as("customer"), "GET", "/api/orders")).body;
  const now = (Array.isArray(status) ? status : status?.orders ?? []).find((o: { id: string }) => o.id === leg.orderId)?.status;
  if (now === "PICKED_UP") expectStatus(await riderAction(id, "start"), 200, "start delivery");
  const otp = await deliveryCode(leg.orderId);
  expectStatus(await riderAction(id, "deliver", { otp }), 200, "deliver");
  stash(KEY, { ...leg, delivered: true });
  const comment = `QA review ${RUN}: fresh butter`;
  const rate = await call(await as("customer"), "POST", `/api/orders/${leg.orderId}/rating`, { target: "SHOP", score: 4, comment });
  expectStatus(rate, [200, 201], "rate the shop");
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, `/shops/${shopSlug("A")}`);
    await page.getByText("Shop info, opening hours and reviews").click();
    await expect(page.getByTestId("shop-reviews")).toContainText(comment);
    await expect(page.getByTestId("shop-reviews")).toContainText("★★★★");
  } finally {
    await context.close();
    await removeAddress("customer", leg.addressId);
  }
  return `${leg.orderNumber} delivered, rated 4★ "${comment}" — shown under the shop's reviews`;
}, { ...SIGNED, partial: "the rating badge average is covered by the ratings spec; here the recent-review list" });
