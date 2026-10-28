/**
 * Dealer programme step 7 (docs/dealer-programme, GKS-SP-001): paid support
 * services — general support (free), product upload and price update at
 * admin-set charges; pay from the shop wallet or online; each paid request
 * opens a help-desk ticket; cancel before work starts for a refund.
 * Scenarios 57–67 of the build prompt.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { POST as adminPost } from "@/app/api/admin/support-services/route";
import { POST as payPost } from "@/app/api/support-services/[id]/pay/route";
import { GET as quoteGet } from "@/app/api/support-services/quote/route";
import { GET as listGet } from "@/app/api/support-services/route";
import { db } from "@/server/db";
import {
  dealers,
  paymentIntents,
  platformInvoiceLines,
  platformInvoices,
  shopAttributions,
  shops,
  shopWallets,
  supportServiceRequests,
  supportTicketAttachments,
  supportTickets,
} from "@/server/db/schema";
import type { PaymentIntentRef } from "@/server/payments/intents";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { applyShopWalletEntry } from "@/server/services/shop-wallet";
import {
  adminRefund,
  cancelSupportRequest,
  createSupportRequest,
  onSupportServicePaymentCaptured,
  payFromWallet,
  quoteSupportService,
  saveCharge,
  saveSupportSettings,
} from "@/server/services/support-services";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

type Actor = { id: string; email: string; name: string | null; role: UserRole };
let admin: Actor;
let owner: Actor;
let shopId: string;

const signIn = (u: Actor) => {
  state.session = { user: { id: u.id, email: u.email, name: u.name, image: null, role: u.role, status: "ACTIVE" } };
};

const DESC = "Please upload my product list from the attached sheet.";

async function seedCharges() {
  // Seed data is not reset between tests: put the three charges back to the migration's defaults.
  await saveCharge("GENERAL", { chargeModel: "FREE", amountPaise: 0, gstApplicable: false, gstRateBp: 0, freeQuotaPerMonth: 0, effectiveFrom: "2026-01-01" }, "test defaults", admin);
  await saveCharge("PRODUCT_UPLOAD", { chargeModel: "PER_BATCH", amountPaise: 49_900, batchSize: 50, gstApplicable: true, gstRateBp: 1800, freeQuotaPerMonth: 0, effectiveFrom: "2026-01-01" }, "test defaults", admin);
  await saveCharge("PRICE_UPDATE", { chargeModel: "PER_BATCH", amountPaise: 19_900, batchSize: 50, gstApplicable: true, gstRateBp: 1800, freeQuotaPerMonth: 1, effectiveFrom: "2026-01-01" }, "test defaults", admin);
  await saveSupportSettings({ refundPercentBeforeWork: 100, freeForManagedBilling: true }, "test defaults", admin);
}

async function topUp(paise: number) {
  await applyShopWalletEntry({ shopId, type: "MANUAL_CREDIT", amountPaise: paise, reason: "test top-up", idempotencyKey: `test-topup:${Math.random()}`, createdBy: admin.id });
}

async function balance(): Promise<number> {
  const [w] = await db.select().from(shopWallets).where(eq(shopWallets.shopId, shopId));
  return w?.balancePaise ?? 0;
}

beforeEach(async () => {
  await resetDatabase();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name, role: "ADMIN" };
  const o = await createUser({ role: "SHOP_OWNER" });
  owner = { id: o.id, email: o.email, name: o.name, role: "SHOP_OWNER" };
  const shop = await createShop(o.id, { name: "Kale Kirana", status: "APPROVED", shopType: "GENERAL_TRADING" as never });
  await db.update(shops).set({ pincode: "411038" }).where(eq(shops.id, shop.id));
  shopId = shop.id;
  await setFeatureFlag("paid_support_services_enabled", { enabled: true, districtCodes: null }, "support services (test)", admin);
  await seedCharges();
});

describe("prices and requests", () => {
  it("general support is free and opens its ticket at once (scenario 57)", async () => {
    const r = await createSupportRequest({ shopId, serviceKey: "GENERAL", quantity: 1, description: "My shop timings do not show correctly." }, owner);
    expect(r).toMatchObject({ status: "PAID", paymentMethod: "FREE", totalPaise: 0, freeReason: "FREE_SERVICE" });
    expect(r.ticketId).toBeTruthy();
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, r.ticketId!));
    expect(t.subject).toContain("General support");
    expect(t.shopId).toBe(shopId);
  });

  it("120 products at ₹499 per 50 = 3 batches + 18% GST, shown before submitting (scenario 58)", async () => {
    const q = await quoteSupportService(shopId, "PRODUCT_UPLOAD", 120);
    expect(q).toMatchObject({ basePaise: 149_700, gstPaise: 26_946, totalPaise: 176_646, freeReason: null });
    expect(q.explanation).toContain("3 ×");
    signIn(owner);
    const viaRoute = await call(quoteGet, `/api/support-services/quote?shopId=${shopId}&serviceKey=PRODUCT_UPLOAD&quantity=120`);
    expect(viaRoute.status).toBe(200);
    expect(viaRoute.body.quote.totalPaise).toBe(176_646);
  });

  it("pays from the wallet: debited once, ticket opened with the files (scenario 59)", async () => {
    await topUp(200_000);
    const sheet = Buffer.from("name,price\nAtta,50\n");
    const r = await createSupportRequest({ shopId, serviceKey: "PRODUCT_UPLOAD", quantity: 120, description: DESC, files: [{ name: "products.csv", bytes: sheet }] }, owner);
    expect(r.status).toBe("AWAITING_PAYMENT");
    const paid = await payFromWallet(r.id, owner);
    expect(paid).toMatchObject({ status: "PAID", paymentMethod: "WALLET" });
    expect(await balance()).toBe(200_000 - 176_646);
    expect(paid.ticketId).toBeTruthy();
    const files = await db.select().from(supportTicketAttachments).where(eq(supportTicketAttachments.ticketId, paid.ticketId!));
    expect(files.map((f) => f.fileName)).toEqual(["products.csv"]);
    // Paying twice is refused, and the wallet is not debited again.
    await expect(payFromWallet(r.id, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await balance()).toBe(200_000 - 176_646);
  });

  it("not enough in the wallet: 402 with the shortfall, nothing debited (scenario 61)", async () => {
    await topUp(10_000);
    const r = await createSupportRequest({ shopId, serviceKey: "PRODUCT_UPLOAD", quantity: 10, description: DESC }, owner);
    signIn(owner);
    const res = await call(payPost, `/api/support-services/${r.id}/pay`, { method: "POST", body: { method: "WALLET" }, params: { id: r.id } });
    expect(res.status).toBe(402);
    expect(res.body.error.details.shortfallPaise).toBe(58_882 - 10_000);
    expect(await balance()).toBe(10_000);
    const [row] = await db.select().from(supportServiceRequests).where(eq(supportServiceRequests.id, r.id));
    expect(row.status).toBe("AWAITING_PAYMENT");
  });

  it("an online payment confirmed by the gateway marks it paid; a wrong amount does not (scenario 60)", async () => {
    const r = await createSupportRequest({ shopId, serviceKey: "PRODUCT_UPLOAD", quantity: 50, description: DESC }, owner);
    const [row] = await db
      .insert(paymentIntents)
      .values({ purpose: "SUPPORT_SERVICE", referenceId: r.id, userId: owner.id, amountPaise: 58_882, gateway: "SANDBOX", merchantOrderId: `SSR-T-${Date.now()}`, description: "test", idempotencyKey: `support-service:${r.id}` } as never)
      .returning();
    const intent = (amountPaise: number) => ({ id: row.id, purpose: "SUPPORT_SERVICE", referenceId: r.id, userId: owner.id, amountPaise, refundedPaise: 0, status: "CAPTURED", gateway: "CASHFREE", gatewayOrderId: null }) as unknown as PaymentIntentRef;
    await onSupportServicePaymentCaptured(intent(100), db);
    expect((await db.select().from(supportServiceRequests).where(eq(supportServiceRequests.id, r.id)))[0].status).toBe("AWAITING_PAYMENT");
    await onSupportServicePaymentCaptured(intent(58_882), db);
    await vi.waitFor(async () => {
      const [row] = await db.select().from(supportServiceRequests).where(eq(supportServiceRequests.id, r.id));
      expect(row).toMatchObject({ status: "PAID", paymentMethod: "ONLINE" });
      expect(row.ticketId).toBeTruthy();
    });
  });

  it("the free monthly quota covers the first price update, then it is charged (scenario 62)", async () => {
    const first = await createSupportRequest({ shopId, serviceKey: "PRICE_UPDATE", quantity: 30, description: "Update prices from my new list." }, owner);
    expect(first).toMatchObject({ status: "PAID", totalPaise: 0, freeReason: "MONTHLY_QUOTA" });
    const second = await quoteSupportService(shopId, "PRICE_UPDATE", 30);
    expect(second).toMatchObject({ freeReason: null, basePaise: 19_900, totalPaise: 23_482 });
  });

  it("a shop on managed billing is not charged again for upload (scenario 66)", async () => {
    const [inv] = await db
      .insert(platformInvoices)
      .values({ invoiceNumber: `GK-T-${Date.now()}`, shopId, financialYear: "2026-27", sequence: 1, supplyType: "INTRA", taxablePaise: 99_900, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 99_900, snapshot: {}, issuedAt: new Date() } as never)
      .returning();
    await db.insert(platformInvoiceLines).values({ invoiceId: inv.id, lineNo: 1, feeType: "BILLING_MANAGEMENT", description: "Managed billing", sac: "998314", rateBp: 0, taxablePaise: 99_900, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 99_900, collectedVia: "SHOP_WALLET" } as never);
    const q = await quoteSupportService(shopId, "PRODUCT_UPLOAD", 120);
    expect(q).toMatchObject({ totalPaise: 0, freeReason: "MANAGED_BILLING" });
  });
});

describe("charges", () => {
  it("a new charge applies to new requests only; old ones keep theirs (scenario 63)", async () => {
    const before = await createSupportRequest({ shopId, serviceKey: "PRODUCT_UPLOAD", quantity: 50, description: DESC }, owner);
    await saveCharge("PRODUCT_UPLOAD", { chargeModel: "PER_BATCH", amountPaise: 59_900, batchSize: 50, gstApplicable: true, gstRateBp: 1800, freeQuotaPerMonth: 0, effectiveFrom: "2026-01-01" }, "price review", admin);
    const after = await quoteSupportService(shopId, "PRODUCT_UPLOAD", 50);
    expect(after.basePaise).toBe(59_900);
    const [old] = await db.select().from(supportServiceRequests).where(eq(supportServiceRequests.id, before.id));
    expect(old.basePaise).toBe(49_900);
    await topUp(100_000);
    expect((await payFromWallet(before.id, owner)).totalPaise).toBe(58_882);
  });

  it("only an admin can change charges (scenario 64)", async () => {
    const op = await createUser({ role: "OPERATOR" });
    signIn({ id: op.id, email: op.email, name: op.name, role: "OPERATOR" });
    const body = { action: "saveCharge", serviceKey: "GENERAL", reason: "operator try", charge: { chargeModel: "PER_REQUEST", amountPaise: 100, gstApplicable: false, gstRateBp: 0, freeQuotaPerMonth: 0, effectiveFrom: "2026-01-01" } };
    expect((await call(adminPost, "/api/admin/support-services", { method: "POST", body })).status).toBe(403);
    signIn(owner);
    expect((await call(adminPost, "/api/admin/support-services", { method: "POST", body })).status).toBe(403);
    await expect(saveCharge("GENERAL", body.charge as never, "owner try", owner)).rejects.toMatchObject({ code: "FORBIDDEN" });
    signIn(admin);
    expect((await call(adminPost, "/api/admin/support-services", { method: "POST", body: { ...body, charge: { ...body.charge, chargeModel: "FREE", amountPaise: 0 } } })).status).toBe(200);
  });
});

describe("cancel and refund", () => {
  it("cancelled before work starts: full refund to the wallet, ticket closed (scenario 65)", async () => {
    await topUp(100_000);
    const r = await createSupportRequest({ shopId, serviceKey: "PRODUCT_UPLOAD", quantity: 50, description: DESC }, owner);
    const paid = await payFromWallet(r.id, owner);
    const cancelled = await cancelSupportRequest(r.id, "changed my mind", owner);
    expect(cancelled).toMatchObject({ status: "REFUNDED", refundPaise: 58_882 });
    expect(await balance()).toBe(100_000);
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, paid.ticketId!));
    expect(t.status).toBe("CLOSED");
  });

  it("after work starts the shop cannot cancel; an admin can still refund", async () => {
    await topUp(100_000);
    const r = await createSupportRequest({ shopId, serviceKey: "PRODUCT_UPLOAD", quantity: 50, description: DESC }, owner);
    const paid = await payFromWallet(r.id, owner);
    await db.update(supportTickets).set({ status: "IN_PROGRESS" }).where(eq(supportTickets.id, paid.ticketId!));
    await expect(cancelSupportRequest(r.id, "too slow", owner)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(adminRefund(r.id, 20_000, "partial goodwill", owner)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const refunded = await adminRefund(r.id, 20_000, "partial goodwill", admin);
    expect(refunded).toMatchObject({ status: "REFUNDED", refundPaise: 20_000 });
    expect(await balance()).toBe(100_000 - 58_882 + 20_000);
  });

  it("an admin-set 50% refund rule is used; an unpaid request just cancels", async () => {
    await saveSupportSettings({ refundPercentBeforeWork: 50 }, "half refund rule", admin);
    await topUp(100_000);
    const r = await createSupportRequest({ shopId, serviceKey: "PRODUCT_UPLOAD", quantity: 50, description: DESC }, owner);
    await payFromWallet(r.id, owner);
    expect((await cancelSupportRequest(r.id, "not needed", owner)).refundPaise).toBe(29_441);
    const unpaid = await createSupportRequest({ shopId, serviceKey: "PRODUCT_UPLOAD", quantity: 50, description: DESC }, owner);
    expect((await cancelSupportRequest(unpaid.id, "not needed", owner)).status).toBe("CANCELLED");
  });
});

describe("who may ask (scenario 67)", () => {
  it("the shop's own dealer may raise a request; another dealer and other owners get 404; off → 404", async () => {
    const du = await createUser({ role: "DEALER" });
    const [dealer] = await db.insert(dealers).values({ userId: du.id, legalName: "Dealer A", contactName: "A", dealerType: "PROPRIETORSHIP", status: "APPROVED" }).returning();
    await db.insert(shopAttributions).values({ shopId, dealerId: dealer.id, source: "CODE_AT_REGISTRATION" });
    const dealerActor: Actor = { id: du.id, email: du.email, name: du.name, role: "DEALER" };
    const r = await createSupportRequest({ shopId, serviceKey: "GENERAL", quantity: 1, description: "Help the owner set up delivery." }, dealerActor);
    expect(r).toMatchObject({ dealerId: dealer.id, status: "PAID" });
    expect(r.ticketId).toBeTruthy();
    // The dealer cannot pay from the shop's wallet.
    const priced = await createSupportRequest({ shopId, serviceKey: "PRODUCT_UPLOAD", quantity: 10, description: DESC }, dealerActor);
    await expect(payFromWallet(priced.id, dealerActor)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const other = await createUser({ role: "DEALER" });
    await db.insert(dealers).values({ userId: other.id, legalName: "Dealer B", contactName: "B", dealerType: "PROPRIETORSHIP", status: "APPROVED" });
    signIn({ id: other.id, email: other.email, name: other.name, role: "DEALER" });
    expect((await call(listGet, `/api/support-services?shopId=${shopId}`)).status).toBe(404);
    const stranger = await createUser({ role: "SHOP_OWNER" });
    signIn({ id: stranger.id, email: stranger.email, name: stranger.name, role: "SHOP_OWNER" });
    expect((await call(listGet, `/api/support-services?shopId=${shopId}`)).status).toBe(404);

    signIn(owner);
    expect((await call(listGet, `/api/support-services?shopId=${shopId}`)).status).toBe(200);
    await setFeatureFlag("paid_support_services_enabled", { enabled: false, districtCodes: null }, "switch off (test)", admin);
    const off = await call(listGet, `/api/support-services?shopId=${shopId}`);
    expect(off.status).toBe(404);
    expect(off.body.error.details.reason).toBe("FEATURE_NOT_AVAILABLE");
  });
});
