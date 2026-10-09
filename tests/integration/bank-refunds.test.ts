/**
 * Refunds to a customer's bank (docs/four-features-2026-10, decided by the
 * owner on 9 Oct 2026; rule bankRefunds).
 *
 * A refund lands in the wallet as before; the customer can have it sent to
 * their verified bank account instead (customer-funded money only, within the
 * window). The amount leaves the wallet at once; finance sends it, records the
 * bank's reference, or marks it failed and it returns to the wallet. The
 * customer can cancel until finance starts. Finance sees the full account
 * only through an audited look-up.
 */
import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async () => {},
  EmailUnavailableError: class extends Error {},
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { PUT as myAccountPut } from "@/app/api/bank-account/route";
import { POST as startRoute } from "@/app/api/bank-account/verification/route";
import { POST as simulateRoute } from "@/app/api/bank-account/verification/simulate/route";
import { GET as refundsGet, POST as refundsPost } from "@/app/api/bank-refunds/route";
import { POST as cancelRoute } from "@/app/api/bank-refunds/[id]/cancel/route";
import { GET as adminList } from "@/app/api/admin/bank-refunds/route";
import { POST as adminDecide } from "@/app/api/admin/bank-refunds/[id]/route";
import { GET as adminAccount } from "@/app/api/admin/bank-refunds/[id]/account/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { auditLogs, bankRefundRequests, notifications, platformSettings, walletTransactions, wallets } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { cancelOrder, checkout } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { applyWalletMutation } from "@/server/services/wallet";
import { call } from "../helpers/http";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

let admin = { id: "", email: "", name: null as string | null };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["bankAccounts", "bankRefunds"]));
  clearRuleCache();
  resetRateLimits();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name };
  await setRule("bankAccounts", { enabled: true }, { id: a.id, role: "ADMIN" });
  await setRule("bankRefunds", { enabled: true }, { id: a.id, role: "ADMIN" });
});

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

const BANK = { method: "BANK_ACCOUNT", accountHolderName: "Asha Patil", accountNumber: "123456789012", confirmAccountNumber: "123456789012", ifsc: "SBIN0001234" };

async function verifiedAccount() {
  const saved = await call(myAccountPut, "/api/bank-account", { method: "PUT", body: BANK });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const started = await call(startRoute, "/api/bank-account/verification", { method: "POST", body: { accountId: saved.body.id } });
  const done = await call(simulateRoute, "/api/bank-account/verification/simulate", {
    method: "POST",
    body: { gatewayOrderId: started.body.gatewayOrderId, method: "UPI", outcome: "SUCCESS" },
  });
  expect(done.body.status).toBe("VERIFIED");
}

/** A customer with a wallet, a cancelled ₹105 order (refunded to the wallet) and the refund's wallet row. */
async function refundedCustomer() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { name: "Dairy One" });
  const sp = await createShopProduct(shop.id, product.id, { onlinePricePaise: 10_500, onlineStock: 50 });
  const { user } = await createUserWithWallet({ balancePaise: 50_000 });
  await addToCart(user.id, sp.id, 1);
  const { orders: placed } = await checkout({ userId: user.id, addressId: await deliveryAddressId(user.id), requestId: `r-${Math.random()}`, paymentMethod: "WALLET" });
  await cancelOrder(placed[0].id, { id: owner.id, role: "SHOP_OWNER" }, "Out of stock");
  const [refund] = await db
    .select()
    .from(walletTransactions)
    .where(and(eq(walletTransactions.userId, user.id), eq(walletTransactions.type, "REFUND")));
  return { customer: user, order: placed[0], refund };
}

const balance = async (userId: string) => (await db.select().from(wallets).where(eq(wallets.userId, userId)))[0].balancePaise;

async function ask(refundTransactionId: string) {
  return call(refundsPost, "/api/bank-refunds", { method: "POST", body: { refundTransactionId } });
}

async function decide(id: string, body: Record<string, unknown>) {
  return call(adminDecide, `/api/admin/bank-refunds/${id}`, { method: "POST", body, params: { id } });
}

describe("refunds to the customer's bank", () => {
  it("a verified customer sends a refund to the bank; finance sees the account, sends it and records the reference", async () => {
    const { customer, order, refund } = await refundedCustomer();
    signIn(customer, "CUSTOMER");
    await verifiedAccount();
    const before = await balance(customer.id);

    const list = await call(refundsGet, "/api/bank-refunds");
    expect(list.status).toBe(200);
    expect(list.body.account).toMatchObject({ label: "SBIN0001234 ••••9012", status: "VERIFIED", usable: true });
    expect(list.body.candidates).toHaveLength(1);
    expect(list.body.candidates[0]).toMatchObject({ refundTransactionId: refund.id, orderNumber: order.orderNumber, refundPaise: refund.amountPaise, sendablePaise: refund.amountPaise });

    const asked = await ask(refund.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ status: "REQUESTED", amountPaise: refund.amountPaise, accountLabel: "SBIN0001234 ••••9012" });
    expect(await balance(customer.id)).toBe(before - refund.amountPaise);
    // Asking again changes nothing.
    expect((await ask(refund.id)).body.id).toBe(asked.body.id);
    expect(await balance(customer.id)).toBe(before - refund.amountPaise);
    expect((await call(refundsGet, "/api/bank-refunds")).body.candidates).toHaveLength(0);
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, customer.id), eq(notifications.type, "wallet.bank_refund_requested")))).toHaveLength(1);
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, admin.id), eq(notifications.type, "support.bank_refund_requested")))).toHaveLength(1);

    // The customer cannot see the finance queue or decide.
    expect((await call(adminList, "/api/admin/bank-refunds")).status).toBe(403);
    expect((await decide(asked.body.id, { action: "pay", reference: "UTR12345" })).status).toBe(403);

    signIn(admin, "ADMIN");
    const queue = await call(adminList, "/api/admin/bank-refunds?status=REQUESTED");
    expect(queue.body.refunds).toHaveLength(1);
    expect(JSON.stringify(queue.body)).not.toContain("123456789012");
    const details = await call(adminAccount, `/api/admin/bank-refunds/${asked.body.id}/account`, { params: { id: asked.body.id } });
    expect(details.body).toMatchObject({ method: "BANK_ACCOUNT", accountHolderName: "Asha Patil", accountNumber: "123456789012", ifsc: "SBIN0001234" });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "bank_refund.details_viewed"))).toHaveLength(1);

    expect((await decide(asked.body.id, { action: "process" })).body.status).toBe("PROCESSING");
    expect((await decide(asked.body.id, { action: "pay", reference: "  " })).status).toBe(422);
    const paid = await decide(asked.body.id, { action: "pay", reference: "UTR12345678" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body).toMatchObject({ status: "PAID", payoutReference: "UTR12345678" });
    // Repeated: answered with what was done; then nothing else can change it.
    expect((await decide(asked.body.id, { action: "pay", reference: "UTR12345678" })).status).toBe(200);
    expect((await decide(asked.body.id, { action: "fail", reason: "Too late" })).status).toBe(409);
    expect(await balance(customer.id)).toBe(before - refund.amountPaise);
    // Once paid, the full number is no longer shown.
    expect((await call(adminAccount, `/api/admin/bank-refunds/${asked.body.id}/account`, { params: { id: asked.body.id } })).status).toBe(409);
    const [note] = await db.select().from(notifications).where(and(eq(notifications.userId, customer.id), eq(notifications.type, "wallet.bank_refund_paid")));
    expect(note.body).toContain("UTR12345678");
  });

  it("a failed transfer and a cancelled request both put the amount back in the wallet, which can then be sent again", async () => {
    const { customer, refund } = await refundedCustomer();
    signIn(customer, "CUSTOMER");
    await verifiedAccount();
    const before = await balance(customer.id);

    const asked = await ask(refund.id);
    signIn(admin, "ADMIN");
    const failed = await decide(asked.body.id, { action: "fail", reason: "Account closed" });
    expect(failed.body).toMatchObject({ status: "FAILED", failureReason: "Account closed" });
    expect(await balance(customer.id)).toBe(before);
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, customer.id), eq(notifications.type, "wallet.bank_refund_returned")))).toHaveLength(1);

    // The money came back as a new refund: it can be sent again, and cancelled before finance starts.
    signIn(customer, "CUSTOMER");
    const list = await call(refundsGet, "/api/bank-refunds");
    expect(list.body.candidates).toHaveLength(1);
    expect((await ask(refund.id)).status).toBe(409); // the original refund is used up
    const again = await ask(list.body.candidates[0].refundTransactionId);
    expect(again.status).toBe(201);
    expect(await balance(customer.id)).toBe(before - refund.amountPaise);
    const cancelled = await call(cancelRoute, `/api/bank-refunds/${again.body.id}/cancel`, { method: "POST", params: { id: again.body.id } });
    expect(cancelled.body.status).toBe("CANCELLED");
    expect(await balance(customer.id)).toBe(before);
    const rows = await db.select().from(bankRefundRequests).where(eq(bankRefundRequests.userId, customer.id));
    expect(rows.map((r) => r.status).sort()).toEqual(["CANCELLED", "FAILED"]);
  });

  it("only refunds still in the wallet, never promotional credit, within the window, to a verified account", async () => {
    const { customer, refund } = await refundedCustomer();
    signIn(customer, "CUSTOMER");

    // No verified account yet: shown, but refused.
    const none = await call(refundsGet, "/api/bank-refunds");
    expect(none.body.account).toBeNull();
    expect((await ask(refund.id)).status).toBe(409);
    await verifiedAccount();

    // Spend most of the wallet: only what is left of the refund can go.
    const left = 2_000;
    await applyWalletMutation({ userId: customer.id, amountPaise: (await balance(customer.id)) - left, type: "MANUAL_DEBIT", idempotencyKey: `spend-${customer.id}`, description: "Spent" });
    expect((await call(refundsGet, "/api/bank-refunds")).body.candidates[0].sendablePaise).toBe(left);
    const partial = await ask(refund.id);
    expect(partial.body.amountPaise).toBe(left);
    expect(await balance(customer.id)).toBe(0);

    // A promotional refund is not offered.
    await applyWalletMutation({ userId: customer.id, amountPaise: 3_000, type: "REFUND", promotionalAmountPaise: 3_000, idempotencyKey: `promo-${customer.id}`, description: "Promotional refund" });
    expect((await call(refundsGet, "/api/bank-refunds")).body.candidates).toHaveLength(0);

    // Older than the window: not offered, and refused.
    const old = await applyWalletMutation({ userId: customer.id, amountPaise: 4_000, type: "REFUND", idempotencyKey: `old-${customer.id}`, description: "Old refund" });
    await db.update(walletTransactions).set({ createdAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(walletTransactions.id, old.transaction.id));
    expect((await call(refundsGet, "/api/bank-refunds")).body.candidates).toHaveLength(0);
    expect((await ask(old.transaction.id)).status).toBe(409);
  });

  it("switched off (default): nothing is offered and nothing can be asked", async () => {
    await db.delete(platformSettings).where(eq(platformSettings.key, "bankRefunds"));
    clearRuleCache();
    const { customer, refund } = await refundedCustomer();
    signIn(customer, "CUSTOMER");
    expect((await call(refundsGet, "/api/bank-refunds")).status).toBe(409);
    expect((await ask(refund.id)).status).toBe(409);
  });
});
