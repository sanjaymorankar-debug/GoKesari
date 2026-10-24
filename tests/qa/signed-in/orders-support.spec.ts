/**
 * Support, grievances and ratings (package 5): reporting a problem on an
 * order, operations working the grievance, shop and rider ratings with their
 * eligibility and moderation, the shop's contact page, and the issue ladder
 * (SM-006), which the dispute case carries: OPEN → TRIAGED → INVESTIGATING →
 * RESOLUTION_PROPOSED → RESOLVED (src/lib/dispute-states.ts).
 *
 * Signed-in tier: the customer's own delivered orders, operations on them.
 */
import { as, me, pageAs } from "../lib/actors";
import { onlyRiderOnline } from "../lib/flows";
import {
  abandon,
  call,
  customerCard,
  driveTo,
  ensureWallet,
  expectStatus,
  keep,
  kept,
  notesFor,
  placeSimple,
  releaseRiders,
  RUN,
  setStatus,
  statusOf,
  TEXT,
  withShopSettings,
} from "../lib/orders-helpers";
import { blocked, expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 240_000 };

async function ready() {
  await releaseRiders();
  await onlyRiderOnline("rider");
  await ensureWallet();
}

/** A delivered order of this run (made once, kept for the checks after). */
async function deliveredOrder(key: string) {
  const known = kept<{ id: string; orderNumber: string }>(key);
  if (known) return known;
  await ready();
  const placed = await placeSimple();
  await driveTo(placed.id, "DELIVERED");
  return keep(key, { id: placed.id, orderNumber: placed.orderNumber });
}

async function grievancesOf(email: string) {
  const res = await call(await as("ops"), "GET", `/api/grievances?q=${encodeURIComponent(email)}`);
  expectStatus(res, 200, "grievance list (operations)");
  return res.body.grievances as { id: string; ticketNumber: string; status: string; orderId: string | null; description: string; category: string }[];
}

qa(["TC-SUP-001", "TC-SUP-002"], "Report a problem on My Orders (PRODUCT): a ticket linked to the order, its reference shown, visible to operations; another customer cannot report on it", async ({ browser }) => {
  const order = await deliveredOrder("support-delivered");
  const { context, page } = await pageAs(browser, "customer");
  let ticket = "";
  try {
    const card = await customerCard(page, order.orderNumber, "past");
    await card.getByRole("button", { name: "Report a problem" }).click();
    await card.getByLabel("Problem type").selectOption("PRODUCT");
    await card.getByLabel("Describe the problem").fill(`QA ${RUN}: the butter pack was torn`);
    await card.getByRole("button", { name: "Send" }).click();
    const done = card.getByText(/Reported — ticket /);
    await expect(done).toBeVisible();
    ticket = ((await done.innerText()).match(/ticket (\S+?)\./)?.[1] ?? "").trim();
  } finally {
    await context.close();
  }
  expect(ticket, "a reference is shown").toMatch(/^GRV-/);
  const email = (await me("customer")).email;
  const row = (await grievancesOf(email)).find((g) => g.ticketNumber === ticket);
  expect(row, "visible to operations").toBeTruthy();
  expect(row!.orderId, "linked to the order").toBe(order.id);
  expect(row!.category).toBe("PRODUCT");
  keep("support-grievance", { id: row!.id, ticketNumber: ticket });
  const other = await call(await as("customer2"), "POST", `/api/orders/${order.id}/issue`, { category: "PRODUCT", description: "Not my order but I complain" });
  expect([403, 404], `customer 2 on someone else's order: ${other.status}`).toContain(other.status);
  return `${ticket} linked to ${order.orderNumber}, listed for operations; customer 2 → ${other.status}`;
}, { ...signed, mobile: true });

qa(["TC-SUP-003", "TC-FLD-100"], "issue form: blank, spaces, 1 and 2001 characters and an unknown category are refused with no ticket; script and Marathi are kept as text; outer spaces trimmed", async ({ browser }) => {
  const order = await deliveredOrder("support-delivered");
  const email = (await me("customer")).email;
  const before = (await grievancesOf(email)).length;
  const ctx = await as("customer");
  const notes: string[] = [];
  for (const [what, body] of [
    ["blank", { category: "PRODUCT", description: "" }],
    ["spaces", { category: "PRODUCT", description: "            " }],
    ["1 character", { category: "PRODUCT", description: "x" }],
    ["2001 characters", { category: "PRODUCT", description: TEXT.long(2001) }],
    ["unknown category", { category: "SPACESHIP", description: "A real description of the problem" }],
  ] as const) {
    const res = await call(ctx, "POST", `/api/orders/${order.id}/issue`, body);
    expect(res.status, what).toBe(422);
    notes.push(`${what} 422`);
  }
  expect((await grievancesOf(email)).length, "no ticket from refused input").toBe(before);
  const { context, page } = await pageAs(browser, "customer");
  try {
    const card = await customerCard(page, order.orderNumber, "past");
    await card.getByRole("button", { name: "Report a problem" }).click();
    await card.getByLabel("Describe the problem").fill("   short   ");
    await expect(card.getByRole("button", { name: "Send" }), "the form waits for 10 characters").toBeDisabled();
  } finally {
    await context.close();
  }
  const text = `   ${TEXT.script} ${TEXT.marathi}   `;
  const ok = await call(ctx, "POST", `/api/orders/${order.id}/issue`, { category: "ORDER", description: text });
  expectStatus(ok, 201, "issue with script and Marathi");
  const row = (await grievancesOf(email)).find((g) => g.ticketNumber === ok.body.ticketNumber);
  expect(row?.description, "kept as written, trimmed").toBe(text.trim());
  return `${notes.join(", ")}; no ticket created; form Send disabled under 10 characters; script + Marathi stored trimmed (${ok.body.ticketNumber}); limit 2000`;
}, { ...signed, partial: "display as plain text is checked for the grievance list in the operator console only through its API" });

qa("TC-SUP-005", "operations work the grievance: assign (IN_PROGRESS), resolve (customer told), close; the dashboard counters follow", async () => {
  const grievance = kept<{ id: string; ticketNumber: string }>("support-grievance") ?? blocked("needs the grievance raised by TC-SUP-001");
  const ops = await as("ops");
  const dash = async () => (await call(ops, "GET", "/api/grievances?dashboard=1")).body as { open: number; inProgress: number; resolved: number; closed: number };
  const d0 = await dash();
  const opsId = (await me("ops")).id;
  expectStatus(await call(ops, "PATCH", `/api/grievances/${grievance.id}`, { action: "assign", assignedToUserId: opsId }), 200, "assign");
  const d1 = await dash();
  expect(d1.inProgress, "IN_PROGRESS counter").toBe(d0.inProgress + 1);
  expectStatus(await call(ops, "PATCH", `/api/grievances/${grievance.id}`, { action: "resolve", resolutionNotes: "Replacement pack sent with the next order" }), 200, "resolve");
  const d2 = await dash();
  expect(d2.resolved, "RESOLVED counter").toBe(d1.resolved + 1);
  const told = await notesFor("customer", grievance.ticketNumber);
  expect(told.map((n) => n.title).join(" | "), "customer told of the resolution").toMatch(/resolved/i);
  expectStatus(await call(ops, "PATCH", `/api/grievances/${grievance.id}`, { action: "status", status: "CLOSED" }), 200, "close");
  const d3 = await dash();
  expect(d3.closed, "CLOSED counter").toBe(d2.closed + 1);
  return `${grievance.ticketNumber}: OPEN → IN_PROGRESS → RESOLVED → CLOSED; counters ${JSON.stringify(d0)} → ${JSON.stringify(d3)}; customer told`;
}, { ...signed, partial: "worked through the grievance API the admin console's grievance screen uses; SLA overdue counting by age is not exercised" });

qa(["TC-SUP-006", "TC-FLD-102"], "rate the shop 4★ with a comment: saved, the shop's average and count change, the review is public without the customer's name; stars outside 1–5 or not whole and over-long comments are refused", async ({ browser }) => {
  const order = await deliveredOrder("support-delivered");
  const shop = need(world().shops.A, "shop A");
  const shopId = shop.id ?? blocked("shop A's id");
  const before = (await call(await as("customer"), "GET", `/api/shops/${shopId}/ratings`)).body as { count: number; average: number | null };
  const ctx = await as("customer");
  const notes: string[] = [];
  for (const [what, body] of [
    ["0 stars", { target: "SHOP", score: 0 }],
    ["6 stars", { target: "SHOP", score: 6 }],
    ["2.5 stars", { target: "SHOP", score: 2.5 }],
    ["1000-character comment", { target: "SHOP", score: 4, comment: TEXT.long(1000) }],
  ] as const) {
    const res = await call(ctx, "POST", `/api/orders/${order.id}/rating`, body);
    expect(res.status, what).toBe(422);
    notes.push(`${what} 422`);
  }
  const comment = `Fresh stock, quick packing ${RUN}`;
  const { context, page } = await pageAs(browser, "customer");
  try {
    const card = await customerCard(page, order.orderNumber, "past");
    const rate = card.getByTestId("rate-order");
    await expect(rate.getByRole("button", { name: "Submit rating" }), "no stars → disabled").toBeDisabled();
    await rate.getByRole("radiogroup", { name: "Rate the shop" }).getByRole("radio", { name: "4 stars" }).click();
    await rate.getByLabel("Review").fill(comment);
    await rate.getByRole("button", { name: "Submit rating" }).click();
    await expect(page.getByTestId("order-card").filter({ hasText: order.orderNumber }).getByText(/You rated the shop 4★/)).toBeVisible({ timeout: 15_000 });
  } finally {
    await context.close();
  }
  const after = (await call(await as("customer"), "GET", `/api/shops/${shopId}/ratings`)).body as { count: number; average: number | null; reviews: { comment: string | null }[] };
  expect(after.count, "rating count").toBe(before.count + 1);
  expect(after.reviews.map((r) => r.comment), "review listed").toContain(comment);
  expect(JSON.stringify(after), "no customer identity in the public reviews").not.toMatch(/QA Customer One|qa-customer|userId|customerId/);
  const twice = await call(ctx, "POST", `/api/orders/${order.id}/rating`, { target: "SHOP", score: 5 });
  expect(twice.status, "rating the same order twice").toBe(409);
  const guest = await pageAs(browser, "customer2");
  try {
    await guest.page.goto(`/shops/${shop.slug}`);
    const info = guest.page.getByText("Shop info, opening hours and reviews");
    if (await info.count()) await info.first().click();
    await expect(guest.page.getByText(comment).first(), "review on the shop page").toBeVisible();
    await expect(guest.page.locator("body")).not.toContainText("QA Customer One");
  } finally {
    await guest.context.close();
  }
  return `${notes.join(", ")}; 4★ "${comment}" saved; count ${before.count} → ${after.count}, average ${after.average}; public without identity; twice → ${twice.status}`;
}, { ...signed, mobile: true });

qa("TC-FLD-102", "a rating comment with script is shown as plain text on the shop page; a blank comment is accepted", async ({ browser }) => {
  const order = await deliveredOrder("support-delivered-2");
  const shop = need(world().shops.A, "shop A");
  const ctx = await as("customer");
  const scripted = `${TEXT.script} ${RUN}`;
  expectStatus(await call(ctx, "POST", `/api/orders/${order.id}/rating`, { target: "SHOP", score: 3, comment: scripted }), 201, "shop rating with a script comment");
  expectStatus(await call(ctx, "POST", `/api/orders/${order.id}/rating`, { target: "DELIVERY_PARTNER", score: 5, comment: "" }), 201, "rider rating with a blank comment");
  const { context, page } = await pageAs(browser, "customer2");
  let dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs += 1;
    await d.dismiss();
  });
  try {
    await page.goto(`/shops/${shop.slug}`);
    const info = page.getByText("Shop info, opening hours and reviews");
    if (await info.count()) await info.first().click();
    await expect(page.getByText(scripted).first(), "shown literally").toBeVisible();
  } finally {
    await context.close();
  }
  expect(dialogs, "no script ran").toBe(0);
  return "script comment shown as text; blank comment accepted";
}, { ...signed, mobile: true });

qa(["TC-SUP-007"], "rating eligibility: an undelivered order, another customer's order and a second rating are refused", async () => {
  await ensureWallet();
  const open = await placeSimple();
  try {
    const undelivered = await call(await as("customer"), "POST", `/api/orders/${open.id}/rating`, { target: "SHOP", score: 4 });
    expect(undelivered.status, "undelivered").toBeGreaterThanOrEqual(400);
    const order = await deliveredOrder("support-delivered");
    const other = await call(await as("customer2"), "POST", `/api/orders/${order.id}/rating`, { target: "SHOP", score: 4 });
    expect([403, 404], `another customer's order: ${other.status}`).toContain(other.status);
    const again = await call(await as("customer"), "POST", `/api/orders/${order.id}/rating`, { target: "SHOP", score: 2 });
    expect(again.status, "second shop rating").toBe(409);
    const bad = await call(await as("customer"), "POST", `/api/orders/${order.id}/rating`, { target: "SHOP", score: 0 });
    expect(bad.status, "score 0").toBe(422);
    return `undelivered ${undelivered.status} "${undelivered.body?.error?.message}"; other customer ${other.status}; twice ${again.status}; score 0 ${bad.status}`;
  } finally {
    await abandon(open.id);
  }
}, { ...signed, partial: "an order delivered more than 30 days ago is TC-SUP-007 in local/orders-rules.spec.ts (needs aging)" });

qa("TC-SUP-008", "rating the rider: saved, the rider sees the average on the dashboard, not public; no rider rating for an order the shop delivered itself", async ({ browser }) => {
  await ready();
  const order = await deliveredOrder("support-delivered-3");
  expectStatus(await call(await as("customer"), "POST", `/api/orders/${order.id}/rating`, { target: "DELIVERY_PARTNER", score: 4 }), 201, "rate the rider");
  const rider = await pageAs(browser, "rider");
  try {
    await rider.page.goto("/delivery-partner");
    await expect(rider.page.getByText(/★ from \d+/)).toBeVisible();
  } finally {
    await rider.context.close();
  }
  const shop = need(world().shops.A, "shop A");
  const pub = await call(await as("customer2"), "GET", `/api/shops/${shop.id}/ratings`);
  expect(JSON.stringify(pub.body), "rider ratings are not in the public shop reviews").not.toMatch(/DELIVERY_PARTNER|rider/i);
  // A self-delivered order: no rider to rate.
  const self = await placeSimple();
  try {
    await driveTo(self.id, "PREPARING");
    const restore = await withShopSettings({ deliveryAvailable: false });
    try {
      await driveTo(self.id, "READY", { from: "PREPARING" });
      expectStatus(await setStatus(self.id, "DELIVERED"), 200, "handed to the customer by the shop");
    } finally {
      await restore();
    }
    expect(await statusOf(self.id)).toBe("DELIVERED");
    const elig = await call(await as("customer"), "GET", `/api/orders/${self.id}/rating`);
    expect(elig.body.canRateRider, "no rider to rate").toBe(false);
    const { context, page } = await pageAs(browser, "customer");
    try {
      const card = await customerCard(page, self.orderNumber, "past");
      await expect(card.getByRole("radiogroup", { name: "Rate the delivery" }).or(card.getByText("Delivery", { exact: true }))).toHaveCount(0);
    } finally {
      await context.close();
    }
  } finally {
    await abandon(self.id);
  }
  return "rider rated 4★ and sees the average; not in public reviews; self-delivered order has no rider rating";
}, { ...signed, mobile: true, partial: "operations' view of the rider average is not opened" });

qa(["TC-SUP-009", "TC-SUP-010"], "moderation hides a rating with a reason and restores it (public list and count follow); the shop owner cannot", async ({ browser }) => {
  const order = await deliveredOrder("support-delivered-4");
  const shop = need(world().shops.A, "shop A");
  const comment = `Moderate me ${RUN}`;
  const rated = await call(await as("customer"), "POST", `/api/orders/${order.id}/rating`, { target: "SHOP", score: 1, comment });
  expectStatus(rated, 201, "a rating to moderate");
  const id = String(rated.body.id);
  const byShop = await call(await as("shop"), "PATCH", `/api/ratings/${id}`, { hide: true, reason: "I do not like it" });
  expect(byShop.status, "shop owner").toBe(403);
  const pub = async () => (await call(await as("customer2"), "GET", `/api/shops/${shop.id}/ratings`)).body as { count: number; reviews: { comment: string | null }[] };
  const visible = await pub();
  expect(visible.reviews.map((r) => r.comment)).toContain(comment);
  const { context, page } = await pageAs(browser, "ops");
  try {
    await page.goto("/admin/ratings");
    const row = page.locator("div.justify-between").filter({ hasText: comment }).first();
    await expect(row).toBeVisible();
    await row.getByLabel("Reason").fill("Abusive language");
    await row.getByRole("button", { name: "Hide" }).click();
    await expect.poll(async () => (await pub()).reviews.map((r) => r.comment).includes(comment), { timeout: 15_000 }).toBe(false);
    const hidden = await pub();
    expect(hidden.count, "hidden rating leaves the count").toBe(visible.count - 1);
    await page.reload();
    await page.locator("div.justify-between").filter({ hasText: comment }).first().getByRole("button", { name: "Restore" }).click();
    await expect.poll(async () => (await pub()).reviews.map((r) => r.comment).includes(comment), { timeout: 15_000 }).toBe(true);
    expect((await pub()).count, "restored to the count").toBe(visible.count);
  } finally {
    await context.close();
  }
  return `shop owner PATCH → ${byShop.status}; hidden from the public list (count ${visible.count} → ${visible.count - 1}) and restored`;
}, { ...signed, mobile: false });

qa("TC-SUP-011", "the shop's contact page as a signed-in customer: contact options shown, no customer data", async ({ browser }) => {
  const shop = need(world().shops.A, "shop A");
  const customer2 = await me("customer2");
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto(`/shops/${shop.slug}/contact`);
    await expect(page.getByRole("heading", { name: "Seller information" })).toBeVisible();
    const body = await page.locator("main").innerText();
    expect(body).toMatch(/\d{10}|customer care|WhatsApp/i);
    for (const leak of [customer2.email, "QA Customer Two", "QA Recipient"]) expect(body, `no ${leak}`).not.toContain(leak);
  } finally {
    await context.close();
  }
  return `/shops/${shop.slug}/contact shows the seller's contact options and no other customer's data`;
}, { ...signed, mobile: true, partial: "guest half in guest/storefront.spec.ts" });

manualContact();
function manualContact() {
  qa("TC-FLD-103", "contact shop: the message field", async ({ browser }) => {
    const shop = need(world().shops.A, "shop A");
    const { context, page } = await pageAs(browser, "customer");
    try {
      await page.goto(`/shops/${shop.slug}/contact`);
      const fields = await page.locator("main textarea, main input[type=text]").count();
      if (fields === 0) blocked("/shops/[slug]/contact has no message field to test — it lists the shop's phone / WhatsApp (or GoKesari customer care); written contact goes through the help desk (/support)");
    } finally {
      await context.close();
    }
    return "a message field exists";
  }, { tier: "signed" });
}

qa(["TC-SUP-012", "TC-SUP-014"], "the issue ladder on a dispute: OPEN → TRIAGED → INVESTIGATING → RESOLUTION_PROPOSED → RESOLVED, each step recorded with who and when and shown to the customer; illegal moves and the customer's staff moves are refused", async ({ browser }) => {
  const order = await deliveredOrder("support-delivered-5");
  const opened = await call(await as("customer"), "POST", "/api/disputes", { orderId: order.id, reason: "QUALITY_ISSUE", description: "The pack smelled stale on opening", disputedAmountPaise: 1000 });
  expectStatus(opened, 201, "open a dispute");
  const id = String(opened.body.id);
  const ops = await as("ops");
  const move = (to: string, extra: Record<string, unknown> = {}, role: "ops" | "customer" = "ops") => (role === "ops" ? Promise.resolve(ops) : as("customer")).then((c) => call(c, "PATCH", `/api/disputes/${id}`, { action: "advance", to, ...extra }));
  const notes: string[] = [];
  const skip = await move("INVESTIGATING");
  expect(skip.status, "OPEN → INVESTIGATING skips triage").toBe(409);
  const close = await call(ops, "PATCH", `/api/disputes/${id}`, { action: "advance", to: "RESOLVED" });
  expect(close.status, "OPEN → RESOLVED without the resolve action").toBe(422);
  const byCustomer = await move("TRIAGED", {}, "customer");
  expect(byCustomer.status, "the customer setting a staff state").toBe(403);
  notes.push(`OPEN→INVESTIGATING ${skip.status}, OPEN→RESOLVED ${close.status}, customer→TRIAGED ${byCustomer.status}`);
  for (const [to, extra] of [["TRIAGED", {}], ["INVESTIGATING", {}], ["RESOLUTION_PROPOSED", { proposal: "A replacement pack with your next order" }]] as const) {
    expectStatus(await move(to, extra), 200, `→ ${to}`);
  }
  expectStatus(await call(ops, "PATCH", `/api/disputes/${id}`, { action: "resolve", outcome: "REPLACEMENT_AGREED", notes: "Customer accepted the replacement", requestId: `qa-${RUN}-${id.slice(0, 8)}` }), 200, "resolve");
  const reopen = await move("INVESTIGATING");
  expect(reopen.status, "RESOLVED → INVESTIGATING").toBe(409);
  notes.push(`RESOLVED→INVESTIGATING ${reopen.status}`);
  const detail = await call(ops, "GET", `/api/disputes/${id}`);
  expectStatus(detail, 200, "dispute detail");
  const text = JSON.stringify(detail.body);
  for (const s of ["TRIAGED", "INVESTIGATING", "RESOLUTION_PROPOSED", "RESOLVED"]) expect(text, `history has ${s}`).toContain(s);
  expect(text, "who and when per step").toMatch(/createdAt|at"/);
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto(`/disputes/${id}`);
    await expect(page.getByText(/Resolved/i).first(), "the customer sees the current state").toBeVisible();
  } finally {
    await context.close();
  }
  return `${opened.body.caseNumber}: ${notes.join("; ")}; ladder OPEN → TRIAGED → INVESTIGATING → RESOLUTION_PROPOSED → RESOLVED recorded; customer sees 'Resolved'`;
}, { ...signed, partial: "the ladder is the dispute case's (src/lib/dispute-states.ts, SM-006 decision): RESOLVED is final, there is no separate CLOSED step" });

