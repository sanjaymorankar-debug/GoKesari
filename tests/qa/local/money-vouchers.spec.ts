/**
 * Wallet vouchers (TC-PAY-012–015, TC-FLD-031), on the local server only:
 * vouchers are platform-wide promotions created by an admin, their spent
 * states (budget used up, a customer's earlier use) are arranged in the
 * local database, and a promotional balance is set on the customer's wallet.
 *
 * What cannot run here: the bonus is credited only when a top-up is paid
 * (verify / webhook), and a top-up cannot be paid on a local server without
 * Cashfree keys — those halves block with that reason.
 */
import ExcelJS from "exceljs";

import { as, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { sellable } from "../lib/flows";
import { call, expectStatus, RUN, why } from "../lib/http";
import { arrangeWallet, cancelAsCustomer, istDate, placeVia, sleep, walletOf } from "../lib/money-helpers";
import { blocked, expect, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 240_000 };
const code = (tag: string) => `QA${tag}${RUN}`.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 30);

async function createVoucher(input: Record<string, unknown>) {
  const res = await call(await as("admin"), "POST", "/api/vouchers", {
    name: `QA voucher ${input.code}`,
    bonusPercent: 10,
    startDate: istDate(-1),
    endDate: istDate(30),
    perCustomerLimit: 1,
    ...input,
  });
  expectStatus(res, 201, `create voucher ${String(input.code)}`);
  return res.body as { id: string; code: string; status: string };
}

/** POST /api/vouchers/preview as the customer (10 a minute: the limit is waited out once). */
async function preview(codeText: string, amountPaise: number) {
  let res = await call(await as("customer"), "POST", "/api/vouchers/preview", { code: codeText, amountPaise });
  if (res.status === 429) {
    await sleep(61_000);
    res = await call(await as("customer"), "POST", "/api/vouchers/preview", { code: codeText, amountPaise });
  }
  return res;
}

qa("TC-PAY-012", "a voucher code previews its bonus on /wallet and the top-up order commits to it", async ({ browser }) => {
  const v = await createVoucher({ code: code("B"), bonusPercent: 10, maximumBonusPaise: 20_000 });
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/wallet");
    const card = page.locator("#add-money");
    await card.getByLabel("Amount in rupees").fill("1000");
    await card.getByLabel("Voucher code").fill(v.code.toLowerCase());
    await expect(card.getByLabel("Voucher code"), "the code box upper-cases").toHaveValue(v.code);
    await card.getByRole("button", { name: "Apply" }).click();
    await expect(card.getByText("Voucher bonus (10%)")).toBeVisible();
    await expect(card.locator("div").filter({ hasText: /^Voucher bonus \(10%\)/ }).first()).toContainText("100");
    await expect(card.locator("div").filter({ hasText: /^Total wallet credit/ }).first()).toContainText("1,100");
  } finally {
    await context.close();
  }
  const order = await call(await as("customer"), "POST", "/api/wallet/topup", { amountPaise: 100_000, voucherCode: v.code });
  expectStatus(order, 200, "top-up with the code");
  expect(order.body.voucherPreview?.bonusAmountPaise, "bonus fixed when the order is made").toBe(10_000);
  const [row] = await db()`select voucher_code, status from payments where gateway_order_id = ${order.body.gatewayOrderId}`;
  expect(row.voucher_code, "the payment carries the code, not a bonus figure").toBe(v.code);
  return `₹1,000 + ${v.code} → preview "Voucher bonus (10%) ₹100, total ₹1,100"; top-up order ${order.body.gatewayOrderId} carries voucher ${row.voucher_code} (bonus ₹100 recomputed at verify)`;
}, { ...local, partial: "the promotional credit and the redemption row are written when the top-up is paid — next check (blocked here)" });

qa("TC-PAY-012", "the voucher bonus is credited as promotional balance with a redemption row when the top-up is paid", async () => {
  blocked("needs a paid top-up: this server has no Cashfree keys (MOCK mode; its settle step is development-only and 404 in a production build). On test.gokesari.com pay a ₹1,000 top-up with a 10% code through the 'Sandbox payment' workflow, then check promotionalBalancePaise +₹100 and a voucher_redemptions row (APPLIED)");
}, local);

qa("TC-PAY-013", "voucher rules: expired, budget used up, already used by this customer, below the minimum — each refused with its own message; the top-up still works without the code", async () => {
  // A voucher cannot be created already ended (TC-FLD-114), so it is made valid and then aged.
  const expired = await createVoucher({ code: code("E") });
  await db()`update vouchers set start_date = ${istDate(-10)}::date, end_date = ${istDate(-1)}::date where id = ${expired.id}`;
  const budget = await createVoucher({ code: code("G"), totalBudgetPaise: 10_000 });
  await db()`update vouchers set budget_used_paise = total_budget_paise where id = ${budget.id}`;
  const used = await createVoucher({ code: code("U"), perCustomerLimit: 1 });
  const userId = world().users.customer!.id!;
  const walletId = (await walletOf("customer")).wallet.id;
  await db()`insert into voucher_redemptions (voucher_id, user_id, wallet_id, topup_amount_paise, bonus_percent, bonus_amount_paise, status, idempotency_key)
             values (${used.id}, ${userId}, ${walletId}, 100000, 10, 10000, 'APPLIED', ${`qa-${RUN}-used`})`;
  const min = await createVoucher({ code: code("M"), minimumTopupPaise: 50_000 });
  const out: string[] = [];
  const messages = new Set<string>();
  for (const [what, v] of [["expired", expired], ["budget used up", budget], ["already used", used], ["below ₹500 minimum", min]] as const) {
    const res = await preview(v.code, 10_000);
    expect(res.status, `${what}: ${why(res)}`).toBe(422);
    const msg = String(res.body?.error?.message ?? "");
    messages.add(msg);
    out.push(`${what} → 422 "${msg}"`);
  }
  expect(messages.size, "a specific message for each rule").toBe(4);
  const plain = await call(await as("customer"), "POST", "/api/wallet/topup", { amountPaise: 10_000 });
  expectStatus(plain, 200, "the top-up without the code");
  const withBad = await call(await as("customer"), "POST", "/api/wallet/topup", { amountPaise: 10_000, voucherCode: expired.code });
  out.push(`top-up with the expired code → ${withBad.status}; without a code → 200`);
  return out.join("; ");
}, local);

qa("TC-FLD-031", "the voucher code field: blank is fine (no bonus), an unknown code is refused clearly, lower case with spaces works the same, 100 characters and <script> are refused without a server error", async () => {
  const v = await createVoucher({ code: code("F"), bonusPercent: 5 });
  const out: string[] = [];
  const blank = await call(await as("customer"), "POST", "/api/wallet/topup", { amountPaise: 10_000, voucherCode: "" });
  expectStatus(blank, 200, "blank code");
  expect(blank.body.voucherPreview, "no bonus").toBeNull();
  out.push("blank → 200, no bonus");
  const unknown = await preview("NOSUCHQA1", 10_000);
  expect(unknown.status).toBe(422);
  expect(why(unknown)).toMatch(/not found/i);
  out.push(`unknown → 422 "${unknown.body.error.message}"`);
  const a = await preview(`  ${v.code.toLowerCase()}  `, 10_000);
  const b = await preview(v.code, 10_000);
  expect(a.status, why(a)).toBe(200);
  expect(a.body.bonusAmountPaise, "same bonus for '  lower case  ' and the exact code").toBe(b.body.bonusAmountPaise);
  out.push(`"  ${v.code.toLowerCase()}  " → 200 bonus ${a.body.bonusAmountPaise} = exact code`);
  for (const [what, text] of [["100 characters", "X".repeat(100)], ["<script>", "<script>alert(1)</script>"]] as const) {
    const res = await preview(text, 10_000);
    expect(res.status, `${what}: ${why(res)}`).toBe(422);
    out.push(`${what} → 422`);
  }
  return out.join("; ");
}, local);

qa("TC-PAY-014", "admin vouchers: create and pause on the page; the template downloads; a sheet with one good and one bad row previews both and creates only the good one; the dashboard counts follow", async ({ browser }) => {
  const name = `QA page voucher ${RUN}`;
  const pageCode = code("P");
  const before = await call(await as("admin"), "GET", "/api/vouchers/dashboard");
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/console/vouchers");
    await page.getByRole("button", { name: "Create Voucher" }).click();
    await page.getByLabel("Voucher name").fill(name);
    await page.getByLabel("Voucher code").fill(pageCode);
    await page.getByLabel("Bonus %").fill("15");
    await page.getByLabel("Valid from").fill(istDate(0));
    await page.getByLabel("Valid until").fill(istDate(20));
    await page.getByRole("button", { name: "Create voucher" }).click();
    const row = page.getByRole("row").filter({ hasText: pageCode });
    await expect(row).toBeVisible();
    await expect(row).toContainText("ACTIVE");
    await row.getByRole("button", { name: "Pause" }).click();
    await expect(row).toContainText("PAUSED");
    // The template, then a sheet with a good and a bad row.
    const template = await call(await as("admin"), "GET", "/api/voucher-uploads/template");
    expect(template.status, "template download").toBe(200);
    expect(template.headers["content-type"]).toMatch(/spreadsheet|octet-stream/);
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Vouchers");
    sheet.addRow(["Voucher Name", "Voucher Code", "Bonus %", "Min Top-Up", "Max Bonus", "Start Date", "End Date"]);
    const good = code("S1");
    const bad = code("S2");
    sheet.addRow([`QA sheet good ${RUN}`, good, 10, 100, 50, istDate(0), istDate(10)]);
    sheet.addRow([`QA sheet bad ${RUN}`, bad, 0, 100, 50, istDate(0), istDate(10)]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    await page.locator('input[type="file"]').setInputFiles({ name: `qa-vouchers-${RUN}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
    await expect(page.getByText("1 to create")).toBeVisible();
    await expect(page.getByText("1 invalid")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: bad })).toContainText(/Bonus %/);
    await page.getByRole("button", { name: "Create 1 voucher(s)" }).click();
    await expect.poll(async () => (await call(await as("admin"), "GET", `/api/vouchers?q=${good}`)).body?.vouchers?.length ?? 0).toBe(1);
    const badList = await call(await as("admin"), "GET", `/api/vouchers?q=${bad}`);
    expect(badList.body.vouchers.length, "the bad row is not created").toBe(0);
  } finally {
    await context.close();
  }
  const after = await call(await as("admin"), "GET", "/api/vouchers/dashboard");
  expect(after.body.totalVouchers, "dashboard total").toBe(before.body.totalVouchers + 2);
  const redemptions = await call(await as("admin"), "GET", "/api/vouchers/redemptions");
  expectStatus(redemptions, 200, "redemptions report");
  return `page: created ${pageCode} (ACTIVE) → Pause → PAUSED; template xlsx downloaded; sheet: 1 to create, 1 invalid ("Bonus %" message) → 1 created; dashboard total ${before.body.totalVouchers} → ${after.body.totalVouchers}; redemptions report ${redemptions.body.redemptions.length} rows`;
}, { ...local, partial: "redemptions only appear after a paid top-up (not possible here), so the redemptions report is only shown to load" });

qa("TC-PAY-015", "an order paid partly from promotional credit and cancelled gets the promotional and customer-funded parts back separately", async () => {
  const listing = await sellable("A", 3);
  const before = await arrangeWallet("customer", 300_000, 2_000); // ₹20 of voucher credit
  const order = await placeVia("customer", "WALLET", listing);
  const mid = await walletOf("customer");
  expect(mid.wallet.promotionalBalancePaise, "promotional credit spent first").toBe(Math.max(0, 2_000 - order.totalPaise));
  const res = await cancelAsCustomer("customer", order.id);
  expectStatus(res, 200, "cancel");
  const after = await walletOf("customer");
  expect(after.wallet.balancePaise, "full refund").toBe(before.wallet.balancePaise);
  expect(after.wallet.promotionalBalancePaise, "promotional part restored as promotional").toBe(2_000);
  const refund = after.transactions.find((t) => t.type === "REFUND" && t.orderId === order.id);
  expect(refund?.promotionalAmountPaise, "the refund row's promotional slice").toBe(Math.min(2_000, order.totalPaise));
  return `₹${order.totalPaise / 100} order from ₹20 promo + ₹${(order.totalPaise - Math.min(2000, order.totalPaise)) / 100} own money → cancel → promo ${mid.wallet.promotionalBalancePaise} → ${after.wallet.promotionalBalancePaise}, balance back to ${after.wallet.balancePaise}`;
}, { ...local, partial: "the promotional balance is set on the local wallet (a voucher bonus needs a paid top-up)" });
