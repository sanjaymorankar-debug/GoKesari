/**
 * Seller verification, Part 3 flows against real PostgreSQL: per-document
 * rules, write-through to the shop, the no-GSTIN declaration, Shop Act
 * certificate upload, admin review and re-check, the per-shop limit, and the
 * scheduled sweep (retries, GST re-check, expiry warnings, suspension).
 * Vendor answers come from the mock or a scripted adapter.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import {
  auditLogs,
  notifications,
  sellerVerificationEvents,
  sellerVerificationFiles,
  sellerVerifications,
  shops,
  shopSuspensions,
} from "@/server/db/schema";
import {
  KycUnavailableError,
  setKycAdapterForTests,
  type KycAdapter,
  type ProviderOutcome,
  type SourceRecord,
  type VerifyRequest,
} from "@/server/kyc";
import {
  adminDecideVerification,
  declareNoGstin,
  getShopVerificationSummary,
  getVerificationFile,
  listVerificationReviewQueue,
  recheckVerification,
  submitSellerDocument,
  uploadShopActCertificate,
} from "@/server/services/seller-verification";
import { runSellerVerificationSweep } from "@/server/services/seller-verification-jobs";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(resetDatabase);
afterEach(() => setKycAdapterForTests(null));

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function setup(shopType: "DAIRY" | "PHARMACY" = "DAIRY") {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const admin = await createUser({ role: "ADMIN" });
  const shop = await createShop(owner.id, { name: "Ganesh Dairy", shopType });
  await db.update(shops).set({ ownerName: "Rahul Patil", legalBusinessName: "Ganesh Dairy" }).where(eq(shops.id, shop.id));
  return {
    shop,
    owner,
    actor: { id: owner.id, role: "SHOP_OWNER" as const },
    adminActor: { id: admin.id, role: "ADMIN" as const },
  };
}

/** An adapter that answers from a script, recording what it was asked. */
function scripted(answer: (req: VerifyRequest) => ProviderOutcome | Promise<ProviderOutcome>) {
  const calls: VerifyRequest[] = [];
  const adapter: KycAdapter = { id: "mock", verify: async (req) => (calls.push(req), answer(req)) };
  setKycAdapterForTests(adapter);
  return calls;
}

const found = (record: Partial<SourceRecord>): ProviderOutcome => ({
  kind: "found",
  providerRef: "ref-1",
  record: { docStatus: "active", name: null, ...record },
});

describe("document rules", () => {
  it("sends a PAN whose name does not match to review", async () => {
    const { shop, actor } = await setup();
    const view = await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE7777F", consentGiven: true, actor });
    expect(view).toMatchObject({ status: "MANUAL_REVIEW", lastErrorCode: "name_mismatch" });
    expect(view.nameMatchScore).toBeLessThan(85);
  });

  it("flags a GSTIN whose PAN is not the shop's PAN, and writes a good GSTIN through to the shop", async () => {
    const { shop, actor } = await setup();
    scripted((req) => found({ name: "GANESH DAIRY", tradeName: "GANESH DAIRY", linkedPan: req.number.slice(2, 12) }));
    await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE1234F", consentGiven: true, actor });

    const bad = await submitSellerDocument({ shopId: shop.id, docType: "GSTIN", number: "27AAPFU0939F1ZV", consentGiven: true, actor });
    expect(bad).toMatchObject({ status: "MANUAL_REVIEW", lastErrorCode: "gstin_pan_mismatch" });

    await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "AAPFU0939F", consentGiven: true, actor });
    const good = await submitSellerDocument({ shopId: shop.id, docType: "GSTIN", number: "27AAPFU0939F1ZV", consentGiven: true, actor });
    // Same number as before, previously in review → checked again, now linked.
    expect(good).toMatchObject({ status: "VERIFIED" });
    const [s] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(s).toMatchObject({ gstin: "27AAPFU0939F1ZV", gstStatus: "REGISTERED", gstVerificationSource: "PROVIDER_VERIFIED" });
  });

  it("checks an FSSAI licence's premises PIN code and writes a good one through", async () => {
    const { shop, actor } = await setup();
    scripted(() => found({ name: "Ganesh Dairy", validUntil: "2030-01-01", pincode: "411038", category: "STATE" }));
    const view = await submitSellerDocument({ shopId: shop.id, docType: "FSSAI", number: "11521001000123", consentGiven: true, actor });
    expect(view).toMatchObject({ status: "MANUAL_REVIEW", lastErrorCode: "address_mismatch" });

    scripted(() => found({ name: "Ganesh Dairy", validUntil: "2030-01-01", pincode: "411001", category: "STATE" }));
    const again = await submitSellerDocument({ shopId: shop.id, docType: "FSSAI", number: "11521001000124", consentGiven: true, actor });
    expect(again.status).toBe("VERIFIED");
    const [s] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(s.fssaiLicenseNumber).toBe("11521001000124");
  });

  it("requires FSSAI for a food shop but not for a pharmacy", async () => {
    const food = await setup("DAIRY");
    const pharmacy = await setup("PHARMACY");
    const a = await getShopVerificationSummary(food.shop.id, food.actor);
    const b = await getShopVerificationSummary(pharmacy.shop.id, pharmacy.actor);
    expect(a.missing).toContain("FSSAI");
    expect(b.missing).not.toContain("FSSAI");
    expect(b.missing).toEqual(["PAN", "GSTIN", "SHOP_ACT"]);
  });
});

describe("no GSTIN", () => {
  it("records the declaration for review; an admin accepts it", async () => {
    const { shop, actor, adminActor } = await setup();
    const view = await declareNoGstin({ shopId: shop.id, declarationAccepted: true, enrolmentNumber: "27abcde1234f1z5", actor });
    expect(view).toMatchObject({ status: "MANUAL_REVIEW", lastErrorCode: "gst_declaration_review", numberMasked: null });
    expect(view.details).toMatchObject({ declaredNotRegistered: true, enrolmentNumber: "27ABCDE1234F1Z5" });

    const queue = await listVerificationReviewQueue(adminActor);
    expect(queue.map((q) => q.view.docType)).toEqual(["GSTIN"]);

    const accepted = await adminDecideVerification(view.id!, { decision: "approve", reason: "" }, adminActor);
    expect(accepted.status).toBe("VERIFIED");
    const [s] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(s.gstStatus).toBe("NOT_REGISTERED");
    const summary = await getShopVerificationSummary(shop.id, actor);
    expect(summary.missing).not.toContain("GSTIN");
  });

  it("refuses without the declaration", async () => {
    const { shop, actor } = await setup();
    await expect(declareNoGstin({ shopId: shop.id, declarationAccepted: false, actor })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("Shop Act certificate", () => {
  it("stores the upload encrypted and routes a Maharashtra certificate to review", async () => {
    const { shop, actor, adminActor } = await setup();
    const view = await uploadShopActCertificate({ shopId: shop.id, number: "PMC/II/12345", file: PDF, consentGiven: true, actor });
    expect(view).toMatchObject({ status: "MANUAL_REVIEW", lastErrorCode: "certificate_review" });

    const [file] = await db.select().from(sellerVerificationFiles).where(eq(sellerVerificationFiles.shopId, shop.id));
    expect(file.contentType).toBe("application/pdf");
    expect(file.dataEncrypted.includes(Buffer.from("%PDF"))).toBe(false);

    // Owner can open it without an audit entry; an admin can, and that is audited; a stranger can't.
    expect((await getVerificationFile(file.id, actor)).data.equals(PDF)).toBe(true);
    await getVerificationFile(file.id, adminActor);
    const views = await db.select().from(auditLogs).where(eq(auditLogs.action, "seller_document.file_viewed"));
    expect(views).toHaveLength(1);
    const stranger = await createUser({ role: "SHOP_OWNER" });
    await expect(getVerificationFile(file.id, { id: stranger.id, role: "SHOP_OWNER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a file that is not a PDF or image, before any vendor call", async () => {
    const { shop, actor } = await setup();
    const calls = scripted(() => ({ kind: "not_found", providerRef: null }));
    await expect(
      uploadShopActCertificate({ shopId: shop.id, number: "PMC12345", file: Buffer.from("MZ executable"), consentGiven: true, actor }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(calls).toHaveLength(0);
  });
});

describe("admin review", () => {
  it("needs a reason to reject, tells the seller, and records the reviewer", async () => {
    const { shop, owner, actor, adminActor } = await setup();
    const view = await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE7777F", consentGiven: true, actor });
    await expect(adminDecideVerification(view.id!, { decision: "reject", reason: "" }, adminActor)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const rejected = await adminDecideVerification(view.id!, { decision: "reject", reason: "Name belongs to someone else" }, adminActor);
    expect(rejected).toMatchObject({ status: "FAILED", reviewNote: "Name belongs to someone else" });
    const [row] = await db.select().from(sellerVerifications).where(eq(sellerVerifications.id, view.id!));
    expect(row.reviewerId).toBe(adminActor.id);
    const notes = await db.select().from(notifications).where(eq(notifications.userId, owner.id));
    expect(notes.some((n) => n.body.includes("Name belongs to someone else"))).toBe(true);
  });

  it("is not open to shop owners", async () => {
    const { shop, actor } = await setup();
    const view = await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE7777F", consentGiven: true, actor });
    await expect(adminDecideVerification(view.id!, { decision: "approve", reason: "" }, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(recheckVerification(view.id!, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("re-checks with the vendor using the number on file", async () => {
    const { shop, actor, adminActor } = await setup();
    const view = await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE9999F", consentGiven: true, actor });
    expect(view.status).toBe("PENDING");
    const calls = scripted(() => found({ name: "PATIL RAHUL" }));
    // Outside the 30 s in-flight window.
    await db.update(sellerVerifications).set({ lastAttemptAt: new Date(Date.now() - 60_000) }).where(eq(sellerVerifications.id, view.id!));
    const again = await recheckVerification(view.id!, adminActor);
    expect(calls[0].number).toBe("ABCPE9999F");
    expect(again).toMatchObject({ status: "VERIFIED", attemptCount: 2 });
  });
});

describe("per-shop limit", () => {
  it("caps paid checks a person can trigger per hour", async () => {
    const { shop, actor } = await setup();
    for (let i = 0; i < 10; i += 1) {
      await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: `ABCPE${1000 + i}F`, consentGiven: true, actor });
    }
    await expect(
      submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE2000F", consentGiven: true, actor }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("scheduled sweep", () => {
  const DAY = 86_400_000;

  it("retries a document a vendor outage left pending", async () => {
    const { shop, actor } = await setup();
    scripted(() => {
      throw new KycUnavailableError("source_down", "down");
    });
    const view = await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE1234F", consentGiven: true, actor });
    expect(view).toMatchObject({ status: "PENDING", lastErrorCode: "vendor_source_down" });

    scripted(() => found({ name: "PATIL RAHUL" }));
    await db.update(sellerVerifications).set({ lastAttemptAt: new Date(Date.now() - 60 * 60_000) }).where(eq(sellerVerifications.id, view.id!));
    const result = await runSellerVerificationSweep();
    expect(result.pendingRetried).toBe(1);
    const [row] = await db.select().from(sellerVerifications).where(eq(sellerVerifications.id, view.id!));
    expect(row.status).toBe("VERIFIED");
  });

  it("re-checks a GSTIN and takes the shop offline when it has been cancelled", async () => {
    const { shop, actor } = await setup();
    scripted((req) => found({ name: "GANESH DAIRY", linkedPan: req.number.slice(2, 12) }));
    const view = await submitSellerDocument({ shopId: shop.id, docType: "GSTIN", number: "27AAPFU0939F1ZV", consentGiven: true, actor });
    expect(view.status).toBe("VERIFIED");

    scripted(() => found({ docStatus: "cancelled", name: "GANESH DAIRY" }));
    await db.update(sellerVerifications).set({ lastAttemptAt: new Date(Date.now() - 31 * DAY) }).where(eq(sellerVerifications.id, view.id!));
    const result = await runSellerVerificationSweep();
    expect(result).toMatchObject({ gstRechecked: 1, shopsSuspended: 1, errors: [] });

    const [s] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(s.status).toBe("SUSPENDED");
    const [suspension] = await db.select().from(shopSuspensions).where(eq(shopSuspensions.shopId, shop.id));
    expect(suspension.suspendedBy).toBeNull();
    expect(suspension.reason).toContain("GST");
    // No automatic refunds without a person.
    expect(Object.values(suspension.policy as Record<string, string>)).not.toContain("CANCEL_REFUND");
  });

  it("warns once before FSSAI expiry, then expires it and suspends the food shop", async () => {
    const { shop, owner, actor } = await setup();
    const soon = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
    scripted(() => found({ name: "Ganesh Dairy", validUntil: soon, pincode: "411001" }));
    const view = await submitSellerDocument({ shopId: shop.id, docType: "FSSAI", number: "11521001000123", consentGiven: true, actor });
    expect(view.status).toBe("VERIFIED");

    expect((await runSellerVerificationSweep()).expiryWarnings).toBe(1);
    expect((await runSellerVerificationSweep()).expiryWarnings).toBe(0);
    const warnings = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.document_expiring")));
    expect(warnings).toHaveLength(1);

    const past = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
    await db.update(sellerVerifications).set({ validUntil: past }).where(eq(sellerVerifications.id, view.id!));
    const result = await runSellerVerificationSweep();
    expect(result).toMatchObject({ expired: 1, shopsSuspended: 1 });
    const events = await db.select().from(sellerVerificationEvents).where(eq(sellerVerificationEvents.verificationId, view.id!));
    expect(events.map((e) => e.eventType)).toEqual(expect.arrayContaining(["EXPIRY_WARNING", "EXPIRED", "SHOP_SUSPENDED"]));
  });

  it("does not suspend for an optional document", async () => {
    const { shop, actor } = await setup();
    scripted(() => found({ name: "Ganesh Dairy", docStatus: "active", category: "MICRO" }));
    const view = await submitSellerDocument({ shopId: shop.id, docType: "UDYAM", number: "UDYAM-MH-26-0012345", consentGiven: true, actor });
    expect(view.status).toBe("VERIFIED");
    scripted(() => found({ name: "Ganesh Dairy", docStatus: "cancelled" }));
    await recheckVerification(view.id!, null);
    const result = await runSellerVerificationSweep();
    expect(result.shopsSuspended).toBe(0);
  });
});
