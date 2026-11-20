/**
 * Newspaper and periodical subscriptions end to end (docs/newspaper-subscriptions-2026-11),
 * signed in on the test accounts: shop A lists a daily paper and a monthly
 * magazine; customer 1 finds shop A for their default address, subscribes to
 * both in one submission; shop A's owner is told and sees the subscriber.
 * The subscriptions are cancelled at the end, so no delivery is ever charged;
 * the two listings stay on shop A (test data, re-used by the next run).
 */
import { as, pageAs } from "../lib/actors";
import { defaultAddress, shopOf } from "../lib/flows";
import { call, expectStatus, pace, type Answer } from "../lib/http";
import { blocked, expect, manual, need, qa } from "../lib/record";

/** A daily newspaper and a monthly magazine of the starter list (migration 0152). */
const PAPER = "The Times of India";
const MAGAZINE = "Tinkle";
const CATEGORIES = ["Newspapers", "Magazines & Periodicals"];

interface Title {
  productId: string;
  name: string;
}
interface Vendor {
  shopId: string;
  name: string;
  offers: { productId: string; shopProductId: string; name: string; pricePaise: number }[];
  missingProductIds: string[];
}
interface Listing {
  id: string;
  productId: string;
  onlineSaleEnabled: boolean;
  onlinePricePaise: number | null;
}

/** Tomorrow in India — the earliest start the API accepts that is never "today" at a day boundary. */
function tomorrowIst(): string {
  return new Date(Date.now() + (5.5 + 24) * 3600_000).toISOString().slice(0, 10);
}

async function titleIds(): Promise<Record<string, string>> {
  const res = await call(await as("customer"), "GET", "/api/subscriptions/newspapers");
  expectStatus(res, 200, "GET /api/subscriptions/newspapers");
  const titles = res.body as Title[];
  const ids: Record<string, string> = {};
  for (const name of [PAPER, MAGAZINE]) ids[name] = need(titles.find((t) => t.name === name), `the title "${name}" (migration 0152)`).productId;
  return ids;
}

/** Shop A carries both newspaper categories and sells both titles online (₹6 and ₹80 a copy). */
async function listOnShopA(ids: Record<string, string>): Promise<string> {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const cats = await call(owner, "GET", "/api/product-categories?selectable=1");
  expectStatus(cats, 200, "GET /api/product-categories?selectable=1");
  for (const name of CATEGORIES) {
    const category = need((cats.body.categories as { id: string; name: string }[]).find((c) => c.name === name), `category "${name}"`);
    await pace();
    const added = await call(owner, "POST", `/api/shops/${shop.id}/product-categories`, { categoryId: category.id });
    expect([200, 201], `add category ${name}: ${added.status} ${added.text.slice(0, 200)}`).toContain(added.status);
  }
  const listings = await call(owner, "GET", `/api/shops/${shop.id}/products`);
  expectStatus(listings, 200, "shop A's listings");
  const prices: Record<string, number> = { [PAPER]: 600, [MAGAZINE]: 8000 };
  for (const [name, productId] of Object.entries(ids)) {
    await pace();
    const existing = (listings.body as Listing[]).find((l) => l.productId === productId);
    let res: Answer;
    if (existing) {
      res = await call(owner, "PATCH", `/api/shop-products/${existing.id}`, {
        onlineSaleEnabled: true,
        onlinePricePaise: prices[name],
        trackInventory: false,
        isActive: true,
        isAvailable: true,
      });
      expectStatus(res, 200, `update shop A's ${name} listing`);
    } else {
      res = await call(owner, "POST", `/api/shops/${shop.id}/products`, {
        productId,
        onlineSaleEnabled: true,
        onlinePricePaise: prices[name],
        trackInventory: false,
      });
      expectStatus(res, 201, `list ${name} on shop A`);
    }
  }
  return shop.id;
}

qa(["TC-SUB-023", "TC-SUB-024", "TC-SUB-025", "TC-SUB-026"], "customer subscribes to a paper and a magazine from a nearby vendor; the vendor is told and sees them", async ({ browser }) => {
  const ids = await titleIds();
  const shopId = await listOnShopA(ids);
  const customer = await as("customer");
  const address = need(await defaultAddress("customer"), "a default address for customer 1");
  const created: string[] = [];
  const notes: string[] = [];

  try {
    // TC-SUB-023: shop A is offered for the address with both titles.
    const vendors = await call(customer, "GET", `/api/subscriptions/newspapers/vendors?addressId=${address.id}&productIds=${ids[PAPER]},${ids[MAGAZINE]}`);
    expectStatus(vendors, 200, "find vendors");
    const list = vendors.body as Vendor[];
    const shopA = list.find((v) => v.shopId === shopId);
    if (!shopA) blocked(`shop A is not offered for customer 1's default address (PIN ${address.pincode}); vendors: ${list.map((v) => v.name).join(", ") || "none"}`);
    expect(shopA.offers.map((o) => o.name).sort(), "shop A's offers").toEqual([MAGAZINE, PAPER].sort());
    expect(shopA.missingProductIds, "titles shop A lacks").toEqual([]);
    expect(list.indexOf(shopA), "shop A carries both, so no vendor with fewer titles comes before it").toBe(
      list.findIndex((v) => v.offers.length === shopA.offers.length),
    );
    notes.push(`${list.length} vendor(s); shop A ${shopA.offers.map((o) => `${o.name} ₹${o.pricePaise / 100}`).join(", ")}`);
    const offerOf = (name: string) => shopA.offers.find((o) => o.name === name)!;

    // TC-SUB-026: one bad item refuses the whole submission.
    const startDate = tomorrowIst();
    const body = (items: unknown[]) => ({ shopId, addressId: address.id, startDate, items });
    for (const [what, items] of [
      ["day of the month 30", [{ shopProductId: offerOf(MAGAZINE).shopProductId, copies: 1, frequency: "MONTHLY", monthDays: [30] }]],
      ["11 copies", [{ shopProductId: offerOf(PAPER).shopProductId, copies: 11, frequency: "DAILY" }]],
      ["a schedule with no day", [{ shopProductId: offerOf(MAGAZINE).shopProductId, copies: 1, frequency: "MONTHLY", monthDays: [] }]],
    ] as const) {
      await pace();
      const res = await call(customer, "POST", "/api/subscriptions/newspapers", body([...items]));
      expect(res.status, `${what}: ${res.text.slice(0, 200)}`).toBe(422);
    }
    notes.push("bad items refused 422");

    // TC-SUB-024: both titles in one submission.
    const res = await call(
      customer,
      "POST",
      "/api/subscriptions/newspapers",
      body([
        { shopProductId: offerOf(PAPER).shopProductId, copies: 1, frequency: "DAILY" },
        { shopProductId: offerOf(MAGAZINE).shopProductId, copies: 1, frequency: "MONTHLY", monthDays: [1] },
      ]),
    );
    expectStatus(res, 201, "subscribe to both titles");
    const subs = res.body.subscriptions as { id: string; bundleId: string; shopId: string; frequency: string; monthDays: number[] }[];
    created.push(...subs.map((s) => s.id));
    expect(subs, "one subscription per title").toHaveLength(2);
    expect(new Set(subs.map((s) => s.bundleId)).size, "one bundle").toBe(1);
    expect(res.body.bundleId, "bundle id").toBe(subs[0].bundleId);
    expect(subs.every((s) => s.shopId === shopId), "all from shop A").toBe(true);
    expect(subs.map((s) => `${s.frequency}${s.monthDays.length ? s.monthDays.join(",") : ""}`).sort(), "schedules").toEqual(["DAILY", "MONTHLY1"]);
    notes.push(`2 subscriptions, bundle ${String(res.body.bundleId).slice(0, 8)}`);

    const { context: customerCtx, page: customerPage } = await pageAs(browser, "customer");
    try {
      await customerPage.goto("/subscriptions?added=newspapers");
      await expect(customerPage.getByTestId("newspapers-added")).toBeVisible();
      await expect(customerPage.getByText("1st of the month").first()).toBeVisible();
      expect(await customerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll").toBe(true);
    } finally {
      await customerCtx.close();
    }

    // TC-SUB-025: the vendor's notice and subscriber list.
    const owner = await as("shop");
    const inbox = await call(owner, "GET", "/api/notifications");
    expectStatus(inbox, 200, "shop owner's notifications");
    const notice = ((inbox.body?.notifications ?? inbox.body) as { type: string; title: string; body: string; actionUrl: string; metadata?: { bundleId?: string } }[]).find(
      (n) => n.type === "shop.new_subscription" && n.metadata?.bundleId === res.body.bundleId,
    );
    expect(notice, "a new-subscriber notice for this submission").toBeTruthy();
    expect(notice!.title).toBe("New subscriber — 2 items");
    expect(notice!.body).toContain(`${PAPER} (1 copy, every day)`);
    expect(notice!.body).toContain(`${MAGAZINE} (1 copy, 1st of the month)`);
    expect(notice!.actionUrl).toBe("/shop/manage/subscribers");
    notes.push(`notice "${notice!.title}"`);

    const { context: shopCtx, page: shopPage } = await pageAs(browser, "shop");
    try {
      await shopPage.goto("/shop/manage/subscribers");
      const listEl = shopPage.getByTestId("shop-subscriber-list");
      await expect(listEl).toBeVisible();
      await expect(listEl.getByText(`${MAGAZINE} · 1 copy · 1st of the month`).first()).toBeVisible();
      await expect(listEl.getByText(`${PAPER} · 1 copy · Every day`).first()).toBeVisible();
    } finally {
      await shopCtx.close();
    }
    notes.push("Subscribers page lists both");
  } finally {
    // Never leave a running subscription behind: nothing is charged before tomorrow.
    for (const id of created) {
      await pace();
      const cancelled = await call(customer, "DELETE", `/api/subscriptions/${id}`, { reason: "QA run — newspaper subscriptions" });
      if (cancelled.status !== 200) notes.push(`cancel ${id.slice(0, 8)} → ${cancelled.status}`);
    }
  }
  return `${notes.join("; ")}; ${created.length} subscription(s) cancelled`;
}, { tier: "signed", timeout: 180_000, partial: "the far vendor and another vendor's title (TC-SUB-023/026) are proved in tests/integration/newspaper-subscriptions.test.ts" });

manual(
  "TC-SUB-027",
  "a day-of-month magazine is delivered and charged only on its day",
  "needs the daily subscription job run on chosen dates against a database; proved in tests/integration/newspaper-subscriptions.test.ts (\"daily generation for newspaper subscriptions\")",
);
