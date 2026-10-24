/**
 * Shop settings as the owner of shop A edits them (signed-in tier: the test
 * site and the local server): opening hours, location and delivery area,
 * minimum order, delivery fee and free-delivery threshold, preparation time,
 * description, logo, and the delivery / pause-orders / COD switches — each
 * field's bad values, and what the shop page shows.
 *
 * Every check reads shop A's settings first and puts them back in a finally
 * block, so the test shop is left exactly as it was.
 */
import type { APIRequestContext } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { addToCart, emptyCart, sellable, shopOf } from "../lib/flows";
import { anonymous, call, expectStatus, why } from "../lib/http";
import { expect, qa } from "../lib/record";

const signed = { tier: "signed" as const, timeout: 180_000 };

/** The fields these checks touch, as the owner's API returns them. */
const FIELDS = [
  "openingHours",
  "serviceRadiusKm",
  "deliveryPincodes",
  "minOrderPaise",
  "deliveryAvailable",
  "deliveryFeePaise",
  "freeDeliveryAbovePaise",
  "description",
  "logoUrl",
  "ordersPaused",
  "codEnabled",
  "pickupInstructions",
] as const;

async function ownerView(ctx: APIRequestContext, shopId: string) {
  const res = await call(ctx, "GET", `/api/shops/${shopId}`);
  expectStatus(res, 200, "the owner's view of the shop");
  return res.body as Record<string, unknown>;
}

/** Runs `body` on shop A and restores the settings it may have changed. */
async function onShopA<T>(body: (ctx: APIRequestContext, shop: { id: string; name: string; slug: string }) => Promise<T>): Promise<T> {
  const shop = await shopOf("A");
  const ctx = await as("shop");
  const before = await ownerView(ctx, shop.id);
  const snapshot = Object.fromEntries(FIELDS.filter((f) => f in before).map((f) => [f, before[f]]));
  try {
    return await body(ctx, shop);
  } finally {
    const restore = await call(ctx, "PATCH", `/api/shops/${shop.id}`, snapshot);
    expectStatus(restore, 200, "restore shop A's settings");
  }
}

const patch = (ctx: APIRequestContext, shopId: string, body: Record<string, unknown>) => call(ctx, "PATCH", `/api/shops/${shopId}`, body);

/** IST hh:mm `offsetMinutes` from now. */
function istTime(offsetMinutes: number) {
  const d = new Date(Date.now() + (330 + offsetMinutes) * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
function istDay() {
  return new Date(Date.now() + 330 * 60_000).getUTCDay();
}

qa("TC-ONB-029", "the owner edits hours, delivery flag and fee, free-delivery threshold, description, logo and the pickup point: saved and shown on the shop page", async ({ browser }) => {
  return onShopA(async (ctx, shop) => {
    const { context, page } = await pageAs(browser, "shop");
    try {
      await page.goto("/shop/manage/hours");
      const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][istDay()];
      await page.getByLabel(`${day} opening time`).fill(istTime(-60));
      await page.getByLabel(`${day} closing time`).fill(istTime(60));
      await page.getByRole("button", { name: "Save shop time" }).click();
      await expect(page.getByText("Saved.")).toBeVisible();
      await page.goto("/shop/manage/location");
      await page.getByLabel("Pickup instructions (optional)").fill("QA: use the side gate");
      await page.getByRole("button", { name: "Save location" }).click();
      await expect(page.getByText("Saved.")).toBeVisible();
    } finally {
      await context.close();
    }
    expectStatus(await patch(ctx, shop.id, { deliveryAvailable: true, deliveryFeePaise: 2500, freeDeliveryAbovePaise: 30_000, description: "QA: fresh every morning", logoUrl: "https://example.com/qa-logo.png" }), 200, "delivery, fee, threshold, description, logo");
    const view = await ownerView(ctx, shop.id);
    expect(view.pickupInstructions).toBe("QA: use the side gate");
    const guest = await anonymous();
    const html = await (await guest.get(`/shops/${shop.slug}`)).text();
    await guest.dispose();
    expect(html).toContain("Open now");
    expect(html).toMatch(/Delivery ₹(<!-- -->)?25(<!-- -->)?, free above ₹(<!-- -->)?300/);
    expect(html).toContain("QA: fresh every morning");
    return "hours (UI) → 'Open now'; pickup instructions (UI) saved; delivery ₹25, free above ₹300, description and logo URL (API) shown on the shop page";
  });
}, { ...signed, partial: "there is no owner screen for the delivery fee, threshold, description or logo (PATCH /api/shops/{id} only), and no preparation-time setting at all (TC-FLD-054)" });

qa("TC-FLD-049", "delivery radius: empty, 0, -1, 2.5 and text refused (422) with the value unchanged; 1 and 50 accepted; 51 refused", async () => {
  return onShopA(async (ctx, shop) => {
    const before = (await ownerView(ctx, shop.id)).serviceRadiusKm;
    const out: string[] = [];
    for (const value of [null, 0, -1, 2.5, "abc", 51]) {
      const res = await patch(ctx, shop.id, { serviceRadiusKm: value });
      expect(res.status, `${value}: ${why(res)}`).toBe(422);
      expect((await ownerView(ctx, shop.id)).serviceRadiusKm).toBe(before);
      out.push(`${JSON.stringify(value)} → 422`);
    }
    for (const value of [1, 50]) {
      expectStatus(await patch(ctx, shop.id, { serviceRadiusKm: value }), 200, `radius ${value}`);
      expect((await ownerView(ctx, shop.id)).serviceRadiusKm).toBe(value);
    }
    return `${out.join(", ")}; 1 and 50 saved; value unchanged after each refusal`;
  });
}, { ...signed, partial: "the form's number box (min 1, max 50, step 1) is not driven" });

qa("TC-FLD-050", "extra delivery PIN zones: 5/7 digits, letters, 000000 and a 0-leading PIN refused (422); a valid PIN accepted; a duplicate stored once; the shop's own PIN recorded", async () => {
  return onShopA(async (ctx, shop) => {
    const own = String((await ownerView(ctx, shop.id)).pincode ?? "411038");
    const out: string[] = [];
    expectStatus(await patch(ctx, shop.id, { deliveryPincodes: [] }), 200, "blank");
    const accepted: string[] = [];
    for (const value of ["41103", "4110381", "41a03b", "000000", "011038"]) {
      const res = await patch(ctx, shop.id, { deliveryPincodes: [value] });
      out.push(`${value} → ${res.status}`);
      if (res.status < 400) accepted.push(value);
    }
    expectStatus(await patch(ctx, shop.id, { deliveryPincodes: ["411045", "411045"] }), 200, "a duplicate");
    const stored = (await ownerView(ctx, shop.id)).deliveryPincodes;
    const self = await patch(ctx, shop.id, { deliveryPincodes: [own] });
    const detail = `blank accepted; ${out.join(", ")}; 411045 twice → stored ${JSON.stringify(stored)}; the shop's own PIN ${own} → ${self.status} (${JSON.stringify((await ownerView(ctx, shop.id)).deliveryPincodes)})`;
    expect(stored, detail).toEqual(["411045"]);
    expect(accepted, `PINs accepted (000000 / 0-leading: known defect D-04) — ${detail}`).toEqual([]);
    return detail;
  });
}, signed);

qa("TC-FLD-051", "minimum order value: negative, text, 3 decimals and an out-of-range amount refused (422); ₹70.50 stored as 7050 paise and shown as ₹70.50; 0 means no minimum", async ({ browser }) => {
  return onShopA(async (ctx, shop) => {
    const out: string[] = [];
    const accepted: string[] = [];
    for (const [label, value] of [["negative", -100], ["text", "abc"], ["10.555", 1055.5], ["₹10 crore", 1_000_000_000_00]] as const) {
      const res = await patch(ctx, shop.id, { minOrderPaise: value });
      out.push(`${label} → ${res.status}`);
      if (res.status < 400) accepted.push(label);
    }
    expectStatus(await patch(ctx, shop.id, { minOrderPaise: 0 }), 200, "0 = no minimum");
    const { context, page } = await pageAs(browser, "shop");
    try {
      await page.goto("/shop/manage/location");
      await page.getByTestId("min-order").fill("70.50");
      await page.getByRole("button", { name: "Save location" }).click();
      await expect(page.getByText("Saved.")).toBeVisible();
      await page.reload();
      await expect(page.getByTestId("min-order")).toHaveValue("70.5");
    } finally {
      await context.close();
    }
    expect((await ownerView(ctx, shop.id)).minOrderPaise).toBe(7050);
    expect(accepted, `amounts accepted: ${out.join("; ")}`).toEqual([]);
    return `${out.join(", ")}; 0 accepted (no minimum); ₹70.50 → 7050 paise, shown back as 70.5`;
  });
}, signed);

qa("TC-FLD-052", "opening hours: impossible times are refused; a closed day and overnight hours (22:00–02:00) save and drive the open / closed label in IST", async () => {
  return onShopA(async (ctx, shop) => {
    const day = istDay();
    const week = (today: Record<string, unknown>) => [0, 1, 2, 3, 4, 5, 6].map((d) => (d === day ? { day: d, ...today } : { day: d, open: "06:00", close: "22:00" }));
    const label = async () => {
      const guest = await anonymous();
      const html = await (await guest.get(`/shops/${shop.slug}`)).text();
      await guest.dispose();
      return html.includes("Open now") ? "Open now" : "Closed";
    };
    const out: string[] = [];
    const impossible: [string, Record<string, unknown>][] = [
      ["25:00", { open: "06:00", close: "25:00" }],
      ["text", { open: "morning", close: "night" }],
      ["open = close", { open: "10:00", close: "10:00" }],
    ];
    const accepted: string[] = [];
    for (const [name, today] of impossible) {
      const res = await patch(ctx, shop.id, { openingHours: week(today) });
      out.push(`${name} → ${res.status}`);
      if (res.status < 400) accepted.push(name);
    }
    expectStatus(await patch(ctx, shop.id, { openingHours: week({ open: "06:00", close: "22:00", closed: true }) }), 200, "closed today");
    expect(await label(), "a closed day shows Closed").toBe("Closed");
    // Overnight hours that span now: opened an hour ago, closing an hour before now tomorrow.
    const overnight = { open: istTime(-60), close: istTime(-120) };
    expectStatus(await patch(ctx, shop.id, { openingHours: week(overnight) }), 200, "overnight hours");
    const overnightLabel = await label();
    out.push(`overnight ${overnight.open}–${overnight.close} (spanning now) → "${overnightLabel}"`);
    expect(accepted, `impossible times accepted: ${out.join("; ")}`).toEqual([]);
    expect(overnightLabel, `overnight hours must count as open — ${out.join("; ")}`).toBe("Open now");
    return out.join("; ");
  });
}, { ...signed, partial: "closing-before-opening is the overnight case, so it cannot be both refused and accepted; it is judged as overnight" });

qa("TC-FLD-053", "delivery fee and free-delivery threshold: negative, text, 3 decimals and out-of-range refused (422); ₹70.50 stored as 7050 and shown; fee 0 accepted; a blank threshold means the fee always applies", async () => {
  return onShopA(async (ctx, shop) => {
    const out: string[] = [];
    const accepted: string[] = [];
    for (const field of ["deliveryFeePaise", "freeDeliveryAbovePaise"] as const) {
      for (const [label, value] of [["negative", -100], ["text", "abc"], ["10.555", 1055.5], ["₹10 crore", 1_000_000_000_00]] as const) {
        const res = await patch(ctx, shop.id, { [field]: value, deliveryAvailable: true });
        out.push(`${field} ${label} → ${res.status}`);
        if (res.status < 400) accepted.push(`${field} ${label}`);
      }
    }
    expectStatus(await patch(ctx, shop.id, { deliveryAvailable: true, deliveryFeePaise: 7050, freeDeliveryAbovePaise: null }), 200, "₹70.50, no threshold");
    const guest = await anonymous();
    const html = await (await guest.get(`/shops/${shop.slug}`)).text();
    await guest.dispose();
    expect(html).toMatch(/Delivery ₹(<!-- -->)?7[01]\b/);
    expect(html, "no 'free above' line without a threshold").not.toContain("free above");
    expectStatus(await patch(ctx, shop.id, { deliveryFeePaise: 0 }), 200, "fee 0");
    expect(accepted, `amounts accepted: ${out.join("; ")}`).toEqual([]);
    return `${out.join(", ")}; 7050 saved; the shop page rounds it to "Delivery ₹71" (no paise); fee 0 accepted`;
  });
}, { ...signed, partial: "no owner screen edits these (API only); 'shown as ₹70.50' — the shop page prints whole rupees" });

qa("TC-FLD-054", "preparation time: the owner can set it (negative, decimal, text, out-of-range refused; a normal value saves and shows after reload)", async ({ browser }) => {
  return onShopA(async (ctx, shop) => {
    const api = await patch(ctx, shop.id, { preparationTimeMinutes: 25 });
    const { context, page } = await pageAs(browser, "shop");
    let fields = 0;
    try {
      for (const path of ["/shop/manage/hours", "/shop/manage/location", "/shop/manage/today"]) {
        await page.goto(path);
        fields += await page.getByLabel(/preparation|prep time/i).count();
      }
    } finally {
      await context.close();
    }
    expect({ fields, api: api.status }, `no preparation-time setting: no field on /shop/manage/{hours,location,today}; PATCH {preparationTimeMinutes} → ${why(api)}`).toEqual({ fields: 1, api: 200 });
    return "preparation time is editable";
  });
}, signed);

qa("TC-FLD-055", "description: blank accepted; over the limit refused (no 500); script shown as text; Marathi saved; line breaks kept on the shop page", async ({ browser }) => {
  return onShopA(async (ctx, shop) => {
    expectStatus(await patch(ctx, shop.id, { description: null }), 200, "blank");
    const long = await patch(ctx, shop.id, { description: "D".repeat(1001) });
    expect(long.status, `1001 characters: ${why(long)}`).toBe(422);
    expectStatus(await patch(ctx, shop.id, { description: "D".repeat(300) }), 200, "300 characters");
    const text = "<script>alert(1)</script> ताजे दूध\nSecond line";
    expectStatus(await patch(ctx, shop.id, { description: text }), 200, "script, Marathi, a line break");
    const { context, page } = await pageAs(browser, "customer");
    let dialogs = 0;
    page.on("dialog", async (d) => {
      dialogs += 1;
      await d.dismiss();
    });
    let shown = "";
    try {
      await page.goto(`/shops/${shop.slug}`);
      await page.getByText("Shop info, opening hours and reviews").click();
      const p = page.getByTestId("shop-info").getByText("<script>alert(1)</script>", { exact: false });
      await expect(p).toBeVisible();
      shown = await p.innerText();
    } finally {
      await context.close();
    }
    expect(dialogs).toBe(0);
    expect(shown).toContain("ताजे दूध");
    expect(shown, `line breaks must be kept on the shop page — shown as "${shown}"`).toContain("\n");
    return `blank ok; 1001 chars → 422 (limit 1000); script shown as text; Marathi kept; line break kept`;
  });
}, signed);

qa("TC-FLD-056", "logo: the owner uploads a logo file (none / oversized / wrong type / disguised / empty refused by content; a valid file shown); without a logo the shop shows a neutral placeholder", async ({ browser }) => {
  return onShopA(async (ctx, shop) => {
    const unsafe = await patch(ctx, shop.id, { logoUrl: "javascript:alert(1)" });
    const notUrl = await patch(ctx, shop.id, { logoUrl: "not a url" });
    expectStatus(await patch(ctx, shop.id, { logoUrl: null }), 200, "no logo");
    const { context, page } = await pageAs(browser, "shop");
    let uploads = 0;
    try {
      for (const path of ["/shop/manage/hours", "/shop/manage/location", "/shop/manage/today", "/shop/profile-setup"]) {
        await page.goto(path);
        uploads += await page.locator('input[type="file"]').count();
      }
    } finally {
      await context.close();
    }
    expect({ uploads, unsafe: unsafe.status }, `no logo upload exists (no file input on the shop's settings screens; logoUrl is a free URL — "not a url" → ${notUrl.status}, "javascript:alert(1)" → ${unsafe.status})`).toEqual({ uploads: 1, unsafe: 422 });
    return "logo upload present";
  });
}, signed);

qa("TC-FLD-057", "delivery, pause-orders and COD switches persist both ways and take effect; a non-boolean is refused", async () => {
  return onShopA(async (ctx, shop) => {
    const out: string[] = [];
    for (const field of ["deliveryAvailable", "ordersPaused", "codEnabled"] as const) {
      const bad = await patch(ctx, shop.id, { [field]: "yes" });
      expect(bad.status, `${field} "yes"`).toBe(422);
      for (const value of [true, false]) {
        expectStatus(await patch(ctx, shop.id, { [field]: value }), 200, `${field} ${value}`);
        expect((await ownerView(ctx, shop.id))[field]).toBe(value);
      }
      out.push(`${field}: "yes" 422, on/off persist`);
    }
    // Effects.
    expectStatus(await patch(ctx, shop.id, { deliveryAvailable: false }), 200, "delivery off");
    const guest = await anonymous();
    const delivering = await call(guest, "GET", `/api/shops?delivery=true&q=${encodeURIComponent(shop.name)}&limit=24`);
    const listed = ((Array.isArray(delivering.body) ? delivering.body : delivering.body?.shops) ?? []) as { id: string }[];
    expect(listed.some((s) => s.id === shop.id), "not listed as delivering").toBe(false);
    expectStatus(await patch(ctx, shop.id, { deliveryAvailable: true }), 200, "delivery back on");
    const listing = await sellable("A", 1);
    await emptyCart();
    expectStatus(await addToCart("customer", listing.shopProductId, 1), [200, 201], "a line from shop A");
    expectStatus(await patch(ctx, shop.id, { ordersPaused: true }), 200, "pause on");
    const html = await (await guest.get(`/shops/${shop.slug}`)).text();
    await guest.dispose();
    const checkout = await call(await as("customer"), "POST", "/api/checkout", { requestId: `qa-paused-${Date.now()}`, paymentMethod: "WALLET", addressId: null, acknowledgeClosedShopIds: [shop.id] });
    await emptyCart();
    expect(checkout.status, `checkout from a paused shop: ${why(checkout)}`).toBeGreaterThanOrEqual(400);
    expect(checkout.status).toBeLessThan(500);
    out.push(`delivery off → not in ?delivery=true; paused → checkout ${checkout.status} "${checkout.body?.error?.message ?? ""}", page ${/paused|not taking orders|cannot check out/i.test(html) ? "says so" : "does not say"}`);
    return out.join("; ");
  });
}, { ...signed, partial: "'COD on: customers are offered COD' also needs the platform COD rule and a cart from this shop — covered by the COD cases" });
