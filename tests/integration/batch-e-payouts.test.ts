/**
 * batch-2026-10 WS-E — F10.2.4 (GAP-005) automated shop payouts: cycles every
 * N days, net payable maths (commission, GST on fees, TCS, TDS, refunds,
 * adjustments, wallet), verified-bank-only transfers, maker-checker, sandbox
 * transfers with UTRs, failures and retries, webhooks (signature, duplicate
 * events), the bank file, mark-paid with UTR, statements, and flags off.
 * Real PostgreSQL; the sandbox provider; emails captured.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

vi.mock("@/server/email/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email/transport")>();
  return { ...actual, emailMode: () => "smtp" as const, sendEmail: vi.fn(async () => {}) };
});
const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { PATCH as batchRoute } from "@/app/api/admin/payouts/batches/[id]/route";
import { PATCH as itemRoute } from "@/app/api/admin/payouts/items/[id]/route";
import { POST as financeWeeklyCron } from "@/app/api/cron/finance-weekly/route";
import { POST as payoutCycleCron } from "@/app/api/cron/payout-cycle/route";
import { GET as statementRoute } from "@/app/api/payouts/statements/[id]/route";
import { POST as webhookRoute } from "@/app/api/webhooks/payouts/[provider]/route";
import { db } from "@/server/db";
import {
  bankAccounts,
  documentEmails,
  financeLedgerEntries,
  financialAdjustments,
  notifications,
  payoutBatches,
  payoutCycleLines,
  payoutEvents,
  payoutItems,
  users,
} from "@/server/db/schema";
import {
  approvePayoutBatch,
  executePayoutBatch,
  exportBankFile,
  markPayoutItemPaid,
  retryFailedPayouts,
  BANK_FILE_COLUMNS,
} from "@/server/payouts/batches";
import { closePayoutCycle } from "@/server/payouts/cycle";
import { buildSandboxWebhook } from "@/server/payouts/providers/sandbox";
import { renderPayoutStatement } from "@/server/payouts/statements";
import { prepareShopSettlements, previousWeekStart, recordAdjustment, refundDeliveredOrder, setCommissionRate } from "@/server/services/finance";
import { applyShopWalletEntry, getShopWalletBalance } from "@/server/services/shop-wallet";
import { NextRequest } from "next/server";
import { call } from "../helpers/http";
import { addDaysIso, deliveredOrder, gstShop, GOKESARI_GSTIN, IST_TODAY, resetBatchE, rules, verifiedBank } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };
let checker = { id: "", role: "ADMIN" as const };
const today = IST_TODAY();
const anchor = addDaysIso(today, -10);

function sessionFor(user: { id: string; role: UserRole }) {
  state.session = { user: { id: user.id, email: `${user.id}@test.local`, name: null, image: null, role: user.role, status: "ACTIVE" } };
}

async function payoutRules(extra: Record<string, unknown> = {}, more: Record<string, Record<string, unknown>> = {}) {
  await rules(admin, {
    invoicing: { enabled: true },
    payouts: { enabled: true, anchorDate: anchor, cycleDays: 5, holdDays: 0, provider: "SANDBOX", minPayoutPaise: 100, ...extra },
    ...more,
  });
}

const PLATFORM_PROFILE = {
  legalName: "GoKesari Technologies Pvt Ltd",
  tradeName: "GoKesari",
  gstin: GOKESARI_GSTIN,
  pan: "AABCG1234K",
  address: "1 MG Road, Bengaluru 560001",
  stateCode: "KA",
};

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  state.session = null;
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  checker = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setCommissionRate({ scope: "DEFAULT", rateBp: 1000 }, admin);
  await payoutRules();
});

afterAll(async () => {
  await resetBatchE();
});

/** A shop with a verified account and one delivered order of `qty` litres (₹105 each) three days ago. */
async function shopWithSale(qty = 4, options: Parameters<typeof gstShop>[0] & { bank?: "VERIFIED" | "PENDING" | "NONE"; method?: "BANK_ACCOUNT" | "UPI" } = {}) {
  const s = await gstShop(options);
  if (options.bank !== "NONE") await verifiedBank(s.owner.id, s.shop.id, options.bank ?? "VERIFIED", options.method ?? "BANK_ACCOUNT");
  const sale = await deliveredOrder(admin, [[s.milkSp.id, qty]], { deliveredDaysAgo: 3 });
  return { ...s, ...sale };
}

async function backdateAdjustments() {
  await db.update(financialAdjustments).set({ createdAt: sql`now() - interval '2 days'` });
}

async function linesOf(shopId: string) {
  return db.select().from(payoutCycleLines).where(eq(payoutCycleLines.shopId, shopId));
}

describe("cycles", () => {
  it("TC-B26-E-021 closes every 5 days by default (configurable), once per cycle", async () => {
    const { shop } = await shopWithSale();
    const result = await closePayoutCycle({ today, actor: admin });
    expect(result!.created).toBe(true);
    expect(result!.cycle).toMatchObject({ cycleStart: addDaysIso(today, -5), cycleEnd: today, cycleDays: 5, status: "BATCHED" });
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].shopId).toBe(shop.id);
    // Idempotent: the same cycle again changes nothing.
    const again = await closePayoutCycle({ today, actor: admin });
    expect(again!.created).toBe(false);
    expect(again!.cycle.id).toBe(result!.cycle.id);
    expect(await db.select().from(payoutBatches)).toHaveLength(1);
    // A 7-day cycle from the same anchor has no complete cycle until day 7, then closes [anchor, anchor+7).
    await payoutRules({ cycleDays: 7, anchorDate: addDaysIso(today, -7) });
    const weekly = await closePayoutCycle({ today, actor: admin });
    expect(weekly!.cycle).toMatchObject({ cycleStart: addDaysIso(today, -7), cycleEnd: today, cycleDays: 7 });
    // The order was already paid in the first cycle: it is never counted twice.
    expect(weekly!.items).toHaveLength(0);
  });
});

describe("net payable maths", () => {
  it("TC-B26-E-022 goods − commission − GST on fees − TCS − TDS − refunds ± adjustments, every component itemised", async () => {
    await payoutRules({}, { platformInvoicing: { enabled: true }, platformTaxProfile: PLATFORM_PROFILE });
    const { shop, order } = await shopWithSale(4); // 4 × ₹105 = ₹420 goods, taxable ₹400 at 5%
    await refundDeliveredOrder({ orderNumber: order.orderNumber, amountPaise: 10_500, reason: "One bottle spoiled", chargeTo: "SHOP", requestId: "r-1", creditNote: { reason: "RETURN", restock: false } }, admin);
    await recordAdjustment({ type: "SHOP_ADJUSTMENT", shopId: shop.id, amountPaise: 500, reason: "Packaging bonus", requestId: "adj-1" }, admin);
    await backdateAdjustments();

    const result = await closePayoutCycle({ today, actor: admin });
    const lines = await linesOf(shop.id);
    const sum = (type: string) => lines.filter((l) => l.lineType === type).reduce((s, l) => s + l.amountPaise, 0);
    expect(sum("GOODS")).toBe(42_000);
    expect(sum("COMMISSION")).toBe(-4_200);
    // GST on GoKesari's commission (KA → MH: IGST 18%) − GST credited back on the refunded goods' commission.
    expect(sum("FEE_GST")).toBe(-756 + 189);
    // TCS 0.5% on ₹400 taxable, reversed on the ₹100 returned; TDS 0.1% likewise.
    expect(sum("TCS")).toBe(-200 + 50);
    expect(sum("TDS")).toBe(-40 + 10);
    expect(sum("REFUND")).toBe(-9_450);
    expect(sum("ADJUSTMENT")).toBe(500);
    const item = result!.items.find((i) => i.shopId === shop.id)!;
    expect(item.amountPaise).toBe(42_000 - 4_200 - 567 - 150 - 30 - 9_450 + 500);
    expect(item.amountPaise).toBe(lines.reduce((s, l) => s + l.amountPaise, 0));
    expect(item.breakdown).toMatchObject({ GOODS: 42_000, COMMISSION: -4_200, TCS: -150, TDS: -30, REFUND: -9_450, ADJUSTMENT: 500 });
    const tcs = lines.find((l) => l.lineType === "TCS" && l.sourceType === "order_financials")!;
    expect(tcs).toMatchObject({ basePaise: 40_000, rateBp: 50 });
    expect(tcs.meta).toMatchObject({ cgst: 100, sgst: 100, igst: 0 });
    // The refund and adjustment are settled by the cycle (the weekly batch won't take them).
    expect((await db.select().from(financialAdjustments)).every((a) => a.status === "SETTLED")).toBe(true);
  });

  it("TC-B26-E-023 commission paid from the shop wallet is not deducted again; the wallet is topped up from the payout", async () => {
    await payoutRules({ walletTopUpTargetPaise: 96_800 }, { shopWallet: { enabled: true } });
    const s = await gstShop();
    await verifiedBank(s.owner.id, s.shop.id);
    await applyShopWalletEntry({ shopId: s.shop.id, type: "MANUAL_CREDIT", amountPaise: 100_000, reason: "Opening balance", idempotencyKey: "open-1" });
    await deliveredOrder(admin, [[s.milkSp.id, 4]], { deliveredDaysAgo: 3 });
    expect(await getShopWalletBalance(s.shop.id)).toBe(95_800); // ₹42 commission debited at delivery

    const result = await closePayoutCycle({ today, actor: admin });
    const lines = await linesOf(s.shop.id);
    const commission = lines.find((l) => l.lineType === "COMMISSION")!;
    expect(commission.amountPaise).toBe(0);
    expect(commission.meta).toMatchObject({ collectedVia: "SHOP_WALLET", commissionPaise: 4_200 });
    expect(lines.find((l) => l.lineType === "WALLET_TOPUP")!.amountPaise).toBe(-1_000);
    const item = result!.items[0];
    expect(item.amountPaise).toBe(42_000 - 200 - 40 - 1_000);

    await approvePayoutBatch(result!.batch!.id, checker);
    await executePayoutBatch(result!.batch!.id, admin);
    expect(await getShopWalletBalance(s.shop.id)).toBe(96_800);
  });
});

describe("who is paid", () => {
  it("TC-B26-E-024 a shop without a verified bank account is held (not paid, not in the file) and carried into the next cycle", async () => {
    const verified = await shopWithSale(2, { name: "Verified Dairy" });
    const pending = await shopWithSale(3, { name: "Pending Dairy", bank: "PENDING", gstin: null });
    const result = await closePayoutCycle({ today, actor: admin });
    const held = result!.items.find((i) => i.shopId === pending.shop.id)!;
    expect(held).toMatchObject({ status: "ON_HOLD", holdReason: "BANK_NOT_VERIFIED" });
    expect(result!.batch!.itemCount).toBe(1);
    const ownerNote = await db.select().from(notifications).where(and(eq(notifications.userId, pending.owner.id), eq(notifications.type, "shop.payout_held")));
    expect(ownerNote).toHaveLength(1);

    await payoutRules({ provider: "BANK_FILE" });
    await approvePayoutBatch(result!.batch!.id, checker);
    const file = await exportBankFile(result!.batch!.id, admin);
    expect(file.rows).toBe(1);
    expect(file.csv).not.toContain(pending.shop.id);

    // Verified later: the held amount is paid with the next cycle.
    await db.update(bankAccounts).set({ status: "VERIFIED" }).where(eq(bankAccounts.shopId, pending.shop.id));
    const next = await closePayoutCycle({ today: addDaysIso(today, 5), actor: admin });
    const carried = next!.items.find((i) => i.shopId === pending.shop.id)!;
    expect(carried.status).toBe("PENDING");
    expect(carried.amountPaise).toBe(held.amountPaise);
    expect((await db.select().from(payoutItems).where(eq(payoutItems.id, held.id)))[0].status).toBe("CARRIED_FORWARD");
    expect(verified.shop.id).toBeTruthy();
  });

  it("TC-B26-E-025 maker-checker: the batch's creator cannot approve it; another admin can; a shop owner cannot", async () => {
    const { owner } = await shopWithSale();
    const result = await closePayoutCycle({ today, actor: admin });
    const batchId = result!.batch!.id;
    await expect(approvePayoutBatch(batchId, admin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    sessionFor(owner);
    expect((await call(batchRoute, `/api/admin/payouts/batches/${batchId}`, { method: "PATCH", body: { action: "approve" }, params: { id: batchId } })).status).toBe(403);
    sessionFor(admin);
    expect((await call(batchRoute, `/api/admin/payouts/batches/${batchId}`, { method: "PATCH", body: { action: "approve" }, params: { id: batchId } })).status).toBe(403);
    sessionFor(checker);
    const ok = await call(batchRoute, `/api/admin/payouts/batches/${batchId}`, { method: "PATCH", body: { action: "approve" }, params: { id: batchId } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "APPROVED", approvedBy: checker.id });
    // With maker-checker off the creator may approve.
    await payoutRules({ makerChecker: false });
    const next = await (async () => {
      await deliveredOrder(admin, [[(await gstShop({ name: "Second" })).milkSp.id, 1]], { deliveredDaysAgo: 1 });
      return closePayoutCycle({ today: addDaysIso(today, 5), actor: admin });
    })();
    if (next?.batch) expect((await approvePayoutBatch(next.batch.id, admin)).status).toBe("APPROVED");
  });
});

describe("transfers", () => {
  it("TC-B26-E-026 sandbox transfer: paid with a UTR through the signed webhook; journal, statement and the owner told", async () => {
    const { shop, owner } = await shopWithSale();
    const result = await closePayoutCycle({ today, actor: admin });
    await approvePayoutBatch(result!.batch!.id, checker);
    const { batch, items } = await executePayoutBatch(result!.batch!.id, admin);
    expect(batch.status).toBe("COMPLETED");
    expect(items[0]).toMatchObject({ status: "PAID", provider: "SANDBOX", attempts: 1 });
    expect(items[0].utr).toMatch(/^SBXN\d{12}$/);
    const ledger = await db.select().from(financeLedgerEntries).where(and(eq(financeLedgerEntries.sourceType, "payout_items"), eq(financeLedgerEntries.sourceId, items[0].id)));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ entryType: "SHOP_SETTLEMENT", direction: "DEBIT", amountPaise: items[0].amountPaise, reference: items[0].utr });
    expect(await db.select().from(payoutEvents).where(and(eq(payoutEvents.itemId, items[0].id), eq(payoutEvents.type, "WEBHOOK_SUCCESS")))).toHaveLength(1);
    const statementMail = await db.select().from(documentEmails).where(and(eq(documentEmails.docType, "PAYOUT_STATEMENT"), eq(documentEmails.docId, items[0].id)));
    expect(statementMail).toHaveLength(1);
    expect(statementMail[0].userId).toBe(owner.id);
    const paidNote = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.payout_paid")));
    expect(paidNote[0].body).toContain(items[0].utr!);
    expect(shop.id).toBe(items[0].shopId);
  });

  it("TC-B26-E-027 a failed transfer is retried after its backoff and paid; one that keeps failing is given up and finance alerted", async () => {
    await payoutRules({ retryMaxAttempts: 2, retryBackoffMinutes: 30 });
    const a = await shopWithSale(2, { name: "Retry Dairy" });
    const b = await shopWithSale(2, { name: "Broken Bank Dairy" });
    const result = await closePayoutCycle({ today, actor: admin });
    // Sandbox: …99 paise fails once, …98 always fails.
    await db.update(payoutItems).set({ amountPaise: 20_099 }).where(eq(payoutItems.shopId, a.shop.id));
    await db.update(payoutItems).set({ amountPaise: 20_098 }).where(eq(payoutItems.shopId, b.shop.id));
    await approvePayoutBatch(result!.batch!.id, checker);
    const executed = await executePayoutBatch(result!.batch!.id, admin);
    const batch = executed.batch;
    let items = executed.items;
    const first = items.find((i) => i.shopId === a.shop.id)!;
    expect(first).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(first.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(batch.status).toBe("PROCESSING");
    // Not yet due: nothing happens.
    expect(await retryFailedPayouts({ actor: { id: null, role: null } })).toBe(0);
    expect(await retryFailedPayouts({ actor: { id: null, role: null }, now: new Date(Date.now() + 31 * 60_000) })).toBe(2);
    ({ items } = await (await import("@/server/payouts/batches")).getPayoutBatch(result!.batch!.id));
    expect(items.find((i) => i.shopId === a.shop.id)).toMatchObject({ status: "PAID", attempts: 2 });
    const broken = items.find((i) => i.shopId === b.shop.id)!;
    expect(broken).toMatchObject({ status: "FAILED", attempts: 2, nextAttemptAt: null });
    const [finalBatch] = await db.select().from(payoutBatches).where(eq(payoutBatches.id, result!.batch!.id));
    expect(finalBatch.status).toBe("PARTIAL");
    const alerts = await db.select().from(notifications).where(eq(notifications.type, "support.payout_failed"));
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(batch.id).toBe(finalBatch.id);
  });

  it("TC-B26-E-028 webhooks: a bad signature is refused; a redelivered event is acknowledged once and changes nothing", async () => {
    await payoutRules({ sandboxAutoWebhook: false });
    await shopWithSale();
    const result = await closePayoutCycle({ today, actor: admin });
    await approvePayoutBatch(result!.batch!.id, checker);
    const { items } = await executePayoutBatch(result!.batch!.id, admin);
    expect(items[0].status).toBe("PROCESSING");
    const hook = buildSandboxWebhook(items[0].providerRef!, { referenceId: items[0].id, amountPaise: items[0].amountPaise, attempt: 1 });
    const post = (body: string, headers: Headers) =>
      webhookRoute(new NextRequest("http://localhost/api/webhooks/payouts/sandbox", { method: "POST", body, headers }), { params: Promise.resolve({ provider: "sandbox" }) });

    const forged = new Headers(hook.headers);
    forged.set("x-sandbox-signature", "0".repeat(64));
    expect((await post(hook.rawBody, forged)).status).toBe(401);
    expect((await post(hook.rawBody.replace("processed", "processed "), hook.headers)).status).toBe(401);

    const firstResponse = await post(hook.rawBody, hook.headers);
    expect(firstResponse.status).toBe(200);
    const again = await post(hook.rawBody, hook.headers);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
    const [paid] = await db.select().from(payoutItems).where(eq(payoutItems.id, items[0].id));
    expect(paid.status).toBe("PAID");
    expect(await db.select().from(financeLedgerEntries).where(eq(financeLedgerEntries.sourceId, items[0].id))).toHaveLength(1);
    // An unknown provider is not found.
    const unknown = await webhookRoute(new NextRequest("http://localhost/api/webhooks/payouts/paypal", { method: "POST", body: "{}" }), { params: Promise.resolve({ provider: "paypal" }) });
    expect(unknown.status).toBe(404);
    // RazorpayX without keys: not configured.
    const rzp = await webhookRoute(new NextRequest("http://localhost/api/webhooks/payouts/razorpayx", { method: "POST", body: "{}" }), { params: Promise.resolve({ provider: "razorpayx" }) });
    expect(rzp.status).toBe(503);
  });
});

describe("until live keys exist: bank file and mark paid", () => {
  it("TC-B26-E-029 the bank file lists verified bank accounts in the generic NEFT/RTGS layout; UPI accounts are skipped", async () => {
    await payoutRules({ provider: "BANK_FILE", debitAccountNumber: "50200012345678" });
    const bankShop = await shopWithSale(4, { name: "Bank Dairy" });
    const upiShop = await shopWithSale(2, { name: "Upi Dairy", method: "UPI" });
    const result = await closePayoutCycle({ today, actor: admin });
    await expect(exportBankFile(result!.batch!.id, admin)).rejects.toMatchObject({ code: "CONFLICT" }); // not approved yet
    await approvePayoutBatch(result!.batch!.id, checker);
    await expect(executePayoutBatch(result!.batch!.id, admin)).rejects.toMatchObject({ code: "CONFLICT" });
    const file = await exportBankFile(result!.batch!.id, admin);
    const [header, row, ...rest] = file.csv.trim().split("\n");
    expect(header).toBe(BANK_FILE_COLUMNS.join(","));
    expect(rest).toHaveLength(0);
    const cells = row.split(",");
    const item = result!.items.find((i) => i.shopId === bankShop.shop.id)!;
    expect(cells[1]).toBe("NEFT");
    expect(cells[2]).toBe((item.amountPaise / 100).toFixed(2));
    expect(cells[3]).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(cells[4]).toBe("50200012345678");
    expect(cells[6]).toBe("123456789012");
    expect(cells[7]).toBe("HDFC0001234");
    expect(cells[10]).toBe(item.id);
    expect(file.skipped).toHaveLength(1);
    expect(file.skipped[0].reason).toContain("UPI");
    const [after] = await db.select().from(payoutItems).where(eq(payoutItems.id, item.id));
    expect(after).toMatchObject({ status: "PROCESSING", provider: "BANK_FILE" });
    expect(upiShop.shop.id).toBeTruthy();
  });

  it("TC-B26-E-030 'mark as paid with UTR': UTR required and unique; paid items complete the batch; only finance may do it", async () => {
    await payoutRules({ provider: "BANK_FILE" });
    const one = await shopWithSale(2, { name: "One" });
    const two = await shopWithSale(3, { name: "Two" });
    const result = await closePayoutCycle({ today, actor: admin });
    await approvePayoutBatch(result!.batch!.id, checker);
    await exportBankFile(result!.batch!.id, admin);
    const itemOne = result!.items.find((i) => i.shopId === one.shop.id)!;
    const itemTwo = result!.items.find((i) => i.shopId === two.shop.id)!;
    await expect(markPayoutItemPaid(itemOne.id, "12", admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    sessionFor(one.owner);
    expect((await call(itemRoute, `/api/admin/payouts/items/${itemOne.id}`, { method: "PATCH", body: { action: "mark_paid", utr: "HDFCN5202610181234" }, params: { id: itemOne.id } })).status).toBe(403);
    sessionFor(admin);
    const paid = await call(itemRoute, `/api/admin/payouts/items/${itemOne.id}`, { method: "PATCH", body: { action: "mark_paid", utr: "hdfcn5202610181234" }, params: { id: itemOne.id } });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "PAID", utr: "HDFCN5202610181234", markedBy: admin.id });
    await expect(markPayoutItemPaid(itemTwo.id, "HDFCN5202610181234", admin)).rejects.toMatchObject({ code: "CONFLICT" });
    // The same UTR again on the same item is a harmless repeat.
    expect((await markPayoutItemPaid(itemOne.id, "HDFCN5202610181234", admin)).status).toBe("PAID");
    const failed = await call(itemRoute, `/api/admin/payouts/items/${itemTwo.id}`, { method: "PATCH", body: { action: "mark_failed", reason: "Account closed" }, params: { id: itemTwo.id } });
    expect(failed.body).toMatchObject({ status: "FAILED", failureReason: "Account closed", nextAttemptAt: null });
    await markPayoutItemPaid(itemTwo.id, "HDFCN5202610189999", admin);
    const [batch] = await db.select().from(payoutBatches).where(eq(payoutBatches.id, result!.batch!.id));
    expect(batch.status).toBe("COMPLETED");
  });

  it("TC-B26-E-031 the settlement statement (PDF and CSV) itemises the payout; only the shop's owner and finance can download it", async () => {
    const { owner, shop } = await shopWithSale();
    const result = await closePayoutCycle({ today, actor: admin });
    await approvePayoutBatch(result!.batch!.id, checker);
    const { items } = await executePayoutBatch(result!.batch!.id, admin);
    const doc = (await renderPayoutStatement(items[0].id))!;
    expect(doc.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(doc.pdf.toString("latin1")).toContain("GOKESARI PAYOUT STATEMENT");
    expect(doc.csv).toContain(`utr,${items[0].utr}`);
    expect(doc.csv).toContain(`net_payout_inr,${(items[0].amountPaise / 100).toFixed(2)}`);
    expect(doc.csv).toMatch(/,GOODS,Order /);
    expect(doc.csv).toMatch(/,TCS,/);

    sessionFor(owner);
    const pdf = await statementRoute(new NextRequest(`http://localhost/api/payouts/statements/${items[0].id}`), { params: Promise.resolve({ id: items[0].id }) });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const csv = await statementRoute(new NextRequest(`http://localhost/api/payouts/statements/${items[0].id}?format=csv`), { params: Promise.resolve({ id: items[0].id }) });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const stranger = await createUser({ role: "SHOP_OWNER" });
    sessionFor(stranger);
    expect((await statementRoute(new NextRequest(`http://localhost/api/payouts/statements/${items[0].id}`), { params: Promise.resolve({ id: items[0].id }) })).status).toBe(404);
    expect(shop.id).toBe(items[0].shopId);
  });
});

describe("flags off", () => {
  it("TC-B26-E-032 with payouts off nothing runs and the weekly settlement is unchanged; with it on, the weekly job leaves shops to the payout cycle", async () => {
    await rules(admin, { invoicing: { enabled: true }, payouts: { enabled: false } });
    const { shop } = await shopWithSale();
    await expect(closePayoutCycle({ today, actor: admin })).rejects.toMatchObject({ code: "CONFLICT" });
    const cronHeaders = { authorization: `Bearer ${process.env.CRON_SECRET}` };
    const skipped = await payoutCycleCron(new NextRequest("http://localhost/api/cron/payout-cycle", { method: "POST", headers: cronHeaders }));
    expect(await skipped.json()).toMatchObject({ skipped: expect.stringContaining("off") });
    expect(await db.select().from(payoutBatches)).toHaveLength(0);
    // The weekly settlement works as before (the order is older than the hold).
    await db.execute(sql`UPDATE order_financials SET delivered_at = now() - interval '9 days'`);
    const settlements = await prepareShopSettlements(previousWeekStart(), { id: admin.id, role: "ADMIN" });
    expect(settlements.map((s) => s.shopId)).toContain(shop.id);

    await payoutRules();
    await expect(prepareShopSettlements(previousWeekStart(), { id: admin.id, role: "ADMIN" })).rejects.toMatchObject({ code: "CONFLICT" });
    const weekly = await financeWeeklyCron(new NextRequest("http://localhost/api/cron/finance-weekly", { method: "POST", headers: cronHeaders }));
    expect(await weekly.json()).toMatchObject({ settlements: 0, shopSettlements: "payout-cycle" });
    // Orders already in a weekly settlement are never paid again by a cycle.
    const cycle = await closePayoutCycle({ today, actor: admin });
    expect(cycle!.items).toHaveLength(0);
    expect((await db.select().from(users).where(eq(users.id, admin.id))).length).toBe(1);
  });
});
