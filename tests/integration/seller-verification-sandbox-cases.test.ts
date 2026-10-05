/**
 * Deliverable 4: the sandbox test cases, run automatically against the mock
 * vendor. The same table is in docs/seller-verification/TEST_CASES.md for
 * manual runs on test.gokesari.com — keep the two in step.
 *
 * Shop under test: food shop (DAIRY) in Pune 411001 (Maharashtra), owner
 * "Owner", legal name "Shree Dairy".
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { SellerDocType } from "@/lib/kyc/doc-formats";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { adminDecideVerification, submitSellerDocument, uploadShopActCertificate } from "@/server/services/seller-verification";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(resetDatabase);

const PDF = Buffer.from("%PDF-1.4\n%%EOF\n");

type Expected = { status: string; code?: string | null } | { error: "VALIDATION_FAILED" };

interface Case {
  id: string;
  doc: SellerDocType;
  scenario: string;
  number: string;
  expected: Expected;
}

export const SANDBOX_CASES: Case[] = [
  { id: "PAN-1", doc: "PAN", scenario: "valid, name matches", number: "ABCPE1234F", expected: { status: "VERIFIED", code: null } },
  { id: "PAN-2", doc: "PAN", scenario: "invalid format (4th letter)", number: "ABCZE1234F", expected: { error: "VALIDATION_FAILED" } },
  { id: "PAN-3", doc: "PAN", scenario: "inactive at source", number: "ABCPE8888F", expected: { status: "FAILED", code: "document_inactive" } },
  { id: "PAN-4", doc: "PAN", scenario: "name mismatch", number: "ABCPE7777F", expected: { status: "MANUAL_REVIEW", code: "name_mismatch" } },
  { id: "PAN-5", doc: "PAN", scenario: "vendor timeout", number: "ABCPE9999F", expected: { status: "PENDING", code: "vendor_timeout" } },
  { id: "PAN-6", doc: "PAN", scenario: "not found", number: "ABCPE0000F", expected: { status: "FAILED", code: "not_found_at_source" } },

  { id: "GST-1", doc: "GSTIN", scenario: "valid, active", number: "27AAPFU1234F1Z5", expected: { status: "VERIFIED", code: null } },
  { id: "GST-2", doc: "GSTIN", scenario: "invalid checksum", number: "27AAPFU1234F1Z6", expected: { error: "VALIDATION_FAILED" } },
  { id: "GST-3", doc: "GSTIN", scenario: "cancelled", number: "27AAPFU8888F1Z7", expected: { status: "FAILED", code: "document_cancelled" } },
  { id: "GST-4", doc: "GSTIN", scenario: "name mismatch", number: "27AAPFU7777F1ZD", expected: { status: "MANUAL_REVIEW", code: "name_mismatch" } },
  { id: "GST-5", doc: "GSTIN", scenario: "vendor timeout", number: "27AAPFU9999F1Z1", expected: { status: "PENDING", code: "vendor_timeout" } },
  { id: "GST-6", doc: "GSTIN", scenario: "not found", number: "27AAPFU0000F1ZJ", expected: { status: "FAILED", code: "not_found_at_source" } },

  { id: "UDY-1", doc: "UDYAM", scenario: "valid", number: "UDYAM-MH-26-0001234", expected: { status: "VERIFIED", code: null } },
  { id: "UDY-2", doc: "UDYAM", scenario: "invalid format", number: "UDYAM-MH-26-12345", expected: { error: "VALIDATION_FAILED" } },
  { id: "UDY-3", doc: "UDYAM", scenario: "cancelled", number: "UDYAM-MH-26-0008888", expected: { status: "FAILED", code: "document_cancelled" } },
  { id: "UDY-4", doc: "UDYAM", scenario: "name mismatch", number: "UDYAM-MH-26-0007777", expected: { status: "MANUAL_REVIEW", code: "name_mismatch" } },
  { id: "UDY-5", doc: "UDYAM", scenario: "vendor timeout", number: "UDYAM-MH-26-0009999", expected: { status: "PENDING", code: "vendor_timeout" } },
  { id: "UDY-6", doc: "UDYAM", scenario: "not found", number: "UDYAM-MH-26-0010000", expected: { status: "FAILED", code: "not_found_at_source" } },

  { id: "FSS-1", doc: "FSSAI", scenario: "valid, 2 years left", number: "11521001001234", expected: { status: "VERIFIED", code: null } },
  { id: "FSS-2", doc: "FSSAI", scenario: "invalid (13 digits)", number: "1152100100123", expected: { error: "VALIDATION_FAILED" } },
  { id: "FSS-3", doc: "FSSAI", scenario: "expired", number: "11521001008888", expected: { status: "EXPIRED", code: "document_expired" } },
  { id: "FSS-4", doc: "FSSAI", scenario: "name mismatch", number: "11521001007777", expected: { status: "MANUAL_REVIEW", code: "name_mismatch" } },
  { id: "FSS-5", doc: "FSSAI", scenario: "vendor timeout", number: "11521001009999", expected: { status: "PENDING", code: "vendor_timeout" } },
  { id: "FSS-6", doc: "FSSAI", scenario: "not found", number: "11521001000000", expected: { status: "FAILED", code: "not_found_at_source" } },
  { id: "FSS-7", doc: "FSSAI", scenario: "expires in 20 days (verified, warning later)", number: "11521001006666", expected: { status: "VERIFIED", code: null } },

  { id: "AAD-1", doc: "SHOP_ACT", scenario: "Aadhaar number typed", number: "2341 2341 2346", expected: { error: "VALIDATION_FAILED" } },
  { id: "AAD-2", doc: "FSSAI", scenario: "Aadhaar number typed", number: "499118665246", expected: { error: "VALIDATION_FAILED" } },
];

/** Shop Act goes through the certificate upload (Maharashtra: no vendor coverage). */
export const SHOP_ACT_CASES: Case[] = [
  { id: "SHA-1", doc: "SHOP_ACT", scenario: "MH certificate, vendor can't check → admin review", number: "PMC/SHOP/12345", expected: { status: "MANUAL_REVIEW", code: "certificate_review" } },
  { id: "SHA-2", doc: "SHOP_ACT", scenario: "vendor can check (stand-in), name and PIN match", number: "PMC/SHOP/12222", expected: { status: "VERIFIED", code: null } },
  { id: "SHA-3", doc: "SHOP_ACT", scenario: "placeholder number", number: "N/A", expected: { error: "VALIDATION_FAILED" } },
  { id: "SHA-4", doc: "SHOP_ACT", scenario: "vendor timeout", number: "PMC/SHOP/19999", expected: { status: "PENDING", code: "vendor_timeout" } },
  { id: "SHA-5", doc: "SHOP_ACT", scenario: "not found at source → certificate review", number: "PMC/SHOP/10000", expected: { status: "MANUAL_REVIEW", code: "certificate_review" } },
];

async function setup() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: "Shree Dairy", shopType: "DAIRY" });
  await db.update(shops).set({ legalBusinessName: "Shree Dairy" }).where(eq(shops.id, shop.id));
  return { shop, actor: { id: owner.id, role: "SHOP_OWNER" as const } };
}

function check(result: PromiseSettledResult<{ status: string; lastErrorCode: string | null }>, expected: Expected) {
  if ("error" in expected) {
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toMatchObject({ code: expected.error });
    return;
  }
  expect(result.status).toBe("fulfilled");
  const view = (result as PromiseFulfilledResult<{ status: string; lastErrorCode: string | null }>).value;
  expect(view.status).toBe(expected.status);
  if (expected.code !== undefined) expect(view.lastErrorCode).toBe(expected.code);
}

describe("sandbox test cases (mock vendor)", () => {
  it.each(SANDBOX_CASES.map((c) => [c.id, c.scenario, c] as const))("%s %s", async (_id, _scenario, c) => {
    const { shop, actor } = await setup();
    const result = await Promise.allSettled([
      submitSellerDocument({ shopId: shop.id, docType: c.doc, number: c.number, consentGiven: true, actor }),
    ]);
    check(result[0], c.expected);
  });

  it.each(SHOP_ACT_CASES.map((c) => [c.id, c.scenario, c] as const))("%s %s", async (_id, _scenario, c) => {
    const { shop, actor } = await setup();
    const result = await Promise.allSettled([
      uploadShopActCertificate({ shopId: shop.id, number: c.number, file: PDF, consentGiven: true, actor }),
    ]);
    check(result[0], c.expected);
  });

  it("SHA-6 admin rejects a certificate whose number doesn't match the upload", async () => {
    const { shop, actor } = await setup();
    const admin = await createUser({ role: "ADMIN" });
    const view = await uploadShopActCertificate({ shopId: shop.id, number: "PMC/SHOP/12345", file: PDF, consentGiven: true, actor });
    const rejected = await adminDecideVerification(
      view.id!,
      { decision: "reject", reason: "Number on the certificate is different" },
      { id: admin.id, role: "ADMIN" },
    );
    expect(rejected).toMatchObject({ status: "FAILED", lastErrorCode: "rejected_by_admin" });
  });
});
