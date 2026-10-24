/**
 * Returns, refunds and disputes (package 5): the customer's return form and
 * its field rules, the shop's decision, the rider's return pickup with the
 * customer's handover code, inspection and refund (full, partial, rejected),
 * cancellation, the timeline, the operations queue, evidence privacy and the
 * operator's refund of a delivered order.
 *
 * Signed-in tier. One delivered order with two units of four lines hosts
 * several returns (each takes one unit); a second delivered order takes the
 * operator refunds. Rider pickups are driven on the rider's dashboard.
 */
import type { Browser, Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { onlyRiderOnline } from "../lib/flows";
import {
  anonymous,
  call,
  checkoutLines,
  driveTo,
  ensureWallet,
  evidencePhoto,
  expectStatus,
  homeSpot,
  keep,
  kept,
  listingOf,
  notesFor,
  orderRow,
  PDF_BYTES,
  png,
  releaseRiders,
  RUN,
  TEXT,
  upload,
  walletOf,
  withShopSettings,
} from "../lib/orders-helpers";
import { blocked, expect, qa } from "../lib/record";
import { IS_LOCAL } from "../lib/target";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 300_000 };

interface Delivered {
  id: string;
  orderNumber: string;
  items: { id: string; name: string; shopProductId: string; lineTotalPaise: number; quantityMilli: number }[];
}

function order(): Delivered {
  return kept<Delivered>("returns-order") ?? blocked("needs the delivered order of the first returns check in this run");
}

function line(o: Delivered, key: "packaged" | "sharedA" | "milk" | "premium") {
  const id = world().listings[key]?.shopProductId;
  const found = o.items.find((i) => i.shopProductId === id) ?? (key === "packaged" ? o.items[0] : undefined);
  return found ?? blocked(`the delivered order has no ${key} line`);
}

async function ready() {
  await releaseRiders();
  await onlyRiderOnline("rider");
  await ensureWallet();
}

/** Requests a return through the API (the form posts the same body). */
async function requestReturn(orderId: string, body: Record<string, unknown>) {
  return call(await as("customer"), "POST", `/api/orders/${orderId}/returns`, body);
}

async function returnDetail(id: string, role: "customer" | "shop" | "ops" = "customer") {
  const res = await call(await as(role), "GET", `/api/returns/${id}`);
  expectStatus(res, 200, "return detail");
  return res.body as { ret: { id: string; status: string; refundAmountPaise: number; refundedPaise: number | null; decisionNote: string | null; returnNumber: string; comment: string | null }; pickup: { status: string; handoverCode?: string } | null; history: { toStatus: string; note: string | null; createdAt: string }[]; items: { comment: string | null; condition: string; quantityMilli: number }[]; actions: string[] };
}

async function act(id: string, body: Record<string, unknown>, role: "customer" | "shop" | "ops" = "shop") {
  return call(await as(role), "PATCH", `/api/returns/${id}`, body);
}

/** Opens a return (one unit of a line) with a photo; returns its id and number. */
async function openReturn(o: Delivered, key: "packaged" | "sharedA" | "milk" | "premium", reason = "QUALITY_ISSUE", extra: Record<string, unknown> = {}) {
  const l = line(o, key);
  const photo = await evidencePhoto();
  const res = await requestReturn(o.id, { reason, items: [{ orderItemId: l.id, quantityMilli: 1000, condition: "OPENED", imageIds: [photo] }], ...extra });
  expectStatus(res, 201, `return of ${l.name}`);
  return { id: String(res.body.id), returnNumber: String(res.body.returnNumber), photo };
}

function riderSpot() {
  const home = homeSpot();
  return { geolocation: { latitude: home.lat + 0.001, longitude: home.lng + 0.001 }, permissions: ["geolocation"] };
}

/** The rider's return-pickup panel on the dashboard. */
async function pickupPanel(page: Page) {
  await page.goto("/delivery-partner");
  const panel = page.getByTestId("return-pickup-panel");
  await expect(panel, "the return pickup reaches the rider").toBeVisible({ timeout: 20_000 });
  return panel;
}

/** Rider accepts and sets off on the dashboard. */
async function acceptAndSetOff(browser: Browser, returnId: string) {
  const { context, page } = await pageAs(browser, "rider", riderSpot());
  try {
    let panel = await pickupPanel(page);
    await panel.getByRole("button", { name: "Accept" }).click();
    await expect.poll(async () => (await returnDetail(returnId)).ret.status, { timeout: 15_000 }).toBe("PICKUP_ASSIGNED");
    panel = await pickupPanel(page);
    await panel.getByRole("button", { name: "Set off to the customer" }).click();
    await expect.poll(async () => (await returnDetail(returnId)).ret.status, { timeout: 15_000 }).toBe("RIDER_EN_ROUTE");
  } finally {
    await context.close();
  }
}

async function enterHandover(browser: Browser, code: string) {
  const { context, page } = await pageAs(browser, "rider", riderSpot());
  try {
    const panel = await pickupPanel(page);
    await panel.getByLabel("Handover code from the customer").fill(code);
    await panel.getByRole("button", { name: "Confirm pickup" }).click();
    await page.waitForLoadState("networkidle").catch(() => {});
    return (await panel.innerText().catch(() => "")) + (await page.locator("body").innerText());
  } finally {
    await context.close();
  }
}

qa(["TC-RET-001", "TC-FLD-095"], "the return form lists each line with its returnable quantity, condition, comment, photos and the reasons (no 'Changed my mind'), and the window end", async ({ browser }) => {
  await ready();
  const lines = [await listingOf("packaged"), await listingOf("sharedA"), await listingOf("milk"), await listingOf("premium")];
  const placed = await checkoutLines(lines.map((listing) => ({ listing, quantity: 2 })));
  await driveTo(placed.id, "DELIVERED");
  const row = await orderRow(placed.id);
  const delivered: Delivered = {
    id: placed.id,
    orderNumber: placed.orderNumber,
    items: row.items.map((i) => ({ id: i.id, name: i.productNameSnapshot, shopProductId: i.shopProductId, lineTotalPaise: i.lineTotalPaise, quantityMilli: i.quantityMilli })),
  };
  keep("returns-order", delivered);
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto(`/orders/${placed.id}/return`);
    const form = page.getByTestId("return-form");
    await expect(form).toBeVisible();
    await expect(form.getByText(/You can request a return until/)).toBeVisible();
    for (const l of lines) await expect(form.getByText(l.name).first()).toBeVisible();
    await form.getByRole("checkbox").first().check();
    await expect(form.getByLabel(/Quantity to return \(max 2\)/)).toBeVisible();
    await expect(form.getByLabel("Condition")).toBeVisible();
    await expect(form.getByLabel("Comment on this item (optional)")).toBeVisible();
    await expect(form.getByRole("button", { name: "Add photos" })).toBeVisible();
    const reasons = await form.getByLabel("Reason for the return").locator("option").allInnerTexts();
    expect(reasons).not.toContain("Changed my mind");
    expect(reasons).toEqual(expect.arrayContaining(["Damaged in delivery", "Wrong item received", "Item missing"]));
    // Submitting with no reason chosen is refused on the form (TC-FLD-095).
    await form.getByRole("button", { name: "Submit return request" }).click();
    await expect(form.getByText("Choose a reason for the return.")).toBeVisible();
  } finally {
    await context.close();
  }
  const odd = await requestReturn(placed.id, { reason: "BANANA", items: [{ orderItemId: delivered.items[0].id, quantityMilli: 1000, condition: "OPENED" }] });
  const changed = await requestReturn(placed.id, { reason: "CHANGED_MIND", items: [{ orderItemId: delivered.items[0].id, quantityMilli: 1000, condition: "OPENED" }] });
  const badCondition = await requestReturn(placed.id, { reason: "MISSING_ITEM", items: [{ orderItemId: delivered.items[0].id, quantityMilli: 1000, condition: "SHINY" }] });
  expect(odd.status, "reason outside the list").toBe(422);
  expect(changed.status, "CHANGED_MIND (not offered)").toBe(422);
  expect(badCondition.status, "condition outside the list").toBe(422);
  return `${placed.orderNumber} delivered (4 lines × 2); form: lines, max 2, condition, comment, photos, reasons without 'Changed my mind', window end; no reason → field message; API: BANANA ${odd.status}, CHANGED_MIND ${changed.status} ("${changed.body?.error?.message}"), bad condition ${badCondition.status}`;
}, { ...signed, mobile: true, partial: "'each option saved and shown after reload' is shown for one reason/condition (DAMAGED, next check); the others are not each submitted" });

qa(["TC-RET-002", "TC-FLD-097", "TC-RET-015"], "'Damaged' needs a photo: refused without; bad files refused; with a valid photo the return is created 'Under review' and the shop is told; the photo is private", async ({ browser }) => {
  const o = order();
  const l = line(o, "packaged");
  const notes: string[] = [];
  const customer = await as("customer");
  const files: [string, { name: string; mimeType: string; buffer: Buffer }][] = [
    ["empty file", { name: "empty.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(0) }],
    ["PDF renamed .jpg", { name: "doc.jpg", mimeType: "image/jpeg", buffer: PDF_BYTES }],
    ["SVG renamed .jpg", { name: "pic.jpg", mimeType: "image/jpeg", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"></svg>') }],
    ["over 2 MB", { name: "big.png", mimeType: "image/png", buffer: Buffer.concat([png(), Buffer.alloc(2_100_000)]) }],
  ];
  for (const [what, file] of files) {
    const res = await upload(customer, "/api/images", file, { purpose: "RETURN_EVIDENCE" });
    expect(res.status, `${what}: ${res.status} ${res.body?.error?.message}`).toBe(422);
    notes.push(`${what} → 422 "${res.body?.error?.message}"`);
  }
  const noPhoto = await requestReturn(o.id, { reason: "DAMAGED", items: [{ orderItemId: l.id, quantityMilli: 1000, condition: "DAMAGED" }] });
  expect(noPhoto.status, "Damaged without a photo").toBe(422);
  const photos = await Promise.all(Array.from({ length: 7 }, () => evidencePhoto()));
  const tooMany = await requestReturn(o.id, { reason: "DAMAGED", items: [{ orderItemId: l.id, quantityMilli: 1000, condition: "DAMAGED", imageIds: photos }] });
  expect(tooMany.status, "7 photos (limit 6)").toBe(422);
  notes.push(`no photo → ${noPhoto.status}; 7 photos → ${tooMany.status} "${tooMany.body?.error?.message}"`);

  const { context, page } = await pageAs(browser, "customer");
  let returnId = "";
  try {
    await page.goto(`/orders/${o.id}/return`);
    const form = page.getByTestId("return-form");
    const item = form.locator("div.space-y-3").filter({ hasText: l.name }).first();
    await item.getByRole("checkbox").check();
    await item.getByLabel(/Quantity to return/).fill("1");
    await item.getByLabel("Condition").selectOption("DAMAGED");
    await form.getByLabel("Reason for the return").selectOption("DAMAGED");
    await form.getByRole("button", { name: "Submit return request" }).click();
    await expect(form.getByText("Please add a photo showing the problem.")).toBeVisible();
    await item.locator('input[type="file"]').setInputFiles({ name: "damage.png", mimeType: "image/png", buffer: png() });
    await expect(item.getByRole("img", { name: "Uploaded" })).toBeVisible({ timeout: 15_000 });
    await form.getByRole("button", { name: "Submit return request" }).click();
    await page.waitForURL(/\/returns\/[0-9a-f-]{36}/, { timeout: 20_000 });
    returnId = page.url().split("/returns/")[1];
    await expect(page.getByTestId("return-case")).toContainText("Under review");
    await page.reload();
    await expect(page.getByTestId("return-case")).toContainText("Damaged in delivery");
    await expect(page.getByTestId("return-case")).toContainText("(Damaged)");
  } finally {
    await context.close();
  }
  const detail = await returnDetail(returnId);
  expect(detail.ret.status).toBe("UNDER_REVIEW");
  keep("return-damaged", { id: returnId, returnNumber: detail.ret.returnNumber });
  const shopTold = await notesFor("shop", detail.ret.returnNumber);
  expect(shopTold.map((n) => n.title), "shop told").toContain("New return request");
  // Evidence privacy (TC-RET-015): the photo of this return.
  const imageId = (await returnDetail(returnId, "shop")).items.length ? ((await call(await as("shop"), "GET", `/api/returns/${returnId}`)).body.items[0].imageIds[0] as string) : "";
  expect(imageId, "the return carries its photo").toBeTruthy();
  const who: Record<string, number> = {};
  for (const role of ["customer", "shop", "ops", "customer2"] as const) who[role] = (await call(await as(role), "GET", `/api/images/${imageId}`)).status;
  const guest = await anonymous();
  who.guest = (await call(guest, "GET", `/api/images/${imageId}`)).status;
  await guest.dispose();
  expect(who.customer).toBe(200);
  expect(who.shop, "shop owner").toBe(200);
  expect(who.ops, "staff").toBe(200);
  expect(who.customer2, "another customer").toBe(404);
  expect(who.guest, "guest").toBe(404);
  return `${notes.join("; ")}; form refused Damaged without a photo, then created ${detail.ret.returnNumber} 'Under review' with one; shop told; photo access ${JSON.stringify(who)}`;
}, { ...signed, mobile: true });

qa(["TC-RET-003", "TC-FLD-094"], "quantities: more than delivered, the same line twice, a second return beyond what is left, 0, negative, text and huge are refused; 2 accepted, 3 refused", async ({ browser }) => {
  const o = order();
  const bread = line(o, "sharedA");
  const notes: string[] = [];
  for (const [what, q, status] of [
    ["3 of 2", 3000, 422],
    ["0", 0, 422],
    ["-1", -1000, 422],
    ["99999999", 99_999_999_000, 422],
    ["text", "two", 422],
  ] as const) {
    const res = await requestReturn(o.id, { reason: "MISSING_ITEM", items: [{ orderItemId: bread.id, quantityMilli: q, condition: "OPENED" }] });
    expect(res.status, what).toBe(status);
    notes.push(`${what} → ${res.status}${res.body?.error?.message ? ` "${res.body.error.message}"` : ""}`);
  }
  const twice = await requestReturn(o.id, { reason: "MISSING_ITEM", items: [{ orderItemId: bread.id, quantityMilli: 1000, condition: "OPENED" }, { orderItemId: bread.id, quantityMilli: 1000, condition: "OPENED" }] });
  expect(twice.status, "same line twice in one request").toBe(422);
  notes.push(`same line twice → ${twice.status}`);
  const damaged = line(o, "packaged");
  const beyond = await requestReturn(o.id, { reason: "MISSING_ITEM", items: [{ orderItemId: damaged.id, quantityMilli: 2000, condition: "OPENED" }] });
  expect(beyond.status, "a second return beyond what is left").toBe(422);
  expect(beyond.body?.error?.message, "names the maximum").toMatch(/at most 1/);
  notes.push(`2 more of a line with 1 left → ${beyond.status} "${beyond.body?.error?.message}"`);
  const half = await requestReturn(o.id, { reason: "MISSING_ITEM", items: [{ orderItemId: bread.id, quantityMilli: 1500, condition: "OPENED" }] });
  notes.push(`1.5 packs → ${half.status}`);
  if (half.status === 201) await act(String(half.body.id), { action: "cancel" }, "customer");
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto(`/orders/${o.id}/return`);
    const form = page.getByTestId("return-form");
    const item = form.locator("div.space-y-3").filter({ hasText: bread.name }).first();
    await item.getByRole("checkbox").check();
    await form.getByLabel("Reason for the return").selectOption("MISSING_ITEM");
    for (const value of ["", "0", "-1", "abc", "99999999", "3"]) {
      await item.getByLabel(/Quantity to return/).fill(value);
      await form.getByRole("button", { name: "Submit return request" }).click();
      await expect(form.getByText(/Enter a quantity between 0 and 2/), `form refuses ${JSON.stringify(value)}`).toBeVisible();
    }
    notes.push("form refuses blank, 0, -1, text, 99999999 and 3 with 'Enter a quantity between 0 and 2'");
  } finally {
    await context.close();
  }
  expect(half.status, `a decimal quantity of a packaged line is refused — ${notes.join("; ")}`).toBe(422);
  return notes.join("; ");
}, { ...signed, partial: "'2 accepted' is shown by the 2-unit lines elsewhere (returns of 1 unit each are accepted in the checks around)" });

qa(["TC-RET-005", "TC-RET-007"], "the shop sees the photo and approves: customer told, a rider pickup is offered; the rider accepts on the dashboard (Pickup assigned), the customer sees the handover code and picks a time (Pickup scheduled)", async ({ browser }) => {
  await ready();
  const damaged = kept<{ id: string; returnNumber: string }>("return-damaged") ?? blocked("needs the return created by TC-RET-002");
  const shop = await pageAs(browser, "shop");
  try {
    await shop.page.goto("/shop/returns?tab=requests");
    const card = shop.page.getByTestId("return-case").filter({ hasText: damaged.returnNumber }).first();
    await expect(card).toBeVisible();
    const img = card.getByRole("img", { name: "Evidence" }).first();
    await expect(img).toBeVisible();
    expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth), "the photo loads for the shop").toBeGreaterThan(0);
    await card.getByRole("button", { name: "Approve return" }).click();
    await expect.poll(async () => (await returnDetail(damaged.id)).ret.status, { timeout: 15_000 }).toMatch(/APPROVED|PICKUP_ASSIGNED/);
  } finally {
    await shop.context.close();
  }
  const told = await notesFor("customer", damaged.returnNumber);
  expect(told.map((n) => n.title), "customer told").toContain("Return approved");
  const { context, page } = await pageAs(browser, "rider", riderSpot());
  try {
    const panel = await pickupPanel(page);
    await expect(panel).toContainText(damaged.returnNumber);
    await expect(panel, "the rider never sees the handover code").not.toContainText(/Handover code:/);
    await panel.getByRole("button", { name: "Accept" }).click();
    await expect.poll(async () => (await returnDetail(damaged.id)).ret.status, { timeout: 15_000 }).toBe("PICKUP_ASSIGNED");
  } finally {
    await context.close();
  }
  const customer = await pageAs(browser, "customer");
  try {
    await customer.page.goto(`/returns/${damaged.id}`);
    const caseCard = customer.page.getByTestId("return-case");
    await expect(caseCard.getByTestId("handover-code")).toContainText(/\d{4}/);
    await caseCard.getByRole("button", { name: "Choose pickup time" }).click();
    const when = new Date(Date.now() + 3 * 3_600_000);
    const local = new Date(when.getTime() - when.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await caseCard.locator('input[type="datetime-local"]').fill(local);
    await caseCard.getByRole("button", { name: "Save time" }).click();
    await expect.poll(async () => (await returnDetail(damaged.id)).ret.status, { timeout: 15_000 }).toBe("PICKUP_SCHEDULED");
  } finally {
    await customer.context.close();
  }
  return `${damaged.returnNumber}: shop saw the photo and approved; customer told; rider accepted on the dashboard (no code shown); customer saw the handover code and chose a time → PICKUP_SCHEDULED`;
}, { ...signed, mobile: true });

qa(["TC-RET-008", "TC-RET-010", "TC-RET-021"], "set off, a wrong handover code is refused, the right one completes the pickup (rider paid a fee); goods received, inspected, refunded in full to the wallet; the customer's timeline shows every step", async ({ browser }) => {
  const damaged = kept<{ id: string; returnNumber: string }>("return-damaged") ?? blocked("needs the return created by TC-RET-002");
  const { context, page } = await pageAs(browser, "rider", riderSpot());
  try {
    const panel = await pickupPanel(page);
    await panel.getByRole("button", { name: "Set off to the customer" }).click();
    await expect.poll(async () => (await returnDetail(damaged.id)).ret.status, { timeout: 15_000 }).toBe("RIDER_EN_ROUTE");
  } finally {
    await context.close();
  }
  const code = (await returnDetail(damaged.id)).pickup?.handoverCode ?? blocked("the customer's handover code");
  const wrong = code === "0000" ? "1111" : "0000";
  const afterWrong = await enterHandover(browser, wrong);
  expect(afterWrong, "wrong code refused").toMatch(/handover code does not match/i);
  expect((await returnDetail(damaged.id)).ret.status).toBe("RIDER_EN_ROUTE");
  const riderView = await call(await as("rider"), "GET", "/api/delivery-partner/deliveries");
  expect(riderView.text, "the rider API carries no handover code").not.toContain(`"${code}"`);
  await enterHandover(browser, code);
  await expect.poll(async () => (await returnDetail(damaged.id)).ret.status, { timeout: 15_000 }).toBe("PICKUP_COMPLETED");
  const earnings = await call(await as("rider"), "GET", "/api/delivery-partner/earnings");
  const fee = (earnings.body.statement as { returnPickupId: string | null; totalPaise: number }[]).find((e) => e.returnPickupId);
  expect(fee, "a return-pickup fee credited to the rider").toBeTruthy();

  const start = await walletOf();
  const shop = await pageAs(browser, "shop");
  try {
    await shop.page.goto("/shop/returns?tab=all");
    let card = shop.page.getByTestId("return-case").filter({ hasText: damaged.returnNumber }).first();
    await card.getByRole("button", { name: "Goods received" }).click();
    await expect.poll(async () => (await returnDetail(damaged.id)).ret.status, { timeout: 15_000 }).toBe("INSPECTION_PENDING");
    card = shop.page.getByTestId("return-case").filter({ hasText: damaged.returnNumber }).first();
    await card.getByRole("button", { name: "Inspect goods" }).click();
    await card.getByLabel("What did you find?").fill("Crushed pack, as the photo shows");
    await card.getByRole("button", { name: "Accept — refund the customer" }).click();
    await expect.poll(async () => (await returnDetail(damaged.id)).ret.status, { timeout: 20_000 }).toBe("REFUND_COMPLETED");
  } finally {
    await shop.context.close();
  }
  const detail = await returnDetail(damaged.id);
  expect(await walletOf(), "wallet credited with the line's value").toBe(start + detail.ret.refundAmountPaise);
  const told = await notesFor("customer", damaged.returnNumber);
  expect(told.map((n) => n.title), "refund notice").toContain("Refund completed");
  const steps = detail.history.map((h) => h.toStatus);
  for (const s of ["RETURN_REQUESTED", "UNDER_REVIEW", "APPROVED", "PICKUP_ASSIGNED", "PICKUP_SCHEDULED", "RIDER_EN_ROUTE", "PICKUP_COMPLETED", "INSPECTION_PENDING", "APPROVED_FOR_REFUND", "REFUND_INITIATED", "REFUND_COMPLETED"]) {
    expect(steps, `timeline has ${s}`).toContain(s);
  }
  const customer = await pageAs(browser, "customer");
  try {
    await customer.page.goto("/returns");
    await expect(customer.page.getByTestId("return-row").filter({ hasText: damaged.returnNumber })).toContainText("Refund completed");
    await customer.page.goto(`/returns/${damaged.id}`);
    const timeline = customer.page.getByRole("list", { name: "Timeline" });
    await expect(timeline.getByRole("listitem")).toHaveCount(detail.history.length);
  } finally {
    await customer.context.close();
  }
  let shopShare = "shop share not read (no database on this site)";
  if (IS_LOCAL) {
    const { db } = await import("../lib/db");
    const rows = await db()<{ type: string; amount_paise: number }[]>`select type, amount_paise from financial_adjustments where idempotency_key like ${`%after-delivery:return-${damaged.id}`}`;
    expect(rows.map((r) => r.type), "the shop's share recorded").toEqual(["REFUND_SHOP"]);
    shopShare = `shop share ${rows[0].amount_paise} paise (REFUND_SHOP)`;
  }
  return `wrong code refused, right code → PICKUP_COMPLETED, rider fee ₹${(fee!.totalPaise / 100).toFixed(2)}; refund ₹${detail.ret.refundAmountPaise / 100} → wallet; ${shopShare}; timeline of ${steps.length} steps on /returns/${damaged.id}`;
}, { ...signed, mobile: true });

qa(["TC-RET-010", "TC-FLD-098"], "inspection refund amount: 0, negative, text, 3 decimals, huge and more than paid are refused; ₹70.50 is stored as 7050 paise and refunded", async ({ browser }) => {
  await ready();
  const o = order();
  const ghee = line(o, "premium");
  const r = await openReturn(o, "premium");
  expectStatus(await act(r.id, { action: "approve" }), 200, "approve");
  await acceptAndSetOff(browser, r.id);
  const code = (await returnDetail(r.id)).pickup?.handoverCode ?? blocked("handover code");
  await enterHandover(browser, code);
  await expect.poll(async () => (await returnDetail(r.id)).ret.status, { timeout: 15_000 }).toBe("PICKUP_COMPLETED");
  expectStatus(await act(r.id, { action: "receive" }), 200, "goods received");
  const owed = (await returnDetail(r.id)).ret.refundAmountPaise;
  expect(owed, "one unit of the line").toBe(ghee.lineTotalPaise / 2);
  const notes: string[] = [];
  for (const [what, refundPaise] of [["0", 0], ["negative", -500], ["text", "abc"], ["3 decimals (10.555)", 1055.5], ["10,00,00,000", 10_000_000_000], ["more than paid", owed + 1]] as const) {
    const res = await act(r.id, { action: "inspect", outcome: "ACCEPT", note: "QA inspection", refundPaise });
    expect(res.status, what).toBe(422);
    notes.push(`${what} → 422`);
  }
  const { context, page } = await pageAs(browser, "shop");
  try {
    await page.goto("/shop/returns?tab=all");
    const card = page.getByTestId("return-case").filter({ hasText: r.returnNumber }).first();
    await card.getByRole("button", { name: "Inspect goods" }).click();
    await card.getByLabel("What did you find?").fill("Seal broken on one jar");
    await card.getByLabel(/Refund ₹/).fill("abc");
    await card.getByRole("button", { name: "Accept — refund the customer" }).click();
    await expect(card.getByText(/check the highlighted fields|Expected number|Invalid|between/i).first(), "text refused on the form").toBeVisible();
    expect((await returnDetail(r.id)).ret.status).toBe("INSPECTION_PENDING");
    const start = await walletOf();
    await card.getByLabel(/Refund ₹/).fill("70.50");
    await card.getByRole("button", { name: "Accept — refund the customer" }).click();
    await expect.poll(async () => (await returnDetail(r.id)).ret.status, { timeout: 20_000 }).toBe("REFUND_COMPLETED");
    const detail = await returnDetail(r.id);
    expect(detail.ret.refundAmountPaise, "₹70.50 stored as 7050 paise").toBe(7050);
    expect(await walletOf(), "partial refund credited").toBe(start + 7050);
    await page.reload();
    await expect(page.getByTestId("return-case").filter({ hasText: r.returnNumber }).first()).toContainText("70.50");
  } finally {
    await context.close();
  }
  return `${notes.join(", ")}; screen 'abc' refused; ₹70.50 → 7050 paise refunded and shown`;
}, { ...signed, partial: "the screen rounds amounts typed with 3 decimals before sending (return-case.tsx Math.round) — the API half refuses them" });

qa(["TC-RET-006", "TC-FLD-096"], "the shop rejects with a reason the customer sees; the comment keeps script and Marathi as text; over-long comments are refused at 1000 / 500 characters", async ({ browser }) => {
  const o = order();
  const bread = line(o, "sharedA");
  const tooLong = await requestReturn(o.id, { reason: "MISSING_ITEM", comment: TEXT.long(1001), items: [{ orderItemId: bread.id, quantityMilli: 1000, condition: "OPENED" }] });
  const itemTooLong = await requestReturn(o.id, { reason: "MISSING_ITEM", items: [{ orderItemId: bread.id, quantityMilli: 1000, condition: "OPENED", comment: TEXT.long(501) }] });
  expect(tooLong.status, "1001-character comment").toBe(422);
  expect(itemTooLong.status, "501-character item comment").toBe(422);
  const comment = `${TEXT.script} ${TEXT.marathi}`;
  const res = await requestReturn(o.id, { reason: "MISSING_ITEM", comment, items: [{ orderItemId: bread.id, quantityMilli: 1000, condition: "UNOPENED", comment: TEXT.hindi }] });
  expectStatus(res, 201, "return with script and Marathi comments");
  const id = String(res.body.id);
  const blank = await returnDetail(id);
  expect(blank.ret.comment, "comment saved as written").toBe(comment);
  const { context, page } = await pageAs(browser, "shop");
  let dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs += 1;
    await d.dismiss();
  });
  try {
    await page.goto("/shop/returns?tab=requests");
    const card = page.getByTestId("return-case").filter({ hasText: String(res.body.returnNumber) }).first();
    await expect(card).toContainText(TEXT.marathi);
    await expect(card).toContainText("<script>alert(1)</script>");
    await card.getByRole("button", { name: "Reject" }).click();
    await card.getByPlaceholder("Reason shown to the customer").fill("Seal intact — please check the bag again");
    await card.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(async () => (await returnDetail(id)).ret.status, { timeout: 15_000 }).toBe("REJECTED");
  } finally {
    await context.close();
  }
  expect(dialogs, "no script ran").toBe(0);
  const customer = await pageAs(browser, "customer");
  try {
    await customer.page.goto(`/returns/${id}`);
    await expect(customer.page.getByTestId("return-case")).toContainText("Seal intact — please check the bag again");
    await expect(customer.page.getByTestId("return-case")).toContainText("Rejected");
  } finally {
    await customer.context.close();
  }
  return `1001/501-character comments → ${tooLong.status}/${itemTooLong.status}; script and Marathi kept and shown as text; rejected with a reason the customer sees on /returns/${id}`;
}, { ...signed, mobile: true, partial: "a blank comment is the default of every other return here (accepted)" });

qa(["TC-RET-009", "TC-RET-013"], "the rider reports 'could not collect': back to Approved, customer and shop told, the shop finds a rider again; the customer cancels before set-off", async ({ browser }) => {
  await ready();
  const o = order();
  const r = await openReturn(o, "milk", "MISSING_ITEM");
  expectStatus(await act(r.id, { action: "approve" }), 200, "approve");
  const { context, page } = await pageAs(browser, "rider", riderSpot());
  try {
    let panel = await pickupPanel(page);
    await panel.getByRole("button", { name: "Accept" }).click();
    await expect.poll(async () => (await returnDetail(r.id)).ret.status, { timeout: 15_000 }).toBe("PICKUP_ASSIGNED");
    panel = await pickupPanel(page);
    await panel.getByRole("button", { name: "Could not collect" }).click();
    await page.getByLabel("Reason the pickup failed").fill("Customer not home");
    await page.getByRole("button", { name: "Report failed pickup" }).click();
    await expect.poll(async () => (await returnDetail(r.id)).ret.status, { timeout: 15_000 }).toBe("APPROVED");
  } finally {
    await context.close();
  }
  const customerTold = await notesFor("customer", r.returnNumber);
  const shopTold = await notesFor("shop", r.returnNumber);
  expect(customerTold.map((n) => n.title)).toContain("Pickup could not be completed");
  expect(shopTold.map((n) => n.title)).toContain("Pickup could not be completed");
  const shop = await pageAs(browser, "shop");
  try {
    await shop.page.goto("/shop/returns?tab=pickups");
    const card = shop.page.getByTestId("return-case").filter({ hasText: r.returnNumber }).first();
    await card.getByRole("button", { name: "Find a rider again" }).click();
    await expect.poll(async () => (await returnDetail(r.id)).pickup?.status, { timeout: 15_000 }).toBe("OFFERED");
  } finally {
    await shop.context.close();
  }
  const customer = await pageAs(browser, "customer");
  try {
    await customer.page.goto(`/returns/${r.id}`);
    await customer.page.getByTestId("return-case").getByRole("button", { name: "Cancel return" }).click();
    await expect.poll(async () => (await returnDetail(r.id)).ret.status, { timeout: 15_000 }).toBe("RETURN_CANCELLED");
  } finally {
    await customer.context.close();
  }
  expect((await returnDetail(r.id)).pickup?.status, "pickup cancelled with the return").toBe("CANCELLED");
  return `${r.returnNumber}: could not collect → APPROVED (both told); Find a rider again → offered; customer cancelled before set-off → RETURN_CANCELLED, pickup cancelled`;
}, { ...signed, mobile: true });

qa(["TC-RET-013", "TC-RET-022"], "after the rider sets off the customer cannot cancel (contact support); operations can, from the returns queue", async ({ browser }) => {
  await ready();
  const o = order();
  const r = await openReturn(o, "milk", "MISSING_ITEM");
  expectStatus(await act(r.id, { action: "approve" }), 200, "approve");
  await acceptAndSetOff(browser, r.id);
  const late = await act(r.id, { action: "cancel" }, "customer");
  expect(late.status, "customer cancel after set-off").toBe(409);
  expect(late.body?.error?.message).toMatch(/contact support/i);
  const { context, page } = await pageAs(browser, "ops");
  try {
    await page.goto("/admin/returns");
    const card = page.getByTestId("return-case").filter({ hasText: r.returnNumber }).first();
    await expect(card).toContainText("Rider on the way");
    await card.getByRole("button", { name: "Cancel return" }).click();
    await expect.poll(async () => (await returnDetail(r.id)).ret.status, { timeout: 15_000 }).toBe("RETURN_CANCELLED");
  } finally {
    await context.close();
  }
  return `${r.returnNumber}: customer cancel en route → ${late.status} "${late.body?.error?.message}"; operations cancelled it from /admin/returns`;
}, { ...signed, mobile: true });

qa(["TC-RET-008", "TC-RET-022", "TC-RET-011"], "five wrong handover codes leave the pickup to operations, who complete it from the queue; inspection rejects the goods: no refund", async ({ browser }) => {
  await ready();
  const o = order();
  const r = await openReturn(o, "sharedA", "MISSING_ITEM");
  expectStatus(await act(r.id, { action: "approve" }), 200, "approve");
  await acceptAndSetOff(browser, r.id);
  const code = (await returnDetail(r.id)).pickup?.handoverCode ?? blocked("handover code");
  const wrong = code === "0000" ? "1111" : "0000";
  for (let i = 0; i < 5; i++) await enterHandover(browser, wrong);
  const locked = await enterHandover(browser, code);
  expect(locked, "the right code after five wrong ones").toMatch(/Too many wrong codes/i);
  expect((await returnDetail(r.id)).ret.status).toBe("RIDER_EN_ROUTE");
  const { context, page } = await pageAs(browser, "ops");
  try {
    await page.goto("/admin/returns");
    const card = page.getByTestId("return-case").filter({ hasText: r.returnNumber }).first();
    await card.getByRole("button", { name: "Complete pickup manually" }).click();
    await card.getByPlaceholder("How was the pickup confirmed?").fill("Customer confirmed on a call");
    await card.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(async () => (await returnDetail(r.id)).ret.status, { timeout: 15_000 }).toBe("PICKUP_COMPLETED");
  } finally {
    await context.close();
  }
  const start = await walletOf();
  expectStatus(await act(r.id, { action: "receive" }), 200, "received");
  const rejected = await act(r.id, { action: "inspect", outcome: "REJECT", note: "Item was used" });
  expectStatus(rejected, 200, "inspection rejects");
  expect((await returnDetail(r.id)).ret.status).toBe("REJECTED");
  expect(await walletOf(), "no refund").toBe(start);
  return `${r.returnNumber}: 5 wrong codes then the right one → "Too many wrong codes"; operations completed the pickup from /admin/returns; inspection REJECT → REJECTED, wallet unchanged`;
}, { ...signed, timeout: 420_000 });

qa("TC-RET-012", "a return to a shop that does not deliver: no rider pickup, 'Customer handed goods over' moves it straight to inspection", async ({ browser }) => {
  const o = order();
  const restore = await withShopSettings({ deliveryAvailable: false });
  let r: { id: string; returnNumber: string };
  try {
    r = await openReturn(o, "packaged", "MISSING_ITEM");
  } finally {
    await restore();
  }
  expectStatus(await act(r.id, { action: "approve" }), 200, "approve");
  const detail = await returnDetail(r.id, "shop");
  expect(detail.ret.status).toBe("APPROVED");
  expect(detail.pickup, "no rider pickup").toBeNull();
  const { context, page } = await pageAs(browser, "shop");
  try {
    await page.goto("/shop/returns?tab=pickups");
    const card = page.getByTestId("return-case").filter({ hasText: r.returnNumber }).first();
    await card.getByRole("button", { name: "Customer handed goods over" }).click();
    await expect.poll(async () => (await returnDetail(r.id)).ret.status, { timeout: 15_000 }).toBe("INSPECTION_PENDING");
  } finally {
    await context.close();
  }
  expectStatus(await act(r.id, { action: "inspect", outcome: "REJECT", note: "QA close-out" }), 200, "close the case");
  return `${r.returnNumber}: approved with no pickup; handed over at the shop → INSPECTION_PENDING`;
}, { ...signed, mobile: true });

qa(["TC-RET-017", "TC-RET-018", "TC-RET-019", "TC-FLD-099"], "operator refunds of a delivered order: part charged to the shop, the rest to the platform (REFUNDED when all is back); amount and reason rules; over-refund 422, replay once; shop and customer 403", async ({ browser }) => {
  await ready();
  const placed = await checkoutLines([{ listing: await listingOf("premium") }]);
  await driveTo(placed.id, "DELIVERED");
  const ops = await as("ops");
  const base = { orderNumber: placed.orderNumber, reason: "QA refund", chargeTo: "SHOP" };
  const notes: string[] = [];
  for (const [what, body] of [
    ["no amount", { ...base, requestId: `qa-${RUN}-na` }],
    ["0", { ...base, amountPaise: 0, requestId: `qa-${RUN}-z` }],
    ["negative", { ...base, amountPaise: -100, requestId: `qa-${RUN}-n` }],
    ["text", { ...base, amountPaise: "abc", requestId: `qa-${RUN}-t` }],
    ["3 decimals", { ...base, amountPaise: 1055.5, requestId: `qa-${RUN}-d` }],
    ["10,00,00,000", { ...base, amountPaise: 10_000_000_000, requestId: `qa-${RUN}-h` }],
    ["no reason", { ...base, reason: "", amountPaise: 100, requestId: `qa-${RUN}-r` }],
    ["total + 1", { ...base, amountPaise: placed.totalPaise + 1, requestId: `qa-${RUN}-o` }],
  ] as const) {
    const res = await call(ops, "POST", "/api/finance/refunds", body);
    expect(res.status, what).toBe(422);
    notes.push(`${what} 422`);
  }
  const shopTry = await call(await as("shop"), "POST", "/api/finance/refunds", { ...base, amountPaise: 100, requestId: `qa-${RUN}-s` });
  const customerTry = await call(await as("customer"), "POST", "/api/finance/refunds", { ...base, amountPaise: 100, requestId: `qa-${RUN}-c` });
  expect(shopTry.status, "shop owner").toBe(403);
  expect(customerTry.status, "customer").toBe(403);
  const start = await walletOf();
  const partBody = { ...base, amountPaise: 7050, requestId: `qa-${RUN}-part-${placed.id.slice(0, 8)}` };
  expectStatus(await call(ops, "POST", "/api/finance/refunds", partBody), 201, "₹70.50 charged to the shop");
  const replay = await call(ops, "POST", "/api/finance/refunds", partBody);
  expect([200, 201]).toContain(replay.status);
  expect(await walletOf(), "₹70.50 credited once (replay refunds nothing more)").toBe(start + 7050);
  const rest = placed.totalPaise - 7050;
  const over = await call(ops, "POST", "/api/finance/refunds", { ...base, amountPaise: rest + 1, requestId: `qa-${RUN}-over` });
  expect(over.status, "more than what remains").toBe(422);
  expectStatus(await call(ops, "POST", "/api/finance/refunds", { ...base, chargeTo: "PLATFORM", amountPaise: rest, requestId: `qa-${RUN}-rest-${placed.id.slice(0, 8)}` }), 201, "the rest charged to the platform");
  expect(await walletOf(), "everything back").toBe(start + placed.totalPaise);
  const status = (await orderRow(placed.id)).status;
  notes.push(`shop ${shopTry.status}, customer ${customerTry.status}; 7050 + replay → once; over-refund ${over.status}; rest → wallet; order ${status}`);
  const ledger = await call(await as("admin"), "GET", `/api/finance/ledger?orderId=${placed.id}`);
  expect(JSON.stringify(ledger.body), "refund entries in the ledger").toMatch(/REFUND/);
  if (IS_LOCAL) {
    const { db } = await import("../lib/db");
    const adj = await db()<{ type: string; amount_paise: number; customer_refund_paise: number }[]>`select type, amount_paise, customer_refund_paise from financial_adjustments where order_id = ${placed.id} order by created_at`;
    expect(adj.map((a) => a.type)).toEqual(["REFUND_SHOP", "REFUND_PLATFORM"]);
    expect(Math.abs(adj[0].amount_paise), "shop share never above the goods refunded").toBeLessThanOrEqual(7050);
    const [audit] = await db()<{ n: number }[]>`select count(*)::int as n from audit_logs where action = 'finance.order_refunded_after_delivery' and entity_id = ${placed.id}`;
    expect(audit.n, "both refunds audited").toBe(2);
    notes.push(`shop share ${adj[0].amount_paise} paise of 7050 (commission kept back), platform ${adj[1].amount_paise}; audited ×2`);
  }
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/finance");
    await page.getByRole("tab", { name: "Refund an order" }).click();
    await expect(page.getByRole("tabpanel").getByLabel("Amount (₹)").first(), "the refund form (administrators; operators get it per order on /admin/exceptions)").toBeVisible();
  } finally {
    await context.close();
  }
  expect(status, `a fully refunded order moves to REFUNDED — ${notes.join("; ")}`).toBe("REFUNDED");
  return notes.join("; ");
}, { ...signed, timeout: 360_000, partial: "the refunds are sent through the API the forms use; the /admin/finance form (administrators) is only opened" });

qa("TC-FLD-099", "the operator refund form refuses an amount with 3 decimals instead of rounding it", async ({ browser }) => {
  await ready();
  const placed = await checkoutLines([{ listing: await listingOf("packaged") }]);
  await driveTo(placed.id, "DELIVERED");
  const start = await walletOf();
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/finance");
    await page.getByRole("tab", { name: "Refund an order" }).click();
    const form = page.getByRole("tabpanel").locator("div.sm\\:grid-cols-5", { has: page.getByLabel("Order number", { exact: true }) }).last();
    await form.getByLabel("Order number", { exact: true }).fill(placed.orderNumber);
    await form.getByLabel("Amount (₹)").fill("10.555");
    await form.getByLabel("Reason").fill("QA three decimals");
    const button = form.getByRole("button", { name: "Refund" });
    if (await button.isEnabled()) {
      await button.click();
      await page.waitForLoadState("networkidle").catch(() => {});
    }
  } finally {
    await context.close();
  }
  const after = await walletOf();
  expect(after - start, `refund taken from "10.555": ${after - start} paise`).toBe(0);
  return "10.555 refused by the form";
}, { ...signed, mobile: false });

