/**
 * GST/PAN self-service verification (marketplace GST-readiness follow-up).
 * No verification provider is configured in tests (see tests/setup.ts), so
 * every submission is expected to land in the self-declared/
 * PENDING_VERIFICATION path — admin confirm/reject is exercised separately.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { decryptPan, encryptPan, maskPan } from "@/lib/pan-crypto";
import {
  adminRejectGst,
  adminRejectPan,
  adminVerifyGst,
  adminVerifyPan,
  getMaskedPan,
  listPendingGstPanVerifications,
  revealPanForAdmin,
  setGstNotRegistered,
  submitGstin,
  submitPan,
} from "@/server/services/gst-pan-verification";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";
import { gstin } from "../helpers/gstin";

beforeEach(resetDatabase);

// A real GSTIN layout with a correct check character (TC-FLD-043 checks it).
const VALID_GSTIN = gstin("27", "AAAAA0000A");
const VALID_PAN = "ABCDE1234F";

async function setupShop() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id);
  return { owner, shop };
}

describe("pan-crypto", () => {
  it("round-trips a PAN through encrypt/decrypt", () => {
    const encrypted = encryptPan(VALID_PAN);
    expect(encrypted).not.toContain(VALID_PAN);
    expect(decryptPan(encrypted)).toBe(VALID_PAN);
  });

  it("masks a PAN to only its last 4 characters", () => {
    expect(maskPan("234F")).toBe("XXXXXX234F");
  });
});

describe("submitGstin", () => {
  it("stores the GSTIN as PENDING_VERIFICATION, self-declared", async () => {
    const { owner, shop } = await setupShop();
    const updated = await submitGstin(shop.id, VALID_GSTIN, { id: owner.id, role: "SHOP_OWNER" });

    expect(updated.gstin).toBe(VALID_GSTIN);
    expect(updated.gstStatus).toBe("PENDING_VERIFICATION");
    expect(updated.gstVerificationSource).toBe("SELF_DECLARED");
    expect(updated.gstVerifiedAt).toBeNull();
  });

  it("rejects a malformed GSTIN", async () => {
    const { owner, shop } = await setupShop();
    await expect(
      submitGstin(shop.id, "not-a-gstin", { id: owner.id, role: "SHOP_OWNER" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses a user who does not own the shop", async () => {
    const { shop } = await setupShop();
    const stranger = await createUser({ role: "SHOP_OWNER" });
    await expect(
      submitGstin(shop.id, VALID_GSTIN, { id: stranger.id, role: "SHOP_OWNER" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("setGstNotRegistered", () => {
  it("clears any prior GSTIN and marks NOT_REGISTERED", async () => {
    const { owner, shop } = await setupShop();
    await submitGstin(shop.id, VALID_GSTIN, { id: owner.id, role: "SHOP_OWNER" });

    const updated = await setGstNotRegistered(shop.id, { id: owner.id, role: "SHOP_OWNER" });
    expect(updated.gstStatus).toBe("NOT_REGISTERED");
    expect(updated.gstin).toBeNull();
  });
});

describe("admin GST review", () => {
  it("verifies a pending GSTIN and writes through to legalBusinessName", async () => {
    const { owner, shop } = await setupShop();
    await submitGstin(shop.id, VALID_GSTIN, { id: owner.id, role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });

    const verified = await adminVerifyGst(shop.id, { id: admin.id, role: "ADMIN" }, {
      legalName: "Verified Legal Pvt Ltd",
    });

    expect(verified.gstStatus).toBe("REGISTERED");
    expect(verified.gstVerificationSource).toBe("ADMIN_VERIFIED");
    expect(verified.legalBusinessName).toBe("Verified Legal Pvt Ltd");
    expect(verified.gstVerifiedBy).toBe(admin.id);
  });

  it("rejects a pending GSTIN with a reason", async () => {
    const { owner, shop } = await setupShop();
    await submitGstin(shop.id, VALID_GSTIN, { id: owner.id, role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });

    const rejected = await adminRejectGst(shop.id, "GSTIN not found on the portal", {
      id: admin.id,
      role: "ADMIN",
    });
    expect(rejected.gstStatus).toBe("VERIFICATION_FAILED");
  });

  it("refuses to re-verify an already-verified GSTIN", async () => {
    const { owner, shop } = await setupShop();
    await submitGstin(shop.id, VALID_GSTIN, { id: owner.id, role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });
    await adminVerifyGst(shop.id, { id: admin.id, role: "ADMIN" });

    await expect(adminVerifyGst(shop.id, { id: admin.id, role: "ADMIN" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("submitPan", () => {
  it("encrypts the PAN, stores only the last 4 in plaintext, and masks for display", async () => {
    const { owner, shop } = await setupShop();
    const updated = await submitPan(shop.id, VALID_PAN, "Test Holder", {
      id: owner.id,
      role: "SHOP_OWNER",
    });

    expect(updated.panNumberEncrypted).not.toContain(VALID_PAN);
    expect(updated.panLast4).toBe("234F");
    expect(updated.panStatus).toBe("PENDING_VERIFICATION");
    expect(updated.panVerificationSource).toBe("SELF_DECLARED");
    expect(getMaskedPan(updated)).toBe("XXXXXX234F");
  });

  it("rejects a malformed PAN", async () => {
    const { owner, shop } = await setupShop();
    await expect(
      submitPan(shop.id, "12345", "Test Holder", { id: owner.id, role: "SHOP_OWNER" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("admin PAN review", () => {
  it("verifies a pending PAN", async () => {
    const { owner, shop } = await setupShop();
    await submitPan(shop.id, VALID_PAN, "Test Holder", { id: owner.id, role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });

    const verified = await adminVerifyPan(shop.id, { id: admin.id, role: "ADMIN" });
    expect(verified.panStatus).toBe("VERIFIED");
    expect(verified.panVerificationSource).toBe("ADMIN_VERIFIED");
  });

  it("rejects a pending PAN with a reason", async () => {
    const { owner, shop } = await setupShop();
    await submitPan(shop.id, VALID_PAN, "Test Holder", { id: owner.id, role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });

    const rejected = await adminRejectPan(shop.id, "Name does not match", {
      id: admin.id,
      role: "ADMIN",
    });
    expect(rejected.panStatus).toBe("VERIFICATION_FAILED");
  });
});

describe("revealPanForAdmin", () => {
  it("decrypts the full PAN for an admin", async () => {
    const { owner, shop } = await setupShop();
    await submitPan(shop.id, VALID_PAN, "Test Holder", { id: owner.id, role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });

    const revealed = await revealPanForAdmin(shop.id, { id: admin.id, role: "ADMIN" });
    expect(revealed).toBe(VALID_PAN);
  });

  it("refuses a non-admin, even the shop owner", async () => {
    const { owner, shop } = await setupShop();
    await submitPan(shop.id, VALID_PAN, "Test Holder", { id: owner.id, role: "SHOP_OWNER" });

    await expect(
      revealPanForAdmin(shop.id, { id: owner.id, role: "SHOP_OWNER" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("listPendingGstPanVerifications", () => {
  it("surfaces shops with a pending GSTIN or PAN, and excludes decided ones", async () => {
    const { owner: ownerA, shop: shopA } = await setupShop();
    await submitGstin(shopA.id, VALID_GSTIN, { id: ownerA.id, role: "SHOP_OWNER" });

    const { owner: ownerB, shop: shopB } = await setupShop();
    await setGstNotRegistered(shopB.id, { id: ownerB.id, role: "SHOP_OWNER" });

    const pending = await listPendingGstPanVerifications();
    const ids = pending.map((s) => s.id);
    expect(ids).toContain(shopA.id);
    expect(ids).not.toContain(shopB.id);
  });
});
