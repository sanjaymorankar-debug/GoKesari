/**
 * Seller verification core pipeline (Part 2) against real PostgreSQL, with
 * the in-process mock vendor (tests/setup.ts forces KYC_PROVIDER=mock).
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptSecret } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import { sellerVerificationEvents, sellerVerifications } from "@/server/db/schema";
import { setKycAdapterForTests, type KycAdapter } from "@/server/kyc";
import { listShopVerifications, submitSellerDocument } from "@/server/services/seller-verification";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(resetDatabase);
afterEach(() => setKycAdapterForTests(null));

async function setup() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: "Shree Dairy" });
  const actor = { id: owner.id, role: "SHOP_OWNER" as const };
  return { owner, shop, actor };
}

describe("submitSellerDocument", () => {
  it("verifies a valid PAN and stores it encrypted and masked", async () => {
    const { shop, actor } = await setup();
    const view = await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE1234F", consentGiven: true, actor });

    expect(view).toMatchObject({ status: "VERIFIED", numberMasked: "XXXXXX234F", providerId: "mock", attemptCount: 1 });
    expect(JSON.stringify(view)).not.toContain("ABCPE1234F");

    const [row] = await db.select().from(sellerVerifications).where(eq(sellerVerifications.shopId, shop.id));
    expect(row.numberEncrypted).not.toContain("ABCPE1234F");
    expect(decryptSecret(row.numberEncrypted!)).toBe("ABCPE1234F");
    expect(row.consentGivenAt).not.toBeNull();

    const events = await db.select().from(sellerVerificationEvents).where(eq(sellerVerificationEvents.verificationId, row.id));
    expect(events.map((e) => e.eventType).sort()).toEqual(["CONSENT_GIVEN", "SUBMITTED", "VENDOR_RESULT"]);
    expect(JSON.stringify(events)).not.toContain("ABCPE1234F");
  });

  it("refuses without consent, and refuses a malformed number before any vendor call", async () => {
    const { shop, actor } = await setup();
    let calls = 0;
    setKycAdapterForTests({ id: "mock", verify: async () => { calls += 1; return { kind: "not_found", providerRef: null }; } });

    await expect(
      submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE1234F", consentGiven: false, actor }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      submitSellerDocument({ shopId: shop.id, docType: "GSTIN", number: "27AAPFU0939F1ZA", consentGiven: true, actor }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(calls).toBe(0);
  });

  it("refuses someone else's shop", async () => {
    const { shop } = await setup();
    const stranger = await createUser({ role: "SHOP_OWNER" });
    await expect(
      submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE1234F", consentGiven: true, actor: { id: stranger.id, role: "SHOP_OWNER" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps the document PENDING when the vendor times out", async () => {
    const { shop, actor } = await setup();
    const view = await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE9999F", consentGiven: true, actor });
    expect(view).toMatchObject({ status: "PENDING", lastErrorCode: "vendor_timeout" });
  });

  it("fails a number unknown at source, and marks an expired FSSAI licence EXPIRED", async () => {
    const { shop, actor } = await setup();
    await expect(
      submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE0000F", consentGiven: true, actor }),
    ).resolves.toMatchObject({ status: "FAILED", lastErrorCode: "not_found_at_source" });
    await expect(
      submitSellerDocument({ shopId: shop.id, docType: "FSSAI", number: "11521001008888", consentGiven: true, actor }),
    ).resolves.toMatchObject({ status: "EXPIRED" });
  });

  it("sends Maharashtra Shop Act numbers the vendor cannot check to manual review", async () => {
    const { shop, actor } = await setup(); // fixture pincode 411001 → MH
    await expect(
      submitSellerDocument({ shopId: shop.id, docType: "SHOP_ACT", number: "PMC/SHOP/12345", consentGiven: true, actor }),
    ).resolves.toMatchObject({ status: "MANUAL_REVIEW", lastErrorCode: "vendor_unsupported" });
  });

  it("checks the GSTIN's PAN against what the source returns", async () => {
    const { shop, actor } = await setup();
    const view = await submitSellerDocument({ shopId: shop.id, docType: "GSTIN", number: "27AAPFU0939F1ZV", consentGiven: true, actor });
    expect(view.status).toBe("VERIFIED");
    expect(view.details).toMatchObject({ linkedPanMatchesGstin: true, stateCode: "27" });
  });

  it("does not pay again for a number already verified", async () => {
    const { shop, actor } = await setup();
    let calls = 0;
    setKycAdapterForTests({
      id: "mock",
      verify: async (req) => {
        calls += 1;
        return { kind: "found", providerRef: req.idempotencyKey, record: { docStatus: "active", name: "SHREE DAIRY" } };
      },
    } satisfies KycAdapter);

    await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE1234F", consentGiven: true, actor });
    const again = await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "abcpe1234f", consentGiven: true, actor });
    expect(calls).toBe(1);
    expect(again).toMatchObject({ status: "VERIFIED", attemptCount: 1 });

    // A different number is a new check.
    await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE1235F", consentGiven: true, actor });
    expect(calls).toBe(2);
  });

  it("lets concurrent identical submissions make only one vendor call", async () => {
    const { shop, actor } = await setup();
    let calls = 0;
    setKycAdapterForTests({
      id: "mock",
      verify: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 200));
        return { kind: "found", providerRef: "x", record: { docStatus: "active", name: "SHREE DAIRY" } };
      },
    });
    const input = { shopId: shop.id, docType: "PAN" as const, number: "ABCPE1234F", consentGiven: true, actor };
    await Promise.all([submitSellerDocument(input), submitSellerDocument(input)]);
    expect(calls).toBe(1);
  });

  it("refuses to rewrite verification history", async () => {
    const { shop, actor } = await setup();
    await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE1234F", consentGiven: true, actor });
    await expect(db.execute(sql`UPDATE seller_verification_events SET note = 'x'`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/append-only/) },
    });
    // DELETE stays possible, for the retention job and shop deletion.
    await db.execute(sql`DELETE FROM seller_verification_events`);
  });
});

describe("listShopVerifications", () => {
  it("lists all five documents, NOT_SUBMITTED for the rest", async () => {
    const { shop, actor } = await setup();
    await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE1234F", consentGiven: true, actor });
    const list = await listShopVerifications(shop.id, actor);
    expect(list.map((v) => [v.docType, v.status])).toEqual([
      ["PAN", "VERIFIED"],
      ["GSTIN", "NOT_SUBMITTED"],
      ["UDYAM", "NOT_SUBMITTED"],
      ["FSSAI", "NOT_SUBMITTED"],
      ["SHOP_ACT", "NOT_SUBMITTED"],
    ]);
  });
});
