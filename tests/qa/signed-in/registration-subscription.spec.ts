/**
 * Shop registration subscription (0203; owner brief 25-Nov-2026; PR #557;
 * docs/shop-registration-subscription-2026-11). Cases in
 * docs/testing/manual/cases-added-2026-11-25-registration-subscription.json.
 *
 * Signed-in tier, runs on test.gokesari.com: the admin screen and its API, role
 * access, the settings defaults, the owner's card, and Expire now / restore on
 * shop B (hidden from customers, then shown again; audited). The date-driven
 * parts (payments, reminder schedule, migration, webhook, grace) are proven in
 * tests/integration/shop-registration-subscription.test.ts (Vitest, real PostgreSQL).
 */
import { as, pageAs } from "../lib/actors";
import { anonymous, call, expectStatus } from "../lib/http";
import { expect, manual, need, qa } from "../lib/record";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 240_000 };
const API = "/api/admin/registration-subscription";

interface Row {
  shopId: string;
  shopName: string;
  status: string;
  expiryDate: string | null;
  daysLeft: number | null;
  amountDuePaise: number;
  link: { id: string; status: string } | null;
}

async function rowOf(shopId: string): Promise<Row | undefined> {
  const res = await call(await as("admin"), "GET", `${API}?filter=ALL`);
  expectStatus(res, 200, "registration list");
  return (res.body.rows as Row[]).find((r) => r.shopId === shopId);
}

qa("TC-REGSUB-001", "Unpaid & expiring registrations screen shows the brief's filters and columns", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/shops/registrations?filter=ALL");
    await expect(page.getByRole("heading", { name: "Unpaid & expiring registrations" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Filter by registration status" });
    for (const name of [/^Unpaid/, /^Expiring in 30 days/, /^15 days/, /^7 days/, /^Grace/, /^Expired/]) await expect(nav.getByRole("link", { name })).toBeVisible();
    await expect(page.getByLabel("Shop type")).toBeVisible();
    await expect(page.getByLabel("Area / city / PIN")).toBeVisible();
    await expect(page.getByLabel("Dealer code")).toBeVisible();
    const table = page.getByTestId("shop-registrations");
    await expect(table).toBeVisible();
    for (const h of ["Shop", "Owner", "Type · dealer", "Registered", "Expiry", "Days left", "Status", "Amount due", "Last reminder", "Payment link", "Actions"]) {
      await expect(table.getByRole("columnheader", { name: h, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Send reminder" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create payment link" })).toBeVisible();
  } finally {
    await context.close();
  }
  return "filters, columns and bulk actions shown";
}, { ...signed, mobile: true });

qa("TC-REGSUB-002", "Registration list API filters by expiry window and downloads CSV with masked mobiles", async () => {
  const admin = await as("admin");
  const all = await call(admin, "GET", `${API}?filter=ALL`);
  expectStatus(all, 200, "list ALL");
  expect(all.body.counts).toEqual(expect.objectContaining({ UNPAID: expect.any(Number), GRACE: expect.any(Number), EXPIRED: expect.any(Number), EXPIRING_30: expect.any(Number) }));
  const window = await call(admin, "GET", `${API}?filter=EXPIRING_30`);
  expectStatus(window, 200, "list EXPIRING_30");
  for (const r of window.body.rows as Row[]) {
    expect(r.daysLeft).not.toBeNull();
    expect(r.daysLeft!).toBeGreaterThanOrEqual(0);
    expect(r.daysLeft!).toBeLessThanOrEqual(30);
  }
  const csv = await call(admin, "GET", `${API}?filter=ALL&format=csv`);
  expectStatus(csv, 200, "CSV");
  const [header, ...lines] = csv.text.trim().split("\n");
  expect(header).toBe("Shop,Owner,Mobile,E-mail,Shop type,Dealer code,Area,City,Registered,Expiry,Days left,Status,Amount due (Rs),Last reminder (IST),Payment link");
  for (const line of lines.slice(0, 50)) expect(line).not.toMatch(/,\d{10},/);
  return `${all.body.rows.length} shops, ${window.body.rows.length} expiring in 30 days, CSV ${lines.length} rows`;
}, signed);

qa("TC-REGSUB-003", "Only admin and operator manage registrations; settings are admin only", async () => {
  for (const role of ["customer", "shop"] as const) {
    const ctx = await as(role);
    expectStatus(await call(ctx, "GET", API), 403, `${role} list`);
    expectStatus(await call(ctx, "POST", API, { action: "REMIND", shopIds: [need(world().shops.A?.id, "shop A")] }), 403, `${role} remind`);
    expectStatus(await call(ctx, "GET", `${API}/settings`), 403, `${role} settings`);
  }
  const ops = await as("ops");
  expectStatus(await call(ops, "GET", `${API}?filter=UNPAID`), 200, "operator list");
  expectStatus(await call(ops, "GET", `${API}/settings`), 403, "operator settings");
  expectStatus(await call(await anonymous(), "GET", API), 401, "guest list");
  return "customer / shop owner 403, operator list 200 and settings 403, guest 401";
}, signed);

qa("TC-REGSUB-004", "Settings carry the brief's defaults", async () => {
  const res = await call(await as("admin"), "GET", `${API}/settings`);
  expectStatus(res, 200, "settings");
  const { membership: m, subscription: s } = res.body;
  expect(m.periodMonths).toBe(12);
  expect(m.graceDays).toBe(7);
  expect(s.unpaidReminderDays).toEqual([1, 3, 7]);
  expect(s.unpaidRepeatEveryDays).toBe(7);
  expect(s.expiryReminderDays).toEqual([30, 15, 7, 6, 5, 4, 3, 2, 1, 0]);
  expect(s.graceDaily).toBe(true);
  expect(s.paymentLinkValidityDays).toBe(7);
  expect(s.ccEmails).toContain("ceo@agtci.com");
  expect(s.payCommissionOnRenewals).toBe(false);
  expect(s.reminderHourIst).toBe(9);
  return `grace ${m.graceDays}, reminders ${m.remindersEnabled ? "on" : "off"}, renewal checkout ${m.renewalCheckoutEnabled ? "on" : "off"}`;
}, signed);

qa("TC-REGSUB-005", "The shop owner's dashboard shows the Shop Registration card", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "shop");
  try {
    await page.goto("/shop");
    const card = page.getByTestId("registration-card");
    await expect(card).toBeVisible();
    for (const label of ["Registration date", "Expiry date", "Days left", "Amount due"]) await expect(card.getByText(label, { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: "Payment history and receipts" })).toBeVisible();
    const status = await card.getByRole("heading").textContent();
    const banner = page.getByTestId("registration-banner");
    const bannerStatus = (await banner.count()) > 0 ? await banner.getAttribute("data-status") : null;
    return `card shown (${status?.trim()}); banner ${bannerStatus ?? "none"}`;
  } finally {
    await context.close();
  }
}, { ...signed, mobile: true });

qa("TC-REGSUB-006", "Expire now hides the shop from customers; restoring the date shows it again; both audited with the reason", async () => {
  const shopB = need(world().shops.B, "shop B");
  const shopId = need(shopB.id, "shop B id");
  const slug = need(shopB.slug, "shop B slug");
  const admin = await as("admin");
  const guest = await anonymous();
  const before = need(await rowOf(shopId), "shop B in the registration list");
  const oldExpiry = need(before.expiryDate, "shop B has an expiry date");
  const restoreDate = new Date(new Date(oldExpiry).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
  expectStatus(await call(guest, "GET", `/shops/${slug}`), 200, "shop B page before");
  try {
    expectStatus(await call(admin, "POST", API, { action: "EXPIRY", shopId, change: { mode: "EXPIRE_NOW" }, reason: "QA TC-REGSUB-006 expire now" }), 200, "expire now");
    expect((await rowOf(shopId))?.status).toBe("EXPIRED");
    expectStatus(await call(guest, "GET", `/shops/${slug}`), 404, "shop B page while expired");
    const search = await call(guest, "GET", `/api/shops?q=${encodeURIComponent(shopB.name)}`);
    expect(JSON.stringify(search.body)).not.toContain(shopId);
  } finally {
    expectStatus(await call(admin, "POST", API, { action: "EXPIRY", shopId, change: { mode: "SET_DATE", date: restoreDate }, reason: "QA TC-REGSUB-006 restore the old expiry" }), 200, "restore expiry");
  }
  expect((await rowOf(shopId))?.status).not.toBe("EXPIRED");
  expectStatus(await call(guest, "GET", `/shops/${slug}`), 200, "shop B page after restore");
  const history = await call(admin, "GET", `${API}/${shopId}`);
  expectStatus(history, 200, "history");
  const changes = (history.body.audit as { action: string; atIst: string; newValue: { reason?: string; mode?: string } }[]).filter((a) => a.action === "shop.registration_expiry_changed");
  expect(changes.slice(0, 2).map((a) => a.newValue.mode).sort()).toEqual(["EXPIRE_NOW", "SET_DATE"]);
  expect(changes[0].newValue.reason).toContain("QA TC-REGSUB-006");
  expect(changes[0].atIst).toMatch(/IST$/);
  return `expired → 404 and not found; restored to ${restoreDate}; audited`;
}, signed);

qa("TC-REGSUB-007", "Expiry change needs a reason; Send reminder skips an active shop", async () => {
  const shopId = need(world().shops.A?.id, "shop A");
  const admin = await as("admin");
  const before = await rowOf(shopId);
  expectStatus(await call(admin, "POST", API, { action: "EXPIRY", shopId, change: { mode: "EXTEND", days: 5 }, reason: "" }), [400, 422], "empty reason");
  expect((await rowOf(shopId))?.expiryDate).toBe(before?.expiryDate);
  if (before?.status === "ACTIVE") {
    const r = await call(admin, "POST", API, { action: "REMIND", shopIds: [shopId] });
    expectStatus(r, 200, "remind active shop");
    expect(r.body).toEqual({ sent: 0, skipped: [{ shopId, reason: "registration active — nothing due" }] });
  }
  return `reason enforced; shop A ${before?.status}`;
}, signed);

qa("TC-REGSUB-008", "A new payment link cancels the shop's older link", async () => {
  const shopId = need(world().shops.B?.id, "shop B");
  const admin = await as("admin");
  const first = await call(admin, "POST", API, { action: "LINK", shopIds: [shopId], validityDays: 1, reason: "QA TC-REGSUB-008 first" });
  expectStatus(first, 200, "first link");
  expect(first.body.failed).toEqual([]);
  const second = await call(admin, "POST", API, { action: "LINK", shopIds: [shopId], validityDays: 1, reason: "QA TC-REGSUB-008 second" });
  expectStatus(second, 200, "second link");
  const row = await rowOf(shopId);
  expect(row?.link?.status).toBe("ACTIVE");
  const history = await call(admin, "GET", `${API}/${shopId}`);
  const cancelled = (history.body.audit as { action: string; previousValue: { linkId?: string } }[]).find((a) => a.action === "shop.registration_link_cancelled");
  expect(cancelled?.previousValue.linkId).toBe(first.body.created[0].linkId);
  return `link ${second.body.created[0].linkId} active; ${first.body.created[0].linkId} cancelled`;
}, signed);

const VITEST = "proven by tests/integration/shop-registration-subscription.test.ts (Vitest, real PostgreSQL) — date-driven, not repeatable on a shared site";
manual("TC-REGSUB-009", "New registration payment starts 1 year from the payment date", VITEST);
manual("TC-REGSUB-010", "Unpaid reminders day 1, 3, 7 then weekly, from 09.00 IST, once a day", VITEST);
manual("TC-REGSUB-011", "Migration of existing shops and its report", VITEST);
manual("TC-REGSUB-012", "Expiry reminders 30, 15, last 7 days, expiry day, grace days", "schedule proven by tests/unit/shop-registration-subscription.test.ts; E15 send by the integration test");
manual("TC-REGSUB-013", "Gateway webhook: success once, failure, duplicate", VITEST);
manual("TC-REGSUB-014", "Mark as paid offline", VITEST);
manual("TC-REGSUB-015", "Grace keeps the shop working; after grace hidden and no new orders", VITEST);
manual("TC-REGSUB-016", "Reminder by e-mail, push and in-app on Android", "needs an Android phone with app 1.14.0");
manual("TC-REGSUB-017", "Reminder by e-mail, push and in-app on iPhone", "needs iPhone build 15 (EAS) — owner");
manual("TC-REGSUB-018", "Pay a renewal link on staging (sandbox)", "pay step runs through the Sandbox payment GitHub workflow");
manual("TC-REGSUB-019", "Production test payment and refund", "owner pays with their own card / UPI and refunds; Claude may not enter payment details");
