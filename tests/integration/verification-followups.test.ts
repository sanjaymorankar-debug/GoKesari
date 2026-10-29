/**
 * Owner decisions, 29 Oct 2026 (seller verification follow-ups):
 *
 *   - one GSTIN, one business: another owner's account may not use a GSTIN that is on a live
 *     shop (or verified / being checked for one); the same owner may, for another branch
 *   - a Shop Act licence covers one establishment: no second live shop may use it, whoever owns it
 *   - PAN may be on several shops (one owner, several shops) — allowed
 *   - the seller-verification records are the source: a verified PAN, Udyam or Shop Act is copied
 *     onto the shop (the shop profile shows them), and a decision on the older GST/PAN queue is
 *     recorded there too, so instant approval and the documents follow-up see it
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { sellerVerifications, shops } from "@/server/db/schema";
import { setKycAdapterForTests, type KycAdapter, type ProviderOutcome, type SourceRecord } from "@/server/kyc";
import { adminRejectPan, adminVerifyGst, adminVerifyPan, submitGstin, submitPan } from "@/server/services/gst-pan-verification";
import { submitSellerDocument } from "@/server/services/seller-verification";
import { gstinHeldByOtherOwner, shopActHeldByOtherShop } from "@/server/services/shop-duplicates";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const GSTIN = "27AAPFU0939F1ZV";
const PAN = "AAPFU0939F";

let admin: { id: string; role: "ADMIN" };

beforeEach(async () => {
  await resetDatabase();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  const found = (record: Partial<SourceRecord>): ProviderOutcome => ({ kind: "found", providerRef: "gov-ref-1", record: { docStatus: "active", name: null, ...record } });
  const adapter: KycAdapter = {
    id: "mock",
    verify: async (req) => found({ name: "GANESH TRADERS", tradeName: "GANESH TRADERS", linkedPan: req.docType === "GSTIN" ? req.number.slice(2, 12) : undefined }),
  };
  setKycAdapterForTests(adapter);
});
afterEach(() => setKycAdapterForTests(null));

async function ownerWithShop(name = "Ganesh Traders") {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name, status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never });
  await db.update(shops).set({ ownerName: "Ganesh Patil", legalBusinessName: "Ganesh Traders" }).where(eq(shops.id, shop.id));
  return { owner, shop, actor: { id: owner.id, role: "SHOP_OWNER" as const } };
}

const submit = (shopId: string, actor: { id: string; role: "SHOP_OWNER" }, docType: "PAN" | "GSTIN" | "UDYAM" | "SHOP_ACT", number: string) =>
  submitSellerDocument({ shopId, docType, number, consentGiven: true, actor });
const shopRow = async (id: string) => (await db.select().from(shops).where(eq(shops.id, id)))[0];
const verificationOf = async (shopId: string, docType: "PAN" | "GSTIN") =>
  (await db.select().from(sellerVerifications).where(and(eq(sellerVerifications.shopId, shopId), eq(sellerVerifications.docType, docType))))[0];

describe("GSTIN: one business; another owner's account is refused, the same owner's branch is not", () => {
  it("refuses another owner's GSTIN on the verification page and on the older GST form", async () => {
    const first = await ownerWithShop();
    expect((await submit(first.shop.id, first.actor, "GSTIN", GSTIN)).status).toBe("VERIFIED");

    const second = await ownerWithShop("Ganesh Traders 2");
    await expect(submit(second.shop.id, second.actor, "GSTIN", GSTIN)).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "DUPLICATE_GSTIN" } });
    await expect(submitGstin(second.shop.id, GSTIN, second.actor)).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "DUPLICATE_GSTIN" } });
    expect(await verificationOf(second.shop.id, "GSTIN")).toBeUndefined();
  });

  it("lets the same owner use it for a second branch", async () => {
    const first = await ownerWithShop();
    await submit(first.shop.id, first.actor, "GSTIN", GSTIN);
    const branch = await createShop(first.owner.id, { name: "Ganesh Traders Kothrud", status: "PENDING_APPROVAL" });
    await db.update(shops).set({ ownerName: "Ganesh Patil", legalBusinessName: "Ganesh Traders" }).where(eq(shops.id, branch.id));
    expect((await submit(branch.id, first.actor, "GSTIN", GSTIN)).status).toBe("VERIFIED");
    expect(await gstinHeldByOtherOwner(GSTIN, first.owner.id)).toBeNull();
  });

  it("a rejected or deleted shop doesn't hold it", async () => {
    const first = await ownerWithShop();
    await submit(first.shop.id, first.actor, "GSTIN", GSTIN);
    await db.update(shops).set({ status: "REJECTED" }).where(eq(shops.id, first.shop.id));
    const second = await ownerWithShop("Ganesh Traders 2");
    expect((await submit(second.shop.id, second.actor, "GSTIN", GSTIN)).status).toBe("VERIFIED");
  });

  it("a GSTIN another owner took before the rule: its re-check goes to a person, not verified", async () => {
    const first = await ownerWithShop();
    const view = await submit(first.shop.id, first.actor, "GSTIN", GSTIN);
    const other = await ownerWithShop("Older Ganesh");
    await db.update(shops).set({ gstin: GSTIN }).where(eq(shops.id, other.shop.id));
    const { recheckVerification } = await import("@/server/services/seller-verification");
    expect(await recheckVerification(view.id!, null)).toMatchObject({ status: "MANUAL_REVIEW", lastErrorCode: "gstin_other_owner" });
  });
});

describe("Shop Act: one establishment, one shop", () => {
  it("refuses a licence another live shop uses, even the same owner's", async () => {
    const first = await ownerWithShop();
    await submit(first.shop.id, first.actor, "SHOP_ACT", "PMC/SHOP/12345");
    const branch = await createShop(first.owner.id, { name: "Ganesh Traders Kothrud", status: "PENDING_APPROVAL" });
    await expect(submit(branch.id, first.actor, "SHOP_ACT", "pmc shop 12345")).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "DUPLICATE_SHOP_ACT" },
    });
    expect(await shopActHeldByOtherShop("PMCSHOP12345", first.shop.id)).toBeNull();
  });
});

describe("PAN: several shops of one owner may share it", () => {
  it("accepts the same PAN on a second shop of another owner too (a PAN is not unique)", async () => {
    const first = await ownerWithShop();
    await submit(first.shop.id, first.actor, "PAN", PAN);
    const second = await ownerWithShop("Ganesh Traders 2");
    expect((await submit(second.shop.id, second.actor, "PAN", PAN)).status).toBe("VERIFIED");
  });
});

describe("verified results are copied onto the shop", () => {
  it("PAN: status, masked last four, the duplicate guard's hash; Udyam: its number; Shop Act: the licence", async () => {
    const { shop, actor } = await ownerWithShop();
    await submit(shop.id, actor, "PAN", PAN);
    await submit(shop.id, actor, "UDYAM", "UDYAM-MH-26-0012345");
    const row = await shopRow(shop.id);
    expect(row).toMatchObject({ panStatus: "VERIFIED", panLast4: "939F", panVerificationSource: "PROVIDER_VERIFIED", udyamNumber: "UDYAM-MH-26-0012345" });
    expect(row.panHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.panNumberEncrypted).not.toContain(PAN);

    expect((await submit(shop.id, actor, "SHOP_ACT", "PMC/SHOP/12345")).status).toBe("VERIFIED");
    expect(await shopRow(shop.id)).toMatchObject({ shopActKey: "PMCSHOP12345" });
  });
});

describe("the older GST/PAN queue records its decisions in the verification records", () => {
  it("approving a GSTIN and a PAN there marks them verified by the reviewer", async () => {
    const { shop, actor } = await ownerWithShop();
    setKycAdapterForTests(null); // the older form never calls a source
    await submitGstin(shop.id, GSTIN, actor);
    await submitPan(shop.id, PAN, "Ganesh Patil", actor);
    expect(await verificationOf(shop.id, "GSTIN")).toBeUndefined();

    await adminVerifyGst(shop.id, admin);
    await adminVerifyPan(shop.id, admin);
    const gst = await verificationOf(shop.id, "GSTIN");
    expect(gst).toMatchObject({ status: "VERIFIED", reviewerId: admin.id, numberEncrypted: null });
    // No verification consent on that form: no number is kept there (no re-check can send it out), only its mask.
    expect(gst.details).toMatchObject({ numberMasked: "27XXXXXXXXXX1ZV", decidedOn: "GST_PAN_QUEUE", embeddedPanHash: expect.any(String) });
    const pan = await verificationOf(shop.id, "PAN");
    expect(pan).toMatchObject({ status: "VERIFIED", reviewerId: admin.id });
    expect((pan.details as Record<string, unknown>).decidedOn).toBe("GST_PAN_QUEUE");
    expect(await shopRow(shop.id)).toMatchObject({ gstStatus: "REGISTERED", panStatus: "VERIFIED" });
  });

  it("rejecting a PAN there marks it failed, with the reason", async () => {
    const { shop, actor } = await ownerWithShop();
    setKycAdapterForTests(null);
    await submitPan(shop.id, PAN, "Ganesh Patil", actor);
    await adminRejectPan(shop.id, "Name on the card does not match", admin);
    expect(await verificationOf(shop.id, "PAN")).toMatchObject({ status: "FAILED", reviewNote: "Name on the card does not match", lastErrorCode: "rejected_by_admin" });
    expect((await shopRow(shop.id)).panStatus).toBe("VERIFICATION_FAILED");
  });
});
