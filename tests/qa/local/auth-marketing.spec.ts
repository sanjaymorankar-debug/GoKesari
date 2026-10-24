/**
 * Shop campaigns from draft to customers' inboxes (QA package 1, Marketing &
 * consent): operations' approval and rejection, sending, withdrawn consent,
 * the shop's weekly allowance and the customers' frequency caps, budget
 * bounds, a double send, and the opened / converted figures.
 *
 * Local tier: new customers who agree to offers are created in the local
 * database and order once from the shop (orders cancelled and refunded), and
 * the `marketing` rule's weekly allowance is raised for the checks that send
 * several campaigns (always restored; TC-MKT-010 runs on the defaults).
 */
import type { APIRequestContext } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { apiWithCookie, keep, kept, localUser, walletOrder, withRule, type LocalUser } from "../lib/auth-helpers";
import { db } from "../lib/db";
import { call, expectStatus, RUN } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world, type Role } from "../lib/world";

const local = { tier: "local" as const, timeout: 420_000 };
const ROOMY = { shopCampaignsPerWeek: 50 };

function shop(key: "A" | "B") {
  const s = need(world().shops[key], `shop ${key}`);
  return { id: need(s.id, `shop ${key} id`), name: s.name, owner: (key === "A" ? "shop" : "shopB") as Role };
}

/** A new customer who agrees to offers and has ordered once from each of `shops` (orders cancelled). */
async function consentingShopper(label: string, shops: ("A" | "B")[]): Promise<LocalUser> {
  const user = await localUser(label, { walletPaise: 300_000, address: true, marketingConsent: true });
  for (const key of shops) {
    const listing = need(key === "A" ? world().listings.packaged : world().listings.sharedB, `a listing at shop ${key}`);
    const order = await walletOrder(user.ctx, listing.shopProductId, shop(key).id, user.addressId);
    expectStatus(await call(user.ctx, "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA marketing audience" }), 200, "cancel");
  }
  return user;
}

async function segmentOf(key: "A" | "B", rules: Record<string, unknown> = { orderedWithinDays: 1 }) {
  const s = shop(key);
  const res = await call(await as(s.owner), "POST", `/api/shops/${s.id}/marketing/segments`, { name: `QA ${key} recent ${RUN} ${Math.random().toString(36).slice(2, 6)}`, rules });
  expectStatus(res, 201, "segment");
  return res.body as { id: string; name: string };
}

async function preview(key: "A" | "B", rules: Record<string, unknown>) {
  const s = shop(key);
  const res = await call(await as(s.owner), "POST", `/api/shops/${s.id}/marketing/segments`, { preview: true, rules });
  expectStatus(res, 200, "preview");
  return res.body as { matched: number; reachable: number };
}

async function draft(key: "A" | "B", segmentId: string, title: string, maxRecipients = 100) {
  const s = shop(key);
  const res = await call(await as(s.owner), "POST", `/api/shops/${s.id}/marketing/campaigns`, { segmentId, title, message: `QA campaign message ${RUN} — fresh stock this week.`, maxRecipients });
  expectStatus(res, 201, "draft");
  return res.body.id as string;
}

async function act(key: "A" | "B", id: string, action: "submit" | "send" | "cancel", role?: Role) {
  return call(await as(role ?? shop(key).owner), "PATCH", `/api/shops/${shop(key).id}/marketing/campaigns/${id}`, { action });
}

async function campaignRow(key: "A" | "B", id: string) {
  const res = await call(await as(shop(key).owner), "GET", `/api/shops/${shop(key).id}/marketing/campaigns`);
  return (res.body as { id: string; status: string; sentCount: number; suppressedCount: number; maxRecipients: number; rejectionReason: string | null; stats: { opened: number; converted: number; revenuePaise: number } }[]).find((c) => c.id === id);
}

/** Submit, approve (operations) and send; returns the sent campaign. */
async function approveAndSend(key: "A" | "B", id: string) {
  expectStatus(await act(key, id, "submit"), 200, "submit");
  expectStatus(await call(await as("ops"), "POST", `/api/admin/campaigns/${id}/decision`, { decision: "approve" }), 200, "approve");
  expectStatus(await act(key, id, "send"), 200, "send");
  return need(await campaignRow(key, id), "the sent campaign");
}

async function inbox(ctx: APIRequestContext, title: string) {
  const res = await call(ctx, "GET", "/api/notifications");
  return (res.body.notifications as { id: string; title: string; readAt: string | null }[]).filter((n) => n.title.endsWith(`: ${title}`));
}

async function recipients(campaignId: string) {
  return (await db()<{ user_id: string }[]>`select user_id from campaign_recipients where campaign_id = ${campaignId}`).map((r) => r.user_id);
}

const SENT = "marketing-sent";

qa("TC-MKT-007", "campaign draft → submitted → approved by operations at /admin/campaigns → sent: consenting customers get an in-app message, sent count within the budget", async ({ browser }) => {
  const a = shop("A");
  return withRule("marketing", ROOMY, async () => {
    const y = await consentingShopper("mkt-y", ["A"]);
    const segment = await segmentOf("A");
    const title = `QA weekend ${RUN}`;
    const owner = await pageAs(browser, "shop");
    try {
      await owner.page.goto("/shop/marketing");
      await owner.page.getByLabel("Send to").selectOption(segment.id);
      await owner.page.getByLabel("Title", { exact: true }).fill(title);
      await owner.page.getByLabel("Message", { exact: true }).fill("Fresh paneer and curd at the shop this weekend.");
      await owner.page.getByLabel("Budget (max customers)").fill("100");
      await owner.page.getByRole("button", { name: "Save draft" }).click();
      await expect(owner.page.getByText("Draft saved — submit it for approval.")).toBeVisible();
      const row = owner.page.getByTestId("campaign-list").locator("div.space-y-1").filter({ hasText: title });
      await expect(row).toContainText("draft");
      await row.getByRole("button", { name: "Submit for approval" }).click();
      await expect(row).toContainText("submitted");
    } finally {
      await owner.context.close();
    }
    const id = need((await call(await as("shop"), "GET", `/api/shops/${a.id}/marketing/campaigns`)).body.find((c: { title: string }) => c.title === title)?.id as string | undefined, "the draft");
    const ops = await pageAs(browser, "ops");
    try {
      await ops.page.goto("/admin/campaigns");
      const row = ops.page.locator("div.space-y-1").filter({ hasText: `${a.name}: ${title}` });
      await row.getByRole("button", { name: "Approve" }).click();
      await expect.poll(async () => (await campaignRow("A", id))?.status).toBe("APPROVED");
    } finally {
      await ops.context.close();
    }
    const again = await pageAs(browser, "shop");
    try {
      await again.page.goto("/shop/marketing");
      const row = again.page.getByTestId("campaign-list").locator("div.space-y-1").filter({ hasText: title });
      await row.getByRole("button", { name: "Send now" }).click();
      await expect.poll(async () => (await campaignRow("A", id))?.status).toBe("SENT");
    } finally {
      await again.context.close();
    }
    const sent = need(await campaignRow("A", id), "the campaign");
    expect(sent.sentCount, "sent within the budget").toBeLessThanOrEqual(sent.maxRecipients);
    const got = await inbox(y.ctx, title);
    expect(got.length, "the consenting customer got one in-app message").toBe(1);
    keep(SENT, { id, title, y: { cookie: y.cookie, id: y.id } });
    return `DRAFT → SUBMITTED (shop page) → APPROVED (/admin/campaigns) → SENT (shop page); sent ${sent.sentCount} ≤ budget ${sent.maxRecipients}; the new consenting customer got "${a.name}: ${title}"`;
  });
}, local);

qa("TC-MKT-012", "a recipient opens the message and orders from the shop: opened, converted and revenue update", async ({ browser }) => {
  const saved = kept<{ id: string; title: string; y: { cookie: string; id: string } }>(SENT) ?? blocked("needs the campaign sent by TC-MKT-007");
  const y = await apiWithCookie(saved.y.cookie);
  const [message] = await inbox(y, saved.title);
  expectStatus(await call(y, "PATCH", "/api/notifications", { id: message.id }), 200, "open the message");
  const [address] = await db()<{ id: string }[]>`select id from addresses where user_id = ${saved.y.id} and is_default`;
  const listing = need(world().listings.packaged, "shop A's packaged listing");
  const order = await walletOrder(y, listing.shopProductId, shop("A").id, address.id);
  try {
    const row = need(await campaignRow("A", saved.id), "the campaign");
    expect(row.stats.opened, "opened").toBeGreaterThanOrEqual(1);
    expect(row.stats.converted, "converted").toBeGreaterThanOrEqual(1);
    expect(row.stats.revenuePaise, "revenue includes the order").toBeGreaterThanOrEqual(order.totalPaise);
    const { context, page } = await pageAs(browser, "shop");
    try {
      await page.goto("/shop/marketing");
      await expect(page.getByTestId("campaign-list").locator("div.space-y-1").filter({ hasText: saved.title })).toContainText(`opened ${row.stats.opened} · ordered ${row.stats.converted} within 7 days`);
    } finally {
      await context.close();
    }
    return `opened ${row.stats.opened}, converted ${row.stats.converted}, revenue ${row.stats.revenuePaise} paise (order ${order.orderNumber}, ${order.totalPaise}) on the campaign row`;
  } finally {
    await call(y, "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA cleanup" });
  }
}, { ...local, partial: "shown on the shop's campaign row and the review queue; there is no separate analytics chart for campaigns" });

qa("TC-MKT-006", "a customer who withdraws consent drops out of the audience (reachable −1) and gets no later campaign", async () => {
  return withRule("marketing", ROOMY, async () => {
    const stays = await consentingShopper("mkt-stays", ["A"]);
    const leaves = await consentingShopper("mkt-leaves", ["A"]);
    const rules = { orderedWithinDays: 1 };
    const before = await preview("A", rules);
    expectStatus(await call(leaves.ctx, "PUT", "/api/consents/marketing", { granted: false }), 200, "withdraw consent");
    const after = await preview("A", rules);
    expect(after.matched, "still a customer of the shop").toBe(before.matched);
    expect(after.reachable, "one fewer reachable").toBe(before.reachable - 1);
    const segment = await segmentOf("A", rules);
    const title = `QA after withdrawal ${RUN}`;
    const id = await draft("A", segment.id, title);
    await approveAndSend("A", id);
    expect((await inbox(stays.ctx, title)).length, "the consenting customer gets it").toBe(1);
    expect((await inbox(leaves.ctx, title)).length, "the one who withdrew gets nothing").toBe(0);
    expect(await recipients(id)).not.toContain(leaves.id);
    return `reachable ${before.reachable} → ${after.reachable} (matched ${after.matched}); the next campaign reached the consenting customer only`;
  });
}, local);

qa("TC-MKT-009", "a rejected campaign (with a reason) is edited and resubmitted by the shop; operations cannot edit or send it themselves", async ({ browser }) => {
  const a = shop("A");
  return withRule("marketing", ROOMY, async () => {
    const segment = await segmentOf("A", { orderedWithinDays: 30 });
    const title = `QA reject me ${RUN}`;
    const id = await draft("A", segment.id, title);
    expectStatus(await act("A", id, "submit"), 200, "submit");
    const reason = "QA: say which products are on offer";
    const ops = await pageAs(browser, "ops");
    try {
      await ops.page.goto("/admin/campaigns");
      const row = ops.page.locator("div.space-y-1").filter({ hasText: `${a.name}: ${title}` });
      await row.getByPlaceholder("Reason to reject").fill(reason);
      await row.getByRole("button", { name: "Reject" }).click();
      await expect.poll(async () => (await campaignRow("A", id))?.status).toBe("REJECTED");
    } finally {
      await ops.context.close();
    }
    expect((await campaignRow("A", id))?.rejectionReason).toBe(reason);
    const owner = await pageAs(browser, "shop");
    try {
      await owner.page.goto("/shop/marketing");
      await expect(owner.page.getByTestId("campaign-list").locator("div.space-y-1").filter({ hasText: title })).toContainText(`Not approved: ${reason}`);
    } finally {
      await owner.context.close();
    }
    const opsEdit = await call(await as("ops"), "PATCH", `/api/shops/${a.id}/marketing/campaigns/${id}`, { action: "update", segmentId: segment.id, title: "QA ops edit", message: "Operations rewrote this message.", maxRecipients: 5 });
    const opsSend = await call(await as("ops"), "PATCH", `/api/shops/${a.id}/marketing/campaigns/${id}`, { action: "send" });
    expect([opsEdit.status, opsSend.status], "operations editing or sending").toEqual([403, 403]);
    const edited = await call(await as("shop"), "PATCH", `/api/shops/${a.id}/marketing/campaigns/${id}`, { action: "update", segmentId: segment.id, title, message: "Paneer 10% off, curd 5% off this week at the shop.", maxRecipients: 50 });
    expectStatus(edited, 200, "the shop edits");
    expect([edited.body.status, edited.body.rejectionReason]).toEqual(["DRAFT", null]);
    expectStatus(await act("A", id, "submit"), 200, "resubmit");
    expect((await campaignRow("A", id))?.status).toBe("SUBMITTED");
    await act("A", id, "cancel");
    return `rejected with "${reason}" (shown to the shop); operations edit/send → 403 "${opsEdit.body.error.message}"; the shop edited (back to DRAFT) and resubmitted (SUBMITTED)`;
  });
}, local);

qa("TC-MKT-010", "limits: a shop's 3rd campaign in 7 days is refused; a customer gets at most one campaign per shop and the total cap per week", async () => {
  const b = shop("B");
  const [{ recent }] = await db()<{ recent: number }[]>`
    select count(*)::int as recent from marketing_campaigns where shop_id = ${b.id} and status in ('SUBMITTED', 'APPROVED', 'SENT')
      and coalesce(sent_at, submitted_at) > now() - interval '7 days'`;
  const segB = await segmentOf("B", { orderedWithinDays: 30 });
  const submitted: string[] = [];
  let refusal: string | null = null;
  for (let i = 0; i < 3 && !refusal; i++) {
    const id = await draft("B", segB.id, `QA weekly ${i + 1} ${RUN}`);
    const res = await act("B", id, "submit");
    if (res.status === 200) submitted.push(id);
    else {
      expect(res.status).toBe(409);
      refusal = res.body.error.message;
      await act("B", id, "cancel");
    }
  }
  for (const id of submitted) await act("B", id, "cancel");
  expect(submitted.length, `submits accepted with ${recent} already this week`).toBe(Math.max(0, 2 - recent));
  expect(refusal).toBe("A shop can run at most 2 campaigns a week.");
  const caps = await withRule("marketing", ROOMY, async () => {
    const z = await consentingShopper("mkt-z", ["A", "B"]);
    const segA = await segmentOf("A");
    const first = await draft("A", segA.id, `QA cap A1 ${RUN}`);
    await approveAndSend("A", first);
    expect(await recipients(first), "the first campaign from shop A").toContain(z.id);
    const second = await draft("A", segA.id, `QA cap A2 ${RUN}`);
    const sentTwice = await approveAndSend("A", second);
    expect(await recipients(second), "a second campaign from the same shop in the week").not.toContain(z.id);
    return withRule("marketing", { totalPerCustomerPerWeek: 1 }, async () => {
      const fromB = await draft("B", (await segmentOf("B")).id, `QA cap B1 ${RUN}`);
      await approveAndSend("B", fromB);
      expect(await recipients(fromB), "past the total cap").not.toContain(z.id);
      return `per shop: A1 reached the customer, A2 skipped them (${sentTwice.suppressedCount} skipped by limits); total cap (set to 1): B1 skipped them`;
    });
  });
  return `shop B: ${submitted.length} submit(s) accepted after ${recent} this week, then "${refusal}"; ${caps}`;
}, { ...local, partial: "the total cap is exercised with rule marketing.totalPerCustomerPerWeek lowered to 1 (the default 3 needs four shops the customer ordered from; this world has two that sell)" });

qa("TC-MKT-011", "budget bounds (0 and 5,001 refused, 5,000 accepted) and a second send of the same campaign is impossible", async () => {
  return withRule("marketing", ROOMY, async () => {
    const a = shop("A");
    const segment = await segmentOf("A", { orderedWithinDays: 30 });
    const ctx = await as("shop");
    const out: string[] = [];
    for (const budget of [0, 5001]) {
      const res = await call(ctx, "POST", `/api/shops/${a.id}/marketing/campaigns`, { segmentId: segment.id, title: `QA budget ${budget}`, message: "Budget bound check message.", maxRecipients: budget });
      expect(res.status, `budget ${budget}`).toBe(422);
      out.push(`${budget} → 422 "${res.body.error.message}"`);
    }
    const max = await draft("A", segment.id, `QA budget 5000 ${RUN}`, 5000);
    await act("A", max, "cancel");
    out.push("5000 accepted");
    const id = await draft("A", segment.id, `QA double send ${RUN}`, 10);
    const sent = await approveAndSend("A", id);
    const twice = await act("A", id, "send");
    expect(twice.status, "second send").toBe(409);
    const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from campaign_recipients where campaign_id = ${id}`;
    expect(n, "recipients once").toBe(sent.sentCount);
    return `${out.join("; ")}; send → SENT (${sent.sentCount}), second send → 409 "${twice.body.error.message}", ${n} recipient rows`;
  });
}, local);
