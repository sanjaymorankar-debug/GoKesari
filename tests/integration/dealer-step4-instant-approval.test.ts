/**
 * Dealer programme step 4 (docs/dealer-programme, GKS-SH-004): instant approval
 * on government GST/PAN verification + online payment, and the "ready for
 * product upload" email.
 *
 * Scenarios (build prompt §5): 20 GSTIN active + name match + gateway payment →
 * approved with no admin, email with the shop ID and product-upload link,
 * dealer told; 21 PAN-only; 22 GSTIN inactive → pending with the reason; 23 name
 * mismatch; 24 GSTIN not this PAN's; 25 verified but fee unpaid → pending, no
 * orders; 26 fee recorded by hand (not the gateway) → pending; 27 provider down
 * → pending, approved by the retry once it answers; 28 another owner's shop with
 * this GSTIN → pending; food shop without FSSAI stays pending; 30 flag off →
 * today's behaviour, nothing logged; another district → today's behaviour.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { auditLogs, dealers, notifications, paymentIntents, sellerVerifications, shopAttributions, shopAutoApprovalLog, shops } from "@/server/db/schema";
import { KycUnavailableError, setKycAdapterForTests, type KycAdapter, type ProviderOutcome, type SourceRecord, type VerifyRequest } from "@/server/kyc";
import { applyGatewayState } from "@/server/payments/processing";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { listGovDecisions } from "@/server/services/gov-auto-approval";
import { approveShop } from "@/server/services/shops";
import { adminDecideVerification, declareNoGstin, recheckVerification, stateCodeForPincode, submitSellerDocument } from "@/server/services/seller-verification";
import { submitLegalDocument } from "@/server/services/legal-documents";
import { runSellerVerificationSweep } from "@/server/services/seller-verification-jobs";
import { recordPayment } from "@/server/services/shop-payments";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; role: "ADMIN" };

beforeEach(async () => {
  await resetDatabase();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setFeatureFlag("gov_verification_auto_approval_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", admin);
});
afterEach(() => setKycAdapterForTests(null));

function scripted(answer: (req: VerifyRequest) => ProviderOutcome | Promise<ProviderOutcome>) {
  const adapter: KycAdapter = { id: "mock", verify: async (req) => answer(req) };
  setKycAdapterForTests(adapter);
}
const found = (record: Partial<SourceRecord>): ProviderOutcome => ({ kind: "found", providerRef: "gov-ref-1", record: { docStatus: "active", name: null, ...record } });
const goodSource = () => scripted((req) => found({ name: "GANESH TRADERS", tradeName: "GANESH TRADERS", linkedPan: req.docType === "GSTIN" ? req.number.slice(2, 12) : undefined }));

async function pendingShop(opts: { shopType?: "GENERAL_TRADING" | "DAIRY"; pincode?: string } = {}) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: "Ganesh Traders", status: "PENDING_APPROVAL", shopType: (opts.shopType ?? "GENERAL_TRADING") as never, registrationFeePaise: 99_900 });
  await db
    .update(shops)
    .set({ ownerName: "Ganesh Patil", legalBusinessName: "Ganesh Traders", phone: `98${String(Date.now()).slice(-8)}`, ...(opts.pincode ? { pincode: opts.pincode } : {}) })
    .where(eq(shops.id, shop.id));
  return { shop, owner, actor: { id: owner.id, role: "SHOP_OWNER" as const } };
}

const verify = (shopId: string, actor: { id: string; role: "SHOP_OWNER" }, docType: "PAN" | "GSTIN" | "SHOP_ACT", number: string) =>
  submitSellerDocument({ shopId, docType, number, consentGiven: true, actor });

/** Shop Act verified (today's rule: every approval needs it) and, for a shop without GST, the declaration accepted. */
async function otherDocuments(shopId: string, actor: { id: string; role: "SHOP_OWNER" }, opts: { noGst?: boolean } = {}) {
  await verify(shopId, actor, "SHOP_ACT", "PMC/SHOP/12345");
  if (opts.noGst) {
    const view = await declareNoGstin({ shopId, declarationAccepted: true, actor });
    await adminDecideVerification(view.id!, { decision: "approve", reason: "" }, admin);
  }
}

const payOnline = (shopId: string, method: "ONLINE" | "UPI" = "ONLINE") =>
  recordPayment({ shopId, paymentType: "REGISTRATION_FEE", amountPaise: 99_900, method, transactionId: `cf_${shopId.slice(0, 8)}` }, admin);

const statusOf = async (shopId: string) => (await db.select({ status: shops.status }).from(shops).where(eq(shops.id, shopId)))[0].status;
const lastLog = async (shopId: string) => (await db.select().from(shopAutoApprovalLog).where(eq(shopAutoApprovalLog.shopId, shopId))).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

describe("approved with no admin step (scenarios 20, 21)", () => {
  it("GSTIN active, name match, its PAN, fee through the gateway → approved; ready-for-upload email; the dealer is told", async () => {
    goodSource();
    const { shop, owner, actor } = await pendingShop();
    const dealerUser = await createUser({ role: "DEALER" });
    const [dealer] = await db.insert(dealers).values({ userId: dealerUser.id, legalName: "Shree Sai", contactName: "Sai", dealerType: "PROPRIETORSHIP", status: "APPROVED" }).returning();
    await db.insert(shopAttributions).values({ shopId: shop.id, dealerId: dealer.id, source: "CODE_AT_REGISTRATION" });

    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await verify(shop.id, actor, "GSTIN", "27AAPFU0939F1ZV");
    await otherDocuments(shop.id, actor);
    // Verified but unpaid: still pending, and the reason is logged.
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    expect((await lastLog(shop.id)).reasons).toEqual(["registration fee not paid"]);

    await payOnline(shop.id);
    expect(await statusOf(shop.id)).toBe("APPROVED");
    const log = await lastLog(shop.id);
    expect(log.outcome).toBe("APPROVED");
    expect(log.evidence).toMatchObject({
      gstin: { status: "VERIFIED", sourceStatus: "active", provider: "mock", providerRef: "gov-ref-1", byReviewer: false },
      payment: { feePaise: 99_900, gatewayPaise: 99_900 },
      duplicate: { kind: "NONE" },
    });
    expect(JSON.stringify(log.evidence)).not.toContain("AAPFU0939F\"");

    const [ready] = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.ready_for_product_upload")));
    expect(ready.title).toBe("Registration successful — Ganesh Traders is ready for product upload");
    expect(ready.body).toContain("/shop/manage/products");
    expect(ready.body).toContain("/shop/product-import");
    expect(ready.actionUrl).toBe("/shop/manage/products");
    const [s] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(ready.body).toContain(s.registrationNumber ?? shop.id);
    const told = await db.select().from(notifications).where(and(eq(notifications.userId, dealerUser.id), eq(notifications.type, "dealer.shop_approved")));
    expect(told).toHaveLength(1);
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "shop.auto_approved"), eq(auditLogs.entityId, shop.id)));
    expect(audit.newValue).toMatchObject({ rule: "GOV_VERIFICATION" });
  });

  it("PAN only (no GST, declaration accepted): PAN valid with name match + gateway fee → approved", async () => {
    goodSource();
    const { shop, actor } = await pendingShop();
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await otherDocuments(shop.id, actor, { noGst: true });
    await payOnline(shop.id);
    expect(await statusOf(shop.id)).toBe("APPROVED");
    expect((await lastLog(shop.id)).evidence).toMatchObject({ pan: { status: "VERIFIED", sourceStatus: "active" } });
  });
});

describe("waits for an admin, with the reason (scenarios 22–26, 28)", () => {
  it("GSTIN inactive at the source", async () => {
    scripted((req) => found({ name: "GANESH TRADERS", docStatus: req.docType === "GSTIN" ? "cancelled" : "active", linkedPan: req.docType === "GSTIN" ? req.number.slice(2, 12) : undefined }));
    const { shop, actor } = await pendingShop();
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await verify(shop.id, actor, "GSTIN", "27AAPFU0939F1ZV");
    await db.update(shops).set({ gstin: "27AAPFU0939F1ZV" }).where(eq(shops.id, shop.id));
    await payOnline(shop.id);
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    expect((await lastLog(shop.id)).reasons.join(" ")).toMatch(/^GSTIN: /);
  });

  it("name on the government record does not match", async () => {
    scripted(() => found({ name: "SOMEONE ELSE ENTERPRISES" }));
    const { shop, actor } = await pendingShop();
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await payOnline(shop.id);
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    expect((await lastLog(shop.id)).reasons.join(" ")).toMatch(/PAN: status manual review/);
  });

  it("GSTIN that does not belong to the shop's PAN", async () => {
    scripted((req) => found({ name: "GANESH TRADERS", linkedPan: req.docType === "GSTIN" ? req.number.slice(2, 12) : undefined }));
    const { shop, actor } = await pendingShop();
    await verify(shop.id, actor, "PAN", "ABCPE1234F");
    await verify(shop.id, actor, "GSTIN", "27AAPFU0939F1ZV");
    await db.update(shops).set({ gstin: "27AAPFU0939F1ZV" }).where(eq(shops.id, shop.id));
    await payOnline(shop.id);
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    expect((await lastLog(shop.id)).reasons.join(" ")).toMatch(/GSTIN: status manual review \(gstin_pan_mismatch\)/);
  });

  it("verified, but the fee was recorded by hand (UPI, not the gateway)", async () => {
    goodSource();
    const { shop, actor } = await pendingShop();
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await otherDocuments(shop.id, actor, { noGst: true });
    await payOnline(shop.id, "UPI");
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    expect((await lastLog(shop.id)).reasons).toEqual(["registration fee not confirmed by the payment gateway"]);
  });

  it("another owner's shop already has this GSTIN", async () => {
    goodSource();
    const other = await createUser({ role: "SHOP_OWNER" });
    const existing = await createShop(other.id, { name: "Old Ganesh", status: "APPROVED" });
    await db.update(shops).set({ gstin: "27AAPFU0939F1ZV" }).where(eq(shops.id, existing.id));
    const { shop, actor } = await pendingShop();
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    // Owner decision, 29 Oct: refused when it is submitted (services/shop-duplicates.ts).
    await expect(verify(shop.id, actor, "GSTIN", "27AAPFU0939F1ZV")).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "DUPLICATE_GSTIN" } });
    // A shop that has it on file from before the rule: the instant approval still holds it back.
    await db.update(shops).set({ gstin: "27AAPFU0939F1ZV" }).where(eq(shops.id, shop.id));
    await payOnline(shop.id);
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
  });

  it("Shop Act not yet verified: waits, and the log names it (today's rule for every approval)", async () => {
    goodSource();
    const { shop, actor } = await pendingShop();
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await payOnline(shop.id);
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    expect((await lastLog(shop.id)).reasons.join(" ")).toMatch(/documents not yet verified: .*Shop/);
  });

  it("a food shop still needs its FSSAI licence: GST/PAN does not replace a shop-type document", async () => {
    goodSource();
    const { shop, actor } = await pendingShop({ shopType: "DAIRY" });
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await otherDocuments(shop.id, actor, { noGst: true });
    await payOnline(shop.id);
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    expect((await lastLog(shop.id)).reasons.join(" ")).toMatch(/FSSAI/);
  });
});

describe("provider down, then back (scenario 27)", () => {
  it("stays pending while the source is unreachable; the retry approves it once the source answers", async () => {
    let down = true;
    scripted((req) => {
      if (down) throw new KycUnavailableError("timeout", "the source did not answer");
      return found({ name: "GANESH TRADERS", linkedPan: req.docType === "GSTIN" ? req.number.slice(2, 12) : undefined });
    });
    const { shop, actor } = await pendingShop();
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await otherDocuments(shop.id, actor, { noGst: true });
    await payOnline(shop.id);
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    expect((await lastLog(shop.id)).reasons.join(" ")).toMatch(/waiting for the government source/);

    down = false;
    await db.update(sellerVerifications).set({ lastAttemptAt: new Date(Date.now() - 24 * 3_600_000) }).where(eq(sellerVerifications.shopId, shop.id));
    await runSellerVerificationSweep();
    expect(await statusOf(shop.id)).toBe("APPROVED");
  });
});

describe("flag off, or another district (scenario 30)", () => {
  it("off: today's behaviour — the shop waits for an admin, nothing is logged", async () => {
    await setFeatureFlag("gov_verification_auto_approval_enabled", { enabled: false, districtCodes: null }, "off (test)", admin);
    goodSource();
    const { shop, actor } = await pendingShop();
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await payOnline(shop.id);
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    expect(await db.select().from(shopAutoApprovalLog)).toHaveLength(0);
  });

  it("on for Pune only: a Mumbai shop waits for an admin", async () => {
    goodSource();
    const { shop, actor } = await pendingShop({ pincode: "400001" });
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await payOnline(shop.id);
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    expect(await db.select().from(shopAutoApprovalLog)).toHaveLength(0);
  });
});

describe("with the shop approval queue's changes (0109 waiver, deferred follow-ups)", () => {
  it("a shop an admin approves without its documents leaves the instant-approval Pending list; the dealer board says approved by admin", async () => {
    goodSource();
    const { shop, actor } = await pendingShop();
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await verify(shop.id, actor, "GSTIN", "27AAPFU0939F1ZV");
    await payOnline(shop.id);
    // No Shop Act: the instant rule waits and says so.
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    expect((await listGovDecisions({ outcome: "PENDING" })).map((r) => r.shopId)).toContain(shop.id);

    await approveShop(shop.id, { classification: "GREEN" }, admin, { waiveDocuments: { reason: "Shop Act applied for, approved for the pilot" } });
    expect(await statusOf(shop.id)).toBe("APPROVED");
    expect((await listGovDecisions({ outcome: "PENDING" })).map((r) => r.shopId)).not.toContain(shop.id);
    // Still in the full history, with the shop's status now.
    expect((await listGovDecisions()).find((r) => r.shopId === shop.id)).toMatchObject({ outcome: "PENDING", shopStatus: "APPROVED" });
  });

  it("a reviewer's decision with deferred follow-ups still approves instantly once the follow-ups run", async () => {
    goodSource();
    const { shop, actor } = await pendingShop();
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await verify(shop.id, actor, "GSTIN", "27AAPFU0939F1ZV");
    await payOnline(shop.id);
    // The Shop Act goes to a person (manual review), whose approval is the last step.
    scripted((req) => (req.docType === "SHOP_ACT" ? ({ kind: "unsupported", reason: "Shop Act is checked by a person" } as ProviderOutcome) : found({ name: "GANESH TRADERS", tradeName: "GANESH TRADERS", linkedPan: req.number.slice(2, 12) })));
    await verify(shop.id, actor, "SHOP_ACT", "PMC/SHOP/12345");
    const [row] = await db.select().from(sellerVerifications).where(and(eq(sellerVerifications.shopId, shop.id), eq(sellerVerifications.docType, "SHOP_ACT")));
    expect(row.status).toBe("MANUAL_REVIEW");
    const tasks: (() => Promise<void>)[] = [];
    await adminDecideVerification(row.id, { decision: "approve", reason: "" }, admin, { defer: (t) => void tasks.push(t) });
    // The answer came back before the follow-ups: not approved yet.
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    for (const t of tasks) await t();
    expect(await statusOf(shop.id)).toBe("APPROVED");
    expect((await lastLog(shop.id)).outcome).toBe("APPROVED");
  });
});

describe("fee paid through the gateway's webhook (staging finding, 28 Oct)", () => {
  it("the capture approves the shop before the webhook is answered — no timer", async () => {
    goodSource();
    const { shop, owner, actor } = await pendingShop();
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await verify(shop.id, actor, "GSTIN", "27AAPFU0939F1ZV");
    await otherDocuments(shop.id, actor);
    const [intent] = await db
      .insert(paymentIntents)
      .values({ purpose: "SHOP_REGISTRATION_FEE", referenceId: shop.id, userId: owner.id, amountPaise: 99_900, gateway: "SANDBOX", merchantOrderId: `gk_${shop.id.slice(0, 8)}`, gatewayOrderId: `go_${shop.id.slice(0, 8)}`, description: "fee", idempotencyKey: `fee:${shop.id}` } as never)
      .returning();
    const result = await applyGatewayState(intent.id, { gatewayOrderId: `go_${shop.id.slice(0, 8)}`, status: "CAPTURED", amountPaise: 99_900, gatewayPaymentId: "pay_wh_1", method: "UPI" }, { source: "WEBHOOK" });
    expect(result.outcome).toBe("MOVED");
    // Straight after the call: no 2-second timer to wait for.
    expect(await statusOf(shop.id)).toBe("APPROVED");
    expect((await lastLog(shop.id)).outcome).toBe("APPROVED");
  });
});

describe("verification review fixes (29 Oct)", () => {
  it("GSTIN checked first, then a different PAN: the PAN goes to review and the shop is not approved; the right PAN passes", async () => {
    goodSource();
    const { shop, actor } = await pendingShop();
    await verify(shop.id, actor, "GSTIN", "27AAPFU0939F1ZV");
    await otherDocuments(shop.id, actor);
    const wrong = await verify(shop.id, actor, "PAN", "ABCPE1234F");
    expect(wrong).toMatchObject({ status: "MANUAL_REVIEW", lastErrorCode: "pan_gstin_mismatch" });
    await payOnline(shop.id);
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    const right = await verify(shop.id, actor, "PAN", "AAPFU0939F");
    expect(right.status).toBe("VERIFIED");
    expect(await statusOf(shop.id)).toBe("APPROVED");
  });

  it("a reviewer can't approve a document that is already verified or still being checked", async () => {
    goodSource();
    const { shop, actor } = await pendingShop();
    const pan = await verify(shop.id, actor, "PAN", "AAPFU0939F");
    expect(pan.status).toBe("VERIFIED");
    await expect(adminDecideVerification(pan.id!, { decision: "approve", reason: "" }, admin)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a reviewer's approval survives the periodic re-check; a cancellation at the source still undoes it", async () => {
    // The record's name doesn't match: the GSTIN goes to a person, who approves it.
    scripted((req) => found({ name: "SOMEONE ELSE", tradeName: "SOMEONE ELSE", linkedPan: req.docType === "GSTIN" ? req.number.slice(2, 12) : undefined }));
    const { shop, actor } = await pendingShop();
    const gst = await verify(shop.id, actor, "GSTIN", "27AAPFU0939F1ZV");
    expect(gst.status).toBe("MANUAL_REVIEW");
    await adminDecideVerification(gst.id!, { decision: "approve", reason: "trade name checked by phone" }, admin);
    const again = await recheckVerification(gst.id!, null);
    expect(again.status).toBe("VERIFIED");
    scripted(() => found({ name: "SOMEONE ELSE", docStatus: "cancelled" }));
    const cancelled = await recheckVerification(gst.id!, null);
    expect(cancelled.status).not.toBe("VERIFIED");
  });

  it("the state comes from any Indian PIN code (Goa is not Maharashtra), or from the shop's state where the PIN spans two", () => {
    expect(stateCodeForPincode("403001")).toBe("GA");
    expect(stateCodeForPincode("411038")).toBe("MH");
    expect(stateCodeForPincode("560001")).toBe("KA");
    expect(stateCodeForPincode("800001")).toBeUndefined();
    expect(stateCodeForPincode("800001", "Bihar")).toBe("BR");
  });

  it("a food shop is approved once its last licence (FSSAI) is in", async () => {
    goodSource();
    const { shop, actor } = await pendingShop({ shopType: "DAIRY" });
    await verify(shop.id, actor, "PAN", "AAPFU0939F");
    await otherDocuments(shop.id, actor, { noGst: true });
    await payOnline(shop.id);
    expect(await statusOf(shop.id)).toBe("PENDING_APPROVAL");
    // The FSSAI record: active, with its expiry and the shop's PIN code.
    const [{ pincode }] = await db.select({ pincode: shops.pincode }).from(shops).where(eq(shops.id, shop.id));
    scripted((req) => found({ name: "GANESH TRADERS", tradeName: "GANESH TRADERS", ...(req.docType === "FSSAI" ? { validUntil: "2028-12-31", pincode } : {}) }));
    await submitSellerDocument({ shopId: shop.id, docType: "FSSAI", number: "11523999000123", consentGiven: true, actor });
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
    const expiry = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    await submitLegalDocument({ shopId: shop.id, docType: "FSSAI", number: "11523999000123", expiryDate: expiry, file: pdf, actor: actor as never });
    expect(await statusOf(shop.id)).toBe("APPROVED");
  });
});
