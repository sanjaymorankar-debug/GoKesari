/**
 * Subscription plans end to end (docs/subscription-plans-2026-11), signed in
 * on the test accounts: shop A makes one of its online listings a Mon–Sat
 * lunch plan at a subscriber price; customer 1 finds it for their default
 * address and subscribes within its rules; shop A is told and sees the
 * subscriber and the prep sheet. Everything is undone at the end: the
 * subscription cancelled (nothing is charged before its first day) and the
 * plan removed.
 */
import { as, pageAs } from "../lib/actors";
import { defaultAddress, sellable } from "../lib/flows";
import { call, expectStatus, pace, RUN } from "../lib/http";
import { expect, manual, need, qa } from "../lib/record";

/** The first Monday at least three days ahead (IST), so lead days never bite. */
function nextMondayIst(): string {
  const now = new Date(Date.now() + 5.5 * 3600_000);
  for (let i = 3; i < 10; i += 1) {
    const d = new Date(now.getTime() + i * 86_400_000);
    if (d.getUTCDay() === 1) return d.toISOString().slice(0, 10);
  }
  throw new Error("unreachable");
}

qa(["TC-SUB-030", "TC-SUB-031", "TC-SUB-032", "TC-SUB-034", "TC-SUB-035"], "a shop's plan is found, taken within its rules, told to the shop and undone", async ({ browser }) => {
  const listing = await sellable("A", 1);
  const owner = await as("shop");
  const customer = await as("customer");
  const address = need(await defaultAddress("customer"), "a default address for customer 1");
  const name = `QA lunch plan ${RUN}`;
  const notes: string[] = [];
  let planId: string | null = null;
  let subscriptionId: string | null = null;

  try {
    // TC-SUB-030: the shop makes the listing a plan.
    const created = await call(owner, "POST", `/api/shops/${listing.shopId}/subscription-plans`, {
      shopProductId: listing.shopProductId,
      name,
      description: "QA run — removed at the end",
      kind: "MEAL",
      slot: "LUNCH",
      slotWindow: "12:30–2 pm",
      serviceDays: [1, 2, 3, 4, 5, 6],
      allowedFrequencies: ["DAILY", "WEEKLY"],
      pricePaise: 4100,
      termDays: [],
      leadDays: 1,
    });
    expectStatus(created, 201, "create the plan");
    planId = created.body.id as string;
    await pace();
    const dup = await call(owner, "POST", `/api/shops/${listing.shopId}/subscription-plans`, { ...created.body, shopProductId: listing.shopProductId, name, pricePaise: 4100, termDays: [] });
    expect(dup.status, "a second plan with the same name").toBe(409);
    notes.push(`plan created on "${listing.name}" at ₹41`);

    // TC-SUB-031: the customer finds it for their address, and subscribes.
    const near = await call(customer, "GET", `/api/subscription-plans?addressId=${address.id}&kind=MEAL&slot=LUNCH`);
    expectStatus(near, 200, "plans near customer 1");
    const found = (near.body as { id: string; pricePaise: number; shop: { id: string } }[]).find((p) => p.id === planId);
    expect(found, "shop A's plan is offered for customer 1's default address").toBeTruthy();
    expect(found!.pricePaise).toBe(4100);

    const monday = nextMondayIst();
    // TC-SUB-032: outside the plan's rules is refused.
    for (const [what, body] of [
      ["Sunday", { frequency: "WEEKLY", weekdays: [7] }],
      ["days of the month", { frequency: "MONTHLY", monthDays: [1] }],
    ] as const) {
      await pace();
      const res = await call(customer, "POST", `/api/subscription-plans/${planId}/subscribe`, { quantityMilli: 1000, startDate: monday, addressId: address.id, ...body });
      expect(res.status, `${what}: ${res.text.slice(0, 200)}`).toBe(422);
    }
    const taken = await call(customer, "POST", `/api/subscription-plans/${planId}/subscribe`, { quantityMilli: 1000, frequency: "DAILY", startDate: monday, addressId: address.id });
    expectStatus(taken, 201, "subscribe to the plan");
    subscriptionId = taken.body.id as string;
    expect(taken.body).toMatchObject({ planId, frequency: "WEEKLY", weekdays: [1, 2, 3, 4, 5, 6] });
    notes.push(`subscribed from ${monday}, Mon–Sat; Sunday and month days refused`);

    const { context: cCtx, page: cPage } = await pageAs(browser, "customer");
    try {
      await cPage.goto(`/subscriptions/${subscriptionId}`);
      await expect(cPage.getByText(`plan "${name}"`, { exact: false })).toBeVisible();
    } finally {
      await cCtx.close();
    }

    // TC-SUB-034: the shop's notice, subscriber list and prep sheet.
    const inbox = await call(owner, "GET", "/api/notifications");
    expectStatus(inbox, 200, "shop owner's notifications");
    const notice = ((inbox.body?.notifications ?? inbox.body) as { type: string; body: string; metadata?: { subscriptionIds?: string[] } }[]).find(
      (n) => n.type === "shop.new_subscription" && n.metadata?.subscriptionIds?.includes(subscriptionId!),
    );
    expect(notice, "a new-subscriber notice").toBeTruthy();
    expect(notice!.body).toContain(`${name} (`);
    expect(notice!.body).toContain("Mon–Sat, Lunch (12:30–2 pm)");

    const { context: sCtx, page: sPage } = await pageAs(browser, "shop");
    try {
      await sPage.goto("/shop/manage/subscribers");
      await expect(sPage.getByTestId("prep-sheet")).toBeVisible();
      await expect(sPage.getByTestId("prep-sheet").getByText(name)).toBeVisible();
      await sPage.goto("/shop/manage/subscription-plans");
      await expect(sPage.getByTestId("shop-plans").getByText(name)).toBeVisible();
    } finally {
      await sCtx.close();
    }
    notes.push("notice, prep sheet and plan card seen");

    // TC-SUB-035: off refuses new subscribers; the product cannot change under a subscriber.
    const off = await call(owner, "PATCH", `/api/shops/${listing.shopId}/subscription-plans/${planId}`, { isActive: false });
    expectStatus(off, 200, "turn the plan off");
    await pace();
    const again = await call(customer, "POST", `/api/subscription-plans/${planId}/subscribe`, { quantityMilli: 1000, frequency: "DAILY", startDate: monday, addressId: address.id });
    expect(again.status, "subscribing to a plan that is off").toBe(404);
    notes.push("plan off refuses new subscribers");
  } finally {
    if (subscriptionId) {
      await pace();
      const cancelled = await call(customer, "DELETE", `/api/subscriptions/${subscriptionId}`, { reason: "QA run — subscription plans" });
      if (cancelled.status !== 200) notes.push(`cancel → ${cancelled.status}`);
    }
    if (planId) {
      await pace();
      const removed = await call(owner, "DELETE", `/api/shops/${listing.shopId}/subscription-plans/${planId}`);
      if (removed.status !== 204) notes.push(`remove plan → ${removed.status}`);
    }
  }
  return `${notes.join("; ")}; subscription cancelled, plan removed`;
}, { tier: "signed", timeout: 180_000, partial: "the far shop, terms and lead days (TC-SUB-031/032) and removal keeping running subscribers (TC-SUB-035) are proved in tests/integration/subscription-plans.test.ts" });

manual(
  "TC-SUB-033",
  "plan subscriptions are charged the plan price, on delivery days only",
  "needs the daily subscription job run on chosen dates against a database; proved in tests/integration/subscription-plans.test.ts (\"charges the plan price on delivery days only\")",
);
