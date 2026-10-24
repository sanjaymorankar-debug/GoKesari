/**
 * Shop marketing as the shop owner sees it (QA package 1, Marketing &
 * consent): the marketing page, segments with an audience preview (counts
 * only), conflicting and invalid rules, campaign drafts and their field
 * rules, sending before approval, and who may use another shop's marketing.
 *
 * Signed-in tier: shop A's owner creates segments and draft campaigns on its
 * own shop and removes them again (drafts are cancelled, segments deleted);
 * at most one campaign is submitted, and cancelled at once so the shop's
 * weekly allowance is not used up. The customer places one order at shop A
 * (cancelled at once, refunded) so the shop has a recent customer to count.
 */
import type { APIRequestContext } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { defaultAddress, placeOrder, shopOf } from "../lib/flows";
import { call, expectStatus, RUN } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 180_000 };

async function owner() {
  return as("shop");
}

async function newSegment(ctx: APIRequestContext, shopId: string, rules: Record<string, unknown>, name = `QA seg ${RUN}`) {
  const res = await call(ctx, "POST", `/api/shops/${shopId}/marketing/segments`, { name, rules });
  expectStatus(res, 201, "create a segment");
  return res.body as { id: string; name: string };
}

async function deleteSegment(shopId: string, id: string) {
  await call(await owner(), "DELETE", `/api/shops/${shopId}/marketing/segments/${id}`);
}

/** A recent, consenting customer of shop A: the customer orders once and the order is cancelled (refunded). */
async function recentCustomer() {
  const ctx = await as("customer");
  const consent = (await call(ctx, "GET", "/api/consents/marketing")).body as { granted: boolean };
  if (!consent.granted) blocked("the customer account has not agreed to offers");
  const order = await placeOrder({ method: "WALLET" });
  await call(ctx, "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA marketing audience" });
  return order;
}

qa("TC-MKT-003", "the shop's marketing page: customer counts, segments, campaigns and the cash-on-delivery setting", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "shop");
  try {
    await page.goto("/shop/marketing");
    const overview = page.getByTestId("customer-overview");
    for (const label of ["Customers", "Agreed to offers", "Repeat (2+ delivered)", "No order in 30 days"]) await expect(overview.getByText(label, { exact: true })).toBeVisible();
    const numbers = (await overview.innerText()).match(/\d+/g) ?? [];
    expect(numbers.length, "four counts").toBeGreaterThanOrEqual(4);
    for (const heading of ["Segments", "Campaigns", "Payment options"]) await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByTestId("cod-toggle")).toBeVisible();
    return `counts ${numbers.slice(0, 4).join("/")} (customers/agreed/repeat/lapsed); segments, campaigns and the COD switch shown`;
  } finally {
    await context.close();
  }
}, { ...signed, mobile: true });

qa("TC-MKT-004", "create and preview a segment by PIN and 'ordered within 30 days': counts only, consenting customers counted as reachable", async ({ browser }) => {
  const shop = await shopOf("A");
  await recentCustomer();
  const pin = need((await defaultAddress("customer"))?.pincode, "the customer's PIN code");
  const name = `QA PIN ${pin} ${RUN}`;
  const { context, page } = await pageAs(browser, "shop");
  let segmentId: string | null = null;
  try {
    await page.goto("/shop/marketing");
    await page.getByLabel("Segment name").fill(name);
    await page.getByLabel("Delivery PIN codes (optional)").fill(pin);
    await page.getByLabel("Ordered within the last (days)").fill("30");
    const previewReply = page.waitForResponse((r) => r.url().includes("/marketing/segments") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Preview audience" }).click();
    const reply = await (await previewReply).json();
    expect(Object.keys(reply).sort(), "the preview carries counts only").toEqual(["matched", "reachable"]);
    expect(reply.matched, "the customer who just ordered matches").toBeGreaterThanOrEqual(1);
    expect(reply.reachable, "consenting customers").toBeGreaterThanOrEqual(1);
    expect(reply.reachable).toBeLessThanOrEqual(reply.matched);
    await expect(page.getByTestId("segment-preview")).toHaveText(`${reply.matched} customers match · ${reply.reachable} agreed to offers`);
    const customer = (await call(await as("customer"), "GET", "/api/profile")).body as { email: string; name: string | null; phoneE164: string | null };
    const html = await page.content();
    for (const leak of [customer.email, customer.phoneE164 ?? "\u0000"]) expect(html, "no customer identity on the page").not.toContain(leak);
    await page.getByRole("button", { name: "Save segment" }).click();
    await expect(page.getByText("Segment saved.")).toBeVisible();
    const list = await call(await owner(), "GET", `/api/shops/${shop.id}/marketing/segments`);
    const saved = (list.body as { id: string; name: string; matched: number; reachable: number }[]).find((s) => s.name === name);
    expect(saved, "segment listed with its counts").toBeTruthy();
    segmentId = saved!.id;
    await expect(page.getByText(`PIN ${pin} · ordered in last 30 days · ${saved!.matched} match · ${saved!.reachable} reachable`)).toBeVisible();
    return `preview {matched ${reply.matched}, reachable ${reply.reachable}} — counts only, no identities; saved and listed`;
  } finally {
    await context.close();
    if (segmentId) await deleteSegment(shop.id, segmentId);
  }
}, { ...signed, partial: "that a non-consenting customer is matched but not reachable is shown with new accounts in tests/qa/local/auth-marketing.spec.ts (TC-MKT-006)" });

qa("TC-MKT-005", "conflicting rules ('not ordered for 60 days' with 'ordered within 30 days') are rejected", async ({ browser }) => {
  const shop = await shopOf("A");
  const api = await call(await owner(), "POST", `/api/shops/${shop.id}/marketing/segments`, { preview: true, rules: { orderedWithinDays: 30, lapsedForDays: 60 } });
  expect(api.status).toBe(422);
  const { context, page } = await pageAs(browser, "shop");
  try {
    await page.goto("/shop/marketing");
    await page.getByLabel("Segment name").fill(`QA conflict ${RUN}`);
    await page.getByLabel("Ordered within the last (days)").fill("30");
    await page.getByLabel("Has not ordered for (days)").fill("60");
    await page.getByRole("button", { name: "Save segment" }).click();
    await expect(page.getByText("'Ordered within' must be longer than 'not ordered for' — otherwise nobody matches.")).toBeVisible();
    return `API 422 "${api.body.error.message}"; the page shows the same message and saves nothing`;
  } finally {
    await context.close();
  }
}, signed);

qa("TC-FLD-122", "segment rules through the API: negative counts, text in number fields and reversed day windows are refused; a segment with no rule means all customers", async () => {
  const shop = await shopOf("A");
  const ctx = await owner();
  const post = (rules: Record<string, unknown>) => call(ctx, "POST", `/api/shops/${shop.id}/marketing/segments`, { name: `QA rules ${RUN}`, rules });
  const out: string[] = [];
  for (const [label, rules] of [
    ["negative order count", { minOrders: -1 }],
    ["text in a number field", { minOrders: "five" }],
    ["text in days", { orderedWithinDays: "abc" }],
    ["reversed windows", { orderedWithinDays: 10, lapsedForDays: 20 }],
    ["PIN of 5 digits", { pincodes: ["41103"] }],
  ] as const) {
    const res = await post(rules);
    expect(res.status, label).toBe(422);
    out.push(`${label} → 422`);
  }
  const empty = await post({});
  expectStatus(empty, 201, "no rule");
  await call(ctx, "DELETE", `/api/shops/${shop.id}/marketing/segments/${empty.body.id}`);
  out.push("no rule → saved as 'All customers'");
  return out.join("; ");
}, {
  ...signed,
  partial:
    "a segment with no rule is accepted and targets all the shop's customers (expected result superseded by src/app/shop/marketing/page.tsx describeRules 'All customers'); there are no date fields — the day windows are the dates",
});

qa("TC-FLD-122", "segment form: text typed in a number field is refused, not silently dropped", async ({ browser }) => {
  const shop = await shopOf("A");
  const name = `QA text rule ${RUN}`;
  const { context, page } = await pageAs(browser, "shop");
  try {
    await page.goto("/shop/marketing");
    await page.getByLabel("Segment name").fill(name);
    await page.getByLabel("At least this many delivered orders").fill("abc");
    const save = page.getByRole("button", { name: "Save segment" });
    // Refused on the form (Save disabled, the field named) or, failing that, by the server: either way nothing is saved.
    const refusedOnForm = await save.isDisabled();
    if (refusedOnForm) await expect(page.getByRole("alert").filter({ hasText: "Delivered orders" })).toBeVisible();
    else {
      await save.click();
      await page.waitForLoadState("networkidle").catch(() => {});
    }
    const list = await call(await owner(), "GET", `/api/shops/${shop.id}/marketing/segments`);
    const saved = (list.body as { id: string; name: string; rules: Record<string, unknown> }[]).find((s) => s.name === name);
    if (saved) await call(await owner(), "DELETE", `/api/shops/${shop.id}/marketing/segments/${saved.id}`);
    expect(saved, `"abc" in 'At least this many delivered orders' was dropped and the segment saved with rules ${JSON.stringify(saved?.rules)} (all customers)`).toBeUndefined();
    return refusedOnForm ? "refused on the form: Save disabled with the field named" : "refused by the server";
  } finally {
    await context.close();
  }
}, signed);

qa("TC-FLD-123", "campaign fields: blank title or message, a message over 500, budget 0, negative or text are refused; script text is kept as plain text", async ({ browser }) => {
  const shop = await shopOf("A");
  const ctx = await owner();
  const segment = await newSegment(ctx, shop.id, { orderedWithinDays: 30 }, `QA campaign fields ${RUN}`);
  const base = { segmentId: segment.id, title: `QA fields ${RUN}`, message: "Fresh paneer this week at the shop.", maxRecipients: 10 };
  const created: string[] = [];
  const out: string[] = [];
  try {
    for (const [label, change, message] of [
      ["blank title", { title: "" }, "Title must be 3–80 characters."],
      ["blank message", { message: "" }, "Message must be 10–500 characters."],
      ["budget 0", { maxRecipients: 0 }, "Budget must be between 1 and"],
      ["negative budget", { maxRecipients: -5 }, "Budget must be between 1 and"],
    ] as const) {
      const res = await call(ctx, "POST", `/api/shops/${shop.id}/marketing/campaigns`, { ...base, ...change });
      expect(res.status, label).toBe(422);
      expect(res.body.error.message, label).toContain(message);
      out.push(`${label} → "${res.body.error.message}"`);
    }
    for (const [label, change] of [["text budget", { maxRecipients: "ten" }], ["message of 501", { message: "m".repeat(501) }], ["no segment", { segmentId: "" }]] as const) {
      expect((await call(ctx, "POST", `/api/shops/${shop.id}/marketing/campaigns`, { ...base, ...change })).status, label).toBe(422);
      out.push(`${label} → 422`);
    }
    const script = `<script>alert(1)</script> QA offer ${RUN}`;
    const draft = await call(ctx, "POST", `/api/shops/${shop.id}/marketing/campaigns`, { ...base, message: script });
    expectStatus(draft, 201, "script text in the message");
    created.push(draft.body.id);
    const { context, page } = await pageAs(browser, "shop");
    let alerted = false;
    page.on("dialog", async (d) => {
      alerted = true;
      await d.dismiss();
    });
    try {
      await page.goto("/shop/marketing");
      await expect(page.getByTestId("campaign-list").getByText(script, { exact: true })).toBeVisible();
      expect(alerted).toBe(false);
      await page.getByLabel("Title", { exact: true }).fill("ab");
      await page.getByLabel("Message", { exact: true }).fill("short");
      await expect(page.getByRole("button", { name: "Save draft" }), "Save draft until title ≥ 3 and message ≥ 10").toBeDisabled();
    } finally {
      await context.close();
    }
    out.push("script message saved as a draft and shown as plain text; the form's Save draft stays disabled for a short title or message");
    return out.join("; ");
  } finally {
    for (const id of created) await call(ctx, "PATCH", `/api/shops/${shop.id}/marketing/campaigns/${id}`, { action: "cancel" });
    await deleteSegment(shop.id, segment.id);
  }
}, { ...signed, partial: "campaigns have no schedule (they are sent by the owner once approved), so 'schedule in the past' has no field to test" });

qa("TC-MKT-008", "'send' on a draft or a submitted campaign is refused", async () => {
  const shop = await shopOf("A");
  const ctx = await owner();
  const segment = await newSegment(ctx, shop.id, { orderedWithinDays: 30 }, `QA send-early ${RUN}`);
  const draft = await call(ctx, "POST", `/api/shops/${shop.id}/marketing/campaigns`, { segmentId: segment.id, title: `QA early ${RUN}`, message: "Not to be sent before approval.", maxRecipients: 5 });
  expectStatus(draft, 201, "draft");
  const path = `/api/shops/${shop.id}/marketing/campaigns/${draft.body.id}`;
  try {
    const onDraft = await call(ctx, "PATCH", path, { action: "send" });
    expect(onDraft.status, "send a draft").toBe(409);
    const submit = await call(ctx, "PATCH", path, { action: "submit" });
    if (submit.status === 409) return `draft → 409 "${onDraft.body.error.message}"; submitted half not run: ${submit.body.error.message}`;
    expectStatus(submit, 200, "submit");
    const onSubmitted = await call(ctx, "PATCH", path, { action: "send" });
    expect(onSubmitted.status, "send a submitted campaign").toBe(409);
    const list = await call(ctx, "GET", `/api/shops/${shop.id}/marketing/campaigns`);
    expect((list.body as { id: string; status: string; sentCount: number }[]).find((c) => c.id === draft.body.id)?.status).toBe("SUBMITTED");
    return `draft → 409, submitted → 409 "${onSubmitted.body.error.message}"; nothing sent`;
  } finally {
    await call(ctx, "PATCH", path, { action: "cancel" });
    await deleteSegment(shop.id, segment.id);
  }
}, signed);

qa("TC-MKT-013", "another shop's owner and a customer get 403 from a shop's segment and campaign APIs", async () => {
  const shop = await shopOf("A");
  const out: string[] = [];
  const calls = (ctx: APIRequestContext) => [
    call(ctx, "GET", `/api/shops/${shop.id}/marketing/segments`),
    call(ctx, "POST", `/api/shops/${shop.id}/marketing/segments`, { preview: true, rules: {} }),
    call(ctx, "POST", `/api/shops/${shop.id}/marketing/segments`, { name: "QA intruder", rules: {} }),
    call(ctx, "GET", `/api/shops/${shop.id}/marketing/campaigns`),
    call(ctx, "POST", `/api/shops/${shop.id}/marketing/campaigns`, { segmentId: "00000000-0000-4000-8000-000000000000", title: "QA intruder", message: "Should never be saved.", maxRecipients: 1 }),
  ];
  const customer = await Promise.all(calls(await as("customer")));
  expect(customer.map((r) => r.status), "customer").toEqual([403, 403, 403, 403, 403]);
  out.push("customer: 5 × 403");
  if (world().users.shopB) {
    const other = await Promise.all(calls(await as("shopB")));
    expect(other.map((r) => r.status), "shop B's owner").toEqual([403, 403, 403, 403, 403]);
    out.push("shop B's owner: 5 × 403");
  } else out.push("no second shop owner on this site");
  return out.join("; ");
}, { ...signed, partial: "the signed-out half is in tests/qa/guest/access.spec.ts" });
